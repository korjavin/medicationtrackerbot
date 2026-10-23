// Push-notification modal coordination state extracted from app.js
// (Plan 2026-05-13, Task 4).
//
// Five top-level `var`s in app.js (pendingMedConfirmIds,
// pendingMedConfirmScheduled, pendingWorkoutSessionId, pendingMedConfirmMode,
// pendingMedConfirmIntakeIds) coordinated two unrelated push modals — the
// medication-confirm modal and the workout-start modal — with no API
// boundary and an implicit "at most one open at a time" invariant that was
// only honoured because ModalManager closes one when another opens.
//
// PushModalState collapses the five vars into closure-private fields behind
// open/close-style methods that enforce the invariant explicitly: opening
// the medication modal clears the workout sessionId (and vice versa), so a
// stale snooze/skip click after switching modals cannot fire against the
// previous modal's data.
//
// Public surface:
//   - PushModalState.openMedConfirm({ ids, names, scheduled, mode, intakeIds })
//   - PushModalState.openWorkoutStart({ sessionId })
//   - PushModalState.clear()
//   - PushModalState.getMedConfirmIds()
//   - PushModalState.getMedConfirmNames()
//   - PushModalState.getMedConfirmScheduled()
//   - PushModalState.getMedConfirmMode()
//   - PushModalState.getMedConfirmIntakeIds()
//   - PushModalState.getWorkoutSessionId()

window.PushModalState = (function () {
    let _state = {
        medConfirmIds: [],
        medConfirmNames: [],
        medConfirmScheduled: null,
        medConfirmMode: 'confirm',
        medConfirmIntakeIds: [],
        workoutSessionId: null,
    }; // module-state: push-modal coordination; invariants documented above

    function openMedConfirm({ ids, names, scheduled, mode, intakeIds } = {}) {
        // Opening the med modal clears any prior workout pending — the two
        // share the same modal slot in production (ModalManager.workoutStart
        // closes when ModalManager.medConfirm opens), so a stale workout
        // sessionId is never the right target for a follow-up snooze/skip.
        _state.medConfirmIds = Array.isArray(ids) ? ids.slice() : [];
        _state.medConfirmNames = Array.isArray(names) ? names.slice() : [];
        _state.medConfirmScheduled = scheduled == null ? null : scheduled;
        _state.medConfirmMode = mode || 'confirm';
        _state.medConfirmIntakeIds = Array.isArray(intakeIds) ? intakeIds.slice() : [];
        _state.workoutSessionId = null;
    }

    function openWorkoutStart({ sessionId } = {}) {
        _state.workoutSessionId = sessionId == null ? null : sessionId;
        _state.medConfirmIds = [];
        _state.medConfirmNames = [];
        _state.medConfirmScheduled = null;
        _state.medConfirmMode = 'confirm';
        _state.medConfirmIntakeIds = [];
    }

    function clear() {
        _state.medConfirmIds = [];
        _state.medConfirmNames = [];
        _state.medConfirmScheduled = null;
        _state.medConfirmMode = 'confirm';
        _state.medConfirmIntakeIds = [];
        _state.workoutSessionId = null;
    }

    function getMedConfirmIds() { return _state.medConfirmIds; }
    function getMedConfirmNames() { return _state.medConfirmNames; }
    function getMedConfirmScheduled() { return _state.medConfirmScheduled; }
    function getMedConfirmMode() { return _state.medConfirmMode; }
    function getMedConfirmIntakeIds() { return _state.medConfirmIntakeIds; }
    function getWorkoutSessionId() { return _state.workoutSessionId; }

    function _resetForTesting() {
        _state.medConfirmIds = [];
        _state.medConfirmNames = [];
        _state.medConfirmScheduled = null;
        _state.medConfirmMode = 'confirm';
        _state.medConfirmIntakeIds = [];
        _state.workoutSessionId = null;
    }

    return {
        openMedConfirm,
        openWorkoutStart,
        clear,
        getMedConfirmIds,
        getMedConfirmNames,
        getMedConfirmScheduled,
        getMedConfirmMode,
        getMedConfirmIntakeIds,
        getWorkoutSessionId,
        _resetForTesting,
    };
})();
