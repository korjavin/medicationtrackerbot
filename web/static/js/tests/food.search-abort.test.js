// Task 3 — AbortController + 10s timeout on food product search.
//
// onFoodNameChange() must:
//   1. abort the previous in-flight controller when a new search starts
//      (proves the streaming reader from the previous query is unwound and
//      doesn't leak past a freshly-typed query),
//   2. fire a 10-second deadline that aborts a stalled fetch and surfaces
//      a typed "Search timed out" status (no console.error),
//   3. leave fast successful searches untouched — the AbortController is
//      created and the timeout is cleared after the local stream completes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

function streamingResponse(jsonLines) {
    let idx = 0;
    return {
        status: 200,
        ok: true,
        body: {
            getReader() {
                return {
                    async read() {
                        if (idx >= jsonLines.length) {
                            return { done: true, value: undefined };
                        }
                        const chunk = new TextEncoder().encode(jsonLines[idx] + '\n');
                        idx += 1;
                        return { done: false, value: chunk };
                    }
                };
            }
        }
    };
}

// Returns a fetch that never resolves on its own; it only rejects when the
// caller-supplied AbortSignal aborts (mirroring real fetch semantics so the
// 10-second timeout can be observed deterministically).
function abortableHangingFetch() {
    return (_url, fetchOpts) => new Promise((_resolve, reject) => {
        if (fetchOpts && fetchOpts.signal) {
            if (fetchOpts.signal.aborted) {
                reject(fetchOpts.signal.reason);
                return;
            }
            fetchOpts.signal.addEventListener('abort', () => {
                reject(fetchOpts.signal.reason);
            });
        }
    });
}

