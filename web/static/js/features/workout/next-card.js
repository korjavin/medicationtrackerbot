// ====================================
// NEXT WORKOUT CARD + Shared slot tag
// ====================================

// workoutSlotTag(doc, session, groupName, extraClass) — the tag that opens a
// history row / session header. Ad-hoc sessions (group_id === -1) read
// AD-HOC; planned sessions read their plan (group) name. Consumed by
// history.js / sessions.js — load this file before those.
function workoutSlotTag(doc, session, groupName, extraClass) {
    const isAdHoc = !!session && session.group_id === -1;
    const tag = doc.createElement('span');
    tag.className = `wg-workouts-slot-tag wg-workouts-slot-tag--${isAdHoc ? 'adhoc' : 'plan'}${extraClass ? ` ${extraClass}` : ''}`;
    tag.textContent = isAdHoc ? 'AD-HOC' : (groupName || 'Plan');
    return tag;
}

async function loadNextWorkout() {
    const container = document.getElementById('next-workout-card');
    await window.DataStore.loadSWR({
        key: 'workout_next',
        tags: ['workout'],
        // apiCallDirect throws on offline/5xx so a transient refresh failure
        // routes through onError (cached card preserved). A real "no next
        // workout" response from
        // the server is JSON null; wrap it into { session: null } so the
        // matched bootstrap shape (app.js workout_next spec) is cached and
        // _renderNextWorkout clears the container the same way it would for
        // that legitimate server response.
        fetcher: async () => {
            if (!window.apiCallDirect) throw new Error('apiCallDirect not available');
            const res = await window.apiCallDirect('/api/workout/sessions/next');
            return res === null ? { session: null } : res;
        },
        onCached: async (cached) => {
            _renderNextWorkout(container, cached);
        },
        onFresh: async (fresh) => {
            _renderNextWorkout(container, fresh);
        },
        onError: async (error, cached) => {
            console.error('Error loading next workout:', error);
            // A no-cache read failure still renders the no-session card, so
            // the screen never loses its way to start a workout.
            if (!cached) _renderNextWorkout(container, null);
        }
    });
}

// Classic scripts share one global scope (meds.js owns _pad2): prefixed names.
function _nextCardPad(n) {
    return String(n).padStart(2, '0');
}

function _nextCardHHMM(d) {
    return `${_nextCardPad(d.getHours())}:${_nextCardPad(d.getMinutes())}`;
}

function _nextCardEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
}

// Kit buttons. Never offline-gated: workout writes are local-first (med-mgvo).
function _nextCardBtn(label, cls, action, onClick) {
    const b = _nextCardEl('button', `wg-btn${cls ? ` ${cls}` : ''}`, label);
    b.type = 'button';
    b.dataset.action = action;
    b.addEventListener('click', onClick);
    return b;
}

// "3 exercises · Bench press, Dips, Cable fly" / "5 exercises · Squat,
// Romanian deadlift +3": every name up to three, else two and the rest.
function _nextCardExerciseLine(count, names) {
    const head = `${count} exercise${count === 1 ? '' : 's'}`;
    const list = Array.isArray(names) ? names.filter(Boolean) : [];
    if (!list.length) return head;
    if (count <= 3) return `${head} · ${list.join(', ')}`;
    return `${head} · ${list.slice(0, 2).join(', ')} +${count - 2}`;
}

