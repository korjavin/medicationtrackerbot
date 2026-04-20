// Tests for the WGBpChart component (Phase 3, Task 2).
// The component renders a systolic/diastolic SVG with a band fill between
// the two lines, two dotted guide lines at BP 80 and 120, and sun-coloured
// last-point markers per series. All colours resolve via CSS classes on
// the SVG children — never through inline stroke=/fill= attributes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CHART_UTILS_JS = path.join(REPO_ROOT, 'web/static/js/core/chart-utils.js');
const WG_BP_CHART_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-bp-chart.js');

function loadEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only',
    });
    dom.window.eval(fs.readFileSync(CHART_UTILS_JS, 'utf8'));
    dom.window.eval(fs.readFileSync(WG_BP_CHART_JS, 'utf8'));
    return {
        window: dom.window,
        api: dom.window.WGBpChart,
        cleanup: () => dom.window.close(),
    };
}

function sampleReadings(days = 14) {
    const readings = [];
    // Start from a fixed anchor so tests are deterministic regardless of wall clock.
    const anchor = Date.UTC(2026, 3, 20, 12, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
        const ts = new Date(anchor - i * 86400000).toISOString();
        readings.push({
            measured_at: ts,
            systolic: 118 + (i % 5),
            diastolic: 76 + (i % 4),
            pulse: 64 + (i % 6),
        });
    }
    return readings;
}

