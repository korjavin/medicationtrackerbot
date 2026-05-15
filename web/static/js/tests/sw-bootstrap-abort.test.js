// Integration test for Task 4 of docs/plans/2026-05-13-api-abort-controller.md:
// the SW's /api/bootstrap stale-while-revalidate path must wrap the
// background revalidation fetch in an AbortSignal.timeout(15_000), and
// the cached response must still be served on time even when the
// revalidation fetch is artificially slow. The existing offline-path
// catch already swallows the rejection silently, so a timed-out
// revalidation must not throw to the foreground.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { allowConsoleNoise } from './helpers/setup.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SW_PATH = path.resolve(REPO_ROOT, 'web/static/sw.js');
const SW_SOURCE = fs.readFileSync(SW_PATH, 'utf-8');

function bootstrapRequest() {
    const req = {
        url: 'https://test.com/api/bootstrap',
        method: 'GET',
        mode: 'cors',
    };
    req.clone = () => req;
    return req;
}

function loadServiceWorker({ fetchImpl } = {}) {
    const mockCacheInstance = {
        match: vi.fn(),
        put: vi.fn().mockResolvedValue(undefined),
        addAll: vi.fn().mockResolvedValue(undefined),
    };
    const mockCaches = {
        open: vi.fn().mockResolvedValue(mockCacheInstance),
        match: vi.fn(),
        keys: vi.fn().mockResolvedValue([]),
        delete: vi.fn().mockResolvedValue(true),
    };
    const swSelf = {
        addEventListener: vi.fn(),
        clients: {
            matchAll: vi.fn().mockResolvedValue([{ postMessage: vi.fn() }]),
            claim: vi.fn(),
        },
        registration: { showNotification: vi.fn() },
        location: { origin: 'https://test.com' },
        skipWaiting: vi.fn(),
    };
    const fakeFetch = fetchImpl ?? vi.fn();
    // No-op importScripts: helpers irrelevant to this test path.
    const importScripts = () => {};
    // eslint-disable-next-line no-new-func
    new Function('self', 'caches', 'fetch', 'importScripts', SW_SOURCE)(
        swSelf, mockCaches, fakeFetch, importScripts,
    );
    const fetchListener = swSelf.addEventListener.mock.calls
        .find((c) => c[0] === 'fetch')[1];
    return { swSelf, mockCaches, mockCacheInstance, fakeFetch, fetchListener };
}

