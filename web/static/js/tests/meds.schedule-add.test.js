// Meds Add-medication CTA (kit v2 M1/M4, med-xso6.18). The screen primary is
// one `#add-btn` in the Meds app bar, visible on every sub-tab, except while
// the visible pane's empty state carries its own primary Add (M4) — then the
// app-bar copy hides so there is exactly one Add on screen.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('Meds — app-bar Add CTA (med-xso6.18)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
        // Stub async sub-tab loaders — these cases exercise placement/visibility only.
        env.window.loadMeds = () => {};
        env.window.loadHistory = () => {};
        env.window.loadInventory = () => {};
        env.window.loadUpcoming = () => {};
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        try { env.window.sessionStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('#add-btn is the single kit primary in the Meds app bar, outside every sub-tab pane', () => {
        const { document } = env;
        const all = document.querySelectorAll('#add-btn');
        expect(all.length).toBe(1);
        const addBtn = all[0];
        expect(document.querySelector('#meds-view .wg-appbar').contains(addBtn)).toBe(true);
        expect(document.getElementById('med-subtabs').contains(addBtn)).toBe(false);
        document.querySelectorAll('#meds-view .med-tab-content').forEach((pane) => {
            expect(pane.contains(addBtn)).toBe(false);
        });
        expect(addBtn.classList.contains('wg-btn')).toBe(true);
        expect(addBtn.classList.contains('wg-btn--primary')).toBe(true);
        expect(addBtn.classList.contains('wg-toolbar-btn')).toBe(false);
        expect(addBtn.getAttribute('aria-label')).toBe('Add medication');
        expect(document.querySelector('.wg-meds-schedule-header')).toBeNull();
    });

    it('stays visible across sub-tabs whose panes carry no empty-state Add', () => {
        const { document, window } = env;
        const addBtn = document.getElementById('add-btn');
        ['history', 'inventory', 'schedule', 'upcoming'].forEach((tab) => {
            window.switchMedTab(tab);
            expect(addBtn.hidden).toBe(false);
        });
    });

    it('hides while the active pane shows an empty state with a primary Add, and returns on switch', () => {
        const { document, window } = env;
        const addBtn = document.getElementById('add-btn');
        window.switchMedTab('schedule');
        window.medications = [];
        window.renderMeds();
        expect(document.querySelector('#med-list .wg-empty .wg-btn--primary')).not.toBeNull();
        expect(addBtn.hidden).toBe(true);

        window.switchMedTab('history');
        expect(addBtn.hidden).toBe(false);
        window.switchMedTab('schedule');
        expect(addBtn.hidden).toBe(true);
    });

    it('clicking #add-btn opens the add-medication modal (wiring preserved)', () => {
        const { window, document } = env;
        let opened = 0;
        window.showAddModal = () => { opened += 1; };
        document.getElementById('add-btn').click();
        expect(opened).toBe(1);
    });
});
