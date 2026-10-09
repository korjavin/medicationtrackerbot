// Wandergeek Weight range selector + chart panel (Phase 6, Task 4;
// Round-2 Task 12 defect #15 reshaped the container).
//
// Covers the range-selector render helper and its persistence:
//   • renderWeightRangeSelector({ active, onChange }) — flex row holding
//     a kit .wg-seg--sm strip with four 7d/30d/90d/All options AND a
//     trailing shared .wg-toolbar-btn .wg-toolbar-btn--primary
//     #add-weight-btn (mirrors BP's buildBPInlineAddButton). The active
//     option is aria-pressed (med-xso6.10).
//   • getActiveWeightRange / setActiveWeightRange — mt-weight-range
//     localStorage key, default '30d'.
//   • renderWeightChart — delegates to WGWeightChart with the active range
//     from localStorage, re-rendering when the selector changes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function isoDaysAgo(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString();
}

function sampleLogs(n) {
    const logs = [];
    for (let i = 0; i < n; i += 1) {
        logs.push({
            id: i + 1,
            measured_at: isoDaysAgo(i),
            weight: 80 - i * 0.05
        });
    }
    return logs;
}

describe('Weight range selector + chart panel (Phase 6, Task 4)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    describe('getActiveWeightRange / setActiveWeightRange', () => {
        it("defaults to '30d' when no value is stored", () => {
            const { window } = env;
            window.localStorage.removeItem('mt-weight-range');
            expect(window.getActiveWeightRange()).toBe('30d');
        });

        it('round-trips valid range values through localStorage', () => {
            const { window } = env;
            window.setActiveWeightRange('7d');
            expect(window.localStorage.getItem('mt-weight-range')).toBe('7d');
            expect(window.getActiveWeightRange()).toBe('7d');
        });

        it('persists the all-time range and reads it back', () => {
            const { window } = env;
            window.setActiveWeightRange('all');
            expect(window.localStorage.getItem('mt-weight-range')).toBe('all');
            expect(window.getActiveWeightRange()).toBe('all');
        });

        it('ignores invalid values and keeps the previous setting', () => {
            const { window } = env;
            window.setActiveWeightRange('90d');
            window.setActiveWeightRange('bogus');
            expect(window.getActiveWeightRange()).toBe('90d');
        });
    });

    describe('renderWeightRangeSelector', () => {
        it('renders four 7d/30d/90d/All options inside a .wg-seg--sm strip', () => {
            const { document, window } = env;
            window.renderWeightRangeSelector({ active: '30d', onChange: () => {} });

            const container = document.getElementById('weight-range-selector');
            expect(container.classList.contains('wg-range-row')).toBe(true);
            // The strip is an inner child of the row so the trailing +Log
            // button sits beside it (same .wg-range-row as BP).
            const track = container.querySelector('.wg-seg.wg-seg--sm');
            expect(track).not.toBeNull();

            const btns = track.querySelectorAll('button[data-range]');
            expect(btns.length).toBe(4);
            expect(Array.from(btns).map((b) => b.getAttribute('data-range')))
                .toEqual(['7d', '30d', '90d', 'all']);
            expect(Array.from(btns).map((b) => b.textContent))
                .toEqual(['7d', '30d', '90d', 'All']);
        });

        it('appends a trailing #add-weight-btn primary toolbar button that opens the weight modal', () => {
            const { document, window } = env;
            window.renderWeightRangeSelector({ active: '30d', onChange: () => {} });

            const cta = document.getElementById('add-weight-btn');
            expect(cta).not.toBeNull();
            // Shared Round-2 Task 2 toolbar classes (color-only --primary).
            expect(cta.classList.contains('wg-toolbar-btn')).toBe(true);
            expect(cta.classList.contains('wg-toolbar-btn--primary')).toBe(true);
            // The label span uses the shared .wg-toolbar-btn__label.
            const label = cta.querySelector('.wg-toolbar-btn__label');
            expect(label).not.toBeNull();
            expect(label.textContent).toBe('Log');
            expect(cta.getAttribute('aria-label')).toBe('Log weight');
            expect(cta.getAttribute('type')).toBe('button');

            // Button lives inside the outer selector row, NOT inside the
            // range strip (so it sits beside the strip).
            const container = document.getElementById('weight-range-selector');
            expect(container.contains(cta)).toBe(true);
            const track = container.querySelector('.wg-seg');
            expect(track.contains(cta)).toBe(false);

            // Clicking dispatches to window.showWeightModal (mirrors BP's
            // `#add-bp-btn` → `window.showBPRecordModal` wiring).
            const spy = vi.fn();
            window.showWeightModal = spy;
            cta.click();
            expect(spy).toHaveBeenCalledTimes(1);
        });

        it('marks exactly one option as selected via aria-pressed', () => {
            const { document, window } = env;
            window.renderWeightRangeSelector({ active: '30d', onChange: () => {} });

            const active = document.querySelectorAll('#weight-range-selector .wg-seg__opt[aria-pressed="true"]');
            expect(active.length).toBe(1);
            expect(active[0].getAttribute('data-range')).toBe('30d');
            expect(document.querySelectorAll('#weight-range-selector .wg-seg__opt[aria-pressed="false"]').length).toBe(3);
        });

        it("falls back to the default ('30d') range when active is invalid", () => {
            const { document, window } = env;
            window.renderWeightRangeSelector({ active: 'bogus', onChange: () => {} });
            const active = document.querySelector('#weight-range-selector .wg-seg__opt[aria-pressed="true"]');
            expect(active.getAttribute('data-range')).toBe('30d');
        });

        it('invokes onChange with the selected range when a different button is clicked', () => {
            const { document, window } = env;
            const onChange = vi.fn();
            window.renderWeightRangeSelector({ active: '30d', onChange });

            const btn7 = document.querySelector('#weight-range-selector button[data-range="7d"]');
            btn7.click();
            expect(onChange).toHaveBeenCalledTimes(1);
            expect(onChange).toHaveBeenCalledWith('7d');
        });

        it('does not invoke onChange when the already-active button is clicked', () => {
            const { document, window } = env;
            const onChange = vi.fn();
            window.renderWeightRangeSelector({ active: '30d', onChange });

            const btn30 = document.querySelector('#weight-range-selector button[data-range="30d"]');
            btn30.click();
            expect(onChange).not.toHaveBeenCalled();
        });

        it('uses the "All" label for the all-time range option', () => {
            const { document, window } = env;
            window.renderWeightRangeSelector({ active: 'all', onChange: () => {} });
            const btnAll = document.querySelector('#weight-range-selector button[data-range="all"]');
            expect(btnAll.textContent).toBe('All');
            expect(btnAll.getAttribute('aria-pressed')).toBe('true');
        });
    });

    describe('renderWeightChart (delegates to WGWeightChart)', () => {
        it('inserts a WGWeightChart SVG into the #weightChart container', () => {
            const { document, window } = env;
            window.renderWeightChart(sampleLogs(40), {});

            const chart = document.getElementById('weightChart');
            expect(chart.classList.contains('wg-weight-chart-panel')).toBe(true);
            const svg = chart.querySelector('svg.wg-weight-chart');
            expect(svg).not.toBeNull();
            expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
        });

        it('tags the chart container with the active range from localStorage', () => {
            const { document, window } = env;
            window.localStorage.setItem('mt-weight-range', '7d');
            window.renderWeightChart(sampleLogs(40), {});
            expect(document.getElementById('weightChart').getAttribute('data-weight-range')).toBe('7d');
        });

        it('forwards the active range to WGWeightChart.render', () => {
            const { window } = env;
            window.localStorage.setItem('mt-weight-range', '7d');
            const renderSpy = vi.spyOn(window.WGWeightChart, 'render');
            window.renderWeightChart(sampleLogs(40), {});

            expect(renderSpy).toHaveBeenCalled();
            const args = renderSpy.mock.calls[0][0];
            expect(args.range).toBe('7d');
        });

        it('renders an empty-state card for empty logs without crashing', () => {
            const { document, window } = env;
            window.renderWeightChart([], {});
            const empty = document.querySelector('#weightChart .wg-weight-chart--empty');
            expect(empty).not.toBeNull();
        });

        it('re-renders the chart with the new range when the selector callback fires', () => {
            const { document, window } = env;
            window.localStorage.setItem('mt-weight-range', '30d');
            const renderSpy = vi.spyOn(window.WGWeightChart, 'render');

            // First render (explicit entry point).
            window.renderWeightChart(sampleLogs(60), {});
            expect(renderSpy).toHaveBeenCalled();
            const firstRange = renderSpy.mock.calls[0][0].range;
            expect(firstRange).toBe('30d');

            // Simulate user toggling the range: persist + re-render.
            window.renderWeightRangeSelector({
                active: '30d',
                onChange: (r) => {
                    window.setActiveWeightRange(r);
                    window.renderWeightChart(sampleLogs(60), {});
                }
            });
            document.querySelector('#weight-range-selector button[data-range="7d"]').click();

            expect(window.localStorage.getItem('mt-weight-range')).toBe('7d');
            const lastRange = renderSpy.mock.calls[renderSpy.mock.calls.length - 1][0].range;
            expect(lastRange).toBe('7d');
            expect(document.getElementById('weightChart').getAttribute('data-weight-range')).toBe('7d');
        });
    });

    describe('default range behavior', () => {
        it("the chart uses '30d' by default without any localStorage entry", () => {
            const { document, window } = env;
            window.localStorage.removeItem('mt-weight-range');
            const renderSpy = vi.spyOn(window.WGWeightChart, 'render');
            window.renderWeightChart(sampleLogs(40), {});

            expect(renderSpy).toHaveBeenCalled();
            expect(renderSpy.mock.calls[0][0].range).toBe('30d');
            expect(document.getElementById('weightChart').getAttribute('data-weight-range')).toBe('30d');
        });
    });
});
