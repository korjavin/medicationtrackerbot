
// ====================================
// WORKOUT MANAGEMENT - CRUD Interface
// ====================================

// State
let workoutGroups = [];
let currentEditingGroupId = null;
let currentEditingVariantId = null;
let currentEditingExerciseId = null;
let currentGroupForVariant = null;
let currentVariantForExercise = null;

// ====================================
// TAB SWITCHING
// ====================================

// Sub-tab state (Phase 7, Task 2). Mirrors the `mt-meds-subtab` /
// `mt-food-subtab` pattern — one of four values (`history`, `groups`,
// `exercises`, `stats`), persisted to localStorage so the user's choice
// survives reload. Default is `history`.
const WORKOUTS_SUBTAB_STORAGE_KEY = 'mt-workouts-subtab';
const WORKOUTS_SUBTAB_OPTIONS = ['history', 'groups', 'exercises', 'stats'];
const WORKOUTS_SUBTAB_DEFAULT = 'history';

function getActiveWorkoutsSubTab() {
    try {
        const raw = window.localStorage.getItem(WORKOUTS_SUBTAB_STORAGE_KEY);
        if (WORKOUTS_SUBTAB_OPTIONS.indexOf(raw) !== -1) return raw;
    } catch (_) { /* ignore */ }
    return WORKOUTS_SUBTAB_DEFAULT;
}

function setActiveWorkoutsSubTab(tab) {
    if (WORKOUTS_SUBTAB_OPTIONS.indexOf(tab) === -1) return;
    try { window.localStorage.setItem(WORKOUTS_SUBTAB_STORAGE_KEY, tab); } catch (_) { /* ignore */ }
}

function syncWorkoutsSubTabActiveClass(activeTab) {
    const container = document.querySelector('.wg-workouts-subtabs');
    if (!container) return;
    const buttons = container.querySelectorAll('.workout-tab');
    buttons.forEach((btn) => {
        const isActive = btn.dataset.tab === activeTab;
        btn.classList.toggle('wg-gloss--sun', isActive);
        btn.classList.toggle('wg-workouts-subtabs__btn--active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

function restoreWorkoutsSubTab() {
    syncWorkoutsSubTabActiveClass(getActiveWorkoutsSubTab());
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restoreWorkoutsSubTab, { once: true });
} else {
    restoreWorkoutsSubTab();
}

function switchWorkoutTab(tab) {
    const activated = activateTabGroup(tab, {
        buttonSelector: '.workout-tab',
        contentSelector: '.workout-tab-content',
        contentIdFromTab: (tabName) => `workout-${tabName}-tab`
    });
    if (!activated) return;

    if (typeof syncWorkoutsSubTabActiveClass === 'function') syncWorkoutsSubTabActiveClass(tab);
    if (typeof setActiveWorkoutsSubTab === 'function') setActiveWorkoutsSubTab(tab);

    if (tab === 'groups') { loadWorkoutGroups(); }
    else if (tab === 'history') { loadNextWorkout(); loadWorkoutHistoryTab(); }
    else if (tab === 'exercises') { loadExerciseLibrary(); }
    else if (tab === 'stats') { loadWorkoutStatsTab(); }
}

bindTabGroup({
    container: document.querySelector('.workout-tabs'),
    buttonSelector: '.workout-tab',
    onTabSelect: switchWorkoutTab
});

// Main load function called when switching to workouts tab. Honors the
// persisted sub-tab so a user who left the screen on Groups or Stats
// returns to that view.
function loadWorkouts() {
    const stored = typeof getActiveWorkoutsSubTab === 'function' ? getActiveWorkoutsSubTab() : WORKOUTS_SUBTAB_DEFAULT;
    switchWorkoutTab(stored);
}

let workoutControlsBound = false;

function bindWorkoutControls() {
    if (workoutControlsBound) return;
    workoutControlsBound = true;

    const bindClick = (id, handler) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', handler);
    };

    bindClick('start-adhoc-workout-btn', () => startAdHocWorkout());
    bindClick('add-workout-group-btn', () => showAddWorkoutGroupModal());
    bindClick('add-exercise-library-btn', () => showExerciseLibraryModal());

    bindClick('workout-group-cancel-btn', () => closeWorkoutGroupModal());
    bindClick('workout-group-close-btn', () => closeWorkoutGroupModal());
    bindClick('workout-group-save-btn', () => saveWorkoutGroup());
    bindClick('add-variant-btn', () => showAddVariantModal());
    bindClick('add-flat-exercise-btn', () => showAddExerciseModalFromGroup());

    bindClick('variant-cancel-btn', () => closeVariantModal());
    bindClick('variant-save-btn', () => saveVariant());
    bindClick('variant-add-exercise-btn', () => showAddExerciseModal());

    bindClick('exercise-cancel-btn', () => closeExerciseModal());
    bindClick('exercise-close-btn', () => closeExerciseModal());
    bindClick('exercise-save-btn', () => saveExercise());

    bindClick('exercise-library-cancel-btn', () => closeExerciseLibraryModal());
    bindClick('exercise-library-close-btn', () => closeExerciseLibraryModal());
    bindClick('exercise-library-save-btn', () => saveExerciseLibraryItem());

    bindClick('workout-session-delete-btn', () => deleteWorkoutSession());
    bindClick('workout-session-cancel-btn', () => closeWorkoutSessionModal());
    bindClick('workout-session-save-btn', () => saveWorkoutSessionDetails());

    bindClick('session-add-exercise-cancel-btn', () => closeAddExerciseToSessionModal());
    bindClick('session-add-exercise-close-btn', () => closeAddExerciseToSessionModal());
    bindClick('session-add-exercise-save-btn', () => saveNewSessionExercise());

    bindClick('miband-workout-cancel-btn', () => closeMiBandWorkoutModal());
    bindClick('miband-workout-save-btn', () => saveMiBandWorkout());
    bindClick('miband-workout-delete-btn', () => deleteMiBandWorkout());

    const rotatingCheckbox = document.getElementById('workout-group-rotating');
    if (rotatingCheckbox) {
        rotatingCheckbox.addEventListener('change', () => {
            toggleRotatingFields();
        });
    }

    document.querySelectorAll('#workout-group-modal .days-select span').forEach((day) => {
        day.addEventListener('click', () => {
            toggleWorkoutDay(day);
        });
    });

    const sessionExerciseName = document.getElementById('session-add-exercise-name');
    if (sessionExerciseName) {
        sessionExerciseName.addEventListener('change', () => {
            onSessionExerciseSelect();
        });
    }

    renderWorkoutModalCloseIcons();
}

// Hydrate the `.wg-gloss` span inside every workout modal's close button with
// the shared close SVG. Mirrors the food.js `renderFoodModalIcons` pattern so
// the Wandergeek close affordance isn't rendered as a blank pill.
function renderWorkoutModalCloseIcons() {
    if (!window.WGIcons || typeof window.WGIcons.iconSvg !== 'function') return;
    const closeBtnIds = [
        'workout-group-close-btn',
        'exercise-close-btn',
        'exercise-library-close-btn',
        'session-add-exercise-close-btn',
    ];
    closeBtnIds.forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        const gloss = btn.querySelector('.wg-gloss');
        if (!gloss || gloss.querySelector('svg')) return;
        gloss.replaceChildren(window.WGIcons.iconSvg('close', { size: 14 }));
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindWorkoutControls, { once: true });
}
bindWorkoutControls();

// ====================================
// NEXT WORKOUT CARD
// ====================================

// Today's-workout card (Phase 7, Task 3). Sun-glossed card that mirrors the
// Meds next-action pattern and surfaces the current rotation slot.
//
// The classifier `getRotationSlot(variantName)` maps a variant name into one
// of five token-group names (PUSH / PULL / LEGS / REST / AD-HOC). It drives
// both the slot-tag CSS variant and the card variant (sun for PUSH/PULL/LEGS,
// muted for REST / AD-HOC).
function getRotationSlot(variantName) {
    if (typeof variantName !== 'string' || variantName.trim() === '') return 'AD-HOC';
    const v = variantName.toUpperCase();
    if (/\bPUSH\b/.test(v)) return 'PUSH';
    if (/\bPULL\b/.test(v)) return 'PULL';
    if (/\bLEGS?\b/.test(v)) return 'LEGS';
    if (/\bREST\b/.test(v) || /\bOFF\b/.test(v)) return 'REST';
    return 'AD-HOC';
}

function _slotTagModifier(slot) {
    switch (slot) {
        case 'PUSH': return 'push';
        case 'PULL': return 'pull';
        case 'LEGS': return 'legs';
        case 'REST': return 'rest';
        default: return 'adhoc';
    }
}

function _formatTodayNames(names, fallback) {
    if (!Array.isArray(names) || names.length === 0) {
        return typeof fallback === 'string' ? fallback : '';
    }
    if (names.length <= 3) return names.join(' · ');
    const first = names.slice(0, 3).join(' · ');
    return `${first} · +${names.length - 3}`;
}

function _formatTodayDuration(minutes) {
    const m = Math.max(0, Math.round(minutes || 0));
    if (m < 60) return `${m}m`;
    const hh = Math.floor(m / 60);
    const mm = m % 60;
    return mm === 0 ? `${hh}h` : `${hh}h ${mm}m`;
}

// renderTodaysWorkoutCard(rotation, todaySessions, opts) — pure DOM helper.
//
// rotation:     `/api/workout/sessions/next` response ({ session, group_name,
//               variant_name, exercises_count, exercises?, is_rotating, ... })
//               or null when no upcoming session is scheduled.
// todaySessions: array of completed session objects carrying a
//               `duration_minutes` field (used to drive the already-completed
//               state). Empty array is the common non-completed case.
// opts.onStart(sessionId): invoked when the Start button is clicked on a
//               non-rest card.
// opts.onAdhoc(): invoked when the ad-hoc CTA is clicked on a rest card (or
//               when no rotation is available).
function renderTodaysWorkoutCard(rotation, todaySessions, opts) {
    const d = (typeof document !== 'undefined') ? document : null;
    if (!d) return null;
    const options = opts || {};
    const onStart = typeof options.onStart === 'function'
        ? options.onStart
        : (typeof window !== 'undefined' && typeof window.startWorkoutSession === 'function'
            ? window.startWorkoutSession
            : () => {});
    const onAdhoc = typeof options.onAdhoc === 'function'
        ? options.onAdhoc
        : (typeof window !== 'undefined' && typeof window.startAdHocWorkout === 'function'
            ? window.startAdHocWorkout
            : () => {});

    const sessions = Array.isArray(todaySessions) ? todaySessions : [];
    const completedSession = sessions.find((s) => s && (s.status === 'completed' || s.completed));
    const session = rotation && rotation.session ? rotation.session : null;
    const slot = getRotationSlot(rotation && rotation.variant_name);

    const card = d.createElement('div');
    card.setAttribute('data-section', 'todays-workout');
    card.dataset.slot = slot;

    const text = d.createElement('div');
    text.className = 'wg-workouts-today-card__text';
    const subtitle = d.createElement('div');
    subtitle.className = 'wg-workouts-today-card__subtitle';
    const value = d.createElement('div');
    value.className = 'wg-workouts-today-card__value';
    text.appendChild(subtitle);
    text.appendChild(value);

    const slotTag = d.createElement('span');
    slotTag.className = `wg-workouts-slot-tag wg-workouts-slot-tag--${_slotTagModifier(slot)}`;
    slotTag.textContent = slot;

    // Already-completed state. Muted `.wg-card` carrying a "Completed · 45m"
    // eyebrow + rotation-slot tag.
    if (completedSession) {
        card.className = 'wg-card wg-workouts-today-card wg-workouts-today-card--completed';
        card.dataset.state = 'completed';
        const minutes = completedSession.duration_minutes != null
            ? completedSession.duration_minutes
            : 0;
        subtitle.textContent = `Completed · ${_formatTodayDuration(minutes)}`;
        value.textContent = rotation && rotation.group_name
            ? rotation.group_name
            : 'Workout logged';
        text.insertBefore(slotTag, subtitle);
        card.appendChild(text);
        return card;
    }

    // Rest state. Triggered when no rotation session is available or when the
    // variant name classifier resolves to REST. Muted `.wg-card` with a
    // "Rest day" eyebrow and a Start ad-hoc CTA.
    if (!session || slot === 'REST') {
        card.className = 'wg-card wg-workouts-today-card wg-workouts-today-card--rest';
        card.dataset.state = 'rest';
        subtitle.textContent = 'Rest day';
        value.textContent = 'Start ad-hoc?';
        text.insertBefore(slotTag, subtitle);
        card.appendChild(text);
        const adhocBtn = d.createElement('button');
        adhocBtn.type = 'button';
        adhocBtn.className = 'wg-workouts-today-card__adhoc wg-gloss';
        adhocBtn.textContent = 'Start ad-hoc';
        adhocBtn.addEventListener('click', () => { onAdhoc(); });
        card.appendChild(adhocBtn);
        return card;
    }

    // Non-rest (PUSH / PULL / LEGS / AD-HOC rotated) state. Sun-glossed
    // `.wg-gloss--sun` card with "Today · SLOT" subtitle, mono names cluster,
    // rotation-slot tag, and a sun-glossed Start button.
    card.className = 'wg-workouts-today-card wg-gloss wg-gloss--sun';
    card.dataset.state = 'today';
    subtitle.textContent = `Today · ${slot}`;
    const exerciseNames = Array.isArray(rotation.exercises)
        ? rotation.exercises.map((e) => (e && e.name) || '').filter(Boolean)
        : [];
    const fallback = rotation.variant_name
        ? `${rotation.variant_name} · ${rotation.exercises_count || 0} exercises`
        : `${rotation.exercises_count || 0} exercises`;
    value.textContent = _formatTodayNames(exerciseNames, fallback);
    text.insertBefore(slotTag, subtitle);
    card.appendChild(text);

    const startBtn = d.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'wg-workouts-today-card__start wg-gloss wg-gloss--sun';
    startBtn.textContent = 'Start';
    const sessionId = session.id;
    startBtn.addEventListener('click', () => { onStart(sessionId); });
    card.appendChild(startBtn);

    return card;
}

async function loadNextWorkout() {
    const container = document.getElementById('next-workout-card');
    await window.DataStore.loadSWR({
        key: 'workout_next',
        tags: ['workout'],
        fetcher: async () => await apiCall('/api/workout/sessions/next'),
        onCached: async (cached) => {
            _renderNextWorkout(container, cached);
        },
        onFresh: async (fresh) => {
            _renderNextWorkout(container, fresh);
        },
        onError: async (error, cached) => {
            console.error('Error loading next workout:', error);
            if (!cached) container.replaceChildren();
        },
        allowNullFresh: true
    });
}

function _renderNextWorkout(container, data) {
    if (!data || !data.session) {
        container.replaceChildren();
        return;
    }

    const session = data.session;
    const status = session.status;
    const isSnoozed = session.is_snoozed || false;

    // Use server-provided is_today flag (computed in the stored timezone) to avoid
    // browser-timezone vs stored-timezone mismatches around midnight.
    const isToday = session.is_today === true;

    // Parse scheduled_date as local midnight to avoid UTC-to-local offset shifting
    // the displayed date by one day for users west of UTC.
    const _dateParts = (session.scheduled_date || '').split('T')[0].split('-').map(Number);
    const date = _dateParts.length === 3 ? new Date(_dateParts[0], _dateParts[1] - 1, _dateParts[2]) : new Date();

    // Determine card styling based on status
    let cardClass = 'next-workout-card';
    let statusEmoji = '📅';
    let statusText = 'Upcoming';

    if (isSnoozed) {
        cardClass += ' notified';
        statusEmoji = '⏰';
        statusText = 'Snoozed';
    } else if (status === 'in_progress') {
        cardClass += ' in-progress';
        statusEmoji = '🏋️';
        statusText = 'In Progress';
    } else if (status === 'notified') {
        cardClass += ' notified';
        statusEmoji = '🔔';
        statusText = 'Ready to Start';
    } else if (status === 'pre_skipped') {
        cardClass += ' pre-skipped';
        statusEmoji = '⏭';
        statusText = 'To Be Skipped';
    } else if (isToday) {
        cardClass += ' today';
        statusText = 'Today';
    }

    const dateStr = isToday ? 'Today' : date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        weekday: 'short'
    });

    const variantId = data.variant_id || 0;
    const groupId = data.group_id || 0;
    const isRotating = data.is_rotating || false;

    const card = document.createElement('div');
    card.className = cardClass;

    const header = document.createElement('div');
    header.className = 'next-workout-header';

    const statusEl = document.createElement('div');
    statusEl.className = 'next-workout-status';
    statusEl.textContent = `${statusEmoji} ${statusText}`;

    const dateEl = document.createElement('div');
    dateEl.className = 'next-workout-date';
    dateEl.textContent = `${dateStr} at ${session.scheduled_time}`;

    header.appendChild(statusEl);
    header.appendChild(dateEl);
    card.appendChild(header);

    const info = document.createElement('div');
    info.className = 'next-workout-info';
    info.classList.add('cursor-pointer');
    info.title = 'View/edit planned exercises';
    info.addEventListener('click', () => {
        openNextWorkoutEditModal(variantId, groupId);
    });

    const title = document.createElement('h3');
    title.textContent = data.group_name;
    const subtitle = document.createElement('p');
    subtitle.textContent = `${data.variant_name} • ${data.exercises_count} exercises ✏️`;
    info.appendChild(title);
    info.appendChild(subtitle);
    card.appendChild(info);

    const isOffline = window.SyncManager && !window.SyncManager.isOnline;
    const createButton = (label, className, onClick) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className + ' workout-action-btn';
        button.textContent = label;
        if (isOffline) {
            button.classList.add('offline-disabled');
            button.setAttribute('data-offline-disabled', 'true');
            button.disabled = true;
        }
        button.addEventListener('click', () => {
            onClick(session.id);
        });
        return button;
    };

    if (status === 'in_progress') {
        const row = document.createElement('div');
        row.className = 'workout-btn-row';
        row.appendChild(createButton('🏋️ Continue', 'btn btn-pill flex-1', showWorkoutSessionModal));
        row.appendChild(createButton('🛑 Stop', 'btn btn-pill flex-1 workout-btn-stop', cancelWorkoutSession));
        card.appendChild(row);
    } else if (status === 'pre_skipped') {
        card.appendChild(createButton('↩ Cancel Skip', 'btn btn-pill workout-btn-full', cancelPreSkipWorkoutSession));
        if (isRotating) {
            card.appendChild(createButton('↻ Next Variant', 'btn btn-pill workout-btn-full-secondary', nextWorkoutVariant));
        }
    } else {
        const row = document.createElement('div');
        row.className = 'workout-btn-row';
        row.appendChild(createButton('🏋️ Start Workout', 'btn btn-pill flex-1', startWorkoutSession));
        row.appendChild(createButton('⏭ Skip', 'btn btn-pill flex-1 workout-btn-skip', preSkipWorkoutSession));
        card.appendChild(row);
        if (isRotating) {
            card.appendChild(createButton('↻ Next Variant', 'btn btn-pill workout-btn-full-secondary', nextWorkoutVariant));
        }
    }

    container.replaceChildren(card);
}

