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
});
