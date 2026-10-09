// ModalManager — central open/close registry for all modals in the app.
// Loaded before app.js. Domain-specific close helpers (closeFoodScannerModal,
// closeWorkoutSessionModal, etc.) are defined in app.js/workout.js and accessed
// lazily at call time via the global scope.
//
// Stack (med-xso6.8): open() pushes the modal id, close() removes it, and the
// shared #modal-overlay hides only once nothing on the stack is still visible.
// Back / Esc / popstate all go through closeTopMostVisibleModal(), which closes
// the most recently opened visible modal through its registered close function
// (register(id, fn); a modal without one just gets close(id)). A close function
// may refuse or finish later (the workout session awaits its autosave): the id
// leaves the stack only when close(id) actually runs.

const ModalManager = {
    _stack: [],
    _closers: {},

    // A falsy closeFn unregisters (dynamic modals such as WGPage on removal).
    register(modalId, closeFn) {
        if (closeFn) ModalManager._closers[modalId] = closeFn;
        else delete ModalManager._closers[modalId];
    },

    _isVisible(modalId) {
        const modal = document.getElementById(modalId);
        return !!modal && !modal.classList.contains('hidden');
    },

    // Drops ids whose modal was hidden behind ModalManager's back (a raw
    // modal.close() / classList toggle) so they never pin the overlay.
    _visibleStack() {
        ModalManager._stack = ModalManager._stack.filter(ModalManager._isVisible);
        return ModalManager._stack;
    },

    // opts.overlay === false: a sub-modal that stacks over its parent without
    // touching #modal-overlay (food scanner / product).
    open(modalId, opts) {
        if (!opts || opts.overlay !== false) {
            const overlay = document.getElementById('modal-overlay');
            if (overlay) overlay.classList.remove('hidden');
        }

        const modal = document.getElementById(modalId);
        if (!modal) return;
        ModalManager._stack = ModalManager._stack.filter((id) => id !== modalId);
        ModalManager._stack.push(modalId);
        if (typeof modal.open === 'function') {
            modal.open();
        } else {
            modal.classList.remove('hidden');
        }
    },

    close(modalId) {
        ModalManager._stack = ModalManager._stack.filter((id) => id !== modalId);
        const modal = document.getElementById(modalId);
        if (modal) {
            if (typeof modal.close === 'function') {
                modal.close();
            } else {
                modal.classList.add('hidden');
            }
        }
        // A parent still open under this child keeps the overlay.
        if (ModalManager._visibleStack().length === 0) {
            const overlay = document.getElementById('modal-overlay');
            if (overlay) overlay.classList.add('hidden');
        }
    },

    closeTop() {
        return ModalManager.closeTopMostVisibleModal();
    },

    bp: {
        open() {
            ModalManager.open('bp-modal');
        },
        close() {
            ModalManager.close('bp-modal');
        }
    },

    weight: {
        open() {
            ModalManager.open('weight-modal');
        },
        close() {
            ModalManager.close('weight-modal');
        }
    },

    note: {
        open() {
            ModalManager.open('note-modal');
        },
        close() {
            ModalManager.close('note-modal');
        }
    },

    food: {
        open() {
            ModalManager.open('food-modal');
        },
        close() {
            if (typeof closeFoodScannerModal === 'function') {
                closeFoodScannerModal();
            }
            ModalManager.close('food-modal');
        }
    },

    med: {
        open() {
            ModalManager.open('med-modal');
        },
        close() {
            ModalManager.close('med-modal');
        }
    },

    medConfirm: {
        open() {
            ModalManager.open('med-confirm-modal');
        },
        close() {
            ModalManager.close('med-confirm-modal');
        }
    },

    workoutStart: {
        open() {
            ModalManager.open('workout-start-modal');
        },
        close() {
            ModalManager.close('workout-start-modal');
        }
    },

    workoutScan: {
        open() {
            ModalManager.open('workout-scan-modal');
        },
        close() {
            ModalManager.close('workout-scan-modal');
        }
    },

    workoutShare: {
        open() {
            ModalManager.open('workout-share-modal');
        },
        close() {
            ModalManager.close('workout-share-modal');
        }
    },

    workoutShareImport: {
        open() {
            ModalManager.open('workout-share-import-modal');
        },
        close() {
            ModalManager.close('workout-share-import-modal');
        }
    },

    exerciseLibrary: {
        open() {
            ModalManager.open('exercise-library-modal');
        },
        close() {
            ModalManager.close('exercise-library-modal');
        }
    },

    workoutEquipment: {
        open() {
            ModalManager.open('workout-equipment-modal');
        },
        close() {
            ModalManager.close('workout-equipment-modal');
        }
    },

    workoutSession: {
        open() {
            ModalManager.open('workout-session-modal');
        },
        close() {
            ModalManager.close('workout-session-modal');
        }
    },

    mibandWorkout: {
        open() {
            ModalManager.open('miband-workout-modal');
        },
        close() {
            ModalManager.close('miband-workout-modal');
        }
    },

    workoutAddExerciseToSession: {
        open() {
            ModalManager.open('workout-add-exercise-to-session-modal');
        },
        close() {
            ModalManager.close('workout-add-exercise-to-session-modal');
        }
    },

    foodProduct: {
        open() {
            ModalManager.open('food-product-modal', { overlay: false });
        },
        close() {
            ModalManager.close('food-product-modal');
        }
    },

    foodScanner: {
        open() {
            if (!document.getElementById('food-scanner-modal')) return;
            ModalManager.open('food-scanner-modal', { overlay: false });
            setFoodScannerStatus('Point camera at barcode or QR.');
            startFoodScanner();
        },
        close() {
            stopFoodScanner();
            ModalManager.close('food-scanner-modal');
        }
    },

    getTopModalDefs() {
        return [
            { id: 'med-modal', fn: () => ModalManager.med.close() },
            { id: 'med-confirm-modal', fn: () => ModalManager.medConfirm.close() },
            { id: 'bp-modal', fn: () => ModalManager.bp.close() },
            { id: 'weight-modal', fn: () => ModalManager.weight.close() },
            { id: 'note-modal', fn: () => ModalManager.note.close() },
            { id: 'food-modal', fn: () => ModalManager.food.close() },
            { id: 'workout-scan-modal', fn: () => typeof closeWorkoutScanModal === 'function' ? closeWorkoutScanModal() : ModalManager.workoutScan.close() },
            { id: 'workout-share-modal', fn: () => (window.WorkoutShare && typeof window.WorkoutShare.close === 'function') ? window.WorkoutShare.close() : ModalManager.workoutShare.close() },
            { id: 'workout-share-import-modal', fn: () => (window.WorkoutShare && typeof window.WorkoutShare.closeImport === 'function') ? window.WorkoutShare.closeImport() : ModalManager.workoutShareImport.close() },
            { id: 'exercise-library-modal', fn: () => typeof closeExerciseLibraryModal === 'function' ? closeExerciseLibraryModal() : ModalManager.exerciseLibrary.close() },
            { id: 'workout-equipment-modal', fn: () => typeof closeWorkoutEquipmentModal === 'function' ? closeWorkoutEquipmentModal() : ModalManager.workoutEquipment.close() },
            { id: 'workout-session-modal', fn: () => typeof closeWorkoutSessionModal === 'function' ? closeWorkoutSessionModal() : ModalManager.workoutSession.close() },
            { id: 'miband-workout-modal', fn: () => typeof closeMiBandWorkoutModal === 'function' ? closeMiBandWorkoutModal() : ModalManager.mibandWorkout.close() },
            { id: 'workout-start-modal', fn: () => ModalManager.workoutStart.close() },
        ];
    },

    getSubModalDefs() {
        return [
            { id: 'workout-add-exercise-to-session-modal', fn: () => typeof closeAddExerciseToSessionModal === 'function' ? closeAddExerciseToSessionModal() : ModalManager.workoutAddExerciseToSession.close() },
            { id: 'food-scanner-modal', fn: () => ModalManager.foodScanner.close() },
            { id: 'food-product-modal', fn: () => ModalManager.foodProduct.close() },
        ];
    },

    getClosePriorityModalDefs() {
        return [...ModalManager.getSubModalDefs(), ...ModalManager.getTopModalDefs()];
    },

    // The in-page dialog (safeConfirm/safePrompt/safeChoose, core/utils.js)
    // mounts on <body>, outside #modal-overlay. These two predicates are the
    // single answer to "is something modal open?" for modal-history.js and
    // back-button.js (bd med-62lh).
    isDialogOpen() {
        return !!document.querySelector('mt-modal.mt-confirm-modal');
    },

    isAnyOpen() {
        const overlay = document.getElementById('modal-overlay');
        return (!!overlay && !overlay.classList.contains('hidden'))
            || ModalManager.isDialogOpen()
            || ModalManager._visibleStack().length > 0;
    },

    closeTopMostVisibleModal() {
        // The in-page dialog sits above every registered modal: Back cancels
        // it first. The last-mounted one is the topmost.
        const cancels = document.querySelectorAll('mt-modal.mt-confirm-modal .mt-confirm-modal__cancel');
        if (cancels.length) {
            cancels[cancels.length - 1].click();
            return true;
        }
        // Most recently opened first: the real top, whatever the modal.
        const stack = ModalManager._visibleStack();
        if (stack.length) {
            const id = stack[stack.length - 1];
            const fn = ModalManager._closers[id];
            if (typeof fn === 'function') fn();
            else ModalManager.close(id);
            return true;
        }
        // Shown without ModalManager.open: the legacy priority list, then any
        // other visible <mt-modal> (Settings invite / delete-account) — so Esc
        // and Back close every modal, registered or not (med-xso6.34).
        for (const modalDef of ModalManager.getClosePriorityModalDefs()) {
            const modal = document.getElementById(modalDef.id);
            if (modal && !modal.classList.contains('hidden')) {
                modalDef.fn();
                return true;
            }
        }
        const loose = document.querySelectorAll('mt-modal:not(.hidden):not(.mt-confirm-modal)');
        if (loose.length) {
            const modal = loose[loose.length - 1];
            if (typeof modal.close === 'function') modal.close();
            else modal.classList.add('hidden');
            return true;
        }
        return false;
    }
};

// The legacy close-priority lists are the initial registrations.
ModalManager.getClosePriorityModalDefs().forEach((d) => ModalManager.register(d.id, d.fn));

// Esc = Back for modals (med-xso6.34): one shared handler closes the topmost
// modal, whichever it is. In-page dialogs handle Esc themselves in the capture
// phase and preventDefault, so a dialog's Esc never also closes its parent.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
    if (ModalManager.closeTopMostVisibleModal()) e.preventDefault();
});

window.ModalManager = ModalManager;
