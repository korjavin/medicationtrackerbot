// Tests for the WGStepsChart component (Phase 8, Task 5).
// Single-series bar renderer for the Health Overview steps card. Every colour
// resolves via CSS classes on SVG children — never through inline
// stroke=/fill= attributes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CHART_UTILS_JS = path.join(REPO_ROOT, 'web/static/js/core/chart-utils.js');
const WG_STEPS_CHART_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-steps-chart.js');

function loadEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only',
    });
    dom.window.eval(fs.readFileSync(CHART_UTILS_JS, 'utf8'));
    dom.window.eval(fs.readFileSync(WG_STEPS_CHART_JS, 'utf8'));
    return {
        window: dom.window,
        api: dom.window.WGStepsChart,
        cleanup: () => dom.window.close(),
    };
}

function toLocalISODate(d) {
    // The chart's isToday() compares local-midnight boundaries; using
    // toISOString() (UTC) here would label "today" as tomorrow whenever the
    // test runs after local midnight UTC. Format YYYY-MM-DD from local parts.
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function makeStats({ days = 7, stepsEach = 8000 } = {}) {
    const anchor = Date.now() - 5000;
    const dayMs = 86400000;
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(anchor - i * dayMs);
        const iso = toLocalISODate(d);
        out.push({ day: iso, steps: stepsEach + i * 100 });
    }
    return out;
}

