// Wandergeek design parity — Round 2, Task 1 (Weight).
//
// Covers the user-reported findings #19 (chart missing goal line, trajectory,
// numbers, trend), #20 (top summary pane), #21 (prognosis "NaN" / trend
// missing), and the modal-shell migration for #weight-modal (#1, #23).
//
// This file intentionally lives alongside the existing Weight test files
// (weight.current-card, weight.history, weight.modal, weight.range) and
// asserts the NEW invariants added by Task 1: a goal-prognosis card that
// is NaN-safe, a chart with labeled y-axis ticks + x-axis dates + a goal
// label + a trend/plan line, and a chart legend bound to the goal.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function isoDaysAgo(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString();
}

describe('Weight design parity — Round 2, Task 1', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    describe('Top summary pane', () => {
        it('does NOT render a #weight-summary-pane element anywhere on the Weight view', () => {
            const { document } = env;
            // The design-parity Round 2 plan calls out the "top summary
            // pane" as a ghost element that never wins over the chart +
            // legend + prognosis layout. We only assert that no rogue
            // element by that id leaks back in — the existing current-
            // card + goal-card pair lives on as the data surface.
            expect(document.getElementById('weight-summary-pane')).toBeNull();
        });
    });

    describe('#weight-modal uses the .wg-modal teal-gloss shell', () => {
        it('#weight-modal carries the .wg-modal class in markup', () => {
            const { document } = env;
            const modal = document.getElementById('weight-modal');
            expect(modal).not.toBeNull();
            expect(modal.classList.contains('wg-modal')).toBe(true);
        });
    });

    describe('renderWeightChart — goal line, axis ticks, x-axis dates, plan + trend', () => {
        it('renders a .wg-weight-chart__goal line when a goal is set', () => {
            const { document, window } = env;
            const logs = [
                { measured_at: isoDaysAgo(7), weight: 82.0 },
                { measured_at: isoDaysAgo(5), weight: 81.4 },
                { measured_at: isoDaysAgo(3), weight: 80.9 },
                { measured_at: isoDaysAgo(1), weight: 80.2 },
            ];
            window.renderWeightChart(logs, { goal: 75 });
            const goal = document.querySelector('#weightChart .wg-weight-chart__goal');
            expect(goal).not.toBeNull();
            expect(goal.tagName.toLowerCase()).toBe('line');
        });

        it('renders numeric y-axis tick labels', () => {
            const { document, window } = env;
            const logs = [
                { measured_at: isoDaysAgo(14), weight: 85.0 },
                { measured_at: isoDaysAgo(10), weight: 84.0 },
                { measured_at: isoDaysAgo(5), weight: 82.0 },
                { measured_at: isoDaysAgo(1), weight: 80.5 },
            ];
            window.renderWeightChart(logs, { goal: 75 });
            const yLabels = document.querySelectorAll(
                '#weightChart .wg-weight-chart__y-tick-label',
            );
            expect(yLabels.length).toBeGreaterThan(0);
            // Every tick label must be a finite-looking number (no "NaN").
            for (const t of yLabels) {
                expect(t.textContent).not.toContain('NaN');
                expect(Number.isFinite(Number(t.textContent))).toBe(true);
            }
        });

        it('renders x-axis date ticks at the first and last data points', () => {
            const { document, window } = env;
            const logs = [
                { measured_at: isoDaysAgo(14), weight: 85.0 },
                { measured_at: isoDaysAgo(1), weight: 80.5 },
            ];
            window.renderWeightChart(logs, { goal: 75 });
            const xLabels = document.querySelectorAll(
                '#weightChart .wg-weight-chart__x-tick-label',
            );
            expect(xLabels.length).toBeGreaterThanOrEqual(2);
        });

        it('renders a GOAL label near the goal line', () => {
            const { document, window } = env;
            const logs = [
                { measured_at: isoDaysAgo(7), weight: 82.0 },
                { measured_at: isoDaysAgo(1), weight: 80.2 },
            ];
            window.renderWeightChart(logs, { goal: 75 });
            const label = document.querySelector('#weightChart .wg-weight-chart__goal-label');
            expect(label).not.toBeNull();
            expect(label.textContent).toContain('GOAL');
            expect(label.textContent).toContain('75');
            expect(label.textContent).not.toContain('NaN');
        });

        it('renders a plan trajectory line when a goal and data are present', () => {
            const { document, window } = env;
            const logs = [
                { measured_at: isoDaysAgo(14), weight: 85.0 },
                { measured_at: isoDaysAgo(10), weight: 84.0 },
                { measured_at: isoDaysAgo(1), weight: 80.5 },
            ];
            window.renderWeightChart(logs, { goal: 75 });
            const plan = document.querySelector('#weightChart .wg-weight-chart__plan');
            expect(plan).not.toBeNull();
        });

        it('renders a trend line (linear regression) when at least 2 points exist', () => {
            const { document, window } = env;
            const logs = [
                { measured_at: isoDaysAgo(14), weight: 85.0 },
                { measured_at: isoDaysAgo(10), weight: 84.0 },
                { measured_at: isoDaysAgo(5), weight: 82.0 },
                { measured_at: isoDaysAgo(1), weight: 80.5 },
            ];
            window.renderWeightChart(logs, { goal: 75 });
            const trend = document.querySelector('#weightChart .wg-weight-chart__trend');
            expect(trend).not.toBeNull();
        });
    });

    describe('renderWeightChartLegend — bound to goal presence', () => {
        it('hides the legend row when no goal is set', () => {
            const { document, window } = env;
            window.renderWeightChartLegend({});
            const legend = document.getElementById('weight-chart-legend');
            expect(legend.hidden).toBe(true);
        });

        it('renders Actual / Plan / Goal items when a goal is set', () => {
            const { document, window } = env;
            window.renderWeightChartLegend({ goal: 75 });
            const legend = document.getElementById('weight-chart-legend');
            expect(legend.hidden).toBe(false);
            const labels = Array.from(
                legend.querySelectorAll('.wg-weight-chart-legend__label'),
            ).map((n) => n.textContent);
            expect(labels[0]).toBe('Actual');
            expect(labels[1]).toBe('Plan');
            expect(labels[2]).toContain('Goal');
            expect(labels[2]).toContain('75');
        });
    });

    describe('renderWeightPrognosisCard — NaN-safe days-to-goal + weekly trend', () => {
        it('hides the card entirely when no goal is set', () => {
            const { document, window } = env;
            window.renderWeightPrognosisCard([], {});
            const card = document.getElementById('weight-prognosis-card');
            expect(card.hidden).toBe(true);
        });

        it('renders a dash for time-to-goal when trend is flat', () => {
            const { document, window } = env;
            const logs = [
                { measured_at: isoDaysAgo(0), weight: 80.0 },
                { measured_at: isoDaysAgo(7), weight: 80.0 },
                { measured_at: isoDaysAgo(14), weight: 80.0 },
            ];
            window.renderWeightPrognosisCard(logs, { goal: 75, goal_direction: 'lose' });
            const card = document.getElementById('weight-prognosis-card');
            expect(card.hidden).toBe(false);
            const value = card.querySelector('.wg-weight-prognosis-card__value');
            expect(value.textContent).toBe('—');
            // The rendered DOM must never contain the literal "NaN".
            expect(card.textContent).not.toContain('NaN');
            expect(card.textContent).not.toContain('Infinity');
        });

        it('renders "in N days" when the trend moves towards the goal', () => {
            const { document, window } = env;
            // Trending down 0.2 kg/day from 80 → goal 75 → 25 days.
            const logs = [
                { measured_at: isoDaysAgo(0), weight: 80.0 },
                { measured_at: isoDaysAgo(5), weight: 81.0 },
                { measured_at: isoDaysAgo(10), weight: 82.0 },
                { measured_at: isoDaysAgo(15), weight: 83.0 },
            ];
            window.renderWeightPrognosisCard(logs, { goal: 75, goal_direction: 'lose' });
            const card = document.getElementById('weight-prognosis-card');
            expect(card.hidden).toBe(false);
            const value = card.querySelector('.wg-weight-prognosis-card__value');
            expect(value.textContent).toMatch(/^in \d+ day/);
            expect(card.textContent).not.toContain('NaN');
        });

        it('renders a dash when the trend points AWAY from the goal', () => {
            const { document, window } = env;
            // Gaining 0.2 kg/day, goal is below current → projection is
            // negative ("never" in finite forward time). Fall back to —.
            const logs = [
                { measured_at: isoDaysAgo(0), weight: 82.0 },
                { measured_at: isoDaysAgo(5), weight: 81.0 },
                { measured_at: isoDaysAgo(10), weight: 80.0 },
                { measured_at: isoDaysAgo(15), weight: 79.0 },
            ];
            window.renderWeightPrognosisCard(logs, { goal: 75, goal_direction: 'lose' });
            const card = document.getElementById('weight-prognosis-card');
            const value = card.querySelector('.wg-weight-prognosis-card__value');
            expect(value.textContent).toBe('—');
            expect(card.textContent).not.toContain('NaN');
        });

        it('renders weekly trend with sign (kg/week) when slope is meaningful', () => {
            const { document, window } = env;
            // Logs arrive newest-first: today=81.4 > 7d ago=80.7 > 14d ago=80.0.
            // Chronologically this means the user is GAINING weight at ~0.1
            // kg/day, which is bad for a lose goal.
            const logs = [
                { measured_at: isoDaysAgo(0), weight: 81.4 },
                { measured_at: isoDaysAgo(7), weight: 80.7 },
                { measured_at: isoDaysAgo(14), weight: 80.0 },
            ];
            window.renderWeightPrognosisCard(logs, { goal: 75, goal_direction: 'lose' });
            const card = document.getElementById('weight-prognosis-card');
            const trendValue = card.querySelector('.wg-weight-prognosis-card__trend-value');
            expect(trendValue.textContent).toMatch(/kg\/week/);
            expect(trendValue.textContent).not.toContain('NaN');
            expect(trendValue.classList.contains('wg-weight-prognosis-card__trend-value--bad')).toBe(true);
        });

        it('falls back to "—" for trend when only a single data point exists', () => {
            const { document, window } = env;
            const logs = [{ measured_at: isoDaysAgo(0), weight: 80.0 }];
            window.renderWeightPrognosisCard(logs, { goal: 75, goal_direction: 'lose' });
            const card = document.getElementById('weight-prognosis-card');
            const trendValue = card.querySelector('.wg-weight-prognosis-card__trend-value');
            expect(trendValue.textContent).toBe('—');
            expect(card.textContent).not.toContain('NaN');
        });

        it('reports "At goal" when the current weight matches the goal', () => {
            const { document, window } = env;
            const logs = [
                { measured_at: isoDaysAgo(0), weight: 75.0 },
                { measured_at: isoDaysAgo(7), weight: 75.2 },
            ];
            window.renderWeightPrognosisCard(logs, { goal: 75, goal_direction: 'lose' });
            const card = document.getElementById('weight-prognosis-card');
            const value = card.querySelector('.wg-weight-prognosis-card__value');
            expect(value.textContent).toBe('At goal');
            expect(card.textContent).not.toContain('NaN');
        });
    });

    describe('computeWeightTrendPerDay — pure helper', () => {
        it('returns null when fewer than 2 points are available', () => {
            const { window } = env;
            expect(window.computeWeightTrendPerDay([], 14)).toBeNull();
            expect(window.computeWeightTrendPerDay([
                { measured_at: isoDaysAgo(0), weight: 80 },
            ], 14)).toBeNull();
        });

        it('returns a negative slope when weight is trending down', () => {
            const { window } = env;
            const logs = [
                { measured_at: isoDaysAgo(0), weight: 78.0 },
                { measured_at: isoDaysAgo(5), weight: 79.0 },
                { measured_at: isoDaysAgo(10), weight: 80.0 },
            ];
            const slope = window.computeWeightTrendPerDay(logs, 14);
            expect(slope).not.toBeNull();
            expect(slope).toBeLessThan(0);
            expect(Number.isFinite(slope)).toBe(true);
        });

        it('returns null when inputs are not finite', () => {
            const { window } = env;
            const slope = window.computeWeightTrendPerDay([
                { measured_at: 'bogus', weight: 80 },
                { measured_at: isoDaysAgo(0), weight: 'x' },
            ], 14);
            expect(slope).toBeNull();
        });
    });
});
