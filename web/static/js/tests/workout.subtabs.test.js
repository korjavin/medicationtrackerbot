// Wandergeek Workouts sub-tab strip (Phase 7, Task 2).
//
// Asserts the rewritten sub-tab strip uses the Wandergeek primitives —
// kit `.wg-seg` strip, `.wg-seg__opt[aria-pressed]` selection (med-xso6.10) — persists the
// active sub-tab via the `mt-workouts-subtab` localStorage key, defaults to
// `history`, and that clicking a sub-tab routes through switchWorkoutTab()
// to toggle the active-state classes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('Workouts sub-tab strip (Phase 7, Task 2)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ withWorkout: true });
        // Stub async sub-tab loaders so they don't reach into `document`
        // after the JSDOM window is closed in afterEach. Tests in this file
        // only care about the DOM class toggles + persistence, not data fetch.
        env.window.loadWorkoutGroups = () => {};
        env.window.loadNextWorkout = () => {};
        env.window.loadWorkoutHistoryTab = () => {};
        env.window.loadExerciseLibrary = () => {};
        env.window.loadWorkoutStatsTab = () => {};
        env.window.loadWorkoutEquipment = () => {};
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renders the strip as a kit .wg-seg strip with five .workout-tab buttons', () => {
        const { document } = env;
        const strip = document.querySelector('#workouts-subtabs');
        expect(strip).not.toBeNull();
        expect(strip.classList.contains('wg-seg')).toBe(true);
        expect(strip.classList.contains('wg-seg--scroll')).toBe(true);

        const buttons = strip.querySelectorAll('.workout-tab');
        expect(buttons.length).toBe(5);
        const tabs = Array.from(buttons).map((btn) => btn.dataset.tab);
        expect(tabs).toEqual(['history', 'groups', 'exercises', 'stats', 'equipment']);

        buttons.forEach((btn) => {
            expect(btn.classList.contains('wg-seg__opt')).toBe(true);
        });
    });

    it('defaults to the "history" sub-tab with an aria-pressed selection', () => {
        const { document } = env;
        const buttons = document.querySelectorAll('#workouts-subtabs .workout-tab');
        const historyBtn = Array.from(buttons).find((b) => b.dataset.tab === 'history');
        const groupsBtn = Array.from(buttons).find((b) => b.dataset.tab === 'groups');
        const exercisesBtn = Array.from(buttons).find((b) => b.dataset.tab === 'exercises');
        const statsBtn = Array.from(buttons).find((b) => b.dataset.tab === 'stats');

        expect(historyBtn.getAttribute('aria-pressed')).toBe('true');

        expect(groupsBtn.getAttribute('aria-pressed')).toBe('false');
        expect(exercisesBtn.getAttribute('aria-pressed')).toBe('false');
        expect(statsBtn.getAttribute('aria-pressed')).toBe('false');
    });

    it('switchWorkoutTab moves aria-pressed across the strip without inline style', () => {
        const { document, window } = env;
        window.switchWorkoutTab('groups');

        const buttons = document.querySelectorAll('#workouts-subtabs .workout-tab');
        const historyBtn = Array.from(buttons).find((b) => b.dataset.tab === 'history');
        const groupsBtn = Array.from(buttons).find((b) => b.dataset.tab === 'groups');

        expect(historyBtn.getAttribute('aria-pressed')).toBe('false');
        expect(groupsBtn.getAttribute('aria-pressed')).toBe('true');

        // No inline style was used to express the active state.
        buttons.forEach((btn) => {
            expect(btn.getAttribute('style')).toBeNull();
        });
    });

    it('switchWorkoutTab activates the matching tab content panel', () => {
        const { document, window } = env;
        window.switchWorkoutTab('exercises');

        const exercisesContent = document.getElementById('workout-exercises-tab');
        expect(exercisesContent).not.toBeNull();
        expect(exercisesContent.classList.contains('active')).toBe(true);

        const historyContent = document.getElementById('workout-history-tab');
        expect(historyContent.classList.contains('active')).toBe(false);

        const exercisesBtn = document.querySelector('.workout-tab[data-tab="exercises"]');
        expect(exercisesBtn.getAttribute('aria-pressed')).toBe('true');
    });

    it('getActiveWorkoutsSubTab defaults to "history" when no value is stored', () => {
        const { window } = env;
        window.localStorage.removeItem('mt-workouts-subtab');
        expect(window.getActiveWorkoutsSubTab()).toBe('history');
    });

    it('setActiveWorkoutsSubTab round-trips valid values through localStorage', () => {
        const { window } = env;
        window.setActiveWorkoutsSubTab('groups');
        expect(window.localStorage.getItem('mt-workouts-subtab')).toBe('groups');
        expect(window.getActiveWorkoutsSubTab()).toBe('groups');

        window.setActiveWorkoutsSubTab('exercises');
        expect(window.getActiveWorkoutsSubTab()).toBe('exercises');

        window.setActiveWorkoutsSubTab('stats');
        expect(window.getActiveWorkoutsSubTab()).toBe('stats');

        window.setActiveWorkoutsSubTab('equipment');
        expect(window.getActiveWorkoutsSubTab()).toBe('equipment');

        window.setActiveWorkoutsSubTab('history');
        expect(window.getActiveWorkoutsSubTab()).toBe('history');
    });

    it('setActiveWorkoutsSubTab ignores invalid values and keeps the previous setting', () => {
        const { window } = env;
        window.setActiveWorkoutsSubTab('groups');
        window.setActiveWorkoutsSubTab('not-a-tab');
        expect(window.getActiveWorkoutsSubTab()).toBe('groups');
    });

    it('switchWorkoutTab persists the chosen sub-tab to localStorage', () => {
        const { window } = env;
        window.switchWorkoutTab('stats');
        expect(window.localStorage.getItem('mt-workouts-subtab')).toBe('stats');

        window.switchWorkoutTab('groups');
        expect(window.localStorage.getItem('mt-workouts-subtab')).toBe('groups');
    });

    it('restoreWorkoutsSubTab applies the stored value to the strip', () => {
        const { document, window } = env;
        window.setActiveWorkoutsSubTab('exercises');
        window.restoreWorkoutsSubTab();

        const buttons = document.querySelectorAll('#workouts-subtabs .workout-tab');
        const exercisesBtn = Array.from(buttons).find((b) => b.dataset.tab === 'exercises');
        expect(exercisesBtn.getAttribute('aria-pressed')).toBe('true');
    });

    it('switchWorkoutTab activates the equipment panel and persists it', () => {
        const { document, window } = env;
        window.switchWorkoutTab('equipment');

        const equipmentContent = document.getElementById('workout-equipment-tab');
        expect(equipmentContent).not.toBeNull();
        expect(equipmentContent.classList.contains('active')).toBe(true);

        const historyContent = document.getElementById('workout-history-tab');
        expect(historyContent.classList.contains('active')).toBe(false);

        const equipmentBtn = document.querySelector('.workout-tab[data-tab="equipment"]');
        expect(equipmentBtn.getAttribute('aria-pressed')).toBe('true');
        expect(window.localStorage.getItem('mt-workouts-subtab')).toBe('equipment');
    });

    it('loadWorkouts honors the persisted sub-tab instead of always reverting to history', () => {
        const { document, window } = env;
        window.setActiveWorkoutsSubTab('groups');
        window.loadWorkouts();

        const groupsContent = document.getElementById('workout-groups-tab');
        expect(groupsContent.classList.contains('active')).toBe(true);

        const groupsBtn = document.querySelector('.workout-tab[data-tab="groups"]');
        expect(groupsBtn.getAttribute('aria-pressed')).toBe('true');
    });
});