describe('WGStepsChart.render', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('exposes a render function on window.WGStepsChart', () => {
        expect(env.api).toBeTruthy();
        expect(typeof env.api.render).toBe('function');
        expect(env.api.DEFAULT_WIDTH).toBe(358);
        expect(env.api.DEFAULT_HEIGHT).toBe(240);
    });

    it('returns an SVG element in the SVG namespace with the wg-steps-chart class', () => {
        const svg = env.api.render({ stats: makeStats({ days: 5 }) });
        expect(svg).not.toBeNull();
        expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
        expect(svg.tagName.toLowerCase()).toBe('svg');
        expect(svg.classList.contains('wg-steps-chart')).toBe(true);
        expect(svg.getAttribute('viewBox')).toBe('0 0 358 240');
        expect(svg.getAttribute('aria-hidden')).toBe('true');
    });

    it('renders one bar per data point', () => {
        const svg = env.api.render({ stats: makeStats({ days: 3 }) });
        const bars = svg.querySelectorAll('rect.wg-steps-chart__bar');
        expect(bars.length).toBe(3);
    });

    it('renders a minimum-height bar for zero-step days', () => {
        const svg = env.api.render({
            stats: [
                { day: '2026-04-01', steps: 0 },
                { day: '2026-04-02', steps: 5000 },
            ],
        });
        const bars = svg.querySelectorAll('rect.wg-steps-chart__bar');
        expect(bars.length).toBe(2);
        const zeroBarHeight = Number(bars[0].getAttribute('height'));
        expect(zeroBarHeight).toBeGreaterThan(0);
    });

    it('sets no inline stroke/fill/style on bar rects or labels', () => {
        const svg = env.api.render({ stats: makeStats({ days: 5 }) });
        const all = svg.querySelectorAll(
            'rect.wg-steps-chart__bar, text.wg-steps-chart__count-label, ' +
            'text.wg-steps-chart__axis-label, text.wg-steps-chart__day-label, ' +
            'line.wg-steps-chart__guide'
        );
        expect(all.length).toBeGreaterThan(0);
        for (const el of all) {
            expect(el.getAttribute('stroke')).toBeNull();
            expect(el.getAttribute('fill')).toBeNull();
            expect(el.getAttribute('style')).toBeNull();
        }
    });

    it('emits a count label per non-zero day with the --inside or --outside variant', () => {
        const svg = env.api.render({ stats: makeStats({ days: 5, stepsEach: 8000 }) });
        const labels = svg.querySelectorAll('text.wg-steps-chart__count-label');
        expect(labels.length).toBe(5);
        for (const label of labels) {
            const inside = label.classList.contains('wg-steps-chart__count-label--inside');
            const outside = label.classList.contains('wg-steps-chart__count-label--outside');
            expect(inside || outside).toBe(true);
        }
    });

    it('omits the count label when steps is zero', () => {
        const svg = env.api.render({
            stats: [
                { day: '2026-04-01', steps: 0 },
                { day: '2026-04-02', steps: 0 },
            ],
        });
        const labels = svg.querySelectorAll('text.wg-steps-chart__count-label');
        expect(labels.length).toBe(0);
    });

    it('count labels are rotated -90° for vertical display', () => {
        const svg = env.api.render({ stats: makeStats({ days: 3, stepsEach: 8000 }) });
        const labels = svg.querySelectorAll('text.wg-steps-chart__count-label');
        labels.forEach((l) => {
            const transform = l.getAttribute('transform') || '';
            expect(transform).toMatch(/^rotate\(-90 /);
        });
    });

    it('applies the 7d range filter — only entries in the last 7 days contribute', () => {
        const stats = makeStats({ days: 14 });
        const svg = env.api.render({ stats, range: '7d' });
        expect(svg).not.toBeNull();
        expect(svg.dataset.stepsRange).toBe('7d');
        const pointCount = Number(svg.dataset.stepsPointCount);
        expect(pointCount).toBeGreaterThan(0);
        expect(pointCount).toBeLessThanOrEqual(7);
    });

    it('applies the 30d range filter', () => {
        const stats = makeStats({ days: 60 });
        const svg = env.api.render({ stats, range: '30d' });
        expect(svg).not.toBeNull();
        expect(svg.dataset.stepsRange).toBe('30d');
        const pointCount = Number(svg.dataset.stepsPointCount);
        expect(pointCount).toBeGreaterThan(0);
        expect(pointCount).toBeLessThanOrEqual(30);
    });

    it("treats range 'all' (and undefined) as no filter", () => {
        const stats = makeStats({ days: 14 });
        const full = env.api.render({ stats, range: 'all' });
        const unspec = env.api.render({ stats });
        expect(full.dataset.stepsRange).toBe('all');
        expect(unspec.dataset.stepsRange).toBe('all');
        expect(Number(full.dataset.stepsPointCount)).toBe(14);
        expect(Number(unspec.dataset.stepsPointCount)).toBe(14);
    });

    it('returns an empty-state card when stats are empty or absent', () => {
        const empty = env.api.render({ stats: [] });
        const missing = env.api.render({});
        const nullStats = env.api.render({ stats: null });
        for (const node of [empty, missing, nullStats]) {
            expect(node).not.toBeNull();
            expect(node.tagName.toLowerCase()).toBe('div');
            expect(node.classList.contains('wg-steps-chart')).toBe(true);
            expect(node.classList.contains('wg-steps-chart--empty')).toBe(true);
            expect(node.textContent).toMatch(/no step data yet/i);
        }
    });

    it('returns the empty-state card when every entry is invalid', () => {
        const el = env.api.render({
            stats: [
                { day: 'bad', steps: 5000 },
                { day: '2026-04-01', steps: 'x' },
            ],
        });
        expect(el.classList.contains('wg-steps-chart--empty')).toBe(true);
    });

    it('produces a sane guide-tick count (inner-only, skips outermost)', () => {
        const svg = env.api.render({ stats: makeStats({ days: 7 }) });
        const tickCount = Number(svg.dataset.stepsTickCount);
        const guides = svg.querySelectorAll('line.wg-steps-chart__guide');
        expect(tickCount).toBeGreaterThanOrEqual(0);
        expect(tickCount).toBeLessThanOrEqual(5);
        expect(guides.length).toBe(tickCount);
    });

    it('renders an axis label per tick (including outer endpoints)', () => {
        const svg = env.api.render({ stats: makeStats({ days: 5 }) });
        const axisLabels = svg.querySelectorAll('text.wg-steps-chart__axis-label');
        // Y-axis has 5 labels (0..4 inclusive)
        expect(axisLabels.length).toBe(5);
    });

    it('formats thousands on the y-axis as "Nk"', () => {
        const svg = env.api.render({ stats: makeStats({ days: 5, stepsEach: 10000 }) });
        const axisTexts = Array.from(svg.querySelectorAll('text.wg-steps-chart__axis-label'))
            .map((el) => el.textContent);
        // At least one label should be a "Nk" form since max > 1000.
        expect(axisTexts.some((t) => /k$/.test(t))).toBe(true);
    });

    it('renders "Today" as the last x-axis day label', () => {
        const svg = env.api.render({ stats: makeStats({ days: 4 }) });
        const labels = Array.from(svg.querySelectorAll('text.wg-steps-chart__day-label'));
        expect(labels.length).toBe(4);
        expect(labels[labels.length - 1].textContent).toBe('Today');
    });

    it('forwards width/height options into the viewBox', () => {
        const svg = env.api.render({ stats: makeStats({ days: 3 }), width: 420, height: 260 });
        expect(svg.getAttribute('viewBox')).toBe('0 0 420 260');
    });

    it('filters out entries with bad dates or non-numeric steps', () => {
        const stats = [
            { day: '2026-04-01', steps: 5000 },
            { day: 'not-a-date', steps: 6000 },
            { day: '2026-04-03', steps: 'x' },
            { day: '2026-04-04', steps: 7000 },
        ];
        const svg = env.api.render({ stats });
        expect(svg.tagName.toLowerCase()).toBe('svg');
        expect(Number(svg.dataset.stepsPointCount)).toBe(2);
    });

    it("accepts 'date' as well as 'day' date keys (per backend contract)", () => {
        const svg = env.api.render({
            stats: [
                { date: '2026-04-01', steps: 5000 },
                { date: '2026-04-02', steps: 6000 },
            ],
        });
        expect(svg.tagName.toLowerCase()).toBe('svg');
        expect(Number(svg.dataset.stepsPointCount)).toBe(2);
    });
});
