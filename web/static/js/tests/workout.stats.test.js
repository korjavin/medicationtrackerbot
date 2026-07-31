// Wandergeek Workouts Stats sub-tab (Phase 7, Task 7).
//
// Asserts the rewritten stats layout:
//   • `.wg-workouts-stats` container
//   • `.wg-gloss--inset` range selector with 7d / 30d / 90d / All pills
//     — active state via `.wg-gloss--sun`, persisted to the
//     `mt-workouts-stats-range` localStorage key
//   • `.wg-workouts-stats__chart-panel` hosts the WGWorkoutChart output
//   • 2×2 `.wg-card` stat-tile grid for Streak / Sessions / Done / Skipped,
//     every tile but Streak scoped to the active range
//   • Top Exercises section renders as a `.wg-section-label` + list of
//     `.wg-card` rows when `top_exercises` is non-empty
//   • Empty-state (`stats === null`) falls back to "No statistics available
//     yet"

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
            range: 'all',
            active_weeks: 5,
            current_streak_weeks: 4,
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

    it('clicking a range button persists the choice, re-renders the chart, and reloads the range-scoped numbers', () => {
        const { document, window } = env;
        const container = document.getElementById('workout-stats-display');
        // The tiles + Top Exercises are computed by the domain per range, so a
        // pill tap has to re-fetch — repainting the chart alone was the bug.
        let reloads = 0;
        window.loadWorkoutStatsTab = () => { reloads++; return Promise.resolve(); };
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

        expect(reloads).toBe(1);
    });

    it('fetches the persisted range so the tiles cover the selected window', async () => {
        const { window } = env;
        const urls = [];
        window.apiCallDirect = async (url) => {
            urls.push(url);
            return populatedStats();
        };
        window.localStorage.setItem('mt-workouts-stats-range', '90d');

        await window.loadWorkoutStatsTab();

        expect(urls).toEqual(['/api/workout/stats?range=90d']);
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
        expect(labels).toEqual(['Streak', 'Sessions', 'Done', 'Skipped']);

        const values = Array.from(tiles).map((t) =>
            t.querySelector('.wg-workouts-stats__tile-value').textContent
        );
        expect(values).toEqual(['4 wk', '20', '85%', '3']);
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

    // med-904.2 — three visualization modes behind a segmented toggle. One
    // payload feeds all three (med-904.1 widened it), so a view switch is a
    // pure re-render: no refetch, no extra apiCallDirect call.
    describe('view toggle (med-904.2)', () => {
        function loadStats() {
            return {
                ...populatedStats({ weeks: 12 }),
                totals: { volume_kg: 12500, hard_sets: 42, reps: 310, pr_count: 3 },
                weekly_volume: populatedStats({ weeks: 12 }).weekly_activity.map((w, i) => ({
                    week: w.week, volume_kg: 900 + i * 100, hard_sets: 4 + i, reps: 30 + i
                })),
                exercise_totals: [
                    { exercise_name: 'Barbell Squat', session_count: 6, sets: 18, reps: 90, total_volume_kg: 8000, max_weight_kg: 140 },
                    { exercise_name: 'Bench', session_count: 4, sets: 12, reps: 60, total_volume_kg: 5000, max_weight_kg: 100 }
                ]
            };
        }

        function pills(container) {
            return Array.from(container.querySelectorAll('.wg-workouts-stats__view-btn'));
        }

        function clickView(container, view) {
            pills(container).find((b) => b.dataset.view === view).click();
        }

        // The catalog is a fetched static asset; stub it so the balance view can
        // resolve body parts (and know which ones went untrained).
        function stubCatalog(window, exercises) {
            window.fetch = vi.fn(async (url) => {
                if (String(url).includes('/static/data/exercises-catalog.json')) {
                    return { ok: true, status: 200, json: async () => ({ exercises }) };
                }
                return { ok: true, status: 200, json: async () => ({}) };
            });
        }

        it('renders three view pills above the range strip, defaulting to consistency', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window.localStorage.removeItem('mt-workouts-stats-view');
            window._renderWorkoutStats(container, loadStats());

            const strip = container.querySelector('.wg-workouts-stats__view');
            expect(strip).not.toBeNull();
            expect(strip.classList.contains('wg-gloss--inset')).toBe(true);
            expect(pills(container).map((b) => b.dataset.view)).toEqual(['consistency', 'load', 'balance']);

            // The view strip precedes the range strip in the DOM.
            const root = container.querySelector('.wg-workouts-stats');
            expect(root.children[0].classList.contains('wg-workouts-stats__view')).toBe(true);
            expect(root.children[1].classList.contains('wg-workouts-stats__range')).toBe(true);

            const active = pills(container).find((b) => b.classList.contains('wg-gloss--sun'));
            expect(active.dataset.view).toBe('consistency');
            expect(active.getAttribute('aria-pressed')).toBe('true');
            // Consistency is today's screen: the Streak tile is still first.
            expect(container.querySelector('.wg-workouts-stats__tile-label').textContent).toBe('Streak');
        });

        it('switching views persists the choice and re-renders without refetching', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            let apiCalls = 0;
            let reloads = 0;
            window.apiCallDirect = async () => { apiCalls++; return loadStats(); };
            window.loadWorkoutStatsTab = () => { reloads++; return Promise.resolve(); };
            window._renderWorkoutStats(container, loadStats());

            clickView(container, 'load');

            expect(window.localStorage.getItem('mt-workouts-stats-view')).toBe('load');
            expect(apiCalls).toBe(0);
            expect(reloads).toBe(0);
        });

        it('honors the persisted view on render and ignores junk', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window.setActiveWorkoutsStatsView('load');
            expect(window.getActiveWorkoutsStatsView()).toBe('load');
            window.setActiveWorkoutsStatsView('not-a-view');
            expect(window.getActiveWorkoutsStatsView()).toBe('load');

            window._renderWorkoutStats(container, loadStats());
            const active = pills(container).find((b) => b.classList.contains('wg-gloss--sun'));
            expect(active.dataset.view).toBe('load');
        });

        it('getActiveWorkoutsStatsView defaults to "consistency" when nothing is stored', () => {
            const { window } = env;
            window.localStorage.removeItem('mt-workouts-stats-view');
            expect(window.getActiveWorkoutsStatsView()).toBe('consistency');
            expect(window.WorkoutStats.getView).toBeTypeOf('function');
            expect(window.WorkoutStats.setView).toBeTypeOf('function');
        });

        it('the load view shows volume tiles and a weekly-tonnage chart', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window._renderWorkoutStats(container, loadStats());
            clickView(container, 'load');

            const labels = Array.from(container.querySelectorAll('.wg-workouts-stats__tile-label'))
                .map((t) => t.textContent);
            expect(labels).toEqual(['Volume', 'Hard sets', 'Reps', 'PRs']);
            const values = Array.from(container.querySelectorAll('.wg-workouts-stats__tile-value'))
                .map((t) => t.textContent);
            expect(values).toEqual(['12.5t', '42', '310', '3']);

            const svg = container.querySelector('.wg-workouts-stats__chart-panel svg.wg-workout-chart');
            expect(svg).not.toBeNull();
            expect(svg.dataset.workoutMetric).toBe('volume');
            expect(container.querySelector('.wg-workouts-stats__legend-label').textContent).toBe('Volume · per week');

            // Top Exercises comes off exercise_totals so its rows add up to the
            // Volume tile above them.
            const rows = container.querySelectorAll('.wg-workouts-stats__top-row');
            expect(rows.length).toBe(2);
            expect(rows[0].textContent).toContain('Barbell Squat');
        });

        it('the load view says so when the range holds no logged sets', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window._renderWorkoutStats(container, {
                ...loadStats(),
                totals: { volume_kg: 0, hard_sets: 0, reps: 0, pr_count: 0 }
            });
            clickView(container, 'load');

            expect(container.querySelector('.wg-workouts-stats__tiles')).toBeNull();
            expect(container.querySelector('.wg-workouts-stats__empty').textContent)
                .toMatch(/no logged sets in this range/i);
        });

        it('the balance view splits sets per body part and lists untrained ones', async () => {
            const { document, window } = env;
            stubCatalog(window, [
                { name: 'Barbell Squat', body_part: 'upper legs' },
                { name: 'Bench Press', body_part: 'chest' },
                { name: 'Lat Pulldown', body_part: 'back' }
            ]);
            const container = document.getElementById('workout-stats-display');
            window._renderWorkoutStats(container, {
                ...loadStats(),
                // Only legs were trained; chest and back are the gap.
                exercise_totals: [{
                    exercise_name: 'Barbell Squat', session_count: 6, sets: 18,
                    reps: 90, total_volume_kg: 8000, max_weight_kg: 140
                }]
            });
            clickView(container, 'balance');

            await vi.waitFor(() => {
                expect(container.querySelector('.wg-workouts-stats__untrained')).toBeTruthy();
            });

            const rows = Array.from(container.querySelectorAll('.wg-workouts-stats__body-split .wg-workouts-stats__top-row'));
            expect(rows).toHaveLength(1);
            expect(rows[0].textContent).toContain('Legs');
            expect(rows[0].textContent).toContain('18 sets · 100%');

            const chips = Array.from(container.querySelectorAll('.wg-workouts-stats__untrained-chip'))
                .map((c) => c.textContent);
            expect(chips).toEqual(['Back', 'Chest']);
        });

        it('the balance view says so when the range holds no exercises', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window._renderWorkoutStats(container, { ...loadStats(), exercise_totals: null });
            clickView(container, 'balance');

            expect(container.querySelector('.wg-workouts-stats__empty').textContent)
                .toMatch(/no exercises logged in this range/i);
        });
    });
});
