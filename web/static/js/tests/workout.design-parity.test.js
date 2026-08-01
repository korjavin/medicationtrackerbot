// Round-2, Task 6 — Workouts design-parity tests.
//
// Pins the four invariants the round-2 parity pass introduced on the
// Workouts screen (user findings #15, #16, #17, #18):
//
//   1. #workouts-view opts into the shared .wg-screen-stage backdrop so
//      the view sits directly on the deep-teal palette.
//   2. The ad-hoc Start affordance is the leftmost action of the
//      next-workout card (med-2fc) — it has no static markup at all, so
//      it can never come back as a hero block or a floating strip.
//   3. The Add exercise affordance is the top-right `.wg-workouts-exercises-
//      header__add` pill, not a sticky bottom CTA.
//   4. The workouts group / exercise / variant / miband modals all carry
//      `.wg-modal` so the shared teal-gloss shell (rather than the legacy
//      paper-white `#workout-*-modal` background block) paints their chrome.
//   5. The Stats tab chart emits numeric y-axis + date x-axis tick labels
//      and a series legend chip so the SVG is readable on its own.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function populatedStats({ weeks = 8 } = {}) {
    const anchor = Date.now() - 5000;
    const weekMs = 7 * 86400000;
    const weekly_activity = [];
    for (let i = weeks - 1; i >= 0; i--) {
        const ts = new Date(anchor - i * weekMs).toISOString();
        weekly_activity.push({ week: ts, completed: 2 + (i % 3), skipped: 0 });
    }
    return {
        active_weeks: 5,
        total_sessions: 20,
        completed_sessions: 17,
        skipped_sessions: 3,
        completion_rate: 85,
        top_exercises: [],
        weekly_activity,
        // The axes + legend live on the Load view's chart since med-zte swapped
        // Consistency's line for a calendar grid, so the fixture has to carry
        // the load aggregates that view reads.
        totals: { volume_kg: 12500, hard_sets: 42, reps: 310, pr_count: 3 },
        weekly_volume: weekly_activity.map((w, i) => ({
            week: w.week, volume_kg: 900 + i * 100, hard_sets: 4 + i, reps: 30 + i,
        })),
    };
}

