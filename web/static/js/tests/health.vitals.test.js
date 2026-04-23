// Wandergeek Health vitals-card wiring (Phase 8, Task 6).
//
// Asserts:
//   • renderVitalCard mounts a .wg-card + .wg-vitals-card + vital-modifier
//     shell with a mono header ("Heart Rate" / "SpO2" / "Stress Level"),
//     a WGVitalsChart SVG, and a section-label averages line showing
//     7d + 30d figures with the vital-specific unit.
//   • The root shell carries the correct modifier class (.wg-vitals-card--hr
//     / --spo2 / --stress) so CSS can key the colour from the matching
//     --wg-health-vitals-*-line token.
//   • Empty state: missing history renders a muted "No <vital> data yet"
//     card under the same header shell.
//   • renderHealthOverviewContent wires the three vitals cards into the
//     overview stream after the steps card, in hr → spo2 → stress order.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function makeHistory({ points = 5, avg = 70 } = {}) {
    const anchor = Date.now() - 5000;
    const step = 2 * 60 * 60 * 1000;
    const out = [];
    for (let i = points - 1; i >= 0; i--) {
        out.push({
            timestamp: anchor - i * step,
            min: avg - 10,
            max: avg + 10,
            avg: avg + (points - i),
        });
    }
    return out;
}

function makeData(overrides) {
    const base = {
        sleep_stats_7d: [],
        sleep_stats_30d: [],
        average_sleep_hours_7d: 0,
        average_sleep_hours_30d: 0,
        step_stats_7d: [],
        step_stats_30d: [],
        average_steps_7d: 0,
        average_steps_30d: 0,
        heart_rate_history_7d: makeHistory({ points: 5, avg: 70 }),
        heart_rate_history_30d: makeHistory({ points: 5, avg: 70 }),
        average_heart_rate_7d: 71,
        average_heart_rate_30d: 73,
        spo2_history_7d: makeHistory({ points: 5, avg: 97 }),
        spo2_history_30d: makeHistory({ points: 5, avg: 97 }),
        average_spo2_7d: 97,
        average_spo2_30d: 96,
        stress_history_7d: makeHistory({ points: 5, avg: 40 }),
        stress_history_30d: makeHistory({ points: 5, avg: 40 }),
        average_stress_7d: 41,
        average_stress_30d: 45,
    };
    return Object.assign({}, base, overrides || {});
}

