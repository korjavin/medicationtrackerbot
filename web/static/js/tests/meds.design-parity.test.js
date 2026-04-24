// Wandergeek Meds design parity — Round 2, Task 4.
//
// Pins the user-reported findings fixed by Task 4:
//   • #med-next-action card removed from the Schedule sub-tab (was a
//     duplicate of the Today next-action + History next-intake surfaces).
//   • #meds-view carries `.wg-screen-stage` so the view sits on the teal
//     palette rather than the paper-white body background.
//   • #med-modal + #med-confirm-modal both carry the shared `.wg-modal`
//     primitive (teal-gloss shell, no legacy white surface).
//   • History is the default sub-tab on first open — stale localStorage
//     values from the pre-round-2 persistence model don't win.
//   • renderMeds() does not re-introduce the next-action card even after
//     medications + a cached next_intake payload are seeded (regression
//     guard against restoring mountNextActionCard).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('Meds design parity (Round 2, Task 4)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        try { env.window.sessionStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('#meds-view carries the wg-screen-stage class so the view sits on the teal palette', () => {
        const { document } = env;
        const view = document.getElementById('meds-view');
        expect(view).not.toBeNull();
        expect(view.classList.contains('wg-screen-stage')).toBe(true);
    });

    it('#med-next-action element is absent from the Schedule sub-tab', () => {
        const { document } = env;
        expect(document.getElementById('med-next-action')).toBeNull();
        expect(document.querySelector('.wg-meds-next-action')).toBeNull();
    });

    it('next-action helpers are no longer exported on window (dead-code regression guard)', () => {
        const { window } = env;
        expect(window.renderNextActionCard).toBeUndefined();
        expect(window.mountNextActionCard).toBeUndefined();
    });

    it('#med-modal uses the shared .wg-modal teal-gloss shell', () => {
        const { document } = env;
        const modal = document.getElementById('med-modal');
        expect(modal).not.toBeNull();
        expect(modal.classList.contains('wg-modal')).toBe(true);
        expect(modal.classList.contains('wg-meds-modal')).toBe(true);
    });

    it('#med-confirm-modal (intake modal) uses the shared .wg-modal teal-gloss shell', () => {
        const { document } = env;
        const modal = document.getElementById('med-confirm-modal');
        expect(modal).not.toBeNull();
        expect(modal.classList.contains('wg-modal')).toBe(true);
        expect(modal.classList.contains('wg-med-confirm-modal')).toBe(true);
    });

    it('history is the default sub-tab on a fresh session (no stored value)', () => {
        const { window, document } = env;
        window.sessionStorage.removeItem('mt-meds-subtab');
        expect(window.getActiveMedsSubTab()).toBe('history');

        const historyBtn = document.querySelector('.med-tab[data-tab="history"]');
        const scheduleBtn = document.querySelector('.med-tab[data-tab="schedule"]');
        const inventoryBtn = document.querySelector('.med-tab[data-tab="inventory"]');
        expect(historyBtn.classList.contains('wg-meds-subtabs__btn--active')).toBe(true);
        expect(scheduleBtn.classList.contains('wg-meds-subtabs__btn--active')).toBe(false);
        expect(inventoryBtn.classList.contains('wg-meds-subtabs__btn--active')).toBe(false);
    });

    it('stale legacy localStorage sub-tab values do not override the history default', () => {
        // Simulate a user that had "schedule" or "inventory" persisted
        // under the old localStorage model. The round-2 sessionStorage
        // switch must ignore the stale value and render history.
        const { window } = env;
        window.localStorage.setItem('mt-meds-subtab', 'inventory');
        window.sessionStorage.removeItem('mt-meds-subtab');
        expect(window.getActiveMedsSubTab()).toBe('history');
    });

    it('renderMeds does not mount a next-action card even after medications are seeded', async () => {
        const { window, document } = env;
        window.DataStore.loadSWR = vi.fn(async (options) => {
            await options.onFresh([
                {
                    id: 1,
                    name: 'Allopurinol',
                    dosage: '100mg',
                    schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }),
                    archived: false
                }
            ]);
        });
        window.DataStore.getCached = async () => ({
            scheduled_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            medication_names: ['Allopurinol']
        });
        window.apiCall = vi.fn().mockResolvedValue([]);

        await window.loadMeds();

        // The schedule tab is populated, but no next-action card is in DOM.
        const list = document.getElementById('med-list');
        expect(list.querySelectorAll('.wg-meds-row').length).toBe(1);
        expect(document.querySelector('.wg-meds-next-action')).toBeNull();
        expect(document.getElementById('med-next-action')).toBeNull();
    });
});
