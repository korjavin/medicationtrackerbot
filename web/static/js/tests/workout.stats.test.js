// Wandergeek Workouts Stats sub-tab (Phase 7, Task 7).
//
// Asserts the rewritten stats layout:
//   • `.wg-workouts-stats` container
//   • `.wg-gloss--inset` range selector with 7d / 30d / 90d / All pills
//     — active state via `.wg-gloss--sun`, persisted to the
//     `mt-workouts-stats-range` localStorage key
//   • `.wg-workouts-stats__calendar` day grid replaces the sessions-per-week
//     line in the Consistency view (med-zte); `.wg-workouts-stats__chart-panel`
//     hosts the WGWorkoutChart output in the Load view
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

    // Local "YYYY-MM-DD" for N days ago — the calendar buckets on the local
    // calendar day, so the fixture has to speak the same dialect.
    function dayStr(daysAgo) {
        const d = new Date();
        d.setDate(d.getDate() - daysAgo);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function cells(container) {
        return Array.from(container.querySelectorAll('.wg-workouts-stats__calendar-cell'));
    }

    function populatedStats({ weeks = 6 } = {}) {
        const anchor = Date.now() - 5000;
        const weekMs = 7 * 86400000;
        const weekly_activity = [];
        for (let i = weeks - 1; i >= 0; i--) {
            const ts = new Date(anchor - i * weekMs).toISOString();
            weekly_activity.push({ week: ts, completed: 2 + i, skipped: 0 });
        }
        return {
            daily_activity: [
                { date: dayStr(9), completed: 1, skipped: 0 },
                { date: dayStr(4), completed: 0, skipped: 1 },
                { date: dayStr(2), completed: 1, skipped: 0 },
            ],
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

    it('clicking a range button persists the choice, re-renders the calendar, and reloads the range-scoped numbers', () => {
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

        // The calendar reflects the new range, and 7d spans at most two week
        // columns (today's week plus whatever spilled into the previous one).
        const grid = container.querySelector('.wg-workouts-stats__calendar-grid');
        expect(grid).not.toBeNull();
        expect(grid.dataset.range).toBe('7d');
        expect(Number(grid.dataset.weeks)).toBeLessThanOrEqual(2);

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

    // med-zte — the sessions-per-week line is gone from Consistency. A
    // GitHub-contribution day grid strictly contains what the line showed (a
    // column read vertically IS the week's session count) and adds which days.
    describe('activity calendar (med-zte)', () => {
        it('renders a 7-column day grid with every column labelled, instead of a line chart', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window._renderWorkoutStats(container, populatedStats({ weeks: 10 }));

            const grid = container.querySelector('.wg-workouts-stats__calendar-grid');
            expect(grid).not.toBeNull();
            expect(grid.getAttribute('role')).toBe('img');
            expect(grid.getAttribute('aria-label')).toMatch(/workout calendar/i);

            // N whole week rows × 7 weekday columns.
            const weeks = Number(grid.dataset.weeks);
            expect(weeks).toBeGreaterThan(0);
            expect(cells(container).length).toBe(weeks * 7);

            // med-wu7: every column carries an initial (GitHub's Mon/Wed/Fri-
            // only convention left four anonymous tracks at phone width). The
            // month row med-zte skipped is now a gutter COLUMN (med-djsa.4).
            const labels = Array.from(container.querySelectorAll('.wg-workouts-stats__calendar-weekday'))
                .map((n) => n.textContent);
            expect(labels).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);

            // No line chart and no chart legend left in this view.
            expect(container.querySelector('.wg-workouts-stats__chart-panel')).toBeNull();
            expect(container.querySelector('path.wg-workout-chart__line')).toBeNull();
            expect(container.querySelector('.wg-workouts-stats__legend')).toBeNull();
        });

        // med-djsa.1 — the whole point of the transpose. If the rows were ever
        // emitted oldest-first again, today's cell would land in the LAST row.
        it('puts the newest week in the first row', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window._renderWorkoutStats(container, {
                ...populatedStats(),
                daily_activity: [
                    { date: dayStr(30), completed: 0, skipped: 1 },
                    { date: dayStr(0), completed: 1, skipped: 0 },
                ],
            });

            const all = cells(container);
            expect(all.length).toBeGreaterThan(7 * 4);
            const done = all.findIndex((c) => c.classList.contains('wg-workouts-stats__calendar-cell--done'));
            const skipped = all.findIndex((c) => c.classList.contains('wg-workouts-stats__calendar-cell--skipped'));
            // Today sits in row 0 (the first 7 cells); a month back is further
            // down the grid, not further left.
            expect(done).toBeLessThan(7);
            expect(skipped).toBeGreaterThanOrEqual(7 * 4);
        });

        it('shades cells by status with three distinct classes and labels each day', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window._renderWorkoutStats(container, {
                ...populatedStats(),
                daily_activity: [
                    { date: dayStr(5), completed: 1, skipped: 0 },
                    { date: dayStr(3), completed: 0, skipped: 2 },
                    // Both on one day reads as completed — you showed up.
                    { date: dayStr(1), completed: 1, skipped: 1 },
                ],
            });

            const byClass = (mod) => cells(container)
                .filter((c) => c.classList.contains(`wg-workouts-stats__calendar-cell--${mod}`));
            expect(byClass('done')).toHaveLength(2);
            expect(byClass('skipped')).toHaveLength(1);
            expect(byClass('empty').length).toBeGreaterThan(0);
            // The three states are genuinely different classes, not one class
            // shaded by an inline style.
            expect(new Set(['done', 'skipped', 'empty']).size).toBe(3);
            cells(container).forEach((c) => expect(c.getAttribute('style')).toBeNull());

            // Order-independent: rows run newest-first, so which of the two
            // done cells comes first depends on today's weekday.
            expect(byClass('done').map((c) => c.title).sort())
                .toEqual([`${dayStr(5)} · completed`, `${dayStr(1)} · completed`].sort());
            expect(byClass('skipped')[0].title).toBe(`${dayStr(3)} · 2 skipped`);
            const untrained = byClass('empty').find((c) => c.title);
            expect(untrained.title).toMatch(/nothing logged$/);
        });

        it('caps the grid at 26 week rows so range=all on a long history stays readable', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window.localStorage.setItem('mt-workouts-stats-range', 'all');
            window._renderWorkoutStats(container, {
                ...populatedStats(),
                daily_activity: [
                    { date: dayStr(365 * 4), completed: 1, skipped: 0 },
                    { date: dayStr(2), completed: 1, skipped: 0 },
                ],
            });

            const grid = container.querySelector('.wg-workouts-stats__calendar-grid');
            expect(Number(grid.dataset.weeks)).toBe(26);
            expect(cells(container).length).toBe(26 * 7);
        });

        it('renders an all-empty grid (not a crash) when nothing was logged', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window._renderWorkoutStats(container, {
                active_weeks: 0,
                total_sessions: 0,
                completed_sessions: 0,
                skipped_sessions: 0,
                completion_rate: 0,
                top_exercises: [],
                weekly_activity: [],
                daily_activity: null,
            });

            const all = cells(container);
            expect(all.length).toBeGreaterThan(0);
            expect(all.every((c) => c.classList.contains('wg-workouts-stats__calendar-cell--empty'))).toBe(true);
            const grid = container.querySelector('.wg-workouts-stats__calendar-grid');
            expect(grid.getAttribute('aria-label')).toMatch(/0 days trained, 0 skipped/);
        });

        // med-djsa.4 — the gutter the transpose freed up. Oracle rather than a
        // hardcoded expectation: the grid is anchored on the real "today", so
        // which rows open a month moves with the wall clock, and a fixture
        // month would rot the day the calendar crossed it.
        const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        function expectedMonthLabels(weeks) {
            const local = new Date();
            const todayMs = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate());
            const sinceMonday = (ms) => (new Date(ms).getUTCDay() + 6) % 7;
            const endMs = todayMs + (6 - sinceMonday(todayMs)) * 86400000;
            const out = [];
            let prev = -1;
            for (let w = 0; w < weeks; w++) {
                const m = new Date(endMs - (w * 7 + 6) * 86400000).getUTCMonth();
                out.push(m === prev ? '' : MONTH_ABBR[m]);
                prev = m;
            }
            return out;
        }

        function monthLabels(container) {
            return Array.from(container.querySelectorAll('.wg-workouts-stats__calendar-month'))
                .map((n) => n.textContent);
        }

        it('labels a row in the gutter whenever its week opens a new month', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window._renderWorkoutStats(container, {
                ...populatedStats(),
                daily_activity: [
                    { date: dayStr(69), completed: 1, skipped: 0 },
                    { date: dayStr(0), completed: 1, skipped: 0 },
                ],
            });

            const grid = container.querySelector('.wg-workouts-stats__calendar-grid');
            const weeks = Number(grid.dataset.weeks);
            expect(weeks).toBeGreaterThanOrEqual(10);

            // One span per row, blanks included — that is what keeps the label
            // column in step with the 7 day columns beside it.
            const labels = monthLabels(container);
            expect(labels).toHaveLength(weeks);
            expect(labels).toEqual(expectedMonthLabels(weeks));

            // The first row is always labelled, and ~10 weeks always straddle
            // at least one month boundary.
            expect(labels[0]).not.toBe('');
            expect(labels.filter(Boolean).length).toBeGreaterThanOrEqual(2);
        });

        it('labels the 7d grid once when its weeks sit inside one month', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window.localStorage.setItem('mt-workouts-stats-range', '7d');
            window._renderWorkoutStats(container, populatedStats());

            const grid = container.querySelector('.wg-workouts-stats__calendar-grid');
            const weeks = Number(grid.dataset.weeks);
            const expected = expectedMonthLabels(weeks);
            expect(monthLabels(container)).toEqual(expected);
            // 7d is one or two rows, so it carries one label unless those rows
            // straddle a month — never more.
            expect(expected.filter(Boolean).length).toBeLessThanOrEqual(2);
        });

        // med-djsa.4 — the column sum answers "which days do I actually train".
        it('closes the grid with per-weekday trained-day totals', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window._renderWorkoutStats(container, {
                ...populatedStats(),
                daily_activity: [
                    { date: dayStr(0), completed: 1, skipped: 0 },
                    { date: dayStr(1), completed: 2, skipped: 0 },
                    // Skipped is not trained — it must not reach the footer.
                    { date: dayStr(2), completed: 0, skipped: 1 },
                    { date: dayStr(3), completed: 1, skipped: 0 },
                ],
            });

            const totals = Array.from(container.querySelectorAll('.wg-workouts-stats__calendar-total'));
            expect(totals).toHaveLength(7);

            const done = cells(container)
                .filter((c) => c.classList.contains('wg-workouts-stats__calendar-cell--done')).length;
            expect(done).toBe(3);
            expect(totals.reduce((sum, t) => sum + Number(t.textContent), 0)).toBe(done);

            // Untrained weekdays render a muted 0, not a blank.
            const zeros = totals.filter((t) => t.textContent === '0');
            expect(zeros.length).toBe(4);
            zeros.forEach((t) =>
                expect(t.classList.contains('wg-workouts-stats__calendar-total--zero')).toBe(true));
            totals.forEach((t) => expect(t.getAttribute('style')).toBeNull());

            // Seven bare digits read aloud are noise, so the row names them.
            const row = container.querySelector('.wg-workouts-stats__calendar-totals');
            expect(row.getAttribute('role')).toBe('img');
            expect(row.getAttribute('aria-label')).toMatch(/Trained days per weekday: Mon \d+, .*Sun \d+\./);
        });
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

            // med-zte — weekly tonnage is a set of discrete buckets, so it
            // renders as bars, one rect per week, not a spline.
            const svg = container.querySelector('.wg-workouts-stats__chart-panel svg.wg-workout-chart');
            expect(svg).not.toBeNull();
            expect(svg.dataset.workoutMetric).toBe('volume');
            expect(svg.dataset.workoutVariant).toBe('bars');
            expect(svg.querySelector('path.wg-workout-chart__line')).toBeNull();
            expect(svg.querySelectorAll('rect.wg-workout-chart__bar')).toHaveLength(12);
            expect(container.querySelector('.wg-workouts-stats__legend-label').textContent).toBe('Volume · per week');

            // Top Exercises comes off exercise_totals so its rows add up to the
            // Volume tile above them.
            const rows = container.querySelectorAll('.wg-workouts-stats__top-row');
            expect(rows.length).toBe(2);
            expect(rows[0].textContent).toContain('Barbell Squat');
        });

        // med-djsa.2 — the names behind the "PRs" tile. The tile alone is a bare
        // number; which lift you beat is the point.
        it('the load view lists the named records and opens the detail view on tap', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            const opened = [];
            window.WorkoutExerciseDetail = { open: (name) => opened.push(name) };
            window._renderWorkoutStats(container, {
                ...loadStats(),
                prs: [
                    { exercise_name: 'Barbell Squat', date: '2026-09-02', weight_kg: 140, previous_kg: 135 },
                    { exercise_name: 'Bench', date: '2026-08-30', weight_kg: 100, previous_kg: 0 }
                ]
            });
            clickView(container, 'load');

            const labels = Array.from(container.querySelectorAll('.wg-workouts-stats__section-label'))
                .map((l) => l.textContent);
            expect(labels).toContain('Records · this range');

            const lists = Array.from(container.querySelectorAll('.wg-workouts-stats__top-exercises'));
            const rows = Array.from(lists[0].querySelectorAll('.wg-workouts-stats__top-row'));
            expect(rows).toHaveLength(2);
            // Locale-sensitive: mirror the production toLocaleDateString call
            // shape rather than hardcoding "Sep 2" (same convention as
            // bp.history / weight.history).
            const day = (iso) => new Date(`${iso}T00:00:00`)
                .toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            expect(rows[0].textContent).toContain('Barbell Squat');
            expect(rows[0].textContent).toContain(`140 kg · was 135 · ${day('2026-09-02')}`);
            // A first-ever weighted lift has no old record to name.
            expect(rows[1].textContent).toContain(`100 kg · first · ${day('2026-08-30')}`);

            rows[0].click();
            expect(opened).toEqual(['Barbell Squat']);
        });

        it('the load view omits the records section entirely when there are none', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window._renderWorkoutStats(container, { ...loadStats(), prs: null });
            clickView(container, 'load');

            const labels = Array.from(container.querySelectorAll('.wg-workouts-stats__section-label'))
                .map((l) => l.textContent);
            // No "no PRs yet" nag either — the section is simply absent, so the
            // only rows left are Top Exercises'.
            expect(labels).not.toContain('Records · this range');
            expect(container.querySelectorAll('.wg-workouts-stats__top-row')).toHaveLength(2);
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

        // med-vov — hard sets are effort-gated, so the sets that were dropped
        // for being rated easy are shown rather than silently subtracted.
        it('the load view names the excluded rated-easy sets on the Hard sets tile', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window._renderWorkoutStats(container, {
                ...loadStats(),
                totals: { volume_kg: 12500, hard_sets: 42, easy_sets: 3, reps: 310, pr_count: 3 }
            });
            clickView(container, 'load');

            const labels = Array.from(container.querySelectorAll('.wg-workouts-stats__tile-label'))
                .map((t) => t.textContent);
            expect(labels).toEqual(['Volume', 'Hard sets · 3 easy', 'Reps', 'PRs']);
        });

        it('the load view still renders when every logged set was rated easy', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window._renderWorkoutStats(container, {
                ...loadStats(),
                totals: { volume_kg: 900, hard_sets: 0, easy_sets: 4, reps: 40, pr_count: 0 }
            });
            clickView(container, 'load');

            expect(container.querySelector('.wg-workouts-stats__empty')).toBeNull();
            const values = Array.from(container.querySelectorAll('.wg-workouts-stats__tile-value'))
                .map((t) => t.textContent);
            expect(values[1]).toBe('0');
            expect(Array.from(container.querySelectorAll('.wg-workouts-stats__tile-label'))
                .map((t) => t.textContent)[1]).toBe('Hard sets · 4 easy');
        });

        // med-djsa.5 — the week-over-week caption under the tonnage chart.
        //
        // `week` on the real payload is the ISO Monday as "YYYY-MM-DD" (domain
        // mondayOf), which is what the caption buckets on; loadStats()'s ISO
        // timestamps predate this and are left alone, so these fixtures speak
        // the production dialect.
        function mondayStr(weeksAgo) {
            const local = new Date();
            const todayMs = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate());
            const sinceMonday = (new Date(todayMs).getUTCDay() + 6) % 7;
            return new Date(todayMs - (sinceMonday + weeksAgo * 7) * 86400000)
                .toISOString().slice(0, 10);
        }

        function statsWithWeeks(weekly_volume) {
            return {
                ...loadStats(),
                weekly_volume,
                prs: null,
            };
        }

        function caption(container) {
            const el = container.querySelector('.wg-workouts-stats__delta');
            return el && el.textContent;
        }

        it('the load view captions the last complete week against the one before it', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window._renderWorkoutStats(container, statsWithWeeks([
                { week: mondayStr(2), volume_kg: 10000, hard_sets: 20, reps: 200 },
                { week: mondayStr(1), volume_kg: 12345, hard_sets: 18, reps: 180 },
                // The current Monday's bucket is partial until Sunday — counting
                // it would report a crash every Tuesday, so it is excluded and
                // its absurd numbers must not appear.
                { week: mondayStr(0), volume_kg: 999999, hard_sets: 99, reps: 900 },
            ]));
            clickView(container, 'load');

            expect(caption(container))
                .toBe('Last week 12.3t · 18 hard sets · +23% vs the week before');
        });

        it('the load view signs a down week and drops the delta when the week before is a gap', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');

            window._renderWorkoutStats(container, statsWithWeeks([
                { week: mondayStr(2), volume_kg: 10000, hard_sets: 20, reps: 200 },
                { week: mondayStr(1), volume_kg: 800, hard_sets: 1, reps: 10 },
            ]));
            clickView(container, 'load');
            expect(caption(container))
                .toBe('Last week 800 kg · 1 hard set · -92% vs the week before');

            // weekly_volume is sparse: an untrained week is ABSENT, not a zero
            // row, so there is nothing to divide by — the line stays, the delta
            // goes.
            window._renderWorkoutStats(container, statsWithWeeks([
                { week: mondayStr(3), volume_kg: 10000, hard_sets: 20, reps: 200 },
                { week: mondayStr(1), volume_kg: 12345, hard_sets: 18, reps: 180 },
            ]));
            clickView(container, 'load');
            expect(caption(container)).toBe('Last week 12.3t · 18 hard sets');
        });

        // The sparse-payload trap: coming back from a week off, the newest
        // complete bucket is TWO weeks old. Labelling it "Last week" would
        // attribute a fortnight-old session's tonnage to a week the user spent
        // on the sofa.
        it('the load view names a rest week instead of relabelling older tonnage', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window._renderWorkoutStats(container, statsWithWeeks([
                { week: mondayStr(3), volume_kg: 10000, hard_sets: 20, reps: 200 },
                { week: mondayStr(2), volume_kg: 12345, hard_sets: 18, reps: 180 },
            ]));
            clickView(container, 'load');

            expect(caption(container)).toBe('Last week no training');
        });

        it('the load view omits the caption when no complete week exists', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window._renderWorkoutStats(container, statsWithWeeks([
                { week: mondayStr(0), volume_kg: 4000, hard_sets: 9, reps: 90 },
            ]));
            clickView(container, 'load');

            expect(caption(container)).toBeNull();
            // The chart itself still draws the partial week.
            expect(container.querySelector('.wg-workouts-stats__legend-label')).not.toBeNull();
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

        // med-vov — the Balance view folds COVERAGE (`sets`), never the
        // effort-gated `hard_sets`. Squatting three honest RPE-5 sets must not
        // make the app print "Not Trained: Legs" on a day you squatted; rating
        // honestly can never produce falser data than not rating at all.
        it('the balance view counts an all-easy exercise as trained, not untrained', async () => {
            const { document, window } = env;
            stubCatalog(window, [
                { name: 'Barbell Squat', body_part: 'upper legs' },
                { name: 'Bench Press', body_part: 'chest' }
            ]);
            const container = document.getElementById('workout-stats-display');
            window._renderWorkoutStats(container, {
                ...loadStats(),
                // Every working set rated easy: 3 sets of coverage, 0 hard.
                exercise_totals: [{
                    exercise_name: 'Barbell Squat', session_count: 1, sets: 3, hard_sets: 0,
                    reps: 15, total_volume_kg: 1500, max_weight_kg: 100
                }]
            });
            clickView(container, 'balance');

            await vi.waitFor(() => {
                expect(container.querySelector('.wg-workouts-stats__untrained')).toBeTruthy();
            });

            const rows = Array.from(container.querySelectorAll('.wg-workouts-stats__body-split .wg-workouts-stats__top-row'));
            expect(rows).toHaveLength(1);
            expect(rows[0].textContent).toContain('Legs');
            expect(rows[0].textContent).toContain('3 sets · 100%');

            const chips = Array.from(container.querySelectorAll('.wg-workouts-stats__untrained-chip'))
                .map((c) => c.textContent);
            expect(chips).toEqual(['Chest']);
            expect(chips).not.toContain('Legs');
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
