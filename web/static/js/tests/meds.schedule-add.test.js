// Wandergeek Round-2, Task 7 (defect #10). Asserts the Meds Add-medication
// CTA is now scoped to the Schedule subtab instead of sitting on the global
// subtab row — History and Inventory must not render an Add control, and the
// button must adopt the shared `.wg-toolbar-btn .wg-toolbar-btn--primary`
// sizing introduced in Round-2 Task 2 (architecture.toolbar-btn.test.js).
//
// These assertions complement the source-level guards in
// `architecture.toolbar-btn.test.js` by exercising the live DOM visibility
// that a user actually sees as they switch between History / Schedule /
// Inventory.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('Meds — Add CTA scoped to Schedule subtab (Round-2 Task 7)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
        // Stub async sub-tab loaders — this test exercises visibility only.
        env.window.loadMeds = () => {};
        env.window.loadHistory = () => {};
        env.window.loadInventory = () => {};
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        try { env.window.sessionStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('#add-btn is NOT a child of the #med-subtabs row any more', () => {
        const { document } = env;
        const subtabsRow = document.getElementById('med-subtabs');
        const addBtn = document.getElementById('add-btn');
        expect(subtabsRow).not.toBeNull();
        expect(addBtn).not.toBeNull();
        expect(subtabsRow.contains(addBtn)).toBe(false);
    });

    it('#add-btn lives inside #med-schedule-tab under .wg-meds-schedule-header', () => {
        const { document } = env;
        const scheduleTab = document.getElementById('med-schedule-tab');
        const addBtn = document.getElementById('add-btn');
        expect(scheduleTab).not.toBeNull();
        expect(scheduleTab.contains(addBtn)).toBe(true);
        const header = scheduleTab.querySelector('.wg-meds-schedule-header');
        expect(header).not.toBeNull();
        expect(header.contains(addBtn)).toBe(true);
        // Header must be a direct child of the tab content AND must render
        // above the med-list so the CTA appears at the top of the list.
        expect(addBtn.parentElement).toBe(header);
        const medList = document.getElementById('med-list');
        expect(medList).not.toBeNull();
        expect(header.parentElement).toBe(scheduleTab);
        expect(medList.parentElement).toBe(scheduleTab);
        // 0x04 === Node.DOCUMENT_POSITION_FOLLOWING — avoid relying on a
        // global `Node` (vitest environments don't always expose it).
        expect(header.compareDocumentPosition(medList) & 0x04).toBeTruthy();
    });

    it('#add-btn carries the shared .wg-toolbar-btn + --primary classes, not the dead one-offs', () => {
        const { document } = env;
        const addBtn = document.getElementById('add-btn');
        expect(addBtn.classList.contains('wg-toolbar-btn')).toBe(true);
        expect(addBtn.classList.contains('wg-toolbar-btn--primary')).toBe(true);
        expect(addBtn.classList.contains('wg-meds-subtabs-row__add')).toBe(false);
        expect(addBtn.classList.contains('wg-gloss')).toBe(false);
        expect(addBtn.classList.contains('wg-gloss--sun')).toBe(false);
        const label = addBtn.querySelector('.wg-toolbar-btn__label');
        expect(label).not.toBeNull();
        expect(label.textContent.trim()).toBe('Add');
    });

    it('Schedule subtab is the only subtab that surfaces #add-btn to the user', () => {
        const { document, window } = env;
        const addBtn = document.getElementById('add-btn');
        const scheduleTab = document.getElementById('med-schedule-tab');
        const historyTab = document.getElementById('med-history-tab');
        const inventoryTab = document.getElementById('med-inventory-tab');

        // Neither the History nor the Inventory subtab content carries an Add
        // control — the button only exists as a child of #med-schedule-tab.
        expect(historyTab.contains(addBtn)).toBe(false);
        expect(inventoryTab.contains(addBtn)).toBe(false);
        expect(scheduleTab.contains(addBtn)).toBe(true);

        // Active the History subtab — .med-tab-content toggles display:none
        // on inactive tabs via `css/styles.css`, so asserting the active-class
        // surface on each subtab exercises the same visibility gate without
        // needing layout metrics that jsdom can't compute.
        window.switchMedTab('history');
        expect(historyTab.classList.contains('active')).toBe(true);
        expect(scheduleTab.classList.contains('active')).toBe(false);
        expect(inventoryTab.classList.contains('active')).toBe(false);

        window.switchMedTab('inventory');
        expect(inventoryTab.classList.contains('active')).toBe(true);
        expect(scheduleTab.classList.contains('active')).toBe(false);
        expect(historyTab.classList.contains('active')).toBe(false);

        window.switchMedTab('schedule');
        expect(scheduleTab.classList.contains('active')).toBe(true);
        expect(historyTab.classList.contains('active')).toBe(false);
        expect(inventoryTab.classList.contains('active')).toBe(false);

        // Regardless of active tab, the one and only #add-btn is inside the
        // Schedule subtab — History and Inventory never receive a duplicate.
        const allAddBtns = document.querySelectorAll('#add-btn');
        expect(allAddBtns.length).toBe(1);
        expect(scheduleTab.contains(allAddBtns[0])).toBe(true);
    });

    it('clicking #add-btn still opens the add-medication modal (wiring preserved)', () => {
        const { window, document } = env;
        let opened = 0;
        window.showAddModal = () => { opened += 1; };
        // Force switchMedTab to Schedule so the button is inside an active
        // tab — the event handler wired at DOMContentLoaded is bound to the
        // element by id, so the click dispatches regardless of display state,
        // but activating the tab mirrors real-user conditions.
        window.switchMedTab('schedule');
        document.getElementById('add-btn').click();
        expect(opened).toBe(1);
    });
});
