// Wandergeek BP screen render tests (Phase 3, Task 3; Round-2, Task 2).
//
// Covers the BP screen render helpers that survived the round-2 parity pass:
//   • renderRangeSelector({ active, onChange }) — .wg-gloss--inset strip
//     with three 14d/30d/60d buttons; active button gets .wg-gloss--sun.
//   • renderBPChart(readings, goalData) — delegates to WGBpChart.render()
//     with the active range; empty input renders a "No data available"
//     message without calling the chart component.
//
// Round-2, Task 2: renderCurrentReading was removed along with the top
// summary pane. Its test coverage is dropped here; the design-parity tests
// in bp.design-parity.test.js verify the pane no longer mounts.

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

    describe('renderRangeSelector', () => {
        it('renders three 14d/30d/60d buttons inside the inset track', () => {
            const { document, window } = env;
            window.renderRangeSelector({ active: 30, onChange: () => {} });

            const container = document.getElementById('bp-range-selector');
            expect(container.classList.contains('wg-bp-range-selector')).toBe(true);
            // Phase 5, Task 5: the inset track is an inner child of the row
            // so the trailing +Log pill can sit on the stage, not in the trough.
            const track = container.querySelector('.wg-bp-range-selector__track');
            expect(track).not.toBeNull();
            expect(track.classList.contains('wg-gloss--inset')).toBe(true);

            const btns = track.querySelectorAll('button[data-range]');
            expect(btns.length).toBe(3);
            expect(Array.from(btns).map((b) => b.getAttribute('data-range'))).toEqual(['14', '30', '60']);
            expect(Array.from(btns).map((b) => b.textContent)).toEqual(['14d', '30d', '60d']);
        });

        it('marks exactly one range button as active via .wg-gloss--sun and aria-pressed', () => {
            const { document, window } = env;
            window.renderRangeSelector({ active: 30, onChange: () => {} });

            // Scope to the inset track; the trailing #add-bp-btn pill also
            // carries `.wg-gloss--sun` by design (Phase 5, Task 5).
            const active = document.querySelectorAll('#bp-range-selector .wg-bp-range-selector__track .wg-gloss--sun');
            expect(active.length).toBe(1);
            expect(active[0].getAttribute('data-range')).toBe('30');
            expect(active[0].getAttribute('aria-pressed')).toBe('true');

            const inactive = document.querySelectorAll(
                '#bp-range-selector .wg-bp-range-selector__track button:not(.wg-gloss--sun)'
            );
            inactive.forEach((b) => expect(b.getAttribute('aria-pressed')).toBe('false'));
        });

        it('falls back to the default (14d) range when active is invalid', () => {
            const { document, window } = env;
            window.renderRangeSelector({ active: 999, onChange: () => {} });
            const active = document.querySelector(
                '#bp-range-selector .wg-bp-range-selector__track .wg-gloss--sun'
            );
            expect(active.getAttribute('data-range')).toBe('14');
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
        it('defaults to 14 when no value is stored', () => {
            const { window } = env;
            window.localStorage.removeItem('mt-bp-range');
            expect(window.getActiveBPRange()).toBe(14);
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

    describe('#add-bp-btn is rendered inline with the range selector (Phase 5, Task 5)', () => {
        it('is NOT present in the static index.html markup — it is rendered by renderRangeSelector', () => {
            const { document } = env;
            // Before renderRangeSelector runs, the button should not exist —
            // the paper-era FAB was removed in Phase 5, Task 5.
            expect(document.getElementById('add-bp-btn')).toBeNull();
        });

        it('renderRangeSelector injects a sun-gloss pill with id="add-bp-btn" as the row\'s trailing child', () => {
            const { document, window } = env;
            window.renderRangeSelector({ active: 60, onChange: () => {} });

            const btn = document.getElementById('add-bp-btn');
            expect(btn).not.toBeNull();
            expect(btn.classList.contains('wg-gloss')).toBe(true);
            expect(btn.classList.contains('wg-gloss--sun')).toBe(true);
            expect(btn.classList.contains('wg-bp-range-selector__add')).toBe(true);
            expect(btn.classList.contains('wg-fab')).toBe(false);
            expect(btn.classList.contains('btn-primary')).toBe(false);
            expect(btn.classList.contains('btn-fab')).toBe(false);

            const row = document.getElementById('bp-range-selector');
            // The +Log pill is the last child of the row (after the inset track).
            expect(row.lastElementChild).toBe(btn);

            const label = btn.querySelector('.wg-bp-range-selector__add-label');
            expect(label).not.toBeNull();
            expect(label.textContent.trim()).toBe('Log');
        });

        it('clicking the inline +Log pill opens the BP modal via showBPRecordModal', () => {
            const { document, window } = env;
            const spy = vi.fn();
            window.showBPRecordModal = spy;
            window.renderRangeSelector({ active: 60, onChange: () => {} });

            const btn = document.getElementById('add-bp-btn');
            btn.click();
            expect(spy).toHaveBeenCalledTimes(1);
        });

        it('has no orphan btn-primary or btn-fab (or .wg-fab) inside #bp-view', () => {
            const { document, window } = env;
            window.renderRangeSelector({ active: 60, onChange: () => {} });
            const view = document.getElementById('bp-view');
            expect(view).not.toBeNull();
            expect(view.querySelectorAll('.btn-primary').length).toBe(0);
            expect(view.querySelectorAll('.btn-fab').length).toBe(0);
            expect(view.querySelectorAll('.wg-fab').length).toBe(0);
        });
    });
});