// Up next card, kit WN1/WN3/WN4/WN5/WN6 (med-soo0.2). Every action routes to
// the session handlers in sessions.js, which own the optimistic writes.
function _renderNextWorkout(container, data) {
    const session = (data && data.session) ? data.session : null;
    if (!session) {
        _renderNoSessionCard(container);
        return;
    }

    const status = session.status;
    const inProgress = status === 'in_progress';
    const skipping = status === 'pre_skipped';
    // Server-provided is_today (stored timezone), not the browser's date.
    const isToday = session.is_today === true;
    const isAdHoc = data.group_id === -1;
    const id = session.id;

    // Parse scheduled_date as local parts: a UTC parse shifts the day for
    // users west of UTC.
    const parts = (session.scheduled_date || '').split('T')[0].split('-').map(Number);
    const date = parts.length === 3 ? new Date(parts[0], parts[1] - 1, parts[2]) : new Date();
    const weekday = date.toLocaleDateString('en-US', { weekday: 'short' });
    const when = isToday ? 'Today' : `${weekday} ${_nextCardPad(date.getDate())}.${_nextCardPad(date.getMonth() + 1)}`;

    let eyebrowText = `${when} · ${session.scheduled_time}`;
    if (inProgress) {
        const started = Date.parse(session.started_at || '');
        eyebrowText = Number.isNaN(started)
            ? 'In progress'
            : `In progress · ${Math.max(0, Math.floor((Date.now() - started) / 60000))} min`;
    } else if (session.is_snoozed) {
        const until = new Date(session.snoozed_until || '');
        eyebrowText = Number.isNaN(until.getTime()) ? 'Snoozed' : `Snoozed to ${_nextCardHHMM(until)}`;
    }

    const card = _nextCardEl('section', `wg-card${skipping ? '' : ' wg-card--accent'} wg-vstack wg-wn`);
    card.setAttribute('aria-label', 'Up next');

    // The sun dot marks something to do today; a skip has nothing to do.
    const head = _nextCardEl('div', 'wg-hstack');
    head.append(
        _nextCardEl('span', `wg-eyebrow${(isToday || inProgress) && !skipping ? ' wg-eyebrow--dot' : ''}`, eyebrowText),
        _nextCardEl('span', 'wg-spacer'),
        skipping ? _nextCardEl('span', 'wg-tag', 'Skipping')
            : isAdHoc ? _nextCardEl('span', 'wg-tag', 'Off plan')
                : _nextCardEl('span', 'wg-meta', data.group_name || '')
    );
    card.appendChild(head);

    // Title = the plan day; a tap opens that day's exercises (Plan page). An
    // empty workout has no plan page, so its tap opens the session.
    const info = _nextCardEl('div', 'wg-wn__info');
    info.setAttribute('role', 'button');
    info.tabIndex = 0;
    const open = isAdHoc
        ? () => showWorkoutSessionModal(id)
        : () => openNextWorkoutEditModal(data.variant_id || 0, data.group_id || 0);
    info.addEventListener('click', open);
    info.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    const dayName = isAdHoc ? ((session.notes || '').trim() || 'Workout') : data.variant_name;
    const fullDay = date.toLocaleDateString('en-US', { weekday: 'long' });
    const line = skipping
        ? (isToday ? 'Skipped today. Undo to keep it.' : `Skipped when ${fullDay} comes. Undo to keep it.`)
        : _nextCardExerciseLine(data.exercises_count || 0, data.exercise_names);
    info.append(_nextCardEl('p', 'wg-card__title', dayName), _nextCardEl('p', 'wg-meta', line));
    card.appendChild(info);

    // Plan line, rotating plans only; hidden while skipping or running.
    const plan = data.plan;
    if (plan && plan.position && !skipping && !inProgress) {
        const row = _nextCardEl('div', 'wg-hstack wg-wn-day');
        const then = plan.total > 1 && plan.next_variant_name ? ` · then ${plan.next_variant_name}` : '';
        row.append(_nextCardEl('span', 'wg-meta', `Day ${plan.position} of ${plan.total}${then}`), _nextCardEl('span', 'wg-spacer'));
        // med-soo0.3 registers WorkoutNextCard.otherPlanDay (the WN7 sheet);
        // until then the button is absent.
        const pick = window.WorkoutNextCard && window.WorkoutNextCard.otherPlanDay;
        if (typeof pick === 'function') {
            row.appendChild(_nextCardBtn('Other plan day', 'wg-btn--sm', 'other-plan-day', () => pick(data)));
        }
        card.appendChild(row);
    }

    const foot = _nextCardEl('div', 'wg-card__foot');
    if (inProgress) {
        foot.append(
            _nextCardBtn('Finish', 'wg-btn--ghost', 'finish', () => completeWorkoutSession(id)),
            _nextCardBtn('Continue', 'wg-btn--primary', 'continue', () => showWorkoutSessionModal(id))
        );
    } else if (skipping) {
        foot.append(_nextCardBtn('Undo skip', '', 'undo-skip', () => cancelPreSkipWorkoutSession(id)));
    } else {
        foot.append(
            _nextCardBtn(isToday ? 'Skip today' : `Skip ${weekday}`, 'wg-btn--ghost', 'skip', () => preSkipWorkoutSession(id)),
            _nextCardBtn(isToday ? 'Start workout' : 'Start now', 'wg-btn--primary', 'start', () => startWorkoutSession(id))
        );
    }
    card.appendChild(foot);

    // "Start empty workout" row under the card (WN1); one workout at a time.
    if (inProgress) container.replaceChildren(card);
    else container.replaceChildren(card, _startEmptyWorkoutRow());
    _attachNextCardGymSwitch(card, foot);
}

function _startEmptyWorkout() {
    return window.startAdHocWorkout({ addSheet: true });
}

