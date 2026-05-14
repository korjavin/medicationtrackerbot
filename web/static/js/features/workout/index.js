// ====================================
// WORKOUT — Orchestrator
// ====================================
//
// Thin orchestrator for the Workouts section. Owns:
//   - sub-tab routing (history / groups / exercises / stats)
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
// library.js / history.js / miband.js / sessions.js / stats.js / next-card.js.

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

// Sub-tab state (Phase 7, Task 2). Mirrors the `mt-meds-subtab` /
// `mt-food-subtab` pattern — one of four values (`history`, `groups`,
// `exercises`, `stats`), persisted to localStorage so the user's choice
// survives reload. Default is `history`.
const WORKOUTS_SUBTAB_STORAGE_KEY = 'mt-workouts-subtab';
const WORKOUTS_SUBTAB_OPTIONS = ['history', 'groups', 'exercises', 'stats'];
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

function syncWorkoutsSubTabActiveClass(activeTab) {
    const container = document.querySelector('.wg-workouts-subtabs');
    if (!container) return;
    const buttons = container.querySelectorAll('.workout-tab');
    buttons.forEach((btn) => {
        const isActive = btn.dataset.tab === activeTab;
        btn.classList.toggle('wg-gloss--sun', isActive);
        btn.classList.toggle('wg-workouts-subtabs__btn--active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

function restoreWorkoutsSubTab() {
    syncWorkoutsSubTabActiveClass(getActiveWorkoutsSubTab());
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restoreWorkoutsSubTab, { once: true });
} else {
    restoreWorkoutsSubTab();
}

function switchWorkoutTab(tab) {
    const activated = activateTabGroup(tab, {
        buttonSelector: '.workout-tab',
        contentSelector: '.workout-tab-content',
        contentIdFromTab: (tabName) => `workout-${tabName}-tab`
    });
    if (!activated) return;

    if (typeof syncWorkoutsSubTabActiveClass === 'function') syncWorkoutsSubTabActiveClass(tab);
    if (typeof setActiveWorkoutsSubTab === 'function') setActiveWorkoutsSubTab(tab);

    if (tab === 'groups') { loadWorkoutGroups(); }
    else if (tab === 'history') { loadNextWorkout(); loadWorkoutHistoryTab(); }
    else if (tab === 'exercises') { loadExerciseLibrary(); }
    else if (tab === 'stats') { loadWorkoutStatsTab(); }
}

bindTabGroup({
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

        bindClick('start-adhoc-workout-btn', () => startAdHocWorkout());
        bindClick('add-workout-group-btn', () => showAddWorkoutGroupModal());
        bindClick('add-exercise-library-btn', () => showExerciseLibraryModal());

        bindClick('workout-group-cancel-btn', () => closeWorkoutGroupModal());
        bindClick('workout-group-save-btn', () => saveWorkoutGroup());
        bindClick('add-variant-btn', () => showAddVariantModal());
        bindClick('add-flat-exercise-btn', () => showAddExerciseModalFromGroup());

        bindClick('variant-cancel-btn', () => closeVariantModal());
        bindClick('variant-save-btn', () => saveVariant());
        bindClick('variant-add-exercise-btn', () => showAddExerciseModal());

        bindClick('exercise-cancel-btn', () => closeExerciseModal());
        bindClick('exercise-save-btn', () => saveExercise());

        bindClick('exercise-library-cancel-btn', () => closeExerciseLibraryModal());
        bindClick('exercise-library-save-btn', () => saveExerciseLibraryItem());

        bindClick('workout-session-delete-btn', () => deleteWorkoutSession());
        bindClick('workout-session-cancel-btn', () => closeWorkoutSessionModal());
        bindClick('workout-session-save-btn', () => saveWorkoutSessionDetails());

        bindClick('session-add-exercise-cancel-btn', () => closeAddExerciseToSessionModal());
        bindClick('session-add-exercise-save-btn', () => saveNewSessionExercise());

        bindClick('miband-workout-cancel-btn', () => closeMiBandWorkoutModal());
        bindClick('miband-workout-save-btn', () => saveMiBandWorkout());
        bindClick('miband-workout-delete-btn', () => deleteMiBandWorkout());

        const rotatingCheckbox = document.getElementById('workout-group-rotating');
        if (rotatingCheckbox) {
            rotatingCheckbox.addEventListener('change', () => {
                toggleRotatingFields();
            });
        }

        document.querySelectorAll('#workout-group-modal .days-select span').forEach((day) => {
            day.addEventListener('click', () => {
                toggleWorkoutDay(day);
            });
        });

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
