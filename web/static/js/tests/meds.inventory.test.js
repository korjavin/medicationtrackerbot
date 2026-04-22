// Wandergeek Meds inventory sub-tab (Phase 5, Task 6).
//
// Exercises renderInventory(): one `.wg-card` per medication that tracks
// inventory (`inventory_count !== null`), large mono count display, low-stock
// alert pill driven by the existing `isLowOnStock()` classifier, last-refilled
// date sourced from `/api/medications/{id}/restocks`, the Refill flow (toggle
// inline input → POST to `/restock` → re-render with updated count), and the
// empty placeholder when no meds track inventory.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

async function seedMedications(window, meds) {
    window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh(meds);
    });
    // Baseline apiCall stub; individual tests override with specific behavior.
    window.apiCall = vi.fn().mockResolvedValue([]);
    await window.loadMeds();
}

async function flushMicrotasks() {
    // Drain microtasks and allow a macrotask tick so chained awaits
    // (including DataStore.invalidateTags subscribers) settle.
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
}

describe('Meds inventory sub-tab (Phase 5, Task 6)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renders empty placeholder when no medication tracks inventory', async () => {
        const { window, document } = env;

        await seedMedications(window, [
            { id: 1, name: 'Allopurinol', dosage: '100mg', schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }), archived: false, inventory_count: null }
        ]);

        window.renderInventory();

        const list = document.getElementById('med-inventory-list');
        expect(list.classList.contains('wg-meds-inventory')).toBe(true);
        const empty = list.querySelector('.wg-meds-inventory__empty');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toMatch(/no medications track inventory/i);
        expect(list.querySelector('.wg-meds-inventory__card')).toBeNull();
    });

    it('renders one .wg-card per tracked med with mono name, count, and count label', async () => {
        const { window, document } = env;

        window.apiCall = vi.fn().mockResolvedValue([]);
        await seedMedications(window, [
            { id: 1, name: 'Allopurinol', dosage: '100mg', schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }), archived: false, inventory_count: 30 },
            { id: 2, name: 'Bisoprolol', dosage: '5mg', schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }), archived: false, inventory_count: 12 },
            { id: 3, name: 'Metformin', dosage: '500mg', schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }), archived: false, inventory_count: null }
        ]);

        window.renderInventory();

        const cards = document.querySelectorAll('.wg-meds-inventory__card');
        expect(cards.length).toBe(2);

        // Alphabetical sort — Allopurinol before Bisoprolol.
        const firstName = cards[0].querySelector('.wg-meds-inventory__name');
        expect(firstName).not.toBeNull();
        expect(firstName.classList.contains('wg-mono-display')).toBe(true);
        expect(firstName.textContent).toBe('Allopurinol');

        const firstCount = cards[0].querySelector('.wg-meds-inventory__count');
        expect(firstCount).not.toBeNull();
        expect(firstCount.classList.contains('wg-mono-display')).toBe(true);
        expect(firstCount.textContent).toBe('30');

        const firstLabel = cards[0].querySelector('.wg-meds-inventory__count-label');
        expect(firstLabel).not.toBeNull();
        expect(firstLabel.textContent.toLowerCase()).toBe('left');

        // Dataset carries the med ID so DOM callers can correlate.
        expect(cards[0].dataset.medId).toBe('1');
        expect(cards[1].dataset.medId).toBe('2');
    });

    it('shows the .wg-tag--alert low-stock pill when isLowOnStock(med) returns true', async () => {
        const { window, document } = env;

        // 3 doses with a daily schedule @ 3 times/day => 1 day of stock; falls
        // below the 7-day threshold in isLowOnStock without an end date.
        await seedMedications(window, [
            { id: 1, name: 'Aspirin', dosage: '100mg', schedule: JSON.stringify({ type: 'daily', times: ['08:00', '14:00', '20:00'] }), archived: false, inventory_count: 3 },
            { id: 2, name: 'Vitamin D', dosage: '1000iu', schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }), archived: false, inventory_count: 90 }
        ]);

        window.renderInventory();

        const cards = document.querySelectorAll('.wg-meds-inventory__card');
        expect(cards.length).toBe(2);

        const aspirinCard = Array.from(cards).find((c) => c.dataset.medId === '1');
        const vitaminCard = Array.from(cards).find((c) => c.dataset.medId === '2');

        const aspirinLow = aspirinCard.querySelector('.wg-meds-inventory__low');
        expect(aspirinLow).not.toBeNull();
        expect(aspirinLow.classList.contains('wg-tag--alert')).toBe(true);
        expect(aspirinLow.classList.contains('wg-tag--mono')).toBe(true);

        const vitaminLow = vitaminCard.querySelector('.wg-meds-inventory__low');
        expect(vitaminLow).toBeNull();
    });

    it('resolves the last-refilled row from /restocks and renders a formatted date', async () => {
        const { window, document } = env;

        const restocksByMed = {
            1: [
                { id: 10, medication_id: 1, quantity: 30, restocked_at: '2026-04-10T12:00:00Z' },
                { id: 11, medication_id: 1, quantity: 60, restocked_at: '2026-04-18T12:00:00Z' }
            ]
        };

        await seedMedications(window, [
            { id: 1, name: 'Allopurinol', dosage: '100mg', schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }), archived: false, inventory_count: 60 }
        ]);

        // seedMedications installs a baseline apiCall stub; override it now so
        // the restocks fetch inside renderInventory returns our fixture.
        window.apiCall = vi.fn(async (endpoint) => {
            const match = /\/api\/medications\/(\d+)\/restocks/.exec(endpoint);
            if (match) return restocksByMed[match[1]] || [];
            return [];
        });

        window.renderInventory();

        // Pre-resolve: row shows the placeholder until the fetch settles.
        const card = document.querySelector('.wg-meds-inventory__card');
        const refilled = card.querySelector('.wg-meds-inventory__refilled');
        expect(refilled.textContent).toBe('Last refilled: —');

        await flushMicrotasks();

        expect(window.apiCall).toHaveBeenCalledWith('/api/medications/1/restocks');
        // Newest restock (2026-04-18) wins even if the fixture is older-first.
        expect(refilled.textContent).toMatch(/^Last refilled: /);
        expect(refilled.textContent).not.toBe('Last refilled: —');
    });

    it('leaves the placeholder when the /restocks call returns no entries', async () => {
        const { window, document } = env;

        window.apiCall = vi.fn(async () => []);

        await seedMedications(window, [
            { id: 1, name: 'Allopurinol', dosage: '100mg', schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }), archived: false, inventory_count: 30 }
        ]);

        window.renderInventory();

        await flushMicrotasks();

        const refilled = document.querySelector('.wg-meds-inventory__refilled');
        expect(refilled.textContent).toBe('Last refilled: —');
    });

    it('Refill button toggles the inline form, POSTs the quantity, and re-renders with the new count', async () => {
        const { window, document } = env;

        await seedMedications(window, [
            { id: 1, name: 'Allopurinol', dosage: '100mg', schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }), archived: false, inventory_count: 30 }
        ]);

        let postedEndpoint = null;
        let postedPayload = null;
        window.apiCall = vi.fn(async (endpoint, method, body) => {
            if (endpoint.endsWith('/restocks')) return [];
            if (endpoint.endsWith('/restock') && method === 'POST') {
                postedEndpoint = endpoint;
                postedPayload = body;
                return { status: 'restocked', quantity_added: body.quantity, inventory_count: 30 + body.quantity };
            }
            return [];
        });

        window.renderInventory();

        const card = document.querySelector('.wg-meds-inventory__card');
        const refillBtn = card.querySelector('.wg-meds-inventory__refill-btn');
        const form = card.querySelector('.wg-meds-inventory__refill-form');
        expect(form.hidden).toBe(true);

        refillBtn.click();
        expect(form.hidden).toBe(false);
        expect(refillBtn.hidden).toBe(true);

        const input = form.querySelector('.wg-meds-inventory__refill-input');
        input.value = '45';
        const confirmBtn = form.querySelector('.wg-meds-inventory__refill-confirm');
        confirmBtn.click();

        await flushMicrotasks();

        expect(postedEndpoint).toBe('/api/medications/1/restock');
        expect(postedPayload).toEqual({ quantity: 45 });

        // Re-render replaced the card; new count should reflect 30 + 45.
        const newCard = document.querySelector('.wg-meds-inventory__card');
        const newCount = newCard.querySelector('.wg-meds-inventory__count');
        expect(newCount.textContent).toBe('75');
    });

    it('Cancel button on the refill form hides it and restores the Refill trigger', async () => {
        const { window, document } = env;

        await seedMedications(window, [
            { id: 1, name: 'Allopurinol', dosage: '100mg', schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }), archived: false, inventory_count: 30 }
        ]);

        window.renderInventory();

        const card = document.querySelector('.wg-meds-inventory__card');
        const refillBtn = card.querySelector('.wg-meds-inventory__refill-btn');
        const form = card.querySelector('.wg-meds-inventory__refill-form');

        refillBtn.click();
        expect(form.hidden).toBe(false);

        const input = form.querySelector('.wg-meds-inventory__refill-input');
        input.value = '99';

        const cancelBtn = form.querySelector('.wg-meds-inventory__refill-cancel');
        cancelBtn.click();

        expect(form.hidden).toBe(true);
        expect(refillBtn.hidden).toBe(false);
        expect(input.value).toBe('');
    });

    it('Refill confirm rejects non-positive quantities without firing the POST', async () => {
        const { window, document } = env;

        await seedMedications(window, [
            { id: 1, name: 'Allopurinol', dosage: '100mg', schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }), archived: false, inventory_count: 30 }
        ]);

        const postSpy = vi.fn().mockResolvedValue({});
        window.apiCall = vi.fn(async (endpoint, method, body) => {
            if (endpoint.endsWith('/restocks')) return [];
            if (method === 'POST') return postSpy(endpoint, body);
            return [];
        });
        window.safeAlert = vi.fn();

        window.renderInventory();

        const refillBtn = document.querySelector('.wg-meds-inventory__refill-btn');
        refillBtn.click();
        const form = document.querySelector('.wg-meds-inventory__refill-form');
        const input = form.querySelector('.wg-meds-inventory__refill-input');
        const confirmBtn = form.querySelector('.wg-meds-inventory__refill-confirm');

        input.value = '0';
        confirmBtn.click();
        await flushMicrotasks();
        expect(postSpy).not.toHaveBeenCalled();

        input.value = '-5';
        confirmBtn.click();
        await flushMicrotasks();
        expect(postSpy).not.toHaveBeenCalled();
    });
});
