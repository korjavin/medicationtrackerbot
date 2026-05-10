// Friendly food-photo flow — Task 4: wiring the summary card + Undo into
// the photo upload path.
//
// Pins three behaviours:
//
//   1. A successful POST /api/food/log/from-photo no longer triggers a
//      browser alert. Instead, the in-app `showFoodPhotoSummary` card
//      renders with one row per parsed item.
//   2. Clicking Undo issues a DELETE for every item (one fetch per id,
//      in parallel) and then swaps the card content to a "Removed N items"
//      success message.
//   3. If any DELETE fails, the card swaps to the error state with a
//      Retry button instead of the success message.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeFakeImageFile(env, name = 'food.jpg') {
    // Use the JSDOM window's File constructor so the resulting object is
    // recognised as a Blob by that window's FormData implementation. A File
    // built from the host (Node) realm is treated as a foreign object and
    // FormData.append rejects it with "parameter 2 is not of type 'Blob'".
    const W = env.window;
    return new W.File([new W.Blob(['x'])], name, { type: 'image/jpeg' });
}

function attachFile(input, file) {
    Object.defineProperty(input, 'files', {
        configurable: true,
        get: () => [file],
    });
}

const SAMPLE_ITEMS = [
    { id: 11, name: 'Oatmeal', weight: 80,  carbs: 50, protein: 10, fat: 5, calories: 280 },
    { id: 12, name: 'Banana',  weight: 120, carbs: 27, protein: 1,  fat: 0, calories: 105 },
];

