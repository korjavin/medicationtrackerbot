// Wandergeek Health sub-tab strip (Phase 8, Task 2).
//
// Asserts the rewritten sub-tab strip uses the Wandergeek primitives —
// `.wg-gloss--inset` container, `.wg-gloss--sun` active pill — persists the
// active sub-tab via the `mt-health-subtab` localStorage key, defaults to
// `overview`, and that clicking a sub-tab routes through switchHealthTab()
// to toggle the active-state classes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('Health sub-tab strip (Phase 8, Task 2)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
        // Stub async sub-tab loaders so they don't reach into `document`
        // after the JSDOM window is closed in afterEach. Tests in this file
        // only care about the DOM class toggles + persistence, not data fetch.
        env.window.loadHealthOverview = () => {};
        env.window.loadNotes = () => {};
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renders the strip as a .wg-gloss--inset container with two .health-tab buttons', () => {
        const { document } = env;
        const strip = document.querySelector('.wg-health-subtabs');
        expect(strip).not.toBeNull();
        expect(strip.classList.contains('wg-gloss--inset')).toBe(true);

        const buttons = strip.querySelectorAll('.health-tab');
        expect(buttons.length).toBe(2);
        const tabs = Array.from(buttons).map((btn) => btn.dataset.tab);
        expect(tabs).toEqual(['overview', 'notes']);

        buttons.forEach((btn) => {
            expect(btn.classList.contains('wg-gloss')).toBe(true);
            expect(btn.classList.contains('wg-health-subtabs__btn')).toBe(true);
        });
    });

    it('defaults to the "overview" sub-tab with .wg-gloss--sun active pill', () => {
        const { document } = env;
        const buttons = document.querySelectorAll('.wg-health-subtabs .health-tab');
        const overviewBtn = Array.from(buttons).find((b) => b.dataset.tab === 'overview');
        const notesBtn = Array.from(buttons).find((b) => b.dataset.tab === 'notes');

        expect(overviewBtn.classList.contains('wg-gloss--sun')).toBe(true);
        expect(overviewBtn.classList.contains('wg-health-subtabs__btn--active')).toBe(true);
        expect(overviewBtn.getAttribute('aria-pressed')).toBe('true');

        expect(notesBtn.classList.contains('wg-gloss--sun')).toBe(false);
        expect(notesBtn.getAttribute('aria-pressed')).toBe('false');
    });

    it('switchHealthTab toggles .wg-gloss--sun across the strip without inline style', () => {
        const { document, window } = env;
        window.switchHealthTab('notes');

        const buttons = document.querySelectorAll('.wg-health-subtabs .health-tab');
        const overviewBtn = Array.from(buttons).find((b) => b.dataset.tab === 'overview');
        const notesBtn = Array.from(buttons).find((b) => b.dataset.tab === 'notes');

        expect(overviewBtn.classList.contains('wg-gloss--sun')).toBe(false);
        expect(overviewBtn.getAttribute('aria-pressed')).toBe('false');
        expect(notesBtn.classList.contains('wg-gloss--sun')).toBe(true);
        expect(notesBtn.classList.contains('wg-health-subtabs__btn--active')).toBe(true);
        expect(notesBtn.getAttribute('aria-pressed')).toBe('true');

        // No inline style was used to express the active state.
        buttons.forEach((btn) => {
            expect(btn.getAttribute('style')).toBeNull();
        });
    });

    it('switchHealthTab activates the matching tab content panel', () => {
        const { document, window } = env;
        window.switchHealthTab('notes');

        const notesContent = document.getElementById('health-notes-tab');
        expect(notesContent).not.toBeNull();
        expect(notesContent.classList.contains('active')).toBe(true);

        const overviewContent = document.getElementById('health-overview-tab');
        expect(overviewContent.classList.contains('active')).toBe(false);

        const notesBtn = document.querySelector('.health-tab[data-tab="notes"]');
        expect(notesBtn.classList.contains('wg-gloss--sun')).toBe(true);
        expect(notesBtn.getAttribute('aria-pressed')).toBe('true');
    });

    it('getActiveHealthSubTab defaults to "overview" when no value is stored', () => {
        const { window } = env;
        window.localStorage.removeItem('mt-health-subtab');
        expect(window.getActiveHealthSubTab()).toBe('overview');
    });

    it('setActiveHealthSubTab round-trips valid values through localStorage', () => {
        const { window } = env;
        window.setActiveHealthSubTab('notes');
        expect(window.localStorage.getItem('mt-health-subtab')).toBe('notes');
        expect(window.getActiveHealthSubTab()).toBe('notes');

        window.setActiveHealthSubTab('overview');
        expect(window.getActiveHealthSubTab()).toBe('overview');
    });

    it('setActiveHealthSubTab ignores invalid values and keeps the previous setting', () => {
        const { window } = env;
        window.setActiveHealthSubTab('notes');
        window.setActiveHealthSubTab('not-a-tab');
        expect(window.getActiveHealthSubTab()).toBe('notes');
    });

    it('switchHealthTab persists the chosen sub-tab to localStorage', () => {
        const { window } = env;
        window.switchHealthTab('notes');
        expect(window.localStorage.getItem('mt-health-subtab')).toBe('notes');

        window.switchHealthTab('overview');
        expect(window.localStorage.getItem('mt-health-subtab')).toBe('overview');
    });

    it('restoreHealthSubTab applies the stored value to the strip', () => {
        const { document, window } = env;
        window.setActiveHealthSubTab('notes');
        window.restoreHealthSubTab();

        const buttons = document.querySelectorAll('.wg-health-subtabs .health-tab');
        const notesBtn = Array.from(buttons).find((b) => b.dataset.tab === 'notes');
        expect(notesBtn.classList.contains('wg-gloss--sun')).toBe(true);
        expect(notesBtn.classList.contains('wg-health-subtabs__btn--active')).toBe(true);
    });
});
