// ====================================
// NEXT WORKOUT CARD + Shared slot utils
// ====================================

// Today's-workout card (Phase 7, Task 3). Sun-glossed card that mirrors the
// Meds next-action pattern and surfaces the current rotation slot.
//
// The classifier `getRotationSlot(variantName)` maps a variant name into one
// of five token-group names (PUSH / PULL / LEGS / REST / AD-HOC). It drives
// both the slot-tag CSS variant and the card variant (sun for PUSH/PULL/LEGS,
// muted for REST / AD-HOC). Also consumed by groups.js / history.js /
// library.js / sessions.js — load this file before those.
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
        // apiCallDirect throws on offline/5xx so a transient refresh failure
        // routes through onError (cached card preserved). The legacy apiCall
        // path returned null on offline (handleOfflineWorkoutRead has no
        // 'sessions' fallback populated by this module), and with
        // allowNullFresh: true that null reached onFresh and cleared the
        // just-rendered cached card. A real "no next workout" response from
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
            await renderWorkoutHistoryStaleBadge();
        },
        onFresh: async (fresh) => {
            _renderNextWorkout(container, fresh);
            await renderWorkoutHistoryStaleBadge();
        },
        onError: async (error, cached) => {
            console.error('Error loading next workout:', error);
            if (!cached) container.replaceChildren();
            await renderWorkoutHistoryStaleBadge();
        }
    });
}

