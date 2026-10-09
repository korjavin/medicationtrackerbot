// ====================================
// WORKOUT — Orchestrator
// ====================================
//
// Thin orchestrator for the Workouts section. Owns:
//   - sub-tab routing (history / groups / exercises / stats / equipment)
//   - workout-cache invalidation helper
//   - top-level controls binding (modal buttons, day-selectors)
//
// Module-level mutable state is forbidden in the extracted feature files; the
// 6 "currently editing" globals from the original workout.js are eliminated by
// each owner file storing them in a closure and exposing read/write accessors
// on window.WorkoutEdit (see groups.js / variants.js / exercises.js).
//
// Load order: this file MUST be loaded last in the workout sub-tree because it
// depends on functions declared in groups.js / variants.js / exercises.js /
// library.js / equipment.js / history.js / miband.js / sessions.js / stats.js /
// next-card.js.

// Workout-tag registration happens at boot via CacheKeys.registerAll() — see
// web/static/js/core/cache-keys.js for the single source of truth.

async function invalidateWorkoutCache() {
    if (window.DataStore?.invalidateTags) {
        await window.DataStore.invalidateTags(['workout']);
    }
    if (window.MedTrackerDB?.WorkoutStore?.clearCache) {
        try { await window.MedTrackerDB.WorkoutStore.clearCache(); } catch (_) { /* best-effort */ }
    }
}

// ====================================
// TAB SWITCHING
// ====================================

// Sub-tab state (Phase 7, Task 2; med-niix.3 adds `equipment`). Mirrors the
// `mt-meds-subtab` / `mt-food-subtab` pattern — one of five values
// (`history`, `groups`, `exercises`, `stats`, `equipment`), persisted to
// localStorage so the user's choice survives reload. Default is `history`.
const WORKOUTS_SUBTAB_STORAGE_KEY = 'mt-workouts-subtab';
const WORKOUTS_SUBTAB_OPTIONS = ['history', 'groups', 'exercises', 'stats', 'equipment'];
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

function restoreWorkoutsSubTab() {
    window.TabController.syncPressed('.workout-tab', getActiveWorkoutsSubTab());
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restoreWorkoutsSubTab, { once: true });
} else {
    restoreWorkoutsSubTab();
}

function switchWorkoutTab(tab) {
    const activated = window.TabController.activateTabGroup(tab, {
        buttonSelector: '.workout-tab',
        contentSelector: '.workout-tab-content',
        contentIdFromTab: (tabName) => `workout-${tabName}-tab`
    });
    if (!activated) return;

    if (typeof setActiveWorkoutsSubTab === 'function') setActiveWorkoutsSubTab(tab);
    // "Add plan" is the Plans screen's app-bar primary.
    const addPlan = document.getElementById('add-workout-group-btn');
    if (addPlan) addPlan.hidden = tab !== 'groups';

    if (tab === 'groups') { loadWorkoutGroups(); }
    else if (tab === 'history') { loadNextWorkout(); loadWorkoutHistoryTab(); }
    else if (tab === 'exercises') { loadExerciseLibrary(); }
    else if (tab === 'stats') { loadWorkoutStatsTab(); }
    else if (tab === 'equipment') { loadWorkoutEquipment(); }
}

window.TabController.bindTabGroup({
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

(function () {
    let workoutControlsBound = false;

    function bindWorkoutControls() {
        if (workoutControlsBound) return;
        workoutControlsBound = true;

        const bindClick = (id, handler) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', handler);
        };

        // med-2fc: no static ad-hoc Start button any more — the next-workout
        // card renders its own `Ad hoc` action and wires it directly.
        bindClick('add-workout-group-btn', () => openWorkoutPlanPage(null));
        bindClick('add-exercise-library-btn', () => showExerciseLibraryModal());

        // Sheet scan-back review (bd med-qj4.9). Guarded: scan.js loads after
        // groups.js, and the Scan row only shows in cloud mode.
        bindClick('workout-scan-cancel-btn', () => { if (window.WorkoutScan) window.WorkoutScan.close(); });
        bindClick('workout-scan-confirm-btn', () => { if (window.WorkoutScan) window.WorkoutScan.confirm(); });

        // Plan editor pages (med-xso6.22): Plan → Day → Exercise.
        document.querySelectorAll('.wg-workout-pages > [data-workout-page]').forEach(bindWorkoutPageControls);
        bindClick('add-variant-btn', () => addWorkoutPlanDay());
        bindClick('add-flat-exercise-btn', () => addWorkoutFlatExercise());
        bindClick('workout-group-notification-row', () => chooseWorkoutNotification());
        bindClick('workout-group-share-btn', () => shareOpenWorkoutPlan());
        bindClick('workout-group-print-btn', () => printOpenWorkoutPlan());
        bindClick('workout-group-scan-btn', () => scanOpenWorkoutPlan());
        bindClick('workout-group-delete-btn', () => deleteOpenWorkoutPlan());
        bindClick('variant-add-exercise-btn', () => addExerciseToWorkoutDay());
        bindClick('workout-exercise-equipment-row', () => chooseWorkoutExerciseEquipment());
        bindClick('workout-exercise-suggest-apply', () => applySuggestedWeight());

        const librarySearch = document.getElementById('exercise-library-search');
        if (librarySearch) {
            librarySearch.addEventListener('input', () => setExerciseLibraryQuery(librarySearch.value));
        }
        const librarySource = document.getElementById('exercise-library-source');
        if (librarySource) {
            librarySource.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-source]');
                if (btn) setExerciseLibrarySource(btn.dataset.source);
            });
        }

        bindClick('exercise-library-cancel-btn', () => closeExerciseLibraryModal());
        bindClick('exercise-library-save-btn', () => saveExerciseLibraryItem());

        bindClick('workout-session-cancel-btn', () => closeWorkoutSessionModal());
        // "+ Exercise" lives in the overview (rendered with its own handler).
        bindClick('workout-session-prog', () => toggleWorkoutSessionOverview());

        bindClick('session-add-exercise-cancel-btn', () => closeAddExerciseToSessionModal());
        bindClick('session-add-exercise-save-btn', () => saveNewSessionExercise());

        bindClick('miband-workout-cancel-btn', () => closeMiBandWorkoutModal());
        bindClick('miband-workout-save-btn', () => saveMiBandWorkout());

        const rotatingCheckbox = document.getElementById('workout-group-rotating');
        if (rotatingCheckbox) {
            rotatingCheckbox.addEventListener('change', () => {
                toggleRotatingFields();
            });
        }

        const sessionExerciseName = document.getElementById('session-add-exercise-name');
        if (sessionExerciseName) {
            sessionExerciseName.addEventListener('change', () => {
                onSessionExerciseSelect();
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindWorkoutControls, { once: true });
    }
    bindWorkoutControls();
})();
