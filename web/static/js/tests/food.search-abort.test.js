// Food product search — debounce, requestId guards + eager cancellation.
//
// onFoodNameChange()/onFoodBarcodeChange() debounce 800ms, then deliver
// results via window.CloudFoodSearch (local first, remote merge on "Load
// more"). A newer search must:
//
//   1. leave fast successful searches untouched — results render with a
//      "Found N local result(s)" status,
//   2. win over a stale in-flight search — the late first result is
//      ignored via the requestId guard, never rendered over the new one,
//   3. eagerly abort the tracked AbortController so no async tail from the
//      stale query can autofill or render into the new one,
//   4. cancel a pending (not yet fired) debounce when the query is cleared,
//      matched exactly, or typed back to the previous completed query.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

// Installs a CloudFoodSearch stub; `searchImpl` receives (query, { remote }).
// remoteConfigured defaults to true so "Load more" reaches the remote search.
function installFoodSearch(window, searchImpl, { remoteConfigured = true } = {}) {
    const search = vi.fn(searchImpl);
    window.CloudFoodSearch = {
        search,
        remoteConfigured: vi.fn(async () => remoteConfigured),
    };
    return search;
}

async function flush(n = 30) {
    for (let i = 0; i < n; i++) await Promise.resolve();
}

describe('Food product search — debounce + stale-search guards', () => {
    let env;

    beforeEach(() => {
        vi.useFakeTimers();
        env = loadFrontendEnv();
    });

    afterEach(() => {
        vi.useRealTimers();
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renders results and clears state on a successful fast search', async () => {
        const { window, document } = env;

        const search = installFoodSearch(window, async () => [
            { id: 1, name: 'Apple', barcode: '123' },
        ]);

        document.getElementById('food-name').value = 'app';
        window.onFoodNameChange();

        // Run the 800ms debounce plus the search microtasks.
        await vi.advanceTimersByTimeAsync(850);
        await flush();

        expect(search).toHaveBeenCalledTimes(1);
        expect(search).toHaveBeenCalledWith('app', { remote: false });

        const status = document.getElementById('food-search-status');
        expect(status.textContent).toContain('result');
        expect(window.FoodProducts.suggestions.some((p) => p.name === 'Apple')).toBe(true);
    });

    it('a rapid second search wins; the stale first result is ignored, not rendered', async () => {
        const { window, document } = env;

        // First search hangs; second resolves immediately.
        const first = deferred();
        let callIdx = 0;
        const search = installFoodSearch(window, (query) => {
            callIdx += 1;
            if (callIdx === 1) return first.promise;
            return Promise.resolve([{ id: 2, name: 'Banana' }]);
        });

        document.getElementById('food-name').value = 'app';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(850);
        await flush(5);

        expect(search).toHaveBeenCalledTimes(1);

        // Type a new query before the first one finishes.
        document.getElementById('food-name').value = 'ban';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(850);
        await flush();

        expect(search).toHaveBeenCalledTimes(2);

        // The stale first search now resolves — the requestId guard must
        // drop it instead of rendering Apple over the Banana results.
        first.resolve([{ id: 1, name: 'Apple' }]);
        await flush();

        expect(window.FoodProducts.suggestions.some((p) => p.name === 'Banana')).toBe(true);
        expect(window.FoodProducts.suggestions.some((p) => p.name === 'Apple')).toBe(false);
        const status = document.getElementById('food-search-status');
        expect(status.textContent).toContain('result');
    });

    it('eagerly aborts the tracked controller when a rapid second search starts', async () => {
        const { window, document } = env;

        const first = deferred();
        let callIdx = 0;
        installFoodSearch(window, () => {
            callIdx += 1;
            if (callIdx === 1) return first.promise;
            return Promise.resolve([{ id: 2, name: 'Banana' }]);
        });

        document.getElementById('food-name').value = 'app';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(850);
        await flush(5);

        const firstController = window.FoodProducts._getAbortController();
        expect(firstController).not.toBeNull();
        expect(firstController.signal.aborted).toBe(false);

        // A new search starting aborts the stale controller outright —
        // proves no async tail from the old query survives.
        document.getElementById('food-name').value = 'ban';
        window.onFoodNameChange();
        await flush(5);

        expect(firstController.signal.aborted).toBe(true);
        first.resolve([]);
        await flush();
    });

    it('aborts the in-flight search when the user clears the query below 2 chars', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        const first = deferred();
        const search = installFoodSearch(window, () => first.promise);

        document.getElementById('food-name').value = 'appl';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(850);
        await flush(10);

        expect(search).toHaveBeenCalledTimes(1);
        const controller = window.FoodProducts._getAbortController();
        expect(controller.signal.aborted).toBe(false);

        // User clears the field below the 2-char threshold — the in-flight
        // search is now stale and must be cancelled (otherwise its eventual
        // completion would render suggestions back into an empty input).
        document.getElementById('food-name').value = 'a';
        window.onFoodNameChange();
        await flush(10);

        expect(controller.signal.aborted).toBe(true);

        // The stale search resolving late must not render.
        first.resolve([{ id: 1, name: 'Apple' }]);
        await vi.advanceTimersByTimeAsync(1000);
        await flush(10);
        expect(search).toHaveBeenCalledTimes(1);
        expect(window.FoodProducts.suggestions.some((p) => p.name === 'Apple')).toBe(false);

        // Status was reset (the too-short branch hides the chip). No stale
        // "Searching..." or "Found N result(s)" surfaces.
        const status = document.getElementById('food-search-status');
        expect(status.textContent).toBe('');
        expect(status.classList.contains('hidden')).toBe(true);
    });

    it('cancels a pending debounce when the user clears below 2 chars before it fires', async () => {
        const { window, document } = env;

        const search = installFoodSearch(window, async () => []);

        // Type a searchable query but clear before the 800ms debounce fires.
        document.getElementById('food-name').value = 'appl';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(200);

        document.getElementById('food-name').value = 'a';
        window.onFoodNameChange();

        // Advance past where the original debounce would have fired plus
        // some headroom — the pending search must have been cancelled, so
        // no search should be invoked for the stale query.
        await vi.advanceTimersByTimeAsync(2000);
        await flush(10);

        expect(search).not.toHaveBeenCalled();
    });

    it('cancels the in-flight search when the user types an exact suggestion match', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        // Seed the suggestions list so the exact-match branch in
        // onFoodNameChange triggers when the user finishes typing.
        window.FoodProducts.suggestions = [{
            id: 7, name: 'Apple Pie', carbs_100g: 0, protein_100g: 0,
            fat_100g: 0, energy_kcal_100g: 0
        }];

        const first = deferred();
        const search = installFoodSearch(window, () => first.promise);

        document.getElementById('food-name').value = 'appl';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(850);
        await flush(10);

        expect(search).toHaveBeenCalledTimes(1);
        const controller = window.FoodProducts._getAbortController();
        expect(controller.signal.aborted).toBe(false);

        // User finishes typing the suggestion's exact display name. The
        // selection-match branch must cancel the in-flight search so it
        // doesn't overwrite the autofill.
        document.getElementById('food-name').value = 'Apple Pie';
        window.onFoodNameChange();
        await flush(10);

        expect(controller.signal.aborted).toBe(true);
        first.resolve([{ id: 1, name: 'Apple' }]);
        await flush(10);
        expect(search).toHaveBeenCalledTimes(1);
        const status = document.getElementById('food-search-status');
        expect(status.textContent).toBe('Product selected.');
    });

    it('does not surface a failure status when a new search supersedes an in-flight remote loadMore', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        // First query: local resolves empty (auto-fires loadMore), remote hangs.
        const remote = deferred();
        const search = installFoodSearch(window, (query, { remote: isRemote } = {}) => {
            if (query === 'aaa' && !isRemote) return Promise.resolve([]);
            if (query === 'aaa' && isRemote) return remote.promise;
            return Promise.resolve([{ id: 9, name: 'Cherry' }]);
        });

        document.getElementById('food-name').value = 'aaa';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(850);
        await flush(20);

        // Local done (empty), remote in flight.
        expect(search).toHaveBeenCalledTimes(2);

        // User types a new query, then the stale remote resolves late.
        document.getElementById('food-name').value = 'bbb';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(850);
        await flush();
        remote.resolve([{ id: 99, name: 'Stale Remote' }]);
        await flush();

        const status = document.getElementById('food-search-status');
        expect(status.textContent).not.toContain('failed');
        expect(status.textContent).not.toContain('timed out');
        expect(window.FoodProducts.suggestions.some((p) => p.name === 'Cherry')).toBe(true);
        expect(window.FoodProducts.suggestions.some((p) => p.name === 'Stale Remote')).toBe(false);
    });

    it('cancels a pending debounce when the user types back to the previous completed query', async () => {
        const { window, document } = env;

        // Step 1: search for "apple" so its results are committed and
        // lastQuery becomes "apple".
        const search = installFoodSearch(window, async (query) => {
            if (query === 'apple') {
                return [{ id: 1, name: 'Apple', carbs_100g: 0, protein_100g: 0, fat_100g: 0, energy_kcal_100g: 0 }];
            }
            // Would-be banana search — marker data to detect leakage.
            return [{ id: 99, name: 'Banana', carbs_100g: 0, protein_100g: 0, fat_100g: 0, energy_kcal_100g: 0 }];
        });

        document.getElementById('food-name').value = 'apple';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(850);
        await flush();

        expect(window.FoodProducts._getLastQuery()).toBe('apple');
        expect(window.FoodProducts.suggestions.some((p) => p.name === 'Apple')).toBe(true);
        const searchCountAfterApple = search.mock.calls.length;

        // Step 2: type "banana" — this schedules a new debounce.
        document.getElementById('food-name').value = 'banana';
        window.onFoodNameChange();
        // Only advance partway through the debounce so it has not fired yet.
        await vi.advanceTimersByTimeAsync(200);

        // Step 3: type back to "apple" before the banana debounce fires.
        // The early-return "same as last query" branch must cancel the
        // pending banana debounce — otherwise it fires after 600ms more,
        // renders banana suggestions, and overwrites lastQuery to "banana".
        document.getElementById('food-name').value = 'apple';
        window.onFoodNameChange();

        // Let any leaked debounce fire and complete.
        await vi.advanceTimersByTimeAsync(2000);
        await flush();

        // No additional search for the banana query was issued.
        expect(search.mock.calls.length).toBe(searchCountAfterApple);
        // lastQuery still reflects "apple" — the banana debounce did not run.
        expect(window.FoodProducts._getLastQuery()).toBe('apple');
        // Suggestions are still the apple results.
        expect(window.FoodProducts.suggestions.some((p) => p.name === 'Banana')).toBe(false);
    });

    it('Load more still fetches after an intermediate sibling search bumped the requestId', async () => {
        // Regression: the loadMoreCallback used to capture the parent
        // search's (requestId, controller). When a sibling search bumped
        // requestId (apple → banana → apple), clicking "Load more" bailed
        // at the entry guard — leaving the button stranded on "Loading...".
        // The callback claims a fresh requestId on each invocation so the
        // click always reaches a real search.
        const { window, document } = env;

        const search = installFoodSearch(window, async (query, { remote: isRemote } = {}) => {
            // Local search for apple → one product so the Load more button
            // renders and unique.length > 0 (no auto-fire).
            if (!isRemote) {
                return [{ id: 1, name: 'Apple', carbs_100g: 0, protein_100g: 0, fat_100g: 0, energy_kcal_100g: 0 }];
            }
            // Any remote search — marker result proving the click reached it.
            return [
                { id: 1, name: 'Apple', carbs_100g: 0, protein_100g: 0, fat_100g: 0, energy_kcal_100g: 0 },
                { id: 2, name: 'Apple Pie', carbs_100g: 0, protein_100g: 0, fat_100g: 0, energy_kcal_100g: 0 },
            ];
        });

        // Step 1: complete the apple search so its DOM (with the Load more
        // button bound to the callback closure) is on screen.
        document.getElementById('food-name').value = 'apple';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(850);
        await flush();

        const list = document.getElementById('food-autocomplete-list');
        let loadMoreBtn = list.querySelector('.autocomplete-load-more');
        expect(loadMoreBtn).not.toBeNull();
        const searchCountAfterApple = search.mock.calls.length;

        // Step 2 + 3: type banana then back to apple within the debounce
        // window — each call bumps the requestId via
        // cancelInFlightFoodSearch. The Apple Load more button is still in
        // the DOM and bound to the original closure.
        document.getElementById('food-name').value = 'banana';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(200);
        document.getElementById('food-name').value = 'apple';
        window.onFoodNameChange();
        await flush(10);

        // Step 4: click Load more. Without the fix the entry guard bails
        // immediately and the button text stays "Loading..." forever. With
        // the fix the callback claims a fresh requestId and proceeds.
        loadMoreBtn = list.querySelector('.autocomplete-load-more');
        expect(loadMoreBtn).not.toBeNull();
        loadMoreBtn.click();
        await flush();

        // The remote search must have been invoked (proves the click
        // reached real work, not the stranded-button path).
        expect(search.mock.calls.length).toBeGreaterThan(searchCountAfterApple);
        const remoteCall = search.mock.calls[searchCountAfterApple];
        expect(remoteCall[0]).toBe('apple');
        expect(remoteCall[1]).toEqual({ remote: true });

        // And the merged remote result rendered — Apple Pie surfaces.
        expect(window.FoodProducts.suggestions.some((p) => p.name === 'Apple Pie')).toBe(true);
    });

    it('aborts the tracked barcode controller immediately when the user types a different valid barcode', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        // The first barcode search hangs. If the race existed, the old
        // search could complete in the new 800ms debounce window and
        // silently autofill product A's data into the form while the input
        // shows barcode B. Even before the new debounce fires, the prior
        // controller must already be aborted.
        const first = deferred();
        let searchCalls = 0;
        const search = installFoodSearch(window, (query, { remote: isRemote } = {}) => {
            searchCalls += 1;
            if (!isRemote && searchCalls === 1) return first.promise;
            return Promise.resolve([]);
        });

        // Type valid barcode A and let the debounce fire so the search starts.
        document.getElementById('food-barcode').value = '12345';
        window.onFoodBarcodeChange();
        await vi.advanceTimersByTimeAsync(850);
        await flush(10);

        expect(search).toHaveBeenCalledTimes(1);
        const firstController = window.FoodProducts._getAbortController();
        expect(firstController.signal.aborted).toBe(false);

        // Type a different valid barcode B BEFORE the new debounce fires.
        // The old in-flight controller must already be aborted at this
        // point — without the eager cancellation the abort would only
        // happen 800ms later when the new debounce runs.
        document.getElementById('food-barcode').value = '67890';
        window.onFoodBarcodeChange();
        // No timer advance yet — only microtasks. Eager cancel runs
        // synchronously inside onFoodBarcodeChange.
        await flush(10);

        expect(firstController.signal.aborted).toBe(true);

        // The form must not have been autofilled by the aborted first
        // search (no product name written into food-name).
        first.resolve([{ id: 1, name: 'Old Apple', barcode: '12345' }]);
        await flush(10);
        expect(document.getElementById('food-name').value).toBe('');
    });

    it('does not autofill the food modal from a barcode result that arrives after the user typed a new barcode', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        // Arrange a resolver for the first search so we can deliver its
        // response AFTER the user has typed a new barcode but BEFORE the
        // new debounce fires. The requestId guard (bumped synchronously by
        // the eager cancellation) must drop it.
        const first = deferred();
        let searchCalls = 0;
        const search = installFoodSearch(window, (query, { remote: isRemote } = {}) => {
            searchCalls += 1;
            if (!isRemote && searchCalls === 1) return first.promise;
            return Promise.resolve([]);
        });

        document.getElementById('food-barcode').value = '12345';
        window.onFoodBarcodeChange();
        await vi.advanceTimersByTimeAsync(850);
        await flush(5);

        // First search in flight, hanging.
        expect(search).toHaveBeenCalledTimes(1);

        // User types a new valid barcode before the first search returns.
        document.getElementById('food-barcode').value = '67890';
        window.onFoodBarcodeChange();
        await flush(5);

        // Now deliver the first search's result late — it must be ignored.
        first.resolve([{
            id: 1, name: 'Old Apple', barcode: '12345',
            carbs_100g: 10, protein_100g: 1, fat_100g: 0, energy_kcal_100g: 50
        }]);
        await flush(20);

        // The food-name input must NOT have been autofilled with "Old Apple".
        expect(document.getElementById('food-name').value).toBe('');
        // No autofill side-effects on macros either.
        expect(document.getElementById('food-carbs').value).toBe('');
    });
});
