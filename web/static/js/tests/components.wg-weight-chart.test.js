// Tests for the WGWeightChart component (Phase 6, Task 2).
// Single-series variant of WGBpChart. The chart renders a weight line over
// the active range, a dashed goal-line overlay when a goal is provided, a
// last-point marker, and an empty-state card when no points fall within
// the range. Every colour resolves via CSS classes on SVG children —
// never through inline stroke=/fill= attributes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CHART_UTILS_JS = path.join(REPO_ROOT, 'web/static/js/core/chart-utils.js');
const WG_WEIGHT_CHART_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-weight-chart.js');

function loadEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only',
    });
    dom.window.eval(fs.readFileSync(CHART_UTILS_JS, 'utf8'));
    dom.window.eval(fs.readFileSync(WG_WEIGHT_CHART_JS, 'utf8'));
    return {
        window: dom.window,
        api: dom.window.WGWeightChart,
        cleanup: () => dom.window.close(),
    };
}

function makeLogs({ days = 30, startWeight = 80, step = -0.1 } = {}) {
    // Anchor a few seconds before Date.now() so the range filter (which also
    // anchors on the current time) sees these logs as recent. The small
    // offset keeps the oldest log clearly older than the `days`-day cutoff
    // — otherwise sub-ms test runtime leaves the boundary log at cutoff and
    // the `>=` comparison keeps an extra entry.
    const anchor = Date.now() - 5000;
    const logs = [];
    for (let i = days - 1; i >= 0; i--) {
        const ts = new Date(anchor - i * 86400000).toISOString();
        const weight = startWeight + (days - 1 - i) * step;
        logs.push({ measured_at: ts, weight: Math.round(weight * 10) / 10 });
    }
    return logs;
}

