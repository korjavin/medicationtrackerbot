// Wandergeek Meds schedule sub-tab (Phase 5, Task 4).
//
// Exercises the rewritten renderMeds(): scheduled entries group by hour of
// their next dose under `.wg-section-label` headers (mono "HH:MM · in Xh Ym"),
// as-needed and archived meds collapse into separate section-label groups
// below the scheduled ones, and each row is a `.wg-card wg-meds-row` with
// dual-classed legacy selectors (`.med-item`, `.icon-action-btn`, `.btn-sm`)
// so the existing UI tests still pass.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function toLocalTime(date) {
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

async function seedMedications(window, meds) {
    window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh(meds);
    });
    window.apiCall = vi.fn().mockResolvedValue([]);
    await window.loadMeds();
}

describe('Meds schedule sub-tab (Phase 5, Task 4)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('groups scheduled meds by hour of next dose under `.wg-section-label` headers', async () => {
        const { window, document } = env;
        const now = new Date();
        // Two meds in the same hour bucket (~+1h) and a third in a later bucket (~+4h).
        // Anchor minutes to :05 so `alsoInOneHour` (+12min → :17) never spills
        // into the next hour regardless of the wall-clock minute when the
        // test runs.
        const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
        inOneHour.setMinutes(5, 0, 0);
        const alsoInOneHour = new Date(inOneHour.getTime() + 12 * 60 * 1000); // same hour
        const fourHoursOut = new Date(inOneHour.getTime() + 3 * 60 * 60 * 1000);

        await seedMedications(window, [
            {
                id: 1,
                name: 'Allopurinol',
                dosage: '100mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(inOneHour)] }),
                archived: false
            },
            {
                id: 2,
                name: 'Bisoprolol',
                dosage: '5mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(alsoInOneHour)] }),
                archived: false
            },
            {
                id: 3,
                name: 'Metformin',
                dosage: '500mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(fourHoursOut)] }),
                archived: false
            }
        ]);

        const list = document.getElementById('med-list');
        const sections = list.querySelectorAll('.wg-section-label');
        expect(sections.length).toBeGreaterThanOrEqual(2);

        // First section header matches HH:MM · in ...
        const firstHeader = sections[0].textContent.trim();
        expect(firstHeader).toMatch(/^\d{2}:\d{2} · in /);

        const rows = list.querySelectorAll('.wg-meds-row');
        expect(rows.length).toBe(3);
        rows.forEach((row) => {
            expect(row.classList.contains('wg-card')).toBe(true);
            expect(row.classList.contains('med-item')).toBe(true);
        });

        // Both +1h meds cluster under the first hour header (before the
        // second header appears).
        const firstHeaderEl = sections[0];
        const secondHeaderEl = sections[1];
        const clustered = [];
        let node = firstHeaderEl.nextElementSibling;
        while (node && node !== secondHeaderEl) {
            if (node.classList.contains('wg-meds-row')) clustered.push(node);
            node = node.nextElementSibling;
        }
        const names = clustered.map((el) => el.querySelector('.wg-meds-row__name').textContent);
        expect(names).toEqual(expect.arrayContaining(['Allopurinol', 'Bisoprolol']));
    });

    it('renders the inventory tag in both normal and low-stock states', async () => {
        const { window, document } = env;
        const now = new Date();
        const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);

        await seedMedications(window, [
            {
                id: 1,
                name: 'Aspirin',
                dosage: '75mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(inOneHour)] }),
                archived: false,
                inventory_count: 2 // one per day ⇒ 2 days of stock ⇒ low (<7)
            },
            {
                id: 2,
                name: 'Metformin',
                dosage: '500mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(inOneHour)] }),
                archived: false,
                inventory_count: 60 // plenty
            }
        ]);

        const aspirinRow = Array.from(document.querySelectorAll('.wg-meds-row'))
            .find((el) => el.textContent.includes('Aspirin'));
        const metforminRow = Array.from(document.querySelectorAll('.wg-meds-row'))
            .find((el) => el.textContent.includes('Metformin'));

        const lowTag = aspirinRow.querySelector('.wg-meds-row__inventory');
        expect(lowTag).not.toBeNull();
        expect(lowTag.classList.contains('wg-tag')).toBe(true);
        expect(lowTag.classList.contains('wg-tag--mono')).toBe(true);
        expect(lowTag.classList.contains('wg-tag--alert')).toBe(true);
        expect(lowTag.textContent).toContain('2');
        expect(lowTag.textContent).toContain('⚠️');

        const okTag = metforminRow.querySelector('.wg-meds-row__inventory');
        expect(okTag).not.toBeNull();
        expect(okTag.classList.contains('wg-tag--alert')).toBe(false);
        expect(okTag.classList.contains('wg-tag--normal')).toBe(true);
        expect(okTag.textContent).toContain('60');
        expect(okTag.textContent).not.toContain('⚠️');
    });

    it('collapses as-needed and archived meds into separate section-label groups after the scheduled ones', async () => {
        const { window, document } = env;
        const now = new Date();
        const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);

        await seedMedications(window, [
            {
                id: 1,
                name: 'Scheduled Med',
                dosage: '10mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(inOneHour)] }),
                archived: false
            },
            {
                id: 2,
                name: 'PRN Med',
                dosage: '1 tab',
                schedule: JSON.stringify({ type: 'as_needed' }),
                archived: false
            },
            {
                id: 3,
                name: 'Archived Med',
                dosage: '2mg',
                schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }),
                archived: true
            }
        ]);

        const list = document.getElementById('med-list');
        const headers = Array.from(list.querySelectorAll('.wg-section-label'))
            .map((h) => h.textContent.trim());
        expect(headers.length).toBe(3);
        expect(headers[0]).toMatch(/^\d{2}:\d{2} · in /);
        expect(headers[1]).toBe('As needed');
        expect(headers[2]).toBe('Archived');

        const archivedRow = Array.from(list.querySelectorAll('.wg-meds-row'))
            .find((el) => el.textContent.includes('Archived Med'));
        expect(archivedRow.classList.contains('archived')).toBe(true);

        const prnRow = Array.from(list.querySelectorAll('.wg-meds-row'))
            .find((el) => el.textContent.includes('PRN Med'));
        expect(prnRow).not.toBeNull();
        expect(prnRow.querySelector('.wg-meds-row__schedule').textContent).toBe('As Needed');
    });

    it('Log / Edit / Delete buttons dispatch to the shared handlers with the med id', async () => {
        const { window, document } = env;
        const now = new Date();
        const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);

        await seedMedications(window, [
            {
                id: 42,
                name: 'Soon Med',
                dosage: '10mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(inOneHour)] }),
                archived: false
            }
        ]);

        const editSpy = vi.spyOn(window, 'showEditModal').mockImplementation(() => {});
        const logSpy = vi.spyOn(window, 'logMedicationPast').mockImplementation(() => {});
        const deleteSpy = vi.spyOn(window, 'deleteMed').mockImplementation(() => {});

        const row = document.querySelector('.wg-meds-row');
        expect(row).not.toBeNull();

        // Log button — carries `.btn-sm` for legacy selectors + the new
        // `.wg-meds-row__log-btn` hook.
        const logBtn = row.querySelector('.wg-meds-row__log-btn');
        expect(logBtn).not.toBeNull();
        expect(logBtn.classList.contains('btn-sm')).toBe(true);
        logBtn.click();
        expect(logSpy).toHaveBeenCalledWith(42, 'Soon Med');

        const editBtn = row.querySelector('.icon-action-btn:not(.delete)');
        editBtn.click();
        expect(editSpy).toHaveBeenCalledWith(42);

        const deleteBtn = row.querySelector('.icon-action-btn.delete');
        deleteBtn.click();
        expect(deleteSpy).toHaveBeenCalledWith(42);

        // Clicking the info area also opens the edit modal.
        editSpy.mockClear();
        row.querySelector('.wg-meds-row__info').click();
        expect(editSpy).toHaveBeenCalledWith(42);
    });

    it('Add medication CTA is an inline `.wg-gloss--sun` pill in the subtabs row (Phase 5, Task 5)', () => {
        const { document } = env;
        const btn = document.getElementById('add-btn');
        expect(btn).not.toBeNull();
        expect(btn.classList.contains('wg-gloss')).toBe(true);
        expect(btn.classList.contains('wg-gloss--sun')).toBe(true);
        expect(btn.classList.contains('wg-meds-subtabs-row__add')).toBe(true);
        expect(btn.classList.contains('wg-meds-add-cta')).toBe(false);
        expect(btn.classList.contains('wg-fab')).toBe(false);
        expect(btn.classList.contains('btn-fab')).toBe(false);
        // The inline pill lives inside the subtabs row, as a sibling of the
        // inset 3-pill track — not inside the Schedule tab-content below.
        const row = document.getElementById('med-subtabs');
        expect(row.contains(btn)).toBe(true);
        const scheduleTab = document.getElementById('med-schedule-tab');
        expect(scheduleTab.contains(btn)).toBe(false);

        const label = btn.querySelector('.wg-meds-subtabs-row__add-label');
        expect(label).not.toBeNull();
        expect(label.textContent.trim()).toBe('Add');
    });

    it('rendering twice replaces the list cleanly (no duplicate section headers)', async () => {
        const { window, document } = env;
        const now = new Date();
        const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);

        await seedMedications(window, [
            {
                id: 1,
                name: 'Scheduled Med',
                dosage: '10mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(inOneHour)] }),
                archived: false
            }
        ]);

        window.renderMeds();

        const list = document.getElementById('med-list');
        const headers = list.querySelectorAll('.wg-section-label');
        expect(headers.length).toBe(1);
        const rows = list.querySelectorAll('.wg-meds-row');
        expect(rows.length).toBe(1);
    });
});
