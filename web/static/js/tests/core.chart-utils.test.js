import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CSS_PATH = path.join(REPO_ROOT, 'web/static/css/styles.css');

function loadChartUtils() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'https://example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    const src = fs.readFileSync(
        path.join(REPO_ROOT, 'web/static/js/core/chart-utils.js'),
        'utf8'
    );
    window.eval(`${src}\n//# sourceURL=file://chart-utils.js`);
    return { window, document: window.document, cleanup: () => dom.window.close() };
}

describe('ChartUtils', () => {
    let env;

    beforeAll(() => { env = loadChartUtils(); });
    afterAll(() => { env.cleanup(); });

    it('is exposed on window', () => {
        expect(typeof env.window.ChartUtils).toBe('object');
    });

    // --- catmullRomSpline ---

    describe('catmullRomSpline', () => {
        it('returns empty string for empty array', () => {
            expect(env.window.ChartUtils.catmullRomSpline([])).toBe('');
        });

        it('returns empty string for null/undefined', () => {
            expect(env.window.ChartUtils.catmullRomSpline(null)).toBe('');
            expect(env.window.ChartUtils.catmullRomSpline(undefined)).toBe('');
        });

        it('returns M command for single point', () => {
            const result = env.window.ChartUtils.catmullRomSpline([[10, 20]]);
            expect(result).toBe('M 10,20');
        });

        it('returns M+L for two points', () => {
            const result = env.window.ChartUtils.catmullRomSpline([[10, 20], [30, 40]]);
            expect(result).toBe('M 10,20 L 30,40');
        });

        it('returns valid SVG path for 3+ points', () => {
            const result = env.window.ChartUtils.catmullRomSpline(
                [[0, 0], [50, 100], [100, 50], [150, 75]],
                5
            );
            expect(result).toMatch(/^M 0,0/);
            expect(result).toContain('L ');
            // Should have multiple L segments (more than the original 3 line segments)
            const lCount = (result.match(/ L /g) || []).length;
            expect(lCount).toBeGreaterThan(3);
        });

        it('produces smooth path (intermediate points between control points)', () => {
            const points = [[0, 100], [50, 0], [100, 100]];
            const result = env.window.ChartUtils.catmullRomSpline(points, 10);
            // With segments=10, we get 10+1 points per segment pair, and 2 pairs
            const lCount = (result.match(/ L /g) || []).length;
            expect(lCount).toBeGreaterThanOrEqual(20);
        });
    });

    // --- calculateYAxisTicks ---

    describe('calculateYAxisTicks', () => {
        it('returns array of numbers', () => {
            const ticks = env.window.ChartUtils.calculateYAxisTicks(60, 90);
            expect(Array.isArray(ticks)).toBe(true);
            expect(ticks.length).toBeGreaterThan(0);
            ticks.forEach(t => expect(typeof t).toBe('number'));
        });

        it('all ticks are within or at bounds', () => {
            const ticks = env.window.ChartUtils.calculateYAxisTicks(62, 88);
            ticks.forEach(t => {
                expect(t).toBeGreaterThanOrEqual(62);
                expect(t).toBeLessThanOrEqual(88);
            });
        });

        it('uses 5-unit intervals for moderate ranges', () => {
            const ticks = env.window.ChartUtils.calculateYAxisTicks(60, 90);
            // Range=30, 30/5=6 ticks which is in 4-8 range
            for (let i = 1; i < ticks.length; i++) {
                expect(ticks[i] - ticks[i - 1]).toBe(5);
            }
        });

        it('handles small range', () => {
            const ticks = env.window.ChartUtils.calculateYAxisTicks(70, 75);
            expect(ticks.length).toBeGreaterThan(0);
        });

        it('handles large range', () => {
            const ticks = env.window.ChartUtils.calculateYAxisTicks(50, 120);
            expect(ticks.length).toBeGreaterThan(0);
            expect(ticks.length).toBeLessThan(20);
        });

        it('returns non-empty ticks for narrow ranges (1-5)', () => {
            // Regression: range=3 with fractional bounds previously returned empty
            const ticks = env.window.ChartUtils.calculateYAxisTicks(80.1, 83.1);
            expect(ticks.length).toBeGreaterThanOrEqual(2);
        });

        it('uses unit intervals for very narrow ranges', () => {
            const ticks = env.window.ChartUtils.calculateYAxisTicks(70.5, 73.5);
            expect(ticks.length).toBeGreaterThanOrEqual(3);
            // Should have integer ticks like [70, 71, 72, 73]
            ticks.forEach(t => expect(Number.isInteger(t)).toBe(true));
        });
    });

    // --- createGradient ---

    describe('createGradient', () => {
        const SVG_NS = 'http://www.w3.org/2000/svg';

        it('creates a linearGradient element with correct stops', () => {
            const doc = env.document;
            const svg = doc.createElementNS(SVG_NS, 'svg');
            doc.body.appendChild(svg);

            const grad = env.window.ChartUtils.createGradient(SVG_NS, svg, 'test-grad', '#ff0000', 0.3);

            expect(grad.tagName).toBe('linearGradient');
            expect(grad.getAttribute('id')).toBe('test-grad');
            expect(grad.getAttribute('x2')).toBe('0');
            expect(grad.getAttribute('y2')).toBe('1');

            const stops = grad.querySelectorAll('stop');
            expect(stops.length).toBe(2);
            expect(stops[0].getAttribute('stop-color')).toBe('#ff0000');
            expect(stops[0].getAttribute('stop-opacity')).toBe('0.3');
            expect(stops[1].getAttribute('stop-color')).toBe('#ff0000');
            expect(stops[1].getAttribute('stop-opacity')).toBe('0');

            doc.body.removeChild(svg);
        });

        it('creates defs element if missing', () => {
            const doc = env.document;
            const svg = doc.createElementNS(SVG_NS, 'svg');
            doc.body.appendChild(svg);

            expect(svg.querySelector('defs')).toBeNull();
            env.window.ChartUtils.createGradient(SVG_NS, svg, 'grad2', '#00ff00', 0.5);
            expect(svg.querySelector('defs')).not.toBeNull();

            doc.body.removeChild(svg);
        });

        it('reuses existing defs element', () => {
            const doc = env.document;
            const svg = doc.createElementNS(SVG_NS, 'svg');
            const defs = doc.createElementNS(SVG_NS, 'defs');
            svg.appendChild(defs);
            doc.body.appendChild(svg);

            env.window.ChartUtils.createGradient(SVG_NS, svg, 'grad3', '#0000ff', 0.2);
            expect(svg.querySelectorAll('defs').length).toBe(1);

            doc.body.removeChild(svg);
        });
    });

    // --- animateLine ---

    describe('animateLine', () => {
        it('does not throw for null input', () => {
            expect(() => env.window.ChartUtils.animateLine(null)).not.toThrow();
        });

        it('does not throw for element without getTotalLength', () => {
            const el = env.document.createElement('div');
            expect(() => env.window.ChartUtils.animateLine(el)).not.toThrow();
        });

        it('sets --line-length and adds class on valid path', () => {
            const mockPath = env.document.createElementNS('http://www.w3.org/2000/svg', 'path');
            // JSDOM doesn't implement getTotalLength, so mock it
            mockPath.getTotalLength = () => 42;

            env.window.ChartUtils.animateLine(mockPath);

            expect(mockPath.style.getPropertyValue('--line-length')).toBe('42');
            expect(mockPath.classList.contains('chart-line-animated')).toBe(true);
        });
    });

    // --- last-value emphasis CSS ---

    describe('last-value emphasis CSS', () => {
        it('.chart-point-latest class exists in styles.css', () => {
            const css = fs.readFileSync(CSS_PATH, 'utf8');
            expect(css).toMatch(/\.chart-point-latest\s*\{/);
        });

        it('.chart-point-pulse class exists in styles.css', () => {
            const css = fs.readFileSync(CSS_PATH, 'utf8');
            expect(css).toMatch(/\.chart-point-pulse\s*\{/);
        });

        it('@keyframes chart-pulse exists in styles.css', () => {
            const css = fs.readFileSync(CSS_PATH, 'utf8');
            expect(css).toMatch(/@keyframes\s+chart-pulse/);
        });

        it('prefers-reduced-motion disables chart-pulse animation', () => {
            const css = fs.readFileSync(CSS_PATH, 'utf8');
            expect(css).toContain('prefers-reduced-motion');
            expect(css).toContain('.chart-point-pulse');
        });
    });

    // --- draw animation CSS ---

    describe('draw animation CSS', () => {
        it('.chart-line-animated class exists in styles.css', () => {
            const css = fs.readFileSync(CSS_PATH, 'utf8');
            expect(css).toMatch(/\.chart-line-animated\s*\{/);
        });

        it('.chart-line-animated uses stroke-dasharray and stroke-dashoffset', () => {
            const css = fs.readFileSync(CSS_PATH, 'utf8');
            expect(css).toContain('stroke-dasharray: var(--line-length)');
            expect(css).toContain('stroke-dashoffset: var(--line-length)');
        });

        it('@keyframes chart-draw exists in styles.css', () => {
            const css = fs.readFileSync(CSS_PATH, 'utf8');
            expect(css).toMatch(/@keyframes\s+chart-draw/);
        });

        it('prefers-reduced-motion disables chart-line-animated animation', () => {
            const css = fs.readFileSync(CSS_PATH, 'utf8');
            expect(css).toContain('prefers-reduced-motion');
            expect(css).toContain('.chart-line-animated');
        });
    });

    // --- aggregateToDaily ---

    describe('aggregateToDaily', () => {
        function makeReading(dateStr, sys, dia, pulse = 70) {
            return {
                date: new Date(dateStr),
                sys,
                dia,
                pulse,
                category: 'normal',
            };
        }

        it('returns empty array for empty input', () => {
            expect(env.window.ChartUtils.aggregateToDaily([])).toEqual([]);
        });

        it('returns empty array for null/undefined', () => {
            expect(env.window.ChartUtils.aggregateToDaily(null)).toEqual([]);
            expect(env.window.ChartUtils.aggregateToDaily(undefined)).toEqual([]);
        });

        it('passes through all readings within recent window unchanged', () => {
            const now = new Date();
            const r1 = makeReading(new Date(now - 1000 * 60 * 60).toISOString(), 120, 80);
            const r2 = makeReading(new Date(now - 1000 * 60 * 60 * 2).toISOString(), 130, 85);
            const result = env.window.ChartUtils.aggregateToDaily([r1, r2], 7);
            expect(result.length).toBe(2);
            // Should not be marked as aggregated
            expect(result[0].aggregated).toBeUndefined();
            expect(result[1].aggregated).toBeUndefined();
        });

        it('collapses 3 readings on one old day into 1 aggregated point', () => {
            // 30 days ago - well outside the 7-day recent window
            const baseDate = new Date();
            baseDate.setDate(baseDate.getDate() - 30);
            baseDate.setHours(8, 0, 0, 0);

            const r1 = makeReading(new Date(baseDate).toISOString(), 120, 80, 70);
            const d2 = new Date(baseDate);
            d2.setHours(12, 0, 0, 0);
            const r2 = makeReading(d2.toISOString(), 140, 90, 80);
            const d3 = new Date(baseDate);
            d3.setHours(20, 0, 0, 0);
            const r3 = makeReading(d3.toISOString(), 130, 85, 75);

            const result = env.window.ChartUtils.aggregateToDaily([r1, r2, r3], 7);
            expect(result.length).toBe(1);
            expect(result[0].aggregated).toBe(true);

            // Time-weighted average:
            // r1 (08:00) weight = 4h (until 12:00) = 14400000ms
            // r2 (12:00) weight = 8h (until 20:00) = 28800000ms
            // r3 (20:00) weight = 4h (until end of day 00:00) = 14400000ms
            // Total weight = 57600000ms
            // weightedSys = 120*14400000 + 140*28800000 + 130*14400000 = 1728000000 + 4032000000 + 1872000000 = 7632000000
            // avgSys = 7632000000 / 57600000 = 132.5 → 133
            expect(result[0].sys).toBe(133);

            // weightedDia = 80*14400000 + 90*28800000 + 85*14400000 = 1152000000 + 2592000000 + 1224000000 = 4968000000
            // avgDia = 4968000000 / 57600000 = 86.25 → 86
            expect(result[0].dia).toBe(86);
        });

        it('handles single reading per old day (no aggregation needed)', () => {
            const baseDate = new Date();
            baseDate.setDate(baseDate.getDate() - 30);
            baseDate.setHours(10, 0, 0, 0);

            const r1 = makeReading(new Date(baseDate).toISOString(), 125, 82, 72);
            const result = env.window.ChartUtils.aggregateToDaily([r1], 7);
            expect(result.length).toBe(1);
            expect(result[0].sys).toBe(125);
            expect(result[0].dia).toBe(82);
            expect(result[0].aggregated).toBe(true);
        });

        it('correctly splits at boundary between recent and old', () => {
            const now = new Date();

            // Recent: 2 days ago
            const recent = makeReading(new Date(now - 2 * 86400000).toISOString(), 120, 80);

            // Old: 20 days ago, two readings on same day
            const oldBase = new Date(now - 20 * 86400000);
            oldBase.setHours(9, 0, 0, 0);
            const old1 = makeReading(new Date(oldBase).toISOString(), 140, 90);
            const oldBase2 = new Date(oldBase);
            oldBase2.setHours(18, 0, 0, 0);
            const old2 = makeReading(oldBase2.toISOString(), 130, 85);

            const result = env.window.ChartUtils.aggregateToDaily([recent, old1, old2], 7);
            // 1 aggregated old point + 1 recent individual = 2
            expect(result.length).toBe(2);

            // First should be the old aggregated one (sorted by date)
            expect(result[0].aggregated).toBe(true);
            // Second should be the recent one, not aggregated
            expect(result[1].aggregated).toBeUndefined();
            expect(result[1].sys).toBe(120);
        });

        it('assigns correct BP category to aggregated point', () => {
            const baseDate = new Date();
            baseDate.setDate(baseDate.getDate() - 30);
            baseDate.setHours(8, 0, 0, 0);

            // Both readings are high
            const r1 = makeReading(new Date(baseDate).toISOString(), 150, 95);
            const d2 = new Date(baseDate);
            d2.setHours(20, 0, 0, 0);
            const r2 = makeReading(d2.toISOString(), 160, 100);

            const result = env.window.ChartUtils.aggregateToDaily([r1, r2], 7);
            expect(result.length).toBe(1);
            // Time-weighted: 150*12h + 160*4h / 16h = 152.5 → 153 sys
            // 95*12h + 100*4h / 16h = 96.25 → 96 dia
            // 153/96 → high1 (sys >= 140 but < 160)
            expect(result[0].category).toBe('high1');
        });

        it('sorts output chronologically', () => {
            const now = new Date();
            const recent = makeReading(new Date(now - 86400000).toISOString(), 120, 80);

            const old1Date = new Date(now - 30 * 86400000);
            old1Date.setHours(10, 0, 0, 0);
            const old1 = makeReading(old1Date.toISOString(), 130, 85);

            const old2Date = new Date(now - 15 * 86400000);
            old2Date.setHours(10, 0, 0, 0);
            const old2 = makeReading(old2Date.toISOString(), 135, 87);

            // Pass in unsorted order
            const result = env.window.ChartUtils.aggregateToDaily([recent, old2, old1], 7);
            expect(result.length).toBe(3);
            // Should be sorted: old1 (30d ago), old2 (15d ago), recent (1d ago)
            expect(result[0].date.getTime()).toBeLessThan(result[1].date.getTime());
            expect(result[1].date.getTime()).toBeLessThan(result[2].date.getTime());
        });
    });

    // --- createLastValueDot ---

    describe('createLastValueDot', () => {
        const SVG_NS = 'http://www.w3.org/2000/svg';

        it('returns a group with two circles', () => {
            const doc = env.document;
            const svg = doc.createElementNS(SVG_NS, 'svg');
            doc.body.appendChild(svg);

            const g = env.window.ChartUtils.createLastValueDot(SVG_NS, 50, 75, '#3b82f6');

            expect(g.tagName).toBe('g');
            const circles = g.querySelectorAll('circle');
            expect(circles.length).toBe(2);

            // Pulse ring
            expect(circles[0].getAttribute('r')).toBe('10');
            expect(circles[0].classList.contains('chart-point-pulse')).toBe(true);

            // Main dot
            expect(circles[1].getAttribute('r')).toBe('6');
            expect(circles[1].classList.contains('chart-point-latest')).toBe(true);
            expect(circles[1].getAttribute('fill')).toBe('#3b82f6');

            doc.body.removeChild(svg);
        });
    });
});
