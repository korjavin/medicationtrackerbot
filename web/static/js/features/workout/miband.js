// ====================================
// MI BAND WORKOUT — Edit / Delete modal
// ====================================
//
// Holds the currently-displayed Mi-Band entry in a closure (was the
// module-level `let currentMiBandWorkout` in the original file). Exposed
// via window.WorkoutMiBand.getCurrent() if any other concern ever needs
// to read it.

(function () {
    let _currentMiBandWorkout = null;

    window.WorkoutMiBandState = window.WorkoutMiBandState || {};
    Object.defineProperty(window.WorkoutMiBandState, 'current', {
        get: () => _currentMiBandWorkout,
        set: (v) => { _currentMiBandWorkout = v; },
        enumerable: true,
        configurable: true
    });
})();

function showMiBandWorkoutModal(w) {
    window.WorkoutMiBandState.current = w;
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
    window.WorkoutMiBandState.current = null;
    window.ModalManager.mibandWorkout.close();
}

async function saveMiBandWorkout() {
    const current = window.WorkoutMiBandState.current;
    if (!current) return;

    const id = current.id;
    const payload = {};

    const steps = parseInt(document.getElementById('miband-workout-steps').value) || 0;
    const distance = parseFloat(document.getElementById('miband-workout-distance').value) || 0;
    const duration = parseInt(document.getElementById('miband-workout-duration').value) || 0;
    const calories = parseInt(document.getElementById('miband-workout-calories').value) || 0;
    const hr = parseInt(document.getElementById('miband-workout-hr').value) || 0;
    const spo2 = parseInt(document.getElementById('miband-workout-spo2').value) || 0;

    if (steps !== current.steps) payload.steps = steps;
    if (distance !== current.distance_m) payload.distance_m = distance;
    if (duration !== current.duration_sec) payload.duration_sec = duration;
    if (calories !== current.calories) payload.calories = calories;
    if (hr !== current.heart_rate_avg) payload.heart_rate_avg = hr;
    if (spo2 !== current.spo2_avg) payload.spo2_avg = spo2;

    if (Object.keys(payload).length === 0) {
        closeMiBandWorkoutModal();
        return;
    }

    try {
        const result = await apiCall(`/api/workout/miband/${id}`, 'PATCH', payload);
        if (result || result === true) {
            await invalidateWorkoutCache();
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
    if (!window.WorkoutMiBandState.current) return;
    await safeConfirm('Delete this workout?', async (ok) => {
        if (ok) {
            await _deleteMiBandWorkoutApi();
        }
    });
}

async function _deleteMiBandWorkoutApi() {
    const current = window.WorkoutMiBandState.current;
    try {
        const result = await apiCall(`/api/workout/miband/${current.id}`, 'DELETE');
        if (result || result === true) {
            await invalidateWorkoutCache();
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

window.WorkoutMiBand = {
    open: showMiBandWorkoutModal,
    close: closeMiBandWorkoutModal,
    save: saveMiBandWorkout,
    delete: deleteMiBandWorkout
};
