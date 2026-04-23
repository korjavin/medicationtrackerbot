// Wandergeek Health summary-tile row + range selector (Phase 8, Task 3).
//
// Asserts:
//   • renderHealthSummaryTiles(data, range) renders one tile per vital
//     (sleep, steps, HR, SpO2, stress) with mono value, uppercase label,
//     and a per-vital trend arrow variant (sun / alert / neutral / empty).
//   • Trend classifier flips per-vital:
//       steps / spo2: up = sun, down = alert
//       stress:       down = sun, up   = alert
//       sleep:        toward 8h = sun, away = alert
//       hr:           active in [50,90] = sun, out = alert
//   • Empty-tile fallback: missing/zero value → "—" placeholder, no trend.
//   • renderHealthRangeSelector renders .wg-gloss--inset + two pills
//     (7d / 30d); exactly one carries .wg-gloss--sun; click invokes onChange.
//   • Range persists via mt-health-range, default 7d.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function makeData(overrides) {
    const base = {
        average_sleep_hours_7d: 7.8,
        average_sleep_hours_30d: 7.2,
        average_steps_7d: 9200,
        average_steps_30d: 8400,
        average_heart_rate_7d: 68,
        average_heart_rate_30d: 70,
        average_spo2_7d: 97,
        average_spo2_30d: 96,
        average_stress_7d: 42,
        average_stress_30d: 48
    };
    return Object.assign({}, base, overrides || {});
}

