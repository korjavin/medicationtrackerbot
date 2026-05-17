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

    const logs = window.WorkoutSessionsState.logs;
    if (!Array.isArray(logs) || logs.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'wg-workouts-session-logs__empty';
        empty.textContent = 'No exercises logged';
        logsContainer.replaceChildren(empty);
        return;
    }

    const fragment = document.createDocumentFragment();
    logs.forEach((log, index) => {
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

        window.WorkoutSessionsState.logs = data.logs || [];
        window.WorkoutSessionsState.data = data.session;
        window.WorkoutSessionsState.originalStatus = data.session.status;

        const sessionData = window.WorkoutSessionsState.data;
        if (sessionData && sessionData.variant_id > 0) {
            try {
                const plannedExercises = await apiCall(`/api/workout/exercises?variant_id=${sessionData.variant_id}`);
                if (Array.isArray(plannedExercises) && plannedExercises.length > 0) {
                    const existingByExerciseID = new Map();
                    window.WorkoutSessionsState.logs.forEach(log => {
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

                    window.WorkoutSessionsState.logs = [...window.WorkoutSessionsState.logs, ...plannedMissingLogs];
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
                onFinish: () => finishWorkoutSession()
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
    }
}

async function deleteExerciseLog(index) {
    const logs = window.WorkoutSessionsState.logs;
    const log = logs[index];
    if (!log) return;

    await safeConfirm(`Remove ${log.exercise_name} from this workout?`, async (ok) => {
        if (!ok) return;

        const logsContainer = document.getElementById('workout-session-logs');

        // Optimistic: splice locally and re-render BEFORE awaiting the network
        // call so the row disappears instantly. Snapshot the removed entry so
        // we can restore on POST failure.
        const removed = logs.splice(index, 1)[0];
        if (logsContainer) renderWorkoutSessionLogs(logsContainer);

        // Unsaved entries (no id) have no backend state to mutate — the local
        // splice above is the whole operation.
        if (!log.id || log.id <= 0) return;

        // Optimistic cache: drop the matching saved row from `workout_history`'s
        // session counts so the History sub-tab repaints with the new exercise
        // count before the DELETE round-trip resolves.
        const historyHandle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
            ? await window.DataStore.applyOptimistic('workout_history', (prev) => {
                if (!prev || !Array.isArray(prev.sessions)) return prev;
                const sessionId = window.WorkoutSessionsState?.data?.id;
                if (!sessionId) return prev;
                const next = { ...prev };
                next.sessions = prev.sessions.map((s) => {
                    if (s?.session?.id !== sessionId) return s;
                    const done = Math.max(0, (s.exercises_completed || 0) - 1);
                    const total = Math.max(done, (s.exercises_count || 0) - 1);
                    return { ...s, exercises_completed: done, exercises_count: total };
                });
                return next;
            }, ['workout'])
            : null;

        try {
            const result = await apiCall(`/api/workout/sessions/logs/delete?id=${log.id}`, 'DELETE');
            if (result === null) {
                // Network/5xx: restore the local row + cached count.
                logs.splice(index, 0, removed);
                if (logsContainer) renderWorkoutSessionLogs(logsContainer);
                if (historyHandle) await historyHandle.rollback();
                return;
            }
            if (historyHandle) await historyHandle.commit(null);
            await invalidateWorkoutCache();
        } catch (error) {
            // Hard failure: restore the local row + cached count, then surface.
            logs.splice(index, 0, removed);
            if (logsContainer) renderWorkoutSessionLogs(logsContainer);
            if (historyHandle) await historyHandle.rollback();
            console.error('Error deleting exercise log:', error);
            safeAlert('Failed to delete exercise log');
        }
    });
}

async function deleteWorkoutSession() {
    const sessionData = window.WorkoutSessionsState.data;
    if (!sessionData) return;
    await safeConfirm('Delete this workout session?', async (ok) => {
        if (ok) {
            const result = await apiCall(`/api/workout/sessions/delete?id=${sessionData.id}`, 'DELETE');
            if (result || result === true) {
                await invalidateWorkoutCache();
                closeWorkoutSessionModal();
                loadWorkoutHistoryTab();
            }
        }
    });
}

async function finishWorkoutSession() {
    if (!window.WorkoutSessionsState.data) return;
    const select = document.getElementById('session-status-select');
    if (select) select.value = 'completed';
    await saveWorkoutSessionDetails();
}

function renderSessionDetailActions(container, opts) {
    container.classList.add('wg-workouts-session-actions');
    container.replaceChildren();

    const onLogSet = (opts && typeof opts.onLogSet === 'function') ? opts.onLogSet : () => {};
    const onFinish = (opts && typeof opts.onFinish === 'function') ? opts.onFinish : () => {};

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
    finishBtn.textContent = 'Finish workout';
    finishBtn.addEventListener('click', () => onFinish());

    container.appendChild(logSetBtn);
    container.appendChild(finishBtn);

    if (typeof window !== 'undefined' && window.SyncManager && window.SyncManager.isOnline === false) {
        [logSetBtn, finishBtn].forEach((btn) => {
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
    window.WorkoutSessionsState.data = null;
    window.WorkoutSessionsState.originalStatus = null;
}

async function saveWorkoutSessionDetails() {
    // Either the top "Save progress" button or the bottom "Finish workout"
    // button can trigger this flow (finishWorkoutSession re-enters here
    // after flipping the status select). Disable both so the unclicked
    // one can't be tapped a second time while the first request is in-flight.
    const topSaveBtn = document.getElementById('workout-session-save-btn');
    const finishBtn = document.getElementById('workout-session-finish-btn');
    const busyTargets = [topSaveBtn, finishBtn].filter(Boolean);
    const feedbackBtn = topSaveBtn || finishBtn;
    if (!feedbackBtn) return;
    const originalText = feedbackBtn.textContent;

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
        feedbackBtn.textContent = 'Saving...';

        // Check if status has changed
        const statusSelect = document.getElementById('session-status-select');
        const newStatus = statusSelect ? statusSelect.value : window.WorkoutSessionsState.originalStatus;
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
        // partial failure (status saved, later log update returns null)
        // leaves workout_history / workout_stats holding the pre-mutation
        // payload until the next manual refresh.
        let anyMutationSucceeded = false;

        // Save status if changed
        if (statusChanged && sessionData) {
            const statusResult = await apiCall(`/api/workout/sessions/status?id=${sessionData.id}`, 'PUT', {
                status: newStatus
            });
            if (statusResult === null) {
                await rollbackOptimistic();
                if (anyMutationSucceeded) await invalidateWorkoutCache();
                return;
            }
            anyMutationSucceeded = true;
        }

        // Save each log — only save new entries that the user actually edited (_dirty)
        for (const log of logs) {
            let logResult;
            let attempted = false;
            if (log.id && log.id > 0) {
                // Existing log — always update
                attempted = true;
                logResult = await apiCall('/api/workout/sessions/logs/update', 'POST', {
                    id: log.id,
                    sets_completed: Math.round(log.sets_completed),
                    reps_completed: Math.round(log.reps_completed),
                    weight_kg: parseFloat(log.weight_kg),
                    notes: log.notes || ''
                });
            } else if (log._dirty) {
                // New log that user actually edited — create it
                attempted = true;
                logResult = await apiCall('/api/workout/sessions/logs/create', 'POST', {
                    session_id: sessionData.id,
                    exercise_id: log.exercise_id,
                    exercise_name: log.exercise_name,
                    target_sets: Math.round(log.sets_completed),
                    target_reps_min: Math.round(log.reps_completed),
                    target_weight_kg: parseFloat(log.weight_kg),
                    status: 'completed',
                    notes: log.notes || ''
                });
            }
            if (attempted && logResult === null) {
                if (!anyMutationSucceeded) await rollbackOptimistic();
                if (anyMutationSucceeded) await invalidateWorkoutCache();
                return;
            }
            if (attempted) anyMutationSucceeded = true;
            // Skip: id===0 && !_dirty — pre-filled but untouched, don't save
        }

        // All requested mutations succeeded — commit the optimistic state
        // (leave it in cache) then invalidate so the next read fetches
        // authoritative server data layered on top.
        for (const h of optimisticHandles) await h.commit(null);
        if (anyMutationSucceeded || optimisticHandles.length > 0) {
            await invalidateWorkoutCache();
        }

        closeWorkoutSessionModal();
        loadWorkoutHistoryTab();
    } catch (error) {
        await rollbackOptimistic();
        console.error('Error saving workout details:', error);
        const message = error.message || 'Error saving workout details. Please try again.';
        safeAlert('❌ ' + message);
    } finally {
        busyTargets.forEach((btn) => {
            btn.classList.remove('wg-btn-saving');
            if (!btn.hasAttribute('data-offline-disabled')) {
                btn.disabled = false;
            }
        });
        feedbackBtn.textContent = originalText;
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
            safeAlert('Failed to start ad-hoc workout');
        }
    } catch (error) {
        if (nextHandle) await nextHandle.rollback();
        console.error('Error starting ad-hoc workout:', error);
        safeAlert('Error starting ad-hoc workout: ' + error.message);
    }
}

async function startWorkoutSession(sessionId) {
    await safeConfirm('Start this workout now?', async (ok) => {
        if (!ok) return;

        try {
            const result = await apiCall(`/api/workout/sessions/${sessionId}/start`, 'POST');
            if (result === null) return;

            // Show success message
            safeAlert('✅ Workout started! You can now log exercises.');

            // Refresh the next workout card
            await invalidateWorkoutCache();
            loadNextWorkout();
        } catch (error) {
            console.error('Error starting workout:', error);
            safeAlert('❌ Failed to start workout. Please try again.');
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
            loadNextWorkout();
            loadWorkoutHistoryTab(); // Refresh history if visible
        } catch (e) {
            for (const h of handles) { try { await h.rollback(); } catch (_) { /* best-effort */ } }
            console.error(e);
            safeAlert('Failed to finish workout');
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
            safeAlert('❌ Failed to mark workout as skipped. Please try again.');
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
        safeAlert('❌ Failed to cancel skip. Please try again.');
    }
}

// ====================================
// ADD EXERCISE TO SESSION
// ====================================

async function showAddExerciseToSessionModal() {
    if (!window.WorkoutSessionsState.data) return;

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
    if (titleEl) titleEl.textContent = val ? `Log set · ${val}` : 'Add exercise';

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
    const sessionData = window.WorkoutSessionsState.data;
    if (!sessionData) return;

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

    // Optimistic: push the new log into the session modal's logs array and
    // re-render BEFORE awaiting the network call, so the row appears
    // instantly. Carries `_optimistic: true` so we can splice it out on
    // POST failure without removing user-edited rows by accident.
    const optimisticLog = {
        id: 0,
        exercise_id: parseInt(exerciseId),
        exercise_name: name,
        sets_completed: sets,
        reps_completed: reps,
        weight_kg: weight == null ? 0 : weight,
        notes: notes,
        status: 'completed',
        _dirty: true,
        _optimistic: true
    };
    const prevLogs = window.WorkoutSessionsState.logs;
    window.WorkoutSessionsState.logs = [...prevLogs, optimisticLog];
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
        // timestamps, any AI-derived fields).
        showWorkoutSessionModal(sessionData.id);
    } catch (error) {
        restoreOptimistic();
        if (historyHandle) await historyHandle.rollback();
        console.error(error);
        safeAlert('Failed to add exercise');
    }
}

window.WorkoutSessions = {
    open: showWorkoutSessionModal,
    close: closeWorkoutSessionModal,
    save: saveWorkoutSessionDetails,
    delete: deleteWorkoutSession,
    finish: finishWorkoutSession,
    renderInfo: renderWorkoutSessionInfo,
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
