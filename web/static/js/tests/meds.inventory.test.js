// Meds Stock sub-tab (kit v2 ST4) and the Update stock sheet (ST1–ST3),
// bd med-wi09.13.
//
// Exercises renderInventory(): one `.wg-row.wg-meds-stock__row` per
// medication that tracks inventory, problems first under "Needs attention",
// "N left · lasts N days" meta, Out (· N over) / Low chips and one Update
// action that opens the sheet. The sheet: an Added | Counted switch, "+1 pack
// (N)" only with a pack size, presets + stepper as one value, the primary
// previewing the result, a read-only history, and writes through
// DataStore.applyOptimistic on /restock (Added) and /stock-audit (Counted).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const DAILY = JSON.stringify({ type: 'daily', times: ['08:00'] });
const TWICE = JSON.stringify({ type: 'daily', times: ['08:00', '20:00'] });

async function seedMedications(window, meds) {
    window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh(meds);
    });
    window.apiCall = vi.fn().mockResolvedValue([]);
    await window.loadMeds();
}

async function flushMicrotasks() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

const rowOf = (document, id) => document.querySelector(`.wg-meds-stock__row[data-med-id="${id}"]`);
const sheet = (document) => document.getElementById('stock-sheet');
const primary = (document) => sheet(document).querySelector('.wg-meds-stocksheet__save');
const picks = (document) => Array.from(sheet(document).querySelectorAll('.wg-pick'));