// ====================================
// NEXT WORKOUT EDIT MODAL
// ====================================

async function openNextWorkoutEditModal(variantId, groupId) {
    if (!variantId || !groupId) return;
    currentGroupForVariant = groupId;
    await showEditVariantModal(variantId);
}

async function nextWorkoutVariant(sessionId) {
    try {
        const result = await apiCall(`/api/workout/sessions/${sessionId}/next-variant`, 'POST');
        if (result === null) return;
        await loadNextWorkout();
    } catch (error) {
        console.error('Error switching to next variant:', error);
        alert('Failed to switch variant. Please try again.');
    }
}

// ====================================
// LOAD WORKOUT GROUPS
// ====================================

async function loadWorkoutGroups() {
    const container = document.getElementById('workout-groups-list');
    await window.DataStore.loadSWR({
        key: 'workout_groups',
        tags: ['workout'],
        fetcher: async () => await apiCall('/api/workout/groups'),
        onCached: async (cached) => {
            _renderWorkoutGroups(container, cached);
        },
        onFresh: async (groups) => {
            workoutGroups = groups || [];
            if (groups && window.MedTrackerDB?.WorkoutStore) {
                await window.MedTrackerDB.WorkoutStore.saveCache('groups', groups);
            }
            _renderWorkoutGroups(container, groups);
        },
        onError: async (error, cached) => {
            console.error('Error loading workout groups:', error);
            if (!cached) {
                const message = document.createElement('p');
                message.className = 'text-hint';
                message.textContent = 'No cached data \u2014 will load when online';
                container.replaceChildren(message);
            }
        }
    });
}

function _renderWorkoutGroups(container, groups) {
    if (!container) return;
    const doc = container.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function') return;
    workoutGroups = groups || [];

    container.classList.add('wg-workouts-groups');

    if (!groups || groups.length === 0) {
        const empty = doc.createElement('p');
        empty.className = 'wg-workouts-groups__empty';
        empty.textContent = 'No workout groups yet \u2014 tap Add to create one.';
        container.replaceChildren(empty);
        return;
    }

    const list = doc.createElement('ul');
    list.className = 'list-reset wg-workouts-groups__list';

    groups.forEach((group) => {
        list.appendChild(_buildWorkoutGroupRow(doc, group));
    });

    container.replaceChildren(list);
}

function _buildWorkoutGroupRow(doc, group) {
    const slot = getRotationSlot(group.name || '');
    const slotMod = _slotTagModifier(slot);

    const card = doc.createElement('li');
    card.className = 'wg-card wg-workouts-groups-row';
    card.dataset.groupId = String(group.id || '');
    card.dataset.slot = slot;
    if (group.is_rotating) card.classList.add('wg-workouts-groups-row--rotating');
    if (!group.active) card.classList.add('wg-workouts-groups-row--inactive');

    const body = doc.createElement('div');
    body.className = 'wg-workouts-groups-row__body';

    const title = doc.createElement('div');
    title.className = 'wg-workouts-groups-row__title';

    const slotTag = doc.createElement('span');
    slotTag.className = `wg-workouts-slot-tag wg-workouts-slot-tag--${slotMod} wg-workouts-groups-row__slot`;
    slotTag.textContent = slot;
    title.appendChild(slotTag);

    const name = doc.createElement('span');
    name.className = 'wg-workouts-groups-row__name';
    name.textContent = group.name || 'Workout group';
    title.appendChild(name);

    body.appendChild(title);

    const meta = doc.createElement('div');
    meta.className = 'wg-workouts-groups-row__meta';

    let daysArray = [];
    try {
        daysArray = JSON.parse(group.days_of_week || '[]');
    } catch (_) {
        daysArray = [];
    }
    const daysMap = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const daysText = daysArray.map((d) => daysMap[d]).filter(Boolean).join(', ');

    if (daysText) {
        const days = doc.createElement('span');
        days.className = 'wg-workouts-groups-row__days';
        days.textContent = daysText;
        meta.appendChild(days);
    }

    if (group.scheduled_time) {
        const time = doc.createElement('span');
        time.className = 'wg-workouts-groups-row__time';
        time.textContent = group.scheduled_time;
        meta.appendChild(time);
    }

    if (Number.isFinite(Number(group.exercises_count))) {
        const count = doc.createElement('span');
        count.className = 'wg-workouts-groups-row__count';
        const n = Number(group.exercises_count);
        count.textContent = `${n} exercise${n === 1 ? '' : 's'}`;
        meta.appendChild(count);
    }

    if (group.is_rotating) {
        const rot = doc.createElement('span');
        rot.className = 'wg-tag wg-tag--mono wg-tag--normal wg-workouts-groups-row__rotating';
        rot.textContent = 'Rotating';
        meta.appendChild(rot);
    }

    if (!group.active) {
        const inactive = doc.createElement('span');
        inactive.className = 'wg-tag wg-tag--mono wg-tag--skipped wg-workouts-groups-row__inactive';
        inactive.textContent = 'Inactive';
        meta.appendChild(inactive);
    }

    if (meta.childNodes.length > 0) body.appendChild(meta);

    card.appendChild(body);

    const actions = doc.createElement('div');
    actions.className = 'wg-workouts-groups-row__actions';
    actions.appendChild(_buildGroupsIconBtn(doc, 'edit', 'Edit group', 'pencil', () => {
        showEditWorkoutGroupModal(group.id);
    }));
    actions.appendChild(_buildGroupsIconBtn(doc, 'delete', 'Delete group', 'trash', (event) => {
        deleteWorkoutGroup(group.id, event);
    }));
    card.appendChild(actions);

    card.addEventListener('click', (e) => {
        if (e.target.closest('.wg-workouts-groups-row__actions')) return;
        showEditWorkoutGroupModal(group.id);
    });

    return card;
}

function _buildGroupsIconBtn(doc, kind, ariaLabel, iconName, handler) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = `wg-icon-btn wg-workouts-groups-row__${kind}`;
    btn.setAttribute('aria-label', ariaLabel);
    const gloss = doc.createElement('span');
    gloss.className = 'wg-gloss';
    if (typeof window !== 'undefined' && window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
        gloss.appendChild(window.WGIcons.iconSvg(iconName, { size: 16 }));
    }
    btn.appendChild(gloss);
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handler(e);
    });
    return btn;
}

function setFlatExercisesPendingSaveMessage() {
    const container = document.getElementById('workout-group-flat-exercises-list');
    if (!container) return;
    const message = document.createElement('p');
    message.className = 'workout-pending-msg';
    message.textContent = 'Save this group first to add exercises.';
    container.replaceChildren(message);
}

// ====================================
// WORKOUT GROUP MODAL
// ====================================

function showAddWorkoutGroupModal() {
    currentEditingGroupId = null;
    currentGroupForVariant = null;
    currentVariantForExercise = null;
    document.getElementById('workout-group-modal-title').textContent = 'Add Workout Group';
    window.ModalManager.workoutGroup.open();

    // Reset fields
    document.getElementById('workout-group-name').value = '';
    document.getElementById('workout-group-description').value = '';
    document.getElementById('workout-group-rotating').checked = false;
    document.getElementById('workout-group-time').value = '09:00';
    document.getElementById('workout-group-notification').value = '15';
    document.getElementById('workout-group-active').checked = true;

    // Clear days
    document.querySelectorAll('#workout-group-modal .days-select span').forEach(s => s.classList.remove('selected'));

    // Show/hide sections based on default "Rotating" state (unchecked)
    document.getElementById('workout-variants-section').style.display = 'none';
    document.getElementById('workout-group-flat-exercises-section').style.display = 'block';
    setFlatExercisesPendingSaveMessage();
}

