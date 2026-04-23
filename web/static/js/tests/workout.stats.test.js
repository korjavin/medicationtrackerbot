// Wandergeek Workouts Stats sub-tab (Phase 7, Task 7).
//
// Asserts the rewritten stats layout:
//   • `.wg-workouts-stats` container
//   • `.wg-gloss--inset` range selector with 7d / 30d / 90d / All pills
//     — active state via `.wg-gloss--sun`, persisted to the
//     `mt-workouts-stats-range` localStorage key
//   • `.wg-workouts-stats__chart-panel` hosts the WGWorkoutChart output
//   • 2×2 `.wg-card` stat-tile grid for Active Weeks / 30-Day Sessions /
//     Done / Skipped
//   • Top Exercises section renders as a `.wg-section-label` + list of
//     `.wg-card` rows when `top_exercises` is non-empty
//   • Empty-state (`stats === null`) falls back to "No statistics available
//     yet"

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('Workouts Stats sub-tab (Phase 7, Task 7)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ withWorkout: true });
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    function populatedStats({ weeks = 6 } = {}) {
        const anchor = Date.now() - 5000;
        const weekMs = 7 * 86400000;
        const weekly_activity = [];
        for (let i = weeks - 1; i >= 0; i--) {
            const ts = new Date(anchor - i * weekMs).toISOString();
            weekly_activity.push({ week: ts, completed: 2 + i, skipped: 0 });
        }
        return {
            active_weeks: 5,
            total_sessions: 20,
            completed_sessions: 17,
            skipped_sessions: 3,
            completion_rate: 85,
            top_exercises: [
                { exercise_name: 'Squat', total_volume_kg: 8000, max_weight_kg: 140 },
                { exercise_name: 'Bench', total_volume_kg: 5000, max_weight_kg: 100 }
            ],
            weekly_activity
        };
    }

    it('renders the .wg-workouts-stats container when stats are present', () => {
        const { document, window } = env;
        const container = document.getElementById('workout-stats-display');
        window._renderWorkoutStats(container, populatedStats());

        const root = container.querySelector('.wg-workouts-stats');
        expect(root).not.toBeNull();
    });

    it('renders the range selector as a .wg-gloss--inset strip with four pills', () => {
        const { document, window } = env;
        const container = document.getElementById('workout-stats-display');
        window._renderWorkoutStats(container, populatedStats());

        const strip = container.querySelector('.wg-workouts-stats__range');
        expect(strip).not.toBeNull();
        expect(strip.classList.contains('wg-gloss--inset')).toBe(true);

        const buttons = strip.querySelectorAll('.wg-workouts-stats__range-btn');
        expect(buttons.length).toBe(4);
        const ranges = Array.from(buttons).map((b) => b.dataset.range);
        expect(ranges).toEqual(['7d', '30d', '90d', 'all']);

        buttons.forEach((btn) => {
            expect(btn.classList.contains('wg-gloss')).toBe(true);
        });
    });

    it('defaults to the "all" range with sun active pill', () => {
        const { document, window } = env;
        const container = document.getElementById('workout-stats-display');
        window.localStorage.removeItem('mt-workouts-stats-range');
        window._renderWorkoutStats(container, populatedStats());

        const buttons = container.querySelectorAll('.wg-workouts-stats__range-btn');
        const allBtn = Array.from(buttons).find((b) => b.dataset.range === 'all');
        expect(allBtn.classList.contains('wg-gloss--sun')).toBe(true);
        expect(allBtn.getAttribute('aria-pressed')).toBe('true');

        const otherBtns = Array.from(buttons).filter((b) => b.dataset.range !== 'all');
        otherBtns.forEach((btn) => {
            expect(btn.classList.contains('wg-gloss--sun')).toBe(false);
            expect(btn.getAttribute('aria-pressed')).toBe('false');
        });
    });

    it('honors the persisted range from localStorage on render', () => {
        const { document, window } = env;
        const container = document.getElementById('workout-stats-display');
        window.localStorage.setItem('mt-workouts-stats-range', '30d');
        window._renderWorkoutStats(container, populatedStats());

        const buttons = container.querySelectorAll('.wg-workouts-stats__range-btn');
        const activeBtn = Array.from(buttons).find((b) => b.classList.contains('wg-gloss--sun'));
        expect(activeBtn).not.toBeNull();
        expect(activeBtn.dataset.range).toBe('30d');
    });

    it('clicking a range button persists the choice and re-renders the chart', () => {
        const { document, window } = env;
        const container = document.getElementById('workout-stats-display');
        window._renderWorkoutStats(container, populatedStats({ weeks: 12 }));

        const buttons = container.querySelectorAll('.wg-workouts-stats__range-btn');
        const sevenBtn = Array.from(buttons).find((b) => b.dataset.range === '7d');
        sevenBtn.click();

        expect(window.localStorage.getItem('mt-workouts-stats-range')).toBe('7d');
        // Active class should have moved.
        expect(sevenBtn.classList.contains('wg-gloss--sun')).toBe(true);
        const allBtn = Array.from(buttons).find((b) => b.dataset.range === 'all');
        expect(allBtn.classList.contains('wg-gloss--sun')).toBe(false);

        // Chart panel reflects the new range on its rendered child.
        const panel = container.querySelector('.wg-workouts-stats__chart-panel');
        expect(panel).not.toBeNull();
        const chartNode = panel.firstElementChild;
        expect(chartNode).not.toBeNull();
        expect(chartNode.dataset.workoutRange).toBe('7d');
    });

    it('renders the chart panel with a WGWorkoutChart output when weekly_activity is present', () => {
        const { document, window } = env;
        const container = document.getElementById('workout-stats-display');
        window._renderWorkoutStats(container, populatedStats({ weeks: 10 }));

        const panel = container.querySelector('.wg-workouts-stats__chart-panel');
        expect(panel).not.toBeNull();
        const svg = panel.querySelector('svg.wg-workout-chart');
        expect(svg).not.toBeNull();
        expect(svg.querySelector('path.wg-workout-chart__line')).not.toBeNull();
    });

    it('renders the empty-state chart card when weekly_activity is empty', () => {
        const { document, window } = env;
        const container = document.getElementById('workout-stats-display');
        window._renderWorkoutStats(container, {
            active_weeks: 0,
            total_sessions: 0,
            completed_sessions: 0,
            skipped_sessions: 0,
            completion_rate: 0,
            top_exercises: [],
            weekly_activity: []
        });

        const panel = container.querySelector('.wg-workouts-stats__chart-panel');
        const empty = panel.querySelector('.wg-workout-chart--empty');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toMatch(/no workout sessions yet/i);
    });

    it('renders the stat-tile grid with the expected four labels', () => {
        const { document, window } = env;
        const container = document.getElementById('workout-stats-display');
        window._renderWorkoutStats(container, populatedStats());

        const tiles = container.querySelectorAll('.wg-workouts-stats__tile');
        expect(tiles.length).toBe(4);

        const labels = Array.from(tiles).map((t) =>
            t.querySelector('.wg-workouts-stats__tile-label').textContent
        );
        expect(labels).toEqual(['Active Weeks', '30-Day Sessions', 'Done', 'Skipped']);

        const values = Array.from(tiles).map((t) =>
            t.querySelector('.wg-workouts-stats__tile-value').textContent
        );
        expect(values).toEqual(['5', '20', '17', '3']);
    });

    it('renders the Top Exercises section when top_exercises is non-empty', () => {
        const { document, window } = env;
        const container = document.getElementById('workout-stats-display');
        window._renderWorkoutStats(container, populatedStats());

        const heading = container.querySelector('.wg-workouts-stats__section-label');
        expect(heading).not.toBeNull();
        expect(heading.textContent).toContain('Top Exercises');

        const rows = container.querySelectorAll('.wg-workouts-stats__top-row');
        expect(rows.length).toBe(2);
        expect(rows[0].textContent).toContain('Squat');
        expect(rows[1].textContent).toContain('Bench');
    });

    it('omits the Top Exercises section when top_exercises is empty', () => {
        const { document, window } = env;
        const container = document.getElementById('workout-stats-display');
        window._renderWorkoutStats(container, {
            active_weeks: 0,
            total_sessions: 0,
            completed_sessions: 0,
            skipped_sessions: 0,
            completion_rate: 0,
            top_exercises: [],
            weekly_activity: []
        });

        expect(container.querySelector('.wg-workouts-stats__section-label')).toBeNull();
        expect(container.querySelector('.wg-workouts-stats__top-exercises')).toBeNull();
    });

    it('renders the empty-state copy when stats === null', () => {
        const { document, window } = env;
        const container = document.getElementById('workout-stats-display');
        window._renderWorkoutStats(container, null);

        const empty = container.querySelector('.wg-workouts-stats__empty');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toMatch(/no statistics available yet/i);
    });

    it('getActiveWorkoutsStatsRange defaults to "all" when no value is stored', () => {
        const { window } = env;
        window.localStorage.removeItem('mt-workouts-stats-range');
        expect(window.getActiveWorkoutsStatsRange()).toBe('all');
    });

    it('setActiveWorkoutsStatsRange round-trips valid values through localStorage', () => {
        const { window } = env;
        window.setActiveWorkoutsStatsRange('7d');
        expect(window.localStorage.getItem('mt-workouts-stats-range')).toBe('7d');
        expect(window.getActiveWorkoutsStatsRange()).toBe('7d');

        window.setActiveWorkoutsStatsRange('90d');
        expect(window.getActiveWorkoutsStatsRange()).toBe('90d');

        window.setActiveWorkoutsStatsRange('all');
        expect(window.getActiveWorkoutsStatsRange()).toBe('all');
    });

    it('setActiveWorkoutsStatsRange ignores invalid values and keeps the previous setting', () => {
        const { window } = env;
        window.setActiveWorkoutsStatsRange('7d');
        window.setActiveWorkoutsStatsRange('not-a-range');
        expect(window.getActiveWorkoutsStatsRange()).toBe('7d');
    });
});