describe('sw.js — /api/bootstrap revalidation timeout (Task 4)', () => {
    beforeEach(() => {
        allowConsoleNoise();
        vi.useRealTimers();
    });

    it('passes an AbortSignal into the background revalidation fetch', async () => {
        const cachedResponse = new Response(
            JSON.stringify({ medications: [], cursor: 1 }),
            { headers: { 'Content-Type': 'application/json' } },
        );
        const freshResponse = new Response(
            JSON.stringify({ medications: [{ id: 1 }], cursor: 2 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
        Object.defineProperty(freshResponse, 'ok', { value: true });

        const fakeFetch = vi.fn().mockResolvedValue(freshResponse);
        const { fetchListener, mockCacheInstance } = loadServiceWorker({ fetchImpl: fakeFetch });
        mockCacheInstance.match.mockResolvedValue(cachedResponse);

        const req = bootstrapRequest();
        const event = { request: req, respondWith: vi.fn(), waitUntil: vi.fn() };

        fetchListener(event);

        const served = await event.respondWith.mock.calls[0][0];
        expect(served).toBe(cachedResponse);

        // Wait for the background revalidation to settle.
        await event.waitUntil.mock.calls[0][0];

        expect(fakeFetch).toHaveBeenCalledTimes(1);
        const fetchOpts = fakeFetch.mock.calls[0][1];
        expect(fetchOpts).toBeDefined();
        expect(fetchOpts.signal).toBeDefined();
        // AbortSignal.timeout(...) returns an AbortSignal instance.
        expect(typeof fetchOpts.signal.aborted).toBe('boolean');
    });

    it('returns the cached bootstrap response on time when the revalidation fetch stalls past 15s', async () => {
        // The 15s timeout is what AbortSignal.timeout enforces. We don't
        // want to actually wait 15s in the test, so we patch
        // AbortSignal.timeout for the duration of this test to fire
        // immediately (or, on a fixed deferred). Either way the cached
        // response is returned synchronously from respondWith before any
        // timeout could possibly fire, so we don't need fake timers — we
        // only need to assert that:
        //   - The cached response is returned ASAP (foreground).
        //   - The aborted background fetch is swallowed (no unhandled rejection).

        const cachedResponse = new Response(
            JSON.stringify({ medications: [], cursor: 1 }),
            { headers: { 'Content-Type': 'application/json' } },
        );

        // Simulate a fetch that rejects with AbortError once the signal
        // aborts. We resolve the rejection synchronously via the test's
        // patched AbortSignal.timeout so the test doesn't have to wait.
        const originalTimeout = AbortSignal.timeout;
        AbortSignal.timeout = (_ms) => {
            const ctrl = new AbortController();
            // Abort on the next microtask so the call site has a chance
            // to attach the signal to fetch before the abort fires.
            Promise.resolve().then(() => ctrl.abort(new DOMException('TimeoutError', 'TimeoutError')));
            return ctrl.signal;
        };

        try {
            const fakeFetch = vi.fn().mockImplementation((_req, opts) => {
                return new Promise((_resolve, reject) => {
                    if (opts && opts.signal) {
                        opts.signal.addEventListener('abort', () => {
                            const err = new DOMException('The user aborted a request.', 'AbortError');
                            reject(err);
                        });
                    }
                });
            });

            const { fetchListener, mockCacheInstance } = loadServiceWorker({ fetchImpl: fakeFetch });
            mockCacheInstance.match.mockResolvedValue(cachedResponse);

            const req = bootstrapRequest();
            const event = { request: req, respondWith: vi.fn(), waitUntil: vi.fn() };

            fetchListener(event);

            const served = await event.respondWith.mock.calls[0][0];
            expect(served).toBe(cachedResponse);

            // The background revalidation must resolve (i.e. the catch
            // swallows the AbortError) — awaiting waitUntil must not throw.
            await expect(event.waitUntil.mock.calls[0][0]).resolves.toBeUndefined();

            // No client notification on an aborted/failed revalidation.
            const clientsResult = await event.waitUntil.mock.calls[0][0];
            expect(clientsResult).toBeUndefined();
            // No cache.put for a non-ok / never-arrived response.
            expect(mockCacheInstance.put).not.toHaveBeenCalled();
        } finally {
            AbortSignal.timeout = originalTimeout;
        }
    });

    it('still notifies clients with BOOTSTRAP_UPDATED on a fast successful revalidation', async () => {
        // Sanity check that the timeout wiring did not regress the
        // happy-path notification.
        const cachedData = { medications: [], cursor: 1 };
        const freshData = { medications: [{ id: 1 }], cursor: 2 };
        const cachedResponse = new Response(JSON.stringify(cachedData), {
            headers: { 'Content-Type': 'application/json' },
        });
        const freshResponse = new Response(JSON.stringify(freshData), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
        Object.defineProperty(freshResponse, 'ok', { value: true });

        const fakeFetch = vi.fn().mockResolvedValue(freshResponse);
        const { fetchListener, mockCacheInstance, swSelf } = loadServiceWorker({ fetchImpl: fakeFetch });
        mockCacheInstance.match.mockResolvedValue(cachedResponse);
        const postedClient = { postMessage: vi.fn() };
        swSelf.clients.matchAll.mockResolvedValue([postedClient]);

        const req = bootstrapRequest();
        const event = { request: req, respondWith: vi.fn(), waitUntil: vi.fn() };

        fetchListener(event);

        const served = await event.respondWith.mock.calls[0][0];
        expect(served).toBe(cachedResponse);

        await event.waitUntil.mock.calls[0][0];

        expect(mockCacheInstance.put).toHaveBeenCalled();
        expect(postedClient.postMessage).toHaveBeenCalledWith({
            type: 'BOOTSTRAP_UPDATED',
            data: freshData,
        });
    });
});