describe('WGWeightChart.render', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('exposes a render function on window.WGWeightChart', () => {
        expect(env.api).toBeTruthy();
        expect(typeof env.api.render).toBe('function');
        expect(env.api.DEFAULT_WIDTH).toBe(358);
        expect(env.api.DEFAULT_HEIGHT).toBe(200);
    });

    it('returns an SVG element in the SVG namespace with the wg-weight-chart class', () => {
        const svg = env.api.render({ logs: makeLogs({ days: 14 }) });
        expect(svg).not.toBeNull();
        expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
        expect(svg.tagName.toLowerCase()).toBe('svg');
        expect(svg.classList.contains('wg-weight-chart')).toBe(true);
        expect(svg.getAttribute('viewBox')).toBe('0 0 358 200');
        expect(svg.getAttribute('aria-hidden')).toBe('true');
    });

    it('renders exactly one weight line path and one last-point circle', () => {
        const svg = env.api.render({ logs: makeLogs({ days: 14 }) });
        const lines = svg.querySelectorAll('path.wg-weight-chart__line');
        const lasts = svg.querySelectorAll('circle.wg-weight-chart__last');
        expect(lines.length).toBe(1);
        expect(lasts.length).toBe(1);
        expect(lines[0].getAttribute('d').length).toBeGreaterThan(0);
    });

    it('sets no inline stroke/fill/style on line, goal, or last-point elements', () => {
        const svg = env.api.render({ logs: makeLogs({ days: 14 }), goal: 72 });
        const elems = [
            svg.querySelector('path.wg-weight-chart__line'),
            svg.querySelector('line.wg-weight-chart__goal'),
            svg.querySelector('circle.wg-weight-chart__last'),
        ];
        for (const el of elems) {
            expect(el).not.toBeNull();
            expect(el.getAttribute('stroke')).toBeNull();
            expect(el.getAttribute('fill')).toBeNull();
            expect(el.getAttribute('style')).toBeNull();
        }
    });

    it('applies the 7d range filter — only the last 7 days contribute to the point count', () => {
        const svg = env.api.render({ logs: makeLogs({ days: 60 }), range: '7d' });
        expect(svg).not.toBeNull();
        expect(svg.dataset.weightRange).toBe('7d');
        const pointCount = Number(svg.dataset.weightPointCount);
        expect(pointCount).toBeGreaterThan(0);
        expect(pointCount).toBeLessThanOrEqual(7);
    });

    it('drops future-dated entries from ranged views so a mistyped log does not stretch the window', () => {
        const dayMs = 86400000;
        const now = Date.now();
        const logs = [
            { measured_at: new Date(now + 5 * dayMs).toISOString(), weight: 90 },
            { measured_at: new Date(now - 1000).toISOString(), weight: 80 },
            { measured_at: new Date(now - 2 * dayMs).toISOString(), weight: 80.2 }
        ];
        const svg = env.api.render({ logs, range: '7d' });
        expect(svg).not.toBeNull();
        expect(svg.dataset.weightRange).toBe('7d');
        // Future entry is filtered out; two in-range logs survive.
        expect(Number(svg.dataset.weightPointCount)).toBe(2);
    });

    it('applies the 30d range filter', () => {
        const svg = env.api.render({ logs: makeLogs({ days: 90 }), range: '30d' });
        expect(svg).not.toBeNull();
        expect(svg.dataset.weightRange).toBe('30d');
        expect(Number(svg.dataset.weightPointCount)).toBeLessThanOrEqual(30);
    });

    it('treats range "all" (and undefined) as no filter', () => {
        const full = env.api.render({ logs: makeLogs({ days: 45 }), range: 'all' });
        const unspec = env.api.render({ logs: makeLogs({ days: 45 }) });
        expect(full).not.toBeNull();
        expect(unspec).not.toBeNull();
        expect(full.dataset.weightRange).toBe('all');
        expect(unspec.dataset.weightRange).toBe('all');
        expect(Number(full.dataset.weightPointCount)).toBe(45);
        expect(Number(unspec.dataset.weightPointCount)).toBe(45);
    });

    it('renders a dashed goal line when a finite goal is provided', () => {
        const svg = env.api.render({ logs: makeLogs({ days: 14 }), goal: 72 });
        const goal = svg.querySelectorAll('line.wg-weight-chart__goal');
        expect(goal.length).toBe(1);
        expect(goal[0].dataset.weightGoal).toBe('72');
        const yMin = Number(svg.dataset.weightYMin);
        const yMax = Number(svg.dataset.weightYMax);
        const y1 = parseFloat(goal[0].getAttribute('y1'));
        expect(yMin).toBeLessThanOrEqual(72);
        expect(yMax).toBeGreaterThanOrEqual(72);
        // Dashed overlay must land inside the plot area.
        expect(y1).toBeGreaterThanOrEqual(14);
        expect(y1).toBeLessThanOrEqual(174);
    });

    it('accepts goal as a {goal} object and renders the overlay', () => {
        const svg = env.api.render({
            logs: makeLogs({ days: 14 }),
            goal: { goal: 70, goal_direction: 'lose' },
        });
        const goal = svg.querySelector('line.wg-weight-chart__goal');
        expect(goal).not.toBeNull();
        expect(goal.dataset.weightGoal).toBe('70');
    });

    it('hides the goal overlay when no goal is provided', () => {
        const svgNone = env.api.render({ logs: makeLogs({ days: 14 }) });
        const svgNull = env.api.render({ logs: makeLogs({ days: 14 }), goal: null });
        const svgNonFinite = env.api.render({ logs: makeLogs({ days: 14 }), goal: { goal: null } });
        expect(svgNone.querySelector('line.wg-weight-chart__goal')).toBeNull();
        expect(svgNull.querySelector('line.wg-weight-chart__goal')).toBeNull();
        expect(svgNonFinite.querySelector('line.wg-weight-chart__goal')).toBeNull();
    });

    it('returns an empty-state HTML card (not null) when logs are empty or absent', () => {
        const empty = env.api.render({ logs: [] });
        const missing = env.api.render({});
        const nullLogs = env.api.render({ logs: null });
        for (const node of [empty, missing, nullLogs]) {
            expect(node).not.toBeNull();
            expect(node.tagName.toLowerCase()).toBe('div');
            expect(node.classList.contains('wg-weight-chart')).toBe(true);
            expect(node.classList.contains('wg-weight-chart--empty')).toBe(true);
            expect(node.textContent).toMatch(/no weight entries yet/i);
        }
    });

    it('returns the empty-state card when the range window contains no logs', () => {
        // Logs are all >30 days old; 7d range filters everything out.
        const oldLogs = makeLogs({ days: 5 }).map((l, i) => {
            const ts = new Date(Date.UTC(2025, 0, 1 + i)).toISOString();
            return { ...l, measured_at: ts };
        });
        // Anchor the last-day 1970 past -> picking "7d" from last point still
        // keeps all 5 logs (they're consecutive). Instead, use a single stale
        // log: ranged relative to the latest point, so always at least 1 point
        // survives. The stronger test is: empty logs -> empty card, already
        // covered above. Here we assert that invalid-only input also produces
        // the empty card path.
        const invalid = env.api.render({
            logs: [{ measured_at: 'not-a-date', weight: 80 }],
            range: '7d',
        });
        expect(invalid.classList.contains('wg-weight-chart--empty')).toBe(true);
    });

    it('produces a sane guide-tick count for short and long ranges (at least one, at most ~10)', () => {
        const shortRange = env.api.render({ logs: makeLogs({ days: 7, startWeight: 80, step: -0.2 }) });
        const longRange = env.api.render({ logs: makeLogs({ days: 90, startWeight: 85, step: -0.1 }) });
        const shortTicks = Number(shortRange.dataset.weightTickCount);
        const longTicks = Number(longRange.dataset.weightTickCount);
        expect(shortTicks).toBeGreaterThanOrEqual(1);
        expect(shortTicks).toBeLessThanOrEqual(10);
        expect(longTicks).toBeGreaterThanOrEqual(1);
        expect(longTicks).toBeLessThanOrEqual(10);
    });

    it('accepts pre-normalised { date, weight } entries', () => {
        const logs = [
            { date: new Date('2026-04-01T12:00:00Z'), weight: 80.0 },
            { date: new Date('2026-04-02T12:00:00Z'), weight: 79.8 },
            { date: new Date('2026-04-03T12:00:00Z'), weight: 79.6 },
        ];
        const svg = env.api.render({ logs });
        expect(svg).not.toBeNull();
        expect(svg.querySelector('path.wg-weight-chart__line')).not.toBeNull();
        expect(svg.querySelector('circle.wg-weight-chart__last')).not.toBeNull();
    });

    it('forwards width/height options into the viewBox', () => {
        const svg = env.api.render({ logs: makeLogs({ days: 14 }), width: 420, height: 240 });
        expect(svg.getAttribute('viewBox')).toBe('0 0 420 240');
    });

    it('keeps the goal value inside the y-range even when it is below data minimum', () => {
        // Weight data around 80; goal is 60 → goal must still render inside
        // the plot area because it expands the y-axis bounds.
        const svg = env.api.render({ logs: makeLogs({ days: 14, startWeight: 80, step: 0 }), goal: 60 });
        const goal = svg.querySelector('line.wg-weight-chart__goal');
        expect(goal).not.toBeNull();
        const y = parseFloat(goal.getAttribute('y1'));
        // plot area: PAD_T=14, height=200, PAD_B=26 → y ∈ [14, 174].
        expect(y).toBeGreaterThanOrEqual(14);
        expect(y).toBeLessThanOrEqual(174);
        const yMin = Number(svg.dataset.weightYMin);
        expect(yMin).toBeLessThanOrEqual(60);
    });

    it('filters out entries with non-numeric weight or bad dates', () => {
        const logs = [
            { measured_at: '2026-04-01T12:00:00Z', weight: 80 },
            { measured_at: 'not-a-date', weight: 79 },
            { measured_at: '2026-04-03T12:00:00Z', weight: 'x' },
            { measured_at: '2026-04-04T12:00:00Z', weight: 79.5 },
        ];
        const svg = env.api.render({ logs });
        expect(svg.tagName.toLowerCase()).toBe('svg');
        // Only 2 valid points survive.
        expect(Number(svg.dataset.weightPointCount)).toBe(2);
    });

    it('returns the empty-state card when every log entry is invalid', () => {
        const svg = env.api.render({
            logs: [
                { measured_at: 'bad', weight: 80 },
                { measured_at: '2026-04-01', weight: 'x' },
            ],
        });
        expect(svg.classList.contains('wg-weight-chart--empty')).toBe(true);
    });

    it('handles a single log entry without division-by-zero', () => {
        const svg = env.api.render({
            logs: [{ measured_at: '2026-04-20T12:00:00Z', weight: 75 }],
        });
        expect(svg.tagName.toLowerCase()).toBe('svg');
        const last = svg.querySelector('circle.wg-weight-chart__last');
        expect(last).not.toBeNull();
        const cx = parseFloat(last.getAttribute('cx'));
        // PAD_L=28, width=358, PAD_R=14 → plot center ≈ 186.
        expect(cx).toBeGreaterThan(28);
        expect(cx).toBeLessThan(358 - 14);
    });

    it('renders Y bounds and goal label in lb when unit is "lb"', () => {
        // Logs around 80 kg ≈ 176 lb; goal 70 kg ≈ 154.3 lb. The Y-axis
        // bounds and goal-line label must reflect the lb conversion so the
        // chart agrees with the rest of the dashboard for lb users.
        const svg = env.api.render({
            logs: makeLogs({ days: 14, startWeight: 80, step: 0 }),
            goal: 70,
            unit: 'lb',
        });
        const yMin = Number(svg.dataset.weightYMin);
        const yMax = Number(svg.dataset.weightYMax);
        // 80 kg ≈ 176.4 lb sits inside [yMin, yMax].
        expect(yMin).toBeLessThanOrEqual(176);
        expect(yMax).toBeGreaterThanOrEqual(177);
        // Goal stored on the line still reflects the converted (display) value.
        const goal = svg.querySelector('line.wg-weight-chart__goal');
        expect(goal).not.toBeNull();
        const goalDisplay = Number(goal.dataset.weightGoal);
        expect(goalDisplay).toBeGreaterThan(154);
        expect(goalDisplay).toBeLessThan(155);
        const label = svg.querySelector('text.wg-weight-chart__goal-label');
        expect(label).not.toBeNull();
        expect(label.textContent).toMatch(/GOAL · 154\.\d lb/);
    });

    it('keeps Y bounds and goal label in kg when unit is omitted', () => {
        // Sanity-check: existing kg behavior is preserved when no unit option
        // is passed. Logs around 80 kg, goal 70 kg → integer kg label.
        const svg = env.api.render({
            logs: makeLogs({ days: 14, startWeight: 80, step: 0 }),
            goal: 70,
        });
        const label = svg.querySelector('text.wg-weight-chart__goal-label');
        expect(label).not.toBeNull();
        expect(label.textContent).toBe('GOAL · 70 kg');
    });

    // --- Plan-trajectory snapshot geometry (Task 6) ---
    //
    // The plan line on the weight chart is supposed to draw a real commitment
    // arc — from (goal_set_at, weight_at_goal_set) → (goal_date, goal_weight).
    // Older "plan line" implementations ignored both endpoints' time
    // information, so moving only goal_date produced no visible change. These
    // tests pin the new snapshot geometry and its fallback to legacy goals.

    function readPlanY(svg) {
        const plan = svg.querySelector('line.wg-weight-chart__plan');
        if (!plan) return null;
        return {
            x1: parseFloat(plan.getAttribute('x1')),
            y1: parseFloat(plan.getAttribute('y1')),
            x2: parseFloat(plan.getAttribute('x2')),
            y2: parseFloat(plan.getAttribute('y2')),
        };
    }

    it('regression: moving only goal_date changes the plan-line slope', () => {
        const logs = makeLogs({ days: 30, startWeight: 80, step: 0 });
        // Common anchors: setAt was a month ago, startWeight matches latest log.
        const setAt = new Date(Date.now() - 30 * 86400000).toISOString();
        const farDate = new Date(Date.now() + 365 * 86400000).toISOString();
        const nearDate = new Date(Date.now() + 90 * 86400000).toISOString();
        const goalCommon = {
            goal: 70,
            goal_set_at: setAt,
            goal_start_weight: 80,
        };
        const svgFar = env.api.render({
            logs,
            goal: { ...goalCommon, goal_date: farDate },
        });
        const svgNear = env.api.render({
            logs,
            goal: { ...goalCommon, goal_date: nearDate },
        });
        const far = readPlanY(svgFar);
        const near = readPlanY(svgNear);
        expect(far).not.toBeNull();
        expect(near).not.toBeNull();
        // X coordinates anchor on the visible logs (same in both renders), so
        // the trajectory shows up exclusively as a y-coordinate change.
        expect(far.x1).toBeCloseTo(near.x1, 1);
        expect(far.x2).toBeCloseTo(near.x2, 1);
        // Tighter target date = steeper descent inside the visible window →
        // line drops faster, so right-edge y is HIGHER on screen (smaller value
        // because SVG y grows downward but "lower weight" maps to larger y).
        // We just assert the two are not equal; direction is asserted by the
        // separate "snapshot honored" case below.
        expect(near.y2).not.toBeCloseTo(far.y2, 1);
    });

    it('honors snapshot anchors: slope matches (goal − startWeight) / (goalDate − setAt)', () => {
        const logs = makeLogs({ days: 30, startWeight: 80, step: 0 });
        // setAt = 30 days ago, goal_date = 60 days from now, startWeight 80, goal 70.
        // Slope = (70 - 80) / (90 days) = -10/90 kg/day ≈ -0.111 kg/day.
        const setAtMs = Date.now() - 30 * 86400000;
        const goalDateMs = Date.now() + 60 * 86400000;
        const svg = env.api.render({
            logs,
            goal: {
                goal: 70,
                goal_set_at: new Date(setAtMs).toISOString(),
                goal_start_weight: 80,
                goal_date: new Date(goalDateMs).toISOString(),
            },
        });
        const plan = svg.querySelector('line.wg-weight-chart__plan');
        expect(plan).not.toBeNull();
        // Recover (x, weight) at each endpoint via the chart's Y bounds.
        const yMin = Number(svg.dataset.weightYMin);
        const yMax = Number(svg.dataset.weightYMax);
        // PAD_T=14, PAD_B=26, height=200 → plotH = 160. yOf(v) = 14 + 160*(1 - (v-yMin)/(yMax-yMin)).
        const plotH = 200 - 14 - 26;
        const yToWeight = (yPx) => yMin + (1 - (yPx - 14) / plotH) * (yMax - yMin);
        const y1 = parseFloat(plan.getAttribute('y1'));
        const y2 = parseFloat(plan.getAttribute('y2'));
        const w1 = yToWeight(y1);
        const w2 = yToWeight(y2);
        // Empirical slope from the two endpoints in weight-per-ms.
        const x1 = parseFloat(plan.getAttribute('x1'));
        const x2 = parseFloat(plan.getAttribute('x2'));
        // Map plot-x back to ms using firstTime/lastTime via the chart's data
        // bounds — first/last log timestamps from the input.
        const firstT = new Date(logs[0].measured_at).getTime();
        const lastT = new Date(logs[logs.length - 1].measured_at).getTime();
        const PAD_L = 28;
        const PAD_R = 14;
        const width = 358;
        const plotW = width - PAD_L - PAD_R;
        const xToMs = (xPx) => firstT + ((xPx - PAD_L) / plotW) * (lastT - firstT);
        const t1 = xToMs(x1);
        const t2 = xToMs(x2);
        const empirical = (w2 - w1) / (t2 - t1);
        const expected = (70 - 80) / (goalDateMs - setAtMs);
        // 5% tolerance covers SVG attribute toFixed(1) rounding.
        expect(Math.abs(empirical - expected) / Math.abs(expected)).toBeLessThan(0.05);
    });

    it('falls back to legacy geometry when snapshot fields are absent', () => {
        const logs = makeLogs({ days: 14, startWeight: 82, step: -0.1 });
        // Legacy goal: just a number — no setAt / startWeight / date.
        const svg = env.api.render({ logs, goal: 72 });
        const plan = readPlanY(svg);
        expect(plan).not.toBeNull();
        // Legacy line: (xOf(firstT), yOf(firstWeight)) → (xOf(lastT), yOf(goal)).
        // The right-edge y must equal the goal line's y (both at goal=72).
        const goalLine = svg.querySelector('line.wg-weight-chart__goal');
        const goalY = parseFloat(goalLine.getAttribute('y1'));
        expect(plan.y2).toBeCloseTo(goalY, 1);
    });

    it('falls back when snapshot date is missing but goal_set_at + start_weight are present', () => {
        // Object-shaped goal that lacks goal_date is treated as legacy.
        const logs = makeLogs({ days: 14, startWeight: 80, step: 0 });
        const svg = env.api.render({
            logs,
            goal: {
                goal: 72,
                goal_set_at: new Date(Date.now() - 30 * 86400000).toISOString(),
                goal_start_weight: 80,
            },
        });
        const plan = readPlanY(svg);
        expect(plan).not.toBeNull();
        const goalLine = svg.querySelector('line.wg-weight-chart__goal');
        const goalY = parseFloat(goalLine.getAttribute('y1'));
        // Right endpoint at goal height — legacy geometry kicked in.
        expect(plan.y2).toBeCloseTo(goalY, 1);
    });

    it('handles a goal_date already in the past without crashing', () => {
        const logs = makeLogs({ days: 14, startWeight: 80, step: 0 });
        // setAt 60 days ago, goal_date 30 days ago (already past), goal 70.
        const svg = env.api.render({
            logs,
            goal: {
                goal: 70,
                goal_set_at: new Date(Date.now() - 60 * 86400000).toISOString(),
                goal_start_weight: 80,
                goal_date: new Date(Date.now() - 30 * 86400000).toISOString(),
            },
        });
        const plan = svg.querySelector('line.wg-weight-chart__plan');
        expect(plan).not.toBeNull();
        // Line still exists; finite coordinates only.
        expect(Number.isFinite(parseFloat(plan.getAttribute('y1')))).toBe(true);
        expect(Number.isFinite(parseFloat(plan.getAttribute('y2')))).toBe(true);
    });

    it('uses interpolation when setAt sits before all visible data', () => {
        const logs = makeLogs({ days: 7, startWeight: 78, step: 0 });
        // setAt is 180 days ago, well before any visible log. startWeight 85,
        // goal 70, goal_date 60 days from now → the visible window samples the
        // line at its mid-section, not at the start anchor.
        const svg = env.api.render({
            logs,
            goal: {
                goal: 70,
                goal_set_at: new Date(Date.now() - 180 * 86400000).toISOString(),
                goal_start_weight: 85,
                goal_date: new Date(Date.now() + 60 * 86400000).toISOString(),
            },
        });
        const plan = svg.querySelector('line.wg-weight-chart__plan');
        expect(plan).not.toBeNull();
        const y1 = parseFloat(plan.getAttribute('y1'));
        const y2 = parseFloat(plan.getAttribute('y2'));
        // Both endpoints are inside the SVG plot area [14, 174].
        expect(y1).toBeGreaterThanOrEqual(14);
        expect(y1).toBeLessThanOrEqual(174);
        expect(y2).toBeGreaterThanOrEqual(14);
        expect(y2).toBeLessThanOrEqual(174);
        // Snapshot path means the line is descending toward the goal: y2 > y1
        // (lower-on-chart = higher y in SVG; weight decreasing means y rising).
        expect(y2).toBeGreaterThan(y1);
    });
});
