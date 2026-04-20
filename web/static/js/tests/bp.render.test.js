// Wandergeek BP screen render tests (Phase 3, Task 3).
//
// Covers the three new render helpers on the BP screen:
//   • renderCurrentReading(reading) — .wg-bp-current-card with 44px mono
//     sys/dia display, status tag from getBPCategory, optional pulse row,
//     optional pulse sparkline via WGSparkline.
//   • renderRangeSelector({ active, onChange }) — .wg-gloss--inset strip
//     with three 14d/30d/60d buttons; active button gets .wg-gloss--sun.
//   • renderBPChart(readings, goalData) — delegates to WGBpChart.render()
//     with the active range; empty input renders a "No data available"
//     message without calling the chart component.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function isoDaysAgo(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString();
}

function sampleReadings(n) {
    const readings = [];
    for (let i = 0; i < n; i += 1) {
        readings.push({
            id: i + 1,
            measured_at: isoDaysAgo(i),
            systolic: 120 + (i % 5),
            diastolic: 78 + (i % 4),
            pulse: 62 + (i % 6)
        });
    }
    return readings;
}

describe('BP screen render helpers (Phase 3, Task 3)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    describe('renderCurrentReading', () => {
        it('renders the current-reading card with 44px mono sys/dia and status tag', () => {
            const { document, window } = env;
            const reading = {
                id: 1,
                measured_at: '2026-04-20T08:12:00Z',
                systolic: 132,
                diastolic: 70,
                pulse: 76
            };
            window.renderCurrentReading(reading);

            const card = document.getElementById('bp-current-card');
            expect(card.classList.contains('wg-bp-current-card')).toBe(true);
            expect(card.classList.contains('wg-card')).toBe(true);

            const value = card.querySelector('.wg-bp-current-card__value');
            expect(value).not.toBeNull();
            expect(value.classList.contains('wg-mono-display')).toBe(true);
            expect(value.querySelector('.wg-bp-current-card__sys').textContent).toBe('132');
            expect(value.querySelector('.wg-bp-current-card__dia').textContent).toBe('/70');

            const tag = card.querySelector('.wg-bp-status');
            expect(tag).not.toBeNull();
            expect(tag.classList.contains('wg-bp-status--highnormal')).toBe(true);

            const pulse = card.querySelector('.wg-bp-current-card__pulse');
            expect(pulse).not.toBeNull();
            expect(pulse.textContent).toContain('76');
        });

        it('renders a pulse sparkline via WGSparkline when pulse is present', () => {
            const { document, window } = env;
            window.renderCurrentReading({
                id: 2,
                measured_at: '2026-04-20T08:12:00Z',
                systolic: 118,
                diastolic: 76,
                pulse: 66
            });

            const svg = document.querySelector('#bp-current-card svg.wg-sparkline');
            expect(svg).not.toBeNull();
            expect(svg.classList.contains('wg-sparkline--sun')).toBe(true);
        });

        it('uses actual pulse history when recentReadings are provided', () => {
            const { document, window } = env;
            const recentReadings = [
                { measured_at: '2026-04-20T08:00:00Z', pulse: 60 },
                { measured_at: '2026-04-20T08:04:00Z', pulse: 62 },
                { measured_at: '2026-04-20T08:08:00Z', pulse: 65 },
                { measured_at: '2026-04-20T08:12:00Z', pulse: 66 },
            ];
            const latestReading = recentReadings[recentReadings.length - 1];
            const sparkRenderSpy = vi.spyOn(window.WGSparkline, 'render');

            window.renderCurrentReading(latestReading, recentReadings);

            expect(sparkRenderSpy).toHaveBeenCalled();
            const callArgs = sparkRenderSpy.mock.calls[0][0];
            // Must use actual pulse history [60, 62, 65, 66], not fabricated values
            expect(callArgs.points).toEqual([60, 62, 65, 66]);
        });

        it('sorts unsorted readings by measured_at before extracting pulse sparkline', () => {
            const { document, window } = env;
            const recentReadings = [
                // Simulate pending items first (unsorted), then server data (newest-first)
                { measured_at: '2026-04-20T08:08:00Z', pulse: 65 },
                { measured_at: '2026-04-20T08:00:00Z', pulse: 60 },
                { measured_at: '2026-04-20T08:12:00Z', pulse: 66 },
                { measured_at: '2026-04-20T08:04:00Z', pulse: 62 },
            ];
            const latestReading = {
                id: 2,
                measured_at: '2026-04-20T08:12:00Z',
                systolic: 118,
                diastolic: 76,
                pulse: 66
            };
            const sparkRenderSpy = vi.spyOn(window.WGSparkline, 'render');

            window.renderCurrentReading(latestReading, recentReadings);

            expect(sparkRenderSpy).toHaveBeenCalled();
            const callArgs = sparkRenderSpy.mock.calls[0][0];
            // Must sort by measured_at despite unsorted input, and show chronological trend
            expect(callArgs.points).toEqual([60, 62, 65, 66]);
        });

        it('falls back to current pulse only if no history has pulse values', () => {
            const { document, window } = env;
            const recentReadings = [
                { measured_at: '2026-04-20T08:00:00Z', pulse: null },
                { measured_at: '2026-04-20T08:04:00Z', pulse: null },
            ];
            const latestReading = {
                id: 2,
                measured_at: '2026-04-20T08:12:00Z',
                systolic: 118,
                diastolic: 76,
                pulse: 66
            };
            const sparkRenderSpy = vi.spyOn(window.WGSparkline, 'render');

            window.renderCurrentReading(latestReading, recentReadings);

            expect(sparkRenderSpy).toHaveBeenCalled();
            const callArgs = sparkRenderSpy.mock.calls[0][0];
            // No pulse history available, so fall back to current pulse only
            expect(callArgs.points).toEqual([66]);
        });

        it('shows "No readings yet" when the reading is null', () => {
            const { document, window } = env;
            window.renderCurrentReading(null);

            const card = document.getElementById('bp-current-card');
            expect(card.textContent).toMatch(/no readings/i);
            expect(card.querySelector('.wg-bp-current-card__value')).toBeNull();
        });

        it('labels offline-pending readings with a pending-sync kicker', () => {
            const { document, window } = env;
            window.renderCurrentReading({
                id: 'local_9',
                measured_at: '2026-04-20T08:12:00Z',
                systolic: 125,
                diastolic: 82,
                pulse: null,
                isLocal: true
            });

            const kicker = document.querySelector('#bp-current-card .wg-bp-current-card__kicker');
            expect(kicker.textContent).toMatch(/pending sync/i);
        });

        it('maps Grade 2 BP to the grade2 status class', () => {
            const { document, window } = env;
            window.renderCurrentReading({
                id: 3,
                measured_at: '2026-04-20T08:12:00Z',
                systolic: 168,
                diastolic: 104,
                pulse: 80
            });
            const tag = document.querySelector('#bp-current-card .wg-bp-status');
            expect(tag.classList.contains('wg-bp-status--grade2')).toBe(true);
        });
    });

    describe('renderRangeSelector', () => {
        it('renders three 14d/30d/60d buttons inside .wg-gloss--inset', () => {
            const { document, window } = env;
            window.renderRangeSelector({ active: 30, onChange: () => {} });

            const container = document.getElementById('bp-range-selector');
            expect(container.classList.contains('wg-bp-range-selector')).toBe(true);
            expect(container.classList.contains('wg-gloss--inset')).toBe(true);

            const btns = container.querySelectorAll('button[data-range]');
            expect(btns.length).toBe(3);
            expect(Array.from(btns).map((b) => b.getAttribute('data-range'))).toEqual(['14', '30', '60']);
            expect(Array.from(btns).map((b) => b.textContent)).toEqual(['14d', '30d', '60d']);
        });

        it('marks exactly one button as active via .wg-gloss--sun and aria-pressed', () => {
            const { document, window } = env;
            window.renderRangeSelector({ active: 30, onChange: () => {} });

            const active = document.querySelectorAll('#bp-range-selector .wg-gloss--sun');
            expect(active.length).toBe(1);
            expect(active[0].getAttribute('data-range')).toBe('30');
            expect(active[0].getAttribute('aria-pressed')).toBe('true');

            const inactive = document.querySelectorAll('#bp-range-selector button:not(.wg-gloss--sun)');
            inactive.forEach((b) => expect(b.getAttribute('aria-pressed')).toBe('false'));
        });

        it('falls back to the default (60d) range when active is invalid', () => {
            const { document, window } = env;
            window.renderRangeSelector({ active: 999, onChange: () => {} });
            const active = document.querySelector('#bp-range-selector .wg-gloss--sun');
            expect(active.getAttribute('data-range')).toBe('60');
        });

        it('invokes onChange with the selected range when a different button is clicked', () => {
            const { document, window } = env;
            const onChange = vi.fn();
            window.renderRangeSelector({ active: 60, onChange });

            const btn14 = document.querySelector('#bp-range-selector button[data-range="14"]');
            btn14.click();
            expect(onChange).toHaveBeenCalledTimes(1);
            expect(onChange).toHaveBeenCalledWith(14);
        });

        it('does not invoke onChange when the already-active button is clicked', () => {
            const { document, window } = env;
            const onChange = vi.fn();
            window.renderRangeSelector({ active: 30, onChange });

            const btn30 = document.querySelector('#bp-range-selector button[data-range="30"]');
            btn30.click();
            expect(onChange).not.toHaveBeenCalled();
        });
    });

    describe('renderBPChart (delegates to WGBpChart)', () => {
        it('inserts an SVG produced by WGBpChart.render into the #bpChart container', () => {
            const { document, window } = env;
            window.renderBPChart(sampleReadings(30), {});

            const chart = document.getElementById('bpChart');
            expect(chart.classList.contains('wg-bp-chart-card')).toBe(true);
            const svg = chart.querySelector('svg.wg-bp-chart');
            expect(svg).not.toBeNull();
            expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
        });

        it('tags the chart container with the active range from localStorage', () => {
            const { document, window } = env;
            window.localStorage.setItem('mt-bp-range', '14');
            window.renderBPChart(sampleReadings(30), {});
            expect(document.getElementById('bpChart').getAttribute('data-bp-range')).toBe('14');
        });

        it('filters readings by the active range before handing them to WGBpChart', () => {
            const { window } = env;
            window.localStorage.setItem('mt-bp-range', '14');
            const renderSpy = vi.spyOn(window.WGBpChart, 'render');
            // Capture cutoff BEFORE the render call so it is guaranteed to be
            // <= the Date.now() the renderer uses internally (otherwise a 1ms
            // delta makes the boundary reading fail the assertion).
            const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
            window.renderBPChart(sampleReadings(30), {});

            expect(renderSpy).toHaveBeenCalled();
            const { readings } = renderSpy.mock.calls[0][0];
            // Every reading handed to the chart must fall within the last 14 days.
            for (const r of readings) {
                expect(new Date(r.measured_at).getTime()).toBeGreaterThanOrEqual(cutoff);
            }
        });

        it('renders a "No data available" message for empty readings without invoking WGBpChart', () => {
            const { document, window } = env;
            const renderSpy = vi.spyOn(window.WGBpChart, 'render');
            window.renderBPChart([], {});
            expect(renderSpy).not.toHaveBeenCalled();
            expect(document.querySelector('#bpChart .no-data-msg')).not.toBeNull();
        });
    });

    describe('getActiveBPRange / setActiveBPRange', () => {
        it('defaults to 60 when no value is stored', () => {
            const { window } = env;
            window.localStorage.removeItem('mt-bp-range');
            expect(window.getActiveBPRange()).toBe(60);
        });

        it('round-trips valid range values through localStorage', () => {
            const { window } = env;
            window.setActiveBPRange(14);
            expect(window.localStorage.getItem('mt-bp-range')).toBe('14');
            expect(window.getActiveBPRange()).toBe(14);
        });

        it('ignores invalid values and keeps the previous setting', () => {
            const { window } = env;
            window.setActiveBPRange(30);
            window.setActiveBPRange(999);
            expect(window.getActiveBPRange()).toBe(30);
        });
    });
});
