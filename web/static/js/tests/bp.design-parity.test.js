// Round-2, Task 2 — BP design-parity tests.
//
// Pins the four invariants the round-2 parity pass introduced on the BP
// screen:
//
//   1. #bp-current-card top summary pane is removed from index.html.
//   2. Default range pill is 14d on a fresh session (no mt-bp-range in
//      localStorage).
//   3. renderBPChart emits y-axis (mmHg) and x-axis (date) tick <text>
//      nodes so the chart is readable without a separate legend.
//   4. After a POST /api/bp round-trip through handleBPSubmit, the history
//      list re-renders with the new row without a page reload.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function isoDaysAgo(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString();
}

function sampleReadings(n) {
    const out = [];
    for (let i = 0; i < n; i += 1) {
        out.push({
            id: i + 1,
            measured_at: isoDaysAgo(i),
            systolic: 118 + (i % 5),
            diastolic: 76 + (i % 4),
            pulse: 64 + (i % 6),
        });
    }
    return out;
}

describe('BP round-2 design parity', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    describe('top summary pane removal', () => {
        it('index.html does NOT mount #bp-current-card inside #bp-view', () => {
            const { document } = env;
            const view = document.getElementById('bp-view');
            expect(view).not.toBeNull();
            expect(view.querySelector('#bp-current-card')).toBeNull();
            expect(document.getElementById('bp-current-card')).toBeNull();
        });

        it('window.renderCurrentReading is no longer exported — production path is empty', () => {
            const { window } = env;
            expect(typeof window.renderCurrentReading).toBe('undefined');
        });
    });

    describe('default range is 14d', () => {
        it('getActiveBPRange returns 14 when no value is stored', () => {
            const { window } = env;
            window.localStorage.removeItem('mt-bp-range');
            expect(window.getActiveBPRange()).toBe(14);
        });

        it('renderRangeSelector with no active prop marks the 14d pill as active', () => {
            const { document, window } = env;
            window.renderRangeSelector({ onChange: () => {} });
            const active = document.querySelector(
                '#bp-range-selector .wg-bp-range-selector__track .wg-gloss--sun'
            );
            expect(active).not.toBeNull();
            expect(active.getAttribute('data-range')).toBe('14');
        });
    });

    describe('chart axis ticks', () => {
        it('renders y-axis mmHg ticks (from the 60/80/100/120/140/160/180 ladder)', () => {
            const { document, window } = env;
            window.localStorage.setItem('mt-bp-range', '14');
            window.renderBPChart(sampleReadings(30), {});

            const svg = document.querySelector('#bpChart svg.wg-bp-chart');
            expect(svg).not.toBeNull();

            const yTicks = svg.querySelectorAll('text.wg-bp-chart__axis-tick[data-bp-axis="y"]');
            expect(yTicks.length).toBeGreaterThanOrEqual(2);
            const values = Array.from(yTicks).map((t) => Number(t.textContent));
            const ladder = [60, 80, 100, 120, 140, 160, 180];
            values.forEach((v) => {
                expect(ladder).toContain(v);
            });
            // 80 and 120 are the teal-band boundaries — typical readings should
            // pull these into the visible window.
            expect(values).toContain(80);
            expect(values).toContain(120);
        });

        it('renders at least 2 x-axis date ticks spanning the plotted window', () => {
            const { document, window } = env;
            window.localStorage.setItem('mt-bp-range', '14');
            window.renderBPChart(sampleReadings(30), {});

            const svg = document.querySelector('#bpChart svg.wg-bp-chart');
            expect(svg).not.toBeNull();

            const xTicks = svg.querySelectorAll('text.wg-bp-chart__axis-tick[data-bp-axis="x"]');
            expect(xTicks.length).toBeGreaterThanOrEqual(2);
            // Every tick must carry a non-empty label; otherwise the axis is
            // visually blank.
            xTicks.forEach((t) => {
                expect(t.textContent.trim().length).toBeGreaterThan(0);
            });
        });
    });

    describe('auto-refresh after create', () => {
        it('handleBPSubmit invalidates the bp tag AND calls loadBPReadings so the list re-renders in place', async () => {
            const { document, window } = env;

            document.getElementById('bp-datetime').value = '2026-04-23T08:00';
            document.getElementById('bp-systolic').value = '124';
            document.getElementById('bp-diastolic').value = '82';
            document.getElementById('bp-pulse').value = '70';
            document.getElementById('bp-site').value = 'right_arm';
            document.getElementById('bp-position').value = 'seated';
            document.getElementById('bp-notes').value = '';

            window.apiCall = vi.fn().mockResolvedValue({ id: 999 });
            const invalidateSpy = vi.fn().mockResolvedValue(undefined);
            window.DataStore.invalidateTags = invalidateSpy;
            const loadBPSpy = vi.fn().mockResolvedValue(undefined);
            window.loadBPReadings = loadBPSpy;
            window.closeBPRecordModal = () => {};

            const event = { preventDefault: () => {} };
            await window.handleBPSubmit(event);

            expect(window.apiCall).toHaveBeenCalledWith('/api/bp', 'POST', expect.any(Object));
            expect(invalidateSpy).toHaveBeenCalledWith(['bp']);
            expect(loadBPSpy).toHaveBeenCalledTimes(1);
        });
    });
});
