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
// cache. Lives on WorkoutSessionsState.ui (no module state); the view (and
// `targets`, below) survives a reload of the same session (add exercise) and
// a minimise → reopen, and resets when another session opens. The rest timer
// stops on minimise.
const SESSION_REST_SECONDS = 90; // ponytail: one default rest; per-exercise rest has no field to read yet

function _sessionUi() {
    const st = window.WorkoutSessionsState;
    if (!st.ui) {
        st.ui = { sessionId: null, current: 0, overview: false, active: null, more: null, rest: null, tick: null, hist: {}, targets: {}, suggest: {}, suggestOpen: {} };
    }
    return st.ui;
}

// Each autosave of an in-progress session mirrors the done-set count into the
// live plan's target_sets (domain mirrorPatch), so a reopen would read a plan
// that shrank mid-workout and drop the pending rows. `ui.targets` remembers
// each exercise's row count for this session; a reopen never goes below it.
// ponytail: in-memory only — a full page reload falls back to the (mirrored)
// plan; persist per session if that bites.
function _logKey(log) {
    return log.exercise_id ? `id:${log.exercise_id}` : `name:${log.exercise_name}`;
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

// The top bar's right slot (kit W1, med-t5s6): while the workout runs it
// holds Finish — top-vs-bottom keeps it far from Next; a finished session
// shows its Completed/Skipped chip instead.
function _renderSessionStatusChip(status) {
    const el = document.getElementById('workout-session-modal-status');
    if (!el) return;
    if (status === 'in_progress') {
        // bd med-4ca: Finish only while the workout actually runs (a finished
        // session changes status from the overview's Status row). Never
        // offline-gated (med-mgvo): the status write is local-first.
        const finishBtn = _wgBtn('Finish', 'wg-btn--primary wg-workouts-session-actions__finish', () => finishWorkoutSession());
        finishBtn.id = 'workout-session-finish-btn';
        el.replaceChildren(finishBtn);
        return;
    }
    const label = _statusLabel(status);
    if (window.WGChip && typeof window.WGChip.create === 'function' && label) {
        el.replaceChildren(window.WGChip.create({ text: label, state: SESSION_STATUS_CHIP_STATE[status], small: true }));
    } else {
        el.textContent = label;
    }
}

// renderWorkoutSessionHeader fills the takeover's top bar (kit .wg-session-top):
// the clock, the plan · day · date line, and Finish (running) or the status
// chip (finished). Status is never edited here — Finish (or the overview's
// Status row on a finished session) changes it.
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
    if (!ui.targets) ui.targets = {};
    logs.forEach((l) => { ui.targets[_logKey(l)] = _targetSets(l); });

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
    if (actions) renderSessionDetailActions(actions);
}

