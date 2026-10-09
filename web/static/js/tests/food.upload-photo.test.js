// Photo flow (kit F6, med-xso6.17): a picked photo is parsed (dry run)
// into the Add sheet's review pane; nothing is logged until Log is pressed.
// Then the logged toast carries Undo.
//
// Pins:
//   1. upload → review pane lists the parsed items, no write yet; Log writes
//      them through CloudFoodAI.logParsedItems and shows the toast (no alert).
//   2. Clicking Undo issues a DELETE for every item and swaps the toast to
//      "Removed N items".
//   3. A partial Undo failure leaves the danger toast with Retry, and Retry
//      only re-attempts the failed items.

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

// What the dry-run parse returns (web/domain/foodai.js previewParsedMeal).
const SAMPLE_PREVIEW = [
    { name: 'Oatmeal', weight: 80,  carbs: 50, protein: 10, fat: 5, calories: 280, carbs_100g: 62, protein_100g: 12, fat_100g: 6, uncertain: false },
    { name: 'Banana',  weight: 120, carbs: 27, protein: 1,  fat: 0, calories: 105, carbs_100g: 22, protein_100g: 1, fat_100g: 0, uncertain: true },
];

// What logParsedItems returns once saved.
const SAMPLE_ITEMS = [
    { id: 11, name: 'Oatmeal', weight: 80,  carbs: 50, protein: 10, fat: 5, calories: 280 },
    { id: 12, name: 'Banana',  weight: 120, carbs: 27, protein: 1,  fat: 0, calories: 105 },
];

function makeCloudFoodAI() {
    return {
        parseMealFromPhoto: vi.fn(async () => ({ status: 'parsed', items: SAMPLE_PREVIEW.map((it) => ({ ...it })) })),
        logParsedItems: vi.fn(async () => ({ items: SAMPLE_ITEMS, failed: 0 })),
    };
}

async function settle() {
    for (let i = 0; i < 6; i++) await flushPromises();
}

// Pick a photo, wait for the review pane, press Log.
async function uploadAndLog(env) {
    const { document, window } = env;
    const input = document.getElementById('food-photo-input');
    attachFile(input, makeFakeImageFile(env));
    await window.uploadFoodPhoto(input);
    await settle();
    document.getElementById('food-add-primary-btn').click();
    await settle();
}

