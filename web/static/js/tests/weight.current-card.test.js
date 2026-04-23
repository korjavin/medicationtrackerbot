// Wandergeek Weight current + goal cards (Phase 6, Task 3).
//
// Covers the two new render helpers on the Weight screen:
//   • renderWeightCurrentCard(logs, goalData) — .wg-weight-current-card with a
//     mono kilo readout, a small "kg" suffix, a trend tag whose variant flips
//     via goal_direction (lose vs. gain), and an empty state when no logs.
//   • renderWeightGoalCard(logs, goalData) — hidden when no goal; otherwise a
//     .wg-weight-goal-card--inset row with a mono target, a gloss-inset track
//     with a --fill-pct progress width, and a muted "Δ kg to goal" label.
//
// Also exercises classifyWeightTrend directly (pure token-group classifier).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function isoDaysAgo(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString();
}

describe('Weight current + goal cards (Phase 6, Task 3)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    describe('classifyWeightTrend', () => {
        it('flips variant direction based on goal_direction', () => {
            const { window } = env;
            // lose goal: negative delta = good, positive = bad
            expect(window.classifyWeightTrend(-0.4, 'lose')).toBe('good');
            expect(window.classifyWeightTrend(0.4, 'lose')).toBe('bad');
            // gain goal: positive delta = good, negative = bad
            expect(window.classifyWeightTrend(0.4, 'gain')).toBe('good');
            expect(window.classifyWeightTrend(-0.4, 'gain')).toBe('bad');
        });

        it('returns flat for zero delta, missing direction, or non-finite input', () => {
            const { window } = env;
            expect(window.classifyWeightTrend(0, 'lose')).toBe('flat');
            expect(window.classifyWeightTrend(-0.2, null)).toBe('flat');
            expect(window.classifyWeightTrend(-0.2, 'maintain')).toBe('flat');
            expect(window.classifyWeightTrend(NaN, 'lose')).toBe('flat');
            expect(window.classifyWeightTrend(Infinity, 'lose')).toBe('flat');
        });
    });

    describe('renderWeightCurrentCard', () => {
        it('renders an empty-state card when no logs are present', () => {
            const { document, window } = env;
            window.renderWeightCurrentCard([], { goal: 75, goal_direction: 'lose' });
            const card = document.getElementById('weight-current-card');
            expect(card.classList.contains('wg-weight-current-card')).toBe(true);
            expect(card.classList.contains('wg-card')).toBe(true);
            const empty = card.querySelector('.wg-weight-current-card__empty');
            expect(empty).not.toBeNull();
            expect(empty.textContent).toContain('No weight logged yet');
            // No mono display in the empty state.
            expect(card.querySelector('.wg-weight-current-card__value')).toBeNull();
        });

        it('renders the mono kg readout and trend tag with lose goal (decrease = good/sun)', () => {
            const { document, window } = env;
            const logs = [
                { measured_at: isoDaysAgo(0), weight: 80.9 },
                { measured_at: isoDaysAgo(3), weight: 81.5 },
                { measured_at: isoDaysAgo(7), weight: 82.6 }
            ];
            const goal = { goal: 75, goal_direction: 'lose' };
            window.renderWeightCurrentCard(logs, goal);

            const card = document.getElementById('weight-current-card');
            expect(card.classList.contains('wg-weight-current-card')).toBe(true);
            const value = card.querySelector('.wg-weight-current-card__value');
            expect(value.classList.contains('wg-mono-display')).toBe(true);
            expect(value.querySelector('.wg-weight-current-card__weight').textContent).toBe('80.9');
            expect(value.querySelector('.wg-weight-current-card__unit').textContent).toBe('kg');

            const trend = card.querySelector('.wg-weight-trend');
            expect(trend).not.toBeNull();
            expect(trend.classList.contains('wg-weight-trend--good')).toBe(true);
            expect(trend.getAttribute('data-trend-variant')).toBe('good');
            // Arrow for decrease is the down glyph, delta is the minus-prefixed magnitude.
            expect(trend.querySelector('.wg-weight-trend__arrow').textContent).toBe('\u2193');
            expect(trend.querySelector('.wg-weight-trend__delta').textContent).toContain('0.6');
        });

        it('flips variant to bad when a lose goal records an increase', () => {
            const { document, window } = env;
            const logs = [
                { measured_at: isoDaysAgo(0), weight: 82.0 },
                { measured_at: isoDaysAgo(3), weight: 81.4 }
            ];
            window.renderWeightCurrentCard(logs, { goal: 75, goal_direction: 'lose' });
            const trend = document.querySelector('#weight-current-card .wg-weight-trend');
            expect(trend.classList.contains('wg-weight-trend--bad')).toBe(true);
            expect(trend.querySelector('.wg-weight-trend__arrow').textContent).toBe('\u2191');
        });

        it('flips variant direction for a gain goal (increase = good/sun)', () => {
            const { document, window } = env;
            const logs = [
                { measured_at: isoDaysAgo(0), weight: 75.3 },
                { measured_at: isoDaysAgo(3), weight: 74.8 }
            ];
            window.renderWeightCurrentCard(logs, { goal: 80, goal_direction: 'gain' });
            const trend = document.querySelector('#weight-current-card .wg-weight-trend');
            expect(trend.classList.contains('wg-weight-trend--good')).toBe(true);
            expect(trend.querySelector('.wg-weight-trend__arrow').textContent).toBe('\u2191');
        });

        it('colors the trend using the lose-weight default when a goal is set but direction is omitted', () => {
            // Backend weight-goal endpoint does not yet expose goal_direction.
            // The current-card must fall back to 'lose' so legacy users still
            // see their downward trend as good/sun rather than a dishonest flat.
            const { document, window } = env;
            const logs = [
                { measured_at: isoDaysAgo(0), weight: 80.9 },
                { measured_at: isoDaysAgo(3), weight: 81.5 }
            ];
            window.renderWeightCurrentCard(logs, { goal: 75 });
            const trend = document.querySelector('#weight-current-card .wg-weight-trend');
            expect(trend.classList.contains('wg-weight-trend--good')).toBe(true);
            expect(trend.querySelector('.wg-weight-trend__arrow').textContent).toBe('\u2193');
        });

        it('uses flat styling when there is no goal, regardless of direction', () => {
            const { document, window } = env;
            const logs = [
                { measured_at: isoDaysAgo(0), weight: 80.9 },
                { measured_at: isoDaysAgo(3), weight: 81.5 }
            ];
            window.renderWeightCurrentCard(logs, {});
            const trend = document.querySelector('#weight-current-card .wg-weight-trend');
            expect(trend.classList.contains('wg-weight-trend--flat')).toBe(true);
        });

        it('labels the trend as "first entry" when only a single log exists', () => {
            const { document, window } = env;
            window.renderWeightCurrentCard(
                [{ measured_at: isoDaysAgo(0), weight: 80.5 }],
                { goal: 75, goal_direction: 'lose' }
            );
            const trend = document.querySelector('#weight-current-card .wg-weight-trend');
            expect(trend.classList.contains('wg-weight-trend--flat')).toBe(true);
            expect(trend.querySelector('.wg-weight-trend__delta').textContent).toBe('first entry');
            expect(trend.querySelector('.wg-weight-trend__arrow').textContent).toBe('\u2192');
        });

        it('kicker surfaces pending and rejected sync states', () => {
            const { document, window } = env;
            const pending = [
                { measured_at: isoDaysAgo(0), weight: 80.2, isLocal: true }
            ];
            window.renderWeightCurrentCard(pending, {});
            const kickerPending = document.querySelector('#weight-current-card .wg-weight-current-card__kicker');
            expect(kickerPending.textContent).toContain('pending sync');

            const rejected = [
                { measured_at: isoDaysAgo(0), weight: 80.2, isLocal: true, isRejected: true }
            ];
            window.renderWeightCurrentCard(rejected, {});
            const kickerRejected = document.querySelector('#weight-current-card .wg-weight-current-card__kicker');
            expect(kickerRejected.textContent).toContain('sync failed');
        });
    });

    describe('renderWeightGoalCard', () => {
        it('hides the goal card when no goal is set', () => {
            const { document, window } = env;
            window.renderWeightGoalCard([], {});
            const card = document.getElementById('weight-goal-card');
            expect(card.hidden).toBe(true);
            expect(card.querySelector('.wg-weight-goal-card__value')).toBeNull();
        });

        it('renders goal target, progress track, and delta label when a goal is set', () => {
            const { document, window } = env;
            const logs = [
                { measured_at: isoDaysAgo(0), weight: 80.0 },
                { measured_at: isoDaysAgo(7), weight: 82.0 }
            ];
            const goal = {
                goal: 75,
                goal_direction: 'lose',
                highest_weight: 85
            };
            window.renderWeightGoalCard(logs, goal);
            const card = document.getElementById('weight-goal-card');
            expect(card.hidden).toBe(false);
            expect(card.classList.contains('wg-weight-goal-card')).toBe(true);
            expect(card.classList.contains('wg-card--inset')).toBe(true);

            const value = card.querySelector('.wg-weight-goal-card__value');
            expect(value.textContent).toContain('75.0');
            expect(value.textContent).toContain('kg');

            const track = card.querySelector('.wg-weight-goal-card__track');
            expect(track.classList.contains('wg-gloss--inset')).toBe(true);
            const fill = card.querySelector('.wg-weight-goal-card__fill');
            // With highest 85 → goal 75, current 80: done = 5 / total = 10 → 50%.
            expect(fill.style.getPropertyValue('--fill-pct')).toBe('50%');

            const delta = card.querySelector('.wg-weight-goal-card__delta');
            expect(delta.textContent).toContain('5.0 kg to goal');
        });

        it('reports "At goal" when the current weight matches the goal', () => {
            const { document, window } = env;
            const logs = [{ measured_at: isoDaysAgo(0), weight: 75.0 }];
            window.renderWeightGoalCard(logs, { goal: 75, goal_direction: 'lose', highest_weight: 85 });
            const delta = document.querySelector('#weight-goal-card .wg-weight-goal-card__delta');
            expect(delta.textContent).toContain('At goal');
            const fill = document.querySelector('#weight-goal-card .wg-weight-goal-card__fill');
            expect(fill.style.getPropertyValue('--fill-pct')).toBe('100%');
        });

        it('clamps progress to 0%..100% when start anchor is missing', () => {
            const { document, window } = env;
            const logs = [{ measured_at: isoDaysAgo(0), weight: 74.5 }];
            // Already below goal of 75, no highest_weight → fills to 100%.
            window.renderWeightGoalCard(logs, { goal: 75, goal_direction: 'lose' });
            const fill = document.querySelector('#weight-goal-card .wg-weight-goal-card__fill');
            expect(fill.style.getPropertyValue('--fill-pct')).toBe('100%');
        });

        it('renders without inline color/hex styles on track/fill elements', () => {
            const { document, window } = env;
            window.renderWeightGoalCard(
                [{ measured_at: isoDaysAgo(0), weight: 80 }],
                { goal: 75, goal_direction: 'lose', highest_weight: 85 }
            );
            const track = document.querySelector('#weight-goal-card .wg-weight-goal-card__track');
            const fill = document.querySelector('#weight-goal-card .wg-weight-goal-card__fill');
            // The only inline style on fill is the --fill-pct custom property.
            const fillStyle = fill.getAttribute('style') || '';
            expect(fillStyle).toContain('--fill-pct');
            expect(fillStyle).not.toMatch(/#[0-9a-fA-F]{3,}/);
            expect(track.getAttribute('style') || '').not.toMatch(/#[0-9a-fA-F]{3,}/);
        });
    });
});
