// Meds Stock sub-tab (kit v2 M3, med-xso6.18; Phase 5 Task 6 before it).
//
// Exercises renderInventory(): one `.wg-card.wg-meds-stock__card` per
// medication that tracks inventory, out/low first, a "N a day · lasts N days"
// meta line, Out/Low chips, the last-refilled line from
// `/api/medications/{id}/restocks`, and the Refill panel (preset `.wg-pick`
// chips + an "Other" stepper; the primary previews "Add N → total") writing
// through DataStore.applyOptimistic on the existing `/restock` route.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const DAILY = JSON.stringify({ type: 'daily', times: ['08:00'] });

async function seedMedications(window, meds) {
    window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh(meds);
    });
    // Baseline apiCall stub; individual tests override with specific behavior.
    window.apiCall = vi.fn().mockResolvedValue([]);
    await window.loadMeds();
}

async function flushMicrotasks() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

const cardOf = (document, id) => document.querySelector(`.wg-meds-stock__card[data-med-id="${id}"]`);

describe('Meds Stock sub-tab (kit v2 M3)', () => {
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
        expect(tab).not.toBeNull();
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
        expect(list.classList.contains('wg-meds-stock')).toBe(true);
        const empty = list.querySelector('.wg-empty');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toMatch(/no inventory tracked/i);
        expect(list.querySelector('.wg-meds-stock__card')).toBeNull();
    });

    it('sorts out → low → ok (then by name) and shows Out / Low chips', async () => {
        const { window, document } = env;
        await seedMedications(window, [
            { id: 1, name: 'Allopurinol', dosage: '100mg', schedule: DAILY, archived: false, inventory_count: 60 },
            { id: 2, name: 'Bisoprolol', dosage: '5mg', schedule: DAILY, archived: false, inventory_count: 3 },
            { id: 3, name: 'Candesartan', dosage: '8mg', schedule: DAILY, archived: false, inventory_count: 0 },
            { id: 4, name: 'Metformin', dosage: '500mg', schedule: DAILY, archived: false, inventory_count: null }
        ]);
        window.renderInventory();

        const cards = Array.from(document.querySelectorAll('.wg-meds-stock__card'));
        expect(cards.map((c) => c.dataset.medId)).toEqual(['3', '2', '1']);
        expect(cards.map((c) => c.dataset.stock)).toEqual(['danger', 'warn', 'ok']);
        cards.forEach((c) => expect(c.classList.contains('wg-card')).toBe(true));
        expect(cards[0].classList.contains('wg-card--danger')).toBe(true);

        const chip = (c) => c.querySelector('.wg-meds-stock__chip');
        expect(chip(cards[0]).textContent).toBe('Out');
        expect(chip(cards[0]).classList.contains('wg-chip--danger')).toBe(true);
        expect(chip(cards[1]).textContent).toBe('Low');
        expect(chip(cards[1]).classList.contains('wg-chip--warn')).toBe(true);
        expect(chip(cards[2])).toBeNull();

        expect(cards[2].querySelector('.wg-meds-stock__name').textContent).toBe('Allopurinol · 100mg');
        const count = cards[2].querySelector('.wg-meds-stock__count');
        expect(count.classList.contains('wg-stat__value')).toBe(true);
        expect(count.textContent).toBe('60doses');
    });

    it('meta line reads usage and how long the stock lasts', async () => {
        const { window, document } = env;
        await seedMedications(window, [
            { id: 1, name: 'Aspirin', schedule: JSON.stringify({ type: 'daily', times: ['08:00', '20:00'] }), archived: false, inventory_count: 20 },
            { id: 2, name: 'Vitamin D', schedule: DAILY, archived: false, inventory_count: 1 },
            { id: 3, name: 'Ibuprofen', schedule: JSON.stringify({ type: 'as_needed' }), archived: false, inventory_count: 12 }
        ]);
        window.renderInventory();
        const meta = (id) => cardOf(document, id).querySelector('.wg-meds-stock__meta').textContent;
        expect(meta('1')).toBe('2 a day · lasts 10 days');
        expect(meta('2')).toBe('1 a day · lasts 1 day');
        expect(meta('3')).toBe('As needed');
    });

    it('negative stock shows 0 doses and how many doses were logged beyond stock', async () => {
        const { window, document } = env;
        await seedMedications(window, [
            { id: 1, name: 'Aspirin', dosage: '100mg', schedule: DAILY, archived: false, inventory_count: -17 }
        ]);
        window.renderInventory();
        const card = cardOf(document, '1');
        expect(card.querySelector('.wg-meds-stock__count').firstChild.textContent).toBe('0');
        expect(card.querySelector('.wg-meds-stock__meta').textContent).toBe('Logged 17 doses beyond stock');
        expect(card.querySelector('.wg-meds-stock__chip').textContent).toBe('Out');
    });

    it('shows "Last refilled" from the newest /restocks row; stays hidden without one', async () => {
        const { window, document } = env;
        await seedMedications(window, [
            { id: 1, name: 'Allopurinol', schedule: DAILY, archived: false, inventory_count: 60 },
            { id: 2, name: 'Bisoprolol', schedule: DAILY, archived: false, inventory_count: 60 }
        ]);
        window.apiCall = vi.fn(async (endpoint) => (endpoint === '/api/medications/1/restocks'
            ? [
                { id: 10, medication_id: 1, quantity: 30, restocked_at: '2026-04-10T12:00:00Z' },
                { id: 11, medication_id: 1, quantity: 60, restocked_at: '2026-04-18T12:00:00Z' }
            ]
            : []));
        window.renderInventory();

        const refilled1 = cardOf(document, '1').querySelector('.wg-meds-stock__refilled');
        expect(refilled1.hidden).toBe(true);
        await flushMicrotasks();

        expect(window.apiCall).toHaveBeenCalledWith('/api/medications/1/restocks');
        expect(refilled1.hidden).toBe(false);
        expect(refilled1.textContent).toMatch(/^Last refilled \S/);
        expect(cardOf(document, '2').querySelector('.wg-meds-stock__refilled').hidden).toBe(true);
    });

    it('Refill opens preset picks (+30 default); picking updates the "Add N → total" primary; Other shows the stepper', async () => {
        const { window, document } = env;
        await seedMedications(window, [
            { id: 1, name: 'Allopurinol', schedule: DAILY, archived: false, inventory_count: 17 }
        ]);
        window.renderInventory();

        const card = cardOf(document, '1');
        const refillBtn = card.querySelector('.wg-meds-stock__refill-btn');
        const panel = card.querySelector('.wg-meds-stock__refill');
        const confirm = panel.querySelector('.wg-meds-stock__confirm');
        expect(panel.hidden).toBe(true);

        refillBtn.click();
        expect(panel.hidden).toBe(false);
        expect(refillBtn.hidden).toBe(true);

        const picks = Array.from(panel.querySelectorAll('.wg-picks .wg-pick'));
        expect(picks.map((p) => p.textContent)).toEqual(['+30', '+60', '+90', 'Other']);
        expect(picks[0].getAttribute('aria-pressed')).toBe('true');
        expect(confirm.textContent).toBe('Add 30 → 47');

        picks[1].click();
        expect(picks[1].getAttribute('aria-pressed')).toBe('true');
        expect(picks[0].getAttribute('aria-pressed')).toBe('false');
        expect(confirm.textContent).toBe('Add 60 → 77');

        const stepper = panel.querySelector('.wg-meds-stock__stepper');
        expect(stepper.hidden).toBe(true);
        picks[3].click();
        expect(stepper.hidden).toBe(false);
        const input = stepper.querySelector('.wg-meds-stock__qty');
        expect(input.value).toBe('60');
        stepper.querySelector('[aria-label="Increase"]').click();
        expect(confirm.textContent).toBe('Add 61 → 78');

        input.value = '0';
        input.dispatchEvent(new window.Event('input'));
        expect(confirm.disabled).toBe(true);

        panel.querySelector('.wg-meds-stock__cancel').click();
        expect(panel.hidden).toBe(true);
        expect(refillBtn.hidden).toBe(false);
    });

    it('confirm writes optimistically, POSTs the existing /restock route, and commits', async () => {
        const { window, document } = env;
        await seedMedications(window, [
            { id: 1, name: 'Allopurinol', schedule: DAILY, archived: false, inventory_count: 17 }
        ]);
        const handle = { commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };
        const applySpy = vi.spyOn(window.DataStore, 'applyOptimistic').mockResolvedValue(handle);
        let posted = null;
        window.apiCall = vi.fn(async (endpoint, method, body) => {
            if (endpoint.endsWith('/restock') && method === 'POST') {
                posted = { endpoint, body };
                return { status: 'restocked', quantity_added: body.quantity, inventory_count: 17 + body.quantity };
            }
            return [];
        });
        window.renderInventory();

        cardOf(document, '1').querySelector('.wg-meds-stock__refill-btn').click();
        cardOf(document, '1').querySelector('.wg-meds-stock__confirm').click();
        await flushMicrotasks();

        expect(applySpy).toHaveBeenCalledWith('medications', expect.any(Function), ['medications']);
        const mutator = applySpy.mock.calls[0][1];
        expect(mutator([{ id: 1, inventory_count: 17 }, { id: 2, inventory_count: 5 }]))
            .toEqual([{ id: 1, inventory_count: 47 }, { id: 2, inventory_count: 5 }]);
        expect(posted).toEqual({ endpoint: '/api/medications/1/restock', body: { quantity: 30 } });
        expect(handle.commit).toHaveBeenCalled();
        expect(handle.rollback).not.toHaveBeenCalled();
        expect(cardOf(document, '1').querySelector('.wg-meds-stock__count').firstChild.textContent).toBe('47');
    });

    it('a failed restock rolls the optimistic count back', async () => {
        const { window, document } = env;
        await seedMedications(window, [
            { id: 1, name: 'Allopurinol', schedule: DAILY, archived: false, inventory_count: 17 }
        ]);
        const handle = { commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };
        vi.spyOn(window.DataStore, 'applyOptimistic').mockResolvedValue(handle);
        window.apiCall = vi.fn(async (endpoint, method) => (method === 'POST' ? null : []));
        window.renderInventory();

        cardOf(document, '1').querySelector('.wg-meds-stock__refill-btn').click();
        cardOf(document, '1').querySelector('.wg-meds-stock__confirm').click();
        await flushMicrotasks();

        expect(handle.rollback).toHaveBeenCalled();
        expect(handle.commit).not.toHaveBeenCalled();
        expect(cardOf(document, '1').querySelector('.wg-meds-stock__count').firstChild.textContent).toBe('17');
    });
});
