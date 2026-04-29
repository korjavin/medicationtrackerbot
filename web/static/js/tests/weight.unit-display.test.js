// Smart weight unit preference (Plan 2026-04-29, Task 5).
//
// All weight display surfaces (Today tile, goal card, delta-to-goal, chart
// legend, prognosis trend, current badge, history list) honor the user's
// saved preference (window.weightUnitPreference). Storage stays in kg —
// values are converted at render time only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const UTILS_JS = path.join(REPO_ROOT, 'web/static/js/core/utils.js');
const EMPTY_STATE_JS = path.join(REPO_ROOT, 'web/static/js/components/empty-state.js');
const WG_ICONS_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-icons.js');
const WG_SPARKLINE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-sparkline.js');
const TODAY_JS = path.join(REPO_ROOT, 'web/static/js/features/today.js');

const KG_PER_LB = 0.45359237;

function isoDaysAgo(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString();
}

describe('formatWeight() helper', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('passes kg through unchanged when unit is kg', () => {
        const { window } = env;
        const out = window.formatWeight(75.0, 'kg');
        expect(out.value).toBe(75.0);
        expect(out.label).toBe('kg');
    });

    it('converts kg to lb when unit is lb', () => {
        const { window } = env;
        const out = window.formatWeight(70.0, 'lb');
        // 70 kg ≈ 154.3 lb
        expect(out.value).toBeCloseTo(70 / KG_PER_LB, 1);
        expect(out.label).toBe('lb');
    });

    it('rounds to one decimal', () => {
        const { window } = env;
        const out = window.formatWeight(75.123, 'kg');
        expect(out.value).toBe(75.1);
    });

    it('falls back to kg label for unknown unit', () => {
        const { window } = env;
        const out = window.formatWeight(80.0, 'gallons');
        expect(out.label).toBe('kg');
        expect(out.value).toBe(80.0);
    });

    it('returns NaN value but valid label when input is non-finite', () => {
        const { window } = env;
        const out = window.formatWeight(NaN, 'lb');
        expect(Number.isNaN(out.value)).toBe(true);
        expect(out.label).toBe('lb');
    });
});