async function showEditWorkoutGroupModal(groupId) {
    currentEditingGroupId = groupId;
    currentGroupForVariant = groupId;
    currentVariantForExercise = null;
    const group = workoutGroups.find(g => g.id === groupId);
    if (!group) return;

    document.getElementById('workout-group-modal-title').textContent = 'Edit Workout Group';
    window.ModalManager.workoutGroup.open();

    // Fill fields
    document.getElementById('workout-group-name').value = group.name;
    document.getElementById('workout-group-description').value = group.description || '';
    document.getElementById('workout-group-rotating').checked = group.is_rotating;
    document.getElementById('workout-group-time').value = group.scheduled_time;
    document.getElementById('workout-group-notification').value = group.notification_advance_minutes;
    document.getElementById('workout-group-active').checked = group.active;

    // Set days
    const daysArray = JSON.parse(group.days_of_week || '[]');
    document.querySelectorAll('#workout-group-modal .days-select span').forEach(s => {
        const day = parseInt(s.dataset.day);
        if (daysArray.includes(day)) {
            s.classList.add('selected');
        } else {
            s.classList.remove('selected');
        }
    });

    // Show variants or flat exercises based on rotation
    if (group.is_rotating) {
        document.getElementById('workout-variants-section').style.display = 'block';
        document.getElementById('workout-group-flat-exercises-section').style.display = 'none';
        await loadVariantsForGroup(groupId);
    } else {
        document.getElementById('workout-variants-section').style.display = 'none';
        document.getElementById('workout-group-flat-exercises-section').style.display = 'block';

        // Fetch variants. If none exists, create a default one for non-rotating groups.
        let variants = await apiCall(`/api/workout/variants?group_id=${groupId}`);
        if (!variants || variants.length === 0) {
            const newVariant = await apiCall('/api/workout/variants/create', 'POST', {
                group_id: groupId,
                name: 'Main',
                rotation_order: null,
                description: ''
            });
            variants = newVariant ? [newVariant] : [];
        }

        if (variants.length === 0) {
            setFlatExercisesPendingSaveMessage();
            return;
        }

        const defaultVariantId = variants[0].id;
        currentGroupForVariant = groupId;
        currentVariantForExercise = defaultVariantId;
        await loadExercisesForVariant(defaultVariantId, 'workout-group-flat-exercises-list');
    }
}

function closeWorkoutGroupModal() {
    window.ModalManager.workoutGroup.close();
    currentEditingGroupId = null;
    currentGroupForVariant = null;
    currentVariantForExercise = null;
}

async function toggleRotatingFields() {
    const isRotating = document.getElementById('workout-group-rotating').checked;
    if (isRotating) {
        document.getElementById('workout-variants-section').style.display = 'block';
        document.getElementById('workout-group-flat-exercises-section').style.display = 'none';
        if (currentEditingGroupId) {
            await loadVariantsForGroup(currentEditingGroupId);
        }
    } else {
        document.getElementById('workout-variants-section').style.display = 'none';
        document.getElementById('workout-group-flat-exercises-section').style.display = 'block';
        if (currentEditingGroupId) {
            // Re-run the logic to fetch/create default variant and load exercises
            let variants = await apiCall(`/api/workout/variants?group_id=${currentEditingGroupId}`);
            if (!variants || variants.length === 0) {
                const newVariant = await apiCall('/api/workout/variants/create', 'POST', {
                    group_id: currentEditingGroupId,
                    name: 'Main',
                    rotation_order: null,
                    description: ''
                });
                variants = newVariant ? [newVariant] : [];
            }
            if (variants.length === 0) {
                setFlatExercisesPendingSaveMessage();
                return;
            }
            const defaultVariantId = variants[0].id;
            currentGroupForVariant = currentEditingGroupId;
            currentVariantForExercise = defaultVariantId;
            await loadExercisesForVariant(defaultVariantId, 'workout-group-flat-exercises-list');
        } else {
            // New group, just show message
            setFlatExercisesPendingSaveMessage();
        }
    }
}

function toggleWorkoutDay(el) {
    el.classList.toggle('selected');
}

async function saveWorkoutGroup() {
    const name = document.getElementById('workout-group-name').value.trim();
    const description = document.getElementById('workout-group-description').value.trim();
    const isRotating = document.getElementById('workout-group-rotating').checked;
    const time = document.getElementById('workout-group-time').value;
    const notification = parseInt(document.getElementById('workout-group-notification').value);
    const active = document.getElementById('workout-group-active').checked;

    if (!name) {
        safeAlert('Group name is required!');
        return;
    }

    if (!time) {
        safeAlert('Scheduled time is required!');
        return;
    }

    const days = Array.from(document.querySelectorAll('#workout-group-modal .days-select span.selected'))
        .map(s => parseInt(s.dataset.day));


    const payload = {
        name,
        description,
        is_rotating: isRotating,
        days_of_week: JSON.stringify(days),
        scheduled_time: time,
        notification_advance_minutes: notification
    };

    let result;
    if (currentEditingGroupId) {
        // Update
        payload.active = active;
        result = await apiCall(`/api/workout/groups/update?id=${currentEditingGroupId}`, 'PUT', payload);
    } else {
        // Create
        result = await apiCall('/api/workout/groups/create', 'POST', payload);
    }

    if (result || result === true) {
        closeWorkoutGroupModal();
        loadWorkoutGroups();
    }
}

async function deleteWorkoutGroup(groupId, event) {
    event.stopPropagation();

    await safeConfirm('Delete this workout group?', async (ok) => {
        if (ok) {
            await _deleteWorkoutGroupApi(groupId);
        }
    });
}

async function _deleteWorkoutGroupApi(groupId) {
    const result = await apiCall(`/api/workout/groups/delete?id=${groupId}`, 'DELETE');
    if (result || result === true) {
        loadWorkoutGroups();
    }
}

// ====================================
// VARIANTS
// ====================================

async function loadVariantsForGroup(groupId) {
    currentGroupForVariant = groupId;
    const container = document.getElementById('workout-variants-list');

    try {
        const variants = await apiCall(`/api/workout/variants?group_id=${groupId}`);

        if (!variants || variants.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'workout-pending-msg';
            empty.textContent = 'No variants yet. Add one to get started!';
            container.replaceChildren(empty);
            return;
        }

        container.replaceChildren();
        variants.forEach((variant) => {
            const rotationText = variant.rotation_order !== null ? ` (Order: ${variant.rotation_order})` : '';

            const card = document.createElement('div');
            card.className = 'workout-variant-card';

            const info = document.createElement('div');
            info.className = 'cursor-pointer flex-1';
            info.addEventListener('click', () => {
                showEditVariantModal(variant.id);
            });

            const nameStrong = document.createElement('strong');
            nameStrong.textContent = variant.name;
            info.appendChild(nameStrong);
            if (rotationText) {
                info.appendChild(document.createTextNode(rotationText));
            }

            if (variant.description) {
                const description = document.createElement('div');
                description.className = 'workout-variant-desc';
                description.textContent = variant.description;
                info.appendChild(description);
            }

            const deleteBtn = createDeleteButton((event) => {
                deleteVariant(variant.id, event);
            });
            deleteBtn.classList.add('workout-delete-btn-inline');

            card.appendChild(info);
            card.appendChild(deleteBtn);
            container.appendChild(card);
        });
    } catch (error) {
        console.error('Error loading variants:', error);
        const message = document.createElement('p');
        message.className = 'text-danger';
        message.textContent = 'Error loading variants';
        container.replaceChildren(message);
    }
}

function showAddVariantModal() {
    const groupId = currentGroupForVariant || currentEditingGroupId;
    if (!groupId) {
        safeAlert('Save this workout group first to add variants.');
        return;
    }

    currentGroupForVariant = groupId;

    currentEditingVariantId = null;
    document.getElementById('workout-variant-modal-title').textContent = 'Add Variant';
    window.ModalManager.workoutVariant.open();

    document.getElementById('workout-variant-name').value = '';
    document.getElementById('workout-variant-description').value = '';
    document.getElementById('workout-variant-rotation').value = '';

    // Show/hide rotation field based on group
    const group = workoutGroups.find(g => g.id === currentGroupForVariant);
    if (group && group.is_rotating) {
        document.getElementById('workout-variant-rotation-field').style.display = 'block';
    } else {
        document.getElementById('workout-variant-rotation-field').style.display = 'none';
    }

    document.getElementById('workout-exercises-section').style.display = 'none';
}

async function showEditVariantModal(variantId) {
    currentEditingVariantId = variantId;

    const variants = await apiCall(`/api/workout/variants?group_id=${currentGroupForVariant}`);
    const variant = variants.find(v => v.id === variantId);
    if (!variant) return;

    document.getElementById('workout-variant-modal-title').textContent = 'Edit Variant';
    window.ModalManager.workoutVariant.open();

    document.getElementById('workout-variant-name').value = variant.name;
    document.getElementById('workout-variant-description').value = variant.description || '';
    document.getElementById('workout-variant-rotation').value = variant.rotation_order !== null ? variant.rotation_order : '';

    const group = workoutGroups.find(g => g.id === currentGroupForVariant);
    if (group && group.is_rotating) {
        document.getElementById('workout-variant-rotation-field').style.display = 'block';
    } else {
        document.getElementById('workout-variant-rotation-field').style.display = 'none';
    }

    document.getElementById('workout-exercises-section').style.display = 'block';
    await loadExercisesForVariant(variantId);
}

function closeVariantModal() {
    window.ModalManager.workoutVariant.close();
    currentEditingVariantId = null;
}

async function saveVariant() {
    const name = document.getElementById('workout-variant-name').value.trim();
    const description = document.getElementById('workout-variant-description').value.trim();
    const rotationRaw = document.getElementById('workout-variant-rotation').value;
    const rotation = rotationRaw !== '' ? parseInt(rotationRaw) : null;

    if (!name) {
        safeAlert('Variant name is required!');
        return;
    }

    const payload = {
        group_id: currentGroupForVariant,
        name,
        rotation_order: rotation,
        description
    };

    let result;
    if (currentEditingVariantId) {
        // Update
        result = await apiCall(`/api/workout/variants/update?id=${currentEditingVariantId}`, 'PUT', payload);
    } else {
        result = await apiCall('/api/workout/variants/create', 'POST', payload);
    }

    if (result || result === true) {
        closeVariantModal();
        loadVariantsForGroup(currentGroupForVariant);
    }
}

async function deleteVariant(variantId, event) {
    event.stopPropagation();
    await safeConfirm('Delete this variant and all its exercises?', async (ok) => {
        if (ok) {
            await _deleteVariantApi(variantId);
        }
    });
}

async function _deleteVariantApi(variantId) {
    const result = await apiCall(`/api/workout/variants/delete?id=${variantId}`, 'DELETE');
    if (result || result === true) {
        loadVariantsForGroup(currentGroupForVariant);
    }
}

// ====================================
// EXERCISES
// ====================================

let currentExercisesContainerId = 'workout-exercises-list';

async function loadExercisesForVariant(variantId, containerId = 'workout-exercises-list') {
    currentVariantForExercise = variantId;
    currentExercisesContainerId = containerId;
    const container = document.getElementById(containerId);

    try {
        const exercises = await apiCall(`/api/workout/exercises?variant_id=${variantId}`);

        if (!exercises || exercises.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'workout-pending-msg';
            empty.textContent = 'No exercises yet. Add one!';
            container.replaceChildren(empty);
            return;
        }

        // Sort by order
        const sortedExercises = [...exercises].sort((a, b) => a.order_index - b.order_index);
        container.replaceChildren();
        sortedExercises.forEach((ex) => {
            const repsText = ex.target_reps_max
                ? `${ex.target_reps_min}-${ex.target_reps_max}`
                : `${ex.target_reps_min}`;
            const weightText = ex.target_weight_kg ? ` @ ${ex.target_weight_kg}kg` : '';

            const card = document.createElement('div');
            card.className = 'workout-exercise-card';

            const info = document.createElement('div');
            info.className = 'cursor-pointer flex-1';
            info.addEventListener('click', () => {
                showEditExerciseModal(ex.id);
            });

            const title = document.createElement('strong');
            title.textContent = `${ex.order_index + 1}. ${ex.exercise_name}`;

            const meta = document.createElement('div');
            meta.className = 'workout-exercise-meta';
            meta.textContent = `${ex.target_sets} sets × ${repsText} reps${weightText}`;

            info.appendChild(title);
            info.appendChild(meta);

            const deleteBtn = createDeleteButton((event) => {
                deleteExercise(ex.id, event);
            });
            deleteBtn.classList.add('workout-delete-btn-inline');

            card.appendChild(info);
            card.appendChild(deleteBtn);
            container.appendChild(card);
        });
    } catch (error) {
        console.error('Error loading exercises:', error);
        const message = document.createElement('p');
        message.className = 'text-danger';
        message.textContent = 'Error loading exercises';
        container.replaceChildren(message);
    }
}