describe('uploadFoodPhoto + Undo (friendly food-photo flow, Task 4)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();

        // food.js refers to these directly; stub them so the upload path
        // doesn't blow up on cache invalidation / list refresh during tests.
        env.window.userInitData = '';
        env.window.loadFoodLogs = vi.fn();
        env.window.loadToday = vi.fn();
        env.window.DataStore = env.window.DataStore || {};
        env.window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
        env.window.DataStore.clearCached = vi.fn().mockResolvedValue(undefined);
        env.window.DataStore.advanceCursorSilently = vi.fn();
    });

    afterEach(() => {
        try {
            env.document.querySelectorAll('.wg-food-photo-summary').forEach((el) => el.remove());
            env.window.localStorage.clear();
        } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('successful upload renders the summary card and does not trigger a browser alert', async () => {
        const { document, window } = env;

        const alertSpy = vi.fn();
        window.alert = alertSpy;
        window.safeAlert = alertSpy;
        if (window.Telegram && window.Telegram.WebApp) {
            window.Telegram.WebApp.showAlert = alertSpy;
        }

        window.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            async json() { return { items: SAMPLE_ITEMS }; },
            async text() { return JSON.stringify({ items: SAMPLE_ITEMS }); },
        });

        const input = document.getElementById('food-photo-input');
        attachFile(input, makeFakeImageFile(env));

        await window.uploadFoodPhoto(input);
        await flushPromises();

        expect(alertSpy).not.toHaveBeenCalled();

        const card = document.querySelector('.wg-food-photo-summary');
        expect(card).not.toBeNull();

        const rows = card.querySelectorAll('.wg-food-photo-summary__item');
        expect(rows.length).toBe(SAMPLE_ITEMS.length);

        // Total kcal sum is rendered in the totals row.
        const totalsKcal = card.querySelector('.wg-food-photo-summary__totals-kcal');
        expect(totalsKcal.textContent).toBe('385 kcal');
    });

    it('clicking Undo issues a DELETE for every item and swaps card to "Removed N items"', async () => {
        const { document, window } = env;

        const fetchSpy = vi.fn().mockImplementation((url, opts) => {
            return Promise.resolve({
                ok: true,
                status: 200,
                async json() {
                    if (opts && opts.method === 'POST') return { items: SAMPLE_ITEMS };
                    return {};
                },
                async text() {
                    if (opts && opts.method === 'POST') return JSON.stringify({ items: SAMPLE_ITEMS });
                    return '';
                },
            });
        });
        window.fetch = fetchSpy;

        const input = document.getElementById('food-photo-input');
        attachFile(input, makeFakeImageFile(env));
        await window.uploadFoodPhoto(input);
        await flushPromises();

        // One fetch so far: the POST upload.
        const postCalls = fetchSpy.mock.calls.filter(
            ([, opts]) => opts && opts.method === 'POST',
        );
        expect(postCalls.length).toBe(1);

        const card = document.querySelector('.wg-food-photo-summary');
        const undoBtn = card.querySelector('.wg-food-photo-summary__undo');
        expect(undoBtn).not.toBeNull();

        // Reset the refresh spies — the upload already called them once on
        // success; we want to confirm the Undo success path calls them again.
        window.loadFoodLogs.mockClear();
        window.loadToday.mockClear();

        undoBtn.click();
        // The Undo handler is async (await Promise.all of N deletes); flush
        // microtasks twice so all of: the click handler, Promise.all, and
        // the cache invalidation promises resolve before we assert.
        await flushPromises();
        await flushPromises();

        const deleteCalls = fetchSpy.mock.calls.filter(
            ([, opts]) => opts && opts.method === 'DELETE',
        );
        expect(deleteCalls.length).toBe(SAMPLE_ITEMS.length);
        // URLs include the item ids (one per item).
        const urls = deleteCalls.map(([url]) => url).sort();
        expect(urls).toEqual([
            '/api/food/log/11',
            '/api/food/log/12',
        ]);

        // Card transitioned to the success state — items rows are gone, a
        // single "Removed 2 items" message took their place. The Close
        // button (in the header) is still there so the user can dismiss.
        const stillCard = document.querySelector('.wg-food-photo-summary');
        expect(stillCard).not.toBeNull();
        expect(stillCard.querySelector('.wg-food-photo-summary__items')).toBeNull();
        const message = stillCard.querySelector('.wg-food-photo-summary__message');
        expect(message).not.toBeNull();
        expect(message.textContent).toBe('Removed 2 items');
        expect(stillCard.querySelector('.wg-food-photo-summary__close')).not.toBeNull();

        // Food list + Today refresh on Undo success.
        expect(window.loadFoodLogs).toHaveBeenCalled();
        expect(window.loadToday).toHaveBeenCalled();
    });

    it('partial Undo failure puts the card into the error state with a Retry button', async () => {
        const { document, window } = env;

        const fetchSpy = vi.fn().mockImplementation((url, opts) => {
            if (opts && opts.method === 'POST') {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    async json() { return { items: SAMPLE_ITEMS }; },
                    async text() { return JSON.stringify({ items: SAMPLE_ITEMS }); },
                });
            }
            // First DELETE fails; second succeeds — partial failure must
            // surface as the error state, not a half-success.
            if (opts && opts.method === 'DELETE') {
                if (url === '/api/food/log/11') {
                    return Promise.resolve({ ok: false, status: 500, async text() { return ''; }, async json() { return {}; } });
                }
                return Promise.resolve({ ok: true, status: 200, async text() { return ''; }, async json() { return {}; } });
            }
            return Promise.resolve({ ok: true, status: 200, async text() { return ''; }, async json() { return {}; } });
        });
        window.fetch = fetchSpy;

        const input = document.getElementById('food-photo-input');
        attachFile(input, makeFakeImageFile(env));
        await window.uploadFoodPhoto(input);
        await flushPromises();

        const card = document.querySelector('.wg-food-photo-summary');
        const undoBtn = card.querySelector('.wg-food-photo-summary__undo');

        // Reset the refresh spies so we can assert the failed-Undo path
        // does NOT trigger an additional refresh.
        window.loadFoodLogs.mockClear();
        window.loadToday.mockClear();

        undoBtn.click();
        await flushPromises();
        await flushPromises();

        const stillCard = document.querySelector('.wg-food-photo-summary');
        expect(stillCard).not.toBeNull();

        const errorMsg = stillCard.querySelector('.wg-food-photo-summary__message--error');
        expect(errorMsg).not.toBeNull();
        expect(errorMsg.textContent).toMatch(/could not undo/i);

        const retry = stillCard.querySelector('.wg-food-photo-summary__retry');
        expect(retry).not.toBeNull();

        // The food list is NOT re-refreshed on a failed Undo: the items
        // are still in the DB, so the list is already correct.
        expect(window.loadFoodLogs).not.toHaveBeenCalled();
    });
});
