// Wandergeek Meds sub-tab strip (Phase 5, Task 2; round-2 Task 4).
//
// Asserts the rewritten sub-tab strip uses the Wandergeek primitives —
// `.wg-gloss--inset` container, `.wg-gloss--sun` active pill — persists the
// active sub-tab via the `mt-meds-subtab` sessionStorage key (round-2 moved
// persistence from localStorage to sessionStorage so every fresh session
// lands on the History default), defaults to `history`, and that clicking
// a sub-tab routes through switchMedTab() to toggle the active-state classes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('Meds sub-tab strip (Phase 5, Task 2)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
        // Stub async sub-tab loaders so they don't reach into `document`
        // after the JSDOM window is closed in afterEach. Tests in this file
        // only care about the DOM class toggles + persistence, not data fetch.
        env.window.loadMeds = () => {};
        env.window.loadHistory = () => {};
        env.window.loadUpcoming = () => {};
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        try { env.window.sessionStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renders the strip as a .wg-gloss--inset container with four .med-tab buttons in history-first order', () => {
        const { document } = env;
        const strip = document.querySelector('.wg-meds-subtabs');
        expect(strip).not.toBeNull();
        expect(strip.classList.contains('wg-gloss--inset')).toBe(true);

        const buttons = strip.querySelectorAll('.med-tab');
        expect(buttons.length).toBe(4);
        const tabs = Array.from(buttons).map((btn) => btn.dataset.tab);
        // Phase 5, Task 5: History is the default landing tab per the
        // Claude Design mockup, so it renders first in the pill strip.
        // bd med-4oxj added Upcoming immediately left of Inventory.
        expect(tabs).toEqual(['history', 'schedule', 'upcoming', 'inventory']);

        buttons.forEach((btn) => {
            expect(btn.classList.contains('wg-gloss')).toBe(true);
            expect(btn.classList.contains('wg-meds-subtabs__btn')).toBe(true);
        });
    });

    it('defaults to the "history" sub-tab with .wg-gloss--sun active pill', () => {
        const { document } = env;
        const buttons = document.querySelectorAll('.wg-meds-subtabs .med-tab');
        const scheduleBtn = Array.from(buttons).find((b) => b.dataset.tab === 'schedule');
        const historyBtn = Array.from(buttons).find((b) => b.dataset.tab === 'history');
        const inventoryBtn = Array.from(buttons).find((b) => b.dataset.tab === 'inventory');

        expect(historyBtn.classList.contains('wg-gloss--sun')).toBe(true);
        expect(historyBtn.classList.contains('wg-meds-subtabs__btn--active')).toBe(true);
        expect(historyBtn.getAttribute('aria-pressed')).toBe('true');

        expect(scheduleBtn.classList.contains('wg-gloss--sun')).toBe(false);
        expect(scheduleBtn.getAttribute('aria-pressed')).toBe('false');
        expect(inventoryBtn.classList.contains('wg-gloss--sun')).toBe(false);
        expect(inventoryBtn.getAttribute('aria-pressed')).toBe('false');
    });

    it('switchMedTab toggles .wg-gloss--sun across the strip without inline style', () => {
        const { document, window } = env;
        window.switchMedTab('schedule');

        const buttons = document.querySelectorAll('.wg-meds-subtabs .med-tab');
        const scheduleBtn = Array.from(buttons).find((b) => b.dataset.tab === 'schedule');
        const historyBtn = Array.from(buttons).find((b) => b.dataset.tab === 'history');

        expect(historyBtn.classList.contains('wg-gloss--sun')).toBe(false);
        expect(historyBtn.getAttribute('aria-pressed')).toBe('false');
        expect(scheduleBtn.classList.contains('wg-gloss--sun')).toBe(true);
        expect(scheduleBtn.classList.contains('wg-meds-subtabs__btn--active')).toBe(true);
        expect(scheduleBtn.getAttribute('aria-pressed')).toBe('true');

        // No inline style was used to express the active state.
        buttons.forEach((btn) => {
            expect(btn.getAttribute('style')).toBeNull();
        });
    });

    it('switchMedTab activates the inventory tab content', () => {
        const { document, window } = env;
        window.switchMedTab('inventory');

        const inventoryContent = document.getElementById('med-inventory-tab');
        expect(inventoryContent).not.toBeNull();
        expect(inventoryContent.classList.contains('active')).toBe(true);

        const scheduleContent = document.getElementById('med-schedule-tab');
        expect(scheduleContent.classList.contains('active')).toBe(false);

        const inventoryBtn = document.querySelector('.med-tab[data-tab="inventory"]');
        expect(inventoryBtn.classList.contains('wg-gloss--sun')).toBe(true);
        expect(inventoryBtn.getAttribute('aria-pressed')).toBe('true');
    });

    // bd med-4oxj — Upcoming is a first-class sub-tab, not a block inside the
    // Schedule list.
    it('switchMedTab activates the upcoming tab content and persists it', () => {
        const { document, window } = env;
        window.switchMedTab('upcoming');

        const upcomingContent = document.getElementById('med-upcoming-tab');
        expect(upcomingContent).not.toBeNull();
        expect(upcomingContent.classList.contains('active')).toBe(true);
        expect(document.getElementById('med-schedule-tab').classList.contains('active')).toBe(false);
        expect(document.getElementById('med-inventory-tab').classList.contains('active')).toBe(false);

        const upcomingBtn = document.querySelector('.med-tab[data-tab="upcoming"]');
        expect(upcomingBtn.classList.contains('wg-gloss--sun')).toBe(true);
        expect(upcomingBtn.getAttribute('aria-pressed')).toBe('true');

        // Survives a reload within the session.
        expect(window.sessionStorage.getItem('mt-meds-subtab')).toBe('upcoming');
        expect(window.getActiveMedsSubTab()).toBe('upcoming');
    });

    it('getActiveMedsSubTab defaults to "history" when no value is stored', () => {
        const { window } = env;
        window.sessionStorage.removeItem('mt-meds-subtab');
        expect(window.getActiveMedsSubTab()).toBe('history');
    });

    it('getActiveMedsSubTab falls back to history when a stale localStorage value is present (round-2 Task 4)', () => {
        // Previously the sub-tab was persisted to localStorage, so existing
        // users may still carry an `mt-meds-subtab` entry — the fresh session
        // must ignore it and render History so the view matches the mockup.
        const { window } = env;
        window.localStorage.setItem('mt-meds-subtab', 'inventory');
        window.sessionStorage.removeItem('mt-meds-subtab');
        expect(window.getActiveMedsSubTab()).toBe('history');
    });

    it('setActiveMedsSubTab round-trips valid values through sessionStorage', () => {
        const { window } = env;
        window.setActiveMedsSubTab('history');
        expect(window.sessionStorage.getItem('mt-meds-subtab')).toBe('history');
        expect(window.getActiveMedsSubTab()).toBe('history');

        window.setActiveMedsSubTab('inventory');
        expect(window.getActiveMedsSubTab()).toBe('inventory');

        window.setActiveMedsSubTab('schedule');
        expect(window.getActiveMedsSubTab()).toBe('schedule');
    });

    it('setActiveMedsSubTab does not write to localStorage (round-2 Task 4)', () => {
        const { window } = env;
        window.localStorage.removeItem('mt-meds-subtab');
        window.setActiveMedsSubTab('inventory');
        expect(window.localStorage.getItem('mt-meds-subtab')).toBeNull();
    });

    it('setActiveMedsSubTab ignores invalid values and keeps the previous setting', () => {
        const { window } = env;
        window.setActiveMedsSubTab('history');
        window.setActiveMedsSubTab('not-a-tab');
        expect(window.getActiveMedsSubTab()).toBe('history');
    });

    it('switchMedTab persists the chosen sub-tab to sessionStorage', () => {
        const { window } = env;
        window.switchMedTab('inventory');
        expect(window.sessionStorage.getItem('mt-meds-subtab')).toBe('inventory');

        window.switchMedTab('history');
        expect(window.sessionStorage.getItem('mt-meds-subtab')).toBe('history');
    });

    it('restoreMedsSubTab applies the stored value to the strip', () => {
        const { document, window } = env;
        window.setActiveMedsSubTab('history');
        window.restoreMedsSubTab();

        const buttons = document.querySelectorAll('.wg-meds-subtabs .med-tab');
        const historyBtn = Array.from(buttons).find((b) => b.dataset.tab === 'history');
        expect(historyBtn.classList.contains('wg-gloss--sun')).toBe(true);
        expect(historyBtn.classList.contains('wg-meds-subtabs__btn--active')).toBe(true);
    });
});