describe('Weight render surfaces honor unit preference (Task 5)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    describe('renderWeightGoalCard', () => {
        it('renders the goal value in kg when preference is kg', () => {
            const { window, document } = env;
            window.weightUnitPreference = 'kg';
            const logs = [{ measured_at: isoDaysAgo(0), weight: 80.0 }];
            window.renderWeightGoalCard(logs, { goal: 75, goal_direction: 'lose', highest_weight: 85 });
            const value = document.querySelector('.wg-weight-goal-card__value');
            expect(value.textContent).toBe('75.0 kg');
        });

        it('renders the goal value in lb when preference is lb', () => {
            const { window, document } = env;
            window.weightUnitPreference = 'lb';
            const logs = [{ measured_at: isoDaysAgo(0), weight: 80.0 }];
            window.renderWeightGoalCard(logs, { goal: 75, goal_direction: 'lose', highest_weight: 85 });
            const value = document.querySelector('.wg-weight-goal-card__value');
            // 75 kg ≈ 165.3 lb
            expect(value.textContent).toMatch(/165\.3 lb/);
        });

        it('renders delta-to-goal in lb when preference is lb', () => {
            const { window, document } = env;
            window.weightUnitPreference = 'lb';
            const logs = [{ measured_at: isoDaysAgo(0), weight: 80.0 }];
            window.renderWeightGoalCard(logs, { goal: 75, goal_direction: 'lose', highest_weight: 85 });
            const delta = document.querySelector('.wg-weight-goal-card__delta');
            // 5 kg above goal ≈ 11.0 lb
            expect(delta.textContent).toMatch(/lb to goal/);
            expect(delta.textContent).toMatch(/\+11\.0/);
        });
    });

    describe('renderWeightChartLegend', () => {
        it('shows Goal in kg when preference is kg', () => {
            const { window, document } = env;
            window.weightUnitPreference = 'kg';
            window.renderWeightChartLegend({ goal: 75 });
            const labels = Array.from(document.querySelectorAll('.wg-weight-chart-legend__label'))
                .map((n) => n.textContent);
            expect(labels[2]).toBe('Goal 75.0 kg');
        });

        it('shows Goal in lb when preference is lb', () => {
            const { window, document } = env;
            window.weightUnitPreference = 'lb';
            window.renderWeightChartLegend({ goal: 75 });
            const labels = Array.from(document.querySelectorAll('.wg-weight-chart-legend__label'))
                .map((n) => n.textContent);
            expect(labels[2]).toMatch(/Goal 165\.3 lb/);
        });
    });

    describe('renderWeightPrognosisCard', () => {
        it('renders weekly trend in kg/week when preference is kg', () => {
            const { window, document } = env;
            window.weightUnitPreference = 'kg';
            const logs = [
                { measured_at: isoDaysAgo(0), weight: 81.4 },
                { measured_at: isoDaysAgo(7), weight: 80.7 },
                { measured_at: isoDaysAgo(14), weight: 80.0 },
            ];
            window.renderWeightPrognosisCard(logs, { goal: 75, goal_direction: 'lose' });
            const trendValue = document.querySelector('.wg-weight-prognosis-card__trend-value');
            expect(trendValue.textContent).toMatch(/kg\/week/);
        });

        it('renders weekly trend in lb/week when preference is lb', () => {
            const { window, document } = env;
            window.weightUnitPreference = 'lb';
            const logs = [
                { measured_at: isoDaysAgo(0), weight: 81.4 },
                { measured_at: isoDaysAgo(7), weight: 80.7 },
                { measured_at: isoDaysAgo(14), weight: 80.0 },
            ];
            window.renderWeightPrognosisCard(logs, { goal: 75, goal_direction: 'lose' });
            const trendValue = document.querySelector('.wg-weight-prognosis-card__trend-value');
            expect(trendValue.textContent).toMatch(/lb\/week/);
            expect(trendValue.textContent).not.toMatch(/kg\/week/);
        });
    });

    describe('renderWeightChart current badge', () => {
        it('shows the current weight in kg when preference is kg', () => {
            const { window, document } = env;
            window.weightUnitPreference = 'kg';
            const logs = [
                { measured_at: isoDaysAgo(7), weight: 82.0 },
                { measured_at: isoDaysAgo(1), weight: 80.2 },
            ];
            // Latest is at index 0 (newest-first), so make sure logs are newest-first.
            const newestFirst = logs.slice().reverse();
            window.renderWeightChart(newestFirst, { goal: 75 });
            const value = document.querySelector('.wg-weight-chart-panel__current-value');
            expect(value).not.toBeNull();
            expect(value.textContent).toMatch(/^80\.2/);
            const unit = document.querySelector('.wg-weight-chart-panel__current-unit');
            expect(unit.textContent).toBe('kg');
        });

        it('shows the current weight in lb when preference is lb', () => {
            const { window, document } = env;
            window.weightUnitPreference = 'lb';
            const logs = [
                { measured_at: isoDaysAgo(7), weight: 82.0 },
                { measured_at: isoDaysAgo(1), weight: 80.2 },
            ];
            const newestFirst = logs.slice().reverse();
            window.renderWeightChart(newestFirst, { goal: 75 });
            const unit = document.querySelector('.wg-weight-chart-panel__current-unit');
            expect(unit.textContent).toBe('lb');
            const value = document.querySelector('.wg-weight-chart-panel__current-value');
            // 80.2 kg ≈ 176.8 lb
            const expected = Math.round((80.2 / KG_PER_LB) * 10) / 10;
            expect(value.textContent).toMatch(new RegExp(String(expected)));
        });
    });

    describe('renderWeightLogs (history list)', () => {
        it('shows kg in each row when preference is kg', () => {
            const { window, document } = env;
            window.weightUnitPreference = 'kg';
            window.renderWeightLogs([
                { id: 1, measured_at: isoDaysAgo(0), weight: 75.4 }
            ], 'all');
            const row = document.querySelector('#weight-list .wg-weight-history-row');
            expect(row.querySelector('.wg-weight-history-row__weight').textContent).toBe('75.4');
            expect(row.querySelector('.wg-weight-history-row__unit').textContent).toBe('kg');
        });

        it('converts to lb in each row when preference is lb', () => {
            const { window, document } = env;
            window.weightUnitPreference = 'lb';
            window.renderWeightLogs([
                { id: 1, measured_at: isoDaysAgo(0), weight: 75.4 }
            ], 'all');
            const row = document.querySelector('#weight-list .wg-weight-history-row');
            const expected = Math.round((75.4 / KG_PER_LB) * 10) / 10;
            expect(row.querySelector('.wg-weight-history-row__weight').textContent).toBe(String(expected));
            expect(row.querySelector('.wg-weight-history-row__unit').textContent).toBe('lb');
        });
    });
});

