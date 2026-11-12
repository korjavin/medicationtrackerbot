// Meds sub-tab strip: Timeline · My meds (bd med-wi09.3, med-5uwb.2).
//
// Kit `.wg-seg` strip with `.wg-seg__opt[aria-pressed]` selection; the active
// sub-tab persists via the `mt-meds-subtab` sessionStorage key (every fresh
// session lands on the Timeline default), and retired values — stored by
// older builds, or passed by a stale caller — map to what replaced them:
// History / Upcoming to the timeline, Stock (`inventory`) to My meds.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('Meds sub-tab strip', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
        // Stub async sub-tab loaders so they don't reach into `document`
        // after the JSDOM window is closed in afterEach. Tests in this file
        // only care about the DOM class toggles + persistence, not data fetch.
        env.window.loadMeds = () => {};
        env.window.loadTimeline = () => {};
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        try { env.window.sessionStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    const pressed = (document, tab) => document.querySelector(`.med-tab[data-tab="${tab}"]`).getAttribute('aria-pressed');

    it('renders Timeline · My meds as a kit .wg-seg strip', () => {
        const { document } = env;
        const strip = document.querySelector('#med-subtabs');
        expect(strip.classList.contains('wg-seg')).toBe(true);
        const buttons = Array.from(strip.querySelectorAll('.med-tab'));
        expect(buttons.map((b) => b.dataset.tab)).toEqual(['timeline', 'schedule']);
        expect(buttons.map((b) => b.textContent.trim())).toEqual(['Timeline', 'My meds']);
        buttons.forEach((btn) => expect(btn.classList.contains('wg-seg__opt')).toBe(true));
    });

    it('the History, Upcoming and Stock panes and their controls are gone', () => {
        const { document, window } = env;
        for (const id of ['med-history-tab', 'med-upcoming-tab', 'history-list', 'med-upcoming-list',
            'next-intake-trigger', 'history-filter-med', 'history-filter-days',
            'med-inventory-tab', 'med-inventory-list']) {
            expect(document.getElementById(id), id).toBeNull();
        }
        expect(document.querySelector('.med-tab[data-tab="inventory"]')).toBeNull();
        for (const fn of ['loadHistory', 'renderHistory', 'loadUpcoming', 'renderUpcomingDoses',
            'renderNextIntakeTrigger', 'populateMedFilter', 'deleteFutureIntakes',
            'renderInventory', 'loadInventory', '_buildStockRow', 'stockAttentionMeds']) {
            expect(typeof window[fn], fn).toBe('undefined');
        }
    });

    it('defaults to the timeline sub-tab with an aria-pressed selection', () => {
        const { document, window } = env;
        expect(pressed(document, 'timeline')).toBe('true');
        expect(pressed(document, 'schedule')).toBe('false');
        expect(document.getElementById('med-timeline-tab').classList.contains('active')).toBe(true);
        window.sessionStorage.removeItem('mt-meds-subtab');
        expect(window.getActiveMedsSubTab()).toBe('timeline');
    });

    it('switchMedTab moves aria-pressed across the strip without inline style', () => {
        const { document, window } = env;
        window.switchMedTab('schedule');
        expect(pressed(document, 'timeline')).toBe('false');
        expect(pressed(document, 'schedule')).toBe('true');
        expect(document.getElementById('med-schedule-tab').classList.contains('active')).toBe(true);
        expect(document.getElementById('med-timeline-tab').classList.contains('active')).toBe(false);
        document.querySelectorAll('#med-subtabs .med-tab').forEach((btn) => {
            expect(btn.getAttribute('style')).toBeNull();
        });
    });

    it('switchMedTab("inventory") opens My meds and scrolls to the refill group', async () => {
        const { document, window } = env;
        const scroll = vi.fn();
        window.loadMeds = async () => {
            const group = document.createElement('section');
            group.dataset.group = 'refill';
            group.scrollIntoView = scroll;
            document.getElementById('med-list').appendChild(group);
        };
        window.switchMedTab('inventory');
        expect(document.getElementById('med-schedule-tab').classList.contains('active')).toBe(true);
        expect(pressed(document, 'schedule')).toBe('true');
        expect(window.sessionStorage.getItem('mt-meds-subtab')).toBe('schedule');
        await new Promise((r) => setTimeout(r, 0));
        expect(scroll).toHaveBeenCalledWith({ block: 'start' });
    });

    it('switchMedTab("inventory") with nothing to refill lands on the list top without throwing', async () => {
        const { document, window } = env;
        window.loadMeds = async () => {};
        expect(() => window.switchMedTab('inventory')).not.toThrow();
        await new Promise((r) => setTimeout(r, 0));
        expect(document.getElementById('med-schedule-tab').classList.contains('active')).toBe(true);
    });

    it('switchMedTab("timeline") loads the timeline anchored on Today', () => {
        const { window } = env;
        const calls = [];
        window.loadTimeline = (opts) => { calls.push(opts); };
        window.switchMedTab('schedule');
        window.switchMedTab('timeline');
        expect(calls).toEqual([{ anchor: true }]);
    });

    it.each(['history', 'upcoming'])('a stored legacy "%s" value maps to timeline', (legacy) => {
        const { window } = env;
        window.sessionStorage.setItem('mt-meds-subtab', legacy);
        expect(window.getActiveMedsSubTab()).toBe('timeline');
    });

    it.each(['history', 'upcoming'])('switchMedTab("%s") lands on the timeline pane and persists timeline', (legacy) => {
        const { document, window } = env;
        window.switchMedTab('schedule');
        window.switchMedTab(legacy);
        expect(document.getElementById('med-timeline-tab').classList.contains('active')).toBe(true);
        expect(pressed(document, 'timeline')).toBe('true');
        expect(window.sessionStorage.getItem('mt-meds-subtab')).toBe('timeline');
    });

    it('setActiveMedsSubTab maps legacy values and ignores unknown ones', () => {
        const { window } = env;
        window.setActiveMedsSubTab('history');
        expect(window.sessionStorage.getItem('mt-meds-subtab')).toBe('timeline');
        window.setActiveMedsSubTab('inventory');
        expect(window.sessionStorage.getItem('mt-meds-subtab')).toBe('schedule');
        window.setActiveMedsSubTab('not-a-tab');
        expect(window.getActiveMedsSubTab()).toBe('schedule');
    });

    it('a stored "inventory" from an older build opens My meds', () => {
        const { window } = env;
        window.sessionStorage.setItem('mt-meds-subtab', 'inventory');
        expect(window.getActiveMedsSubTab()).toBe('schedule');
    });

    it('a stale localStorage value never overrides the session default, and is never written', () => {
        const { window } = env;
        window.localStorage.setItem('mt-meds-subtab', 'inventory');
        window.sessionStorage.removeItem('mt-meds-subtab');
        expect(window.getActiveMedsSubTab()).toBe('timeline');
        window.localStorage.removeItem('mt-meds-subtab');
        window.setActiveMedsSubTab('schedule');
        expect(window.localStorage.getItem('mt-meds-subtab')).toBeNull();
    });

    it('restoreMedsSubTab applies the stored value to the strip', () => {
        const { document, window } = env;
        window.setActiveMedsSubTab('schedule');
        window.restoreMedsSubTab();
        expect(pressed(document, 'schedule')).toBe('true');
    });
});
