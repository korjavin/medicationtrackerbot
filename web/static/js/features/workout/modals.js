// ====================================
// WORKOUT START MODAL — push-notification action sheet
// ====================================
//
// Owns the "workout start" push-notification modal flow extracted from app.js
// (Plan 2026-06-10 finish-app-js-split, Task 4). A workout_start push deep-link
// (handlePushAction in app.js) opens this modal; the action buttons let the
// user jump into the session, snooze it, skip it, or dismiss the sheet.
//
// Bare function declarations stay the live call path: app.js's
// bindNotificationControls binds the modal buttons via call-time arrow wrappers
// (workout-start-{now,snooze-60,snooze-120,skip,dismiss}-btn) and handlePushAction
// calls showWorkoutStartModal directly, so these names must remain window globals.
// window.WorkoutModals mirrors the public surface for documentation / discovery.
//
// No module-level mutable state: the pending session id lives on
// window.PushModalState (features/push-modal.js), enforcing the "at most one
// push modal open at a time" invariant.

function showWorkoutStartModal(sessionId) {
    window.PushModalState.openWorkoutStart({ sessionId });
    window.ModalManager.workoutStart.open();
}

function closeWorkoutStartModal() {
    window.ModalManager.workoutStart.close();
}

function startWorkoutFromModal() {
    closeWorkoutStartModal();
    switchTab('workouts');
}

async function snoozeWorkout(minutes) {
    const sessionId = window.PushModalState.getWorkoutSessionId();
    if (!sessionId) return;
    const btn = document.getElementById(`workout-start-snooze-${minutes}-btn`);
    await withSubmit(btn, async () => {
        // Optimistic: stamp snoozed_until on the cached workout_next.session so
        // the next-card hides the "Start" CTA while we wait on the POST.
        const snoozeUntilIso = new Date(Date.now() + minutes * 60 * 1000).toISOString();
        const handle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
            ? await window.DataStore.applyOptimistic('workout_next', (prev) => {
                if (!prev || !prev.session || prev.session.id !== sessionId) return prev;
                return {
                    ...prev,
                    session: {
                        ...prev.session,
                        snoozed_until: snoozeUntilIso,
                        is_snoozed: true
                    }
                };
            }, ['workout'])
            : null;

        try {
            const res = await apiCall(`/api/workout/sessions/${sessionId}/snooze`, 'POST', { minutes: minutes });
            if (res) {
                if (handle) await handle.commit(null);
                if (typeof invalidateWorkoutCache === 'function') {
                    await invalidateWorkoutCache();
                } else if (window.DataStore?.invalidateTags) {
                    await window.DataStore.invalidateTags(['workout']);
                }
                safeAlert(`Snoozed for ${minutes} minutes`);
            } else if (handle) {
                await handle.rollback();
            }
        } catch (error) {
            if (handle) await handle.rollback();
            throw error;
        }
        closeWorkoutStartModal();
    });
}

async function skipWorkout() {
    const sessionId = window.PushModalState.getWorkoutSessionId();
    if (!sessionId) return;
    await safeConfirm("Are you sure you want to skip this workout?", async (ok) => {
        if (!ok) return;

        // Optimistic: null workout_next so the home card vanishes immediately.
        const handle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
            ? await window.DataStore.applyOptimistic('workout_next', (prev) => {
                if (prev?.session?.id === sessionId) return { session: null };
                return prev;
            }, ['workout'])
            : null;

        try {
            const res = await apiCall(`/api/workout/sessions/${sessionId}/skip`, 'POST');
            if (res) {
                if (handle) await handle.commit(null);
                if (typeof invalidateWorkoutCache === 'function') {
                    await invalidateWorkoutCache();
                } else if (window.DataStore?.invalidateTags) {
                    await window.DataStore.invalidateTags(['workout']);
                }
                safeAlert("Workout skipped");
                loadWorkouts();
            } else if (handle) {
                await handle.rollback();
            }
        } catch (error) {
            if (handle) await handle.rollback();
            throw error;
        }
        closeWorkoutStartModal();
    });
}

async function skipWorkoutFromModal() {
    await skipWorkout();
}

window.WorkoutModals = {
    show: showWorkoutStartModal,
    close: closeWorkoutStartModal,
    start: startWorkoutFromModal,
    snooze: snoozeWorkout,
    skip: skipWorkout,
    skipFromModal: skipWorkoutFromModal
};