// Today tile honoring the unit preference. The Today screen tests load only a
// minimal subset of scripts (no app harness), so we provide the same minimal
// load order plus utils.js so formatWeight is available, then call the
// internal renderToday with a state object exercising the weight tile.
function loadTodayMinimal() {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="today-content"></div></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(fs.readFileSync(UTILS_JS, 'utf8'));
    window.eval(fs.readFileSync(EMPTY_STATE_JS, 'utf8') + '\nwindow.createEmptyState = createEmptyState;');
    window.eval(fs.readFileSync(WG_ICONS_JS, 'utf8'));
    window.eval(fs.readFileSync(WG_SPARKLINE_JS, 'utf8'));
    window.eval(fs.readFileSync(TODAY_JS, 'utf8'));
    return {
        window,
        document: window.document,
        render: window.TodayDashboard.renderToday,
        cleanup: () => dom.window.close()
    };
}

function presentWeightState(now) {
    return {
        greeting: { value: 'Good morning', deeplink: null, status: 'ok' },
        nextMed: { value: null, deeplink: 'meds', status: 'missing' },
        bpLatest: { value: null, deeplink: 'bp', status: 'missing' },
        bpTrend7d: { value: null, deeplink: 'bp', status: 'missing' },
        weightLatest: {
            value: { weight: 80.0, measured_at: new Date(now.getTime() - 24 * 60 * 60000).toISOString() },
            deeplink: 'weight',
            status: 'ok'
        },
        weightTrend7d: {
            value: { direction: 'down', delta: -0.4, points: [80.6, 80.2, 80.0] },
            deeplink: 'weight',
            status: 'ok'
        },
        caloriesToday: { value: null, deeplink: 'food', status: 'disabled' },
        caloriesTarget: { value: null, deeplink: 'food', status: 'disabled' },
        macrosToday: { value: null, deeplink: 'food', status: 'disabled' },
        macrosTarget: { value: null, deeplink: 'food', status: 'disabled' },
        nextWorkout: { value: null, deeplink: 'workouts', status: 'disabled' },
        sleepLastNight: { value: null, deeplink: 'health', status: 'disabled' }
    };
}

describe('Today tile renderWeightTile honors weight unit preference', () => {
    let env;
    const now = new Date('2026-04-20T09:00:00Z');

    beforeEach(() => {
        env = loadTodayMinimal();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('shows weight + 7d trend in kg when preference is kg', () => {
        const root = env.document.getElementById('today-content');
        env.window.weightUnitPreference = 'kg';
        env.render(presentWeightState(now), root, { now });

        const tile = root.querySelector('.wg-metric-tile[data-deeplink="weight"]');
        expect(tile).not.toBeNull();
        const value = tile.querySelector('.wg-metric-tile__value').textContent;
        const unit = tile.querySelector('.wg-metric-tile__unit').textContent;
        const tag = tile.querySelector('.wg-tag');
        expect(value).toBe('80');
        expect(unit).toMatch(/^kg/);
        expect(tag.textContent).toMatch(/7d -0\.4/);
    });

    it('shows weight + 7d trend converted to lb when preference is lb', () => {
        const root = env.document.getElementById('today-content');
        env.window.weightUnitPreference = 'lb';
        env.render(presentWeightState(now), root, { now });

        const tile = root.querySelector('.wg-metric-tile[data-deeplink="weight"]');
        const value = tile.querySelector('.wg-metric-tile__value').textContent;
        const unit = tile.querySelector('.wg-metric-tile__unit').textContent;
        const tag = tile.querySelector('.wg-tag');
        // 80 kg ≈ 176.4 lb
        const expected = Math.round((80 / KG_PER_LB) * 10) / 10;
        expect(value).toBe(String(expected));
        expect(unit).toMatch(/^lb/);
        // Trend delta -0.4 kg ≈ -0.9 lb
        const expectedDelta = Math.round((0.4 / KG_PER_LB) * 10) / 10;
        expect(tag.textContent).toMatch(new RegExp(`7d -${expectedDelta}`));
    });
});