describe('Health summary-tile row + range selector (Phase 8, Task 3)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    describe('getActiveHealthRange / setActiveHealthRange', () => {
        it("defaults to '7d' when no value is stored", () => {
            const { window } = env;
            window.localStorage.removeItem('mt-health-range');
            expect(window.getActiveHealthRange()).toBe('7d');
        });

        it('round-trips valid range values through localStorage', () => {
            const { window } = env;
            window.setActiveHealthRange('30d');
            expect(window.localStorage.getItem('mt-health-range')).toBe('30d');
            expect(window.getActiveHealthRange()).toBe('30d');
        });

        it('ignores invalid values and keeps the previous setting', () => {
            const { window } = env;
            window.setActiveHealthRange('30d');
            window.setActiveHealthRange('90d');
            window.setActiveHealthRange('bogus');
            expect(window.getActiveHealthRange()).toBe('30d');
        });
    });

    describe('renderHealthRangeSelector', () => {
        it('renders .wg-gloss--inset with two 7d/30d pills', () => {
            const { window } = env;
            const el = window.renderHealthRangeSelector({ active: '7d', onChange: () => {} });
            expect(el.classList.contains('wg-gloss--inset')).toBe(true);
            expect(el.classList.contains('wg-health-range-selector')).toBe(true);

            const btns = el.querySelectorAll('button[data-range]');
            expect(btns.length).toBe(2);
            expect(Array.from(btns).map((b) => b.getAttribute('data-range'))).toEqual(['7d', '30d']);
            expect(Array.from(btns).map((b) => b.textContent)).toEqual(['7d', '30d']);
        });

        it('marks exactly one button as active via .wg-gloss--sun and aria-pressed', () => {
            const { window } = env;
            const el = window.renderHealthRangeSelector({ active: '30d', onChange: () => {} });
            const active = el.querySelectorAll('.wg-gloss--sun');
            expect(active.length).toBe(1);
            expect(active[0].getAttribute('data-range')).toBe('30d');
            expect(active[0].getAttribute('aria-pressed')).toBe('true');

            const inactive = el.querySelectorAll('button:not(.wg-gloss--sun)');
            inactive.forEach((b) => expect(b.getAttribute('aria-pressed')).toBe('false'));
        });

        it("falls back to '7d' default when active is invalid", () => {
            const { window } = env;
            const el = window.renderHealthRangeSelector({ active: 'bogus', onChange: () => {} });
            const active = el.querySelector('.wg-gloss--sun');
            expect(active.getAttribute('data-range')).toBe('7d');
        });

        it('invokes onChange with the selected range when a different button is clicked', () => {
            const { window } = env;
            const onChange = vi.fn();
            const el = window.renderHealthRangeSelector({ active: '7d', onChange });
            el.querySelector('button[data-range="30d"]').click();
            expect(onChange).toHaveBeenCalledWith('30d');
        });

        it('does not invoke onChange when the already-active button is clicked', () => {
            const { window } = env;
            const onChange = vi.fn();
            const el = window.renderHealthRangeSelector({ active: '7d', onChange });
            el.querySelector('button[data-range="7d"]').click();
            expect(onChange).not.toHaveBeenCalled();
        });
    });

    describe('renderHealthSummaryTiles', () => {
        it('renders one tile per vital in sleep/steps/hr/spo2/stress order', () => {
            const { window } = env;
            const tiles = window.renderHealthSummaryTiles(makeData(), '7d');
            expect(tiles.classList.contains('wg-card')).toBe(true);
            expect(tiles.classList.contains('wg-health-summary')).toBe(true);
            expect(tiles.getAttribute('data-range')).toBe('7d');

            const perTile = tiles.querySelectorAll('.wg-health-summary__tile');
            expect(perTile.length).toBe(5);
            expect(Array.from(perTile).map((t) => t.getAttribute('data-vital')))
                .toEqual(['sleep', 'steps', 'hr', 'spo2', 'stress']);
        });

        it('formats the sleep tile with one decimal + "h" unit', () => {
            const { window } = env;
            const tiles = window.renderHealthSummaryTiles(makeData(), '7d');
            const sleepTile = tiles.querySelector('[data-vital="sleep"]');
            const val = sleepTile.querySelector('.wg-health-summary__value');
            expect(val.textContent).toBe('7.8 h');
        });

        it('formats the steps tile with locale grouping and no unit suffix', () => {
            const { window } = env;
            const tiles = window.renderHealthSummaryTiles(makeData(), '7d');
            const stepsTile = tiles.querySelector('[data-vital="steps"]');
            const val = stepsTile.querySelector('.wg-health-summary__value');
            // Contains a 9, some grouping separator, then 200.
            expect(val.textContent).toMatch(/^9\D?200$/);
        });

        it('uses the 30d average when range=30d', () => {
            const { window } = env;
            const tiles = window.renderHealthSummaryTiles(makeData(), '30d');
            const spo2Tile = tiles.querySelector('[data-vital="spo2"]');
            const val = spo2Tile.querySelector('.wg-health-summary__value');
            expect(val.textContent).toBe('96 %');
        });

        it('steps trend: up vs 30d = sun variant with up arrow', () => {
            const { window } = env;
            const tiles = window.renderHealthSummaryTiles(makeData({ average_steps_7d: 10000, average_steps_30d: 8000 }), '7d');
            const trend = tiles.querySelector('[data-vital="steps"] .wg-health-summary__trend');
            expect(trend.getAttribute('data-variant')).toBe('sun');
            expect(trend.textContent).toBe('\u2191');
        });

        it('steps trend: down vs 30d = alert variant with down arrow', () => {
            const { window } = env;
            const tiles = window.renderHealthSummaryTiles(makeData({ average_steps_7d: 7000, average_steps_30d: 9000 }), '7d');
            const trend = tiles.querySelector('[data-vital="steps"] .wg-health-summary__trend');
            expect(trend.getAttribute('data-variant')).toBe('alert');
            expect(trend.textContent).toBe('\u2193');
        });

        it('stress trend: down vs 30d = sun variant (lower stress is better)', () => {
            const { window } = env;
            const tiles = window.renderHealthSummaryTiles(makeData({ average_stress_7d: 30, average_stress_30d: 50 }), '7d');
            const trend = tiles.querySelector('[data-vital="stress"] .wg-health-summary__trend');
            expect(trend.getAttribute('data-variant')).toBe('sun');
            expect(trend.textContent).toBe('\u2193');
        });

        it('stress trend: up vs 30d = alert variant', () => {
            const { window } = env;
            const tiles = window.renderHealthSummaryTiles(makeData({ average_stress_7d: 70, average_stress_30d: 50 }), '7d');
            const trend = tiles.querySelector('[data-vital="stress"] .wg-health-summary__trend');
            expect(trend.getAttribute('data-variant')).toBe('alert');
        });

        it('sleep trend: closer to 8h = sun, farther = alert', () => {
            const { window } = env;

            const closer = window.renderHealthSummaryTiles(makeData({ average_sleep_hours_7d: 7.6, average_sleep_hours_30d: 6.4 }), '7d');
            expect(closer.querySelector('[data-vital="sleep"] .wg-health-summary__trend').getAttribute('data-variant')).toBe('sun');

            const farther = window.renderHealthSummaryTiles(makeData({ average_sleep_hours_7d: 5.0, average_sleep_hours_30d: 7.0 }), '7d');
            expect(farther.querySelector('[data-vital="sleep"] .wg-health-summary__trend').getAttribute('data-variant')).toBe('alert');
        });

        it('hr trend: in-range active avg = sun; out-of-range = alert', () => {
            const { window } = env;

            const inRange = window.renderHealthSummaryTiles(makeData({ average_heart_rate_7d: 68, average_heart_rate_30d: 70 }), '7d');
            expect(inRange.querySelector('[data-vital="hr"] .wg-health-summary__trend').getAttribute('data-variant')).toBe('sun');

            const outOfRange = window.renderHealthSummaryTiles(makeData({ average_heart_rate_7d: 105, average_heart_rate_30d: 100 }), '7d');
            expect(outOfRange.querySelector('[data-vital="hr"] .wg-health-summary__trend').getAttribute('data-variant')).toBe('alert');
        });

        it('spo2 trend: up = sun, down = alert', () => {
            const { window } = env;

            const up = window.renderHealthSummaryTiles(makeData({ average_spo2_7d: 98, average_spo2_30d: 96 }), '7d');
            expect(up.querySelector('[data-vital="spo2"] .wg-health-summary__trend').getAttribute('data-variant')).toBe('sun');

            const down = window.renderHealthSummaryTiles(makeData({ average_spo2_7d: 92, average_spo2_30d: 96 }), '7d');
            expect(down.querySelector('[data-vital="spo2"] .wg-health-summary__trend').getAttribute('data-variant')).toBe('alert');
        });

        it('empty-tile fallback: missing value renders "—" without a trend arrow', () => {
            const { window } = env;
            const tiles = window.renderHealthSummaryTiles({
                average_sleep_hours_7d: null,
                average_sleep_hours_30d: null,
                average_steps_7d: 9000,
                average_steps_30d: 8000,
                average_heart_rate_7d: 70,
                average_heart_rate_30d: 68,
                average_spo2_7d: 97,
                average_spo2_30d: 96,
                average_stress_7d: 40,
                average_stress_30d: 45
            }, '7d');
            const sleepTile = tiles.querySelector('[data-vital="sleep"]');
            expect(sleepTile.classList.contains('wg-health-summary__tile--empty')).toBe(true);
            const val = sleepTile.querySelector('.wg-health-summary__value');
            expect(val.textContent).toBe('\u2014');
            const trend = sleepTile.querySelector('.wg-health-summary__trend');
            expect(trend.getAttribute('data-variant')).toBe('empty');
            expect(trend.textContent).toBe('');
        });

        it('neutral trend when active equals other average', () => {
            const { window } = env;
            const tiles = window.renderHealthSummaryTiles(makeData({ average_steps_7d: 9000, average_steps_30d: 9000 }), '7d');
            const trend = tiles.querySelector('[data-vital="steps"] .wg-health-summary__trend');
            expect(trend.getAttribute('data-variant')).toBe('neutral');
        });
    });

    describe('range selector wired into renderHealthOverviewContent', () => {
        it('mounts a .wg-health-summary grid + a .wg-health-range-selector in the content', () => {
            const { document, window } = env;
            const content = document.getElementById('health-overview-content');
            window.renderHealthOverviewContent(content, makeData());

            expect(content.querySelector('.wg-health-summary')).not.toBeNull();
            const selector = content.querySelector('.wg-health-range-selector');
            expect(selector).not.toBeNull();
            expect(selector.classList.contains('wg-gloss--inset')).toBe(true);
            expect(selector.querySelectorAll('button[data-range]').length).toBe(2);
        });

        it('range change from the selector re-renders tiles with the new range', () => {
            const { document, window } = env;
            const content = document.getElementById('health-overview-content');
            window.localStorage.setItem('mt-health-range', '7d');
            window.renderHealthOverviewContent(content, makeData());

            let summary = content.querySelector('.wg-health-summary');
            expect(summary.getAttribute('data-range')).toBe('7d');

            const btn30 = content.querySelector('.wg-health-range-selector button[data-range="30d"]');
            btn30.click();

            expect(window.localStorage.getItem('mt-health-range')).toBe('30d');
            summary = content.querySelector('.wg-health-summary');
            expect(summary.getAttribute('data-range')).toBe('30d');
            // spo2 tile reflects the 30d average (96 vs 97).
            const spo2Val = summary.querySelector('[data-vital="spo2"] .wg-health-summary__value');
            expect(spo2Val.textContent).toBe('96 %');
        });
    });
});
