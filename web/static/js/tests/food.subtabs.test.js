// Wandergeek Food sub-tab strip (Phase 4, Task 3).
//
// Asserts the rewritten sub-tab strip uses the Wandergeek primitives —
// `.wg-gloss--inset` container, `.wg-gloss--sun` active pill — persists the
// active sub-tab via the `mt-food-subtab` localStorage key, and that
// clicking a sub-tab routes through switchFoodTab() to toggle the
// active-state classes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('Food sub-tab strip (Phase 4, Task 3)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
        // Stub async sub-tab loaders so they don't reach into `document` after
        // the JSDOM window is closed in afterEach. Tests in this file only care
        // about the DOM class toggles + persistence, not the data fetch.
        env.window.loadFoodLogs = () => {};
        env.window.loadMyMeals = () => {};
        env.window.loadFoodDB = () => {};
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renders the strip as a .wg-gloss--inset container with three .food-tab buttons', () => {
        const { document } = env;
        const strip = document.querySelector('.wg-food-subtabs');
        expect(strip).not.toBeNull();
        expect(strip.classList.contains('wg-gloss--inset')).toBe(true);

        const buttons = strip.querySelectorAll('.food-tab');
        expect(buttons.length).toBe(3);
        const tabs = Array.from(buttons).map((btn) => btn.dataset.tab);
        expect(tabs).toEqual(['log', 'meals', 'fooddb']);

        buttons.forEach((btn) => {
            expect(btn.classList.contains('wg-gloss')).toBe(true);
            expect(btn.classList.contains('wg-food-subtabs__btn')).toBe(true);
        });
    });

    it('defaults to the "log" sub-tab with .wg-gloss--sun active pill', () => {
        const { document } = env;
        const buttons = document.querySelectorAll('.wg-food-subtabs .food-tab');
        const logBtn = Array.from(buttons).find((b) => b.dataset.tab === 'log');
        const mealsBtn = Array.from(buttons).find((b) => b.dataset.tab === 'meals');

        expect(logBtn.classList.contains('wg-gloss--sun')).toBe(true);
        expect(logBtn.classList.contains('wg-food-subtabs__btn--active')).toBe(true);
        expect(logBtn.getAttribute('aria-pressed')).toBe('true');

        expect(mealsBtn.classList.contains('wg-gloss--sun')).toBe(false);
        expect(mealsBtn.getAttribute('aria-pressed')).toBe('false');
    });

    it('switchFoodTab toggles .wg-gloss--sun across the strip without inline style', () => {
        const { document, window } = env;
        window.switchFoodTab('meals');

        const buttons = document.querySelectorAll('.wg-food-subtabs .food-tab');
        const logBtn = Array.from(buttons).find((b) => b.dataset.tab === 'log');
        const mealsBtn = Array.from(buttons).find((b) => b.dataset.tab === 'meals');

        expect(logBtn.classList.contains('wg-gloss--sun')).toBe(false);
        expect(logBtn.getAttribute('aria-pressed')).toBe('false');
        expect(mealsBtn.classList.contains('wg-gloss--sun')).toBe(true);
        expect(mealsBtn.classList.contains('wg-food-subtabs__btn--active')).toBe(true);
        expect(mealsBtn.getAttribute('aria-pressed')).toBe('true');

        // Make sure no inline style was used to express the active state.
        buttons.forEach((btn) => {
            expect(btn.getAttribute('style')).toBeNull();
        });
    });

    it('getActiveFoodSubTab defaults to "log" when no value is stored', () => {
        const { window } = env;
        window.localStorage.removeItem('mt-food-subtab');
        expect(window.getActiveFoodSubTab()).toBe('log');
    });

    it('setActiveFoodSubTab round-trips valid values through localStorage', () => {
        const { window } = env;
        window.setActiveFoodSubTab('meals');
        expect(window.localStorage.getItem('mt-food-subtab')).toBe('meals');
        expect(window.getActiveFoodSubTab()).toBe('meals');

        window.setActiveFoodSubTab('fooddb');
        expect(window.getActiveFoodSubTab()).toBe('fooddb');
    });

    it('setActiveFoodSubTab ignores invalid values and keeps the previous setting', () => {
        const { window } = env;
        window.setActiveFoodSubTab('meals');
        window.setActiveFoodSubTab('not-a-tab');
        expect(window.getActiveFoodSubTab()).toBe('meals');
    });

    it('switchFoodTab persists the chosen sub-tab to localStorage', () => {
        const { window } = env;
        window.switchFoodTab('fooddb');
        expect(window.localStorage.getItem('mt-food-subtab')).toBe('fooddb');
    });

    it('switchFoodTab hides .food-date-nav on non-log sub-tabs and restores it on log', () => {
        const { document, window } = env;
        const nav = document.querySelector('.food-date-nav');
        expect(nav).not.toBeNull();

        // Default state: 'log' tab is active, day-nav visible.
        expect(nav.classList.contains('hidden')).toBe(false);

        window.switchFoodTab('meals');
        expect(nav.classList.contains('hidden')).toBe(true);

        window.switchFoodTab('fooddb');
        expect(nav.classList.contains('hidden')).toBe(true);

        window.switchFoodTab('log');
        expect(nav.classList.contains('hidden')).toBe(false);

        // Visibility is class-based, not inline-style-based.
        expect(nav.getAttribute('style')).toBeNull();
    });

    it('switchFoodTab hides #food-add-cta-dock on non-log sub-tabs and restores it on log', () => {
        const { document, window } = env;
        const dock = document.getElementById('food-add-cta-dock');
        expect(dock).not.toBeNull();

        // Default state: 'log' tab is active, dock visible.
        expect(dock.classList.contains('hidden')).toBe(false);

        window.switchFoodTab('meals');
        expect(dock.classList.contains('hidden')).toBe(true);

        window.switchFoodTab('fooddb');
        expect(dock.classList.contains('hidden')).toBe(true);

        window.switchFoodTab('log');
        expect(dock.classList.contains('hidden')).toBe(false);

        // Visibility is class-based, not inline-style-based.
        expect(dock.getAttribute('style')).toBeNull();
    });

    it('switchFoodTab keeps #food-add-cta-dock hidden when returning to log on a weekly view', () => {
        // Reproduces the "switching meals -> log unhides the dock on a
        // weekly summary" regression: the Add Food action must stay
        // unavailable whenever the resolved period is not a daily view,
        // regardless of the active sub-tab.
        const { document, window } = env;
        const dock = document.getElementById('food-add-cta-dock');

        // Flip the period to 'week' via the real setter so the
        // module-scoped `currentFoodStatsPeriod` binding is updated
        // (let-bindings aren't reachable as window.* properties).
        window.setFoodStatsPeriod('week');
        dock.classList.add('hidden');

        window.switchFoodTab('meals');
        expect(dock.classList.contains('hidden')).toBe(true);

        window.switchFoodTab('log');
        expect(dock.classList.contains('hidden')).toBe(true);
    });

    it('restoreFoodSubTab applies the stored value to the strip', () => {
        const { document, window } = env;
        window.setActiveFoodSubTab('meals');
        window.restoreFoodSubTab();

        const buttons = document.querySelectorAll('.wg-food-subtabs .food-tab');
        const mealsBtn = Array.from(buttons).find((b) => b.dataset.tab === 'meals');
        expect(mealsBtn.classList.contains('wg-gloss--sun')).toBe(true);
        expect(mealsBtn.classList.contains('wg-food-subtabs__btn--active')).toBe(true);
    });
});