describe('uploadFoodPhoto → review → Log + Undo (kit F6)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ withSync: true });

        // food.js refers to these directly; stub them so the upload path
        // doesn't blow up on cache invalidation / list refresh during tests.
        env.window.loadFoodLogs = vi.fn();
        env.window.loadToday = vi.fn();
        env.window.DataStore = env.window.DataStore || {};
        env.window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
        env.window.DataStore.clearCached = vi.fn().mockResolvedValue(undefined);
    });

    afterEach(() => {
        try {
            env.document.querySelectorAll('.wg-food-photo-summary').forEach((el) => el.remove());
            env.window.localStorage.clear();
        } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('upload shows the review pane and logs nothing until Log is pressed', async () => {
        const { document, window } = env;

        const alertSpy = vi.fn();
        window.safeAlert = alertSpy;
        const ai = makeCloudFoodAI();
        window.CloudFoodAI = ai;
        const apiSpy = vi.fn(async () => []);
        window.apiCall = apiSpy;

        const input = document.getElementById('food-photo-input');
        attachFile(input, makeFakeImageFile(env));
        await window.uploadFoodPhoto(input);
        await settle();

        // Parsed as a dry run; the review pane is up with one row per item.
        expect(ai.parseMealFromPhoto).toHaveBeenCalledTimes(1);
        expect(ai.parseMealFromPhoto.mock.calls[0][1]).toMatchObject({ dryRun: true });
        const sheet = document.getElementById('food-add-sheet');
        expect(sheet.classList.contains('hidden')).toBe(false);
        expect(sheet.dataset.view).toBe('review');
        const rows = document.querySelectorAll('#food-add-review-list .wg-food-add__review-row');
        expect(rows).toHaveLength(2);
        expect(rows[0].textContent).toContain('Oatmeal');
        // The uncertain row carries the warn chip; the sure one does not.
        expect(rows[0].textContent).not.toContain('estimate');
        expect(rows[1].textContent).toContain('estimate');
        expect(document.getElementById('food-add-primary-btn').textContent).toBe('Log 2 items');

        // Nothing written yet: no save, no write call, no toast.
        expect(ai.logParsedItems).not.toHaveBeenCalled();
        expect(apiSpy.mock.calls.filter(([, m]) => m && m !== 'GET')).toEqual([]);
        expect(document.querySelector('.wg-food-photo-summary')).toBeNull();

        document.getElementById('food-add-primary-btn').click();
        await settle();

        expect(ai.logParsedItems).toHaveBeenCalledTimes(1);
        const [items, opts] = ai.logParsedItems.mock.calls[0];
        expect(items.map((it) => it.name)).toEqual(['Oatmeal', 'Banana']);
        expect(typeof opts.eatenAt).toBe('number');
        expect(sheet.classList.contains('hidden')).toBe(true);
        expect(alertSpy).not.toHaveBeenCalled();

        const card = document.querySelector('.wg-food-photo-summary');
        expect(card).not.toBeNull();
        // The standard toast (med-xso6.5): item count + kcal total.
        expect(card.classList.contains('wg-toast')).toBe(true);
        expect(card.querySelector('.wg-toast__text').firstChild.textContent).toBe('2 items logged');
        expect(card.querySelector('.wg-toast__text small').textContent).toBe('385 kcal · from photo');
    });

    it('Discard closes the review without logging anything', async () => {
        const { document, window } = env;
        const ai = makeCloudFoodAI();
        window.CloudFoodAI = ai;
        window.apiCall = vi.fn(async () => []);

        const input = document.getElementById('food-photo-input');
        attachFile(input, makeFakeImageFile(env));
        await window.uploadFoodPhoto(input);
        await settle();

        document.getElementById('food-add-discard-btn').click();
        await settle();

        expect(document.getElementById('food-add-sheet').classList.contains('hidden')).toBe(true);
        expect(ai.logParsedItems).not.toHaveBeenCalled();
        expect(document.querySelector('.wg-food-photo-summary')).toBeNull();
    });

    it('clicking Undo issues a DELETE for every item and swaps card to "Removed N items"', async () => {
        const { document, window } = env;

        const ai = makeCloudFoodAI();
        window.CloudFoodAI = ai;
        const apiSpy = vi.fn(async (url, method) => (method === 'DELETE' ? { status: 'deleted' } : []));
        window.apiCall = apiSpy;

        await uploadAndLog(env);

        // One AI parse + one save so far; no DELETEs yet.
        expect(ai.parseMealFromPhoto).toHaveBeenCalledTimes(1);
        expect(ai.logParsedItems).toHaveBeenCalledTimes(1);
        expect(apiSpy.mock.calls.filter(([, m]) => m === 'DELETE')).toEqual([]);

        const card = document.querySelector('.wg-food-photo-summary');
        const undoBtn = card.querySelector('.wg-toast__undo');
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

        const deleteCalls = apiSpy.mock.calls.filter(
            ([, method]) => method === 'DELETE',
        );
        expect(deleteCalls.length).toBe(SAMPLE_ITEMS.length);
        // URLs include the item ids (one per item).
        const urls = deleteCalls.map(([url]) => url).sort();
        expect(urls).toEqual([
            '/api/food/log/11',
            '/api/food/log/12',
        ]);

        // The logged toast was swapped for a "Removed 2 items" toast.
        const toasts = document.querySelectorAll('.wg-food-photo-summary');
        expect(toasts).toHaveLength(1);
        expect(toasts[0].querySelector('.wg-toast__text').textContent).toBe('Removed 2 items');

        // Food list + Today refresh on Undo success.
        expect(window.loadFoodLogs).toHaveBeenCalled();
        expect(window.loadToday).toHaveBeenCalled();
    });

    it('Retry after a partial Undo failure only re-attempts the failed items', async () => {
        const { document, window } = env;

        let firstDeleteRound = true;
        window.CloudFoodAI = makeCloudFoodAI();
        // First DELETE round: id 12 fails, id 11 succeeds.
        // Second DELETE round (Retry): only id 12 should be re-attempted,
        // and it should now succeed. If the retry path naively re-issues
        // a DELETE for id 11 (already deleted), the store would return
        // 500 and the user would be locked in error state forever.
        const apiSpy = vi.fn().mockImplementation((url, method) => {
            if (method === 'DELETE' && firstDeleteRound && url === '/api/food/log/12') {
                return Promise.resolve(null);
            }
            return Promise.resolve(method === 'DELETE' ? { status: 'deleted' } : []);
        });
        window.apiCall = apiSpy;

        await uploadAndLog(env);

        const card = document.querySelector('.wg-food-photo-summary');
        const undoBtn = card.querySelector('.wg-toast__undo');

        undoBtn.click();
        await flushPromises();
        await flushPromises();

        // Initial Undo round: 2 deletes, one of them failed.
        let deleteCalls = apiSpy.mock.calls.filter(([, method]) => method === 'DELETE');
        expect(deleteCalls.length).toBe(2);

        const retry = document.querySelector('.wg-food-photo-summary.wg-toast--danger .wg-toast__undo');
        expect(retry).not.toBeNull();

        // Now Retry: only the failed item (id 12) should be re-issued.
        firstDeleteRound = false;
        retry.click();
        await flushPromises();
        await flushPromises();

        deleteCalls = apiSpy.mock.calls.filter(([, method]) => method === 'DELETE');
        // Total calls: 2 from first round + 1 from retry (only id 12).
        expect(deleteCalls.length).toBe(3);
        expect(deleteCalls[2][0]).toBe('/api/food/log/12');

        // After successful retry, card transitions to the success message —
        // and reports the ORIGINAL total count, not the count of items
        // attempted in the final round.
        const message = document.querySelector('.wg-food-photo-summary .wg-toast__text');
        expect(message).not.toBeNull();
        expect(message.textContent).toBe('Removed 2 items');
    });

    it('partial Undo failure puts the card into the error state with a Retry button', async () => {
        const { document, window } = env;

        window.CloudFoodAI = makeCloudFoodAI();
        // First DELETE fails; second succeeds — partial failure must
        // surface as the error state, not a half-success.
        window.apiCall = vi.fn().mockImplementation((url, method) => {
            if (method === 'DELETE' && url === '/api/food/log/11') {
                return Promise.resolve(null);
            }
            return Promise.resolve(method === 'DELETE' ? { status: 'deleted' } : []);
        });

        await uploadAndLog(env);

        const card = document.querySelector('.wg-food-photo-summary');
        const undoBtn = card.querySelector('.wg-toast__undo');

        // Reset the refresh spies so we can assert the failed-Undo path
        // does NOT trigger an additional refresh.
        window.loadFoodLogs.mockClear();
        window.loadToday.mockClear();

        undoBtn.click();
        await flushPromises();
        await flushPromises();

        const stillCard = document.querySelector('.wg-food-photo-summary');
        expect(stillCard).not.toBeNull();

        const errorMsg = stillCard.classList.contains('wg-toast--danger') && stillCard.querySelector('.wg-toast__text');
        expect(errorMsg).not.toBeNull();
        expect(errorMsg.textContent).toMatch(/could not undo/i);

        const retry = stillCard.querySelector('.wg-toast__undo');
        expect(retry).not.toBeNull();

        // Partial failure: id 12 was deleted server-side while id 11 was not,
        // so the UI must refresh to drop the now-stale row. Otherwise the
        // user sees a row that no longer exists in the DB.
        expect(window.loadFoodLogs).toHaveBeenCalled();
    });
});
