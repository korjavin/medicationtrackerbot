(function () {
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

        // Legacy proxy objects for compatibility with existing tests and code.
        bp: {
            open() { window.ModalManager.open('bp-modal'); },
            close() { window.ModalManager.close('bp-modal'); }
        },
        weight: {
            open() { window.ModalManager.open('weight-modal'); },
            close() { window.ModalManager.close('weight-modal'); }
        },
        food: {
            open() { window.ModalManager.open('food-modal'); },
            close() {
                if (typeof window.closeFoodScannerModal === 'function') window.closeFoodScannerModal();
                window.ModalManager.close('food-modal');
            }
        },
        med: {
            open() { window.ModalManager.open('med-modal'); },
            close() { window.ModalManager.close('med-modal'); }
        },
        medConfirm: {
            open() { window.ModalManager.open('med-confirm-modal'); },
            close() { window.ModalManager.close('med-confirm-modal'); }
        },
        workoutStart: {
            open() { window.ModalManager.open('workout-start-modal'); },
            close() { window.ModalManager.close('workout-start-modal'); }
        },
        workoutGroup: {
            open() { window.ModalManager.open('workout-group-modal'); },
            close() { window.ModalManager.close('workout-group-modal'); }
        },
        workoutVariant: {
            open() { window.ModalManager.open('workout-variant-modal'); },
            close() { window.ModalManager.close('workout-variant-modal'); }
        },
        workoutExercise: {
            open() { window.ModalManager.open('workout-exercise-modal'); },
            close() { window.ModalManager.close('workout-exercise-modal'); }
        },
        exerciseLibrary: {
            open() { window.ModalManager.open('exercise-library-modal'); },
            close() { window.ModalManager.close('exercise-library-modal'); }
        },
        workoutSession: {
            open() { window.ModalManager.open('workout-session-modal'); },
            close() { window.ModalManager.close('workout-session-modal'); }
        },
        workoutAddExerciseToSession: {
            open() { window.ModalManager.open('workout-add-exercise-to-session-modal'); },
            close() { window.ModalManager.close('workout-add-exercise-to-session-modal'); }
        },
        foodProduct: {
            open() { window.ModalManager.open('food-product-modal'); },
            close() { window.ModalManager.close('food-product-modal'); }
        },
        foodScanner: {
            open() {
                window.ModalManager.open('food-scanner-modal');
                if (typeof window.setFoodScannerStatus === 'function') window.setFoodScannerStatus('Point camera at barcode or QR.');
                if (typeof window.startFoodScanner === 'function') window.startFoodScanner();
            },
            close() {
                if (typeof window.stopFoodScanner === 'function') window.stopFoodScanner();
                window.ModalManager.close('food-scanner-modal');
            }
        },

        getTopModalDefs() {
            return [
                { id: 'med-modal', fn: () => window.ModalManager.close('med-modal') },
                { id: 'med-confirm-modal', fn: () => window.ModalManager.close('med-confirm-modal') },
                { id: 'bp-modal', fn: () => window.ModalManager.close('bp-modal') },
                { id: 'weight-modal', fn: () => window.ModalManager.close('weight-modal') },
                { id: 'food-modal', fn: () => { if (typeof window.closeFoodScannerModal === 'function') window.closeFoodScannerModal(); window.ModalManager.close('food-modal'); } },
                { id: 'workout-group-modal', fn: () => typeof window.closeWorkoutGroupModal === 'function' ? window.closeWorkoutGroupModal() : window.ModalManager.close('workout-group-modal') },
                { id: 'workout-variant-modal', fn: () => typeof window.closeVariantModal === 'function' ? window.closeVariantModal() : window.ModalManager.close('workout-variant-modal') },
                { id: 'workout-exercise-modal', fn: () => typeof window.closeExerciseModal === 'function' ? window.closeExerciseModal() : window.ModalManager.close('workout-exercise-modal') },
                { id: 'exercise-library-modal', fn: () => typeof window.closeExerciseLibraryModal === 'function' ? window.closeExerciseLibraryModal() : window.ModalManager.close('exercise-library-modal') },
                { id: 'workout-session-modal', fn: () => typeof window.closeWorkoutSessionModal === 'function' ? window.closeWorkoutSessionModal() : window.ModalManager.close('workout-session-modal') },
                { id: 'workout-start-modal', fn: () => window.ModalManager.close('workout-start-modal') },
            ];
        },

        getSubModalDefs() {
            return [
                { id: 'workout-add-exercise-to-session-modal', fn: () => typeof window.closeAddExerciseToSessionModal === 'function' ? window.closeAddExerciseToSessionModal() : window.ModalManager.close('workout-add-exercise-to-session-modal') },
                { id: 'food-scanner-modal', fn: () => { if (typeof window.stopFoodScanner === 'function') window.stopFoodScanner(); window.ModalManager.close('food-scanner-modal'); } },
                { id: 'food-product-modal', fn: () => window.ModalManager.close('food-product-modal') },
            ];
        },

        getClosePriorityModalDefs() {
            return [...window.ModalManager.getSubModalDefs(), ...window.ModalManager.getTopModalDefs()];
        },

        closeTopMostVisibleModal() {
            for (const modalDef of window.ModalManager.getClosePriorityModalDefs()) {
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

    (function bindOverlayBackdrop() {
        function setup() {
            const overlay = document.getElementById('modal-overlay');
            if (!overlay) return;
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) window.ModalManager.closeTopMostVisibleModal();
            });
        }
        document.readyState === 'loading'
            ? document.addEventListener('DOMContentLoaded', setup, { once: true })
            : setup();
    })();

    window.switchTab = function (tab) {
        document.querySelectorAll('.tab').forEach((el) => {
            if (el.dataset.tab === tab) {
                el.classList.add('active');
            } else {
                el.classList.remove('active');
            }
        });

        document.querySelectorAll('.view').forEach((el) => {
            if (el.id === `${tab}-view`) {
                el.classList.add('active');
            } else {
                el.classList.remove('active');
            }
        });

        // Initialize/Reload tab data
        if (tab === 'meds') {
            const activeMedTab = document.querySelector('.med-tab.active');
            if (activeMedTab) {
                if (typeof window.switchMedTab === 'function') window.switchMedTab(activeMedTab.dataset.tab);
            } else {
                if (typeof window.switchMedTab === 'function') window.switchMedTab('history');
            }
        }
        else if (tab === 'bp') { if (typeof window.loadBPReadings === 'function') window.loadBPReadings(); }
        else if (tab === 'weight') { if (typeof window.loadWeightLogs === 'function') window.loadWeightLogs(); }
        else if (tab === 'workouts') { if (typeof window.loadWorkouts === 'function') window.loadWorkouts(); }
        else if (tab === 'food') { if (typeof window.loadFoodLogs === 'function') window.loadFoodLogs(); }
        else if (tab === 'health') { if (typeof window.loadHealthOverview === 'function') window.loadHealthOverview(); }
        else if (tab === 'settings') { if (typeof window.loadSettings === 'function') window.loadSettings(); }
    };
})();
