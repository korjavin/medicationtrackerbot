// The Update stock sheet (ST1–ST3, bd med-wi09.13) and the My meds app-bar
// sub (kit MY1, bd med-5uwb.2). The Stock sub-tab is gone (merged into My
// meds); the sheet opens from the Needs a refill rows (meds.schedule.test.js)
// and the editor. The sheet: an Added | Counted switch, "+1 pack (N)" only
// with a pack size, presets + stepper as one value, the primary previewing
// the result, a read-only history, and writes through
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

const openSheet = (window, id) => window.openStockSheet(window.medications.find((m) => m.id === id));
const metaOf = (document, id) => document.querySelector(`#med-list .wg-meds-row[data-med-id="${id}"] .wg-meds-row__meta`).textContent;
const sheet = (document) => document.getElementById('stock-sheet');
const primary = (document) => sheet(document).querySelector('.wg-meds-stocksheet__save');
const picks = (document) => Array.from(sheet(document).querySelectorAll('.wg-pick'));

describe('Update stock sheet (ST1–ST3)', () => {
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

    it('opens on Added: presets without a pack size, +30 preselected, "Add 30 → 47"; the stepper is the same value', async () => {
        const { window, document } = env;
        await seedMedications(window, [
            { id: 1, name: 'Metformin', dosage: '1000mg', schedule: TWICE, archived: false, inventory_count: 17 }
        ]);
        openSheet(window, 1);

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
        expect(s.querySelector('.wg-meds-stocksheet__unit').textContent).toBe('doses');
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
        openSheet(window, 1);
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
        openSheet(window, 1);
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
        expect(metaOf(document, 1)).toContain('45 left · lasts 22 days');
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
        openSheet(window, 1);

        primary(document).click();
        await flushMicrotasks();
        expect(handle.rollback).toHaveBeenCalled();
        expect(window.safeToast).toHaveBeenCalled();
        expect(sheet(document)).not.toBeNull();
        expect(metaOf(document, 1)).toContain('17 left · lasts 17 days');

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
        expect(metaOf(document, 1)).toContain('47 left · lasts 47 days');
    });

    it('the history under the form is the read-only ledger, newest first (ST3)', async () => {
        const { window, document } = env;
        await seedMedications(window, [{
            id: 1, name: 'Metformin', schedule: TWICE, archived: false, inventory_count: 47,
            stock: { counted: 39, counted_at: '2026-10-12T10:00:00Z', seed: false, refills: [{ n: 30, at: '2026-10-20T10:00:00Z' }], taken: 22 },
        }]);
        openSheet(window, 1);
        const titles = Array.from(sheet(document).querySelectorAll('.wg-meds-stock__history .wg-row__title')).map((t) => t.textContent);
        expect(titles).toHaveLength(3);
        expect(titles[0]).toMatch(/^−22 taken since /);
        expect(titles[1]).toMatch(/^\+30 · /);
        expect(titles[2]).toMatch(/^Counted 39 · /);
        expect(sheet(document).querySelector('.wg-meds-stock__history .wg-hint').textContent).toBe("Something wrong? Add a new count. History isn't edited.");
    });
});

// My meds app-bar sub (bd med-5uwb.2): "N meds · R need(s) a refill", R being
// the list's own Needs a refill group (groupMyMeds — archived meds never
// count); the Timeline keeps "N active · …".
describe('My meds app-bar sub (MY1)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.sessionStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    const med = (id, count, extra = {}) => ({ id, name: `Med ${id}`, schedule: DAILY, archived: false, inventory_count: count, ...extra });

    it('reads "9 meds · 2 need a refill", "1 needs", "9 meds" with none; archived never count; Timeline unchanged', async () => {
        const { window, document } = env;
        const sub = document.querySelector('#meds-view [data-meds-sub]');
        window.sessionStorage.setItem('mt-meds-subtab', 'schedule');
        const fine = [3, 4, 5, 6, 7, 8, 9].map((id) => med(id, 60));
        const archivedOut = med(10, 0, { archived: true });

        await seedMedications(window, [med(1, 0), med(2, 3), ...fine, archivedOut]);
        expect(sub.textContent).toBe('9 meds · 2 need a refill');

        await seedMedications(window, [med(1, 0), med(2, 60), ...fine, archivedOut]);
        expect(sub.textContent).toBe('9 meds · 1 needs a refill');

        await seedMedications(window, [med(1, 60), med(2, 60), ...fine, archivedOut]);
        expect(sub.textContent).toBe('9 meds');

        await seedMedications(window, [med(1, 60)]);
        expect(sub.textContent).toBe('1 med');

        window.sessionStorage.setItem('mt-meds-subtab', 'timeline');
        await seedMedications(window, [med(1, 0), med(2, 3)]);
        expect(sub.textContent).toMatch(/^2 active/);
        expect(sub.textContent).not.toMatch(/refill/);
    });
});
