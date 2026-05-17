// Direct tests for the shared `undoFoodAIItems` helper extracted from
// features/food/photo.js into features/food/ai-undo.js. The helper is shared
// by the food-photo flow and (post-Task 4) the food-description AI flow, so
// exercising it independently of the photo upload path gives the description
// flow a coverage entry point and pins the cross-flow contract.
//
// Covers:
//   1. Success path: every DELETE returns ok → cache invalidated, list
//      refresh fired, summary card transitions to "Removed N items".
//   2. Partial failure: one DELETE fails → summary card transitions to its
//      retry-able error state. The retry callback supplied to showError must
//      only re-attempt the items that haven't already been deleted.
//   3. All-failure: every DELETE fails → summary card still transitions to
//      the error state with a retry callback. Cache invalidation must NOT
//      run when nothing was actually deleted server-side.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

const SAMPLE_ITEMS = [
    { id: 11, name: 'Oatmeal', weight: 80,  carbs: 50, protein: 10, fat: 5, calories: 280 },
    { id: 12, name: 'Banana',  weight: 120, carbs: 27, protein: 1,  fat: 0, calories: 105 },
];

describe('undoFoodAIItems (shared food-AI undo helper)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();

        env.window.userInitData = '';
        env.window.loadFoodLogs = vi.fn();
        env.window.loadToday = vi.fn();
        env.window.DataStore = env.window.DataStore || {};
        env.window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
        env.window.DataStore.clearCached = vi.fn().mockResolvedValue(undefined);
        env.window.DataStore.advanceCursorSilently = vi.fn();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('is exposed as a global function loaded ahead of photo.js', () => {
        expect(typeof env.window.undoFoodAIItems).toBe('function');
        // Backwards-compat shim: window.FoodPhoto.undo points at the same fn.
        expect(env.window.FoodPhoto.undo).toBe(env.window.undoFoodAIItems);
    });

    it('success path: deletes every item, invalidates caches, calls summary.showRemoved', async () => {
        const { window } = env;

        window.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            async json() { return {}; },
            async text() { return ''; },
        });

        const summary = {
            showRemoved: vi.fn(),
            showError: vi.fn(),
        };

        await window.undoFoodAIItems(SAMPLE_ITEMS, summary);
        await flushPromises();

        // One DELETE per item, with the correct URLs.
        const deleteCalls = window.fetch.mock.calls.filter(
            ([, opts]) => opts && opts.method === 'DELETE',
        );
        expect(deleteCalls.length).toBe(SAMPLE_ITEMS.length);
        const urls = deleteCalls.map(([url]) => url).sort();
        expect(urls).toEqual(['/api/food/log/11', '/api/food/log/12']);

        // Cache invalidation + list refresh fired on the success path.
        expect(window.DataStore.invalidateTags).toHaveBeenCalledWith(['food']);
        expect(window.DataStore.advanceCursorSilently).toHaveBeenCalled();
        expect(window.loadFoodLogs).toHaveBeenCalled();
        expect(window.loadToday).toHaveBeenCalled();

        // Summary card flipped to the success state with the full count.
        expect(summary.showRemoved).toHaveBeenCalledWith(SAMPLE_ITEMS.length);
        expect(summary.showError).not.toHaveBeenCalled();
    });

    it('partial failure: summary.showError called and retry only re-attempts failed items', async () => {
        const { window } = env;

        let firstRound = true;
        window.fetch = vi.fn().mockImplementation((url) => {
            // First round: id 12 fails, id 11 succeeds.
            // Retry round: id 12 should now succeed; id 11 must NOT be re-issued
            // (already deleted server-side; re-deleting would 500).
            if (firstRound && url === '/api/food/log/12') {
                return Promise.resolve({ ok: false, status: 500, async text() { return ''; }, async json() { return {}; } });
            }
            return Promise.resolve({ ok: true, status: 200, async text() { return ''; }, async json() { return {}; } });
        });

        const summary = {
            showRemoved: vi.fn(),
            showError: vi.fn(),
        };

        await window.undoFoodAIItems(SAMPLE_ITEMS, summary);
        await flushPromises();

        // Two DELETEs in the first round; partial failure surfaces showError
        // with a retry handler.
        let deleteCalls = window.fetch.mock.calls.filter(([, opts]) => opts && opts.method === 'DELETE');
        expect(deleteCalls.length).toBe(2);
        expect(summary.showError).toHaveBeenCalledTimes(1);
        expect(summary.showError.mock.calls[0][0]).toMatch(/could not undo/i);
        const retry = summary.showError.mock.calls[0][1];
        expect(typeof retry).toBe('function');

        // Cache invalidation still ran because at least one DELETE succeeded.
        expect(window.DataStore.invalidateTags).toHaveBeenCalledWith(['food']);

        // Drive the retry: only id 12 should be re-attempted.
        firstRound = false;
        summary.showRemoved.mockClear();
        summary.showError.mockClear();

        await retry();
        await flushPromises();

        deleteCalls = window.fetch.mock.calls.filter(([, opts]) => opts && opts.method === 'DELETE');
        expect(deleteCalls.length).toBe(3); // 2 from initial + 1 retry
        expect(deleteCalls[2][0]).toBe('/api/food/log/12');

        // After successful retry, showRemoved is called with the ORIGINAL
        // total count, not the count of items attempted in the retry round.
        expect(summary.showRemoved).toHaveBeenCalledWith(SAMPLE_ITEMS.length);
        expect(summary.showError).not.toHaveBeenCalled();
    });

    it('all-failure: showError fires with retry callback; cache not invalidated', async () => {
        const { window } = env;

        window.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            async json() { return {}; },
            async text() { return ''; },
        });

        const summary = {
            showRemoved: vi.fn(),
            showError: vi.fn(),
        };

        await window.undoFoodAIItems(SAMPLE_ITEMS, summary);
        await flushPromises();

        const deleteCalls = window.fetch.mock.calls.filter(([, opts]) => opts && opts.method === 'DELETE');
        expect(deleteCalls.length).toBe(SAMPLE_ITEMS.length);

        // Nothing was actually deleted server-side, so no cache work and no
        // list refresh should fire.
        expect(window.DataStore.invalidateTags).not.toHaveBeenCalled();
        expect(window.loadFoodLogs).not.toHaveBeenCalled();
        expect(window.loadToday).not.toHaveBeenCalled();

        expect(summary.showRemoved).not.toHaveBeenCalled();
        expect(summary.showError).toHaveBeenCalledTimes(1);
        expect(typeof summary.showError.mock.calls[0][1]).toBe('function');
    });

    it('empty input is a no-op (no fetch, no summary callbacks)', async () => {
        const { window } = env;
        window.fetch = vi.fn();

        const summary = { showRemoved: vi.fn(), showError: vi.fn() };

        await window.undoFoodAIItems([], summary);
        await window.undoFoodAIItems(null, summary);

        expect(window.fetch).not.toHaveBeenCalled();
        expect(summary.showRemoved).not.toHaveBeenCalled();
        expect(summary.showError).not.toHaveBeenCalled();
    });
});