async function resolveVariantForExercise() {
    if (currentVariantForExercise) return true;

    const groupId = currentGroupForVariant || currentEditingGroupId;
    if (!groupId) {
        safeAlert('Save this workout group first to add exercises.');
        return false;
    }

    const group = workoutGroups.find(g => g.id === groupId);
    if (group && group.is_rotating) {
        safeAlert('Open a variant first to add exercises.');
        return false;
    }

    try {
        let variants = await apiCall(`/api/workout/variants?group_id=${groupId}`);
        if (!variants || variants.length === 0) {
            const createdVariant = await apiCall('/api/workout/variants/create', 'POST', {
                group_id: groupId,
                name: 'Main',
                rotation_order: null,
                description: ''
            });
            variants = createdVariant ? [createdVariant] : [];
        }

        const variantId = variants[0]?.id;
        if (!variantId) {
            safeAlert('Save this workout group first to add exercises.');
            return false;
        }

        currentGroupForVariant = groupId;
        currentVariantForExercise = variantId;
        return true;
    } catch (error) {
        console.error('Failed to resolve variant for exercise modal:', error);
        safeAlert('Failed to prepare exercise editor. Please try again.');
        return false;
    }
}

async function showAddExerciseModal() {
    const canOpen = await resolveVariantForExercise();
    if (!canOpen) return;

    currentEditingExerciseId = null;
    document.getElementById('workout-exercise-modal-title').textContent = 'Add Exercise';
    window.ModalManager.workoutExercise.open();

    document.getElementById('workout-exercise-name').value = '';
    document.getElementById('workout-exercise-sets').value = '';
    document.getElementById('workout-exercise-reps-min').value = '';
    document.getElementById('workout-exercise-reps-max').value = '';
    document.getElementById('workout-exercise-weight').value = '';
    document.getElementById('workout-exercise-order').value = '0';

    // Load exercise library for autocomplete
    let datalist = document.getElementById('exercise-library-datalist');
    if (!datalist) {
        datalist = document.createElement('datalist');
        datalist.id = 'exercise-library-datalist';
        document.body.appendChild(datalist);
        document.getElementById('workout-exercise-name').setAttribute('list', 'exercise-library-datalist');
    }
    datalist.replaceChildren();

    try {
        const items = await apiCall('/api/workout/exercise-library');
        if (items && items.length > 0) {
            items.forEach(item => {
                const option = document.createElement('option');
                option.value = item.name;
                option.dataset.sets = item.default_sets || '';
                option.dataset.repsMin = item.default_reps_min || '';
                option.dataset.repsMax = item.default_reps_max || '';
                option.dataset.weight = item.default_weight_kg || '';
                datalist.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error loading exercise library for autocomplete:', error);
    }

    // Add change handler to pre-fill defaults from library
    const nameInput = document.getElementById('workout-exercise-name');
    nameInput.onchange = function () {
        const option = Array.from(datalist.options).find(o => o.value === nameInput.value);
        if (option) {
            if (!document.getElementById('workout-exercise-sets').value && option.dataset.sets)
                document.getElementById('workout-exercise-sets').value = option.dataset.sets;
            if (!document.getElementById('workout-exercise-reps-min').value && option.dataset.repsMin)
                document.getElementById('workout-exercise-reps-min').value = option.dataset.repsMin;
            if (!document.getElementById('workout-exercise-reps-max').value && option.dataset.repsMax)
                document.getElementById('workout-exercise-reps-max').value = option.dataset.repsMax;
            if (!document.getElementById('workout-exercise-weight').value && option.dataset.weight)
                document.getElementById('workout-exercise-weight').value = option.dataset.weight;
        }
    };
}

async function showAddExerciseModalFromGroup() {
    // It's the same modal, we just use the default variant already set in currentVariantForExercise
    await showAddExerciseModal();
}

async function showEditExerciseModal(exerciseId) {
    currentEditingExerciseId = exerciseId;

    const exercises = await apiCall(`/api/workout/exercises?variant_id=${currentVariantForExercise}`);
    const exercise = exercises.find(e => e.id === exerciseId);
    if (!exercise) return;

    document.getElementById('workout-exercise-modal-title').textContent = 'Edit Exercise';
    window.ModalManager.workoutExercise.open();

    document.getElementById('workout-exercise-name').value = exercise.exercise_name;
    document.getElementById('workout-exercise-sets').value = exercise.target_sets;
    document.getElementById('workout-exercise-reps-min').value = exercise.target_reps_min;
    document.getElementById('workout-exercise-reps-max').value = exercise.target_reps_max || '';
    document.getElementById('workout-exercise-weight').value = exercise.target_weight_kg || '';
    document.getElementById('workout-exercise-order').value = exercise.order_index;
}

function closeExerciseModal() {
    window.ModalManager.workoutExercise.close();
    currentEditingExerciseId = null;
}

async function saveExercise() {
    const name = document.getElementById('workout-exercise-name').value.trim();
    const sets = parseInt(document.getElementById('workout-exercise-sets').value);
    const repsMin = parseInt(document.getElementById('workout-exercise-reps-min').value);
    const repsMaxRaw = document.getElementById('workout-exercise-reps-max').value;
    const repsMax = repsMaxRaw !== '' ? parseInt(repsMaxRaw) : null;
    const weightRaw = document.getElementById('workout-exercise-weight').value;
    const weight = weightRaw !== '' ? parseFloat(weightRaw) : null;
    const order = parseInt(document.getElementById('workout-exercise-order').value) || 0;

    if (!name || !sets || !repsMin) {
        safeAlert('Exercise name, sets, and reps min are required!');
        return;
    }

    const payload = {
        variant_id: currentVariantForExercise,
        exercise_name: name,
        target_sets: sets,
        target_reps_min: repsMin,
        target_reps_max: repsMax,
        target_weight_kg: weight,
        order_index: order
    };

    let result;
    if (currentEditingExerciseId) {
        result = await apiCall(`/api/workout/exercises/update?id=${currentEditingExerciseId}`, 'PUT', payload);
    } else {
        result = await apiCall('/api/workout/exercises/create', 'POST', payload);
    }

    if (result || result === true) {
        closeExerciseModal();
        loadExercisesForVariant(currentVariantForExercise, currentExercisesContainerId);
    }
}

async function deleteExercise(exerciseId, event) {
    event.stopPropagation();
    await safeConfirm('Delete this exercise?', async (ok) => {
        if (ok) {
            await _deleteExerciseApi(exerciseId);
        }
    });
}

async function _deleteExerciseApi(id) {
    const result = await apiCall(`/api/workout/exercises/delete?id=${id}`, 'DELETE');
    if (result || result === true) {
        loadExercisesForVariant(currentVariantForExercise, currentExercisesContainerId);
    }
}

// ====================================
// EXERCISE LIBRARY
// ====================================

let currentEditingLibraryItemId = null;

async function loadExerciseLibrary() {
    const container = document.getElementById('exercise-library-list');
    await window.DataStore.loadSWR({
        key: 'exercise_library',
        tags: ['exercise_library'],
        fetcher: async () => await apiCall('/api/workout/exercise-library'),
        onCached: async (cached) => {
            _renderExerciseLibrary(container, cached);
        },
        onFresh: async (fresh) => {
            _renderExerciseLibrary(container, fresh);
        },
        onError: async (error, cached) => {
            console.error('Error loading exercise library:', error);
            if (!cached) {
                const message = document.createElement('p');
                message.className = 'text-hint';
                message.textContent = 'No cached data \u2014 will load when online';
                container.replaceChildren(message);
            }
        }
    });
}

function _renderExerciseLibrary(container, items) {
    if (!container) return;
    const doc = container.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function') return;

    container.classList.add('wg-workouts-exercises');

    if (!items || items.length === 0) {
        const empty = doc.createElement('p');
        empty.className = 'wg-workouts-exercises__empty';
        empty.textContent = 'No exercises in library yet \u2014 tap Add to create one.';
        container.replaceChildren(empty);
        return;
    }

    const list = doc.createElement('ul');
    list.className = 'list-reset wg-workouts-exercises__list';

    items.forEach((item) => {
        list.appendChild(_buildExerciseLibraryRow(doc, item));
    });

    container.replaceChildren(list);
}

function _buildExerciseLibraryRow(doc, item) {
    const slot = getRotationSlot(item.name || '');
    const slotMod = _slotTagModifier(slot);

    const card = doc.createElement('li');
    card.className = 'wg-card wg-workouts-exercises-row';
    card.dataset.exerciseId = String(item.id || '');
    card.dataset.slot = slot;

    const body = doc.createElement('div');
    body.className = 'wg-workouts-exercises-row__body';

    const title = doc.createElement('div');
    title.className = 'wg-workouts-exercises-row__title';

    const slotTag = doc.createElement('span');
    slotTag.className = `wg-tag wg-tag--mono wg-workouts-slot-tag wg-workouts-slot-tag--${slotMod} wg-workouts-exercises-row__slot`;
    slotTag.textContent = slot;
    title.appendChild(slotTag);

    const name = doc.createElement('span');
    name.className = 'wg-workouts-exercises-row__name';
    name.textContent = item.name || 'Exercise';
    title.appendChild(name);

    body.appendChild(title);

    const meta = doc.createElement('div');
    meta.className = 'wg-workouts-exercises-row__meta';

    const setsCount = Number(item.default_sets) || 0;
    const repsMin = Number(item.default_reps_min) || 0;
    const repsMax = Number(item.default_reps_max) || 0;
    const repsStr = repsMax ? `${repsMin}-${repsMax}` : `${repsMin}`;
    if (setsCount > 0 || repsMin > 0) {
        const defaults = doc.createElement('span');
        defaults.className = 'wg-workouts-exercises-row__defaults';
        defaults.textContent = `${setsCount}×${repsStr}`;
        meta.appendChild(defaults);
    }

    if (Number.isFinite(Number(item.default_weight_kg)) && Number(item.default_weight_kg) > 0) {
        const weight = doc.createElement('span');
        weight.className = 'wg-workouts-exercises-row__weight';
        weight.textContent = `${Number(item.default_weight_kg)}kg`;
        meta.appendChild(weight);
    }

    if (item.notes) {
        const notes = doc.createElement('span');
        notes.className = 'wg-workouts-exercises-row__notes';
        notes.textContent = item.notes;
        meta.appendChild(notes);
    }

    if (meta.childNodes.length > 0) body.appendChild(meta);

    card.appendChild(body);

    const actions = doc.createElement('div');
    actions.className = 'wg-workouts-exercises-row__actions';
    actions.appendChild(_buildExercisesIconBtn(doc, 'edit', 'Edit exercise', 'pencil', () => {
        showEditExerciseLibraryModal(item.id);
    }));
    actions.appendChild(_buildExercisesIconBtn(doc, 'delete', 'Delete exercise', 'trash', (event) => {
        deleteExerciseLibraryItem(item.id, event);
    }));
    card.appendChild(actions);

    card.addEventListener('click', (e) => {
        if (e.target.closest('.wg-workouts-exercises-row__actions')) return;
        showEditExerciseLibraryModal(item.id);
    });

    return card;
}

function _buildExercisesIconBtn(doc, kind, ariaLabel, iconName, handler) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = `wg-icon-btn wg-workouts-exercises-row__${kind}`;
    btn.setAttribute('aria-label', ariaLabel);
    const gloss = doc.createElement('span');
    gloss.className = 'wg-gloss';
    if (typeof window !== 'undefined' && window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
        gloss.appendChild(window.WGIcons.iconSvg(iconName, { size: 16 }));
    }
    btn.appendChild(gloss);
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handler(e);
    });
    return btn;
}

function showExerciseLibraryModal(id) {
    currentEditingLibraryItemId = null;
    document.getElementById('exercise-library-modal-title').textContent = 'Add Exercise';
    window.ModalManager.exerciseLibrary.open();

    document.getElementById('exercise-library-name').value = '';
    document.getElementById('exercise-library-sets').value = '';
    document.getElementById('exercise-library-reps-min').value = '';
    document.getElementById('exercise-library-reps-max').value = '';
    document.getElementById('exercise-library-weight').value = '';
    document.getElementById('exercise-library-notes').value = '';
}

async function showEditExerciseLibraryModal(id) {
    const items = await apiCall('/api/workout/exercise-library');
    const item = items && items.find(i => i.id === id);
    if (!item) return;

    currentEditingLibraryItemId = id;
    document.getElementById('exercise-library-modal-title').textContent = 'Edit Exercise';
    window.ModalManager.exerciseLibrary.open();

    document.getElementById('exercise-library-name').value = item.name;
    document.getElementById('exercise-library-sets').value = item.default_sets || '';
    document.getElementById('exercise-library-reps-min').value = item.default_reps_min || '';
    document.getElementById('exercise-library-reps-max').value = item.default_reps_max || '';
    document.getElementById('exercise-library-weight').value = item.default_weight_kg || '';
    document.getElementById('exercise-library-notes').value = item.notes || '';
}

function closeExerciseLibraryModal() {
    window.ModalManager.exerciseLibrary.close();
    currentEditingLibraryItemId = null;
}