function _startEmptyWorkoutRow() {
    const list = _nextCardEl('div', 'wg-list');
    const row = _nextCardEl('button', 'wg-row');
    row.type = 'button';
    row.id = 'workout-start-empty-row';
    const lead = _nextCardEl('span', 'wg-row__lead');
    lead.appendChild(_wgIco('plus'));
    const body = _nextCardEl('span', 'wg-row__body');
    body.append(_nextCardEl('span', 'wg-row__title', 'Start empty workout'), _nextCardEl('span', 'wg-row__meta', 'Add exercises as you go'));
    row.append(lead, body, _wgIco('chev-r', 'wg-row__chev'));
    row.addEventListener('click', _startEmptyWorkout);
    list.appendChild(row);
    return list;
}

// WN6: nothing scheduled. With no plan at all the card also offers "Make a
// plan"; when a plan exists (inactive, or no day ahead) that offer goes.
function _renderNoSessionCard(container) {
    const card = _nextCardEl('section', 'wg-card wg-card--accent wg-vstack wg-wn');
    card.setAttribute('aria-label', 'Up next');
    const head = _nextCardEl('div', 'wg-hstack');
    const eyebrow = _nextCardEl('span', 'wg-eyebrow', 'No plan yet');
    head.append(eyebrow, _nextCardEl('span', 'wg-spacer'));
    const info = _nextCardEl('div', 'wg-wn__info');
    const meta = _nextCardEl('p', 'wg-meta', 'Add exercises as you go. Make a plan to get reminders.');
    info.append(_nextCardEl('p', 'wg-card__title', 'Log a workout'), meta);
    const foot = _nextCardEl('div', 'wg-card__foot');
    const makePlan = _nextCardBtn('Make a plan', 'wg-btn--ghost', 'make-plan', () => {
        switchWorkoutTab('groups');
        openWorkoutPlanPage(null);
    });
    foot.append(makePlan, _nextCardBtn('Start empty workout', 'wg-btn--primary', 'start-empty', _startEmptyWorkout));
    card.append(head, info, foot);
    container.replaceChildren(card);
    _attachNextCardGymSwitch(card, foot);

    // Local read (cloud mode answers from the vault); a failure keeps the offer.
    Promise.resolve()
        .then(() => window.apiCall('/api/workout/groups'))
        .then((groups) => {
            if (!card.isConnected || !Array.isArray(groups) || groups.length === 0) return;
            eyebrow.textContent = 'Nothing scheduled';
            meta.textContent = 'Add exercises as you go.';
            makePlan.remove();
        })
        .catch(() => { /* keep the offer */ });
}

// med-8j5w.2: "At: <gym>" active-gym switch above the card's foot.
// Fire-and-forget after the card mounts; absent when the account has no gyms
// or the gym read fails (the switch is a write affordance, not data). A
// switch re-resolves plate chips / progression at the new gym from then on.
async function _attachNextCardGymSwitch(card, foot) {
    const eq = window.WorkoutEquipment;
    if (!eq || typeof eq.locations !== 'function' || typeof eq.gymSwitch !== 'function') return;
    let state = null;
    try {
        state = await eq.locations();
    } catch (_) {
        return;
    }
    if (!card.isConnected || !state || state.locations.length === 0) return;
    if (card.querySelector('.wg-workouts-gym-switch')) return;
    // A persistent setting, not a per-workout choice: the picker says so.
    const control = eq.gymSwitch(document, state.locations, state.activeId, {
        title: 'Where do you train?',
        hint: 'Stays selected for every workout until you change it.',
        onPick: async (id) => {
            const ok = await eq.setActiveLocation(id);
            if (ok) state.activeId = id;
            return ok;
        },
    });
    card.insertBefore(control, foot);
}

// ====================================
// NEXT WORKOUT EDIT MODAL
// ====================================

// The card's planned-exercises tap: the Plan page, then that Day's page on top
// (a flat plan has no Day page — its exercises are on the Plan page).
async function openNextWorkoutEditModal(variantId, groupId) {
    if (!variantId || !groupId) return;
    const page = await openWorkoutPlanPage(groupId);
    const draft = window.WorkoutEdit.planDraft;
    if (!page || !draft || !document.getElementById('workout-group-rotating').checked) return;
    const day = draft.days.find((d) => d.id === variantId);
    if (day) openWorkoutDayPage(day, renderWorkoutPlanBody);
}

async function nextWorkoutVariant(sessionId) {
    try {
        const result = await apiCall(`/api/workout/sessions/${sessionId}/next-variant`, 'POST');
        if (result === null) return;
        await invalidateWorkoutCache();
        await loadNextWorkout();
    } catch (error) {
        console.error('Error switching to next variant:', error);
        safeToast('Failed to switch day. Please try again.', 'error');
    }
}

window.WorkoutNextCard = {
    load: loadNextWorkout,
    openEdit: openNextWorkoutEditModal,
    nextVariant: nextWorkoutVariant
};
