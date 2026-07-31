// Tests for the WGWorkoutChart component (Phase 7, Task 7).
// Single-series variant of WGWeightChart without a goal overlay. The chart
// renders a session-activity trend line over the active range, a last-point
// marker, and an empty-state card when no points fall within the range.
// Every colour resolves via CSS classes on SVG children — never through
// inline stroke=/fill= attributes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CHART_UTILS_JS = path.join(REPO_ROOT, 'web/static/js/core/chart-utils.js');
const WG_WORKOUT_CHART_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-workout-chart.js');

function loadEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only',
    });
    dom.window.eval(fs.readFileSync(CHART_UTILS_JS, 'utf8'));
    dom.window.eval(fs.readFileSync(WG_WORKOUT_CHART_JS, 'utf8'));
    return {
        window: dom.window,
        api: dom.window.WGWorkoutChart,
        cleanup: () => dom.window.close(),
    };
}

function makeSessions({ weeks = 12, startCount = 1, stepCount = 1 } = {}) {
    // Anchor a few seconds before Date.now() so the range filter (which
    // also anchors on the current time) sees these entries as recent.
    const anchor = Date.now() - 5000;
    const weekMs = 7 * 86400000;
    const sessions = [];
    for (let i = weeks - 1; i >= 0; i--) {
        const ts = new Date(anchor - i * weekMs).toISOString();
        sessions.push({
            week: ts,
            completed: Math.max(0, startCount + (weeks - 1 - i) * stepCount),
            skipped: 0,
        });
    }
    return sessions;
}