async function saveExerciseLibraryItem() {
    const name = document.getElementById('exercise-library-name').value.trim();
    const sets = parseInt(document.getElementById('exercise-library-sets').value) || 0;
    const repsMin = parseInt(document.getElementById('exercise-library-reps-min').value) || 0;
    const repsMaxRaw = document.getElementById('exercise-library-reps-max').value;
    const repsMax = repsMaxRaw !== '' ? parseInt(repsMaxRaw) : null;
    const weightRaw = document.getElementById('exercise-library-weight').value;
    const weight = weightRaw !== '' ? parseFloat(weightRaw) : null;
    const notes = document.getElementById('exercise-library-notes').value.trim();

    if (!name) {
        safeAlert('Exercise name is required!');
        return;
    }

    const payload = {
        name: name,
        default_sets: sets,
        default_reps_min: repsMin,
        default_reps_max: repsMax,
        default_weight_kg: weight,
        notes: notes
    };

    let result;
    if (currentEditingLibraryItemId) {
        result = await apiCall(`/api/workout/exercise-library/update?id=${currentEditingLibraryItemId}`, 'PUT', payload);
    } else {
        result = await apiCall('/api/workout/exercise-library/create', 'POST', payload);
    }

    if (result || result === true) {
        closeExerciseLibraryModal();
        loadExerciseLibrary();
    }
}

async function deleteExerciseLibraryItem(id, event) {
    event?.stopPropagation?.();
    await safeConfirm('Delete this exercise from library?', async (ok) => {
        if (ok) {
            await _deleteExerciseLibraryApi(id);
        }
    });
}

async function _deleteExerciseLibraryApi(id) {
    const result = await apiCall(`/api/workout/exercise-library/delete?id=${id}`, 'DELETE');
    if (result || result === true) {
        loadExerciseLibrary();
    }
}

// ====================================
// HISTORY & STATS TABS
// ====================================

async function loadWorkoutHistoryTab() {
    const container = document.getElementById('workout-history-display');
    try {
        // Fetch both manual sessions and Mi Band outdoor workouts in parallel.
        // Also read the cached settings_bundle to get the user's saved timezone so that
        // skipped-session sort timestamps are interpreted in the same timezone the backend
        // used when scheduling, not the browser's local timezone.
        const cachedBundle = window.DataStore
            ? await window.DataStore.getCached('settings_bundle').catch(() => null)
            : null;
        let userTz = cachedBundle?.timezone || '';
        // If the bundle was cleared by a tag invalidation (e.g. after /tz change),
        // fall back to a direct settings fetch so the correct timezone is used.
        if (!userTz) {
            const fresh = await apiCall('/api/settings', 'GET').catch(() => null);
            if (fresh?.timezone) userTz = fresh.timezone;
        }
        const [sessionsResp, mibandResp] = await Promise.all([
            apiCall('/api/workout/sessions?limit=50').catch(() => []),
            apiCall('/api/workout/miband?limit=100').catch(() => [])
        ]);
        _renderWorkoutHistory(container, sessionsResp || [], mibandResp || [], userTz);
    } catch (error) {
        console.error('Error loading workout history:', error);
        const message = document.createElement('p');
        message.className = 'text-danger';
        message.textContent = 'Error loading history';
        container.replaceChildren(message);
    }
}

// Maps Mi Band activity_name → display label + icon
const MIBAND_ACTIVITY_META = {
    'nordic_walking': { label: 'Nordic Walking', icon: '🏔️' },
    'cycling': { label: 'Cycling', icon: '🚴' },
    'walking': { label: 'Walking', icon: '🚶' },
    'running': { label: 'Running', icon: '🏃' },
};

function _formatDuration(sec) {
    if (!sec || sec <= 0) return '—';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return `${h}h ${m}min`;
    return `${m}min`;
}

// Convert a naive local datetime (dateStr "YYYY-MM-DD", timeStr "HH:MM") in a named
// timezone to a UTC millisecond timestamp.  Falls back to browser-local interpretation
// when tzName is empty or unrecognised.
function _naiveDatetimeToUTCMs(dateStr, timeStr, tzName) {
    const naiveUTCMs = Date.parse(`${dateStr}T${timeStr}:00Z`); // treat as UTC for TZ math
    if (!tzName) return new Date(`${dateStr}T${timeStr}:00`).getTime(); // browser-local fallback
    try {
        // Find what local time the naive-UTC instant corresponds to in tzName, then
        // compute the difference and apply it to get the true UTC ms.
        const approxDate = new Date(naiveUTCMs);
        // 'sv' locale produces "YYYY-MM-DD HH:MM:SS" — easy to re-parse as UTC.
        const localStr = approxDate.toLocaleString('sv', { timeZone: tzName }).replace(' ', 'T');
        const diff = naiveUTCMs - Date.parse(localStr + 'Z');
        return naiveUTCMs + diff;
    } catch (_) {
        return naiveUTCMs; // fall back to UTC on error
    }
}

function _renderWorkoutHistory(container, sessions, mibandWorkouts, userTz) {
    // Build unified list sorted by date DESC
    const items = [];

    // Manual strength sessions
    const finalSessions = (sessions || []).filter(s =>
        s.session.status === 'completed' || s.session.status === 'skipped'
    );
    finalSessions.forEach(s => {
        let ts;
        if (s.session.started_at) {
            ts = new Date(s.session.started_at).getTime();
        } else {
            // Skipped sessions have no started_at; interpret the scheduled time in the
            // user's saved timezone (same as the backend uses) so that sort order is
            // consistent with Mi Band entries that carry absolute UTC timestamps.
            const dateStr = s.session.scheduled_date.split('T')[0];
            const timeStr = s.session.scheduled_time || '00:00';
            ts = _naiveDatetimeToUTCMs(dateStr, timeStr, userTz || '');
        }
        items.push({ type: 'session', ts: ts, data: s });
    });

    // Mi Band outdoor workouts
    (mibandWorkouts || []).forEach(w => {
        items.push({ type: 'miband', ts: new Date(w.start_time).getTime(), data: w });
    });

    // Sort newest first
    items.sort((a, b) => b.ts - a.ts);

    container.replaceChildren();
    container.classList.add('wg-workouts-history');

    if (items.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'wg-workouts-history__empty';
        empty.textContent = 'No workout history yet';
        container.appendChild(empty);
        return;
    }

    // Group by local day for section-labeled clusters (mirrors Phase 6 weight
    // history pattern). Use the user's stored timezone so day boundaries line
    // up with the backend-interpreted scheduled times of skipped sessions.
    const groups = _groupWorkoutHistoryByDay(items, userTz);
    const list = document.createElement('ul');
    list.className = 'list-reset wg-workouts-history__list';
    groups.forEach((group) => {
        list.appendChild(_buildWorkoutHistoryGroup(group));
    });
    container.appendChild(list);
}

function _groupWorkoutHistoryByDay(items, userTz) {
    // Compute day keys in the user's stored timezone so section headers agree
    // with the backend-scheduled day for skipped sessions (see
    // _naiveDatetimeToUTCMs above). Falls back to browser local when tzName is
    // empty/unrecognised.
    const tzName = userTz || undefined;
    let keyFmt;
    let labelFmt;
    try {
        keyFmt = new Intl.DateTimeFormat('en-CA', {
            timeZone: tzName,
            year: 'numeric', month: '2-digit', day: '2-digit'
        });
        labelFmt = new Intl.DateTimeFormat(undefined, {
            timeZone: tzName,
            day: '2-digit', month: '2-digit', year: 'numeric'
        });
    } catch (_) {
        keyFmt = new Intl.DateTimeFormat('en-CA', {
            year: 'numeric', month: '2-digit', day: '2-digit'
        });
        labelFmt = new Intl.DateTimeFormat(undefined, {
            day: '2-digit', month: '2-digit', year: 'numeric'
        });
    }

    const now = new Date();
    const todayKey = keyFmt.format(now);
    // Decrement via UTC calendar arithmetic so DST transitions (23h/25h
    // local days) don't shift yesterdayKey to the wrong calendar date.
    const [ty, tm, td] = todayKey.split('-').map(Number);
    const yUTC = new Date(Date.UTC(ty, tm - 1, td) - 86400000);
    const yesterdayKey = `${yUTC.getUTCFullYear()}-${String(yUTC.getUTCMonth() + 1).padStart(2, '0')}-${String(yUTC.getUTCDate()).padStart(2, '0')}`;

    const buckets = new Map();
    items.forEach((item) => {
        const d = new Date(item.ts);
        if (!Number.isFinite(d.getTime())) return;
        const dayKey = keyFmt.format(d);

        let key;
        let label;
        if (dayKey === todayKey) { key = 'today'; label = 'Today'; }
        else if (dayKey === yesterdayKey) { key = 'yesterday'; label = 'Yesterday'; }
        else {
            key = dayKey;
            label = labelFmt.format(d);
        }
        // Sort-key uses the ISO-like key so chronological ordering stays
        // correct even when the browser's timezone differs from userTz.
        const sortKey = Date.parse(dayKey + 'T00:00:00Z');
        if (!buckets.has(key)) buckets.set(key, { label, sortKey, items: [] });
        buckets.get(key).items.push(item);
    });
    return Array.from(buckets.values()).sort((a, b) => b.sortKey - a.sortKey);
}

function _buildWorkoutHistoryGroup(group) {
    const groupItem = document.createElement('li');
    groupItem.className = 'wg-workouts-history__group';

    const header = document.createElement('div');
    header.className = 'wg-section-label wg-workouts-history__group-label';
    const headerText = document.createElement('span');
    headerText.textContent = group.label;
    header.appendChild(headerText);
    groupItem.appendChild(header);

    const rowList = document.createElement('ul');
    rowList.className = 'list-reset wg-workouts-history__rows';
    group.items.forEach((entry) => {
        const row = entry.type === 'session'
            ? _buildSessionCard(entry.data)
            : _buildMiBandCard(entry.data);
        rowList.appendChild(row);
    });
    groupItem.appendChild(rowList);
    return groupItem;
}

function _formatHistoryDuration(minutes) {
    const m = Math.max(0, Math.round(Number(minutes) || 0));
    if (m <= 0) return '—';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

function _buildSessionCard(s) {
    const session = s.session || {};
    const slot = getRotationSlot(s.variant_name || '');
    const slotMod = _slotTagModifier(slot);

    const card = document.createElement('li');
    card.className = 'wg-card wg-workouts-history-row';
    card.classList.add(`wg-workouts-history-row--${session.status || 'unknown'}`);
    if (s.isLocal) card.classList.add('wg-workouts-history-row--pending');
    if (s.isRejected) card.classList.add('wg-workouts-history-row--rejected');
    card.dataset.sessionId = String(session.id || '');
    card.dataset.slot = slot;

    const body = document.createElement('div');
    body.className = 'wg-workouts-history-row__body';

    const title = document.createElement('div');
    title.className = 'wg-workouts-history-row__title';

    const slotTag = document.createElement('span');
    slotTag.className = `wg-workouts-slot-tag wg-workouts-slot-tag--${slotMod} wg-workouts-history-row__slot`;
    slotTag.textContent = slot;
    title.appendChild(slotTag);

    const name = document.createElement('span');
    name.className = 'wg-workouts-history-row__name';
    name.textContent = s.group_name || 'Workout';
    title.appendChild(name);

    body.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'wg-workouts-history-row__meta';

    const timeText = session.started_at
        ? new Date(session.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : (session.scheduled_time || '');
    if (timeText) {
        const time = document.createElement('span');
        time.className = 'wg-workouts-history-row__time';
        time.textContent = timeText;
        meta.appendChild(time);
    }

    if (session.status === 'completed') {
        const count = document.createElement('span');
        count.className = 'wg-workouts-history-row__count';
        const done = s.exercises_completed || 0;
        const total = s.exercises_count || done;
        count.textContent = `${done}/${total} exercises`;
        meta.appendChild(count);
    } else if (session.status === 'skipped') {
        const skipped = document.createElement('span');
        skipped.className = 'wg-tag wg-tag--mono wg-tag--skipped wg-workouts-history-row__status';
        skipped.textContent = 'Skipped';
        meta.appendChild(skipped);
    }

    const durationMinutes = _computeSessionDurationMinutes(session);
    if (durationMinutes > 0) {
        const duration = document.createElement('span');
        duration.className = 'wg-workouts-history-row__duration';
        duration.textContent = _formatHistoryDuration(durationMinutes);
        meta.appendChild(duration);
    }

    if (s.total_volume > 0) {
        const volume = document.createElement('span');
        volume.className = 'wg-workouts-history-row__volume';
        volume.textContent = `${Math.round(s.total_volume).toLocaleString()} kg`;
        meta.appendChild(volume);
    }

    if (s.isRejected) {
        meta.appendChild(_buildHistorySyncTag('rejected', 'Failed', s.errorMessage));
    } else if (s.isLocal) {
        meta.appendChild(_buildHistorySyncTag('pending', 'Pending'));
    }

    body.appendChild(meta);
    card.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'wg-workouts-history-row__actions';
    actions.appendChild(_buildHistoryIconBtn('view', 'View session', 'chevronRight', () => {
        showWorkoutSessionModal(session.id);
    }));
    actions.appendChild(_buildHistoryIconBtn('edit', 'Edit session', 'pencil', () => {
        showWorkoutSessionModal(session.id);
    }));
    actions.appendChild(_buildHistoryIconBtn('delete', 'Delete session', 'trash', () => {
        deleteWorkoutSessionById(session.id);
    }, { isWrite: true }));
    card.appendChild(actions);

    card.addEventListener('click', (e) => {
        // Ignore clicks originating from icon-btns — they dispatch their own
        // action and shouldn't also fall through to the detail view.
        if (e.target.closest('.wg-workouts-history-row__actions')) return;
        showWorkoutSessionModal(session.id);
    });
    return card;
}

async function deleteWorkoutSessionById(sessionId) {
    if (!sessionId) return;
    await safeConfirm('Delete this workout session?', async (ok) => {
        if (!ok) return;
        const result = await apiCall(`/api/workout/sessions/delete?id=${sessionId}`, 'DELETE');
        if (result || result === true) {
            loadWorkoutHistoryTab();
        }
    });
}

function _computeSessionDurationMinutes(session) {
    if (!session) return 0;
    if (Number.isFinite(Number(session.duration_minutes))) {
        return Math.max(0, Math.round(Number(session.duration_minutes)));
    }
    if (session.started_at && session.completed_at) {
        const diff = new Date(session.completed_at).getTime() - new Date(session.started_at).getTime();
        if (Number.isFinite(diff) && diff > 0) return Math.round(diff / 60000);
    }
    return 0;
}

function _buildHistorySyncTag(kind, label, tooltip) {
    const tag = document.createElement('span');
    tag.className = `wg-tag wg-tag--mono wg-tag--${kind} wg-workouts-history-row__sync`;
    tag.textContent = label;
    if (tooltip) tag.title = tooltip;
    return tag;
}

function _buildHistoryIconBtn(kind, ariaLabel, iconName, handler, opts) {
    const btn = document.createElement('button');
    btn.type = 'button';
    let className = `wg-icon-btn wg-workouts-history-row__${kind}`;
    const isWrite = !!(opts && opts.isWrite);
    if (isWrite) {
        // Share the sync.js offline-toggling pathway used by modal-level
        // workout action buttons so DELETE-only controls stay disabled when
        // offline.
        className += ' workout-action-btn';
    }
    btn.className = className;
    btn.setAttribute('aria-label', ariaLabel);
    const gloss = document.createElement('span');
    gloss.className = 'wg-gloss';
    if (window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
        gloss.appendChild(window.WGIcons.iconSvg(iconName, { size: 16 }));
    }
    btn.appendChild(gloss);
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handler();
    });
    if (isWrite && typeof window !== 'undefined' && window.SyncManager && window.SyncManager.isOnline === false) {
        btn.classList.add('offline-disabled');
        btn.setAttribute('data-offline-disabled', 'true');
        btn.disabled = true;
    }
    return btn;
}