// Mounts the wg-stale-badge into the Workouts History subtab. The subtab
// surfaces two data sources (the next-workout card driven by 'workout_next'
// and the history list driven by 'workout_history'); the chip reads the
// OLDER of the two timestamps so the user sees a worst-case freshness floor
// rather than a freshness chip that disagrees with the list below it.
async function renderWorkoutHistoryStaleBadge() {
    const slot = (typeof document !== 'undefined') ? document.getElementById('workout-history-stale-badge') : null;
    if (!slot) return;
    const api = (typeof window !== 'undefined') ? window.WGStaleBadge : null;
    if (!api || typeof api.render !== 'function') {
        slot.replaceChildren();
        slot.classList.add('hidden');
        return;
    }
    const cache = (typeof window !== 'undefined') && window.MedTrackerDB
        ? window.MedTrackerDB.ApiCache
        : null;
    const offline = (typeof navigator !== 'undefined') ? navigator.onLine === false : false;
    let oldestTs = null;
    if (cache && typeof cache.getWithMeta === 'function') {
        for (const key of ['workout_next', 'workout_history']) {
            try {
                const entry = await cache.getWithMeta(key);
                if (entry && Number.isFinite(entry.timestamp)) {
                    if (oldestTs === null || entry.timestamp < oldestTs) oldestTs = entry.timestamp;
                }
            } catch (_) { /* best-effort cache read */ }
        }
    }
    if (oldestTs === null && !offline) {
        slot.replaceChildren();
        slot.classList.add('hidden');
        return;
    }
    const badge = api.render({ fetchedAt: oldestTs, isOffline: offline });
    slot.replaceChildren(badge);
    slot.classList.remove('hidden');
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

    // Round-2 Task 10 (defect #13a): kicker label replaces the legacy
    // emoji-prefixed status line. Text content preserved so downstream
    // tests (loadNextWorkout / SWR / snoozed paths) keep pinning the same
    // status strings.
    let statusText = 'Upcoming';
    if (isSnoozed) {
        statusText = 'Snoozed';
    } else if (status === 'in_progress') {
        statusText = 'In Progress';
    } else if (status === 'notified') {
        statusText = 'Ready to Start';
    } else if (status === 'pre_skipped') {
        statusText = 'To Be Skipped';
    } else if (isToday) {
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
    card.className = 'wg-workouts-next-card';

    const header = document.createElement('div');
    header.className = 'wg-workouts-next-card__header';

    const statusEl = document.createElement('div');
    statusEl.className = 'wg-workouts-next-card__kicker';
    statusEl.textContent = statusText;

    const dateEl = document.createElement('div');
    dateEl.className = 'wg-workouts-next-card__date';
    dateEl.textContent = `${dateStr} at ${session.scheduled_time}`;

    header.appendChild(statusEl);
    header.appendChild(dateEl);
    card.appendChild(header);

    const info = document.createElement('div');
    info.className = 'wg-workouts-next-card__info';
    info.title = 'View/edit planned exercises';
    info.addEventListener('click', () => {
        openNextWorkoutEditModal(variantId, groupId);
    });

    const title = document.createElement('h3');
    title.className = 'wg-workouts-next-card__title';
    title.textContent = data.group_name;
    const subtitle = document.createElement('p');
    subtitle.className = 'wg-workouts-next-card__subtitle';
    subtitle.textContent = `${data.variant_name} · ${data.exercises_count} exercises`;
    info.appendChild(title);
    info.appendChild(subtitle);
    card.appendChild(info);

    const isOffline = window.SyncManager && !window.SyncManager.isOnline;
    // Round-2 Task 10 (defect #13a): every action button adopts the
    // shared `.wg-toolbar-btn` sizing with a primary (yellow filled) or
    // secondary (outline/ghost) variant. No emoji prefixes. The
    // `workout-action-btn` marker class is preserved so `sync.js`
    // offline-disabled handler (which scans `.workout-action-btn`) keeps
    // flipping these buttons when connectivity drops mid-session.
    const createButton = (label, variant, onClick) => {
        const button = document.createElement('button');
        button.type = 'button';
        const variantClass = variant === 'primary'
            ? 'wg-toolbar-btn--primary'
            : 'wg-toolbar-btn--secondary';
        button.className = `wg-toolbar-btn ${variantClass} workout-action-btn`;
        const labelEl = document.createElement('span');
        labelEl.className = 'wg-toolbar-btn__label';
        labelEl.textContent = label;
        button.appendChild(labelEl);
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

    const actions = document.createElement('div');
    actions.className = 'wg-workouts-next-card__actions';
    if (status === 'in_progress') {
        actions.appendChild(createButton('View', 'primary', showWorkoutSessionModal));
        actions.appendChild(createButton('Finish', 'secondary', completeWorkoutSession));
    } else if (status === 'pre_skipped') {
        actions.appendChild(createButton('Cancel Skip', 'primary', cancelPreSkipWorkoutSession));
        if (isRotating) {
            actions.appendChild(createButton('Next Variant', 'secondary', nextWorkoutVariant));
        }
    } else {
        actions.appendChild(createButton('Start Workout', 'primary', startWorkoutSession));
        actions.appendChild(createButton('Skip', 'secondary', preSkipWorkoutSession));
        if (isRotating) {
            actions.appendChild(createButton('Next Variant', 'secondary', nextWorkoutVariant));
        }
    }
    card.appendChild(actions);

    container.replaceChildren(card);
}

// ====================================
// NEXT WORKOUT EDIT MODAL
// ====================================

async function openNextWorkoutEditModal(variantId, groupId) {
    if (!variantId || !groupId) return;
    window.WorkoutEdit.groupForVariant = groupId;
    await showEditVariantModal(variantId);
}

async function nextWorkoutVariant(sessionId) {
    try {
        const result = await apiCall(`/api/workout/sessions/${sessionId}/next-variant`, 'POST');
        if (result === null) return;
        await invalidateWorkoutCache();
        await loadNextWorkout();
    } catch (error) {
        console.error('Error switching to next variant:', error);
        alert('Failed to switch variant. Please try again.');
    }
}

window.WorkoutNextCard = {
    load: loadNextWorkout,
    renderToday: renderTodaysWorkoutCard,
    openEdit: openNextWorkoutEditModal,
    nextVariant: nextWorkoutVariant
};