describe('WGBpChart.render', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('exposes a render function on the global WGBpChart', () => {
        expect(env.api).toBeTruthy();
        expect(typeof env.api.render).toBe('function');
    });

    it('returns an SVG element in the SVG namespace with the wg-bp-chart class', () => {
        const svg = env.api.render({ readings: sampleReadings() });
        expect(svg).not.toBeNull();
        expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
        expect(svg.tagName.toLowerCase()).toBe('svg');
        expect(svg.classList.contains('wg-bp-chart')).toBe(true);
        expect(svg.getAttribute('viewBox')).toBe('0 0 358 200');
        expect(svg.getAttribute('aria-hidden')).toBe('true');
    });

    it('renders exactly one systolic path and one diastolic path', () => {
        const svg = env.api.render({ readings: sampleReadings() });
        const sys = svg.querySelectorAll('path.wg-bp-chart__sys');
        const dia = svg.querySelectorAll('path.wg-bp-chart__dia');
        expect(sys.length).toBe(1);
        expect(dia.length).toBe(1);
        expect(sys[0].getAttribute('d').length).toBeGreaterThan(0);
        expect(dia[0].getAttribute('d').length).toBeGreaterThan(0);
    });

    it('includes a band path that opens with M and closes with Z', () => {
        const svg = env.api.render({ readings: sampleReadings() });
        const band = svg.querySelector('path.wg-bp-chart__band');
        expect(band).not.toBeNull();
        const d = band.getAttribute('d');
        expect(d).toMatch(/^M/);
        expect(d).toMatch(/Z\s*$/);
    });

    it('emits two dotted guide lines at BP 80 and 120, with 80 rendered below 120', () => {
        const svg = env.api.render({ readings: sampleReadings() });
        const guides = svg.querySelectorAll('line.wg-bp-chart__guide');
        expect(guides.length).toBe(2);
        const byValue = {};
        guides.forEach((g) => { byValue[g.dataset.bpGuide] = parseFloat(g.getAttribute('y1')); });
        expect(byValue['80']).toBeDefined();
        expect(byValue['120']).toBeDefined();
        // Higher BP (120) sits higher on the chart, i.e. smaller y.
        expect(byValue['80']).toBeGreaterThan(byValue['120']);
    });

    it('renders one sun-colored last-point circle per series (sys + dia)', () => {
        const svg = env.api.render({ readings: sampleReadings() });
        const lasts = svg.querySelectorAll('circle.wg-bp-chart__last');
        expect(lasts.length).toBe(2);
        const series = new Set();
        lasts.forEach((c) => series.add(c.dataset.bpSeries));
        expect(series.has('sys')).toBe(true);
        expect(series.has('dia')).toBe(true);
    });

    it('sets no inline stroke/fill/style on sys, dia, or band paths', () => {
        const svg = env.api.render({ readings: sampleReadings() });
        const paths = [
            svg.querySelector('path.wg-bp-chart__sys'),
            svg.querySelector('path.wg-bp-chart__dia'),
            svg.querySelector('path.wg-bp-chart__band'),
        ];
        for (const el of paths) {
            expect(el).not.toBeNull();
            expect(el.getAttribute('stroke')).toBeNull();
            expect(el.getAttribute('fill')).toBeNull();
            expect(el.getAttribute('style')).toBeNull();
        }
    });

    it('sets no inline stroke/fill on last-point circles', () => {
        const svg = env.api.render({ readings: sampleReadings() });
        const lasts = svg.querySelectorAll('circle.wg-bp-chart__last');
        lasts.forEach((c) => {
            expect(c.getAttribute('stroke')).toBeNull();
            expect(c.getAttribute('fill')).toBeNull();
        });
    });

    it('returns null for empty, missing, or invalid input', () => {
        expect(env.api.render({ readings: [] })).toBeNull();
        expect(env.api.render({})).toBeNull();
        expect(env.api.render({ readings: null })).toBeNull();
        // Entries that fail numeric validation are filtered out; a list of
        // only-invalid entries should yield null.
        expect(env.api.render({ readings: [{ measured_at: 'not-a-date', systolic: 120, diastolic: 80 }] })).toBeNull();
        expect(env.api.render({ readings: [{ measured_at: new Date().toISOString(), systolic: 'x', diastolic: 80 }] })).toBeNull();
    });

    it('honours custom width/height in the viewBox', () => {
        const svg = env.api.render({ readings: sampleReadings(), width: 420, height: 240 });
        expect(svg.getAttribute('viewBox')).toBe('0 0 420 240');
    });

    it('accepts pre-normalised readings ({ date, sys, dia }) as well as API shape', () => {
        const readings = [
            { date: new Date('2026-04-01T12:00:00Z'), sys: 120, dia: 80 },
            { date: new Date('2026-04-02T12:00:00Z'), sys: 125, dia: 82 },
            { date: new Date('2026-04-03T12:00:00Z'), sys: 118, dia: 78 },
        ];
        const svg = env.api.render({ readings });
        expect(svg).not.toBeNull();
        expect(svg.querySelector('path.wg-bp-chart__sys')).not.toBeNull();
        expect(svg.querySelector('path.wg-bp-chart__dia')).not.toBeNull();
    });

    it('forwards the range option into a dataset attribute when provided', () => {
        const svg = env.api.render({ readings: sampleReadings(), range: 14 });
        expect(svg.dataset.bpRange).toBe('14');
    });

    it('keeps extreme hypertensive readings inside the plot area', () => {
        // A Grade 2 HTN reading (180/110) must not be truncated above the top
        // padding; the last-point marker's cy must fall within [PAD_T, height - PAD_B].
        const readings = [
            { measured_at: '2026-04-01T12:00:00Z', systolic: 118, diastolic: 76 },
            { measured_at: '2026-04-10T12:00:00Z', systolic: 180, diastolic: 110 },
        ];
        const svg = env.api.render({ readings });
        expect(svg).not.toBeNull();
        const lasts = svg.querySelectorAll('circle.wg-bp-chart__last');
        expect(lasts.length).toBe(2);
        lasts.forEach((c) => {
            const cy = parseFloat(c.getAttribute('cy'));
            // PAD_T=14, height=200, PAD_B=26 → valid y in [14, 174].
            expect(cy).toBeGreaterThanOrEqual(14);
            expect(cy).toBeLessThanOrEqual(174);
        });
    });
});