describe('Health vitals cards (Phase 8, Task 6)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renderVitalCard returns a .wg-card + .wg-vitals-card shell with mono header (hr)', () => {
        const { window } = env;
        const card = window.renderVitalCard('hr', makeData(), '7d');
        expect(card.classList.contains('wg-card')).toBe(true);
        expect(card.classList.contains('wg-vitals-card')).toBe(true);
        expect(card.classList.contains('wg-vitals-card--hr')).toBe(true);
        expect(card.getAttribute('data-vital')).toBe('hr');
        expect(card.getAttribute('data-range')).toBe('7d');
        const header = card.querySelector('.wg-vitals-card__header');
        expect(header).not.toBeNull();
        expect(header.classList.contains('wg-mono-display')).toBe(true);
        expect(header.textContent).toBe('Heart Rate');
    });

    it('uses the SpO2 title + modifier when vital is spo2', () => {
        const { window } = env;
        const card = window.renderVitalCard('spo2', makeData(), '7d');
        expect(card.classList.contains('wg-vitals-card--spo2')).toBe(true);
        expect(card.querySelector('.wg-vitals-card__header').textContent).toBe('SpO2');
    });

    it('uses the Stress Level title + modifier when vital is stress', () => {
        const { window } = env;
        const card = window.renderVitalCard('stress', makeData(), '7d');
        expect(card.classList.contains('wg-vitals-card--stress')).toBe(true);
        expect(card.querySelector('.wg-vitals-card__header').textContent).toBe('Stress Level');
    });

    it('mounts a WGVitalsChart SVG inside the card with matching vital modifier', () => {
        const { window } = env;
        const card = window.renderVitalCard('hr', makeData(), '7d');
        const svg = card.querySelector('svg.wg-vitals-chart');
        expect(svg).not.toBeNull();
        expect(svg.classList.contains('wg-vitals-chart--hr')).toBe(true);
        expect(svg.dataset.vitalsVital).toBe('hr');
    });

    it('passes the active range into the chart dataset', () => {
        const { window } = env;
        const card = window.renderVitalCard('spo2', makeData(), '30d');
        const svg = card.querySelector('svg.wg-vitals-chart');
        expect(svg.dataset.vitalsRange).toBe('30d');
    });

    it('renders a section-label averages line with 7d + 30d figures (hr)', () => {
        const { window } = env;
        const card = window.renderVitalCard('hr', makeData({
            average_heart_rate_7d: 71,
            average_heart_rate_30d: 74,
        }), '7d');
        const stat = card.querySelector('.wg-vitals-card__stat');
        expect(stat).not.toBeNull();
        expect(stat.classList.contains('wg-section-label')).toBe(true);
        expect(stat.textContent).toContain('71 bpm (7d avg)');
        expect(stat.textContent).toContain('74 bpm (30d avg)');
    });

    it('renders the averages line with % unit for SpO2', () => {
        const { window } = env;
        const card = window.renderVitalCard('spo2', makeData({
            average_spo2_7d: 97,
            average_spo2_30d: 96,
        }), '7d');
        const stat = card.querySelector('.wg-vitals-card__stat');
        expect(stat.textContent).toContain('97 % (7d avg)');
        expect(stat.textContent).toContain('96 % (30d avg)');
    });

    it('renders the averages line with /100 unit for Stress', () => {
        const { window } = env;
        const card = window.renderVitalCard('stress', makeData({
            average_stress_7d: 41,
            average_stress_30d: 45,
        }), '7d');
        const stat = card.querySelector('.wg-vitals-card__stat');
        expect(stat.textContent).toContain('41 / 100 (7d avg)');
        expect(stat.textContent).toContain('45 / 100 (30d avg)');
    });

    it('renders the empty-state card when vital history is missing (hr)', () => {
        const { window } = env;
        const card = window.renderVitalCard('hr', makeData({ heart_rate_history_7d: [] }), '7d');
        expect(card.classList.contains('wg-vitals-card--hr')).toBe(true);
        const empty = card.querySelector('.wg-vitals-chart--empty');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toMatch(/no heart rate data yet/i);
        expect(card.querySelector('.wg-vitals-card__stat')).toBeNull();
    });

    it('renders the empty-state card when vital history is missing (spo2)', () => {
        const { window } = env;
        const card = window.renderVitalCard('spo2', makeData({ spo2_history_7d: [] }), '7d');
        const empty = card.querySelector('.wg-vitals-chart--empty');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toMatch(/no spo2 data yet/i);
    });

    it('renders the empty-state card when vital history is missing (stress)', () => {
        const { window } = env;
        const card = window.renderVitalCard('stress', makeData({ stress_history_7d: [] }), '7d');
        const empty = card.querySelector('.wg-vitals-chart--empty');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toMatch(/no stress data yet/i);
    });

    it('accepts missing data gracefully and still returns a card', () => {
        const { window } = env;
        const card = window.renderVitalCard('hr', {}, '7d');
        expect(card.classList.contains('wg-vitals-card')).toBe(true);
        expect(card.querySelector('.wg-vitals-chart--empty')).not.toBeNull();
    });

    it('falls back to 7d range when the arg is invalid', () => {
        const { window } = env;
        const card = window.renderVitalCard('hr', makeData(), 'bogus');
        expect(card.getAttribute('data-range')).toBe('7d');
    });

    it('returns null when an unknown vital is requested', () => {
        const { window } = env;
        const card = window.renderVitalCard('bogus', makeData(), '7d');
        expect(card).toBeNull();
    });

    it('renderHealthOverviewContent mounts three vitals cards after the steps card', () => {
        const { document, window } = env;
        const content = document.getElementById('health-overview-content');
        window.renderHealthOverviewContent(content, makeData());
        const stepsCard = content.querySelector('.wg-steps-card');
        const vitalCards = content.querySelectorAll('.wg-vitals-card');
        expect(stepsCard).not.toBeNull();
        expect(vitalCards.length).toBe(3);
        const stepsIdx = Array.from(content.children).indexOf(stepsCard);
        const firstVitalsIdx = Array.from(content.children).indexOf(vitalCards[0]);
        expect(firstVitalsIdx).toBeGreaterThan(stepsIdx);
    });

    it('vitals cards render in hr → spo2 → stress order', () => {
        const { document, window } = env;
        const content = document.getElementById('health-overview-content');
        window.renderHealthOverviewContent(content, makeData());
        const vitalCards = Array.from(content.querySelectorAll('.wg-vitals-card'));
        expect(vitalCards.map((c) => c.getAttribute('data-vital'))).toEqual(['hr', 'spo2', 'stress']);
    });

    it('renderHealthOverviewContent mounts the data-source disclaimer after the vitals', () => {
        const { document, window } = env;
        const content = document.getElementById('health-overview-content');
        window.renderHealthOverviewContent(content, makeData());
        const disclaimer = content.querySelector('.wg-health-disclaimer');
        expect(disclaimer).not.toBeNull();
        expect(disclaimer.textContent.toLowerCase()).toContain('.nxk');
        const lastVitals = content.querySelector('.wg-vitals-card--stress');
        const stressIdx = Array.from(content.children).indexOf(lastVitals);
        const disclaimerIdx = Array.from(content.children).indexOf(disclaimer);
        expect(disclaimerIdx).toBeGreaterThan(stressIdx);
    });

    it('formats a dash when the per-vital average is missing (null)', () => {
        const { window } = env;
        const card = window.renderVitalCard('hr', makeData({
            average_heart_rate_7d: null,
            average_heart_rate_30d: null,
        }), '7d');
        const stat = card.querySelector('.wg-vitals-card__stat');
        expect(stat.textContent).toContain('\u2014 bpm (7d avg)');
        expect(stat.textContent).toContain('\u2014 bpm (30d avg)');
    });
});
