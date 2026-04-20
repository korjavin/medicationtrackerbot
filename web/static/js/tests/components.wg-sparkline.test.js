// Tests for the WGSparkline component (Task 7).
// The sparkline's stroke colour comes from a CSS class on the SVG element,
// not from an inline colour string — the tests assert the class wiring and
// the deterministic path geometry.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const WG_SPARKLINE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-sparkline.js');

function loadEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only'
    });
    dom.window.eval(fs.readFileSync(WG_SPARKLINE_JS, 'utf8'));
    return {
        window: dom.window,
        api: dom.window.WGSparkline,
        cleanup: () => dom.window.close()
    };
}

describe('WGSparkline.render', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('renders a namespaced <svg> with width/height/viewBox', () => {
        const svg = env.api.render({ points: [10, 20, 15, 30], variant: 'sun', width: 100, height: 20 });
        expect(svg).not.toBeNull();
        expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
        expect(svg.getAttribute('width')).toBe('100');
        expect(svg.getAttribute('height')).toBe('20');
        expect(svg.getAttribute('viewBox')).toBe('0 0 100 20');
        expect(svg.getAttribute('aria-hidden')).toBe('true');
    });

    it('attaches the base class and variant class to the <svg>', () => {
        const svg = env.api.render({ points: [1, 2, 3], variant: 'mint' });
        expect(svg.classList.contains('wg-sparkline')).toBe(true);
        expect(svg.classList.contains('wg-sparkline--mint')).toBe(true);
    });

    it('emits a line path with deterministic `d` attribute for a 4-point series', () => {
        const svg = env.api.render({ points: [0, 50, 25, 100], width: 90, height: 30 });
        const line = svg.querySelector('path.wg-spark');
        expect(line).not.toBeNull();
        const d = line.getAttribute('d');
        // 4 points → 3 intervals of 30px each, y scales so min→28 max→2
        // Point 0: x=0.0, v=0 → y=28.0
        // Point 1: x=30.0, v=50 → y=15.0 (middle)
        // Point 2: x=60.0, v=25 → y=21.5
        // Point 3: x=90.0, v=100 → y=2.0
        expect(d).toBe('M0.0 28.0 L30.0 15.0 L60.0 21.5 L90.0 2.0');
    });

    it('includes a fill path for multi-point data and tags it with the variant', () => {
        const svg = env.api.render({ points: [10, 20, 15], variant: 'coral', width: 60, height: 20 });
        const fill = svg.querySelector('path.wg-spark-fill');
        expect(fill).not.toBeNull();
        const d = fill.getAttribute('d');
        expect(d.startsWith('M')).toBe(true);
        expect(d.endsWith('Z')).toBe(true);
        expect(fill.classList.contains('wg-spark-fill--coral')).toBe(true);
    });

    it('renders a tail circle at the last data point carrying the variant class', () => {
        const svg = env.api.render({ points: [5, 10, 15], variant: 'mint-soft', width: 60, height: 20 });
        const tail = svg.querySelector('circle.wg-spark-tail');
        expect(tail).not.toBeNull();
        expect(tail.classList.contains('wg-spark-tail--mint-soft')).toBe(true);
        // Tail sits at the last x and its y matches the line's last point.
        expect(parseFloat(tail.getAttribute('cx'))).toBeCloseTo(60, 1);
    });

    it('returns null for empty or invalid point arrays', () => {
        expect(env.api.render({ points: [] })).toBeNull();
        expect(env.api.render({ points: [NaN, NaN] })).toBeNull();
        expect(env.api.render({})).toBeNull();
    });

    it('omits the fill path for single-point data (no closed region to fill)', () => {
        const svg = env.api.render({ points: [42], variant: 'sun', width: 50, height: 20 });
        expect(svg).not.toBeNull();
        expect(svg.querySelector('path.wg-spark-fill')).toBeNull();
        expect(svg.querySelector('path.wg-spark')).not.toBeNull();
        expect(svg.querySelector('circle.wg-spark-tail')).not.toBeNull();
    });

    it('does not set inline colour on the <path> — stroke comes from CSS class', () => {
        const svg = env.api.render({ points: [1, 2, 3], variant: 'sun' });
        const line = svg.querySelector('path.wg-spark');
        expect(line.getAttribute('stroke')).toBeNull();
        expect(line.getAttribute('style')).toBeNull();
    });

    it('applies default width/height when unspecified', () => {
        const svg = env.api.render({ points: [1, 2, 3] });
        expect(svg.getAttribute('width')).toBe(String(env.api.DEFAULT_WIDTH));
        expect(svg.getAttribute('height')).toBe(String(env.api.DEFAULT_HEIGHT));
    });
});
