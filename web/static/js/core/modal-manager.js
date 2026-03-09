// ModalManager — central open/close registry for all modals in the app.
// Loaded before app.js. Domain-specific close helpers (closeFoodScannerModal,
// closeWorkoutGroupModal, etc.) are defined in app.js/workout.js and accessed
// lazily at call time via the global scope.

const ModalManager = {
    open(modalId) {
        const overlay = document.getElementById('modal-overlay');
        if (overlay) overlay.classList.remove('hidden');

        const modal = document.getElementById(modalId);
        if (!modal) return;
        if (typeof modal.open === 'function') {
            modal.open();
        } else {
            modal.classList.remove('hidden');
        }
    },

    close(modalId) {
        const overlay = document.getElementById('modal-overlay');
        if (overlay) overlay.classList.add('hidden');

        const modal = document.getElementById(modalId);
        if (!modal) return;
        if (typeof modal.close === 'function') {
            modal.close();
        } else {
            modal.classList.add('hidden');
        }
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

    workoutGroup: {
        open() {
            ModalManager.open('workout-group-modal');
        },
        close() {
            ModalManager.close('workout-group-modal');
        }
    },

    workoutVariant: {
        open() {
            ModalManager.open('workout-variant-modal');
        },
        close() {
            ModalManager.close('workout-variant-modal');
        }
    },

    workoutExercise: {
        open() {
            ModalManager.open('workout-exercise-modal');
        },
        close() {
            ModalManager.close('workout-exercise-modal');
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
            document.getElementById('modal-overlay').classList.remove('hidden');
            const modal = document.getElementById('workout-add-exercise-to-session-modal');
            if (!modal) return;
            if (typeof modal.open === 'function') {
                modal.open();
            } else {
                modal.classList.remove('hidden');
            }
        },
        close() {
            const modal = document.getElementById('workout-add-exercise-to-session-modal');
            if (!modal) return;
            if (typeof modal.close === 'function') {
                modal.close();
            } else {
                modal.classList.add('hidden');
            }
        }
    },

    foodProduct: {
        open() {
            const modal = document.getElementById('food-product-modal');
            if (modal && typeof modal.open === 'function') {
                modal.open();
            } else if (modal) {
                modal.classList.remove('hidden');
            }
        },
        close() {
            const modal = document.getElementById('food-product-modal');
            if (modal && typeof modal.close === 'function') {
                modal.close();
            } else if (modal) {
                modal.classList.add('hidden');
            }
        }
    },

    foodScanner: {
        open() {
            const scannerModal = document.getElementById('food-scanner-modal');
            if (!scannerModal) return;
            if (typeof scannerModal.open === 'function') {
                scannerModal.open();
            } else {
                scannerModal.classList.remove('hidden');
            }
            setFoodScannerStatus('Point camera at barcode or QR.');
            startFoodScanner();
        },
        close() {
            stopFoodScanner();
            const scannerModal = document.getElementById('food-scanner-modal');
            if (!scannerModal) return;
            if (typeof scannerModal.close === 'function') {
                scannerModal.close();
            } else {
                scannerModal.classList.add('hidden');
            }
        }
    },

    getTopModalDefs() {
        return [
            { id: 'med-modal', fn: () => ModalManager.med.close() },
            { id: 'med-confirm-modal', fn: () => ModalManager.medConfirm.close() },
            { id: 'bp-modal', fn: () => ModalManager.bp.close() },
            { id: 'weight-modal', fn: () => ModalManager.weight.close() },
            { id: 'food-modal', fn: () => ModalManager.food.close() },
            { id: 'workout-group-modal', fn: () => typeof closeWorkoutGroupModal === 'function' ? closeWorkoutGroupModal() : ModalManager.workoutGroup.close() },
            { id: 'workout-variant-modal', fn: () => typeof closeVariantModal === 'function' ? closeVariantModal() : ModalManager.workoutVariant.close() },
            { id: 'workout-exercise-modal', fn: () => typeof closeExerciseModal === 'function' ? closeExerciseModal() : ModalManager.workoutExercise.close() },
            { id: 'exercise-library-modal', fn: () => typeof closeExerciseLibraryModal === 'function' ? closeExerciseLibraryModal() : ModalManager.exerciseLibrary.close() },
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
            { id: 'food-save-meal-modal', fn: () => typeof closeFoodSaveMealModal === 'function' ? closeFoodSaveMealModal() : ModalManager.close('food-save-meal-modal') },
        ];
    },

    getClosePriorityModalDefs() {
        return [...ModalManager.getSubModalDefs(), ...ModalManager.getTopModalDefs()];
    },

    closeTopMostVisibleModal() {
        for (const modalDef of ModalManager.getClosePriorityModalDefs()) {
            const modal = document.getElementById(modalDef.id);
            if (modal && !modal.classList.contains('hidden')) {
                modalDef.fn();
                return true;
            }
        }
        return false;
    }
};

window.ModalManager = ModalManager;
