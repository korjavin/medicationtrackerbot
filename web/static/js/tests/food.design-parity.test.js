// Round-2, Task 3 — Food design-parity tests.
//
// Pins the three invariants the round-2 parity pass introduced on the
// Food screen (user findings #6, #7):
//
//   1. The trailing sticky `#food-add-cta-dock` is removed from index.html
//      and never remounted by `_renderFoodData` / `loadFoodLogs`.
//   2. The only Add-food affordance is `#add-food-inline-btn` inside the
//      day-nav header — it sits in the same flex row as the chevrons and
//      day label, matching `.local/design-reference/project/screens.jsx`
//      FoodScreen.
//   3. The macros card still mounts directly under the day-nav header and
//      is unaffected by the CTA removal.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('Food round-2 design parity', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    describe('CTA dock removal', () => {
        it('index.html does NOT mount #food-add-cta-dock inside #food-view', () => {
            const { document } = env;
            const view = document.getElementById('food-view');
            expect(view).not.toBeNull();
            expect(view.querySelector('#food-add-cta-dock')).toBeNull();
            expect(document.getElementById('food-add-cta-dock')).toBeNull();
            expect(document.querySelector('.wg-food-cta-dock')).toBeNull();
        });

        it('_renderFoodData does not synthesize a second Add-food button', () => {
            const { document, window } = env;
            const groups = [{
                name: 'Breakfast',
                time: '08:00',
                calories: 300,
                carbs: 40,
                protein: 15,
                fat: 8,
                logs: [{
                    id: 1,
                    name: 'Oatmeal',
                    weight: 200,
                    calories: 300,
                    carbs: 40,
                    protein: 15,
                    fat: 8,
                    eaten_at: '2026-04-20T08:00:00Z',
                }],
            }];
            window._renderFoodData(groups, null, 'day', '2026-04-20');

            // The only Add-food button in the DOM must be the header inline
            // pill — no `.wg-food-add-cta` inside `#food-list`, no second
            // `#add-food-btn`, nothing duplicated in `#food-log-tab`.
            expect(document.querySelectorAll('.wg-food-add-cta')).toHaveLength(0);
            expect(document.querySelectorAll('#add-food-btn')).toHaveLength(0);

            const addButtons = document.querySelectorAll('#food-view [id^="add-food"]');
            expect(addButtons).toHaveLength(1);
            expect(addButtons[0].id).toBe('add-food-inline-btn');
        });
    });

    describe('header inline +Add placement', () => {
        it('#add-food-inline-btn lives inside the same .wg-food-day-nav row as the chevrons and date label', () => {
            const { document } = env;
            const nav = document.querySelector('#food-view .wg-food-day-nav');
            expect(nav).not.toBeNull();
            // The day-nav must opt into the trailing-action grid template
            // (`--with-action` widens the grid to a 4th `auto` column).
            expect(nav.classList.contains('wg-food-day-nav--with-action')).toBe(true);

            const inline = document.getElementById('add-food-inline-btn');
            expect(inline).not.toBeNull();
            expect(inline.parentElement).toBe(nav);

            // The chevrons and the date-label center must be siblings of
            // the inline button — no wrap into a second row.
            const prev = nav.querySelector('#food-date-prev-btn');
            const next = nav.querySelector('#food-date-next-btn');
            const center = nav.querySelector('.wg-food-day-nav__center');
            expect(prev.parentElement).toBe(nav);
            expect(next.parentElement).toBe(nav);
            expect(center.parentElement).toBe(nav);
        });

        it('inline pill carries the shared .wg-toolbar-btn primary sizing and a visible "Add" label', () => {
            // Round-2 Task 6 (defect #9): button migrated from the per-section
            // `.wg-food-day-nav__add` one-off onto the shared
            // `.wg-toolbar-btn .wg-toolbar-btn--primary` sizing (sun-gloss
            // fill is provided by the --primary variant, not by .wg-gloss).
            const { document } = env;
            const inline = document.getElementById('add-food-inline-btn');
            expect(inline).not.toBeNull();
            expect(inline.classList.contains('wg-toolbar-btn')).toBe(true);
            expect(inline.classList.contains('wg-toolbar-btn--primary')).toBe(true);
            expect(inline.classList.contains('wg-food-day-nav__add')).toBe(false);
            expect(inline.textContent).toContain('Add');
        });
    });

    describe('macros card still sits below the header', () => {
        it('#food-macros-card is a descendant of #food-log-tab, below the day-nav', () => {
            const { document, window } = env;
            const macros = document.getElementById('food-macros-card');
            const tab = document.getElementById('food-log-tab');
            expect(macros).not.toBeNull();
            expect(tab.contains(macros)).toBe(true);

            const nav = document.querySelector('#food-view .wg-food-day-nav');
            // DOM order: the nav must appear before the macros card.
            expect(
                nav.compareDocumentPosition(macros) & window.Node.DOCUMENT_POSITION_FOLLOWING
            ).toBeTruthy();
        });
    });
});