describe('Workouts round-2 design parity', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ withWorkout: true });
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    describe('screen stage + background', () => {
        it('#workouts-view carries the .wg-screen-stage class so the view sits on the teal palette', () => {
            const { document } = env;
            const view = document.getElementById('workouts-view');
            expect(view).not.toBeNull();
            expect(view.classList.contains('wg-screen-stage')).toBe(true);
        });
    });

    describe('Start button placement', () => {
        // med-2fc: the ad-hoc Start CTA left the document entirely. It used to
        // be a subtabs-row pill, then (med-3dk) its own `.wg-workouts-history-
        // header` strip floating above the UPCOMING pane — two "start"
        // affordances on one screen. It is now the leftmost action of the
        // next-workout card's own action row, rendered by `_renderNextWorkout`.
        it('no static ad-hoc Start markup survives in the document (no #start-adhoc-workout-btn, no history-header strip)', () => {
            const { document } = env;
            expect(document.getElementById('start-adhoc-workout-btn')).toBeNull();
            expect(document.querySelector('.wg-workouts-history-header')).toBeNull();
            expect(document.querySelector('.wg-workouts-history-header__add')).toBeNull();

            // The subtabs row still holds only the pill track.
            const subtabsRow = document.getElementById('workouts-subtabs');
            expect(subtabsRow.querySelectorAll('button').length).toBe(4);

            // No hero block on this screen at all.
            expect(document.querySelector('.wg-title-hero')).toBeNull();
        });

        it('Start AdHoc is the leftmost action of the next-workout card, secondary to Start Scheduled', () => {
            const { window, document } = env;
            const container = document.getElementById('next-workout-card');
            window._renderNextWorkout(container, {
                session: {
                    id: 42, status: 'notified', scheduled_date: '2026-04-24',
                    scheduled_time: '09:00', is_today: true
                },
                group_name: 'Morning 2',
                variant_name: 'Carry & Core',
                exercises_count: 2,
                variant_id: 7,
                group_id: 3,
                is_rotating: false
            });

            const actions = container.querySelectorAll(
                '.wg-workouts-next-card__actions > .wg-toolbar-btn'
            );
            const labels = Array.from(actions).map(
                (btn) => btn.querySelector('.wg-toolbar-btn__label').textContent
            );
            expect(labels).toEqual(['Start AdHoc', 'Start Scheduled', 'Skip']);

            // Ad-hoc is the secondary variant so the scheduled start stays the
            // visual primary.
            expect(actions[0].classList.contains('wg-toolbar-btn--secondary')).toBe(true);
            expect(actions[1].classList.contains('wg-toolbar-btn--primary')).toBe(true);
        });
    });

    describe('Add Exercise button placement', () => {
        it('Add exercise pill lives in the top-right of the Exercises tab header', () => {
            const { document } = env;
            const tab = document.getElementById('workout-exercises-tab');
            expect(tab).not.toBeNull();

            const header = tab.querySelector('.wg-workouts-exercises-header');
            expect(header).not.toBeNull();

            const cta = document.getElementById('add-exercise-library-btn');
            expect(cta).not.toBeNull();
            expect(cta.parentElement).toBe(header);
            expect(cta.classList.contains('wg-gloss')).toBe(true);
            expect(cta.classList.contains('wg-gloss--sun')).toBe(true);
            expect(cta.classList.contains('wg-workouts-exercises-header__add')).toBe(true);
        });

        it('No bottom-dock .wg-workouts-exercises__add-cta remains in the DOM', () => {
            const { document } = env;
            expect(document.querySelector('.wg-workouts-exercises__add-cta')).toBeNull();
            expect(document.querySelector('.wg-workouts-exercises__add-cta-label')).toBeNull();
        });

        it('Exercises tab header sits ABOVE the library list in DOM order', () => {
            const { document, window } = env;
            const tab = document.getElementById('workout-exercises-tab');
            const header = tab.querySelector('.wg-workouts-exercises-header');
            const list = document.getElementById('exercise-library-list');
            expect(header).not.toBeNull();
            expect(list).not.toBeNull();
            expect(
                header.compareDocumentPosition(list) & window.Node.DOCUMENT_POSITION_FOLLOWING,
            ).toBeTruthy();
        });
    });

    describe('modal shell migration', () => {
        it('#workout-group-modal uses the .wg-modal shell', () => {
            const { document } = env;
            const modal = document.getElementById('workout-group-modal');
            expect(modal).not.toBeNull();
            expect(modal.classList.contains('wg-modal')).toBe(true);
            expect(modal.classList.contains('wg-workouts-group-modal')).toBe(true);
        });

        it('#workout-exercise-modal uses the .wg-modal shell', () => {
            const { document } = env;
            const modal = document.getElementById('workout-exercise-modal');
            expect(modal).not.toBeNull();
            expect(modal.classList.contains('wg-modal')).toBe(true);
            expect(modal.classList.contains('wg-workouts-exercise-modal')).toBe(true);
        });

        it('#miband-workout-modal uses the .wg-modal shell with the shared form-modal chrome', () => {
            const { document } = env;
            const modal = document.getElementById('miband-workout-modal');
            expect(modal).not.toBeNull();
            expect(modal.classList.contains('wg-modal')).toBe(true);
            expect(modal.classList.contains('wg-workouts-miband-modal')).toBe(true);

            // Same eyebrow + mono-display title as the exercise-library modal
            // it was restyled from (med-bzv).
            const eyebrow = modal.querySelector('.wg-workouts-miband-modal__eyebrow');
            expect(eyebrow).not.toBeNull();
            expect(eyebrow.classList.contains('wg-section-label')).toBe(true);
            expect(eyebrow.textContent).toBe('Cardio');
            const title = modal.querySelector('.wg-workouts-miband-modal__title');
            expect(title).not.toBeNull();
            expect(title.classList.contains('wg-mono-display')).toBe(true);
            expect(title.id).toBe('miband-workout-modal-title');

            // All six numeric inputs sit in .wg-gloss--inset wraps, paired into
            // __row groups — no legacy .form-row / bare <input> left.
            const wraps = modal.querySelectorAll('.wg-workouts-miband-modal__input-wrap');
            expect(wraps.length).toBe(6);
            wraps.forEach((wrap) => {
                expect(wrap.classList.contains('wg-gloss--inset')).toBe(true);
                expect(wrap.querySelector('.wg-workouts-miband-modal__input')).not.toBeNull();
            });
            expect(modal.querySelectorAll('.wg-workouts-miband-modal__row').length).toBe(3);
            expect(modal.querySelector('.form-row')).toBeNull();
            expect(modal.querySelector('.modal-header')).toBeNull();

            // Save pill is sun-glossed; Cancel is a plain gloss; Delete is gone.
            const cancel = document.getElementById('miband-workout-cancel-btn');
            const save = document.getElementById('miband-workout-save-btn');
            expect(cancel.classList.contains('wg-gloss')).toBe(true);
            expect(cancel.classList.contains('wg-gloss--sun')).toBe(false);
            expect(save.classList.contains('wg-gloss')).toBe(true);
            expect(save.classList.contains('wg-gloss--sun')).toBe(true);
            expect(document.getElementById('miband-workout-delete-btn')).toBeNull();
        });

        it('#workout-variant-modal uses the .wg-modal shell with .wg-workouts-variant-modal variant classes', () => {
            const { document } = env;
            const modal = document.getElementById('workout-variant-modal');
            expect(modal).not.toBeNull();
            expect(modal.classList.contains('wg-modal')).toBe(true);
            expect(modal.classList.contains('wg-workouts-variant-modal')).toBe(true);

            // Eyebrow + mono-display title — matches the group/exercise
            // modals migrated earlier in Phase 7.
            const eyebrow = modal.querySelector('.wg-workouts-variant-modal__eyebrow');
            const title = modal.querySelector('.wg-workouts-variant-modal__title');
            expect(eyebrow).not.toBeNull();
            expect(eyebrow.classList.contains('wg-section-label')).toBe(true);
            expect(title).not.toBeNull();
            expect(title.classList.contains('wg-mono-display')).toBe(true);
            expect(title.id).toBe('workout-variant-modal-title');

            // Name + Description inputs live inside .wg-gloss--inset wraps.
            const wraps = modal.querySelectorAll('.wg-workouts-variant-modal__input-wrap');
            expect(wraps.length).toBeGreaterThanOrEqual(2);
            wraps.forEach((wrap) => {
                expect(wrap.classList.contains('wg-gloss--inset')).toBe(true);
            });

            // Save pill is sun-glossed; Cancel is a plain gloss.
            const cancel = document.getElementById('variant-cancel-btn');
            const save = document.getElementById('variant-save-btn');
            expect(cancel).not.toBeNull();
            expect(cancel.classList.contains('wg-gloss')).toBe(true);
            expect(cancel.classList.contains('wg-gloss--sun')).toBe(false);
            expect(save).not.toBeNull();
            expect(save.classList.contains('wg-gloss')).toBe(true);
            expect(save.classList.contains('wg-gloss--sun')).toBe(true);

            // Legacy paper-era classes must not linger on the variant modal.
            const modalHtml = modal.outerHTML;
            expect(modalHtml).not.toMatch(/\bbtn-primary\b/);
            expect(modalHtml).not.toMatch(/\bbtn-secondary\b/);
            expect(modalHtml).not.toMatch(/\bmodal-header\b/);
            expect(modalHtml).not.toMatch(/\bform-row\b/);
        });
    });

    describe('Stats chart axes + legend', () => {
        // med-zte moved the chart out of Consistency (now a calendar grid) and
        // into Load, where weekly tonnage renders as bars. The axis + legend
        // parity rules are unchanged, they just live one pill over.
        beforeEach(() => {
            env.window.WorkoutStats.setView('load');
        });

        it('chart SVG carries y-axis numeric tick labels', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window._renderWorkoutStats(container, populatedStats());

            const svg = container.querySelector('svg.wg-workout-chart');
            expect(svg).not.toBeNull();

            const yTicks = svg.querySelectorAll(
                'text.wg-workout-chart__axis-tick[data-workout-axis="y"]',
            );
            expect(yTicks.length).toBeGreaterThanOrEqual(2);
            yTicks.forEach((t) => {
                expect(t.textContent.trim().length).toBeGreaterThan(0);
                expect(Number.isFinite(Number(t.textContent))).toBe(true);
            });
        });

        it('chart SVG carries x-axis date tick labels', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window._renderWorkoutStats(container, populatedStats());

            const svg = container.querySelector('svg.wg-workout-chart');
            expect(svg).not.toBeNull();

            const xTicks = svg.querySelectorAll(
                'text.wg-workout-chart__axis-tick[data-workout-axis="x"]',
            );
            expect(xTicks.length).toBeGreaterThanOrEqual(2);
            xTicks.forEach((t) => {
                expect(t.textContent.trim().length).toBeGreaterThan(0);
            });
        });

        it('renders a legend chip below the chart documenting the series', () => {
            const { document, window } = env;
            const container = document.getElementById('workout-stats-display');
            window._renderWorkoutStats(container, populatedStats());

            const legend = container.querySelector('.wg-workouts-stats__legend');
            expect(legend).not.toBeNull();

            const chips = legend.querySelectorAll('.wg-workouts-stats__legend-chip');
            expect(chips.length).toBeGreaterThanOrEqual(1);
            const firstChip = chips[0];
            expect(
                firstChip.querySelector('.wg-workouts-stats__legend-swatch'),
            ).not.toBeNull();
            expect(firstChip.textContent.trim().length).toBeGreaterThan(0);

            // The chart panel must still appear ABOVE the legend in DOM
            // order so readers see the line before the label.
            const chartPanel = container.querySelector('.wg-workouts-stats__chart-panel');
            expect(chartPanel).not.toBeNull();
            expect(
                chartPanel.compareDocumentPosition(legend) & window.Node.DOCUMENT_POSITION_FOLLOWING,
            ).toBeTruthy();
        });
    });
});
