// Tests for the WGVitalsChart component (Phase 8, Task 6).
// Area + line renderer for the Health Overview HR / SpO2 / Stress cards.
// Parameterised by `vital` — the modifier class on the root SVG is the only
// thing that changes between variants; colour resolves via CSS tokens
// (never inline stroke/fill).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CHART_UTILS_JS = path.join(REPO_ROOT, 'web/static/js/core/chart-utils.js');
const WG_VITALS_CHART_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-vitals-chart.js');

function loadEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only',
    });
    dom.window.eval(fs.readFileSync(CHART_UTILS_JS, 'utf8'));
    dom.window.eval(fs.readFileSync(WG_VITALS_CHART_JS, 'utf8'));
    return {
        window: dom.window,
        api: dom.window.WGVitalsChart,
        cleanup: () => dom.window.close(),
    };
}

function makeHistory({ points = 5, step = 2 * 60 * 60 * 1000, avg = 70 } = {}) {
    const anchor = Date.now() - 5000;
    const out = [];
    for (let i = points - 1; i >= 0; i--) {
        out.push({
            timestamp: anchor - i * step,
            min: avg - 10,
            max: avg + 10,
            avg: avg + (points - i),
        });
    }
    return out;
}

describe('WGVitalsChart.render', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('exposes a render function on window.WGVitalsChart', () => {
        expect(env.api).toBeTruthy();
        expect(typeof env.api.render).toBe('function');
        expect(env.api.DEFAULT_WIDTH).toBe(358);
        expect(env.api.DEFAULT_HEIGHT).toBe(200);
    });

    it('returns an SVG element with wg-vitals-chart + vital modifier classes', () => {
        const svg = env.api.render({ history: makeHistory({ points: 5 }), vital: 'hr' });
        expect(svg).not.toBeNull();
        expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
        expect(svg.tagName.toLowerCase()).toBe('svg');
        expect(svg.classList.contains('wg-vitals-chart')).toBe(true);
        expect(svg.classList.contains('wg-vitals-chart--hr')).toBe(true);
        expect(svg.getAttribute('viewBox')).toBe('0 0 358 200');
        expect(svg.getAttribute('aria-hidden')).toBe('true');
    });

    it('renders one area path, one (or more) line paths, and one last-value dot', () => {
        const svg = env.api.render({ history: makeHistory({ points: 5 }), vital: 'hr' });
        expect(svg.querySelectorAll('path.wg-vitals-chart__area').length).toBe(1);
        expect(svg.querySelectorAll('path.wg-vitals-chart__line').length).toBeGreaterThanOrEqual(1);
        expect(svg.querySelectorAll('circle.wg-vitals-chart__last').length).toBe(1);
    });

    it('selects the correct modifier class per vital (hr / spo2 / stress)', () => {
        const hr = env.api.render({ history: makeHistory({ points: 3, avg: 72 }), vital: 'hr' });
        const spo2 = env.api.render({ history: makeHistory({ points: 3, avg: 97 }), vital: 'spo2' });
        const stress = env.api.render({ history: makeHistory({ points: 3, avg: 40 }), vital: 'stress' });
        expect(hr.classList.contains('wg-vitals-chart--hr')).toBe(true);
        expect(hr.classList.contains('wg-vitals-chart--spo2')).toBe(false);
        expect(spo2.classList.contains('wg-vitals-chart--spo2')).toBe(true);
        expect(stress.classList.contains('wg-vitals-chart--stress')).toBe(true);
    });

    it('falls back to the hr vital when the arg is missing or invalid', () => {
        const missing = env.api.render({ history: makeHistory({ points: 3 }) });
        const bogus = env.api.render({ history: makeHistory({ points: 3 }), vital: 'bogus' });
        expect(missing.classList.contains('wg-vitals-chart--hr')).toBe(true);
        expect(bogus.classList.contains('wg-vitals-chart--hr')).toBe(true);
    });

    it('applies vital-specific y-range defaults', () => {
        const hr = env.api.render({ history: makeHistory({ points: 3, avg: 72 }), vital: 'hr' });
        const spo2 = env.api.render({ history: makeHistory({ points: 3, avg: 97 }), vital: 'spo2' });
        const stress = env.api.render({ history: makeHistory({ points: 3, avg: 40 }), vital: 'stress' });
        expect(hr.dataset.vitalsYMin).toBe('40');
        expect(hr.dataset.vitalsYMax).toBe('160');
        expect(spo2.dataset.vitalsYMin).toBe('85');
        expect(spo2.dataset.vitalsYMax).toBe('100');
        expect(stress.dataset.vitalsYMin).toBe('0');
        expect(stress.dataset.vitalsYMax).toBe('100');
    });

    it('honours yMin / yMax overrides when passed', () => {
        const svg = env.api.render({
            history: makeHistory({ points: 3, avg: 72 }),
            vital: 'hr',
            yMin: 50,
            yMax: 120,
        });
        expect(svg.dataset.vitalsYMin).toBe('50');
        expect(svg.dataset.vitalsYMax).toBe('120');
    });

    it('sets no inline stroke/fill/style on chart children', () => {
        const svg = env.api.render({ history: makeHistory({ points: 5 }), vital: 'spo2' });
        const all = svg.querySelectorAll(
            'path.wg-vitals-chart__area, path.wg-vitals-chart__line, ' +
            'circle.wg-vitals-chart__last, line.wg-vitals-chart__guide, ' +
            'text.wg-vitals-chart__axis-label, text.wg-vitals-chart__day-label'
        );
        expect(all.length).toBeGreaterThan(0);
        for (const el of all) {
            expect(el.getAttribute('stroke')).toBeNull();
            expect(el.getAttribute('fill')).toBeNull();
            expect(el.getAttribute('style')).toBeNull();
        }
    });

    it('applies the 7d range filter — only entries in the last 7 days contribute', () => {
        const anchor = Date.now() - 5000;
        const dayMs = 86400000;
        const history = [];
        for (let i = 13; i >= 0; i--) {
            history.push({
                timestamp: anchor - i * dayMs,
                min: 55, max: 85, avg: 70,
            });
        }
        const svg = env.api.render({ history, vital: 'hr', range: '7d' });
        expect(svg.dataset.vitalsRange).toBe('7d');
        const pointCount = Number(svg.dataset.vitalsPointCount);
        expect(pointCount).toBeGreaterThan(0);
        expect(pointCount).toBeLessThanOrEqual(8);
    });

    it('applies the 30d range filter', () => {
        const anchor = Date.now() - 5000;
        const dayMs = 86400000;
        const history = [];
        for (let i = 59; i >= 0; i--) {
            history.push({
                timestamp: anchor - i * dayMs,
                min: 55, max: 85, avg: 70,
            });
        }
        const svg = env.api.render({ history, vital: 'hr', range: '30d' });
        expect(svg.dataset.vitalsRange).toBe('30d');
        const pointCount = Number(svg.dataset.vitalsPointCount);
        expect(pointCount).toBeGreaterThan(0);
        expect(pointCount).toBeLessThanOrEqual(31);
    });

    it("treats range 'all' (and undefined) as no filter", () => {
        const history = makeHistory({ points: 8 });
        const full = env.api.render({ history, vital: 'hr', range: 'all' });
        const unspec = env.api.render({ history, vital: 'hr' });
        expect(full.dataset.vitalsRange).toBe('all');
        expect(unspec.dataset.vitalsRange).toBe('all');
        expect(Number(full.dataset.vitalsPointCount)).toBe(8);
        expect(Number(unspec.dataset.vitalsPointCount)).toBe(8);
    });

    it('returns an empty-state card when history is empty or absent', () => {
        const empty = env.api.render({ history: [], vital: 'hr' });
        const missing = env.api.render({ vital: 'spo2' });
        const nullStats = env.api.render({ history: null, vital: 'stress' });
        expect(empty.tagName.toLowerCase()).toBe('div');
        expect(empty.classList.contains('wg-vitals-chart')).toBe(true);
        expect(empty.classList.contains('wg-vitals-chart--empty')).toBe(true);
        expect(empty.classList.contains('wg-vitals-chart--hr')).toBe(true);
        expect(empty.textContent).toMatch(/no heart rate data yet/i);
        expect(missing.classList.contains('wg-vitals-chart--spo2')).toBe(true);
        expect(missing.textContent).toMatch(/no spo2 data yet/i);
        expect(nullStats.classList.contains('wg-vitals-chart--stress')).toBe(true);
        expect(nullStats.textContent).toMatch(/no stress data yet/i);
    });

    it('returns the empty-state card when every entry is invalid', () => {
        const el = env.api.render({
            history: [
                { timestamp: 'bad', avg: 70 },
                { timestamp: Date.now(), avg: 'x' },
            ],
            vital: 'hr',
        });
        expect(el.classList.contains('wg-vitals-chart--empty')).toBe(true);
    });

    it('produces a sane guide-tick count (inner-only, skips outermost)', () => {
        const svg = env.api.render({ history: makeHistory({ points: 5 }), vital: 'hr' });
        const tickCount = Number(svg.dataset.vitalsTickCount);
        const guides = svg.querySelectorAll('line.wg-vitals-chart__guide');
        expect(tickCount).toBeGreaterThanOrEqual(0);
        expect(tickCount).toBeLessThanOrEqual(5);
        expect(guides.length).toBe(tickCount);
    });

    it('renders an axis label per tick (including outer endpoints)', () => {
        const svg = env.api.render({ history: makeHistory({ points: 5 }), vital: 'hr' });
        const axisLabels = svg.querySelectorAll('text.wg-vitals-chart__axis-label');
        expect(axisLabels.length).toBe(5);
    });

    it('renders 5 x-axis date labels across the range', () => {
        const svg = env.api.render({ history: makeHistory({ points: 5 }), vital: 'hr' });
        const dayLabels = svg.querySelectorAll('text.wg-vitals-chart__day-label');
        expect(dayLabels.length).toBe(5);
        for (const label of dayLabels) {
            expect(label.textContent).toMatch(/^\d+\/\d+$/);
        }
    });

    it('splits the line into separate paths when gaps exceed 3 hours', () => {
        const base = Date.now() - 10000;
        const history = [
            { timestamp: base,                     min: 58, max: 84, avg: 70 },
            { timestamp: base + 30 * 60 * 1000,    min: 59, max: 85, avg: 72 },
            // 6-hour gap here
            { timestamp: base + 7 * 3600 * 1000,   min: 60, max: 86, avg: 74 },
            { timestamp: base + 7.5 * 3600 * 1000, min: 61, max: 85, avg: 73 },
        ];
        const svg = env.api.render({ history, vital: 'hr' });
        const linePaths = svg.querySelectorAll('path.wg-vitals-chart__line');
        expect(linePaths.length).toBe(2);
    });

    it('forwards width/height options into the viewBox', () => {
        const svg = env.api.render({
            history: makeHistory({ points: 3 }),
            vital: 'hr',
            width: 420,
            height: 260,
        });
        expect(svg.getAttribute('viewBox')).toBe('0 0 420 260');
    });

    it('filters out entries with bad timestamps or non-numeric avg', () => {
        const base = Date.now() - 10000;
        const history = [
            { timestamp: base,                   min: 58, max: 84, avg: 70 },
            { timestamp: 'not-a-date',           min: 59, max: 85, avg: 72 },
            { timestamp: base + 60 * 1000,       min: 60, max: 86, avg: 'x' },
            { timestamp: base + 120 * 1000,      min: 60, max: 86, avg: 74 },
        ];
        const svg = env.api.render({ history, vital: 'hr' });
        expect(svg.tagName.toLowerCase()).toBe('svg');
        expect(Number(svg.dataset.vitalsPointCount)).toBe(2);
    });

    it('omits the area path when only one data point is present', () => {
        const svg = env.api.render({
            history: [{ timestamp: Date.now(), min: 58, max: 84, avg: 70 }],
            vital: 'hr',
        });
        expect(svg.tagName.toLowerCase()).toBe('svg');
        expect(svg.querySelectorAll('path.wg-vitals-chart__area').length).toBe(0);
        expect(svg.querySelectorAll('circle.wg-vitals-chart__last').length).toBe(1);
    });

    it('accepts ISO-string timestamps as well as numeric ms', () => {
        const now = new Date();
        const earlier = new Date(now.getTime() - 3600 * 1000);
        const svg = env.api.render({
            history: [
                { timestamp: earlier.toISOString(), min: 58, max: 84, avg: 70 },
                { timestamp: now.toISOString(),     min: 60, max: 86, avg: 74 },
            ],
            vital: 'hr',
        });
        expect(svg.tagName.toLowerCase()).toBe('svg');
        expect(Number(svg.dataset.vitalsPointCount)).toBe(2);
    });
});