describe('Meds Stock sub-tab (kit v2 ST4) + Update stock sheet (ST1–ST3)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('the sub-tab reads "Stock" but keeps the inventory tab id', () => {
        const { document } = env;
        const tab = document.querySelector('#med-subtabs .med-tab[data-tab="inventory"]');
        expect(tab.textContent.trim()).toBe('Stock');
        expect(document.getElementById('med-inventory-tab')).not.toBeNull();
    });

    it('renders the empty state when no medication tracks inventory', async () => {
        const { window, document } = env;
        await seedMedications(window, [
            { id: 1, name: 'Allopurinol', dosage: '100mg', schedule: DAILY, archived: false, inventory_count: null }
        ]);
        window.renderInventory();
        const list = document.getElementById('med-inventory-list');
        expect(list.querySelector('.wg-empty').textContent).toMatch(/no inventory tracked/i);
        expect(list.querySelector('.wg-meds-stock__row')).toBeNull();
    });

    it('problems first under "Needs attention" (out, then low), the rest under "Fine", one Update each', async () => {
        const { window, document } = env;
        await seedMedications(window, [
            { id: 1, name: 'Allopurinol', dosage: '100mg', schedule: DAILY, archived: false, inventory_count: 60 },
            { id: 2, name: 'Bisoprolol', dosage: '5mg', schedule: DAILY, archived: false, inventory_count: 3 },
            { id: 3, name: 'Ibuprofen', dosage: '400mg', schedule: JSON.stringify({ type: 'as_needed' }), archived: false, inventory_count: -17 },
            { id: 4, name: 'Metformin', dosage: '500mg', schedule: DAILY, archived: false, inventory_count: null }
        ]);
        window.renderInventory();

        const sections = Array.from(document.querySelectorAll('#med-inventory-list .wg-section'));
        expect(sections.map((s) => s.querySelector('.wg-eyebrow').textContent)).toEqual(['Needs attention', 'Fine']);
        expect(Array.from(sections[0].querySelectorAll('.wg-meds-stock__row')).map((r) => r.dataset.medId)).toEqual(['3', '2']);
        expect(Array.from(sections[1].querySelectorAll('.wg-meds-stock__row')).map((r) => r.dataset.medId)).toEqual(['1']);

        const chip = (id) => rowOf(document, id).querySelector('.wg-meds-stock__chip');
        expect(chip('3').textContent).toBe('Out · 17 over');
        expect(chip('3').classList.contains('wg-chip--danger')).toBe(true);
        expect(chip('2').textContent).toBe('Low');
        expect(chip('2').classList.contains('wg-chip--warn')).toBe(true);
        expect(chip('1')).toBeNull();

        expect(rowOf(document, '1').querySelector('.wg-meds-stock__name').textContent).toBe('Allopurinol · 100mg');
        expect(rowOf(document, '1').querySelector('.wg-meds-stock__meta').textContent).toBe('60 left · lasts 60 days');
        expect(rowOf(document, '3').querySelector('.wg-meds-stock__meta').textContent).toBe('As neededOut · 17 over');
        document.querySelectorAll('.wg-meds-stock__row').forEach((r) => {
            expect(r.querySelector('.wg-meds-stock__update').textContent).toBe('Update');
        });
    });

    it('Update opens the sheet on Added: presets without a pack size, +30 preselected, "Add 30 → 47"; the stepper is the same value', async () => {
        const { window, document } = env;
        await seedMedications(window, [
            { id: 1, name: 'Metformin', dosage: '1000mg', schedule: TWICE, archived: false, inventory_count: 17 }
        ]);
        window.renderInventory();
        rowOf(document, '1').querySelector('.wg-meds-stock__update').click();

        const s = sheet(document);
        expect(s.querySelector('.wg-sheethead__title').textContent).toBe('Update stock');
        expect(s.querySelector('.wg-eyebrow').textContent).toBe('Metformin · 1000mg');
        expect(s.querySelector('.wg-seg--accent [data-mode="added"]').getAttribute('aria-pressed')).toBe('true');
        expect(s.querySelector('.wg-meds-stocksheet__has').textContent).toBe('App has 17 · 2 a day · lasts 8 days');
        expect(picks(document).map((p) => p.textContent)).toEqual(['+30', '+60', '+90']);
        expect(picks(document)[0].getAttribute('aria-pressed')).toBe('true');
        expect(primary(document).textContent).toBe('Add 30 → 47');

        picks(document)[1].click();
        expect(primary(document).textContent).toBe('Add 60 → 77');
        const input = s.querySelector('.wg-meds-stock__qty');
        expect(input.value).toBe('60');
        s.querySelector('[aria-label="Increase"]').click();
        expect(primary(document).textContent).toBe('Add 61 → 78');
        expect(picks(document).some((p) => p.getAttribute('aria-pressed') === 'true')).toBe(false);

        input.value = '0';
        input.dispatchEvent(new window.Event('input'));
        expect(primary(document).disabled).toBe(true);

        s.querySelector('.wg-sheethead .wg-btn').click();
        expect(sheet(document)).toBeNull();
    });

    it('a pack size adds "+1 pack (N)" first (ST1)', async () => {
        const { window, document } = env;
        await seedMedications(window, [
            { id: 1, name: 'Metformin', schedule: TWICE, archived: false, inventory_count: 17, pack_size: 28 }
        ]);
        window.renderInventory();
        rowOf(document, '1').querySelector('.wg-meds-stock__update').click();
        expect(picks(document).map((p) => p.textContent)).toEqual(['+1 pack (28)', '+30', '+60', '+90']);
        picks(document)[0].click();
        expect(primary(document).textContent).toBe('Add 28 → 45');
    });

    it('Counted prefills the app\'s number and says what it replaces (ST2), then POSTs /stock-audit', async () => {
        const { window, document } = env;
        await seedMedications(window, [
            { id: 1, name: 'Metformin', schedule: TWICE, archived: false, inventory_count: 47 }
        ]);
        const handle = { commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };
        vi.spyOn(window.DataStore, 'applyOptimistic').mockResolvedValue(handle);
        const posts = [];
        window.apiCall = vi.fn(async (endpoint, method, body) => {
            if (method === 'POST') { posts.push({ endpoint, body }); return { status: 'counted', inventory_count: body.count }; }
            return [];
        });
        window.renderInventory();
        rowOf(document, '1').querySelector('.wg-meds-stock__update').click();
        sheet(document).querySelector('[data-mode="counted"]').click();

        expect(sheet(document).querySelector('.wg-meds-stock__qty').value).toBe('47');
        expect(sheet(document).querySelector('.wg-hint').hidden).toBe(false);
        expect(primary(document).textContent).toBe('Set to 47 (app had 47)');
        sheet(document).querySelector('[aria-label="Decrease"]').click();
        sheet(document).querySelector('[aria-label="Decrease"]').click();
        expect(primary(document).textContent).toBe('Set to 45 (app had 47)');

        primary(document).click();
        await flushMicrotasks();
        expect(posts).toEqual([{ endpoint: '/api/medications/1/stock-audit', body: { count: 45 } }]);
        expect(handle.commit).toHaveBeenCalled();
        expect(sheet(document)).toBeNull();
        expect(rowOf(document, '1').querySelector('.wg-meds-stock__meta').textContent).toBe('45 left · lasts 22 days');
    });

    it('Added writes optimistically through /restock, commits and repaints; a failure rolls back and keeps the sheet', async () => {
        const { window, document } = env;
        await seedMedications(window, [
            { id: 1, name: 'Allopurinol', schedule: DAILY, archived: false, inventory_count: 17 }
        ]);
        const handle = { commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };
        const applySpy = vi.spyOn(window.DataStore, 'applyOptimistic').mockResolvedValue(handle);
        let fail = true;
        window.apiCall = vi.fn(async (endpoint, method, body) => {
            if (method !== 'POST') return [];
            return fail ? null : { status: 'restocked', quantity_added: body.quantity, inventory_count: 17 + body.quantity };
        });
        window.safeToast = vi.fn();
        window.renderInventory();
        rowOf(document, '1').querySelector('.wg-meds-stock__update').click();

        primary(document).click();
        await flushMicrotasks();
        expect(handle.rollback).toHaveBeenCalled();
        expect(window.safeToast).toHaveBeenCalled();
        expect(sheet(document)).not.toBeNull();
        expect(rowOf(document, '1').querySelector('.wg-meds-stock__meta').textContent).toBe('17 left · lasts 17 days');

        fail = false;
        primary(document).click();
        await flushMicrotasks();
        expect(applySpy).toHaveBeenCalledWith('medications', expect.any(Function), ['medications']);
        const mutated = applySpy.mock.calls[1][1]([{ id: 1, inventory_count: 17 }, { id: 2, inventory_count: 5 }]);
        expect(mutated[0]).toMatchObject({ id: 1, inventory_count: 47, stock: { refills: [{ n: 30 }] } });
        expect(mutated[1]).toEqual({ id: 2, inventory_count: 5 });
        expect(window.apiCall).toHaveBeenLastCalledWith('/api/medications/1/restock', 'POST', { quantity: 30 });
        expect(handle.commit).toHaveBeenCalled();
        expect(sheet(document)).toBeNull();
        expect(rowOf(document, '1').querySelector('.wg-meds-stock__meta').textContent).toBe('47 left · lasts 47 days');
    });

    it('the history under the form is the read-only ledger, newest first (ST3)', async () => {
        const { window, document } = env;
        await seedMedications(window, [{
            id: 1, name: 'Metformin', schedule: TWICE, archived: false, inventory_count: 47,
            stock: { counted: 39, counted_at: '2026-10-12T10:00:00Z', seed: false, refills: [{ n: 30, at: '2026-10-20T10:00:00Z' }], taken: 22 },
        }]);
        window.renderInventory();
        rowOf(document, '1').querySelector('.wg-meds-stock__update').click();
        const titles = Array.from(sheet(document).querySelectorAll('.wg-meds-stock__history .wg-row__title')).map((t) => t.textContent);
        expect(titles).toHaveLength(3);
        expect(titles[0]).toMatch(/^−22 taken since /);
        expect(titles[1]).toMatch(/^\+30 · /);
        expect(titles[2]).toMatch(/^Counted 39 · /);
        expect(sheet(document).querySelector('.wg-meds-stock__history .wg-hint').textContent).toBe("Something wrong? Add a new count. History isn't edited.");
    });
});