function _buildMiBandCard(w) {
    const meta = MIBAND_ACTIVITY_META[w.activity_name] || { label: w.activity_name, icon: '🏅' };
    const startDate = new Date(w.start_time);
    const timeStr = startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const distKm = w.distance_m >= 1000
        ? `${(w.distance_m / 1000).toFixed(1)} km`
        : `${Math.round(w.distance_m)} m`;
    const duration = _formatDuration(w.duration_sec);

    const card = document.createElement('li');
    card.className = 'wg-card wg-workouts-history-row wg-workouts-history-row--miband';
    card.dataset.mibandId = String(w.id || '');
    card.dataset.slot = 'AD-HOC';

    const body = document.createElement('div');
    body.className = 'wg-workouts-history-row__body';

    const title = document.createElement('div');
    title.className = 'wg-workouts-history-row__title';

    const slotTag = document.createElement('span');
    slotTag.className = 'wg-workouts-slot-tag wg-workouts-slot-tag--adhoc wg-workouts-history-row__slot';
    slotTag.textContent = meta.label.toUpperCase();
    title.appendChild(slotTag);

    const name = document.createElement('span');
    name.className = 'wg-workouts-history-row__name';
    name.textContent = w.source === 'manual' ? 'Manual entry' : 'Mi Band';
    title.appendChild(name);

    body.appendChild(title);

    const metaRow = document.createElement('div');
    metaRow.className = 'wg-workouts-history-row__meta';

    if (timeStr) {
        const t = document.createElement('span');
        t.className = 'wg-workouts-history-row__time';
        t.textContent = timeStr;
        metaRow.appendChild(t);
    }

    const dist = document.createElement('span');
    dist.className = 'wg-workouts-history-row__count';
    dist.textContent = distKm;
    metaRow.appendChild(dist);

    if (w.duration_sec > 0) {
        const dur = document.createElement('span');
        dur.className = 'wg-workouts-history-row__duration';
        dur.textContent = duration;
        metaRow.appendChild(dur);
    }

    if (w.heart_rate_avg > 0) {
        const hr = document.createElement('span');
        hr.className = 'wg-workouts-history-row__volume';
        hr.textContent = `${w.heart_rate_avg} bpm`;
        metaRow.appendChild(hr);
    }

    body.appendChild(metaRow);
    card.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'wg-workouts-history-row__actions';
    actions.appendChild(_buildHistoryIconBtn('view', 'View workout', 'chevronRight', () => {
        showMiBandWorkoutModal(w);
    }));
    card.appendChild(actions);

    card.addEventListener('click', (e) => {
        if (e.target.closest('.wg-workouts-history-row__actions')) return;
        showMiBandWorkoutModal(w);
    });
    return card;
}

// ====================================
// MI BAND WORKOUT EDIT/DELETE
// ====================================

let currentMiBandWorkout = null;

function showMiBandWorkoutModal(w) {
    currentMiBandWorkout = w;
    document.getElementById('miband-workout-id').value = w.id;
    document.getElementById('miband-workout-steps').value = w.steps || 0;
    document.getElementById('miband-workout-distance').value = w.distance_m || 0;
    document.getElementById('miband-workout-duration').value = w.duration_sec || 0;
    document.getElementById('miband-workout-calories').value = w.calories || 0;
    document.getElementById('miband-workout-hr').value = w.heart_rate_avg || 0;
    document.getElementById('miband-workout-spo2').value = w.spo2_avg || 0;

    window.ModalManager.mibandWorkout.open();
}

function closeMiBandWorkoutModal() {
    currentMiBandWorkout = null;
    window.ModalManager.mibandWorkout.close();
}

async function saveMiBandWorkout() {
    if (!currentMiBandWorkout) return;

    const id = currentMiBandWorkout.id;
    const payload = {};

    const steps = parseInt(document.getElementById('miband-workout-steps').value) || 0;
    const distance = parseFloat(document.getElementById('miband-workout-distance').value) || 0;
    const duration = parseInt(document.getElementById('miband-workout-duration').value) || 0;
    const calories = parseInt(document.getElementById('miband-workout-calories').value) || 0;
    const hr = parseInt(document.getElementById('miband-workout-hr').value) || 0;
    const spo2 = parseInt(document.getElementById('miband-workout-spo2').value) || 0;

    if (steps !== currentMiBandWorkout.steps) payload.steps = steps;
    if (distance !== currentMiBandWorkout.distance_m) payload.distance_m = distance;
    if (duration !== currentMiBandWorkout.duration_sec) payload.duration_sec = duration;
    if (calories !== currentMiBandWorkout.calories) payload.calories = calories;
    if (hr !== currentMiBandWorkout.heart_rate_avg) payload.heart_rate_avg = hr;
    if (spo2 !== currentMiBandWorkout.spo2_avg) payload.spo2_avg = spo2;

    if (Object.keys(payload).length === 0) {
        closeMiBandWorkoutModal();
        return;
    }

    try {
        const result = await apiCall(`/api/workout/miband/${id}`, 'PATCH', payload);
        if (result || result === true) {
            closeMiBandWorkoutModal();
            loadWorkoutHistoryTab();
        } else {
            throw new Error('API returned false/null');
        }
    } catch (err) {
        console.error('Error updating Mi Band workout:', err);
        safeAlert('Failed to update workout. Please try again.');
    }
}

async function deleteMiBandWorkout() {
    if (!currentMiBandWorkout) return;
    await safeConfirm('Delete this workout?', async (ok) => {
        if (ok) {
            await _deleteMiBandWorkoutApi();
        }
    });
}

async function _deleteMiBandWorkoutApi() {
    try {
        const result = await apiCall(`/api/workout/miband/${currentMiBandWorkout.id}`, 'DELETE');
        if (result || result === true) {
            closeMiBandWorkoutModal();
            loadWorkoutHistoryTab();
        } else {
            throw new Error('API returned false/null');
        }
    } catch (err) {
        console.error('Error deleting Mi Band workout:', err);
        safeAlert('Failed to delete workout. Please try again.');
    }
}

let currentSessionLogs = [];
let currentSessionData = null;
let originalSessionStatus = null;

function renderWorkoutSessionInfo(infoContainer, session) {
    infoContainer.classList.add('wg-workouts-session-info');

    const root = document.createElement('div');
    root.className = 'wg-workouts-session-info__row';

    const header = document.createElement('div');
    header.className = 'wg-workouts-session-info__header';

    const slot = getRotationSlot(session.variant_name || '');
    const slotTag = document.createElement('span');
    slotTag.className = `wg-workouts-slot-tag wg-workouts-slot-tag--${_slotTagModifier(slot)} wg-workouts-session-info__slot`;
    slotTag.textContent = slot;
    header.appendChild(slotTag);

    const dateParts = (session.scheduled_date || '').split('T')[0].split('-').map(Number);
    const dateObj = dateParts.length === 3
        ? new Date(dateParts[0], dateParts[1] - 1, dateParts[2])
        : new Date();
    const title = document.createElement('span');
    title.className = 'wg-mono-display wg-workouts-session-info__title';
    const weekday = dateObj.toLocaleDateString(undefined, { weekday: 'short' });
    const dateStr = dateObj.toLocaleDateString(undefined, {
        day: '2-digit', month: '2-digit', year: 'numeric'
    });
    title.textContent = `${dateStr} · ${weekday}`;
    header.appendChild(title);
    root.appendChild(header);

    const meta = document.createElement('div');
    meta.className = 'wg-workouts-session-info__meta';

    const timeText = session.started_at
        ? new Date(session.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : (session.scheduled_time || '');
    if (timeText) {
        const time = document.createElement('span');
        time.className = 'wg-workouts-session-info__time';
        time.textContent = timeText;
        meta.appendChild(time);
    }

    const durationMin = _computeSessionDurationMinutes(session);
    if (durationMin > 0) {
        const dur = document.createElement('span');
        dur.className = 'wg-workouts-session-info__duration';
        dur.textContent = _formatHistoryDuration(durationMin);
        meta.appendChild(dur);
    }
    root.appendChild(meta);

    const statusRow = document.createElement('div');
    statusRow.className = 'wg-workouts-session-info__status wg-gloss--inset';

    const label = document.createElement('label');
    label.className = 'wg-workouts-session-info__status-label';
    label.textContent = 'Status';
    label.setAttribute('for', 'session-status-select');

    const select = document.createElement('select');
    select.id = 'session-status-select';
    select.className = 'wg-workouts-session-info__status-select';

    const statusOptions = [
        { value: 'in_progress', label: 'In Progress' },
        { value: 'completed', label: 'Completed' },
        { value: 'skipped', label: 'Skipped' }
    ];
    statusOptions.forEach((opt) => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        option.selected = session.status === opt.value;
        select.appendChild(option);
    });

    statusRow.appendChild(label);
    statusRow.appendChild(select);
    root.appendChild(statusRow);

    infoContainer.replaceChildren(root);
}

function renderWorkoutSessionLogs(logsContainer) {
    logsContainer.classList.add('wg-workouts-session-logs');

    if (!Array.isArray(currentSessionLogs) || currentSessionLogs.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'wg-workouts-session-logs__empty';
        empty.textContent = 'No exercises logged';
        logsContainer.replaceChildren(empty);
        return;
    }

    const fragment = document.createDocumentFragment();
    currentSessionLogs.forEach((log, index) => {
        fragment.appendChild(_buildSessionExerciseCard(log, index));
    });

    logsContainer.replaceChildren(fragment);
}

