// Wandergeek Health steps-card wiring (Phase 8, Task 5).
//
// Asserts:
//   • renderStepsCard mounts a .wg-card + .wg-steps-card shell with a mono
//     header, a WGStepsChart SVG, and a section-label averages line.
//   • Empty state: missing step_stats_7d data renders a muted
//     "No step data yet" card under the same header shell.
//   • renderHealthOverviewContent wires the steps card into the overview
//     stream after the sleep card.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function makeStepStats(days = 5) {
    const anchor = Date.now() - 5000;
    const dayMs = 86400000;
    const stats = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(anchor - i * dayMs);
        const iso = d.toISOString().slice(0, 10);
        stats.push({ day: iso, steps: 6500 + (days - i) * 200 });
    }
    return stats;
}

function makeData(overrides) {
    const base = {
        sleep_stats_7d: [],
        average_sleep_hours_7d: 0,
        average_sleep_hours_30d: 0,
        step_stats_7d: makeStepStats(5),
        average_steps_7d: 7200,
        average_steps_30d: 6800,
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

describe('Health steps card (Phase 8, Task 5)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renderStepsCard returns a .wg-card + .wg-steps-card shell with mono header', () => {
        const { window } = env;
        const card = window.renderStepsCard(makeData(), '7d');
        expect(card.classList.contains('wg-card')).toBe(true);
        expect(card.classList.contains('wg-steps-card')).toBe(true);
        expect(card.getAttribute('data-range')).toBe('7d');
        const header = card.querySelector('.wg-steps-card__header');
        expect(header).not.toBeNull();
        expect(header.classList.contains('wg-mono-display')).toBe(true);
        expect(header.textContent).toBe('Steps');
    });

    it('mounts a WGStepsChart SVG inside the card with the active range', () => {
        const { window } = env;
        const card = window.renderStepsCard(makeData(), '7d');
        const svg = card.querySelector('svg.wg-steps-chart');
        expect(svg).not.toBeNull();
        expect(svg.dataset.stepsRange).toBe('7d');
        expect(card.querySelectorAll('rect.wg-steps-chart__bar').length).toBeGreaterThan(0);
    });

    it('renders a section-label averages line with 7d + 30d figures', () => {
        const { window } = env;
        const card = window.renderStepsCard(makeData({
            average_steps_7d: 7250,
            average_steps_30d: 6820,
        }), '7d');
        const stat = card.querySelector('.wg-steps-card__stat');
        expect(stat).not.toBeNull();
        expect(stat.classList.contains('wg-section-label')).toBe(true);
        expect(stat.textContent).toContain('7,250 steps (7d avg)');
        expect(stat.textContent).toContain('6,820 steps (30d avg)');
    });

    it('renders the empty-state card when step_stats_7d is missing', () => {
        const { window } = env;
        const card = window.renderStepsCard(makeData({ step_stats_7d: [] }), '7d');
        expect(card.classList.contains('wg-steps-card')).toBe(true);
        const empty = card.querySelector('.wg-steps-chart--empty');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toMatch(/no step data yet/i);
        expect(card.querySelector('.wg-steps-card__stat')).toBeNull();
    });

    it('accepts missing data gracefully and still returns a card', () => {
        const { window } = env;
        const card = window.renderStepsCard({}, '7d');
        expect(card.classList.contains('wg-steps-card')).toBe(true);
        expect(card.querySelector('.wg-steps-chart--empty')).not.toBeNull();
    });

    it('falls back to 7d range when the arg is invalid', () => {
        const { window } = env;
        const card = window.renderStepsCard(makeData(), 'bogus');
        expect(card.getAttribute('data-range')).toBe('7d');
    });

    it('renderHealthOverviewContent mounts the steps card after the sleep card', () => {
        const { document, window } = env;
        const content = document.getElementById('health-overview-content');
        window.renderHealthOverviewContent(content, makeData());
        const sleepCard = content.querySelector('.wg-sleep-card');
        const stepsCard = content.querySelector('.wg-steps-card');
        expect(sleepCard).not.toBeNull();
        expect(stepsCard).not.toBeNull();
        const sleepIdx = Array.from(content.children).indexOf(sleepCard);
        const stepsIdx = Array.from(content.children).indexOf(stepsCard);
        expect(stepsIdx).toBeGreaterThan(sleepIdx);
    });
});