// _targetSets is how many set rows an exercise shows: its done sets plus the
// pending rows still to do (the plan's target, raised by "Add set"). A
// placeholder log (status '', e.g. an exercise added mid-workout) has no plan
// target to read back after a reload, so it always offers one pending row.
function _targetSets(log) {
    const floor = log.status === '' ? 1 : 0;
    return Math.min(20, Math.max(_ensureLogSets(log).length, Number(log._targetSets) || 0, floor));
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

// The empty session's only way in (no exercise screen, so no footer plus).
function _sessionAddExerciseButton() {
    const add = _wgBtn('', 'wg-btn--sm', () => showAddExerciseToSessionModal());
    add.id = 'workout-session-empty-add-btn';
    add.append(_wgIco('plus', 'wg-ico--sm'), document.createTextNode('Add exercise'));
    return add;
}

// Kit W2/WA2: every exercise as a row (tap → that exercise), "Add exercise" as
// the last row, the gym, and — on a finished session only — its status.
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
    const addRow = document.createElement('button');
    addRow.type = 'button';
    addRow.id = 'workout-session-add-row';
    addRow.className = 'wg-row wg-session-overview__add';
    const addLead = document.createElement('span');
    addLead.className = 'wg-row__lead';
    addLead.appendChild(_wgIco('plus'));
    const addBody = document.createElement('span');
    addBody.className = 'wg-row__body';
    const addTitle = document.createElement('span');
    addTitle.className = 'wg-row__title';
    addTitle.textContent = 'Add exercise';
    addBody.appendChild(addTitle);
    addRow.append(addLead, addBody);
    addRow.addEventListener('click', () => showAddExerciseToSessionModal());
    list.appendChild(addRow);
    wrap.appendChild(list);

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

    // A finished session flips between Completed and Skipped only: re-opening
    // it as In Progress has no Finish/clock/rest path in this view.
    const status = st.targetStatus || st.originalStatus;
    if (st.data && st.data.status !== 'in_progress') {
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
            const picked = await safeChoose('', SESSION_STATUS_OPTIONS
                .filter((o) => o.value !== 'in_progress')
                .map((o) => ({ ...o, selected: o.value === status })),
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
    if (st.ui !== ui) return;
    const sets = _priorSessionSets(rows);
    if (!sets) return;
    ui.last[name] = sets;
    const cur = st.logs[ui.current];
    if (!ui.overview && cur && cur.exercise_name === name) _rerenderSessionLogs();
}

// The per-set rows of the newest OTHER session on or before this one, from a
// history read; null when there is none.
function _priorSessionSets(rows) {
    const st = window.WorkoutSessionsState;
    if (!Array.isArray(rows) || !st.data) return null;
    const sid = st.data.id;
    const day = String(st.data.scheduled_date || '').slice(0, 10);
    const prior = rows.find((r) => r && r.session_id !== sid && Array.isArray(r.sets) && r.sets.length > 0
        && (!day || !r.date || String(r.date).slice(0, 10) <= day));
    return prior ? prior.sets : null;
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
            // An added exercise (source 'library') pre-fills from the library
            // default, labelled "default"; no default reads "—" (kit WA4).
            fromDefault: log.source === 'library',
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
        fromDefault: !!ghost.fromDefault,
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
        const blank = ghost && v.fromDefault && !Number(value);
        c.appendChild(document.createTextNode(blank ? '—' : _fmtSetNumber(value)));
        // A rated row shows its RPE in the reps cell; the active pending row
        // keeps "last N" there (its chip row already shows the rating).
        const small = field === 'reps' && v.rpe != null && (v.done || row !== activeRow)
            ? `RPE ${_fmtSetNumber(v.rpe)}`
            : ghost ? (v.fromLast ? 'last' : (v.fromDefault && !blank ? 'default' : ''))
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

    // One-tap RPE: on the active pending row, and on the set just ticked
    // until it is rated. Tapping the pressed chip clears the rating.
    const justTicked = v.done && row === _ensureLogSets(log).length - 1 && v.rpe == null;
    if ((row === activeRow && !v.done) || justTicked) {
        const picks = document.createElement('div');
        picks.className = 'wg-set__rpe-picks';
        const eyebrow = document.createElement('span');
        eyebrow.className = 'wg-eyebrow';
        eyebrow.textContent = 'RPE';
        picks.appendChild(eyebrow);
        [6, 7, 8, 9, 10].forEach((n) => {
            const on = v.rpe != null && Number(v.rpe) === n;
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'wg-pick';
            b.textContent = String(n);
            b.setAttribute('aria-label', `RPE ${n}`);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
            b.addEventListener('click', () => _setSessionSetField(index, row, 'rpe', on ? '' : String(n)));
            picks.appendChild(b);
        });
        el.appendChild(picks);
    }

    // Kit WA7: the type line, then the RPE line ending in "Delete set" at the
    // far right — away from the Done tick and the ± strip.
    if (moreOpen) {
        const line = () => {
            const d = document.createElement('div');
            d.className = 'wg-set__more wg-picks';
            el.appendChild(d);
            return d;
        };
        let more = line();
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
        more = line();
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
        const spacer = document.createElement('span');
        spacer.className = 'wg-spacer';
        const del = _wgBtn('', 'wg-btn--danger-ghost wg-btn--sm wg-set__delete', () => { _deleteSessionSet(index, row); });
        del.append(_wgIco('trash', 'wg-ico--sm'), document.createTextNode('Delete set'));
        more.append(spacer, del);
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
    // The line under the tags: what is logged, else the plan row's target
    // (an untouched planned exercise, kit W1). An added exercise with nothing
    // logged has no target, so no "0 × 0 · bodyweight" line — its ghost set
    // carries the numbers (kit WA4, Iris on med-okwf.3).
    const has = (l) => Number(l.sets_completed) > 0 && Number(l.reps_completed) > 0;
    const t = log._target;
    const line = has(log) || !t ? log
        : { sets_completed: log._targetSets, reps_completed: t.reps, weight_kg: t.weight_kg };
    const shown = has(line);
    monoRow.textContent = shown ? _formatLogMono(line) : '';
    monoRow.hidden = !shown;
    entry.appendChild(monoRow);

    // In-session weight suggestion (med-h5u3): a collapsed "Try <kg>" chip in
    // the meta row that expands to the editor's suggestion card under the mono
    // row. Fire-and-forget like the chips above.
    _maybeAttachSuggestChip(entry, meta, monoRow, log, index);

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

// _maybeAttachPRBadge adds a "PR" badge to a saved log card's meta row when the
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
    // Second in the card's .wg-ex__meta tag row.
    headerRow.insertBefore(badge, headerRow.children[1] || null);
}

// _maybeAttachBodyPartChip appends a friendly body-part chip (Legs / Core /
// Forearms …) to a card's meta row when the exercise resolves to a catalog
// body_part with a friendly translation (med-mj4). Mirrors _maybeAttachPRBadge:
// async, guards mount + double-append, coexists with the PR badge. Silent
// no-op when the shared catalog helper is absent.
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
    headerRow.appendChild(chip);
}

// -- In-session weight suggestion (med-h5u3) --
//
// The plan editor's "Try <kg>" (suggestExerciseTarget, the same progression
// engine propagate runs) asked from the live session by plan row, with the
// session's id so the domain skips this session's own ticked sets and resolves
// loads at its gym. One read per exercise row (two rows can share a name with
// different rules) per open, re-asked on a gym switch. Bot mode 404 / null →
// nothing rendered.
function _suggestKey(log) {
    return `${log.source === 'library' ? 'lib' : 'row'}:${_logKey(log)}`;
}

function _exerciseSuggestion(log) {
    const ui = _sessionUi();
    const key = _suggestKey(log);
    if (!ui.suggest[key]) {
        // A library log's id lives in the library id space: ask by name only.
        const id = log.source === 'library' ? 0 : (Number(log.exercise_id) || 0);
        const sid = Number(window.WorkoutSessionsState.data && window.WorkoutSessionsState.data.id) || 0;
        let p;
        try {
            p = Promise.resolve(apiCall(`/api/workout/exercises/suggest-target?name=${encodeURIComponent(log.exercise_name)}`
                + (id > 0 ? `&exercise_id=${id}` : '') + (sid > 0 ? `&session_id=${sid}` : '')));
        } catch (e) {
            p = Promise.reject(e);
        }
        ui.suggest[key] = p.then((r) => (r && r.target_weight_kg != null ? r : null), () => null);
    }
    return ui.suggest[key];
}

// Chip only while a pending row exists and its shown weight is not already the
// suggestion (the editor's _syncSuggestApply hide rule). Apply drafts the first
// pending row through _setSessionSetField, whose cascade carries it to every
// later pending row; done rows are never touched and nothing is written until
// a set is ticked. Session only — propagate carries the lifted weight to the
// plan, so Apply has no plan write of its own.
async function _maybeAttachSuggestChip(entry, meta, monoRow, log, index) {
    if (!log || !log.exercise_name) return;
    const ui = _sessionUi();
    const pending = _exerciseSuggestion(log);
    const s = await pending;
    // A gym switch re-asks: a superseded read never renders.
    if (ui.suggest[_suggestKey(log)] !== pending) return;
    if (!s || !meta.isConnected || window.WorkoutSessionsState.ui !== ui) return;
    if (meta.querySelector('.wg-workouts-session-exercise__suggest-chip')) return;
    const first = _ensureLogSets(log).length;
    if (first >= _targetSets(log)) return;
    const kg = Number(s.target_weight_kg);
    if (Number(_setRowValues(log, first).weight_kg) === kg) return;

    const key = _suggestKey(log);
    const open = !!ui.suggestOpen[key];
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'wg-chip wg-chip--sm wg-workouts-session-exercise__suggest-chip';
    chip.setAttribute('aria-expanded', open ? 'true' : 'false');
    chip.append(_wgIco('sparkle'), document.createTextNode(`Try ${kg} kg`));
    chip.addEventListener('click', () => {
        ui.suggestOpen[key] = !ui.suggestOpen[key];
        _rerenderSessionLogs();
    });
    meta.appendChild(chip);
    if (!open) return;

    // Same markup as the editor's #workout-exercise-suggest-card (kit P3).
    const card = document.createElement('div');
    card.className = 'wg-card wg-card--accent wg-hstack wg-workouts-session-exercise__suggest';
    const body = document.createElement('span');
    body.className = 'wg-vstack wg-spacer';
    const title = document.createElement('span');
    title.className = 'wg-row__title';
    title.textContent = `Try ${kg} kg`;
    body.appendChild(title);
    const last = s.last;
    if (last && last.weight_kg != null) {
        // Effort clause omitted entirely when unrated, exactly like the editor.
        const parts = [`${last.weight_kg} kg × ${last.reps}`];
        if (last.effort) parts.push(last.effort);
        const hint = document.createElement('span');
        hint.className = 'wg-hint';
        hint.textContent = `Last: ${parts.join(' · ')}`;
        body.appendChild(hint);
    }
    const apply = _wgBtn('Apply', 'wg-btn--sm wg-workouts-session-exercise__suggest-apply',
        () => _setSessionSetField(index, _ensureLogSets(log).length, 'weight_kg', String(kg)));
    card.append(_wgIco('sparkle', 'wg-sun'), body, apply);
    entry.insertBefore(card, monoRow.nextSibling);
}

// -- Plate-loading chip (med-v75c.2) --
//
// Each exercise card shows which plates to load for the active set row's
// weight (_plateWeightFor; log.weight_kg once every row is done): a glyph
// plus a text line solved by the domain
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
    // The weight suggestion snaps to the session gym's loads too: re-ask.
    if (st.ui) st.ui.suggest = {};
    (st.logs || []).forEach((log, index) => {
        const entry = document.getElementById(`exercise-log-${index}`);
        if (!entry) return;
        entry.querySelectorAll(SESSION_EQUIP_STRIP_SEL).forEach((el) => el.remove());
        _maybeAttachPlateChip(entry, log);
        const meta = entry.querySelector('.wg-ex__meta');
        const mono = entry.querySelector('.wg-workouts-session-exercise__mono');
        if (!meta || !mono) return;
        entry.querySelectorAll('.wg-workouts-session-exercise__suggest-chip, .wg-workouts-session-exercise__suggest')
            .forEach((el) => el.remove());
        _maybeAttachSuggestChip(entry, meta, mono, log, index);
    });
    _refreshSessionEquipSheets();
}

// A remote write (another device, the MCP connector, a sync pull) touching
// workout records while a session is open: re-read the session's gym stamp
// (overview gym switch) and re-resolve the chips — the active gym, a gym or the inventory
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
            equipmentForExercise: equipmentForExercise, pickNearestLoad: pickNearestLoad,
            // The swap picker's gym filter (med-j6pn); absent = whole inventory.
            inventoryAt: domain && typeof domain.inventoryAt === 'function' ? domain.inventoryAt : null
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

// The weight to load: the active (next) set row's while sets remain, else the
// working weight (max done set).
function _plateWeightFor(log) {
    const li = window.WorkoutSessionsState.logs.indexOf(log);
    const row = li >= 0 ? _activeSetRow(li, log) : -1;
    return Number(row >= 0 ? _setRowValues(log, row).weight_kg : log.weight_kg);
}

// Both strip variants a card can carry: the plate chip and (med-j6pn) the
// dashed no-equipment line that keeps the swap button reachable.
const SESSION_EQUIP_STRIP_SEL = '.wg-workouts-session-exercise__plates, .wg-workouts-session-exercise__equip-none';

// _sessionPlateLoad solves what to load for one item at weight w:
// { glyph: { perSide, sides, text } | null, parts: [[text, cls]] }, or null
// when there is nothing to load (no weight, exact fixed load, bare bar, no
// achievable rung).
function _sessionPlateLoad(eq, w, gear, groups, unit) {
    if (!eq || !Number.isFinite(w) || w <= 0) return null;
    if (eq.kind === 'plated') {
        const sides = eq.sides === 1 ? 1 : 2;
        const glyphFor = (ld) => ({ perSide: ld.per_side, sides, text: groups.plateText(ld.bar_kg, ld.per_side, sides, unit) });
        const ld = gear.loadingFor(eq, w);
        if (ld && ld.per_side.length > 0) {
            const g = glyphFor(ld);
            return { glyph: g, parts: [[g.text, 'wg-plates__text']] };
        }
        // Exact bare-bar working weight: nothing to load, like the print
        // sheet (which draws no glyph for an empty per_side).
        if (ld) return null;
        // Below the bar nothing is achievable: say so instead of suggesting
        // the bare bar as a "nearest" rung above the target.
        const bar = Number(eq.bar_kg);
        if (Number.isFinite(bar) && w < bar) {
            return { glyph: null, parts: [[`below bar (${_sessionPlateR2(bar)} kg)`, 'wg-plates__text']] };
        }
        const near = gear.nearestLoads(eq.loads_kg, w);
        const chosen = gear.pickNearestLoad(near.below, near.above, w);
        if (chosen === null) return null;
        const best = gear.loadingFor(eq, chosen);
        if (!best) return null;
        const glyph = best.per_side.length > 0 ? glyphFor(best) : null;
        const parts = glyph ? [[glyph.text, 'wg-plates__text']] : [];
        const delta = _sessionPlateR2(chosen - w);
        const sign = delta > 0 ? '+' : '';
        parts.push([`${_sessionPlateR2(chosen)} kg (${sign}${delta} kg)`, 'wg-plates__delta']);
        return { glyph, parts };
    }
    if (eq.kind === 'fixed') {
        const loads = (Array.isArray(eq.loads_kg) ? eq.loads_kg : [])
            .map(Number).filter((n) => Number.isFinite(n) && n > 0);
        if (loads.indexOf(w) !== -1) return null;
        const near = gear.nearestLoads(loads, w);
        const chosen = gear.pickNearestLoad(near.below, near.above, w);
        if (chosen === null) return null;
        return { glyph: null, parts: [[`nearest: ${_sessionPlateR2(chosen)} kg`, 'wg-plates__text']] };
    }
    return null;
}

// _renderSessionPlateChip builds the strip for one card synchronously from
// resolved gear (kit W4): a source line naming the equipment ("auto: <name>"
// for an auto-match), the plates line, and — on an in-progress session — the
// swap button. Returns true when a plate chip was mounted. When nothing
// resolves to load (no weight, unbound gear, exact fixed load, bare bar) an
// in-progress card gets the dashed no-equipment line instead (still false);
// any other card stays unchanged. Every lookup is guarded and the domain
// solvers are total, so a malformed response degrades to no chip, never a throw.
function _renderSessionPlateChip(entry, log, gear) {
    if (!entry || !log || !gear || gear.failed) return false;
    if (entry.querySelector(SESSION_EQUIP_STRIP_SEL)) return false;
    const groups = window.WorkoutGroups;
    if (!groups || typeof groups.plateSvg !== 'function' || typeof groups.plateText !== 'function') return false;
    const w = _plateWeightFor(log);
    const hit = _sessionEquipmentForLog(log, gear);
    const unit = (typeof readWeightUnitPreference === 'function') ? readWeightUnitPreference() : 'kg';
    const load = hit ? _sessionPlateLoad(hit.item, w, gear, groups, unit) : null;
    const swappable = !!_sessionEquipTarget(log, gear);
    if (!load && !swappable) return false;

    const span = (cls, text) => {
        const s = document.createElement('span');
        if (cls) s.className = cls;
        if (text !== undefined) s.textContent = text;
        return s;
    };
    const wrap = document.createElement('div');
    wrap.className = load
        ? 'wg-plates wg-workouts-session-exercise__plates'
        : 'wg-plates wg-plates--none wg-workouts-session-exercise__equip-none';
    if (load && load.glyph) {
        const svg = groups.plateSvg(load.glyph.perSide, load.glyph.sides);
        svg.setAttribute('aria-label', `Plate loading: ${load.glyph.text}`);
        wrap.appendChild(svg);
    }
    const txt = span('wg-plates__txt');
    // med-x295: an auto-matched item (no explicit binding) says so.
    const src = span(hit && hit.auto ? 'wg-plates__src wg-plates__auto' : 'wg-plates__src');
    if (hit) {
        if (hit.auto) src.appendChild(document.createTextNode('auto: '));
        src.appendChild(document.createElement('b')).textContent = hit.item.name || 'Equipment';
    } else {
        src.textContent = 'No equipment';
    }
    txt.appendChild(src);
    const line = span('wg-plates__line');
    if (load) load.parts.forEach(([text, cls]) => line.appendChild(span(cls, text)));
    else line.textContent = !hit && !(w > 0) ? 'Bodyweight · nothing to load' : 'Nothing to load';
    txt.appendChild(line);
    wrap.appendChild(txt);

    if (swappable) {
        const swap = document.createElement('button');
        swap.type = 'button';
        swap.className = 'wg-plates__swap';
        swap.setAttribute('aria-label', 'Change equipment');
        swap.appendChild(_wgIco('swap', 'wg-ico--sm'));
        swap.addEventListener('click', () => { _openSessionEquipPicker(log); });
        wrap.appendChild(swap);
    }

    const mono = entry.querySelector('.wg-workouts-session-exercise__mono');
    if (mono) entry.insertBefore(wrap, mono.nextSibling);
    else entry.appendChild(wrap);
    return !!load;
}

// _sessionEquipTarget names where a swap for this log is saved (med-j6pn):
// { kind: 'plan', row } for a plan-backed log (the plan row's equipment_id,
// same field as P3's Equipment row), { kind: 'library', row } for an
// ad-hoc / library-sourced one. Only an in-progress session swaps — a
// finished one is frozen. null = no swap.
function _sessionEquipTarget(log, gear) {
    const st = window.WorkoutSessionsState;
    if (!log || !gear || gear.failed || !st.data || st.data.status !== 'in_progress') return null;
    if (log.source === 'library') {
        const lib = gear.libById[log.exercise_id];
        return lib ? { kind: 'library', row: lib } : null;
    }
    const row = gear.rowsById[log.exercise_id];
    return row ? { kind: 'plan', row } : null;
}

// One-line item summary for the picker: "bar 20 · plates to 25",
// "pair · handle 2 · plates to 10", "fixed · 16 kg".
function _sessionEquipSummary(item) {
    const r = _sessionPlateR2;
    if (item.kind === 'plated') {
        const plates = (Array.isArray(item.plates) ? item.plates : [])
            .map((p) => Number(p && p.kg)).filter((n) => Number.isFinite(n) && n > 0);
        const parts = item.pair ? ['pair'] : [];
        parts.push(`${item.pair || item.sides === 1 ? 'handle' : 'bar'} ${r(item.bar_kg)}`);
        if (plates.length) parts.push(`plates to ${r(Math.max(...plates))}`);
        return parts.join(' · ');
    }
    const loads = (Array.isArray(item.loads_kg) ? item.loads_kg : [])
        .map(Number).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    if (!loads.length) return 'fixed';
    const lo = r(loads[0]);
    const hi = r(loads[loads.length - 1]);
    return lo === hi ? `fixed · ${lo} kg` : `fixed · ${lo}–${hi} kg`;
}

function _sessionEquipPlanLabel() {
    return window.WorkoutSessionsState.planLabel || 'plan';
}

const SESSION_EQUIP_PICKER_ID = 'workout-session-equip-sheet';
const SESSION_EQUIP_MANAGE_ID = 'workout-session-equip-manage-sheet';
const SESSION_EQUIP_MANAGE_LIST_ID = 'workout-session-equip-manage-list';

function _sessionEl(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
}

function _closeSessionSheet(id) {
    const mm = window.ModalManager;
    if (mm && typeof mm.close === 'function') { mm.close(id); return; }
    const node = document.getElementById(id);
    if (node) node.classList.add('hidden');
}

function _closeSessionEquipPicker() {
    _closeSessionSheet(SESSION_EQUIP_PICKER_ID);
}

function _isSessionSheetShown(id) {
    const node = document.getElementById(id);
    return !!node && !node.classList.contains('hidden');
}

// The shared Equipment editor's Add, preselecting the session's gym (its
// stamped location; unstamped = the active gym). It stacks over the session
// and the sheets; a save refreshes them through refreshSessionPlateGear.
function _addSessionEquipment() {
    const data = window.WorkoutSessionsState.data;
    const stamped = data && Object.prototype.hasOwnProperty.call(data, 'location_id') ? data.location_id : undefined;
    if (window.WorkoutEquipment && typeof window.WorkoutEquipment.openAdd === 'function') {
        window.WorkoutEquipment.openAdd(stamped);
    }
}

// _openSessionEquipManage (kit W4b "Manage equipment", med-i7kw): the
// Equipment tab's inventory list in a sheet over the picker — the session
// stays open underneath. Rows open the shared editor above it; Close / Back
// returns to the picker.
function _openSessionEquipManage() {
    const doc = document;
    const el = _sessionEl;
    let sheet = doc.getElementById(SESSION_EQUIP_MANAGE_ID);
    if (!sheet) {
        sheet = doc.createElement('mt-modal');
        sheet.id = SESSION_EQUIP_MANAGE_ID;
        sheet.className = 'hidden wg-modal wg-sheet wg-workouts-equip-sheet';
        sheet.setAttribute('aria-label', 'Manage equipment');
    }
    doc.body.appendChild(sheet); // above the picker
    const head = el('header', 'wg-sheethead');
    const titles = el('div', 'wg-sheethead__titles');
    titles.append(el('div', 'wg-eyebrow', 'Your workout stays open'), el('div', 'wg-sheethead__title', 'Equipment'));
    const acts = el('div', 'wg-sheethead__acts');
    const add = _wgBtn('', 'wg-btn--ghost wg-btn--icon', _addSessionEquipment);
    add.setAttribute('aria-label', 'Add equipment');
    add.appendChild(_wgIco('plus'));
    const close = _wgBtn('', 'wg-btn--ghost wg-btn--icon', () => _closeSessionSheet(SESSION_EQUIP_MANAGE_ID));
    close.setAttribute('aria-label', 'Close');
    close.appendChild(_wgIco('x'));
    acts.append(add, close);
    head.append(titles, acts);
    const list = el('div');
    list.id = SESSION_EQUIP_MANAGE_LIST_ID;
    list.dataset.gymActions = 'off';
    const body = el('div', 'wg-sheet__body');
    body.appendChild(list);
    sheet.replaceChildren(el('div', 'wg-sheet__grab'), head, body);

    const mm = window.ModalManager;
    if (mm && typeof mm.open === 'function') mm.open(sheet.id);
    else sheet.classList.remove('hidden');
    if (window.WorkoutEquipment && typeof window.WorkoutEquipment.load === 'function') {
        window.WorkoutEquipment.load(list);
    }
}

// After a gear refresh (an equipment write, a gym switch, a remote change)
// repaint whichever equipment sheet is open over the session, in place.
async function _refreshSessionEquipSheets() {
    if (_isSessionSheetShown(SESSION_EQUIP_MANAGE_ID)
        && window.WorkoutEquipment && typeof window.WorkoutEquipment.load === 'function') {
        window.WorkoutEquipment.load(document.getElementById(SESSION_EQUIP_MANAGE_LIST_ID));
    }
    const st = window.WorkoutSessionsState;
    if (!st.equipPickerLog || !_isSessionSheetShown(SESSION_EQUIP_PICKER_ID)) return;
    await _sessionPlateGear();
    if (_isSessionSheetShown(SESSION_EQUIP_PICKER_ID)) await _openSessionEquipPicker(st.equipPickerLog, true);
}

// _openSessionEquipPicker (kit W4b): a bottom sheet over the session with
// Auto (clear the override) and the inventory at the session's gym; the
// current choice is pressed and one tap picks + closes. `refreshOnly`: a
// repaint of the open sheet, never a (re)open.
async function _openSessionEquipPicker(log, refreshOnly) {
    const gear = _sessionPlateGearSync();
    const target = _sessionEquipTarget(log, gear);
    if (!target) return;
    const loc = gear.location || null;
    const inv = Array.isArray(gear.inv) ? gear.inv : [];
    const scoped = loc && typeof gear.inventoryAt === 'function'
        ? gear.inventoryAt(inv, loc.locationId, loc.liveLocationIds) : inv;
    // A pending optimistic create carries a local_ id the write would reject.
    const items = scoped.filter((i) => i && i.id !== null && i.id !== undefined
        && !(typeof i.id === 'string' && i.id.indexOf('local_') === 0));
    let gymName = null;
    if (loc && loc.locationId !== null && loc.locationId !== undefined
        && window.WorkoutEquipment && typeof window.WorkoutEquipment.locations === 'function') {
        try {
            const state = await window.WorkoutEquipment.locations();
            const l = state.locations.find((x) => String(x.id) === String(loc.locationId));
            gymName = l ? (l.name || null) : null;
        } catch (_) { gymName = null; }
    }
    const isPlan = target.kind === 'plan';
    const current = target.row.equipment_id === null || target.row.equipment_id === undefined
        ? null : String(target.row.equipment_id);

    const doc = document;
    const el = _sessionEl;
    // Re-checked after the gym read: the session (or the sheet, for a
    // refresh) may have closed meanwhile.
    if (!window.WorkoutSessionsState.data) return;
    let sheet = doc.getElementById(SESSION_EQUIP_PICKER_ID);
    // Already open: a gear refresh repaints it in place (med-i7kw), never
    // re-stacking it above the Manage sheet or the editor.
    const shown = !!sheet && !sheet.classList.contains('hidden');
    if (refreshOnly && !shown) return;
    window.WorkoutSessionsState.equipPickerLog = log;
    if (!sheet) {
        sheet = doc.createElement('mt-modal');
        sheet.id = SESSION_EQUIP_PICKER_ID;
        sheet.className = 'hidden wg-modal wg-sheet wg-workouts-equip-sheet';
        sheet.setAttribute('aria-label', 'Equipment');
    }
    if (!shown) doc.body.appendChild(sheet); // last in the body: above the session takeover

    const head = el('header', 'wg-sheethead');
    const titles = el('div', 'wg-sheethead__titles');
    titles.append(el('div', 'wg-eyebrow', isPlan ? `Saves to ${_sessionEquipPlanLabel()}` : 'Saves to library'),
        el('div', 'wg-sheethead__title', 'Equipment'));
    const acts = el('div', 'wg-sheethead__acts');
    const close = _wgBtn('', 'wg-btn--ghost wg-btn--icon', _closeSessionEquipPicker);
    close.setAttribute('aria-label', 'Close');
    close.appendChild(_wgIco('x'));
    acts.appendChild(close);
    head.append(titles, acts);

    const body = el('div', 'wg-sheet__body');
    const choice = (icon, label, sub, value) => {
        const pressed = value === current;
        const b = el('button', 'wg-choice');
        b.type = 'button';
        b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
        b.dataset.equipmentId = value === null ? '' : value;
        const lead = el('span', 'wg-row__lead');
        lead.appendChild(_wgIco(icon));
        const text = el('span', null, label);
        text.appendChild(el('span', 'wg-choice__sub', sub));
        b.append(lead, text);
        b.addEventListener('click', () => {
            _closeSessionEquipPicker();
            if (!pressed) _setSessionExerciseEquipment(target.kind, target.row.id, value === null ? null : Number(value), label);
        });
        return b;
    };
    if (items.length === 0) {
        const empty = el('div', 'wg-empty');
        const ico = el('span', 'wg-empty__icon');
        ico.appendChild(_wgIco('box', 'wg-ico--lg'));
        const emptyActs = el('div', 'wg-empty__acts');
        const add = _wgBtn('', '', _addSessionEquipment);
        add.append(_wgIco('plus', 'wg-ico--sm'), 'Add equipment');
        emptyActs.appendChild(add);
        empty.append(ico, el('p', 'wg-empty__title', gymName ? `No equipment at ${gymName}` : 'No equipment yet'),
            el('p', 'wg-empty__body', 'Add the bars, dumbbells and plates you have here, and the strip will work out every load for you. Your workout stays open.'),
            emptyActs);
        body.appendChild(empty);
    } else {
        // What Auto resolves to: the override cleared (a plan row then
        // inherits the library binding, else auto-matches at this gym).
        const lib = isPlan ? (gear.libById[target.row.exercise_library_id] || null) : { ...target.row, equipment_id: null };
        const plan = isPlan ? { ...target.row, equipment_id: null } : null;
        // Same weight the strip's resolution uses (_sessionEquipmentForLog).
        const autoHit = gear.equipmentForExercise(plan, lib, inv, Number(log.weight_kg), loc);
        const at = gymName ? ` at ${gymName}` : '';
        const autoSub = !autoHit ? `Nothing matches${at}`
            : (autoHit.auto ? `Best match${at} · now ${autoHit.item.name}` : `From library · now ${autoHit.item.name}`);
        const autoList = el('div', 'wg-choices');
        autoList.appendChild(choice('sparkle', 'Auto', autoSub, null));
        body.appendChild(autoList);
        const section = el('section', 'wg-section');
        const sHead = el('div', 'wg-section__head');
        sHead.appendChild(el('span', 'wg-eyebrow', `${gymName ? `At ${gymName}` : 'Your equipment'} · ${items.length}`));
        const list = el('div', 'wg-choices');
        items.forEach((item) => {
            const icon = ['barbell', 'dumbbell', 'kettlebell'].indexOf(item.implement) !== -1 ? item.implement : 'box';
            list.appendChild(choice(icon, item.name || 'Equipment', _sessionEquipSummary(item), String(item.id)));
        });
        section.append(sHead, list);
        body.appendChild(section);
        const foot = el('div', 'wg-equip-foot');
        const manage = el('button', 'wg-link', 'Manage equipment');
        manage.type = 'button';
        manage.appendChild(_wgIco('chev-r', 'wg-ico--sm'));
        manage.addEventListener('click', _openSessionEquipManage);
        foot.appendChild(manage);
        body.appendChild(foot);
    }
    sheet.replaceChildren(el('div', 'wg-sheet__grab'), head, body);
    if (shown) return;

    const mm = window.ModalManager;
    if (mm && typeof mm.open === 'function') {
        if (typeof mm.register === 'function') mm.register(sheet.id, _closeSessionEquipPicker);
        mm.open(sheet.id);
    } else {
        sheet.classList.remove('hidden');
    }
}

// Re-solve every mounted card's strip from the cached gear (no rebuild).
function _rerenderSessionEquipStrips() {
    const st = window.WorkoutSessionsState;
    (st.logs || []).forEach((log, index) => {
        const entry = document.getElementById(`exercise-log-${index}`);
        if (entry) _refreshSessionPlateChip(entry, log);
    });
}

// _setSessionExerciseEquipment persists a swap (med-j6pn): the plan row's
// equipment_id (kind 'plan') or the library row's (kind 'library'); null
// clears the override (Auto). Both endpoints replace their core fields, so the
// row's own values are sent back verbatim; progression_rule / training_goal
// are omitted, which preserves them. Optimistic (rule 9): the open session's
// gear is patched and the strips re-solve at once; a failed write restores
// both. `label` set → success toast with Undo (which writes the previous id
// back, quietly). `fallbackRow` is the row as last written, for an Undo after
// the session view closed (its gear no longer holds the row).
async function _setSessionExerciseEquipment(kind, rowId, equipmentId, label, fallbackRow) {
    // Sync when cached, so the strip re-solves within the tap.
    const st = window.WorkoutSessionsState;
    const gear = st.data ? (_sessionPlateGearSync() || await _sessionPlateGear()) : null;
    const isPlan = kind === 'plan';
    const map = gear && !gear.failed ? (isPlan ? gear.rowsById : gear.libById) : null;
    const live = map && map[rowId] ? map : null;
    let before = live ? live[rowId] : null;
    if (!before && fallbackRow) {
        // No open gear: re-read the row so the full-replace PUT carries its
        // current targets, not the swap-time snapshot.
        try {
            const rows = await apiCall(isPlan ? `/api/workout/exercises?variant_id=${fallbackRow.variant_id}` : '/api/workout/exercise-library');
            before = (Array.isArray(rows) ? rows : []).find((r) => r && r.id === rowId) || null;
        } catch (_) { before = null; }
        if (!before) before = fallbackRow;
    }
    if (!before) return false;
    const prevId = before.equipment_id === undefined ? null : before.equipment_id;
    const patched = { ...before, equipment_id: equipmentId };
    if (live) {
        live[rowId] = patched;
        _rerenderSessionEquipStrips();
    }

    let handle = null;
    try {
        if (window.DataStore && typeof window.DataStore.applyOptimistic === 'function') {
            // The library list caches the binding; plan rows live in no cached
            // payload, so their handle only parks the plans read until commit.
            handle = isPlan
                ? await window.DataStore.applyOptimistic('workout_groups', (prev) => prev, ['workout'])
                : await window.DataStore.applyOptimistic('exercise_library', (prev) => (Array.isArray(prev)
                    ? prev.map((r) => (r && r.id === rowId ? { ...r, equipment_id: equipmentId } : r)) : prev), ['exercise_library']);
        }
    } catch (_) { handle = null; /* a failed cache projection must not block the write */ }

    const opt = (v) => (v === undefined ? null : v);
    const body = isPlan
        ? {
            exercise_name: before.exercise_name, target_sets: before.target_sets,
            target_reps_min: before.target_reps_min, target_reps_max: opt(before.target_reps_max),
            target_weight_kg: opt(before.target_weight_kg), order_index: before.order_index,
            equipment_id: equipmentId,
        }
        : {
            name: before.name, default_sets: before.default_sets, default_reps_min: before.default_reps_min,
            default_reps_max: opt(before.default_reps_max), default_weight_kg: opt(before.default_weight_kg),
            notes: before.notes || '', body_part: before.body_part || '', equipment_id: equipmentId,
        };
    const url = isPlan ? `/api/workout/exercises/update?id=${rowId}` : `/api/workout/exercise-library/update?id=${rowId}`;
    let ok = false;
    try {
        ok = !!(await apiCall(url, 'PUT', body, { suppressWriteAlert: true }));
    } catch (_) {
        ok = false;
    }
    if (!ok) {
        if (live && live[rowId] === patched) {
            live[rowId] = before;
            _rerenderSessionEquipStrips();
        }
        if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
        safeToast("Couldn't change the equipment — try again.", 'error');
        return false;
    }
    if (handle) { try { await handle.commit(null); } catch (_) { /* best-effort */ } }
    // Re-read the truth and re-ask the weight suggestion (it snaps to the
    // new gear); local writes never reach the remote-change listener.
    refreshSessionPlateGear();
    if (label) {
        safeToast(`Equipment: ${label}`, 'success', {
            detail: isPlan ? `Saved to ${_sessionEquipPlanLabel()}` : 'Saved to library',
            action: { label: 'Undo', onClick: () => { _setSessionExerciseEquipment(kind, rowId, prevId, null, patched); } },
        });
    }
    return true;
}

// _maybeAttachPlateChip decorates a card with its plate-loading chip.
// Fire-and-forget, same async-attach flow as the body-part chip: guards mount
// + double-append, silent no-op when gear is unresolvable.
async function _maybeAttachPlateChip(entry, log) {
    if (!entry || !log) return;
    if (entry.querySelector(SESSION_EQUIP_STRIP_SEL)) return;
    const gear = await _sessionPlateGear();
    // The card may have been re-rendered (add/remove set) while we awaited —
    // only decorate the still-mounted entry, and don't double-chip.
    if (!entry.isConnected) return;
    if (entry.querySelector(SESSION_EQUIP_STRIP_SEL)) return;
    const st = window.WorkoutSessionsState;
    if (!gear || gear.failed || !st.data || gear.sessionId !== st.data.id) return;
    if (gear.gen !== (st.plateGearGen || 0)) return; // a refresh superseded this build
    _renderSessionPlateChip(entry, log, gear);
}

// _refreshSessionPlateChip re-solves a mounted card's chip after a weight
// edit. The gear resolved once at session open, so the common path renders
// synchronously and the chip tracks _plateWeightFor; before the first resolve
// lands it falls back to the async attach (whose guards make the overlap
// with the card-build attach harmless).
function _refreshSessionPlateChip(entry, log) {
    if (!entry || !log) return;
    entry.querySelectorAll(SESSION_EQUIP_STRIP_SEL).forEach((el) => el.remove());
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
// A weight change (not a ghost-accept, which passes the shown value) also
// carries over to every later pending row's draft; done rows are never touched.
// ponytail: cascade stays within one exercise; reps never cascade.
function _setSessionSetField(logIndex, row, field, value) {
    const log = window.WorkoutSessionsState.logs[logIndex];
    if (!log) return;
    const done = _ensureLogSets(log).length;
    if (field === 'weight_kg') {
        const w = _applySetField({}, 'weight_kg', value).weight_kg;
        if (w !== Number(_setRowValues(log, row).weight_kg)) {
            for (let r = Math.max(row + 1, done); r < _targetSets(log); r++) {
                _applySetField(_setDraft(log, r - done), 'weight_kg', w);
            }
        }
    }
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
    const n = parseDecimal(typed);
    if (!Number.isFinite(n)) return;
    if (window.WorkoutSessionsState.logs[logIndex] !== log) return;
    _setSessionSetField(logIndex, row, field, n);
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

// _deleteSessionSet removes one set row after an in-page confirm (kit WA7b).
// A pending row only drops its draft: one row fewer. A done row leaves
// log.sets (later rows renumber) and saves at once, with the History row's
// volume / completed count projected through applyOptimistic. The exercise
// always keeps one row; removing the exercise is the header trash.
async function _deleteSessionSet(logIndex, row) {
    const st = window.WorkoutSessionsState;
    const log = st.logs[logIndex];
    if (!log) return;
    const v = _setRowValues(log, row);
    const body = `${log.exercise_name} · ${_fmtSetNumber(v.weight_kg)} kg × ${_fmtSetNumber(v.reps)}`
        + `${v.done ? ', done' : ''}. Sets after it move up.`;
    await safeConfirm(body, async (ok) => {
        if (!ok || st.logs[logIndex] !== log) return;
        const sets = _ensureLogSets(log);
        const ui = _sessionUi();
        ui.more = null;
        ui.active = null;
        log._targetSets = Math.max(1, _targetSets(log) - 1);
        if (row >= sets.length) {
            if (Array.isArray(log._drafts)) log._drafts.splice(row - sets.length, 1);
            _rerenderSessionLogs();
            return;
        }
        const volume = (l) => (Number(l.sets_completed) || 0) * (Number(l.reps_completed) || 0) * (Number(l.weight_kg) || 0);
        // A saved log with a done set counts as completed (the domain promotes
        // a placeholder on its first set; the local copy keeps status '').
        const counted = log.id > 0 && log.status !== 'skipped';
        const volBefore = volume(log);
        sets.splice(row, 1);
        sets.forEach((x, i) => { x.set_index = i; });
        _syncLogScalarsFromSets(log);
        // Mirrors the domain: a saved log with no sets left is a placeholder again.
        const demoted = counted && sets.length === 0;
        if (demoted) log.status = '';
        log._dirty = true;
        log._setsDirty = true;
        _rerenderSessionLogs();

        // Save now, not on the debounce: this pending timer's edits ride along.
        // Started before any await so a close / Finish in between drains it.
        if (_autosaveTimer) { clearTimeout(_autosaveTimer); _autosaveTimer = null; }
        const saving = runAutosave();
        const sessionId = st.data && st.data.id;
        const handle = counted && sessionId && window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
            ? await window.DataStore.applyOptimistic('workout_history', (prev) => {
                if (!prev || !Array.isArray(prev.sessions)) return prev;
                return {
                    ...prev,
                    sessions: prev.sessions.map((s) => (s?.session?.id !== sessionId ? s : {
                        ...s,
                        total_volume: Math.max(0, (s.total_volume || 0) - volBefore + (demoted ? 0 : volume(log))),
                        exercises_completed: Math.max(0, (s.exercises_completed || 0) - (demoted ? 1 : 0)),
                    })),
                };
            }, ['workout']).catch(() => null)
            : null;
        const saved = await saving;
        if (handle) await (saved ? handle.commit(null) : handle.rollback());
    }, { title: `Delete set ${row + 1}?`, confirmLabel: 'Delete', icon: 'trash', destructive: true });
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
    if (typeof document === 'undefined') return;
    if (!document.hidden) {
        // ponytail: one guarded call; native/haptics.js if a second caller appears. iOS has no vibrate.
        try { if (typeof navigator.vibrate === 'function') navigator.vibrate(200); } catch (_) { /* best-effort */ }
        return;
    }
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
        // the view (current exercise, row counts); another session starts fresh.
        const sameSession = !!(st.ui && st.ui.sessionId === data.session.id);
        if (!sameSession) {
            _stopSessionTick();
            st.ui = null;
            _sessionUi().sessionId = data.session.id;
        } else {
            // Last-session values and the PR baseline re-read on every open.
            st.ui.hist = {};
            st.ui.last = {};
            st.ui.suggest = {};
        }

        window.WorkoutSessionsState.logs = data.logs || [];
        window.WorkoutSessionsState.data = data.session;
        // The plan names ride on the details envelope, not the session row:
        // the equipment swap's "Saves to <Plan> · <Day>" (med-j6pn).
        window.WorkoutSessionsState.planLabel = [data.group_name || data.session.group_name,
            data.variant_name || data.session.variant_name].filter(Boolean).join(' · ');
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

                // Plan order, logged or not, then exercises added mid-workout
                // (source 'library') in the order they were added: an added
                // exercise goes to the end (kit WA4, med-okwf.3) and keeps its
                // place on every reload. Logs are read back sorted by id, so
                // without this a log made before the plan's sets would lead.
                const merged = [...window.WorkoutSessionsState.logs, ...(plannedMissingLogs || [])];
                if (plannedRows) {
                    const pos = (l) => {
                        if (l.source === 'library') return Number.MAX_SAFE_INTEGER;
                        const i = plannedRows.findIndex((p) => (l.exercise_id && p._eid
                            ? p._eid === l.exercise_id : p.exercise_name === l.exercise_name));
                        return i < 0 ? plannedRows.length : i;
                    };
                    window.WorkoutSessionsState.logs = merged
                        .map((l, k) => ({ l, k, p: pos(l) }))
                        .sort((a, b) => a.p - b.p || a.k - b.k)
                        .map((x) => x.l);
                } else {
                    window.WorkoutSessionsState.logs = merged;
                }
            } catch (prefillError) {
                console.error('Error pre-filling planned exercises:', prefillError);
            }
        }

        // Clear any stale autosave error from a previously-open session.
        setAutosaveStatus('saved');

        // Fresh open: land on the first exercise with sets still to do.
        const ui = _sessionUi();
        if (sameSession && ui.targets) {
            st.logs.forEach((l) => {
                const remembered = ui.targets[_logKey(l)] || 0;
                if (remembered > (l._targetSets || 0)) l._targetSets = remembered;
            });
        }
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
        if (data.session.status === 'in_progress') _ensureSessionTick();

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
    // A flat weight edit moves the working weight — re-solve the plate chip.
    const el = document.getElementById(`exercise-log-${index}`);
    if (el && field === 'weight_kg') _refreshSessionPlateChip(el, logs[index]);
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

// Footer (kit WA1, med-okwf.2): the static Add exercise plus, the save line,
// then Prev / Next as two equal buttons — on an exercise screen only (one
// exercise up), never in the overview. Finish lives in the top bar
// (_renderSessionStatusChip, med-t5s6) so it is never next to Next.
function renderSessionDetailActions(container) {
    container.replaceChildren();

    const st = window.WorkoutSessionsState;
    const ui = _sessionUi();
    const n = (st.logs || []).length;
    const show = !ui.overview && n >= 1;
    container.hidden = !show;
    const add = document.getElementById('workout-session-add-btn');
    if (add) add.hidden = !show;
    if (!show) return;

    const prev = _wgBtn('', 'wg-workouts-session-actions__prev', () => _showSessionExercise(ui.current - 1));
    prev.disabled = ui.current <= 0;
    prev.append(_wgIco('chev-l', 'wg-ico--sm'), document.createTextNode('Prev'));
    const next = _wgBtn('', 'wg-workouts-session-actions__next', () => _showSessionExercise(ui.current + 1));
    next.disabled = ui.current >= n - 1;
    next.append(document.createTextNode('Next'), _wgIco('chev-r', 'wg-ico--sm'));
    container.append(prev, next);
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
    // Same for the equipment picker and its Manage sheet (med-i7kw).
    if (_isSessionSheetShown(SESSION_EQUIP_MANAGE_ID)) _closeSessionSheet(SESSION_EQUIP_MANAGE_ID);
    if (_isSessionSheetShown(SESSION_EQUIP_PICKER_ID)) _closeSessionEquipPicker();
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
    window.WorkoutSessionsState.equipPickerLog = null;
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
            // Nothing done (a notes-only planned row, or every set un-ticked):
            // its weight is a placeholder 0, and the domain mirrors a sent weight
            // into the plan target — omit it so the plan keeps its weight.
            const weightField = Number(log.sets_completed) > 0 ? parseFloat(log.weight_kg) : undefined;
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
                        ...(weightField !== undefined ? { weight_kg: weightField } : {}),
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
                        ...(weightField !== undefined ? { target_weight_kg: weightField } : {}),
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
            // Starting an upcoming session re-keys it onto today's slot (or an
            // ad-hoc one, med-gmyf); the route names the session it started.
            const startedId = result && result.session_id != null ? result.session_id : sessionId;
            await showWorkoutSessionModal(startedId);

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

// Kit WA3/WA3b (med-okwf.3): the sheet is a search field over the shared row
// list; tapping a row adds that exercise (saveNewSessionExercise). No Save, no
// sets/reps/weight fields — the added exercise gets one pending set.
async function showAddExerciseToSessionModal() {
    const st = window.WorkoutSessionsState;
    if (!st.data) return;

    const input = document.getElementById('session-add-exercise-name');
    input.value = '';
    const eyebrow = document.getElementById('workout-add-exercise-to-session-eyebrow');
    if (eyebrow) {
        const adhoc = st.data.group_id === -1 && st.data.notes ? String(st.data.notes).trim() : '';
        eyebrow.textContent = adhoc || st.planLabel || 'Workout';
    }

    await window.WorkoutLibrary.bindExerciseAddList({
        input,
        mount: document.getElementById('session-add-exercise-suggest'),
        exclude: st.logs.map((l) => l.exercise_name),
        lastLine: _lastSessionLine,
        onAdd: saveNewSessionExercise
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

// "last 3 × 15 · 20 kg" for a row of the add list: the prior session's sets
// (the source of the ghost "last" cells), top set by weight. null = never
// logged before.
async function _lastSessionLine(name) {
    const sets = _priorSessionSets(await _exerciseHistory(name));
    if (!sets) return null;
    const top = sets.reduce((a, s) => ((Number(s.weight_kg) || 0) > (Number(a.weight_kg) || 0) ? s : a), sets[0]);
    const w = Number(top.weight_kg) || 0;
    return `last ${sets.length} × ${_fmtSetNumber(top.reps)}${w > 0 ? ` · ${_fmtSetNumber(w)} kg` : ''}`;
}

// A row was tapped in the add list: add that exercise as the next one, not
// done, with one pending set (med-okwf.1/.3). `item` is a library row (id +
// default_reps_min / default_weight_kg), a catalog name { name } or a typed
// name { name }; the last two have no id and go through
// resolveOrCreateLibraryId (med-prk.3). The pending set's ghost is last
// session's set when there is one (_setRowValues), else the library default
// posted here as the target, else empty.
let _addingExercise = false; // module-state: one add at a time — a double tap must not POST two creates
async function saveNewSessionExercise(item) {
    if (_addingExercise) return;
    _addingExercise = true;
    try {
        await _addSessionExercise(item);
    } finally {
        _addingExercise = false;
    }
}

async function _addSessionExercise(item) {
    const sessionData = window.WorkoutSessionsState.data;
    const name = String((item && item.name) || '').trim();
    if (!sessionData || !name) return;

    // Drain any pending/in-flight autosave first. Otherwise a debounce timer
    // armed by a prior edit can fire during the create awaits below and iterate
    // the just-pushed optimistic log (id:0, _dirty) → a second logs/create for
    // the same exercise (dedup conflict). Flushing also persists that prior edit
    // before the modal reload at the end reloads clean server state (which would
    // otherwise drop it). If the flush FAILS (offline/5xx), bail like
    // closeWorkoutSessionModal does: settleFailure already restored the dirty
    // flags + inline error, so proceeding to create + reload would drop that
    // preserved edit. The add-exercise sheet stays open.
    if (!(await flushPendingAutosave())) {
        safeAlert('Could not save your previous change — fix that first, then add the exercise.');
        return;
    }
    if (!window.WorkoutSessionsState.data) return;

    // The library default pre-fills the pending set, clamped to the same
    // ceilings as addLocalSet / saveWorkoutSessionDetails (reps 100, 500 kg).
    const reps = Math.min(100, Math.max(0, Math.round(Number(item.default_reps_min) || 0)));
    const rawWeight = Number(item.default_weight_kg);
    const weight = rawWeight > 0 ? Math.min(500, rawWeight) : null;

    let exerciseId = item.id;
    if (!exerciseId) {
        // A catalog name or a typed one. resolveOrCreateLibraryId matches the
        // library case-insensitively by name first and only INSERTs when the
        // name is genuinely new (med-prk.3) — with no defaults.
        exerciseId = await window.WorkoutLibrary.resolveOrCreateLibraryId(name);
        if (!exerciseId) {
            safeToast('Failed to add exercise', 'error');
            return;
        }
    }

    // Optimistic: push the new log into the session modal's logs array and
    // re-render BEFORE awaiting the network call, so the row appears
    // instantly. Carries `_optimistic: true` so we can splice it out on
    // POST failure without removing user-edited rows by accident.
    // The added exercise is NOT done (med-okwf.1): a placeholder log (status
    // '', zero done sets) whose reps/weight only pre-fill the one pending set
    // row (the ghost falls back to them). It completes through the normal
    // per-set flow — ticking a set autosaves `sets`, and the domain promotes a
    // placeholder to 'completed' once it has a set. Untouched, it never counts
    // as completed (history, stats, 1RM/PR, gamification all read 'completed').
    // Not _dirty: the create below is its whole persistence; a dirty id:0 row
    // would make a racing autosave POST a second (conflicting) create.
    const optimisticLog = {
        id: 0,
        exercise_id: parseInt(exerciseId),
        exercise_name: name,
        sets_completed: 0,
        reps_completed: reps,
        weight_kg: weight == null ? 0 : weight,
        sets: [],
        _setsInit: true,
        notes: '',
        status: '',
        source: 'library',
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
    // the new total before the POST resolves. Not exercises_completed — the
    // new exercise isn't done yet.
    const historyHandle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
        ? await window.DataStore.applyOptimistic('workout_history', (prev) => {
            if (!prev || !Array.isArray(prev.sessions)) return prev;
            const next = { ...prev };
            next.sessions = prev.sessions.map((s) => {
                if (s?.session?.id !== sessionData.id) return s;
                return { ...s, exercises_count: (s.exercises_count || 0) + 1 };
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
            // createLog stores target_* as the flat done scalars when no
            // `sets` are sent, so target_sets 0 = zero done sets; reps/weight
            // ride along as the pending row's pre-fill.
            target_sets: 0,
            target_reps_min: reps,
            target_weight_kg: weight,
            status: '',
            notes: '',
            source: 'library'
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