describe('WGWorkoutChart.render', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('exposes a render function on window.WGWorkoutChart', () => {
        expect(env.api).toBeTruthy();
        expect(typeof env.api.render).toBe('function');
        expect(env.api.DEFAULT_WIDTH).toBe(358);
        expect(env.api.DEFAULT_HEIGHT).toBe(200);
    });

    it('returns an SVG element in the SVG namespace with the wg-workout-chart class', () => {
        const svg = env.api.render({ sessions: makeSessions({ weeks: 6 }) });
        expect(svg).not.toBeNull();
        expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
        expect(svg.tagName.toLowerCase()).toBe('svg');
        expect(svg.classList.contains('wg-workout-chart')).toBe(true);
        expect(svg.getAttribute('viewBox')).toBe('0 0 358 200');
        expect(svg.getAttribute('aria-hidden')).toBe('true');
    });

    it('renders exactly one line path and one last-point circle', () => {
        const svg = env.api.render({ sessions: makeSessions({ weeks: 6 }) });
        const lines = svg.querySelectorAll('path.wg-workout-chart__line');
        const lasts = svg.querySelectorAll('circle.wg-workout-chart__last');
        expect(lines.length).toBe(1);
        expect(lasts.length).toBe(1);
        expect(lines[0].getAttribute('d').length).toBeGreaterThan(0);
    });

    it('sets no inline stroke/fill/style on line or last-point elements', () => {
        const svg = env.api.render({ sessions: makeSessions({ weeks: 6 }) });
        const elems = [
            svg.querySelector('path.wg-workout-chart__line'),
            svg.querySelector('circle.wg-workout-chart__last'),
        ];
        for (const el of elems) {
            expect(el).not.toBeNull();
            expect(el.getAttribute('stroke')).toBeNull();
            expect(el.getAttribute('fill')).toBeNull();
            expect(el.getAttribute('style')).toBeNull();
        }
    });

    it('applies the 7d range filter — only entries in the last 7 days contribute', () => {
        const svg = env.api.render({ sessions: makeSessions({ weeks: 12 }), range: '7d' });
        expect(svg).not.toBeNull();
        expect(svg.dataset.workoutRange).toBe('7d');
        // A weekly cadence means 7d keeps at most two weekly boundaries.
        const pointCount = Number(svg.dataset.workoutPointCount);
        expect(pointCount).toBeGreaterThan(0);
        expect(pointCount).toBeLessThanOrEqual(2);
    });

    it('drops future-dated entries from ranged views', () => {
        const dayMs = 86400000;
        const now = Date.now();
        const sessions = [
            { week: new Date(now + 5 * dayMs).toISOString(), completed: 9, skipped: 0 },
            { week: new Date(now - 1000).toISOString(), completed: 3, skipped: 0 },
            { week: new Date(now - 2 * dayMs).toISOString(), completed: 2, skipped: 0 }
        ];
        const svg = env.api.render({ sessions, range: '7d' });
        expect(svg).not.toBeNull();
        expect(svg.dataset.workoutRange).toBe('7d');
        expect(Number(svg.dataset.workoutPointCount)).toBe(2);
    });

    it('applies the 30d range filter', () => {
        const svg = env.api.render({ sessions: makeSessions({ weeks: 12 }), range: '30d' });
        expect(svg).not.toBeNull();
        expect(svg.dataset.workoutRange).toBe('30d');
        const pointCount = Number(svg.dataset.workoutPointCount);
        // 30 days ≈ 4-5 weekly entries; weekly buckets (7-day span) that
        // still overlap the 30-day window are also kept, so up to 6 entries
        // may make it through.
        expect(pointCount).toBeGreaterThan(0);
        expect(pointCount).toBeLessThanOrEqual(6);
    });

    it('treats range "all" (and undefined) as no filter', () => {
        const full = env.api.render({ sessions: makeSessions({ weeks: 12 }), range: 'all' });
        const unspec = env.api.render({ sessions: makeSessions({ weeks: 12 }) });
        expect(full).not.toBeNull();
        expect(unspec).not.toBeNull();
        expect(full.dataset.workoutRange).toBe('all');
        expect(unspec.dataset.workoutRange).toBe('all');
        expect(Number(full.dataset.workoutPointCount)).toBe(12);
        expect(Number(unspec.dataset.workoutPointCount)).toBe(12);
    });

    it('returns an empty-state HTML card (not null) when sessions are empty or absent', () => {
        const empty = env.api.render({ sessions: [] });
        const missing = env.api.render({});
        const nullSessions = env.api.render({ sessions: null });
        for (const node of [empty, missing, nullSessions]) {
            expect(node).not.toBeNull();
            expect(node.tagName.toLowerCase()).toBe('div');
            expect(node.classList.contains('wg-workout-chart')).toBe(true);
            expect(node.classList.contains('wg-workout-chart--empty')).toBe(true);
            expect(node.textContent).toMatch(/no workout sessions yet/i);
        }
    });

    it('returns the empty-state card when every entry is invalid', () => {
        const svg = env.api.render({
            sessions: [
                { week: 'bad', completed: 3 },
                { week: '2026-04-01', completed: 'x' },
            ],
        });
        expect(svg.classList.contains('wg-workout-chart--empty')).toBe(true);
    });

    it('produces a sane guide-tick count for short and long ranges', () => {
        const shortRange = env.api.render({ sessions: makeSessions({ weeks: 4, startCount: 1, stepCount: 1 }) });
        const longRange = env.api.render({ sessions: makeSessions({ weeks: 52, startCount: 1, stepCount: 0 }) });
        const shortTicks = Number(shortRange.dataset.workoutTickCount);
        const longTicks = Number(longRange.dataset.workoutTickCount);
        expect(shortTicks).toBeGreaterThanOrEqual(0);
        expect(shortTicks).toBeLessThanOrEqual(10);
        expect(longTicks).toBeGreaterThanOrEqual(0);
        expect(longTicks).toBeLessThanOrEqual(10);
    });

    it('accepts pre-normalised { date, value } entries', () => {
        const sessions = [
            { date: new Date('2026-04-01T12:00:00Z'), value: 2 },
            { date: new Date('2026-04-08T12:00:00Z'), value: 3 },
            { date: new Date('2026-04-15T12:00:00Z'), value: 4 },
        ];
        const svg = env.api.render({ sessions });
        expect(svg).not.toBeNull();
        expect(svg.querySelector('path.wg-workout-chart__line')).not.toBeNull();
        expect(svg.querySelector('circle.wg-workout-chart__last')).not.toBeNull();
    });

    it('forwards width/height options into the viewBox', () => {
        const svg = env.api.render({ sessions: makeSessions({ weeks: 6 }), width: 420, height: 240 });
        expect(svg.getAttribute('viewBox')).toBe('0 0 420 240');
    });

    it('filters out entries with non-numeric values or bad dates', () => {
        const sessions = [
            { week: '2026-04-01T12:00:00Z', completed: 2 },
            { week: 'not-a-date', completed: 3 },
            { week: '2026-04-15T12:00:00Z', completed: 'x' },
            { week: '2026-04-22T12:00:00Z', completed: 4 },
        ];
        const svg = env.api.render({ sessions });
        expect(svg.tagName.toLowerCase()).toBe('svg');
        expect(Number(svg.dataset.workoutPointCount)).toBe(2);
    });

    it('handles a single entry without division-by-zero', () => {
        const svg = env.api.render({
            sessions: [{ week: '2026-04-20T12:00:00Z', completed: 3 }],
        });
        expect(svg.tagName.toLowerCase()).toBe('svg');
        const last = svg.querySelector('circle.wg-workout-chart__last');
        expect(last).not.toBeNull();
        const cx = parseFloat(last.getAttribute('cx'));
        expect(cx).toBeGreaterThan(28);
        expect(cx).toBeLessThan(358 - 14);
    });

    it('reflects the chosen metric on the dataset (sessions vs volume)', () => {
        const sessionsPayload = [
            { week: '2026-04-01T12:00:00Z', completed: 2, volume: 1200 },
            { week: '2026-04-08T12:00:00Z', completed: 3, volume: 2400 },
            { week: '2026-04-15T12:00:00Z', completed: 4, volume: 3600 },
        ];
        const sessionsChart = env.api.render({ sessions: sessionsPayload, metric: 'sessions' });
        const volumeChart = env.api.render({ sessions: sessionsPayload, metric: 'volume' });
        expect(sessionsChart.dataset.workoutMetric).toBe('sessions');
        expect(volumeChart.dataset.workoutMetric).toBe('volume');
    });

    it('renders the est-1rm metric from raw.est_1rm with a continuous y-scale', () => {
        const payload = [
            { date: new Date('2026-04-01T12:00:00Z'), est_1rm: 116, top_weight: 100 },
            { date: new Date('2026-04-08T12:00:00Z'), est_1rm: 128, top_weight: 110 },
            { date: new Date('2026-04-15T12:00:00Z'), est_1rm: 140, top_weight: 120 },
        ];
        const svg = env.api.render({ sessions: payload, metric: 'est-1rm' });
        expect(svg.tagName.toLowerCase()).toBe('svg');
        expect(svg.dataset.workoutMetric).toBe('est-1rm');
        // Continuous (non-sessions) y-scale: floor rounds down to a 10, not 0.
        expect(Number(svg.dataset.workoutYMin)).toBe(110);
        expect(Number(svg.dataset.workoutYMax)).toBe(150);
        expect(Number(svg.dataset.workoutPointCount)).toBe(3);
    });

    it('renders the top-weight metric from raw.top_weight', () => {
        const payload = [
            { date: new Date('2026-04-01T12:00:00Z'), est_1rm: 116, top_weight: 100 },
            { date: new Date('2026-04-08T12:00:00Z'), est_1rm: 128, top_weight: 110 },
            { date: new Date('2026-04-15T12:00:00Z'), est_1rm: 140, top_weight: 120 },
        ];
        const svg = env.api.render({ sessions: payload, metric: 'top-weight' });
        expect(svg.dataset.workoutMetric).toBe('top-weight');
        expect(Number(svg.dataset.workoutYMin)).toBe(100);
        expect(Number(svg.dataset.workoutYMax)).toBe(130);
        expect(svg.querySelector('path.wg-workout-chart__line')).not.toBeNull();
    });

    it('returns the empty-state card when the chosen metric field is absent', () => {
        const payload = [
            { date: new Date('2026-04-01T12:00:00Z'), completed: 2 },
            { date: new Date('2026-04-08T12:00:00Z'), completed: 3 },
        ];
        const svg = env.api.render({ sessions: payload, metric: 'est-1rm' });
        expect(svg.classList.contains('wg-workout-chart--empty')).toBe(true);
    });

    // med-zte — bars for discrete buckets (weekly tonnage). The line stays the
    // default so exercise-detail's est-1RM / top-weight / reps charts are
    // untouched by the option existing.
    describe('variant: bars', () => {
        const weekly = [
            { week: '2026-04-06T12:00:00Z', volume: 900 },
            { week: '2026-04-13T12:00:00Z', volume: 0 },
            { week: '2026-04-20T12:00:00Z', volume: 1400 },
        ];

        it('emits one rect per bucket and no line or last-point marker', () => {
            const svg = env.api.render({ sessions: weekly, metric: 'volume', variant: 'bars' });
            expect(svg.dataset.workoutVariant).toBe('bars');
            const bars = svg.querySelectorAll('rect.wg-workout-chart__bar');
            expect(bars).toHaveLength(3);
            expect(svg.querySelector('path.wg-workout-chart__line')).toBeNull();
            expect(svg.querySelector('circle.wg-workout-chart__last')).toBeNull();
            // The zero week is an honest zero-height bar, not a gap.
            expect(Number(bars[1].getAttribute('height'))).toBe(0);
            expect(Number(bars[2].getAttribute('height')))
                .toBeGreaterThan(Number(bars[0].getAttribute('height')));
        });

        it('keeps the y-axis on a zero baseline so bar heights stay proportional', () => {
            // With the line variant these values floor to a 900 y-min; a bar
            // chart on that axis would draw 900 as nothing at all.
            const svg = env.api.render({ sessions: weekly.slice(0, 1).concat(weekly[2]), metric: 'volume', variant: 'bars' });
            expect(Number(svg.dataset.workoutYMin)).toBe(0);
            const line = env.api.render({ sessions: weekly.slice(0, 1).concat(weekly[2]), metric: 'volume' });
            expect(Number(line.dataset.workoutYMin)).toBe(900);
        });

        it('keeps every bucket instead of downsampling, and stays inside the plot', () => {
            const svg = env.api.render({ sessions: makeSessions({ weeks: 120 }), variant: 'bars' });
            const bars = Array.from(svg.querySelectorAll('rect.wg-workout-chart__bar'));
            expect(bars).toHaveLength(120);
            const width = env.api.DEFAULT_WIDTH;
            bars.forEach((bar) => {
                const x = Number(bar.getAttribute('x'));
                const w = Number(bar.getAttribute('width'));
                expect(x).toBeGreaterThanOrEqual(0);
                expect(x + w).toBeLessThanOrEqual(width);
                expect(w).toBeGreaterThan(0);
            });
        });

        it('defaults to the line variant, and an unknown variant falls back to it', () => {
            const dflt = env.api.render({ sessions: weekly, metric: 'volume' });
            expect(dflt.dataset.workoutVariant).toBe('line');
            expect(dflt.querySelector('path.wg-workout-chart__line')).not.toBeNull();
            expect(dflt.querySelector('rect.wg-workout-chart__bar')).toBeNull();

            const bogus = env.api.render({ sessions: weekly, metric: 'volume', variant: 'candles' });
            expect(bogus.dataset.workoutVariant).toBe('line');
        });

        it('sets no inline stroke/fill/style on bars', () => {
            const svg = env.api.render({ sessions: weekly, metric: 'volume', variant: 'bars' });
            svg.querySelectorAll('rect.wg-workout-chart__bar').forEach((bar) => {
                expect(bar.getAttribute('fill')).toBeNull();
                expect(bar.getAttribute('stroke')).toBeNull();
                expect(bar.getAttribute('style')).toBeNull();
            });
        });
    });
});