function _buildSessionExerciseCard(log, index) {
    const isUnsaved = !log.id || log.id === 0;

    const entry = document.createElement('div');
    entry.className = 'wg-card wg-workouts-session-exercise exercise-log-entry';
    entry.id = `exercise-log-${index}`;
    if (isUnsaved && !log._dirty) {
        entry.classList.add('unsaved');
    }

    const headerRow = document.createElement('div');
    headerRow.className = 'wg-workouts-session-exercise__header exercise-log-header';

    const title = document.createElement('span');
    title.className = 'wg-mono-display wg-workouts-session-exercise__name';
    title.textContent = log.exercise_name || '';

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.title = 'Remove exercise';
    deleteButton.className = 'wg-icon-btn wg-workouts-session-exercise__delete exercise-log-delete-btn';
    deleteButton.setAttribute('aria-label', 'Remove exercise');
    const deleteGloss = document.createElement('span');
    deleteGloss.className = 'wg-gloss';
    if (window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
        deleteGloss.appendChild(window.WGIcons.iconSvg('trash', { size: 16 }));
    }
    deleteButton.appendChild(deleteGloss);
    deleteButton.addEventListener('click', () => {
        deleteExerciseLog(index);
    });

    headerRow.appendChild(title);
    headerRow.appendChild(deleteButton);
    entry.appendChild(headerRow);

    const sets = Math.max(0, Math.round(Number(log.sets_completed) || 0));
    const reps = Math.max(0, Math.round(Number(log.reps_completed) || 0));
    const weight = Math.max(0, Number(log.weight_kg) || 0);
    const weightLabel = weight > 0 ? `${weight % 1 === 0 ? weight : weight.toFixed(1)} kg` : 'bodyweight';
    const monoRow = document.createElement('div');
    monoRow.className = 'wg-workouts-session-exercise__mono';
    monoRow.textContent = `${sets} × ${reps} · ${weightLabel}`;
    entry.appendChild(monoRow);

    if (isUnsaved && !log._dirty) {
        const hint = document.createElement('div');
        hint.className = 'wg-workouts-session-exercise__hint exercise-log-unsaved-hint';
        hint.textContent = 'Not yet logged — edit to include';
        entry.appendChild(hint);
    }

    const inputRow = document.createElement('div');
    inputRow.className = 'wg-workouts-session-exercise__inputs log-input-row';

    const createNumberInputGroup = (labelText, value, field, min, max, step, inputmode) => {
        const group = document.createElement('label');
        group.className = 'wg-gloss--inset wg-workouts-session-exercise__field log-input-group';

        const labelEl = document.createElement('span');
        labelEl.className = 'wg-workouts-session-exercise__field-label';
        labelEl.textContent = labelText;

        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'wg-workouts-session-exercise__field-input';
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.value = String(value);
        input.setAttribute('inputmode', inputmode);
        input.addEventListener('change', () => {
            updateLocalLog(index, field, input.value);
        });

        group.appendChild(labelEl);
        group.appendChild(input);
        return group;
    };

    inputRow.appendChild(createNumberInputGroup('Sets', log.sets_completed || 0, 'sets_completed', 0, 20, 1, 'numeric'));
    inputRow.appendChild(createNumberInputGroup('Reps', log.reps_completed || 0, 'reps_completed', 0, 100, 1, 'numeric'));
    inputRow.appendChild(createNumberInputGroup('Weight (kg)', log.weight_kg || 0, 'weight_kg', 0, 500, 0.5, 'decimal'));
    entry.appendChild(inputRow);

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

async function showWorkoutSessionModal(sessionId) {
    const logsContainer = document.getElementById('workout-session-logs');
    const infoContainer = document.getElementById('workout-session-info');
    const overlay = document.getElementById('modal-overlay');

    try {
        const data = await apiCall(`/api/workout/sessions/details?id=${sessionId}`);
        if (!data) return;

        currentSessionLogs = data.logs || [];
        currentSessionData = data.session;
        originalSessionStatus = data.session.status;

        if (currentSessionData && currentSessionData.variant_id > 0) {
            try {
                const plannedExercises = await apiCall(`/api/workout/exercises?variant_id=${currentSessionData.variant_id}`);
                if (Array.isArray(plannedExercises) && plannedExercises.length > 0) {
                    const existingByExerciseID = new Map();
                    currentSessionLogs.forEach(log => {
                        if (log.exercise_id && !existingByExerciseID.has(log.exercise_id)) {
                            existingByExerciseID.set(log.exercise_id, true);
                        }
                    });

                    const plannedMissingLogs = plannedExercises
                        .filter(ex => !existingByExerciseID.has(ex.id))
                        .map(ex => ({
                            id: 0,
                            exercise_id: ex.id,
                            exercise_name: ex.exercise_name,
                            sets_completed: ex.target_sets || 0,
                            reps_completed: ex.target_reps_min || 0,
                            weight_kg: ex.target_weight_kg || 0,
                            notes: '',
                            status: 'completed',
                            _dirty: false  // NOT saved unless user actually edits
                        }));

                    currentSessionLogs = [...currentSessionLogs, ...plannedMissingLogs];
                }
            } catch (prefillError) {
                console.error('Error pre-filling planned exercises:', prefillError);
            }
        }

        renderWorkoutSessionInfo(infoContainer, data.session);
        renderWorkoutSessionLogs(logsContainer);
        const actionsContainer = document.getElementById('workout-session-actions');
        if (actionsContainer) {
            renderSessionDetailActions(actionsContainer, {
                onLogSet: () => showAddExerciseToSessionModal(),
                onFinish: () => finishWorkoutSession(),
                onDelete: () => deleteWorkoutSession()
            });
        }

        window.ModalManager.workoutSession.open();

        // Add click handler to overlay to close modal
        overlay.onclick = function (e) {
            if (e.target === overlay) {
                closeWorkoutSessionModal();
            }
        };
    } catch (error) {
        console.error('Error loading session details:', error);
        safeAlert('Error loading session details');
    }
}

function updateLocalLog(index, field, value) {
    if (!currentSessionLogs[index]) return;

    if (field === 'notes') {
        currentSessionLogs[index][field] = value;
    } else if (field === 'sets_completed' || field === 'reps_completed') {
        // Sets and reps must be integers
        currentSessionLogs[index][field] = Math.max(0, Math.round(parseFloat(value) || 0));
    } else {
        // Weight can be decimal
        currentSessionLogs[index][field] = Math.max(0, parseFloat(value) || 0);
    }
    // Mark as dirty so it gets saved
    currentSessionLogs[index]._dirty = true;
    // Update visual state — remove dim styling
    const el = document.getElementById(`exercise-log-${index}`);
    if (el) {
        el.classList.remove('unsaved');
        const hint = el.querySelector('.exercise-log-unsaved-hint');
        if (hint) hint.remove();
    }
}
async function deleteExerciseLog(index) {
    const log = currentSessionLogs[index];
    if (!log) return;

    await safeConfirm(`Remove ${log.exercise_name} from this workout?`, async (ok) => {
        if (!ok) return;

        // If it has an ID (already saved in DB), delete from backend
        if (log.id && log.id > 0) {
            try {
                await apiCall(`/api/workout/sessions/logs/delete?id=${log.id}`, 'DELETE');
            } catch (error) {
                console.error('Error deleting exercise log:', error);
                safeAlert('Failed to delete exercise log');
                return;
            }
        }

        // Remove from local array and re-render
        currentSessionLogs.splice(index, 1);
        const logsContainer = document.getElementById('workout-session-logs');
        renderWorkoutSessionLogs(logsContainer);
    });
}

async function deleteWorkoutSession() {
    if (!currentSessionData) return;
    await safeConfirm('Delete this workout session?', async (ok) => {
        if (ok) {
            const result = await apiCall(`/api/workout/sessions/delete?id=${currentSessionData.id}`, 'DELETE');
            if (result || result === true) {
                closeWorkoutSessionModal();
                loadWorkoutHistoryTab();
            }
        }
    });
}

async function finishWorkoutSession() {
    if (!currentSessionData) return;
    const select = document.getElementById('session-status-select');
    if (select) select.value = 'completed';
    await saveWorkoutSessionDetails();
}

function renderSessionDetailActions(container, opts) {
    container.classList.add('wg-workouts-session-actions');
    container.replaceChildren();

    const onLogSet = (opts && typeof opts.onLogSet === 'function') ? opts.onLogSet : () => {};
    const onFinish = (opts && typeof opts.onFinish === 'function') ? opts.onFinish : () => {};
    const onDelete = (opts && typeof opts.onDelete === 'function') ? opts.onDelete : () => {};

    // `.workout-action-btn` hooks these into sync.js's offline toggling
    // sweep so the buttons stay disabled/enabled as connectivity changes
    // while the modal is open. Static offline state at creation time is
    // applied below (SyncManager.isOnline === false case).
    const logSetBtn = document.createElement('button');
    logSetBtn.type = 'button';
    logSetBtn.id = 'workout-session-add-exercise-btn';
    logSetBtn.className = 'wg-gloss--sun wg-workouts-session-actions__btn wg-workouts-session-actions__log-set workout-action-btn';
    logSetBtn.textContent = 'Log set';
    logSetBtn.addEventListener('click', () => onLogSet());

    const finishBtn = document.createElement('button');
    finishBtn.type = 'button';
    finishBtn.id = 'workout-session-finish-btn';
    finishBtn.className = 'wg-gloss wg-workouts-session-actions__btn wg-workouts-session-actions__finish workout-action-btn';
    finishBtn.textContent = 'Finish';
    finishBtn.addEventListener('click', () => onFinish());

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.id = 'workout-session-bottom-delete-btn';
    deleteBtn.className = 'wg-gloss wg-workouts-session-actions__btn wg-workouts-session-actions__delete workout-action-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => onDelete());

    container.appendChild(logSetBtn);
    container.appendChild(finishBtn);
    container.appendChild(deleteBtn);

    if (typeof window !== 'undefined' && window.SyncManager && window.SyncManager.isOnline === false) {
        [logSetBtn, finishBtn, deleteBtn].forEach((btn) => {
            btn.classList.add('offline-disabled');
            btn.setAttribute('data-offline-disabled', 'true');
            btn.disabled = true;
        });
    }
}

function closeWorkoutSessionModal() {
    const overlay = document.getElementById('modal-overlay');
    overlay.onclick = null; // Remove click handler
    window.ModalManager.workoutSession.close();
    currentSessionData = null;
    originalSessionStatus = null;
}

async function saveWorkoutSessionDetails() {
    const saveButton = document.querySelector('#workout-session-modal .actions .btn-primary');
    const originalText = saveButton.textContent;

    try {
        // Disable button and show loading state
        saveButton.disabled = true;
        saveButton.textContent = 'Saving...';
        saveButton.style.opacity = '0.6';

        // Check if status has changed
        const statusSelect = document.getElementById('session-status-select');
        const newStatus = statusSelect ? statusSelect.value : originalSessionStatus;
        const statusChanged = newStatus !== originalSessionStatus;

        // Validate all logs before saving
        for (const log of currentSessionLogs) {
            if (log.sets_completed < 0 || log.reps_completed < 0 || log.weight_kg < 0) {
                throw new Error('Values cannot be negative');
            }
            if (log.sets_completed > 20 || log.reps_completed > 100 || log.weight_kg > 500) {
                throw new Error('Values exceed maximum allowed');
            }
        }

        // Save status if changed
        if (statusChanged && currentSessionData) {
            const statusResult = await apiCall(`/api/workout/sessions/status?id=${currentSessionData.id}`, 'PUT', {
                status: newStatus
            });
            if (statusResult === null) return;
        }

        // Save each log — only save new entries that the user actually edited (_dirty)
        for (const log of currentSessionLogs) {
            let logResult;
            if (log.id && log.id > 0) {
                // Existing log — always update
                logResult = await apiCall('/api/workout/sessions/logs/update', 'POST', {
                    id: log.id,
                    sets_completed: Math.round(log.sets_completed),
                    reps_completed: Math.round(log.reps_completed),
                    weight_kg: parseFloat(log.weight_kg),
                    notes: log.notes || ''
                });
            } else if (log._dirty) {
                // New log that user actually edited — create it
                logResult = await apiCall('/api/workout/sessions/logs/create', 'POST', {
                    session_id: currentSessionData.id,
                    exercise_id: log.exercise_id,
                    exercise_name: log.exercise_name,
                    target_sets: Math.round(log.sets_completed),
                    target_reps_min: Math.round(log.reps_completed),
                    target_weight_kg: parseFloat(log.weight_kg),
                    status: 'completed',
                    notes: log.notes || ''
                });
            }
            if (logResult === null) return;
            // Skip: id===0 && !_dirty — pre-filled but untouched, don't save
        }

        closeWorkoutSessionModal();
        loadWorkoutHistoryTab();
    } catch (error) {
        console.error('Error saving workout details:', error);
        const message = error.message || 'Error saving workout details. Please try again.';
        safeAlert('❌ ' + message);
    } finally {
        // Re-enable button (unless offline mode disabled it)
        if (!saveButton.hasAttribute('data-offline-disabled')) {
            saveButton.disabled = false;
        }
        saveButton.textContent = originalText;
        saveButton.style.opacity = '1';
    }
}

// Stats sub-tab range selector state (Phase 7, Task 7). Persists the active
// range the same way `mt-bp-range` / `mt-weight-range` do, with the Workouts-
// specific storage key. Keeps the range CONSISTENT across tab switches and
// reloads.
const WORKOUTS_STATS_RANGE_KEY = 'mt-workouts-stats-range';
const WORKOUTS_STATS_RANGE_OPTIONS = ['7d', '30d', '90d', 'all'];
const WORKOUTS_STATS_RANGE_DEFAULT = 'all';

function getActiveWorkoutsStatsRange() {
    try {
        const raw = window.localStorage.getItem(WORKOUTS_STATS_RANGE_KEY);
        if (WORKOUTS_STATS_RANGE_OPTIONS.indexOf(raw) !== -1) return raw;
    } catch (_) { /* ignore */ }
    return WORKOUTS_STATS_RANGE_DEFAULT;
}

function setActiveWorkoutsStatsRange(range) {
    if (WORKOUTS_STATS_RANGE_OPTIONS.indexOf(range) === -1) return;
    try { window.localStorage.setItem(WORKOUTS_STATS_RANGE_KEY, range); } catch (_) { /* ignore */ }
}

async function loadWorkoutStatsTab() {
    const container = document.getElementById('workout-stats-display');
    await window.DataStore.loadSWR({
        key: 'workout_stats',
        tags: ['workout'],
        fetcher: async () => await apiCall('/api/workout/stats'),
        onCached: async (cached) => {
            _renderWorkoutStats(container, cached);
        },
        onFresh: async (stats) => {
            _renderWorkoutStats(container, stats);
        },
        onError: async (error, cached) => {
            console.error('Error loading stats:', error);
            if (!cached) {
                const message = document.createElement('p');
                message.className = 'text-hint';
                message.textContent = 'No cached data \u2014 will load when online';
                container.replaceChildren(message);
            }
        }
    });
}

function _renderWorkoutStats(container, stats) {
    if (!stats) {
        const empty = document.createElement('p');
        empty.className = 'text-center text-hint wg-workouts-stats__empty';
        empty.textContent = 'No statistics available yet';
        container.replaceChildren(empty);
        return;
    }

    const formatVolume = (kg) => {
        if (!kg || kg === 0) return '—';
        if (kg >= 1000) return `${(kg / 1000).toFixed(1)}t`;
        return `${Math.round(kg).toLocaleString()} kg`;
    };

    const root = document.createElement('div');
    root.className = 'wg-workouts-stats';

    // Range selector — gloss-inset strip with four pills; active state via
    // `.wg-gloss--sun`. Clicking a button persists the range and re-renders
    // the chart in place without re-fetching.
    const activeRange = getActiveWorkoutsStatsRange();
    const rangeStrip = document.createElement('div');
    rangeStrip.className = 'wg-gloss--inset wg-workouts-stats__range';
    rangeStrip.setAttribute('role', 'tablist');
    const rangeLabels = { '7d': '7d', '30d': '30d', '90d': '90d', 'all': 'All' };
    const rangeButtons = new Map();
    WORKOUTS_STATS_RANGE_OPTIONS.forEach((range) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wg-gloss wg-workouts-stats__range-btn';
        btn.dataset.range = range;
        btn.textContent = rangeLabels[range];
        if (range === activeRange) {
            btn.classList.add('wg-gloss--sun', 'wg-workouts-stats__range-btn--active');
            btn.setAttribute('aria-pressed', 'true');
        } else {
            btn.setAttribute('aria-pressed', 'false');
        }
        btn.addEventListener('click', () => {
            setActiveWorkoutsStatsRange(range);
            rangeButtons.forEach((b, key) => {
                const isActive = key === range;
                b.classList.toggle('wg-gloss--sun', isActive);
                b.classList.toggle('wg-workouts-stats__range-btn--active', isActive);
                b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
            });
            renderChartInto(range);
        });
        rangeButtons.set(range, btn);
        rangeStrip.appendChild(btn);
    });
    root.appendChild(rangeStrip);

    // Chart panel — WGWorkoutChart renders either an <svg> or an empty-state
    // <div>; either way it carries `.wg-workout-chart` so the panel styles
    // itself consistently.
    const chartPanel = document.createElement('div');
    chartPanel.className = 'wg-workouts-stats__chart-panel';
    const renderChartInto = (range) => {
        chartPanel.replaceChildren();
        const sessions = Array.isArray(stats.weekly_activity) ? stats.weekly_activity : [];
        const node = window.WGWorkoutChart && typeof window.WGWorkoutChart.render === 'function'
            ? window.WGWorkoutChart.render({ sessions, range })
            : null;
        if (node) {
            chartPanel.appendChild(node);
        } else {
            const empty = document.createElement('div');
            empty.className = 'wg-workout-chart wg-workout-chart--empty';
            const msg = document.createElement('span');
            msg.className = 'wg-workout-chart__empty-msg';
            msg.textContent = 'No workout sessions yet';
            empty.appendChild(msg);
            chartPanel.appendChild(empty);
        }
    };
    renderChartInto(activeRange);
    root.appendChild(chartPanel);

    // Stat tiles — 2×2 `.wg-card` grid. Labels mirror the existing API
    // semantics: Active Weeks / 30-Day Sessions / Done / Skipped.
    const tiles = document.createElement('div');
    tiles.className = 'wg-workouts-stats__tiles';
    const buildTile = (valueText, labelText) => {
        const card = document.createElement('div');
        card.className = 'wg-card wg-workouts-stats__tile';

        const value = document.createElement('div');
        value.className = 'wg-workouts-stats__tile-value wg-mono-display';
        value.textContent = valueText;

        const label = document.createElement('div');
        label.className = 'wg-workouts-stats__tile-label';
        label.textContent = labelText;

        card.appendChild(value);
        card.appendChild(label);
        return card;
    };

    tiles.appendChild(buildTile(String(stats.active_weeks || 0), 'Active Weeks'));
    tiles.appendChild(buildTile(String(stats.total_sessions || 0), '30-Day Sessions'));
    tiles.appendChild(buildTile(String(stats.completed_sessions || 0), 'Done'));
    tiles.appendChild(buildTile(String(stats.skipped_sessions || 0), 'Skipped'));
    root.appendChild(tiles);

    // Top Exercises — optional. `.wg-section-label` heading, then a list of
    // `.wg-card` rows each carrying a mono name, volume summary, and a
    // sun-coloured fill bar.
    if (stats.top_exercises && stats.top_exercises.length > 0) {
        const heading = document.createElement('div');
        heading.className = 'wg-section-label wg-workouts-stats__section-label';
        heading.textContent = 'Top Exercises · Volume';
        root.appendChild(heading);

        const maxVol = stats.top_exercises[0].total_volume_kg || 1;
        const list = document.createElement('ul');
        list.className = 'wg-workouts-stats__top-exercises';

        stats.top_exercises.forEach((ex) => {
            const pct = maxVol > 0 ? (ex.total_volume_kg / maxVol * 100).toFixed(1) : 0;
            const maxW = ex.max_weight_kg > 0 ? `${ex.max_weight_kg} kg max` : '';

            const row = document.createElement('li');
            row.className = 'wg-card wg-workouts-stats__top-row';

            const head = document.createElement('div');
            head.className = 'wg-workouts-stats__top-row-head';

            const name = document.createElement('span');
            name.className = 'wg-workouts-stats__top-row-name';
            name.textContent = ex.exercise_name;

            const volume = document.createElement('span');
            volume.className = 'wg-workouts-stats__top-row-volume';
            volume.textContent = `${formatVolume(ex.total_volume_kg)}${maxW ? ` · ${maxW}` : ''}`;

            head.appendChild(name);
            head.appendChild(volume);

            const bar = document.createElement('div');
            bar.className = 'wg-workouts-stats__top-row-bar';
            const fill = document.createElement('div');
            fill.className = 'wg-workouts-stats__top-row-bar-fill';
            fill.style.setProperty('--fill-pct', `${pct}%`);
            bar.appendChild(fill);

            row.appendChild(head);
            row.appendChild(bar);
            list.appendChild(row);
        });

        root.appendChild(list);
    }

    container.replaceChildren(root);
}