describe('Food product search — AbortController + 10s timeout', () => {
    let env;

    beforeEach(() => {
        vi.useFakeTimers();
        env = loadFrontendEnv();
        Object.defineProperty(env.window.navigator, 'onLine', {
            configurable: true,
            get: () => true
        });
        env.window.userInitData = 'test-init';
        // JSDOM does not expose TextDecoder/TextEncoder on its window; the
        // streaming reader in products.js needs them.
        env.window.TextDecoder = globalThis.TextDecoder;
        env.window.TextEncoder = globalThis.TextEncoder;
    });

    afterEach(() => {
        vi.useRealTimers();
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renders results and clears state on a successful fast search', async () => {
        const { window, document } = env;

        window.fetch = vi.fn(async (_url, fetchOpts) => {
            // Sanity: the signal is wired through every search fetch.
            expect(fetchOpts && fetchOpts.signal).toBeDefined();
            return streamingResponse([JSON.stringify([{ id: 1, name: 'Apple', barcode: '123' }])]);
        });

        document.getElementById('food-name').value = 'app';
        window.onFoodNameChange();

        // Run the 800ms debounce, the streaming read microtasks, and any
        // scheduled timers (including the 10s abort which gets cleared on
        // local-stream completion).
        await vi.advanceTimersByTimeAsync(850);
        await vi.runAllTimersAsync();
        for (let i = 0; i < 30; i++) await Promise.resolve();

        expect(window.fetch).toHaveBeenCalled();
        // Each search call must include a signal — proves AbortController
        // wiring is active on every fetch().
        for (const call of window.fetch.mock.calls) {
            const opts = call[1];
            expect(opts && opts.signal).toBeDefined();
        }

        const status = document.getElementById('food-search-status');
        // Either the local-only success or the post-loadMore success
        // copy is acceptable — both contain "result(s)".
        expect(status.textContent).toContain('result');
        expect(window.FoodProducts.suggestions.some((p) => p.name === 'Apple')).toBe(true);
    });

    it('aborts the previous fetch when a rapid second search starts', async () => {
        const { window, document } = env;

        // First fetch hangs (will be aborted by the second search). Second
        // fetch resolves immediately so the test settles.
        const seen = [];
        let callIdx = 0;
        window.fetch = vi.fn((_url, fetchOpts) => {
            const i = callIdx++;
            seen.push(fetchOpts.signal);
            if (i === 0) {
                // Hang until aborted.
                return new Promise((_resolve, reject) => {
                    fetchOpts.signal.addEventListener('abort', () => {
                        reject(fetchOpts.signal.reason);
                    });
                });
            }
            return Promise.resolve(streamingResponse([JSON.stringify([{ id: 2, name: 'Banana' }])]));
        });

        // First search.
        document.getElementById('food-name').value = 'app';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(850);
        // Let the first fetch's pending Promise attach the abort listener.
        for (let i = 0; i < 5; i++) await Promise.resolve();

        // First fetch should have been invoked and is still hanging.
        expect(window.fetch).toHaveBeenCalledTimes(1);
        const firstSignal = seen[0];
        expect(firstSignal.aborted).toBe(false);

        // Type a new query before the first one finishes.
        document.getElementById('food-name').value = 'ban';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(850);
        await vi.runAllTimersAsync();
        for (let i = 0; i < 30; i++) await Promise.resolve();

        // The first controller must have been aborted by the second search
        // starting up — proves no stream-leak from the stale query.
        expect(firstSignal.aborted).toBe(true);
        expect(window.fetch).toHaveBeenCalledTimes(2);

        // The status reflects the second search, not a "timed out" copy
        // from the aborted first (the requestId guard filters that out).
        const status = document.getElementById('food-search-status');
        expect(status.textContent).not.toContain('timed out');
    });

    it('surfaces "Search timed out" after the 10s deadline fires', async () => {
        allowConsoleNoise(); // tolerate any incidental noise from the abort path
        const { window, document } = env;

        window.fetch = vi.fn(abortableHangingFetch());

        document.getElementById('food-name').value = 'kebab';
        window.onFoodNameChange();

        // Fire the 800ms debounce so the search starts.
        await vi.advanceTimersByTimeAsync(850);
        for (let i = 0; i < 5; i++) await Promise.resolve();

        // Fetch is hanging. The 10s deadline has not fired yet.
        const status = document.getElementById('food-search-status');
        expect(status.textContent).toContain('Searching local');

        // Advance past the 10s abort deadline.
        await vi.advanceTimersByTimeAsync(10_500);
        for (let i = 0; i < 30; i++) await Promise.resolve();

        // The catch branch rendered the typed timeout status without logging.
        expect(status.textContent).toBe('Search timed out');
        expect(status.classList.contains('error')).toBe(true);
    });

    it('times out the remote OpenFoodFacts fetch after a fresh 10s budget when local results are empty', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        // First call (local search): returns an empty array immediately so
        // loadMoreCallback auto-fires. Second call (remote OpenFoodFacts):
        // hangs until aborted by the per-loadMore deadline.
        let callIdx = 0;
        window.fetch = vi.fn((_url, fetchOpts) => {
            const i = callIdx++;
            if (i === 0) {
                return Promise.resolve(streamingResponse([JSON.stringify([])]));
            }
            return new Promise((_resolve, reject) => {
                if (fetchOpts && fetchOpts.signal) {
                    fetchOpts.signal.addEventListener('abort', () => {
                        reject(fetchOpts.signal.reason);
                    });
                }
            });
        });

        document.getElementById('food-name').value = 'unobtanium';
        window.onFoodNameChange();

        // Fire the 800ms debounce so the search starts; local stream
        // resolves immediately and triggers loadMoreCallback.
        await vi.advanceTimersByTimeAsync(850);
        for (let i = 0; i < 30; i++) await Promise.resolve();

        // Both fetches should have fired (local + remote).
        expect(window.fetch).toHaveBeenCalledTimes(2);
        const status = document.getElementById('food-search-status');
        expect(status.textContent).toContain('Searching OpenFoodFacts');

        // Advance past the per-loadMore 10s deadline; the remote fetch must
        // abort and surface a typed status without throwing.
        await vi.advanceTimersByTimeAsync(10_500);
        for (let i = 0; i < 30; i++) await Promise.resolve();

        expect(status.textContent).toContain('Remote search timed out');
    });

    it('aborts the in-flight fetch when the user clears the query below 2 chars', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        // The first fetch hangs forever unless aborted. After the user
        // clears the input there is nothing else to fetch.
        let firstSignal = null;
        let firstFetchSettled = false;
        window.fetch = vi.fn((_url, fetchOpts) => {
            firstSignal = fetchOpts && fetchOpts.signal;
            return new Promise((_resolve, reject) => {
                if (firstSignal) {
                    firstSignal.addEventListener('abort', () => {
                        firstFetchSettled = true;
                        reject(firstSignal.reason);
                    });
                }
            });
        });

        document.getElementById('food-name').value = 'appl';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(850);
        for (let i = 0; i < 10; i++) await Promise.resolve();

        expect(window.fetch).toHaveBeenCalledTimes(1);
        expect(firstSignal.aborted).toBe(false);

        // User clears the field below the 2-char threshold — the in-flight
        // search is now stale and must be aborted (otherwise its eventual
        // completion would render suggestions back into an empty input).
        document.getElementById('food-name').value = 'a';
        window.onFoodNameChange();
        for (let i = 0; i < 10; i++) await Promise.resolve();

        expect(firstSignal.aborted).toBe(true);
        expect(firstFetchSettled).toBe(true);

        // No follow-up fetch fires — the query is too short to search.
        await vi.advanceTimersByTimeAsync(1000);
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(window.fetch).toHaveBeenCalledTimes(1);

        // Status was reset (the too-short branch calls setFoodSearchStatus()
        // with no args, hiding the chip). No stale "Searching local..." or
        // "Found N result(s)" surfaces.
        const status = document.getElementById('food-search-status');
        expect(status.textContent).toBe('');
        expect(status.classList.contains('hidden')).toBe(true);
    });

    it('cancels a pending debounce when the user clears below 2 chars before it fires', async () => {
        const { window, document } = env;

        window.fetch = vi.fn(() => Promise.resolve(streamingResponse([JSON.stringify([])])));

        // Type a searchable query but clear before the 800ms debounce fires.
        document.getElementById('food-name').value = 'appl';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(200);

        document.getElementById('food-name').value = 'a';
        window.onFoodNameChange();

        // Advance past where the original debounce would have fired plus
        // some headroom — the pending search must have been cancelled, so
        // no fetch should be invoked for the stale query.
        await vi.advanceTimersByTimeAsync(2000);
        for (let i = 0; i < 10; i++) await Promise.resolve();

        expect(window.fetch).not.toHaveBeenCalled();
    });

    it('aborts the in-flight fetch when the user types an exact suggestion match', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        // Seed the suggestions list so the exact-match branch in
        // onFoodNameChange triggers when the user finishes typing.
        window.FoodProducts.suggestions = [{
            id: 7, name: 'Apple Pie', carbs_100g: 0, protein_100g: 0,
            fat_100g: 0, energy_kcal_100g: 0
        }];

        let firstSignal = null;
        window.fetch = vi.fn((_url, fetchOpts) => {
            firstSignal = fetchOpts && fetchOpts.signal;
            return new Promise((_resolve, reject) => {
                if (firstSignal) {
                    firstSignal.addEventListener('abort', () => {
                        reject(firstSignal.reason);
                    });
                }
            });
        });

        document.getElementById('food-name').value = 'appl';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(850);
        for (let i = 0; i < 10; i++) await Promise.resolve();

        expect(window.fetch).toHaveBeenCalledTimes(1);
        expect(firstSignal.aborted).toBe(false);

        // User finishes typing the suggestion's exact display name. The
        // selection-match branch must cancel the in-flight search so it
        // doesn't overwrite the autofill.
        document.getElementById('food-name').value = 'Apple Pie';
        window.onFoodNameChange();
        for (let i = 0; i < 10; i++) await Promise.resolve();

        expect(firstSignal.aborted).toBe(true);
        const status = document.getElementById('food-search-status');
        expect(status.textContent).toBe('Product selected.');
    });

    it('does not surface "Remote fetch failed" when a new search aborts an in-flight remote loadMore', async () => {
        allowConsoleNoise();
        const { window, document } = env;
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        let callIdx = 0;
        window.fetch = vi.fn((_url, fetchOpts) => {
            const i = callIdx++;
            // First call (local for query 1): empty → triggers loadMore.
            if (i === 0) {
                return Promise.resolve(streamingResponse([JSON.stringify([])]));
            }
            // Second call (remote for query 1): hangs until aborted.
            if (i === 1) {
                return new Promise((_resolve, reject) => {
                    if (fetchOpts && fetchOpts.signal) {
                        fetchOpts.signal.addEventListener('abort', () => {
                            reject(fetchOpts.signal.reason);
                        });
                    }
                });
            }
            // Third call (local for query 2): resolves with results.
            return Promise.resolve(streamingResponse([JSON.stringify([{ id: 9, name: 'Cherry' }])]));
        });

        document.getElementById('food-name').value = 'aaa';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(850);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        // Local stream done, remote in flight.
        expect(window.fetch).toHaveBeenCalledTimes(2);

        // User types a new query — must abort the remote fetch silently.
        document.getElementById('food-name').value = 'bbb';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(850);
        await vi.runAllTimersAsync();
        for (let i = 0; i < 30; i++) await Promise.resolve();

        const status = document.getElementById('food-search-status');
        expect(status.textContent).not.toContain('Remote fetch failed');
        expect(status.textContent).not.toContain('Remote search timed out');
        // No console.error from the user-initiated abort.
        const sawLoadMoreError = errorSpy.mock.calls.some((c) => String(c[0]).includes('Load more failed'));
        expect(sawLoadMoreError).toBe(false);
        errorSpy.mockRestore();
    });

    it('cancels a pending debounce when the user types back to the previous completed query', async () => {
        const { window, document } = env;

        // Step 1: search for "apple" so its results are committed and
        // lastQuery becomes "apple". The local stream resolves immediately
        // and the remote loadMore also returns empty so the search settles.
        let callIdx = 0;
        window.fetch = vi.fn(() => {
            const i = callIdx++;
            if (i === 0) {
                return Promise.resolve(streamingResponse([
                    JSON.stringify([{ id: 1, name: 'Apple', carbs_100g: 0, protein_100g: 0, fat_100g: 0, energy_kcal_100g: 0 }])
                ]));
            }
            // Subsequent calls (would-be banana search) — return marker
            // data so we can detect leakage.
            return Promise.resolve(streamingResponse([
                JSON.stringify([{ id: 99, name: 'Banana', carbs_100g: 0, protein_100g: 0, fat_100g: 0, energy_kcal_100g: 0 }])
            ]));
        });

        document.getElementById('food-name').value = 'apple';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(850);
        await vi.runAllTimersAsync();
        for (let i = 0; i < 30; i++) await Promise.resolve();

        expect(window.FoodProducts._getLastQuery()).toBe('apple');
        expect(window.FoodProducts.suggestions.some((p) => p.name === 'Apple')).toBe(true);
        const fetchCountAfterApple = window.fetch.mock.calls.length;

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
        await vi.runAllTimersAsync();
        for (let i = 0; i < 30; i++) await Promise.resolve();

        // No additional fetch for the banana query was issued.
        expect(window.fetch.mock.calls.length).toBe(fetchCountAfterApple);
        // lastQuery still reflects "apple" — the banana debounce did not run.
        expect(window.FoodProducts._getLastQuery()).toBe('apple');
        // Suggestions are still the apple results.
        expect(window.FoodProducts.suggestions.some((p) => p.name === 'Banana')).toBe(false);
    });

    it('Load more still fetches after an intermediate sibling search bumped the requestId', async () => {
        // Regression: the loadMoreCallback originally captured the parent
        // search's (requestId, controller). When a sibling search bumped
        // requestId / aborted the controller (apple → banana → apple, where
        // the bump fires twice), clicking "Load more" set the button to
        // "Loading..." but then bailed at the entry guard — leaving the
        // button stranded. The fix has loadMoreCallback claim a fresh
        // lifecycle on each invocation so the click always reaches a real
        // fetch.
        const { window, document } = env;

        let callIdx = 0;
        window.fetch = vi.fn((_url, fetchOpts) => {
            const i = callIdx++;
            // call 0: local search for apple → returns one product so the
            // Load more button is rendered and unique.length > 0 (no
            // auto-fire).
            if (i === 0) {
                return Promise.resolve(streamingResponse([
                    JSON.stringify([{ id: 1, name: 'Apple', carbs_100g: 0, protein_100g: 0, fat_100g: 0, energy_kcal_100g: 0 }])
                ]));
            }
            // call 1+: any later remote fetch — return a marker result so
            // the test can prove the click reached the network.
            return Promise.resolve(streamingResponse([
                JSON.stringify([{ id: 2, name: 'Apple Pie', carbs_100g: 0, protein_100g: 0, fat_100g: 0, energy_kcal_100g: 0 }])
            ]));
        });

        // Step 1: complete the apple search so its DOM (with the Load more
        // button bound to a captured requestId) is on screen.
        document.getElementById('food-name').value = 'apple';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(850);
        await vi.runAllTimersAsync();
        for (let i = 0; i < 30; i++) await Promise.resolve();

        const list = document.getElementById('food-autocomplete-list');
        let loadMoreBtn = list.querySelector('.autocomplete-load-more');
        expect(loadMoreBtn).not.toBeNull();
        const fetchCountAfterApple = window.fetch.mock.calls.length;

        // Step 2 + 3: type banana then back to apple within the debounce
        // window — each call bumps the requestId via
        // cancelInFlightFoodSearch, invalidating the loadMoreCallback's
        // original (captured) requestId. The Apple Load more button is
        // still in the DOM and bound to the original closure.
        document.getElementById('food-name').value = 'banana';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(200);
        document.getElementById('food-name').value = 'apple';
        window.onFoodNameChange();
        for (let i = 0; i < 10; i++) await Promise.resolve();

        // Step 4: simulate clicking Load more. Without the fix the entry
        // guard bails immediately and the button text stays "Loading..."
        // forever. With the fix the callback claims a fresh requestId and
        // proceeds to fetch.
        loadMoreBtn = list.querySelector('.autocomplete-load-more');
        expect(loadMoreBtn).not.toBeNull();
        loadMoreBtn.click();
        for (let i = 0; i < 30; i++) await Promise.resolve();

        // The remote fetch must have been invoked (proves the click
        // reached real work, not the stranded-button path).
        expect(window.fetch.mock.calls.length).toBeGreaterThan(fetchCountAfterApple);
        const remoteCall = window.fetch.mock.calls[fetchCountAfterApple];
        expect(remoteCall[0]).toContain('remote=true');
        expect(remoteCall[0]).toContain('q=apple');

        // And the merged remote result rendered — Apple Pie surfaces.
        expect(window.FoodProducts.suggestions.some((p) => p.name === 'Apple Pie')).toBe(true);
    });

    it('aborts the in-flight barcode fetch immediately when the user types a different valid barcode', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        // The first barcode fetch hangs forever unless aborted. If the race
        // existed, the old fetch could complete in the new 800ms debounce
        // window and silently autofill product A's data into the form while
        // the input shows barcode B. Even before the new debounce fires,
        // the prior controller must already be aborted.
        let firstSignal = null;
        let secondSignal = null;
        let callIdx = 0;
        window.fetch = vi.fn((_url, fetchOpts) => {
            const i = callIdx++;
            if (i === 0) {
                firstSignal = fetchOpts && fetchOpts.signal;
                return new Promise((_resolve, reject) => {
                    if (firstSignal) {
                        firstSignal.addEventListener('abort', () => {
                            reject(firstSignal.reason);
                        });
                    }
                });
            }
            secondSignal = fetchOpts && fetchOpts.signal;
            return Promise.resolve(streamingResponse([JSON.stringify([])]));
        });

        // Type valid barcode A and let the debounce fire so the fetch starts.
        document.getElementById('food-barcode').value = '12345';
        window.onFoodBarcodeChange();
        await vi.advanceTimersByTimeAsync(850);
        for (let i = 0; i < 10; i++) await Promise.resolve();

        expect(window.fetch).toHaveBeenCalledTimes(1);
        expect(firstSignal.aborted).toBe(false);

        // Type a different valid barcode B BEFORE the new debounce fires.
        // The old in-flight controller must already be aborted at this
        // point — without the eager cancellation the abort would only
        // happen 800ms later when the new debounce runs.
        document.getElementById('food-barcode').value = '67890';
        window.onFoodBarcodeChange();
        // No timer advance yet — only microtasks. Eager cancel runs
        // synchronously inside onFoodBarcodeChange.
        for (let i = 0; i < 10; i++) await Promise.resolve();

        expect(firstSignal.aborted).toBe(true);

        // The form must not have been autofilled by the aborted first
        // fetch (no product name written into food-name).
        expect(document.getElementById('food-name').value).toBe('');
    });

    it('does not autofill the food modal from an in-flight barcode fetch whose result arrives after the user typed a new barcode', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        // Arrange a resolver for the first fetch so we can deliver its
        // response AFTER the user has typed a new barcode but BEFORE the
        // new debounce fires. This is the exact race window Codex
        // identified — the requestId guard alone could not catch it.
        let resolveFirst;
        let callIdx = 0;
        window.fetch = vi.fn((_url, fetchOpts) => {
            const i = callIdx++;
            if (i === 0) {
                return new Promise((resolve, reject) => {
                    resolveFirst = () => resolve(streamingResponse([
                        JSON.stringify([{
                            id: 1, name: 'Old Apple', barcode: '12345',
                            carbs_100g: 10, protein_100g: 1, fat_100g: 0, energy_kcal_100g: 50
                        }])
                    ]));
                    if (fetchOpts && fetchOpts.signal) {
                        fetchOpts.signal.addEventListener('abort', () => {
                            reject(fetchOpts.signal.reason);
                        });
                    }
                });
            }
            return Promise.resolve(streamingResponse([JSON.stringify([])]));
        });

        document.getElementById('food-barcode').value = '12345';
        window.onFoodBarcodeChange();
        await vi.advanceTimersByTimeAsync(850);
        for (let i = 0; i < 5; i++) await Promise.resolve();

        // First fetch in flight, hanging.
        expect(window.fetch).toHaveBeenCalledTimes(1);

        // User types a new valid barcode before the first fetch returns.
        document.getElementById('food-barcode').value = '67890';
        window.onFoodBarcodeChange();
        for (let i = 0; i < 5; i++) await Promise.resolve();

        // Now try to deliver the first fetch's result. With the eager
        // cancellation the controller is aborted, so resolveFirst settles
        // into the rejected branch instead; even if a stub somehow let it
        // through, the requestId guard (bumped synchronously) would bail.
        try { resolveFirst(); } catch (_) { /* ignore */ }
        for (let i = 0; i < 20; i++) await Promise.resolve();

        // The food-name input must NOT have been autofilled with "Old Apple".
        expect(document.getElementById('food-name').value).toBe('');
        // No autofill side-effects on macros either.
        expect(document.getElementById('food-carbs').value).toBe('');
    });
});
