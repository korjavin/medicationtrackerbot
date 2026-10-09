// ====================================
// WORKOUT SESSIONS — Detail modal + lifecycle
// ====================================
//
// Owns:
//   - currentSessionLogs / currentSessionData / originalSessionStatus
//     (closure-private; exposed via window.WorkoutSessionsState getters for
//     cross-file readers / tests that walk the state).
//   - the workout-session modal renderer, log editing, log deletion,
//     status flip, delete, save, finish.
//   - the ad-hoc start / start / pre-skip / cancel-preskip / complete
//     lifecycle actions called from next-card.js buttons.
//   - the "Add exercise to session" modal flow.

(function () {
    let _currentSessionLogs = [];
    let _currentSessionData = null;
    let _originalSessionStatus = null;

    window.WorkoutSessionsState = window.WorkoutSessionsState || {};
    Object.defineProperty(window.WorkoutSessionsState, 'logs', {
        get: () => _currentSessionLogs,
        set: (v) => { _currentSessionLogs = Array.isArray(v) ? v : []; },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(window.WorkoutSessionsState, 'data', {
        get: () => _currentSessionData,
        set: (v) => { _currentSessionData = v; },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(window.WorkoutSessionsState, 'originalStatus', {
        get: () => _originalSessionStatus,
        set: (v) => { _originalSessionStatus = v; },
        enumerable: true,
        configurable: true
    });
})();

// -- Debounced autosave (med-eas.71) --
// Any edit arms an ~800ms timer that persists through the existing
// saveWorkoutSessionDetails path WITHOUT closing the modal. Module-local
// state (no window.* global). A single in-flight promise serializes saves so
// overlapping autosaves don't interleave; flushPendingAutosave() is called on
// modal close so a change made right before closing isn't dropped.
let _autosaveTimer = null; // module-state: single pending debounce timer for the open session modal
let _autosaveInFlight = null; // module-state: serializes overlapping autosaves for the open session modal

function scheduleAutosave() {
    if (_autosaveTimer) clearTimeout(_autosaveTimer);
    _autosaveTimer = setTimeout(() => {
        _autosaveTimer = null;
        // Swallow rejections: a thrown write (abort / invalid_request) already
        // surfaces inline via saveWorkoutSessionDetails' catch — the timer has no
        // awaiter, so an uncaught reject here would be an unhandled rejection.
        runAutosave().catch(() => {});
    }, 800);
}

// runSerializedSave chains every save (autosave AND Finish) through a single
// in-flight promise so two saveWorkoutSessionDetails calls never overlap — e.g.
// a debounce timer firing during the Finish network window queues after it
// instead of running concurrently.
function runSerializedSave(opts) {
    const p = Promise.resolve(_autosaveInFlight)
        .catch(() => {})
        .then(() => saveWorkoutSessionDetails(opts));
    _autosaveInFlight = p;
    // Null out once THIS save settles so _autosaveInFlight means "a save is
    // genuinely in flight" — not "the last save's resolved value". Otherwise a
    // failed autosave (returns false, doesn't throw) leaves a settled false that
    // flushPendingAutosave awaits forever, permanently blocking modal close.
    p.finally(() => { if (_autosaveInFlight === p) _autosaveInFlight = null; });
    return p;
}

function runAutosave() {
    return runSerializedSave({ fromAutosave: true });
}

// Returns true when it's safe to dismiss the modal (nothing pending, or the
// pending/in-flight save succeeded) and false when a pending save FAILED — the
// close path uses this so an offline/5xx flush keeps the modal open with the
// inline error instead of tearing it down and dropping the unsaved edit.
async function flushPendingAutosave() {
    const hadPending = !!_autosaveTimer;
    if (_autosaveTimer) { clearTimeout(_autosaveTimer); _autosaveTimer = null; }
    if (hadPending) {
        try { return await runAutosave(); } catch (_) { return false; /* inline error already surfaced */ }
    } else if (_autosaveInFlight) {
        try { return await _autosaveInFlight; } catch (_) { return false; /* best-effort */ }
    }
    return true; // nothing pending — safe to close
}

function cancelAutosave() {
    if (_autosaveTimer) { clearTimeout(_autosaveTimer); _autosaveTimer = null; }
    // Drop any prior session's in-flight/settled save promise so it can't leak
    // into the next modal's close (flushPendingAutosave would otherwise await a
    // save that belongs to a session the user already left).
    _autosaveInFlight = null;
}

// setAutosaveStatus drives the inline modal status element (added in Task 4).
// No-op when the element isn't mounted so autosave works regardless.
function setAutosaveStatus(state, message) {
    const el = document.getElementById('workout-session-autosave-status');
    if (!el) return;
    el.classList.remove('is-saving', 'is-error', 'is-saved');
    if (state === 'saving') {
        el.classList.add('is-saving');
        el.textContent = 'Saving…';
    } else if (state === 'error') {
        el.classList.add('is-error');
        el.textContent = message || 'Autosave failed — your changes are kept. Retrying on next edit.';
    } else {
        // 'saved' / cleared
        el.textContent = '';
    }
}

const SESSION_STATUS_OPTIONS = [
    { value: 'in_progress', label: 'In Progress' },
    { value: 'completed', label: 'Completed' },
    { value: 'skipped', label: 'Skipped' }
];

function _statusLabel(status) {
    const match = SESSION_STATUS_OPTIONS.find((o) => o.value === status);
    return match ? match.label : '';
}

// -- Session takeover view state (med-xso6.21) --
// Which exercise is on screen, whether the overview is open, the active set
// row, the open RPE/type strip, the rest timer and the last-session history
// cache. Lives on WorkoutSessionsState.ui (no module state); it survives a
// reload of the same session (add exercise) and a minimise, and resets when
// another session opens.
const SESSION_REST_SECONDS = 90; // ponytail: one default rest; per-exercise rest has no field to read yet

function _sessionUi() {
    const st = window.WorkoutSessionsState;
    if (!st.ui) {
        st.ui = { sessionId: null, current: 0, overview: false, active: null, more: null, rest: null, tick: null, hist: {} };
    }
    return st.ui;
}

function _wgIco(name, extraClass) {
    const i = document.createElement('i');
    i.className = extraClass ? `wg-ico ${extraClass}` : 'wg-ico';
    i.setAttribute('data-icon', name);
    if (window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
        try { i.appendChild(window.WGIcons.iconSvg(name)); } catch (_) { /* unknown icon: leave the placeholder */ }
    }
    return i;
}

function _wgBtn(label, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls ? `wg-btn ${cls}` : 'wg-btn';
    if (label) b.textContent = label;
    if (onClick) b.addEventListener('click', onClick);
    return b;
}

// m:ss (h:mm:ss past an hour) for the session clock and the rest timer.
function _fmtSessionClock(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// A running session counts up from started_at; a finished one shows its
// duration (same rule as the History row).
function _sessionClockText(session) {
    if (!session) return '';
    if (session.status === 'in_progress') {
        const started = Date.parse(session.started_at || '');
        return Number.isFinite(started) ? _fmtSessionClock((Date.now() - started) / 1000) : '0:00';
    }
    const min = _computeSessionDurationMinutes(session);
    return min > 0 ? _formatHistoryDuration(min) : '—';
}

const SESSION_STATUS_CHIP_STATE = { in_progress: 'warn', completed: 'ok', skipped: 'stale' };

function _renderSessionStatusChip(status) {
    const el = document.getElementById('workout-session-modal-status');
    if (!el) return;
    const label = _statusLabel(status);
    if (window.WGChip && typeof window.WGChip.create === 'function' && label) {
        el.replaceChildren(window.WGChip.create({ text: label, state: SESSION_STATUS_CHIP_STATE[status], small: true }));
    } else {
        el.textContent = label;
    }
}

// renderWorkoutSessionHeader fills the takeover's top bar (kit .wg-session-top):
// the clock, the plan · day · date line, and the status chip. Status is shown,
// never edited, here — Finish (or the overview's Status row on a finished
// session) changes it.
function renderWorkoutSessionHeader(session) {
    const heading = document.getElementById('workout-session-modal-heading');
    if (!heading) return;

    const clock = document.createElement('div');
    clock.className = 'wg-session-top__clock';
    clock.id = 'workout-session-clock';
    clock.textContent = _sessionClockText(session);

    const dateParts = (session.scheduled_date || '').split('T')[0].split('-').map(Number);
    const dateObj = dateParts.length === 3
        ? new Date(dateParts[0], dateParts[1] - 1, dateParts[2])
        : new Date();
    const weekday = dateObj.toLocaleDateString(undefined, { weekday: 'short' });
    const dateStr = dateObj.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
    // Ad-hoc sessions (group_id === -1, e.g. `/workout walk`) carry their
    // free-text label in session.notes; it names the session instead of a plan.
    const adhocLabel = (session.group_id === -1 && session.notes) ? String(session.notes).trim() : '';
    const sub = document.createElement('div');
    sub.className = 'wg-session-top__sub';
    sub.id = 'workout-session-modal-title';
    sub.textContent = [adhocLabel || session.group_name, session.variant_name, `${dateStr} · ${weekday}`]
        .filter(Boolean).join(' · ');

    heading.replaceChildren(clock, sub);
    _renderSessionStatusChip(session.status);
}

// med-8j5w.2: the session's gym ("At: <gym>"), mounted in the overview's Gym
// row (med-xso6.21 moved it out of the header). Shown when the account has
// gyms or the session carries a gym snapshot. A stamped session preselects its
// own gym (a deleted one shows as its snapshot name), an unstamped one the
// active gym it resolves at. Changing it PUTs the session's location and
// re-resolves the plate chips; on a finished session it only changes future
// resolutions (no retroactive re-propagation).
async function _attachSessionGymSwitch(slot, session) {
    const eq = window.WorkoutEquipment;
    if (!eq || typeof eq.locations !== 'function' || typeof eq.gymSwitch !== 'function' || !session) return;
    let state = null;
    try {
        state = await eq.locations();
    } catch (_) {
        return;
    }
    const st = window.WorkoutSessionsState;
    if (!slot.isConnected || !st.data || st.data.id !== session.id) return;
    const prior = slot.querySelector('.wg-workouts-gym-switch');
    if (prior) prior.remove();
    const stamped = Object.prototype.hasOwnProperty.call(session, 'location_id');
    const live = stamped && session.location_id !== null && session.location_id !== undefined
        && state.locations.some((l) => String(l.id) === String(session.location_id));
    const deletedName = stamped && !live && session.location_id !== null && session.location_id !== undefined
        ? (session.location_name || 'Deleted gym') : null;
    if (state.locations.length === 0 && !deletedName) { slot.hidden = true; return; }
    const selected = stamped ? session.location_id : state.activeId;
    const finished = session.status === 'completed' || session.status === 'skipped';
    const control = eq.gymSwitch(document, state.locations, selected, {
        extra: deletedName ? { value: '__deleted', label: `${deletedName} (deleted)` } : null,
        title: 'Gym for this workout',
        hint: finished ? 'Changing the gym of a finished workout only affects future suggestions.' : '',
        onPick: (id) => setWorkoutSessionLocation(session.id, id),
    });
    control.classList.add('wg-workouts-session-modal__gym');
    slot.appendChild(control);
    slot.hidden = false;
}

// setWorkoutSessionLocation moves the open session to another gym (null = no
// gym). Rule 9: the history row's gym label projects optimistically on the
// `workout_history` cache. On success the session state takes the stamp and
// the chips re-resolve at the new gym. Returns true on success.
async function setWorkoutSessionLocation(sessionId, locationId) {
    let name = null;
    try {
        const state = await window.WorkoutEquipment.locations();
        const loc = state.locations.find((l) => String(l.id) === String(locationId));
        name = loc ? loc.name : null;
    } catch (_) { name = null; }
    const project = (s) => (s && s.session && s.session.id === sessionId
        ? { ...s, session: { ...s.session, location_id: locationId, location_name: name } } : s);
    let handle = null;
    try {
        if (window.DataStore && typeof window.DataStore.applyOptimistic === 'function') {
            handle = await window.DataStore.applyOptimistic('workout_history', (prev) => (prev && Array.isArray(prev.sessions)
                ? { ...prev, sessions: prev.sessions.map(project) } : prev), ['workout']);
        }
    } catch (_) { handle = null; /* a failed cache projection must not block the write */ }
    let result = null;
    try {
        result = await apiCall(`/api/workout/sessions/location?id=${sessionId}`, 'PUT',
            { location_id: locationId }, { suppressWriteAlert: true });
    } catch (_) {
        result = null;
    }
    if (!result || typeof result !== 'object') {
        if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
        safeToast("Couldn't change the gym — try again.", 'error');
        return false;
    }
    if (handle) { try { await handle.commit(null); } catch (_) { /* best-effort */ } }
    const st = window.WorkoutSessionsState;
    if (st.data && st.data.id === sessionId) {
        st.data = { ...st.data, location_id: result.location_id, location_name: result.location_name };
        refreshSessionPlateGear();
    }
    return true;
}

// setWorkoutSessionStatus changes the session status the next save persists
// (WorkoutSessionsState.targetStatus — the status select is gone). Finish sets
// it to completed; a finished session changes it from the overview's Status
// row. A status change is a persisted edit, so it autosaves like a set edit.
function setWorkoutSessionStatus(status) {
    if (!SESSION_STATUS_OPTIONS.some((o) => o.value === status)) return;
    window.WorkoutSessionsState.targetStatus = status;
    _renderSessionStatusChip(status);
    scheduleAutosave();
}

// renderWorkoutSessionLogs renders the takeover's body for the current state:
// the progress segments, ONE exercise (kit W1) or the overview (kit W2), and
// the footer buttons. Every interaction re-renders through here.
function renderWorkoutSessionLogs(logsContainer) {
    logsContainer.classList.add('wg-workouts-session-logs');
    const ui = _sessionUi();
    const logs = window.WorkoutSessionsState.logs;
    if (ui.current >= logs.length) ui.current = Math.max(0, logs.length - 1);

    _renderSessionProgress();
    if (ui.overview) {
        logsContainer.replaceChildren(_buildSessionOverview());
    } else if (logs.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'wg-workouts-session-logs__empty';
        empty.textContent = 'No exercises logged';
        logsContainer.replaceChildren(empty, _sessionAddExerciseButton());
    } else {
        logsContainer.replaceChildren(_buildSessionExerciseCard(logs[ui.current], ui.current));
        _ensureExerciseHistory(logs[ui.current].exercise_name);
    }
    const actions = document.getElementById('workout-session-actions');
    if (actions) renderSessionDetailActions(actions, { onFinish: () => finishWorkoutSession() });
}

// _targetSets is how many set rows an exercise shows: its done sets plus the
// pending rows still to do (the plan's target, raised by "Add set").
function _targetSets(log) {
    return Math.min(20, Math.max(_ensureLogSets(log).length, Number(log._targetSets) || 0));
}

function _logComplete(log) {
    const done = _ensureLogSets(log).length;
    return done > 0 && done >= _targetSets(log);
}

// One segment per exercise: done = every set row completed, now = on screen.
// The bar is the button that opens / closes the overview.
function _renderSessionProgress() {
    const bar = document.getElementById('workout-session-prog');
    if (!bar) return;
    const ui = _sessionUi();
    const segs = window.WorkoutSessionsState.logs.map((log, i) => {
        const seg = document.createElement('span');
        seg.className = 'wg-session-prog__seg';
        if (_logComplete(log)) seg.classList.add('wg-session-prog__seg--done');
        else if (i === ui.current) seg.classList.add('wg-session-prog__seg--now');
        return seg;
    });
    bar.replaceChildren(...segs);
    bar.setAttribute('aria-expanded', ui.overview ? 'true' : 'false');
}

function toggleWorkoutSessionOverview(open) {
    const ui = _sessionUi();
    ui.overview = typeof open === 'boolean' ? open : !ui.overview;
    _rerenderSessionLogs();
}

function _showSessionExercise(index) {
    const ui = _sessionUi();
    const logs = window.WorkoutSessionsState.logs;
    if (index < 0 || index >= logs.length) return;
    ui.current = index;
    ui.overview = false;
    ui.active = null;
    ui.more = null;
    _rerenderSessionLogs();
}

function _sessionAddExerciseButton() {
    const add = _wgBtn('', 'wg-btn--sm', () => showAddExerciseToSessionModal());
    add.id = 'workout-session-header-add-btn';
    add.append(_wgIco('plus', 'wg-ico--sm'), document.createTextNode('Exercise'));
    return add;
}

// Kit W2: every exercise as a row (tap → that exercise), then "+ Exercise",
// the gym, and — on a finished session only — its status.
function _buildSessionOverview() {
    const st = window.WorkoutSessionsState;
    const ui = _sessionUi();
    const wrap = document.createElement('div');
    wrap.className = 'wg-vstack wg-session-overview';

    const list = document.createElement('div');
    list.className = 'wg-list';
    st.logs.forEach((log, i) => {
        const done = _ensureLogSets(log).length;
        const total = _targetSets(log);
        const complete = _logComplete(log);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'wg-row wg-session-overview__row';
        const lead = document.createElement('span');
        lead.className = 'wg-row__lead';
        if (complete) lead.classList.add('wg-row__lead--ok');
        else if (i === ui.current) lead.classList.add('wg-row__lead--sun');
        lead.appendChild(_wgIco(complete ? 'check' : 'dumbbell'));
        const body = document.createElement('span');
        body.className = 'wg-row__body';
        const title = document.createElement('span');
        title.className = 'wg-row__title';
        title.textContent = log.exercise_name || '';
        const meta = document.createElement('span');
        meta.className = 'wg-row__meta';
        meta.textContent = `${done} of ${total} sets${log.weight_kg > 0 ? ` · ${_fmtSetNumber(log.weight_kg)} kg` : ''}`;
        body.append(title, meta);
        row.append(lead, body);
        if (i === ui.current && !complete && window.WGChip) {
            row.appendChild(window.WGChip.create({ text: 'Now', state: 'warn', small: true }));
        } else {
            row.appendChild(_wgIco('chev-r', 'wg-row__chev'));
        }
        row.addEventListener('click', () => _showSessionExercise(i));
        list.appendChild(row);
    });
    wrap.appendChild(list);

    const acts = document.createElement('div');
    acts.className = 'wg-hstack';
    acts.appendChild(_sessionAddExerciseButton());
    wrap.appendChild(acts);

    const gym = document.createElement('div');
    gym.id = 'workout-session-gym';
    gym.className = 'wg-setting wg-setting--boxed';
    gym.hidden = true;
    const gymBody = document.createElement('span');
    gymBody.className = 'wg-setting__body';
    const gymTitle = document.createElement('span');
    gymTitle.className = 'wg-setting__title';
    gymTitle.textContent = 'Gym';
    gymBody.appendChild(gymTitle);
    gym.appendChild(gymBody);
    wrap.appendChild(gym);
    if (st.data) _attachSessionGymSwitch(gym, { ...st.data });

    const status = st.targetStatus || st.originalStatus;
    if (st.data && status !== 'in_progress') {
        const row = document.createElement('button');
        row.type = 'button';
        row.id = 'workout-session-status-row';
        row.className = 'wg-setting wg-setting--boxed';
        const sb = document.createElement('span');
        sb.className = 'wg-setting__body';
        const stt = document.createElement('span');
        stt.className = 'wg-setting__title';
        stt.textContent = 'Status';
        sb.appendChild(stt);
        const val = document.createElement('span');
        val.className = 'wg-setting__value';
        val.textContent = _statusLabel(status);
        row.append(sb, val, _wgIco('chev-r', 'wg-row__chev'));
        row.addEventListener('click', async () => {
            const picked = await safeChoose('', SESSION_STATUS_OPTIONS.map((o) => ({ ...o, selected: o.value === status })),
                { title: 'Workout status' });
            if (!picked || picked === status || !window.WorkoutSessionsState.data) return;
            setWorkoutSessionStatus(picked);
            _rerenderSessionLogs();
        });
        wrap.appendChild(row);
    }
    return wrap;
}

// Plate/bar/set numbers print at most 2dp without float dust (72, 1.25).
function _fmtSetNumber(v) {
    return String(Math.round((Number(v) || 0) * 100) / 100);
}

// -- Last session's values (ghost cells) --
// One history read per exercise name per open session, shared with the PR
// badge: GET /api/workout/exercises/history returns newest-first
// [{date, sets, session_id}]. "Last" = the newest OTHER session on or before
// this one with per-set data.
function _exerciseHistory(name) {
    const ui = _sessionUi();
    if (!ui.hist[name]) {
        let p;
        try {
            p = Promise.resolve(apiCall(`/api/workout/exercises/history?name=${encodeURIComponent(name)}&limit=500`));
        } catch (e) {
            p = Promise.reject(e);
        }
        ui.hist[name] = p.then((rows) => (Array.isArray(rows) ? rows : null), () => null);
    }
    return ui.hist[name];
}

function _lastSessionSets(name) {
    const ui = _sessionUi();
    const v = ui.last && ui.last[name];
    return Array.isArray(v) ? v : null;
}

async function _ensureExerciseHistory(name) {
    if (!name) return;
    const ui = _sessionUi();
    if (!ui.last) ui.last = {};
    if (Object.prototype.hasOwnProperty.call(ui.last, name)) return;
    ui.last[name] = null;
    const rows = await _exerciseHistory(name);
    const st = window.WorkoutSessionsState;
    if (st.ui !== ui || !rows || !st.data) return;
    const sid = st.data.id;
    const day = String(st.data.scheduled_date || '').slice(0, 10);
    const prior = rows.find((r) => r && r.session_id !== sid && Array.isArray(r.sets) && r.sets.length > 0
        && (!day || !r.date || String(r.date).slice(0, 10) <= day));
    if (!prior) return;
    ui.last[name] = prior.sets;
    const cur = st.logs[ui.current];
    if (!ui.overview && cur && cur.exercise_name === name) _rerenderSessionLogs();
}

// The values a set row shows. A done row shows its stored set; a pending row
// shows its draft (cells the user accepted or adjusted) over a ghost: last
// session's set at that position, else the previous done set, else the plan
// target. ghostW / ghostR flag cells still showing the ghost.
function _setRowValues(log, row) {
    const done = _ensureLogSets(log);
    if (row < done.length) return { ...done[row], done: true };
    const last = _lastSessionSets(log.exercise_name);
    const prev = done[done.length - 1];
    let ghost;
    if (last) {
        const s = last[Math.min(row, last.length - 1)] || {};
        ghost = { weight_kg: Number(s.weight_kg) || 0, reps: Number(s.reps) || 0, set_type: s.set_type || 'normal', fromLast: true };
    } else if (prev) {
        ghost = { weight_kg: prev.weight_kg, reps: prev.reps, set_type: 'normal', fromLast: false };
    } else {
        const t = log._target || {};
        ghost = {
            weight_kg: Number(t.weight_kg != null ? t.weight_kg : log.weight_kg) || 0,
            reps: Number(t.reps != null ? t.reps : log.reps_completed) || 0,
            set_type: 'normal',
            fromLast: false,
        };
    }
    const draft = (Array.isArray(log._drafts) && log._drafts[row - done.length]) || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(draft, k);
    return {
        weight_kg: has('weight_kg') ? draft.weight_kg : ghost.weight_kg,
        reps: has('reps') ? draft.reps : ghost.reps,
        set_type: has('set_type') ? draft.set_type : ghost.set_type,
        rpe: has('rpe') ? draft.rpe : undefined,
        ghostW: !has('weight_kg'),
        ghostR: !has('reps'),
        fromLast: ghost.fromLast,
        done: false,
    };
}

function _setDraft(log, j) {
    if (!Array.isArray(log._drafts)) log._drafts = [];
    if (!log._drafts[j]) log._drafts[j] = {};
    return log._drafts[j];
}

// The highlighted row (big ± adjusters): the one the user tapped, else the
// first pending row; -1 when every row is done.
function _activeSetRow(index, log) {
    const ui = _sessionUi();
    const total = _targetSets(log);
    if (ui.active && ui.active.li === index && ui.active.row < total) return ui.active.row;
    const done = _ensureLogSets(log).length;
    return done < total ? done : -1;
}

const SESSION_SET_TYPES = [['normal', 'Normal'], ['warmup', 'Warm-up'], ['drop', 'Drop'], ['failure', 'Failure']];
const SESSION_SET_GLYPH = { warmup: 'W', drop: 'D', failure: 'F' };

function _buildSetRow(log, index, row, activeRow) {
    const v = _setRowValues(log, row);
    const ui = _sessionUi();
    const el = document.createElement('div');
    el.className = 'wg-set';
    if (v.done) el.classList.add('wg-set--done');
    if (row === activeRow) el.classList.add('wg-set--active');
    el.dataset.row = String(row);

    // The index is the per-row toggle for RPE and set type.
    const moreOpen = !!(ui.more && ui.more.li === index && ui.more.row === row);
    const idx = document.createElement('button');
    idx.type = 'button';
    idx.className = 'wg-set__idx';
    if (v.set_type === 'warmup') idx.classList.add('wg-set__idx--warm');
    idx.textContent = SESSION_SET_GLYPH[v.set_type] || String(row + 1);
    idx.setAttribute('aria-label', `Set ${row + 1}: RPE and type`);
    idx.setAttribute('aria-expanded', moreOpen ? 'true' : 'false');
    idx.addEventListener('click', () => {
        ui.more = moreOpen ? null : { li: index, row };
        _rerenderSessionLogs();
    });
    el.appendChild(idx);

    const last = _lastSessionSets(log.exercise_name);
    const lastSet = last ? last[Math.min(row, last.length - 1)] : null;
    const cell = (field, value, ghost, label) => {
        const c = document.createElement('button');
        c.type = 'button';
        c.className = 'wg-set__cell';
        c.dataset.field = field;
        if (ghost) c.classList.add('wg-set__cell--ghost');
        c.setAttribute('aria-label', `${label} ${_fmtSetNumber(value)}`);
        c.appendChild(document.createTextNode(_fmtSetNumber(value)));
        const small = ghost ? (v.fromLast ? 'last' : '')
            : (lastSet && !v.done && row === activeRow ? `last ${_fmtSetNumber(lastSet[field])}` : '');
        if (small) {
            const s = document.createElement('small');
            s.textContent = small;
            c.appendChild(s);
        }
        c.addEventListener('click', () => { _onSetCellTap(index, row, field); });
        return c;
    };
    el.appendChild(cell('weight_kg', v.weight_kg, !v.done && v.ghostW, 'Weight'));
    el.appendChild(cell('reps', v.reps, !v.done && v.ghostR, 'Reps'));

    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'wg-set__done';
    doneBtn.setAttribute('aria-pressed', v.done ? 'true' : 'false');
    doneBtn.setAttribute('aria-label', v.done ? 'Set done — undo' : 'Complete set');
    doneBtn.appendChild(_wgIco('check', 'wg-ico--lg'));
    doneBtn.addEventListener('click', () => {
        if (v.done) _undoSessionSet(index, row);
        else _completeSessionSet(index, row - _ensureLogSets(log).length);
    });
    el.appendChild(doneBtn);

    if (row === activeRow) {
        const adjust = document.createElement('div');
        adjust.className = 'wg-set__adjust';
        [['−2.5', 'weight_kg', -2.5], ['+2.5', 'weight_kg', 2.5], ['−1', 'reps', -1], ['+1', 'reps', 1]]
            .forEach(([label, field, delta]) => {
                adjust.appendChild(_wgBtn(label, 'wg-btn--sm', () => _adjustSessionSet(index, row, field, delta)));
            });
        el.appendChild(adjust);
    }

    if (moreOpen) {
        const more = document.createElement('div');
        more.className = 'wg-set__more wg-picks';
        const pick = (label, onClick, aria) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'wg-pick';
            b.textContent = label;
            if (aria) b.setAttribute('aria-label', aria);
            b.addEventListener('click', onClick);
            more.appendChild(b);
            return b;
        };
        SESSION_SET_TYPES.forEach(([val, label]) => {
            const b = pick(label, () => _setSessionSetField(index, row, 'set_type', val));
            b.dataset.setType = val;
            b.setAttribute('aria-pressed', (v.set_type || 'normal') === val ? 'true' : 'false');
        });
        const rpe = v.rpe == null ? null : Number(v.rpe);
        // First tap from "no RPE" lands on 7 / 8 (7.5 ± 0.5).
        const step = (d) => () => _setSessionSetField(index, row, 'rpe',
            String(Math.min(10, Math.max(1, (rpe == null ? 7.5 : rpe) + d))));
        pick('−', step(-0.5), 'Lower RPE');
        const rpeLabel = document.createElement('span');
        rpeLabel.className = 'wg-set__rpe';
        rpeLabel.textContent = rpe == null ? 'RPE —' : `RPE ${_fmtSetNumber(rpe)}`;
        more.appendChild(rpeLabel);
        pick('+', step(0.5), 'Raise RPE');
        if (rpe != null) pick('Clear', () => _setSessionSetField(index, row, 'rpe', ''), 'Clear RPE');
        el.appendChild(more);
    }
    return el;
}

function _buildSessionExerciseCard(log, index) {
    const logs = window.WorkoutSessionsState.logs;
    const entry = document.createElement('div');
    entry.className = 'wg-ex wg-workouts-session-exercise exercise-log-entry';
    entry.id = `exercise-log-${index}`;

    const headerRow = document.createElement('div');
    headerRow.className = 'wg-ex__head wg-workouts-session-exercise__header exercise-log-header';
    const titles = document.createElement('div');
    titles.className = 'wg-vstack wg-spacer';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'wg-eyebrow';
    eyebrow.textContent = `Exercise ${index + 1} of ${logs.length}`;
    const title = document.createElement('span');
    title.className = 'wg-ex__name wg-workouts-session-exercise__name';
    title.textContent = log.exercise_name || '';
    const meta = document.createElement('span');
    meta.className = 'wg-ex__meta';
    titles.append(eyebrow, title, meta);

    const deleteButton = _wgBtn('', 'wg-btn--ghost wg-btn--icon wg-workouts-session-exercise__delete exercise-log-delete-btn',
        () => { deleteExerciseLog(index); });
    deleteButton.title = 'Remove exercise';
    deleteButton.setAttribute('aria-label', 'Remove exercise');
    deleteButton.appendChild(_wgIco('trash'));

    headerRow.append(titles, deleteButton);
    entry.appendChild(headerRow);

    // PR cue (Phase 3, epic med-qj4) and the friendly body-part chip (med-mj4)
    // land in the exercise's tag row. Fire-and-forget; each guards mount and
    // double-append, and no-ops when its data is unavailable.
    _maybeAttachPRBadge(meta, log);
    _maybeAttachBodyPartChip(meta, log);

    const monoRow = document.createElement('div');
    monoRow.className = 'wg-workouts-session-exercise__mono';
    monoRow.textContent = _formatLogMono(log);
    entry.appendChild(monoRow);

    // Plate-loading chip (med-v75c.2): which plates to load for the working
    // weight. Fire-and-forget; silent no-op when the exercise has no
    // bound/resolvable equipment. Synchronous when the gear is already cached
    // (every set tap re-renders the card — no flicker).
    _refreshSessionPlateChip(entry, log);

    // Set rows (kit .wg-set, 56px): index (RPE/type toggle), weight, reps, done.
    // Done rows are log.sets — what is persisted; pending rows show ghost
    // values and are never written until their check is tapped.
    const head = document.createElement('div');
    head.className = 'wg-sethead';
    ['Set', 'kg', 'Reps', 'Done'].forEach((t) => {
        const s = document.createElement('span');
        s.textContent = t;
        head.appendChild(s);
    });
    entry.appendChild(head);

    const total = _targetSets(log);
    const activeRow = _activeSetRow(index, log);
    const setsWrap = document.createElement('div');
    setsWrap.className = 'wg-vstack wg-workouts-session-exercise__sets';
    for (let row = 0; row < total; row++) setsWrap.appendChild(_buildSetRow(log, index, row, activeRow));
    entry.appendChild(setsWrap);

    const tools = document.createElement('div');
    tools.className = 'wg-hstack';
    const addSetBtn = _wgBtn('', 'wg-btn--ghost wg-btn--sm wg-workouts-session-exercise__add-set', () => addLocalSet(index));
    addSetBtn.append(_wgIco('plus', 'wg-ico--sm'), document.createTextNode('Add set'));
    // The save validator caps a log at 20 sets.
    addSetBtn.disabled = total >= 20;
    tools.appendChild(addSetBtn);
    entry.appendChild(tools);

    const notesGroup = document.createElement('label');
    notesGroup.className = 'wg-gloss--inset wg-workouts-session-exercise__field wg-workouts-session-exercise__field--notes log-input-group';

    const notesLabel = document.createElement('span');
    notesLabel.className = 'wg-workouts-session-exercise__field-label';
    notesLabel.textContent = 'Notes';

    const notesInput = document.createElement('input');
    notesInput.type = 'text';
    notesInput.className = 'wg-workouts-session-exercise__field-input';
    notesInput.value = log.notes || '';
    notesInput.placeholder = 'Add notes...';
    notesInput.maxLength = 200;
    notesInput.addEventListener('change', () => {
        updateLocalLog(index, 'notes', notesInput.value);
    });

    notesGroup.appendChild(notesLabel);
    notesGroup.appendChild(notesInput);
    entry.appendChild(notesGroup);

    return entry;
}

// _maybeAttachPRBadge appends a "PR" badge to a saved log card's header when the
// log sets a new record for its exercise (Phase 3, epic med-qj4). Uses the shared
// analysis resolver in exercise-detail.js so bot mode (no analysis module) skips
// the history fetch entirely.
async function _maybeAttachPRBadge(headerRow, log) {
    if (!log || !log.id || log.id <= 0) return;
    if (!Array.isArray(log.sets) || log.sets.length === 0) return;
    const detail = window.WorkoutExerciseDetail;
    if (!detail || typeof detail.getAnalysis !== 'function') return;

    const WA = await detail.getAnalysis();
    if (!WA) return;

    // Shared with the ghost cells' last-session read (one fetch per name).
    const logs = await _exerciseHistory(log.exercise_name);
    if (!Array.isArray(logs)) return;

    // Baseline = every OTHER session's logs for this exercise; a set beating that
    // baseline is a fresh PR held by this session.
    const sessionId = window.WorkoutSessionsState.data && window.WorkoutSessionsState.data.id;
    const prior = logs.filter((l) => l.session_id !== sessionId);
    // No prior history for this exercise = no record to beat. Don't badge the
    // first-ever log (an all-zero baseline that anything positive "beats").
    if (prior.length === 0) return;
    const priorPRs = WA.exercisePRs(prior);
    if (!detail.isPRLog(log, priorPRs, WA)) return;

    // The card may have been re-rendered (add/remove set) while we awaited — only
    // decorate the still-mounted header, and don't double-badge.
    if (!headerRow.isConnected) return;
    if (headerRow.querySelector('.wg-workouts-session-exercise__pr-badge')) return;

    const badge = document.createElement('span');
    badge.className = 'wg-tag wg-tag--sun wg-workouts-session-exercise__pr-badge';
    badge.textContent = 'PR';
    badge.title = 'New personal record';
    // Sit next to the name (before the delete button anchored right).
    headerRow.insertBefore(badge, headerRow.children[1] || null);
}

// _maybeAttachBodyPartChip appends a friendly body-part chip (Legs / Core /
// Forearms …) to a card header when the exercise resolves to a catalog body_part
// with a friendly translation (med-mj4). Mirrors _maybeAttachPRBadge: async,
// guards mount + double-append, sits left of the delete button so it coexists
// with the PR badge. Silent no-op when the shared catalog helper is absent.
async function _maybeAttachBodyPartChip(headerRow, log) {
    if (!log || !window.WorkoutExerciseCatalog) return;

    const bp = await window.WorkoutExerciseCatalog.getBodyPart(log.exercise_name);
    const friendly = window.WorkoutExerciseCatalog.friendlyBodyPart(bp);
    if (!friendly) return;

    // The card may have been re-rendered while we awaited — only decorate the
    // still-mounted header, and don't double-chip.
    if (!headerRow.isConnected) return;
    if (headerRow.querySelector('.wg-workouts-session-exercise__bodypart-chip')) return;

    const chip = document.createElement('span');
    chip.className = 'wg-tag wg-workouts-session-exercise__bodypart-chip';
    chip.textContent = friendly;
    chip.title = 'Body part';
    // Left of the delete button (anchored right), alongside the PR badge.
    headerRow.insertBefore(chip, headerRow.querySelector('.exercise-log-delete-btn') || null);
}

// -- Plate-loading chip (med-v75c.2) --
//
// Each exercise card shows which plates to load for its working weight
// (log.weight_kg, the max set weight kept in sync by
// _syncLogScalarsFromSets): a glyph plus a text line solved by the domain
// loadingFor over the exercise's bound equipment, with a nearest-achievable
// fallback (nearestLoads, tie → below) and its delta when the exact kg is
// unreachable. Fixed gear gets a text-only "nearest: N kg" one-liner when
// the target isn't a stocked load; unbound or unresolvable gear leaves the
// card unchanged. The loading is derived and re-solved on read — never
// written anywhere.
//
// Gear resolves once per session open and is cached on
// window.WorkoutSessionsState.plateGear ({ sessionId, rowsById, libById,
// inv, location, loadingFor, nearestLoads, equipmentForExercise, pickNearestLoad }
// or { sessionId, failed: true }); any fetch/import failure resolves to
// failed so cards render exactly as today.

// _sessionPlateGearSync returns the cached gear map for the open session, or
// null when nothing usable is cached (cold, failed, or a stale session).
// med-8j5w.2: the cache is keyed by session id AND a gear generation
// (st.plateGearGen), bumped by refreshSessionPlateGear whenever the gym
// context changes (session gym switch, active-gym switch, a remote gym /
// inventory change). A build started under an older generation is never
// cached or rendered, so a same-session gym switch cannot reuse old gear.
function _sessionPlateGearSync() {
    const st = window.WorkoutSessionsState;
    const g = st && st.plateGear;
    if (!g || !st.data) return null;
    return g.sessionId === st.data.id && g.gen === (st.plateGearGen || 0) ? g : null;
}

// _sessionPlateGear resolves the exercise → equipment map once per session
// open and gym context (in-flight builds are shared across cards via
// plateGearPromise).
async function _sessionPlateGear() {
    const st = window.WorkoutSessionsState;
    const cached = _sessionPlateGearSync();
    if (cached) return cached;
    const gen = st.plateGearGen || 0;
    if (st.plateGearPromise && st.plateGearPromiseGen === gen) return st.plateGearPromise;
    const built = _buildSessionPlateGear(st.data).then((g) => (g ? { ...g, gen: gen } : g));
    st.plateGearPromise = built;
    st.plateGearPromiseGen = gen;
    const gear = await built;
    if (st.plateGearPromise === built) st.plateGearPromise = null;
    // Only the session + generation that triggered the build may cache it.
    if (gear && st.data && gear.sessionId === st.data.id && gen === (st.plateGearGen || 0)) st.plateGear = gear;
    return gear;
}

// refreshSessionPlateGear drops the open session's resolved gear (bumping the
// generation so in-flight builds are discarded) and re-solves every mounted
// card's chip at the current gym context. Logs/inputs are untouched.
function refreshSessionPlateGear() {
    const st = window.WorkoutSessionsState;
    if (!st || !st.data) return;
    st.plateGearGen = (st.plateGearGen || 0) + 1;
    st.plateGear = null;
    st.plateGearPromise = null;
    (st.logs || []).forEach((log, index) => {
        const entry = document.getElementById(`exercise-log-${index}`);
        if (!entry) return;
        const old = entry.querySelector('.wg-workouts-session-exercise__plates');
        if (old) old.remove();
        _maybeAttachPlateChip(entry, log);
    });
}

// A remote write (another device, the MCP connector, a sync pull) touching
// workout records while a session is open: re-read the session's gym stamp
// (header) and re-resolve the chips — the active gym, a gym or the inventory
// may have changed underneath. The UI's own writes are not 'cloud-write'.
async function _onSessionRemoteWorkoutChange(event) {
    const detail = event && event.detail;
    if (!detail || detail.source !== 'cloud-write') return;
    if (!Array.isArray(detail.changedTags) || detail.changedTags.indexOf('workout') === -1) return;
    const st = window.WorkoutSessionsState;
    if (!st || !st.data) return;
    const sessionId = st.data.id;
    try {
        const fresh = await apiCall(`/api/workout/sessions/details?id=${sessionId}`);
        const s = fresh && fresh.session;
        if (s && st.data && st.data.id === sessionId) {
            const next = { ...st.data };
            if (Object.prototype.hasOwnProperty.call(s, 'location_id')) {
                next.location_id = s.location_id;
                next.location_name = s.location_name;
            }
            st.data = next;
            const gym = document.getElementById('workout-session-gym');
            if (gym) _attachSessionGymSwitch(gym, { ...next, status: s.status || next.status });
        }
    } catch (_) { /* chips still refresh below */ }
    if (st.data && st.data.id === sessionId) refreshSessionPlateGear();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('datastore:changed', (e) => { _onSessionRemoteWorkoutChange(e); });
}

// _buildSessionPlateGear fetches the plan rows (for the variant behind this
// session), the exercise library, and the equipment inventory, plus the
// domain plate math. Never throws: any failure resolves to
// { sessionId, failed: true } (no chips). A completion snapshot freezes the
// plan as performed: the live variant is never consulted for completed
// sessions (the med-qj4.2.1 no-fetch contract covers this read too), so
// their plan-row logs stay chipless — the snapshot carries no library id
// to resolve them by. An in-progress session may still carry a snapshot
// (mid-workout plan edits materialize one) without being frozen, so those
// keep consulting the live variant for the library link.
async function _buildSessionPlateGear(sessionData) {
    const sessionId = sessionData ? sessionData.id : null;
    const fail = () => ({ sessionId: sessionId, failed: true });
    try {
        const variantId = sessionData ? Number(sessionData.variant_id) : 0;
        const rowsById = {};
        const hasSnapshot = !!(sessionData && Array.isArray(sessionData.exercise_snapshot));
        const frozen = hasSnapshot && sessionData.status === 'completed';
        if (variantId > 0 && !frozen) {
            const rows = await apiCall(`/api/workout/exercises?variant_id=${variantId}`);
            if (!Array.isArray(rows)) return fail();
            for (const r of rows) {
                if (r && r.id !== null && r.id !== undefined) rowsById[r.id] = r;
            }
        }
        const lib = await apiCall('/api/workout/exercise-library');
        if (!Array.isArray(lib)) return fail();
        const libById = {};
        for (const r of lib) {
            if (r && r.id !== null && r.id !== undefined) libById[r.id] = r;
        }
        // Same inventory source order as the print path: the equipment tab's
        // cached list first, the API fallback second.
        let inv = null;
        try {
            if (window.WorkoutEquipment && typeof window.WorkoutEquipment.list === 'function') {
                inv = await window.WorkoutEquipment.list();
            }
        } catch (_) {
            inv = null;
        }
        if (!Array.isArray(inv)) inv = await apiCall('/api/workout/equipment', 'GET');
        if (!Array.isArray(inv)) return fail();
        const domain = await window.WorkoutGroups.loadEquipmentDomain();
        const loadingFor = domain && domain.loadingFor;
        const nearestLoads = domain && domain.nearestLoads;
        const equipmentForExercise = domain && domain.equipmentForExercise;
        const pickNearestLoad = domain && domain.pickNearestLoad;
        if (typeof loadingFor !== 'function' || typeof nearestLoads !== 'function'
            || typeof equipmentForExercise !== 'function' || typeof pickNearestLoad !== 'function') return fail();
        // med-8j5w.1: resolve at the session's stamped gym (an unstamped
        // session: the active one), same rule as the domain's propagate.
        const stamped = sessionData && Object.prototype.hasOwnProperty.call(sessionData, 'location_id')
            ? sessionData.location_id : undefined;
        const location = window.WorkoutEquipment && typeof window.WorkoutEquipment.locationScope === 'function'
            ? await window.WorkoutEquipment.locationScope(stamped) : null;
        return {
            sessionId: sessionId, rowsById: rowsById, libById: libById,
            inv: inv, location: location, loadingFor: loadingFor, nearestLoads: nearestLoads,
            equipmentForExercise: equipmentForExercise, pickNearestLoad: pickNearestLoad
        };
    } catch (_) {
        return fail();
    }
}

// _sessionEquipmentForLog maps a session log to its equipment:
// { item, auto } or null. Ad-hoc / library-sourced logs carry the library id
// directly as exercise_id (toLogResponse source === 'library'); plan-backed
// logs carry the plan row id and resolve through the row — the row's own
// equipment_id override, else the library binding, else an inventory item
// auto-matched by implement + the logged weight (equipmentForExercise, the
// shared rule, med-x295). Nothing bound or matched → null.
function _sessionEquipmentForLog(log, gear) {
    if (!log || !gear || gear.failed) return null;
    const planRow = log.source === 'library' ? null : (gear.rowsById[log.exercise_id] || null);
    const libRow = log.source === 'library'
        ? gear.libById[log.exercise_id]
        : (planRow ? gear.libById[planRow.exercise_library_id] : null);
    if (!planRow && !libRow) return null;
    return gear.equipmentForExercise(planRow, libRow || null, gear.inv, Number(log.weight_kg), gear.location || null);
}

// Plate/bar kg print at most 2dp (the domain grid); String() keeps integers
// bare (72, not 72.00) and decimals short (1.25, never float dust).
function _sessionPlateR2(v) {
    return Math.round(Number(v) * 100) / 100;
}

// _renderSessionPlateChip builds the chip for one card synchronously from
// resolved gear. Returns true when a chip was mounted, false when the card
// stays unchanged (no weight, unbound gear, exact fixed load, bare bar,
// empty inventory). Every lookup is guarded and the domain solvers are
// total, so a malformed response degrades to no chip, never a throw.
// The weight to load: the active (next) set row's while sets remain, else the
// working weight (max done set).
function _plateWeightFor(log) {
    const li = window.WorkoutSessionsState.logs.indexOf(log);
    const row = li >= 0 ? _activeSetRow(li, log) : -1;
    return Number(row >= 0 ? _setRowValues(log, row).weight_kg : log.weight_kg);
}

function _renderSessionPlateChip(entry, log, gear) {
    if (!entry || !log || !gear || gear.failed) return false;
    if (entry.querySelector('.wg-workouts-session-exercise__plates')) return false;
    const groups = window.WorkoutGroups;
    if (!groups || typeof groups.plateSvg !== 'function' || typeof groups.plateText !== 'function') return false;
    const w = _plateWeightFor(log);
    if (!Number.isFinite(w) || w <= 0) return false;
    const hit = _sessionEquipmentForLog(log, gear);
    if (!hit) return false;
    const eq = hit.item;
    const unit = (typeof readWeightUnitPreference === 'function') ? readWeightUnitPreference() : 'kg';

    const wrap = document.createElement('div');
    wrap.className = 'wg-plates wg-workouts-session-exercise__plates';
    const addText = (text, cls) => {
        const s = document.createElement('span');
        s.className = cls;
        s.textContent = text;
        wrap.appendChild(s);
    };
    const addGlyph = (perSide, sides, text) => {
        const svg = groups.plateSvg(perSide, sides);
        svg.setAttribute('aria-label', `Plate loading: ${text}`);
        wrap.appendChild(svg);
        addText(text, 'wg-plates__text');
    };
    // med-x295: an auto-matched item (no explicit binding) names itself first.
    if (hit.auto) addText(`auto: ${eq.name}`, 'wg-plates__auto');

    if (eq.kind === 'plated') {
        const sides = eq.sides === 1 ? 1 : 2;
        const ld = gear.loadingFor(eq, w);
        if (ld && ld.per_side.length > 0) {
            addGlyph(ld.per_side, sides, groups.plateText(ld.bar_kg, ld.per_side, sides, unit));
        } else if (ld) {
            // Exact bare-bar working weight: nothing to load, like the print
            // sheet (which draws no glyph for an empty per_side).
            return false;
        } else {
            // Below the bar nothing is achievable: say so instead of
            // suggesting the bare bar as a "nearest" rung above the target.
            const bar = Number(eq.bar_kg);
            if (Number.isFinite(bar) && w < bar) {
                addText(`below bar (${_sessionPlateR2(bar)} kg)`, 'wg-plates__text');
            } else {
                const near = gear.nearestLoads(eq.loads_kg, w);
                const chosen = gear.pickNearestLoad(near.below, near.above, w);
                if (chosen === null) return false;
                const best = gear.loadingFor(eq, chosen);
                if (!best) return false;
                if (best.per_side.length > 0) {
                    addGlyph(best.per_side, sides, groups.plateText(best.bar_kg, best.per_side, sides, unit));
                }
                const delta = _sessionPlateR2(chosen - w);
                const sign = delta > 0 ? '+' : '';
                addText(`${_sessionPlateR2(chosen)} kg (${sign}${delta} kg)`, 'wg-plates__delta');
            }
        }
    } else if (eq.kind === 'fixed') {
        const loads = (Array.isArray(eq.loads_kg) ? eq.loads_kg : [])
            .map(Number).filter((n) => Number.isFinite(n) && n > 0);
        if (loads.indexOf(w) !== -1) return false;
        const near = gear.nearestLoads(loads, w);
        const chosen = gear.pickNearestLoad(near.below, near.above, w);
        if (chosen === null) return false;
        addText(`nearest: ${_sessionPlateR2(chosen)} kg`, 'wg-plates__text');
    } else {
        return false;
    }

    const mono = entry.querySelector('.wg-workouts-session-exercise__mono');
    if (mono) entry.insertBefore(wrap, mono.nextSibling);
    else entry.appendChild(wrap);
    return true;
}

// _maybeAttachPlateChip decorates a card with its plate-loading chip.
// Fire-and-forget, same async-attach flow as the body-part chip: guards mount
// + double-append, silent no-op when gear is unresolvable.
async function _maybeAttachPlateChip(entry, log) {
    if (!entry || !log) return;
    if (entry.querySelector('.wg-workouts-session-exercise__plates')) return;
    const gear = await _sessionPlateGear();
    // The card may have been re-rendered (add/remove set) while we awaited —
    // only decorate the still-mounted entry, and don't double-chip.
    if (!entry.isConnected) return;
    if (entry.querySelector('.wg-workouts-session-exercise__plates')) return;
    const st = window.WorkoutSessionsState;
    if (!gear || gear.failed || !st.data || gear.sessionId !== st.data.id) return;
    if (gear.gen !== (st.plateGearGen || 0)) return; // a refresh superseded this build
    _renderSessionPlateChip(entry, log, gear);
}

// _refreshSessionPlateChip re-solves a mounted card's chip after a weight
// edit. The gear resolved once at session open, so the common path renders
// synchronously and the chip tracks the mono line; before the first resolve
// lands it falls back to the async attach (whose guards make the overlap
// with the card-build attach harmless).
function _refreshSessionPlateChip(entry, log) {
    if (!entry || !log) return;
    const old = entry.querySelector('.wg-workouts-session-exercise__plates');
    if (old) old.remove();
    const gear = _sessionPlateGearSync();
    if (gear && !gear.failed) _renderSessionPlateChip(entry, log, gear);
    else _maybeAttachPlateChip(entry, log);
}


// -- Per-set editing (Phase 1, epic med-qj4) --

const SESSION_VALID_SET_TYPES = new Set(['normal', 'warmup', 'drop', 'failure']);

// _ensureLogSets returns log.sets — the DONE sets. Existing logs (bot mode, or
// pre-Phase-1 cloud rows) arrive with only flat scalars (or `sets: []`), so
// synthesize N rows from sets_completed carrying the aggregate reps/weight — a
// lossless round-trip for those aggregates (deriveSetScalars gives back the
// same scalars). Runs once per log (_setsInit): a log whose sets were all
// undone, or an un-logged planned row, stays at zero done sets.
function _ensureLogSets(log) {
    if (Array.isArray(log.sets) && (log.sets.length > 0 || log._setsInit)) return log.sets;
    log._setsInit = true;
    const n = Math.min(20, Math.max(0, Math.round(Number(log.sets_completed) || 0)));
    const reps = Math.max(0, Math.round(Number(log.reps_completed) || 0));
    const weight = Math.max(0, Number(log.weight_kg) || 0);
    log.sets = Array.from({ length: n }, (_, i) => ({
        set_index: i, weight_kg: weight, reps, set_type: 'normal'
    }));
    return log.sets;
}

// _syncLogScalarsFromSets mirrors the cloud domain's deriveSetScalars (and the
// Go mergePayloadValues collapse): sets_completed=len, reps_completed=max(reps),
// weight_kg=max(weight) — so the flat fields the save pipeline + bot mode read
// stay in lockstep with the per-set array.
function _syncLogScalarsFromSets(log) {
    const sets = Array.isArray(log.sets) ? log.sets : [];
    log.sets_completed = sets.length;
    log.reps_completed = sets.reduce((m, s) => Math.max(m, Number(s.reps) || 0), 0);
    log.weight_kg = sets.reduce((m, s) => Math.max(m, Number(s.weight_kg) || 0), 0);
}

function _formatLogMono(log) {
    const sets = Math.max(0, Math.round(Number(log.sets_completed) || 0));
    const reps = Math.max(0, Math.round(Number(log.reps_completed) || 0));
    const weight = Math.max(0, Number(log.weight_kg) || 0);
    const weightLabel = weight > 0 ? `${weight % 1 === 0 ? weight : weight.toFixed(1)} kg` : 'bodyweight';
    return `${sets} × ${reps} · ${weightLabel}`;
}

function _rerenderSessionLogs() {
    const c = document.getElementById('workout-session-logs');
    if (c) renderWorkoutSessionLogs(c);
}

// Clamp one set field to the save validator's ceilings (reps ≤ 100, weight ≤
// 500, RPE 1–10) so a typed value can't abort the whole session save with
// "Values exceed maximum allowed". Mutates and returns `s`.
function _applySetField(s, field, value) {
    if (field === 'set_type') {
        s.set_type = SESSION_VALID_SET_TYPES.has(value) ? value : 'normal';
    } else if (field === 'reps') {
        s.reps = Math.min(100, Math.max(0, Math.round(parseFloat(value) || 0)));
    } else if (field === 'weight_kg') {
        s.weight_kg = Math.min(500, Math.max(0, Math.round((parseFloat(value) || 0) * 100) / 100));
    } else if (field === 'rpe') {
        const n = parseFloat(value);
        if (value === '' || value === null || Number.isNaN(n)) delete s.rpe;
        else s.rpe = Math.min(10, Math.max(1, n));
    }
    return s;
}

// A done-set edit: persisted through the usual dirty flags + autosave.
function updateLocalSet(logIndex, setIndex, field, value) {
    const log = window.WorkoutSessionsState.logs[logIndex];
    if (!log || !Array.isArray(log.sets) || !log.sets[setIndex]) return;
    _applySetField(log.sets[setIndex], field, value);
    _syncLogScalarsFromSets(log);
    log._dirty = true;
    log._setsDirty = true;
    _rerenderSessionLogs();
    scheduleAutosave();
}

// _setSessionSetField edits one row: a done row persists (updateLocalSet), a
// pending row only changes its local draft (nothing to save until done).
function _setSessionSetField(logIndex, row, field, value) {
    const log = window.WorkoutSessionsState.logs[logIndex];
    if (!log) return;
    const done = _ensureLogSets(log).length;
    if (row < done) { updateLocalSet(logIndex, row, field, value); return; }
    // Only the touched cell leaves its ghost; the other keeps showing it.
    const draft = _setDraft(log, row - done);
    const tmp = _applySetField({ ...draft }, field, value);
    Object.keys(draft).forEach((k) => { delete draft[k]; });
    Object.assign(draft, tmp);
    _sessionUi().active = { li: logIndex, row };
    _rerenderSessionLogs();
}

function _adjustSessionSet(logIndex, row, field, delta) {
    const log = window.WorkoutSessionsState.logs[logIndex];
    if (!log) return;
    const v = _setRowValues(log, row);
    _setSessionSetField(logIndex, row, field, String((Number(v[field]) || 0) + delta));
}

// Cell tap: a ghost cell accepts its value (and the row becomes active); a
// cell on another row activates that row; a concrete cell on the active row
// (or a done row) opens a numeric prompt for a typed value.
async function _onSetCellTap(logIndex, row, field) {
    const log = window.WorkoutSessionsState.logs[logIndex];
    if (!log) return;
    const ui = _sessionUi();
    const v = _setRowValues(log, row);
    const ghost = !v.done && (field === 'weight_kg' ? v.ghostW : v.ghostR);
    if (ghost) { _setSessionSetField(logIndex, row, field, String(v[field])); return; }
    if (!v.done && _activeSetRow(logIndex, log) !== row) {
        ui.active = { li: logIndex, row };
        _rerenderSessionLogs();
        return;
    }
    const typed = await safePrompt('', {
        title: field === 'weight_kg' ? `Set ${row + 1} — weight (kg)` : `Set ${row + 1} — reps`,
        value: _fmtSetNumber(v[field]),
        inputMode: field === 'weight_kg' ? 'decimal' : 'numeric',
        maxLength: 6,
        confirmLabel: 'Set',
        emptyError: 'Enter a number.',
    });
    if (typed === null || typed === undefined) return;
    if (!Number.isFinite(parseFloat(typed))) return;
    if (window.WorkoutSessionsState.logs[logIndex] !== log) return;
    _setSessionSetField(logIndex, row, field, typed);
}

// _completeSessionSet marks pending row `j` (0 = the first pending row) done:
// its values (draft over ghost) become the next entry of log.sets, which is
// what autosave persists. Starts the rest timer on a running session.
function _completeSessionSet(logIndex, j) {
    const st = window.WorkoutSessionsState;
    const log = st.logs[logIndex];
    if (!log) return;
    const sets = _ensureLogSets(log);
    if (sets.length >= 20) return;
    const v = _setRowValues(log, sets.length + j);
    const s = { set_index: sets.length, weight_kg: 0, reps: 0, set_type: 'normal' };
    _applySetField(s, 'weight_kg', v.weight_kg);
    _applySetField(s, 'reps', v.reps);
    _applySetField(s, 'set_type', v.set_type || 'normal');
    if (v.rpe != null) _applySetField(s, 'rpe', v.rpe);
    sets.push(s);
    if (Array.isArray(log._drafts)) log._drafts.splice(j, 1);
    // A non-first pending row ticked out of order still counts as one set:
    // keep the row count (done + pending) unchanged.
    log._targetSets = Math.max(Number(log._targetSets) || 0, sets.length);
    _syncLogScalarsFromSets(log);
    log._dirty = true;
    log._setsDirty = true;
    const ui = _sessionUi();
    ui.active = null;
    ui.more = null;
    if (st.data && st.data.status === 'in_progress') _startRest(log.exercise_name);
    _rerenderSessionLogs();
    scheduleAutosave();
}

// _undoSessionSet un-ticks a done set: it leaves log.sets and goes back to the
// head of the pending rows with its values, so a mis-tap costs nothing.
function _undoSessionSet(logIndex, row) {
    const log = window.WorkoutSessionsState.logs[logIndex];
    if (!log || !Array.isArray(log.sets) || !log.sets[row]) return;
    const [s] = log.sets.splice(row, 1);
    log.sets.forEach((x, i) => { x.set_index = i; });
    if (!Array.isArray(log._drafts)) log._drafts = [];
    const draft = { weight_kg: s.weight_kg, reps: s.reps, set_type: s.set_type || 'normal' };
    if (s.rpe != null) draft.rpe = s.rpe;
    log._drafts.unshift(draft);
    log._targetSets = Math.max(Number(log._targetSets) || 0, log.sets.length + 1);
    _syncLogScalarsFromSets(log);
    log._dirty = true;
    log._setsDirty = true;
    _rerenderSessionLogs();
    scheduleAutosave();
}

// addLocalSet adds a PENDING row (nothing to save until it is ticked done).
// Capped at the save validator's 20-set ceiling.
function addLocalSet(logIndex) {
    const log = window.WorkoutSessionsState.logs[logIndex];
    if (!log) return;
    const total = _targetSets(log);
    if (total >= 20) return;
    log._targetSets = total + 1;
    _sessionUi().active = { li: logIndex, row: total };
    _rerenderSessionLogs();
}

// -- Rest timer (kit .wg-rest) --
// Ticking a set done on a running session docks a 90s countdown above the
// footer: +30s extends it, Skip clears it. At zero it clears itself and, when
// the page is hidden, asks the service worker for a notification (best-effort:
// no permission / no SW = silent). One 1s interval (ui.tick) also drives the
// session clock; it stops on minimise.
function _startRest(label) {
    const ui = _sessionUi();
    ui.rest = {
        left: SESSION_REST_SECONDS,
        endAt: Date.now() + SESSION_REST_SECONDS * 1000,
        total: SESSION_REST_SECONDS,
        label: label || '',
    };
    _ensureSessionTick();
    _renderRest();
}

function _extendRest(seconds) {
    const ui = _sessionUi();
    if (!ui.rest) return;
    ui.rest.left += seconds;
    ui.rest.endAt += seconds * 1000;
    ui.rest.total += seconds;
    _renderRest();
}

function _clearRest() {
    _sessionUi().rest = null;
    _renderRest();
}

function _renderRest() {
    const dock = document.getElementById('workout-session-rest');
    if (!dock) return;
    const rest = _sessionUi().rest;
    if (!rest) { dock.hidden = true; dock.replaceChildren(); return; }
    let box = dock.querySelector('.wg-rest');
    if (!box) {
        box = document.createElement('div');
        box.className = 'wg-rest';
        box.setAttribute('role', 'timer');
        const time = document.createElement('span');
        time.className = 'wg-rest__time';
        const body = document.createElement('div');
        body.className = 'wg-rest__body';
        const label = document.createElement('span');
        label.className = 'wg-eyebrow';
        const meter = document.createElement('div');
        meter.className = 'wg-meter';
        const fill = document.createElement('div');
        fill.className = 'wg-meter__fill';
        meter.appendChild(fill);
        body.append(label, meter);
        const plus = _wgBtn('+30s', 'wg-btn--sm wg-btn--ghost wg-rest__plus', () => _extendRest(30));
        const skip = _wgBtn('Skip', 'wg-btn--sm wg-rest__skip', () => _clearRest());
        box.append(time, body, plus, skip);
        dock.replaceChildren(box);
    }
    const left = Math.max(0, rest.left);
    box.querySelector('.wg-rest__time').textContent = _fmtSessionClock(left);
    box.querySelector('.wg-eyebrow').textContent = rest.label ? `Rest · ${rest.label}` : 'Rest';
    box.querySelector('.wg-meter__fill').style.setProperty('--p', `${Math.round((left / Math.max(1, rest.total)) * 100)}%`);
    dock.hidden = false;
}

function _ensureSessionTick() {
    const ui = _sessionUi();
    if (ui.tick) return;
    ui.tick = setInterval(_sessionTick, 1000);
}

function _stopSessionTick() {
    const ui = _sessionUi();
    if (ui.tick) { clearInterval(ui.tick); ui.tick = null; }
}

function _sessionTick() {
    const st = window.WorkoutSessionsState;
    if (!st.data) { _stopSessionTick(); return; }
    const clock = document.getElementById('workout-session-clock');
    if (clock) clock.textContent = _sessionClockText(st.data);
    const ui = _sessionUi();
    if (!ui.rest) return;
    // One second per tick, caught up to the wall clock when a hidden tab's
    // timers were throttled.
    ui.rest.left = Math.min(ui.rest.left - 1, Math.ceil((ui.rest.endAt - Date.now()) / 1000));
    if (ui.rest.left <= 0) {
        _clearRest();
        _notifyRestOver();
    } else {
        _renderRest();
    }
}

function _notifyRestOver() {
    if (typeof document === 'undefined' || !document.hidden) return;
    try {
        const sw = navigator.serviceWorker;
        if (!sw || !sw.ready) return;
        sw.ready
            .then((reg) => reg && reg.showNotification('Rest over', { body: 'Time for your next set.', tag: 'workout-rest' }))
            .catch(() => {});
    } catch (_) { /* best-effort */ }
}

async function showWorkoutSessionModal(sessionId) {
    // Fresh state is about to load — drop any autosave timer armed against the
    // session being replaced so it can't fire against the new one.
    cancelAutosave();
    // The plate-chip gear map belongs to one session open — drop it (and
    // any in-flight build) so the new session resolves its own variant.
    window.WorkoutSessionsState.plateGear = null;
    window.WorkoutSessionsState.plateGearPromise = null;
    const logsContainer = document.getElementById('workout-session-logs');
    const overlay = document.getElementById('modal-overlay');

    try {
        const data = await apiCall(`/api/workout/sessions/details?id=${sessionId}`);
        if (!data) return;

        const st = window.WorkoutSessionsState;
        // A re-open of the same session (add exercise, minimise → reopen) keeps
        // the view (current exercise, rest timer); another session starts fresh.
        const sameSession = !!(st.ui && st.ui.sessionId === data.session.id);
        if (!sameSession) {
            _stopSessionTick();
            st.ui = null;
            _sessionUi().sessionId = data.session.id;
        } else {
            // Last-session values and the PR baseline re-read on every open.
            st.ui.hist = {};
            st.ui.last = {};
        }

        window.WorkoutSessionsState.logs = data.logs || [];
        window.WorkoutSessionsState.data = data.session;
        window.WorkoutSessionsState.originalStatus = data.session.status;
        st.targetStatus = data.session.status;

        const sessionData = window.WorkoutSessionsState.data;
        if (sessionData && sessionData.variant_id > 0) {
            try {
                // Prefer the completion snapshot (immutable "plan as performed") so
                // later variant/library/target edits don't rewrite this session.
                // Each snapshot row carries its exercise_id so editing an un-logged
                // planned row can save (a logs/create with exercise_id 0 is
                // rejected). Dedupe against logs by exercise_id when the row has
                // one — so a plan with the same exercise name twice keeps both
                // un-logged rows visible — and fall back to name only for legacy
                // (id-less) snapshot rows. Fall back to the live variant entirely
                // for legacy (snapshot-less) sessions.
                const snapshot = sessionData.exercise_snapshot;
                let plannedMissingLogs;
                let plannedRows = null;
                // An un-logged planned row opens with zero done sets; its plan
                // target becomes the pending rows (ghost values) to tick off.
                const plannedRow = (exerciseId, ex) => ({
                    id: 0,
                    exercise_id: exerciseId || 0,
                    exercise_name: ex.exercise_name,
                    sets: [],
                    _setsInit: true,
                    sets_completed: 0,
                    reps_completed: 0,
                    weight_kg: 0,
                    notes: '',
                    status: 'completed',
                    _targetSets: Math.max(1, Math.round(Number(ex.target_sets) || 0)),
                    _target: { reps: ex.target_reps_min || 0, weight_kg: ex.target_weight_kg || 0 },
                    _dirty: false  // NOT saved unless a set is ticked done
                });
                if (Array.isArray(snapshot)) {
                    plannedRows = snapshot.map((ex) => ({ ...ex, _eid: ex.exercise_id || 0 }));
                    const loggedIds = new Set(
                        window.WorkoutSessionsState.logs
                            .filter(log => log.exercise_id)
                            .map(log => log.exercise_id)
                    );
                    const loggedNames = new Set(
                        window.WorkoutSessionsState.logs.map(log => log.exercise_name)
                    );
                    plannedMissingLogs = snapshot
                        .filter(ex => ex.exercise_id
                            ? !loggedIds.has(ex.exercise_id)
                            : !loggedNames.has(ex.exercise_name))
                        .map(ex => plannedRow(ex.exercise_id, ex));
                } else {
                    const plannedExercises = await apiCall(`/api/workout/exercises?variant_id=${sessionData.variant_id}`);
                    if (Array.isArray(plannedExercises)) {
                        plannedRows = plannedExercises.map((ex) => ({ ...ex, _eid: ex.id }));
                    }
                    if (Array.isArray(plannedExercises) && plannedExercises.length > 0) {
                        const existingByExerciseID = new Map();
                        window.WorkoutSessionsState.logs.forEach(log => {
                            if (log.exercise_id && !existingByExerciseID.has(log.exercise_id)) {
                                existingByExerciseID.set(log.exercise_id, true);
                            }
                        });

                        plannedMissingLogs = plannedExercises
                            .filter(ex => !existingByExerciseID.has(ex.id))
                            .map(ex => plannedRow(ex.id, ex));
                    }
                }

                // Logged exercises still show their plan's remaining sets as
                // pending rows (matched by exercise_id, name for legacy rows).
                if (plannedRows) {
                    window.WorkoutSessionsState.logs.forEach((log) => {
                        const ex = plannedRows.find((p) => (log.exercise_id && p._eid
                            ? p._eid === log.exercise_id : p.exercise_name === log.exercise_name));
                        if (!ex) return;
                        log._targetSets = Math.round(Number(ex.target_sets) || 0);
                        log._target = { reps: ex.target_reps_min || 0, weight_kg: ex.target_weight_kg || 0 };
                    });
                }

                if (plannedMissingLogs && plannedMissingLogs.length > 0) {
                    window.WorkoutSessionsState.logs = [...window.WorkoutSessionsState.logs, ...plannedMissingLogs];
                }
            } catch (prefillError) {
                console.error('Error pre-filling planned exercises:', prefillError);
            }
        }

        // Clear any stale autosave error from a previously-open session.
        setAutosaveStatus('saved');

        // Fresh open: land on the first exercise with sets still to do.
        const ui = _sessionUi();
        if (!sameSession) {
            const first = st.logs.findIndex((l) => !_logComplete(l));
            ui.current = first >= 0 ? first : 0;
        }

        renderWorkoutSessionHeader({ ...data.session, group_name: data.group_name });
        renderWorkoutSessionLogs(logsContainer);
        _renderRest();

        window.ModalManager.workoutSession.open();
        const modal = document.getElementById('workout-session-modal');
        if (modal && window.WGIcons && typeof window.WGIcons.hydrate === 'function') window.WGIcons.hydrate(modal);
        if (data.session.status === 'in_progress' || ui.rest) _ensureSessionTick();

        // Add click handler to overlay to close modal
        overlay.onclick = function (e) {
            if (e.target === overlay) {
                return closeWorkoutSessionModal();
            }
        };
    } catch (error) {
        console.error('Error loading session details:', error);
        safeToast('Error loading session details', 'error');
    }
}

function updateLocalLog(index, field, value) {
    const logs = window.WorkoutSessionsState.logs;
    if (!logs[index]) return;

    if (field === 'notes') {
        logs[index][field] = value;
    } else if (field === 'sets_completed' || field === 'reps_completed') {
        // Sets and reps must be integers
        logs[index][field] = Math.max(0, Math.round(parseFloat(value) || 0));
    } else {
        // Weight can be decimal
        logs[index][field] = Math.max(0, parseFloat(value) || 0);
    }
    // Mark as dirty so it gets saved
    logs[index]._dirty = true;
    // Update visual state — remove dim styling
    const el = document.getElementById(`exercise-log-${index}`);
    if (el) {
        el.classList.remove('unsaved');
        const hint = el.querySelector('.exercise-log-unsaved-hint');
        if (hint) hint.remove();
        // A flat weight edit moves the working weight — re-solve the plate chip.
        if (field === 'weight_kg') _refreshSessionPlateChip(el, logs[index]);
    }
    scheduleAutosave();
}

async function deleteExerciseLog(index) {
    const logs = window.WorkoutSessionsState.logs;
    const log = logs[index];
    if (!log) return;

    await safeConfirm(`Remove ${log.exercise_name} from this workout?`, async (ok) => {
        if (!ok) return;

        const logsContainer = document.getElementById('workout-session-logs');
        const sessionData = window.WorkoutSessionsState.data;
        // A plan-backed session re-materializes its planned exercises on every
        // modal open, so deleting the log (or splicing an un-logged planned row)
        // is not enough — the removal also has to land on the session snapshot.
        const planBacked = !!(sessionData && sessionData.variant_id > 0);
        const hadLog = !!(log.id && log.id > 0);

        // Optimistic: splice locally and re-render BEFORE awaiting the network
        // call so the row disappears instantly. Snapshot the removed entry so
        // we can restore on POST failure.
        const removed = logs.splice(index, 1)[0];
        if (logsContainer) renderWorkoutSessionLogs(logsContainer);

        // An unsaved row in an ad-hoc session has no backend state at all — the
        // local splice above is the whole operation.
        if (!hadLog && !planBacked) return;

        // Optimistic cache: drop the matching row from `workout_history`'s
        // session counts so the History sub-tab repaints with the new exercise
        // count before the round-trip resolves. An un-logged planned row only
        // ever counted toward exercises_count, never exercises_completed.
        const historyHandle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
            ? await window.DataStore.applyOptimistic('workout_history', (prev) => {
                if (!prev || !Array.isArray(prev.sessions)) return prev;
                const sessionId = window.WorkoutSessionsState?.data?.id;
                if (!sessionId) return prev;
                const next = { ...prev };
                next.sessions = prev.sessions.map((s) => {
                    if (s?.session?.id !== sessionId) return s;
                    const done = hadLog
                        ? Math.max(0, (s.exercises_completed || 0) - 1)
                        : (s.exercises_completed || 0);
                    const total = Math.max(done, (s.exercises_count || 0) - 1);
                    return { ...s, exercises_completed: done, exercises_count: total };
                });
                return next;
            }, ['workout'])
            : null;

        const restore = async () => {
            logs.splice(index, 0, removed);
            if (logsContainer) renderWorkoutSessionLogs(logsContainer);
            if (historyHandle) await historyHandle.rollback();
        };

        try {
            // Plan removal FIRST, log delete second, so `restore()` stays
            // truthful on a partial failure: if the plan removal fails nothing
            // has been written yet, and if it succeeds but the log delete fails
            // the log still exists — a restored row renders exactly what the
            // server holds either way. The reverse order could restore a row
            // whose log was already tombstoned.
            if (planBacked) {
                const result = await apiCall('/api/workout/sessions/planned-exercise/delete', 'POST', {
                    session_id: sessionData.id,
                    exercise_id: log.exercise_id || 0,
                    exercise_name: log.exercise_name,
                });
                // Network/5xx: restore the local row + cached count.
                if (result === null) return await restore();
            }
            if (hadLog) {
                const result = await apiCall(`/api/workout/sessions/logs/delete?id=${log.id}`, 'DELETE');
                if (result === null) return await restore();
            }
            if (historyHandle) await historyHandle.commit(null);
            await invalidateWorkoutCache();
        } catch (error) {
            // Hard failure: restore the local row + cached count, then surface.
            await restore();
            console.error('Error deleting exercise log:', error);
            safeToast('Failed to delete exercise log', 'error');
        }
    });
}

// bd med-ci6: the session-detail modal no longer carries its own Delete —
// deleting a session lives on the History row's trash icon
// (deleteWorkoutSessionById in features/workout/history.js), and every entry
// point that can open a completed/skipped session is such a row.

async function finishWorkoutSession() {
    if (!window.WorkoutSessionsState.data) return;
    // Drain any pending/in-flight autosave first so Finish doesn't run a second
    // save concurrently (which could re-create a not-yet-reconciled log).
    await flushPendingAutosave();
    const st = window.WorkoutSessionsState;
    if (!st.data) return;
    const ok = await safeForm('', _buildFinishSummary(), {
        title: 'Finish workout?',
        icon: 'flag',
        confirmLabel: 'Finish',
        cancelLabel: 'Keep going',
        collect: () => true,
    });
    if (!ok || !window.WorkoutSessionsState.data || window.WorkoutSessionsState.data !== st.data) return;
    _clearRest();
    st.targetStatus = 'completed';
    // Serialize through the same in-flight chain as autosave so a debounce timer
    // that fires during this network round-trip queues after Finish instead of
    // running a second, overlapping save.
    await runSerializedSave();
}

// The Finish dialog body: which sets are still unlogged (they are dropped —
// only done sets persist) and a time / sets / volume summary.
function _buildFinishSummary() {
    const st = window.WorkoutSessionsState;
    const wrap = document.createElement('div');
    wrap.className = 'wg-vstack';
    let left = 0;
    const names = [];
    let doneSets = 0;
    let volume = 0;
    st.logs.forEach((log) => {
        const sets = _ensureLogSets(log);
        const pending = _targetSets(log) - sets.length;
        if (pending > 0) { left += pending; names.push(log.exercise_name); }
        doneSets += sets.length;
        sets.forEach((s) => {
            if (s.set_type !== 'warmup') volume += (Number(s.weight_kg) || 0) * (Number(s.reps) || 0);
        });
    });
    const p = document.createElement('p');
    p.className = 'wg-workouts-session-finish__left';
    if (left > 0) {
        const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
        p.textContent = `Sets left: ${left}, across ${list}. They won't be saved. You can edit the session later from History.`;
    } else {
        p.textContent = 'All sets logged. You can edit the session later from History.';
    }
    wrap.appendChild(p);

    const grid = document.createElement('div');
    grid.className = 'wg-grid3';
    const stat = (label, value) => {
        const s = document.createElement('div');
        s.className = 'wg-stat';
        const v = document.createElement('span');
        v.className = 'wg-stat__value wg-stat__value--md';
        v.textContent = value;
        const l = document.createElement('span');
        l.className = 'wg-eyebrow';
        l.textContent = label;
        s.append(l, v);
        return s;
    };
    const vol = volume >= 1000 ? `${_fmtSetNumber(Math.round(volume / 100) / 10)} t` : `${_fmtSetNumber(Math.round(volume))} kg`;
    grid.append(stat('Time', _sessionClockText(st.data)), stat('Sets', String(doneSets)), stat('Volume', vol));
    wrap.appendChild(grid);
    return wrap;
}

// Footer (kit .wg-session-foot): prev / next exercise and, while the workout
// runs, Finish.
function renderSessionDetailActions(container, opts) {
    container.classList.add('wg-workouts-session-actions');
    container.replaceChildren();

    const onFinish = (opts && typeof opts.onFinish === 'function') ? opts.onFinish : () => {};
    const st = window.WorkoutSessionsState;
    const ui = _sessionUi();
    const n = (st.logs || []).length;

    if (!ui.overview && n > 1) {
        const prev = _wgBtn('', 'wg-btn--ghost wg-btn--icon wg-workouts-session-actions__prev', () => _showSessionExercise(ui.current - 1));
        prev.setAttribute('aria-label', 'Previous exercise');
        prev.disabled = ui.current <= 0;
        prev.appendChild(_wgIco('chev-l'));
        const next = _wgBtn('', 'wg-btn--ghost wg-btn--sm wg-workouts-session-actions__next', () => _showSessionExercise(ui.current + 1));
        next.disabled = ui.current >= n - 1;
        next.append(document.createTextNode('Next'), _wgIco('chev-r', 'wg-ico--sm'));
        container.append(prev, next);
    }

    // bd med-4ca: Finish only makes sense while the workout is actually
    // running. On a finished session a second tap re-stamped completed_at and
    // skipped a rotation variant; the domain guards that now, but the button
    // should not offer a no-op either. A finished session changes its status
    // from the overview's Status row.
    if (st?.data?.status !== 'in_progress') return;

    // Never offline-gated (med-mgvo): the status write is local-first, so a
    // tap must always persist or surface an error — never silently no-op.
    const finishBtn = _wgBtn('Finish', 'wg-btn--primary wg-workouts-session-actions__finish', () => onFinish());
    finishBtn.id = 'workout-session-finish-btn';
    container.appendChild(finishBtn);
}

async function closeWorkoutSessionModal() {
    // Flush any pending debounced edit before dismissing so a change made right
    // before Close (or an overlay click) isn't dropped. If that flush fails
    // (offline / 5xx) keep the modal open — settleFailure already surfaced the
    // inline error and restored the dirty flags, so bailing here preserves the
    // unsaved edit for a retry instead of tearing the modal down and losing it.
    // Runs before state is nulled so the save can still read WorkoutSessionsState.
    if (!(await flushPendingAutosave())) return;
    // med-laj4: closing a still-running workout that has saved sets is how a
    // Finish gets forgotten. Nudge, never block. originalStatus tracks the
    // last persisted status, so the Finish path's own close stays quiet.
    const st = window.WorkoutSessionsState;
    if (st.data && st.originalStatus === 'in_progress' && (st.logs || []).some(l => l.id > 0)) {
        safeToast('Workout still unfinished — open it and tap Finish when done.', 'info');
    }
    const overlay = document.getElementById('modal-overlay');
    overlay.onclick = null; // Remove click handler
    // med-xso6.31: every session close (Finish, ×, overlay, Back, flush) routes
    // here; the Add-exercise sub-modal must go with it or it floats, overlay-less,
    // over whatever tab shows next.
    window.ModalManager.workoutAddExerciseToSession.close();
    window.ModalManager.workoutSession.close();
    // The rest timer and clock stop on minimise (best-effort timer; the view
    // — current exercise — is kept for a re-open of the same session).
    _stopSessionTick();
    _clearRest();
    window.WorkoutSessionsState.data = null;
    window.WorkoutSessionsState.originalStatus = null;
    window.WorkoutSessionsState.targetStatus = null;
    window.WorkoutSessionsState.plateGear = null;
    window.WorkoutSessionsState.plateGearPromise = null;
}

async function saveWorkoutSessionDetails(opts) {
    // Two callers share this write path:
    //  - "Finish workout" (finishWorkoutSession → status=completed): closes the
    //    modal on success and drives busy-state feedback on the Finish button.
    //  - Debounced autosave (fromAutosave): must NOT close the modal and must
    //    NOT hijack the Finish button — it drives the inline status element.
    const fromAutosave = !!(opts && opts.fromAutosave);
    // A timer that fired just before the modal closed would otherwise re-save a
    // torn-down session (the log loop UPDATEs every log unconditionally). Nothing
    // to autosave once state is gone. Finish guards its own state before calling.
    if (fromAutosave && (!window.WorkoutSessionsState || !window.WorkoutSessionsState.data)) return true;
    // Autosave never closes the modal; the deliberate Finish path always does.
    const closeOnSuccess = !fromAutosave;

    const finishBtn = document.getElementById('workout-session-finish-btn');
    const busyTargets = fromAutosave ? [] : [finishBtn].filter(Boolean);
    const feedbackBtn = fromAutosave ? null : finishBtn;
    const originalText = feedbackBtn ? feedbackBtn.textContent : '';

    const optimisticHandles = [];
    async function rollbackOptimistic() {
        for (const h of optimisticHandles) {
            try { await h.rollback(); } catch (_) { /* best-effort */ }
        }
    }

    try {
        busyTargets.forEach((btn) => {
            btn.disabled = true;
            btn.classList.add('wg-btn-saving');
        });
        if (feedbackBtn) feedbackBtn.textContent = 'Saving...';
        if (fromAutosave) setAutosaveStatus('saving');

        // Check if status has changed (Finish / the overview's Status row set
        // targetStatus; originalStatus is the last persisted one).
        const newStatus = window.WorkoutSessionsState.targetStatus || window.WorkoutSessionsState.originalStatus;
        const statusChanged = newStatus !== window.WorkoutSessionsState.originalStatus;

        // Validate all logs before saving
        const logs = window.WorkoutSessionsState.logs;
        for (const log of logs) {
            if (log.sets_completed < 0 || log.reps_completed < 0 || log.weight_kg < 0) {
                throw new Error('Values cannot be negative');
            }
            if (log.sets_completed > 20 || log.reps_completed > 100 || log.weight_kg > 500) {
                throw new Error('Values exceed maximum allowed');
            }
        }

        // Optimistic cache projection (BEFORE network round-trip): flip the
        // cached session.status in workout_history so the list repaints
        // immediately, and when finishing a workout, null out workout_next so
        // the Today / Workouts subtab card disappears the moment the user
        // taps Finish.
        const sessionData = window.WorkoutSessionsState.data;
        if (statusChanged && sessionData && window.DataStore && typeof window.DataStore.applyOptimistic === 'function') {
            optimisticHandles.push(await window.DataStore.applyOptimistic('workout_history', (prev) => {
                if (!prev || !Array.isArray(prev.sessions)) return prev;
                const next = { ...prev };
                next.sessions = prev.sessions.map((s) => {
                    if (s?.session?.id !== sessionData.id) return s;
                    return { ...s, session: { ...s.session, status: newStatus } };
                });
                return next;
            }, ['workout']));
            if (newStatus === 'completed' || newStatus === 'skipped') {
                optimisticHandles.push(await window.DataStore.applyOptimistic('workout_next', (prev) => {
                    if (prev?.session?.id === sessionData.id) return { session: null };
                    return prev;
                }, ['workout']));
            }
        }

        // Track whether any mutation succeeded so we can invalidate the
        // workout-tagged caches before any early return — otherwise a
        // partial failure (a log saved, a later write returns null) leaves
        // workout_history / workout_stats holding the pre-mutation payload
        // until the next manual refresh.
        let anyMutationSucceeded = false;
        let statusPersisted = false;

        // Skipping flips the status BEFORE the log writes below, so those writes
        // hit an already-skipped session and their plan propagation no-ops — a
        // skipped session must never advance the plan (mirror/progression is for
        // completed sessions only). Completing (or staying in_progress) keeps the
        // inverted order: logs first so propagation runs while the session is
        // still in_progress, status flip last.
        const skipFirst = statusChanged && sessionData && newStatus === 'skipped';

        async function persistStatus() {
            const statusResult = await apiCall(`/api/workout/sessions/status?id=${sessionData.id}`, 'PUT', {
                status: newStatus
            }, { suppressWriteAlert: fromAutosave });
            if (statusResult === null) return false;
            anyMutationSucceeded = true;
            statusPersisted = true;
            return true;
        }

        // On failure the optimistic projection is normally rolled back — status is
        // saved LAST for completion, so a failure before it means the server status
        // never changed and the projected flip is wrong. But on the skip path the
        // status PUT already landed first, so its projection matches the server:
        // commit it and just invalidate so the failed log write reconciles on the
        // next read (persisted writes are picked up via the tag invalidation).
        async function settleFailure() {
            // A null apiCall result is a soft (network/5xx) failure. For autosave
            // keep the modal open, keep local edits, and surface the inline error
            // (Task 4) — never drop what the user typed.
            if (fromAutosave) setAutosaveStatus('error');
            if (statusPersisted) {
                for (const h of optimisticHandles) {
                    try { await h.commit(null); } catch (_) { /* best-effort */ }
                }
                await invalidateWorkoutCache();
                return;
            }
            await rollbackOptimistic();
            if (anyMutationSucceeded) await invalidateWorkoutCache();
        }

        if (skipFirst) {
            if (!(await persistStatus())) { await settleFailure(); return false; }
        }

        // Save each log before the terminal status flip below (completion path).
        // Schedule propagation — which applies opt-in progression (linear/double)
        // onto the plan targets — only fires while the session is still
        // pending/notified/in_progress. Flipping status to completed first would
        // make every qualifying log write a no-op, so the "edit sets, Finish
        // workout" flow would silently skip progression.
        // Only save new entries that the user actually edited (_dirty).
        for (const log of logs) {
            let logResult;
            let attempted = false;
            // Claim the dirty flags BEFORE the await, and snapshot the per-set
            // array. An edit landing while this write is in flight re-marks the
            // log (and re-arms the debounce) so the *next* autosave re-sends it.
            // Clearing the flags only AFTER the await would clobber that fresh
            // edit — the classic read-clear race that silently drops the
            // just-typed per-set data. The snapshot keeps the payload consistent
            // even if the live sets array is mutated mid-flight. On a soft failure
            // we restore the flags so the pending edit is retried, not lost.
            const sentSets = !!(log._setsDirty && Array.isArray(log.sets));
            const setsPayload = sentSets ? log.sets.map((s) => ({ ...s })) : null;
            try {
                if (log.id && log.id > 0) {
                    // Existing log — always update
                    attempted = true;
                    log._dirty = false;
                    log._setsDirty = false;
                    logResult = await apiCall('/api/workout/sessions/logs/update', 'POST', {
                        id: log.id,
                        sets_completed: Math.round(log.sets_completed),
                        reps_completed: Math.round(log.reps_completed),
                        weight_kg: parseFloat(log.weight_kg),
                        notes: log.notes || '',
                        // Per-set array rides alongside the derived flat scalars, but
                        // only when the user actually edited the SETS (_setsDirty),
                        // not on any edit (_dirty is also set by a notes-only edit).
                        // Render materializes log.sets on every card (_ensureLogSets),
                        // so gating on _dirty would persist a fabricated
                        // N-identical-sets array whenever a legacy/flat-only log's
                        // notes were touched. Absent key ⇒ cloud updateLog keeps any
                        // real stored sets (it spreads the existing record); bot
                        // ignores the key either way (Task 3).
                        ...(setsPayload ? { sets: setsPayload } : {})
                    }, { suppressWriteAlert: fromAutosave });
                } else if (log._dirty && log._setsInit && Array.isArray(log.sets) && log.sets.length === 0
                    && !(Number(log.sets_completed) > 0) && !log.notes) {
                    // A planned row whose sets were all un-ticked again: nothing
                    // to create. Drop the flags so it doesn't re-try forever.
                    log._dirty = false;
                    log._setsDirty = false;
                } else if (log._dirty) {
                    // New log that user actually edited — create it
                    attempted = true;
                    log._dirty = false;
                    log._setsDirty = false;
                    logResult = await apiCall('/api/workout/sessions/logs/create', 'POST', {
                        session_id: sessionData.id,
                        exercise_id: log.exercise_id,
                        exercise_name: log.exercise_name,
                        target_sets: Math.round(log.sets_completed),
                        target_reps_min: Math.round(log.reps_completed),
                        target_weight_kg: parseFloat(log.weight_kg),
                        status: 'completed',
                        notes: log.notes || '',
                        ...(setsPayload ? { sets: setsPayload } : {})
                    }, { suppressWriteAlert: fromAutosave });
                }
            } catch (writeErr) {
                // A THROWN write (AbortController timeout → e.aborted, or the cloud
                // domain layer's invalid_request) bypasses the null-result restore
                // below and unwinds to the outer catch, which never touches these
                // flags. Restore the claimed dirty flags here so the pending edit
                // is retried on the next autosave instead of being silently dropped
                // (the next successful save would otherwise omit the un-flagged
                // sets, or skip the un-flagged create entirely).
                if (attempted) {
                    log._dirty = true;
                    if (sentSets) log._setsDirty = true;
                }
                throw writeErr;
            }
            if (attempted && logResult === null) {
                // Restore the claimed flags so the edit is retried on the next
                // autosave rather than silently dropped.
                log._dirty = true;
                if (sentSets) log._setsDirty = true;
                await settleFailure();
                return false;
            }
            if (attempted) {
                anyMutationSucceeded = true;
                // Adopt the server id so a *subsequent* autosave routes through the
                // idempotent update path. Without this, a created placeholder keeps
                // id===0 && _dirty, so the next autosave hits logs/create again →
                // createLog's dedup guard throws 'conflict' (blocking alert + aborts
                // the batch, and later bricks Finish). Flags were already claimed
                // above; re-clearing here would clobber a mid-flight edit.
                if (logResult && logResult.id) log.id = logResult.id;
            }
            // Skip: id===0 && !_dirty — pre-filled but untouched, don't save
        }

        // Save status LAST — after the logs above have propagated to the plan
        // (skipped sessions already flipped their status first, above).
        if (statusChanged && sessionData && !skipFirst) {
            if (!(await persistStatus())) {
                await settleFailure();
                return false;
            }
        }

        // All requested mutations succeeded — commit the optimistic state
        // (leave it in cache) then invalidate so the next read fetches
        // authoritative server data layered on top.
        // Advance the baseline so a *subsequent* autosave doesn't see the same
        // status as still-changed and re-PUT it (and re-apply workout_next /
        // gamification) on every later keystroke-batch.
        if (statusChanged && window.WorkoutSessionsState) {
            window.WorkoutSessionsState.originalStatus = newStatus;
        }
        for (const h of optimisticHandles) await h.commit(null);
        if (anyMutationSucceeded || optimisticHandles.length > 0) {
            await invalidateWorkoutCache();
        }
        // Finishing via this modal (the primary "Finish workout" path, also reached
        // by finishWorkoutSession) sets status=completed, which grants Movement-ring
        // HP — evict the gamification caches like completeWorkoutSession does so the
        // Today rings/Journey repaint instead of showing stale HP until cache expiry.
        if (statusChanged && newStatus === 'completed' && window.DataStore) {
            await window.DataStore.invalidateTags(['gamification']).catch(() => {});
        }

        // Autosave stays put; only the deliberate Finish path closes the modal.
        if (fromAutosave) setAutosaveStatus('saved');
        if (closeOnSuccess) {
            // This save already persisted everything; drop any pending timer so
            // the close-triggered flush doesn't re-save the just-completed session.
            cancelAutosave();
            closeWorkoutSessionModal();
            loadWorkoutHistoryTab();
        }
        return true; // all requested mutations persisted — safe to close
    } catch (error) {
        await rollbackOptimistic();
        console.error('Error saving workout details:', error);
        const message = error.message || 'Error saving workout details. Please try again.';
        // Autosave failures surface inline (Task 4) and keep the modal + local
        // edits intact; only the explicit Finish path pops a blocking alert.
        if (fromAutosave) setAutosaveStatus('error', message);
        else safeToast(message, 'error');
        return false; // save failed — close path keeps the modal open
    } finally {
        busyTargets.forEach((btn) => {
            btn.classList.remove('wg-btn-saving');
            btn.disabled = false;
        });
        if (feedbackBtn) feedbackBtn.textContent = originalText;
    }
}

// ====================================
// SESSION LIFECYCLE — ad-hoc / start / skip / complete
// ====================================

async function startAdHocWorkout() {
    // Optimistic cache projection: clear `workout_next` so the rest-day card
    // doesn't keep rendering "Start ad-hoc" while the POST is in flight; the
    // server response replaces the cache with the actual new session.
    const nextHandle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
        ? await window.DataStore.applyOptimistic('workout_next', () => ({ session: null }), ['workout'])
        : null;

    try {
        // Create ad-hoc workout session via API
        const result = await apiCall('/api/workout/sessions/adhoc', 'POST');

        if (result && result.session) {
            // Immediately open the session modal to start logging exercises
            await showWorkoutSessionModal(result.session.id);

            if (nextHandle) await nextHandle.commit({ session: result.session });
            await invalidateWorkoutCache();
            await loadNextWorkout();
        } else {
            if (nextHandle) await nextHandle.rollback();
            safeToast('Failed to start ad-hoc workout', 'error');
        }
    } catch (error) {
        if (nextHandle) await nextHandle.rollback();
        console.error('Error starting ad-hoc workout:', error);
        safeToast('Error starting ad-hoc workout: ' + error.message, 'error');
    }
}

async function startWorkoutSession(sessionId) {
    // The pre-confirm stays (bd med-bp6t judgement call): starting is a
    // state-changing write — it stamps started_at, answers the session's
    // reminder chain, and can re-key a future session onto today — so an
    // accidental tap on Start keeps its guard. Only the success alert goes.
    await safeConfirm('Start this workout now?', async (ok) => {
        if (!ok) return;

        // Optimistic cache projection, mirroring startAdHocWorkout: clear
        // `workout_next` while the POST is in flight; commit on success,
        // roll back on any failure.
        const nextHandle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
            ? await window.DataStore.applyOptimistic('workout_next', () => ({ session: null }), ['workout'])
            : null;
        const toastError = (msg) => {
            if (window.SyncManager && typeof window.SyncManager.showToast === 'function') {
                window.SyncManager.showToast(msg, 'error');
            }
        };

        try {
            const result = await apiCall(`/api/workout/sessions/${sessionId}/start`, 'POST');
            if (result === null) {
                if (nextHandle) await nextHandle.rollback();
                toastError('Failed to start workout');
                return;
            }

            // Open the session modal directly — no success alert (bd med-bp6t).
            // The start route returns true, so the id we already hold is used.
            await showWorkoutSessionModal(sessionId);

            if (nextHandle) await nextHandle.commit(null);
            await invalidateWorkoutCache();
            await loadNextWorkout();
        } catch (error) {
            if (nextHandle) await nextHandle.rollback();
            console.error('Error starting workout:', error);
            toastError('Error starting workout: ' + error.message);
        }
    });
}

async function completeWorkoutSession(sessionId) {
    await safeConfirm('Finish this workout now? It will be marked as completed.', async (ok) => {
        if (!ok) return;

        // Optimistic cache projection: flip the cached session.status in
        // workout_history so the list repaints immediately, and null out
        // workout_next so the Today / Workouts subtab card disappears as soon
        // as the user confirms.
        const handles = [];
        if (window.DataStore && typeof window.DataStore.applyOptimistic === 'function') {
            handles.push(await window.DataStore.applyOptimistic('workout_history', (prev) => {
                if (!prev || !Array.isArray(prev.sessions)) return prev;
                const next = { ...prev };
                next.sessions = prev.sessions.map((s) => {
                    if (s?.session?.id !== sessionId) return s;
                    return { ...s, session: { ...s.session, status: 'completed' } };
                });
                return next;
            }, ['workout']));
            handles.push(await window.DataStore.applyOptimistic('workout_next', (prev) => {
                if (prev?.session?.id === sessionId) return { session: null };
                return prev;
            }, ['workout']));
        }

        try {
            const result = await apiCall(`/api/workout/sessions/status?id=${sessionId}`, 'PUT', { status: 'completed' });
            if (result === null) {
                for (const h of handles) { try { await h.rollback(); } catch (_) { /* best-effort */ } }
                return;
            }
            for (const h of handles) await h.commit(null);
            await invalidateWorkoutCache();
            // Completing a workout grants Movement-ring HP (loadMovement scores
            // completed sessions), so evict the gamification caches too — the
            // refetch hits the read-rescore and repaints the Today rings/HP.
            if (window.DataStore) await window.DataStore.invalidateTags(['gamification']).catch(() => {});
            loadNextWorkout();
            loadWorkoutHistoryTab(); // Refresh history if visible
        } catch (e) {
            for (const h of handles) { try { await h.rollback(); } catch (_) { /* best-effort */ } }
            console.error(e);
            safeToast('Failed to finish workout', 'error');
        }
    });
}

async function preSkipWorkoutSession(sessionId) {
    await safeConfirm('Mark this workout as to-be-skipped? No notification will be sent and it will be automatically skipped at the scheduled time.', async (ok) => {
        if (!ok) return;

        // Optimistic: flip workout_next.session.status to 'pre_skipped' so the
        // next-card swaps Start/Skip → Cancel Skip without waiting on the POST.
        const handle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
            ? await window.DataStore.applyOptimistic('workout_next', (prev) => {
                if (!prev || !prev.session || prev.session.id !== sessionId) return prev;
                return { ...prev, session: { ...prev.session, status: 'pre_skipped' } };
            }, ['workout'])
            : null;

        try {
            const result = await apiCall(`/api/workout/sessions/${sessionId}/preskip`, 'POST');
            if (result === null) {
                if (handle) await handle.rollback();
                return;
            }
            if (handle) await handle.commit(null);
            await invalidateWorkoutCache();
            loadNextWorkout();
        } catch (error) {
            if (handle) await handle.rollback();
            console.error('Error pre-skipping workout:', error);
            safeToast('Failed to mark workout as skipped. Please try again.', 'error');
        }
    });
}

async function cancelPreSkipWorkoutSession(sessionId) {
    // Optimistic: flip workout_next.session.status back to 'pending' so the
    // card swaps Cancel Skip → Start/Skip without waiting on the POST.
    const handle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
        ? await window.DataStore.applyOptimistic('workout_next', (prev) => {
            if (!prev || !prev.session || prev.session.id !== sessionId) return prev;
            return { ...prev, session: { ...prev.session, status: 'pending' } };
        }, ['workout'])
        : null;

    try {
        const result = await apiCall(`/api/workout/sessions/${sessionId}/cancel-preskip`, 'POST');
        if (result === null) {
            if (handle) await handle.rollback();
            return;
        }
        if (handle) await handle.commit(null);
        await invalidateWorkoutCache();
        loadNextWorkout();
    } catch (error) {
        if (handle) await handle.rollback();
        console.error('Error cancelling pre-skip:', error);
        safeToast('Failed to cancel skip. Please try again.', 'error');
    }
}

// ====================================
// ADD EXERCISE TO SESSION
// ====================================

async function showAddExerciseToSessionModal() {
    if (!window.WorkoutSessionsState.data) return;

    // Reset fields
    const hiddenId = document.getElementById('session-add-exercise-id');
    document.getElementById('session-add-exercise-name').value = '';
    hiddenId.value = '';
    delete hiddenId.dataset.pickedName;
    document.getElementById('session-add-exercise-sets').value = '';
    document.getElementById('session-add-exercise-reps').value = '';
    document.getElementById('session-add-exercise-weight').value = '';
    document.getElementById('session-add-exercise-notes').value = '';

    const titleEl = document.getElementById('workout-add-exercise-to-session-title');
    if (titleEl) titleEl.textContent = 'Add exercise';

    // Shared inline suggestion list (med-prk.3, med-max): library + catalog
    // names, rendered under the field instead of in a native <datalist> popup.
    await window.WorkoutLibrary.bindExercisePicker({
        input: document.getElementById('session-add-exercise-name'),
        mount: document.getElementById('session-add-exercise-suggest'),
        onPick: onSessionExercisePicked
    });
    // The session may have closed while the picker loaded (med-xso6.31).
    if (!window.WorkoutSessionsState.data) return;

    window.ModalManager.workoutAddExerciseToSession.open();

    // Ensure overlay closes this modal too
    const overlay = document.getElementById('modal-overlay');
    overlay.onclick = function (e) {
        if (e.target === overlay) {
            closeAddExerciseToSessionModal();
        }
    };
}

function closeAddExerciseToSessionModal() {
    window.ModalManager.workoutAddExerciseToSession.close();

    // Revert overlay onclick to close session modal
    const overlay = document.getElementById('modal-overlay');
    overlay.onclick = function (e) {
        if (e.target === overlay) {
            return closeWorkoutSessionModal();
        }
    };
}

// A row was tapped in the inline suggestion list. Library items carry an id and
// the defaults that pre-fill the quick-add fields; catalog-only items carry
// neither, so the hidden id stays empty and saveNewSessionExercise routes the
// name through resolveOrCreateLibraryId instead of posting exercise_id
// "undefined"/NaN (med-prk.3).
function onSessionExercisePicked(item) {
    const hiddenId = document.getElementById('session-add-exercise-id');
    hiddenId.value = item.id || '';
    // Remember which name this id belongs to: picking does not fire `change`,
    // but the later blur does, and onSessionExerciseSelect must be able to tell
    // "still the picked name" from "hand-edited since".
    hiddenId.dataset.pickedName = item.name || '';

    _setSessionExerciseTitle(item.name || '');
    if (item.id == null) return;

    // Autofill if empty.
    const setsEl = document.getElementById('session-add-exercise-sets');
    const repsEl = document.getElementById('session-add-exercise-reps');
    const weightEl = document.getElementById('session-add-exercise-weight');
    if (!setsEl.value && item.default_sets) setsEl.value = item.default_sets;
    if (!repsEl.value && item.default_reps_min) repsEl.value = item.default_reps_min;
    if (!weightEl.value && item.default_weight_kg) weightEl.value = item.default_weight_kg;
}

function _setSessionExerciseTitle(name) {
    const titleEl = document.getElementById('workout-add-exercise-to-session-title');
    if (titleEl) titleEl.textContent = name ? `Log set · ${name}` : 'Add exercise';
}

// Bound to the name field's `change`. Keeps the modal title in step with the
// typed name, and drops a hidden id that no longer belongs to it — the id is
// only valid for the exact name that was picked from the suggestion list.
function onSessionExerciseSelect() {
    const val = document.getElementById('session-add-exercise-name').value;
    const hiddenId = document.getElementById('session-add-exercise-id');
    _setSessionExerciseTitle(val);
    if ((hiddenId.dataset.pickedName || '') !== val) hiddenId.value = '';
}

async function saveNewSessionExercise() {
    const sessionData = window.WorkoutSessionsState.data;
    if (!sessionData) return;

    // Drain any pending/in-flight autosave first. Otherwise a debounce timer
    // armed by a prior edit can fire during the create awaits below and iterate
    // the just-pushed optimistic log (id:0, _dirty) → a second logs/create for
    // the same exercise (dedup conflict). Flushing also persists that prior edit
    // before the modal reload at the end reloads clean server state (which would
    // otherwise drop it). If the flush FAILS (offline/5xx), bail like
    // closeWorkoutSessionModal does: settleFailure already restored the dirty
    // flags + inline error, so proceeding to create + reload would drop that
    // preserved edit. The add-exercise modal stays open with the typed values.
    if (!(await flushPendingAutosave())) {
        safeAlert('Could not save your previous change — fix that first, then add the exercise.');
        return;
    }
    if (!window.WorkoutSessionsState.data) return;

    const name = document.getElementById('session-add-exercise-name').value.trim();
    let exerciseId = document.getElementById('session-add-exercise-id').value;
    const sets = parseInt(document.getElementById('session-add-exercise-sets').value);
    const reps = parseInt(document.getElementById('session-add-exercise-reps').value);
    const weightRaw = document.getElementById('session-add-exercise-weight').value;
    const weight = weightRaw !== '' ? parseFloat(weightRaw) : null;
    const notes = document.getElementById('session-add-exercise-notes').value.trim();

    if (!name || !sets || !reps) {
        safeAlert('Name, sets, and reps are required');
        return;
    }

    // Enforce the same ceilings as saveWorkoutSessionDetails / addLocalSet.
    // The modal's max="20" is only a soft hint — Save is a button handler, so a
    // typed/pasted value (e.g. 21, or a huge number that would OOM the tab via
    // Array.from below) reaches here unclamped.
    if (sets > 20 || reps > 100 || (weight != null && weight > 500)) {
        safeAlert('Values exceed maximum allowed');
        return;
    }

    if (!exerciseId) {
        // Nothing was picked from the suggestion list (free-typed, or the name
        // was edited after picking). resolveOrCreateLibraryId matches the
        // library case-insensitively by name first and only INSERTs when the
        // name is genuinely new (med-prk.3) — create-new is allowed here.
        exerciseId = await window.WorkoutLibrary.resolveOrCreateLibraryId(name, {
            sets: sets, repsMin: reps, weight: weight
        });
        if (!exerciseId) {
            safeToast('Failed to add exercise', 'error');
            return;
        }
    }

    // Optimistic: push the new log into the session modal's logs array and
    // re-render BEFORE awaiting the network call, so the row appears
    // instantly. Carries `_optimistic: true` so we can splice it out on
    // POST failure without removing user-edited rows by accident.
    // Seed the per-set array from the quick-add sets/reps/weight so the log
    // round-trips per-set data (and can be refined set-by-set in the modal);
    // the flat scalars are kept for bot mode + existing consumers.
    const setRows = Array.from({ length: Math.max(1, sets) }, (_, i) => ({
        set_index: i, weight_kg: weight == null ? 0 : weight, reps, set_type: 'normal'
    }));
    const optimisticLog = {
        id: 0,
        exercise_id: parseInt(exerciseId),
        exercise_name: name,
        sets_completed: sets,
        reps_completed: reps,
        weight_kg: weight == null ? 0 : weight,
        sets: setRows,
        notes: notes,
        status: 'completed',
        _dirty: true,
        _setsDirty: true,
        _optimistic: true
    };
    const prevLogs = window.WorkoutSessionsState.logs;
    window.WorkoutSessionsState.logs = [...prevLogs, optimisticLog];
    // The takeover jumps to the exercise just added.
    const ui = _sessionUi();
    const prevCurrent = ui.current;
    ui.current = prevLogs.length;
    ui.overview = false;
    ui.active = null;
    const logsContainer = document.getElementById('workout-session-logs');
    if (logsContainer) renderWorkoutSessionLogs(logsContainer);
    closeAddExerciseToSessionModal();

    // Optimistic cache: bump the affected session's exercise count in the
    // cached workout_history payload so the History sub-tab repaints with
    // the new total before the POST resolves.
    const historyHandle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
        ? await window.DataStore.applyOptimistic('workout_history', (prev) => {
            if (!prev || !Array.isArray(prev.sessions)) return prev;
            const next = { ...prev };
            next.sessions = prev.sessions.map((s) => {
                if (s?.session?.id !== sessionData.id) return s;
                const done = (s.exercises_completed || 0) + 1;
                const total = Math.max(done, (s.exercises_count || 0) + 1);
                return { ...s, exercises_completed: done, exercises_count: total };
            });
            return next;
        }, ['workout'])
        : null;

    function restoreOptimistic() {
        const current = window.WorkoutSessionsState.logs;
        window.WorkoutSessionsState.logs = current.filter((l) => l !== optimisticLog);
        ui.current = prevCurrent;
        if (logsContainer) renderWorkoutSessionLogs(logsContainer);
    }

    try {
        const result = await apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: sessionData.id,
            exercise_id: parseInt(exerciseId),
            exercise_name: name,
            target_sets: sets,
            target_reps_min: reps,
            target_weight_kg: weight,
            status: 'completed',
            notes: notes,
            source: 'library',
            sets: setRows
        });
        if (result === null) {
            restoreOptimistic();
            if (historyHandle) await historyHandle.rollback();
            return;
        }

        if (historyHandle) await historyHandle.commit(null);
        await invalidateWorkoutCache();
        // Refresh session modal so the local optimistic entry is replaced
        // with the authoritative server payload (real id, server-stamped
        // timestamps, any AI-derived fields). Reopen reloads clean state and
        // cancels any pending timer — the exercise is already persisted above,
        // so there is nothing left to autosave here.
        await showWorkoutSessionModal(sessionData.id);
        const added = window.WorkoutSessionsState.logs.findIndex((l) => result && result.id && l.id === result.id);
        if (added >= 0 && window.WorkoutSessionsState.ui === ui) {
            ui.current = added;
            _rerenderSessionLogs();
        }
    } catch (error) {
        restoreOptimistic();
        if (historyHandle) await historyHandle.rollback();
        console.error(error);
        safeToast('Failed to add exercise', 'error');
    }
}

window.WorkoutSessions = {
    open: showWorkoutSessionModal,
    close: closeWorkoutSessionModal,
    save: saveWorkoutSessionDetails,
    finish: finishWorkoutSession,
    renderHeader: renderWorkoutSessionHeader,
    setLocation: setWorkoutSessionLocation,
    refreshGear: refreshSessionPlateGear,
    setStatus: setWorkoutSessionStatus,
    toggleOverview: toggleWorkoutSessionOverview,
    renderLogs: renderWorkoutSessionLogs,
    renderActions: renderSessionDetailActions,
    updateLog: updateLocalLog,
    deleteLog: deleteExerciseLog,
    startAdHoc: startAdHocWorkout,
    start: startWorkoutSession,
    complete: completeWorkoutSession,
    preSkip: preSkipWorkoutSession,
    cancelPreSkip: cancelPreSkipWorkoutSession,
    openAddExercise: showAddExerciseToSessionModal,
    closeAddExercise: closeAddExerciseToSessionModal,
    saveAddExercise: saveNewSessionExercise
};