// ====================================
// START WORKOUT SESSION
// ====================================

// ====================================
// AD-HOC WORKOUT
// ====================================

async function startAdHocWorkout() {
    try {
        // Create ad-hoc workout session via API
        const result = await apiCall('/api/workout/sessions/adhoc', 'POST');

        if (result && result.session) {
            // Immediately open the session modal to start logging exercises
            await showWorkoutSessionModal(result.session.id);

            // Refresh the next workout card
            await loadNextWorkout();
        } else {
            safeAlert('Failed to start ad-hoc workout');
        }
    } catch (error) {
        console.error('Error starting ad-hoc workout:', error);
        safeAlert('Error starting ad-hoc workout: ' + error.message);
    }
}

// ====================================
// WORKOUT SESSION MANAGEMENT
// ====================================

async function startWorkoutSession(sessionId) {
    await safeConfirm('Start this workout now?', async (ok) => {
        if (!ok) return;

        try {
            const result = await apiCall(`/api/workout/sessions/${sessionId}/start`, 'POST');
            if (result === null) return;

            // Show success message
            safeAlert('✅ Workout started! You can now log exercises.');

            // Refresh the next workout card
            loadNextWorkout();
        } catch (error) {
            console.error('Error starting workout:', error);
            safeAlert('❌ Failed to start workout. Please try again.');
        }
    });
}

async function cancelWorkoutSession(sessionId) {
    await safeConfirm('Finish this workout now? It will be marked as completed.', async (ok) => {
        if (ok) {
            try {
                const result = await apiCall(`/api/workout/sessions/status?id=${sessionId}`, 'PUT', { status: 'completed' });
                if (result === null) return;
                loadNextWorkout();
                loadWorkoutHistoryTab(); // Refresh history if visible
            } catch (e) {
                console.error(e);
                safeAlert('Failed to finish workout');
            }
        }
    });
}

async function preSkipWorkoutSession(sessionId) {
    await safeConfirm('Mark this workout as to-be-skipped? No notification will be sent and it will be automatically skipped at the scheduled time.', async (ok) => {
        if (!ok) return;

        try {
            const result = await apiCall(`/api/workout/sessions/${sessionId}/preskip`, 'POST');
            if (result === null) return;
            loadNextWorkout();
        } catch (error) {
            console.error('Error pre-skipping workout:', error);
            safeAlert('❌ Failed to mark workout as skipped. Please try again.');
        }
    });
}

async function cancelPreSkipWorkoutSession(sessionId) {
    try {
        const result = await apiCall(`/api/workout/sessions/${sessionId}/cancel-preskip`, 'POST');
        if (result === null) return;
        loadNextWorkout();
    } catch (error) {
        console.error('Error cancelling pre-skip:', error);
        safeAlert('❌ Failed to cancel skip. Please try again.');
    }
}

// ====================================
// ADD EXERCISE TO SESSION
// ====================================

async function showAddExerciseToSessionModal() {
    if (!currentSessionData) return;

    // Reset fields
    document.getElementById('session-add-exercise-name').value = '';
    document.getElementById('session-add-exercise-id').value = '';
    document.getElementById('session-add-exercise-sets').value = '';
    document.getElementById('session-add-exercise-reps').value = '';
    document.getElementById('session-add-exercise-weight').value = '';
    document.getElementById('session-add-exercise-notes').value = '';

    const titleEl = document.getElementById('workout-add-exercise-to-session-title');
    if (titleEl) titleEl.textContent = 'Add exercise';

    // Load unique exercises
    const datalist = document.getElementById('unique-exercises-list');
    datalist.replaceChildren();

    try {
        const exercises = await apiCall('/api/workout/exercise-library');
        if (exercises && exercises.length > 0) {
            exercises.forEach(ex => {
                const option = document.createElement('option');
                option.value = ex.name;
                option.dataset.id = ex.id;
                option.dataset.sets = ex.default_sets || '';
                option.dataset.reps = ex.default_reps_min || '';
                option.dataset.weight = ex.default_weight_kg || '';
                datalist.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error loading unique exercises:', error);
    }

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
            closeWorkoutSessionModal();
        }
    };
}

function onSessionExerciseSelect() {
    const input = document.getElementById('session-add-exercise-name');
    const datalist = document.getElementById('unique-exercises-list');
    const hiddenId = document.getElementById('session-add-exercise-id');

    const val = input.value;
    const option = Array.from(datalist.options).find(o => o.value === val);

    const titleEl = document.getElementById('workout-add-exercise-to-session-title');
    if (titleEl) titleEl.textContent = val ? `Log set \u00b7 ${val}` : 'Add exercise';

    if (option) {
        hiddenId.value = option.dataset.id;
        // Autofill if empty
        if (!document.getElementById('session-add-exercise-sets').value)
            document.getElementById('session-add-exercise-sets').value = option.dataset.sets;
        if (!document.getElementById('session-add-exercise-reps').value)
            document.getElementById('session-add-exercise-reps').value = option.dataset.reps;
        if (!document.getElementById('session-add-exercise-weight').value && option.dataset.weight)
            document.getElementById('session-add-exercise-weight').value = option.dataset.weight;
    } else {
        hiddenId.value = '';
    }
}

async function saveNewSessionExercise() {
    if (!currentSessionData) return;

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

    if (!exerciseId) {
        // Try to find in datalist again
        const datalist = document.getElementById('unique-exercises-list');
        const option = Array.from(datalist.options).find(o => o.value === name);
        if (option) {
            exerciseId = option.dataset.id;
        } else {
            safeAlert('Please select an existing exercise from the list. Adding new unknown exercises to a session is not supported yet.');
            return;
        }
    }

    try {
        const result = await apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: currentSessionData.id,
            exercise_id: parseInt(exerciseId),
            exercise_name: name,
            target_sets: sets,
            target_reps_min: reps,
            target_weight_kg: weight,
            status: 'completed',
            notes: notes,
            source: 'library'
        });
        if (result === null) return;

        closeAddExerciseToSessionModal();
        // Refresh session modal
        showWorkoutSessionModal(currentSessionData.id);
    } catch (error) {
        console.error(error);
        safeAlert('Failed to add exercise');
    }
}
