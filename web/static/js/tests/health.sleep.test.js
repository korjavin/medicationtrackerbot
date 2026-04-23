// Wandergeek Health sleep-card wiring (Phase 8, Task 4).
//
// Asserts:
//   • renderSleepCard mounts a .wg-card + .wg-sleep-card shell with a mono
//     header, a WGSleepChart SVG, a legend row with per-stage + HR swatches,
//     and a section-label averages line.
//   • The legend badge variants carry the correct --wg-health-sleep-* token
//     hook via their __badge--{variant} class (deep / light / rem / awake /
//     hr) — colours are never set inline.
//   • Empty state: missing sleep_stats_7d data renders a muted
//     "No sleep data yet" card under the same header shell.
//   • renderHealthOverviewContent wires the sleep card into the overview
//     stream after the summary tiles + range selector.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function makeSleepStats(days = 5) {
    const anchor = Date.now() - 5000;
    const dayMs = 86400000;
    const stats = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(anchor - i * dayMs);
        const iso = d.toISOString().slice(0, 10);
        stats.push({
            date: iso,
            deep_mins: 80,
            light_mins: 220,
            rem_mins: 70,
            awake_mins: 20,
            total_mins: 390,
            heart_rate_avg: 58 + (days - i),
        });
    }
    return stats;
}

function makeData(overrides) {
    const base = {
        sleep_stats_7d: makeSleepStats(5),
        average_sleep_hours_7d: 6.5,
        average_sleep_hours_30d: 6.9,
        step_stats_7d: [],
        average_steps_7d: 0,
        average_steps_30d: 0,
        heart_rate_history_7d: [],
        average_heart_rate_7d: 0,
        average_heart_rate_30d: 0,
        spo2_history_7d: [],
        average_spo2_7d: 0,
        average_spo2_30d: 0,
        stress_history_7d: [],
        average_stress_7d: 0,
        average_stress_30d: 0,
    };
    return Object.assign({}, base, overrides || {});
}

describe('Health sleep card (Phase 8, Task 4)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renderSleepCard returns a .wg-card + .wg-sleep-card shell with mono header', () => {
        const { window } = env;
        const card = window.renderSleepCard(makeData(), '7d');
        expect(card.classList.contains('wg-card')).toBe(true);
        expect(card.classList.contains('wg-sleep-card')).toBe(true);
        expect(card.getAttribute('data-range')).toBe('7d');
        const header = card.querySelector('.wg-sleep-card__header');
        expect(header).not.toBeNull();
        expect(header.classList.contains('wg-mono-display')).toBe(true);
        expect(header.textContent).toBe('Sleep');
    });

    it('mounts a WGSleepChart SVG inside the card with the active range', () => {
        const { window } = env;
        const card = window.renderSleepCard(makeData(), '7d');
        const svg = card.querySelector('svg.wg-sleep-chart');
        expect(svg).not.toBeNull();
        expect(svg.dataset.sleepRange).toBe('7d');
        // At least one stage rect exists.
        expect(card.querySelectorAll('rect.wg-sleep-chart__stage').length).toBeGreaterThan(0);
    });

    it('renders a legend row with the 5 canonical swatches (deep/light/rem/awake/hr)', () => {
        const { window } = env;
        const card = window.renderSleepCard(makeData(), '7d');
        const legend = card.querySelector('.wg-health-legend');
        expect(legend).not.toBeNull();
        const items = legend.querySelectorAll('.wg-health-legend__item');
        expect(items.length).toBe(5);

        const variants = Array.from(legend.querySelectorAll('.wg-health-legend__badge'))
            .map((b) => {
                const variantClass = Array.from(b.classList)
                    .find((c) => c.startsWith('wg-health-legend__badge--') && c !== 'wg-health-legend__badge--line');
                return variantClass ? variantClass.replace('wg-health-legend__badge--', '') : null;
            });
        expect(variants).toEqual(['deep', 'light', 'rem', 'awake', 'hr']);
    });

    it('marks the HR legend swatch with the --line modifier', () => {
        const { window } = env;
        const card = window.renderSleepCard(makeData(), '7d');
        const hrBadge = card.querySelector('.wg-health-legend__badge--hr');
        expect(hrBadge).not.toBeNull();
        expect(hrBadge.classList.contains('wg-health-legend__badge--line')).toBe(true);
    });

    it('uses no inline style on legend swatches (colour resolves via CSS)', () => {
        const { window } = env;
        const card = window.renderSleepCard(makeData(), '7d');
        const badges = card.querySelectorAll('.wg-health-legend__badge');
        expect(badges.length).toBe(5);
        badges.forEach((b) => {
            expect(b.getAttribute('style')).toBeNull();
        });
    });

    it('renders a section-label averages line with 7d + 30d figures', () => {
        const { window } = env;
        const card = window.renderSleepCard(makeData({
            average_sleep_hours_7d: 7.2,
            average_sleep_hours_30d: 6.9,
        }), '7d');
        const stat = card.querySelector('.wg-sleep-card__stat');
        expect(stat).not.toBeNull();
        expect(stat.classList.contains('wg-section-label')).toBe(true);
        expect(stat.textContent).toContain('7.2 hrs (7d avg)');
        expect(stat.textContent).toContain('6.9 hrs (30d avg)');
    });

    it('renders the empty-state card when sleep_stats_7d is missing', () => {
        const { window } = env;
        const card = window.renderSleepCard(makeData({ sleep_stats_7d: [] }), '7d');
        expect(card.classList.contains('wg-sleep-card')).toBe(true);
        const empty = card.querySelector('.wg-sleep-chart--empty');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toMatch(/no sleep data yet/i);
        // No legend / stat row when empty.
        expect(card.querySelector('.wg-health-legend')).toBeNull();
        expect(card.querySelector('.wg-sleep-card__stat')).toBeNull();
    });

    it('accepts missing data gracefully and still returns a card', () => {
        const { window } = env;
        const card = window.renderSleepCard({}, '7d');
        expect(card.classList.contains('wg-sleep-card')).toBe(true);
        expect(card.querySelector('.wg-sleep-chart--empty')).not.toBeNull();
    });

    it('falls back to 7d range when the arg is invalid', () => {
        const { window } = env;
        const card = window.renderSleepCard(makeData(), 'bogus');
        expect(card.getAttribute('data-range')).toBe('7d');
    });

    it('renderHealthOverviewContent mounts the sleep card after the range selector', () => {
        const { document, window } = env;
        const content = document.getElementById('health-overview-content');
        window.renderHealthOverviewContent(content, makeData());
        const card = content.querySelector('.wg-sleep-card');
        expect(card).not.toBeNull();
        // Order: summary tiles → range selector → sleep card.
        const selector = content.querySelector('.wg-health-range-selector');
        expect(selector).not.toBeNull();
        const selectorIdx = Array.from(content.children).indexOf(selector);
        const cardIdx = Array.from(content.children).indexOf(card);
        expect(cardIdx).toBeGreaterThan(selectorIdx);
    });
});
