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
