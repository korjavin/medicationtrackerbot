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
            // med-2fc: Start AdHoc now lives only inside the card, so a
            // no-cache read failure must still render the ad-hoc-only card
            // rather than emptying the container — otherwise a transient
            // fetch error leaves the screen with no way to start a workout.
            if (!cached) _renderNextWorkout(container, null);
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
    const session = (data && data.session) ? data.session : null;

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
            onClick(session ? session.id : null);
        });
        return button;
    };

    const card = document.createElement('div');
    card.className = 'wg-workouts-next-card';

    const actions = document.createElement('div');
    actions.className = 'wg-workouts-next-card__actions';
    // med-2fc: Start AdHoc is the leftmost action in every status branch —
    // it replaced the floating History-header CTA, so this is the only
    // ad-hoc entry point on the screen. It starts an unplanned session, so
    // it ignores the session id `createButton` hands its onClick.
    actions.appendChild(createButton('Start AdHoc', 'secondary', () => window.startAdHocWorkout()));

    // No scheduled session: render the card with Start AdHoc alone (no
    // kicker/date/title/subtitle, no Skip, no Next Day) so the ad-hoc entry
    // point stays in the same place on screen.
    if (!session) {
        card.appendChild(actions);
        container.replaceChildren(card);
        return;
    }

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

    if (status === 'in_progress') {
        actions.appendChild(createButton('View', 'primary', showWorkoutSessionModal));
        actions.appendChild(createButton('Finish', 'secondary', completeWorkoutSession));
    } else if (status === 'pre_skipped') {
        actions.appendChild(createButton('Cancel Skip', 'primary', cancelPreSkipWorkoutSession));
        if (isRotating) {
            actions.appendChild(createButton('Next Day', 'secondary', nextWorkoutVariant));
        }
    } else {
        actions.appendChild(createButton('Start Scheduled', 'primary', startWorkoutSession));
        actions.appendChild(createButton('Skip', 'secondary', preSkipWorkoutSession));
        if (isRotating) {
            actions.appendChild(createButton('Next Day', 'secondary', nextWorkoutVariant));
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
        alert('Failed to switch day. Please try again.');
    }
}

window.WorkoutNextCard = {
    load: loadNextWorkout,
    openEdit: openNextWorkoutEditModal,
    nextVariant: nextWorkoutVariant
};
