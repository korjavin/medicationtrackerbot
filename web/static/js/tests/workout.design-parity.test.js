// Round-2, Task 6 — Workouts design-parity tests.
//
// Pins the four invariants the round-2 parity pass introduced on the
// Workouts screen (user findings #15, #16, #17, #18):
//
//   1. #workouts-view opts into the shared .wg-screen-stage backdrop so
//      the view sits directly on the deep-teal palette.
//   2. The Start button is an inline sun-gloss pill on the subtab row —
//      never inside a `.wg-title-hero`, never full-width.
//   3. The Add exercise affordance is the top-right `.wg-workouts-exercises-
//      header__add` pill, not a sticky bottom CTA.
//   4. The workouts group / exercise / variant modals all carry `.wg-modal`
//      so the shared teal-gloss shell (rather than the legacy paper-white
//      `#workout-*-modal` background block) paints their chrome.
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
        it('Start button is an inline sun-gloss pill inside the subtabs row — not inside a .wg-title-hero', () => {
            const { document } = env;
            const startBtn = document.getElementById('start-adhoc-workout-btn');
            expect(startBtn).not.toBeNull();
            expect(startBtn.classList.contains('wg-gloss')).toBe(true);
            expect(startBtn.classList.contains('wg-gloss--sun')).toBe(true);
            expect(startBtn.classList.contains('wg-workouts-subtabs-row__add')).toBe(true);

            // Lives inside the subtabs flex row, next to the Tab strip.
            const row = document.getElementById('workouts-subtabs');
            expect(row).not.toBeNull();
            expect(row.contains(startBtn)).toBe(true);
            expect(row.classList.contains('wg-workouts-subtabs-row')).toBe(true);

            // Must NOT live inside any `.wg-title-hero` / hero block.
            expect(startBtn.closest('.wg-title-hero')).toBeNull();
            expect(document.querySelector('.wg-title-hero')).toBeNull();
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
