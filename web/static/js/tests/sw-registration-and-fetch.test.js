import { describe, expect, it, vi, beforeEach } from 'vitest';
import { loadFrontendEnv, createMockResponse } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';
import fs from 'fs';
import path from 'path';

// Load the newly extracted app-shell.js logic since it's not automatically loaded by harness yet
const appShellCode = fs.readFileSync(path.resolve(__dirname, '../app-shell.js'), 'utf-8');

describe('PWA Registration and App Shell behavior', () => {
    let env;

    beforeEach(() => {
        allowConsoleNoise();
        env = loadFrontendEnv();
        // Execute the script directly against the JSDOM window context
        // This is necessary because JSDOM doesn't run dynamically injected scripts by default
        const scriptCode = `
            (function(window, navigator, document) {
                ${appShellCode}
            })(window, window.navigator, window.document);
        `;
        env.window.eval(scriptCode);
    });

    it('registers the service worker on load', async () => {
        const { window, cleanup } = env;
        try {
            // Mock service worker navigator API
            const registerSpy = vi.fn().mockResolvedValue({
                scope: '/',
                update: vi.fn().mockResolvedValue(),
                onupdatefound: null
            });
            Object.defineProperty(window.navigator, 'serviceWorker', {
                value: {
                    register: registerSpy,
                    addEventListener: vi.fn(),
                    controller: null
                },
                configurable: true
            });

            // Re-trigger load event because app-shell attaches listener instantly
            window.initServiceWorker();
            window.dispatchEvent(new window.Event('load'));

            // Give promises time to flush
            await new Promise(r => setTimeout(r, 0));

            expect(registerSpy).toHaveBeenCalledWith('/static/sw.js', { scope: '/', updateViaCache: 'none' });
        } finally {
            cleanup();
        }
    });

    it('shows update toast when new service worker is installed', async () => {
        const { window, document, cleanup } = env;
        try {
            const mockWorker = {
                state: 'installing',
                onstatechange: null,
                postMessage: vi.fn()
            };
            const mockRegistration = {
                scope: '/',
                update: vi.fn().mockResolvedValue(),
                installing: mockWorker,
                waiting: mockWorker,
                onupdatefound: null
            };

            Object.defineProperty(window.navigator, 'serviceWorker', {
                value: {
                    register: vi.fn().mockResolvedValue(mockRegistration),
                    addEventListener: vi.fn(),
                    controller: {} // Need a mock controller to simulate active SW
                },
                configurable: true
            });

            window.initServiceWorker();
            window.dispatchEvent(new window.Event('load'));
            await new Promise(r => setTimeout(r, 0));

            // Trigger update found
            mockRegistration.onupdatefound();

            // Simulate worker state progressing to installed
            mockWorker.state = 'installed';
            mockWorker.onstatechange();

            const toast = document.getElementById('pwa-update-toast');
            expect(toast).not.toBeNull();
            expect(toast.textContent).toContain('New version available');

            // Click upate button
            const updateBtn = document.getElementById('pwa-update-btn');
            updateBtn.click();

            expect(mockWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
            expect(updateBtn.textContent).toBe('Updating…');

        } finally {
            cleanup();
        }
    });
});

describe('Service Worker (sw.js) Fetch and Cache Strategies', () => {
    let mockCaches;
    let mockCacheInstance;

    beforeEach(() => {
        // Build mock cache system
        mockCacheInstance = {
            match: vi.fn(),
            put: vi.fn(),
            addAll: vi.fn()
        };
        mockCaches = {
            open: vi.fn().mockResolvedValue(mockCacheInstance),
            match: vi.fn(),
            keys: vi.fn().mockResolvedValue([]),
            delete: vi.fn()
        };
        global.caches = mockCaches;
        global.self = {
            addEventListener: vi.fn(),
            clients: { matchAll: vi.fn(), claim: vi.fn() },
            registration: { showNotification: vi.fn() },
            location: { origin: 'https://test.com' },
            skipWaiting: vi.fn()
        };
        global.fetch = vi.fn().mockResolvedValue(new Response());
        // Load the sw.js script securely without executing any global conflicts.
        // sw.js calls importScripts('/static/js/sw-api-helper.js') at the top —
        // route that through a stub that inlines the helper into the same
        // sandbox so self.SwApi is available to the SW message handler.
        const swCode = fs.readFileSync(path.resolve(__dirname, '../../sw.js'), 'utf-8');
        const swApiHelperCode = fs.readFileSync(path.resolve(__dirname, '../sw-api-helper.js'), 'utf-8');
        const importScripts = (p) => {
            if (typeof p === 'string' && p.includes('sw-api-helper.js')) {
                // eslint-disable-next-line no-new-func
                new Function('self', 'fetch', swApiHelperCode)(global.self, global.fetch);
            }
        };
        // eslint-disable-next-line no-new-func
        new Function('self', 'caches', 'fetch', 'importScripts', swCode)(
            global.self, global.caches, global.fetch, importScripts
        );
    });

    it('returns cached APP_SHELL_CACHE_KEY immediately and initiates background refresh on navigation', async () => {
        const fetchListeners = global.self.addEventListener.mock.calls.filter(c => c[0] === 'fetch');
        expect(fetchListeners.length).toBe(1);
        const fetchHandler = fetchListeners[0][1];

        // Mock event setup
        const fakeRequest = {
            url: 'https://test.com/bp_add',
            method: 'GET',
            mode: 'navigate',
            clone: () => fakeRequest
        };

        const event = {
            request: fakeRequest,
            respondWith: vi.fn(),
            waitUntil: vi.fn()
        };

        const cachedShellResponse = new Response('<html>Cached App Shell</html>');
        const networkFreshResponse = new Response('<html>Fresh App Shell</html>');

        // Initial cache has shell
        mockCacheInstance.match.mockImplementation((key) => {
            if (key === '/__app_shell__') return Promise.resolve(cachedShellResponse);
            return Promise.resolve(null);
        });

        // Network eventually returns fresh shell
        global.fetch.mockResolvedValue(networkFreshResponse);

        // Execute fetch handler
        fetchHandler(event);

        expect(event.respondWith).toHaveBeenCalled();
        const responsePromise = event.respondWith.mock.calls[0][0];

        // Wait for the response promise to resolve
        const resolvedResponse = await responsePromise;

        // 1. Should return the cached version instantly
        expect(resolvedResponse).toBe(cachedShellResponse);

        // 2. Should have spawned a background refresh task
        // We wait for all tick promises to settle
        await new Promise(r => setTimeout(r, 0));

        // 3. Should have fetched from network
        expect(global.fetch).toHaveBeenCalledWith(fakeRequest);

        // 4. Should have updated cache with fresh shell
        expect(mockCacheInstance.put).toHaveBeenCalledWith('/__app_shell__', expect.any(Response));
    });

    it('bypasses the SPA shell handler for standalone HTML pages (/oidc-setup, /pitch)', async () => {
        const fetchHandler = global.self.addEventListener.mock.calls.find(c => c[0] === 'fetch')[1];

        const standalonePaths = ['/oidc-setup', '/pitch'];
        for (const pathname of standalonePaths) {
            mockCacheInstance.put.mockClear();
            mockCacheInstance.match.mockClear();
            mockCaches.open.mockClear();
            global.fetch.mockClear();

            const fakeRequest = {
                url: `https://test.com${pathname}`,
                method: 'GET',
                mode: 'navigate',
                clone: () => fakeRequest
            };
            const event = { request: fakeRequest, respondWith: vi.fn(), waitUntil: vi.fn() };

            // Even if a cached shell exists, it must NOT be returned for these paths.
            const cachedShellResponse = new Response('<html>Cached SPA Shell</html>');
            mockCacheInstance.match.mockImplementation((key) => {
                if (key === '/__app_shell__') return Promise.resolve(cachedShellResponse);
                return Promise.resolve(null);
            });

            const pageResponse = new Response(`<html>${pathname} page</html>`);
            global.fetch.mockResolvedValueOnce(pageResponse);

            fetchHandler(event);
            const resolved = await event.respondWith.mock.calls[0][0];

            // Must serve the real page, not the SPA shell.
            expect(resolved).toBe(pageResponse);
            // Must hit the network for the requested path.
            expect(global.fetch).toHaveBeenCalledWith(fakeRequest);
            // Must never read or pollute APP_SHELL_CACHE_KEY for these paths.
            expect(mockCacheInstance.put).not.toHaveBeenCalledWith('/__app_shell__', expect.any(Response));
            expect(mockCacheInstance.match).not.toHaveBeenCalledWith('/__app_shell__');
        }
    });

    it('falls back to network then old cache if APP_SHELL_CACHE_KEY is missing currently', async () => {
        const fetchHandler = global.self.addEventListener.mock.calls.find(c => c[0] === 'fetch')[1];

        const fakeRequest = { url: 'https://test.com/', method: 'GET', mode: 'navigate', clone: () => fakeRequest };
        const event = { request: fakeRequest, respondWith: vi.fn(), waitUntil: vi.fn() };
        const networkResponse = new Response('<html>Network Shell</html>');

        mockCacheInstance.match.mockResolvedValue(null); // No cache available at all
        global.fetch = vi.fn().mockResolvedValue(networkResponse); // Network is online

        fetchHandler(event);
        const finalResponse = await event.respondWith.mock.calls[0][0];
        expect(finalResponse).toBeInstanceOf(Response);
        expect(finalResponse.status).toBe(200);
        // It should have cached the fresh network response against APP_SHELL_CACHE_KEY
        expect(mockCacheInstance.put).toHaveBeenCalledWith('/__app_shell__', expect.any(Response));
    });

    describe('Bootstrap SWR (stale-while-revalidate)', () => {
        function getFetchHandler() {
            return global.self.addEventListener.mock.calls.find(c => c[0] === 'fetch')[1];
        }

        function makeBootstrapRequest() {
            const req = {
                url: 'https://test.com/api/bootstrap',
                method: 'GET',
                mode: 'cors',
                clone: () => req
            };
            return req;
        }

        it('returns cached bootstrap immediately and revalidates in background', async () => {
            const fetchHandler = getFetchHandler();
            const cachedData = { medications: [], cursor: 1 };
            const freshData = { medications: [{ id: 1 }], cursor: 2 };

            const cachedResponse = new Response(JSON.stringify(cachedData), {
                headers: { 'Content-Type': 'application/json' }
            });
            const freshResponse = new Response(JSON.stringify(freshData), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
            // Make freshResponse.ok return true
            Object.defineProperty(freshResponse, 'ok', { value: true });

            mockCacheInstance.match.mockResolvedValue(cachedResponse);
            global.self.clients.matchAll.mockResolvedValue([{ postMessage: vi.fn() }]);
            global.fetch.mockResolvedValue(freshResponse);

            const fakeRequest = makeBootstrapRequest();
            const event = { request: fakeRequest, respondWith: vi.fn(), waitUntil: vi.fn() };

            fetchHandler(event);

            // Should call respondWith (SWR path)
            expect(event.respondWith).toHaveBeenCalled();
            const resolved = await event.respondWith.mock.calls[0][0];

            // Should return the cached response immediately
            expect(resolved).toBe(cachedResponse);

            // Should have fired a background revalidation
            expect(event.waitUntil).toHaveBeenCalled();

            // Wait for background fetch to complete
            await event.waitUntil.mock.calls[0][0];
            await new Promise(r => setTimeout(r, 0));

            // Should have fetched from network. The bootstrap revalidation
            // wraps fetch with an AbortSignal.timeout so the call site now
            // passes a second `{ signal }` arg; assert request match only.
            expect(global.fetch).toHaveBeenCalled();
            expect(global.fetch.mock.calls[0][0]).toBe(fakeRequest);

            // Should have updated the cache
            expect(mockCacheInstance.put).toHaveBeenCalled();

            // Should have notified clients with BOOTSTRAP_UPDATED
            const clients = await global.self.clients.matchAll();
            expect(clients[0].postMessage).toHaveBeenCalledWith({
                type: 'BOOTSTRAP_UPDATED',
                data: freshData
            });
        });

        it('falls through to network-first when no cached bootstrap exists', async () => {
            const fetchHandler = getFetchHandler();
            const freshData = { medications: [{ id: 1 }], cursor: 1 };
            const freshResponse = new Response(JSON.stringify(freshData), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
            Object.defineProperty(freshResponse, 'ok', { value: true });

            mockCacheInstance.match.mockResolvedValue(null); // No cache
            global.fetch.mockResolvedValue(freshResponse);

            const fakeRequest = makeBootstrapRequest();
            const event = { request: fakeRequest, respondWith: vi.fn(), waitUntil: vi.fn() };

            fetchHandler(event);

            const resolved = await event.respondWith.mock.calls[0][0];

            // Should return the network response
            expect(resolved).toBe(freshResponse);

            // Should have cached the response
            expect(mockCacheInstance.put).toHaveBeenCalledWith(fakeRequest, expect.any(Response));
        });

        it('returns offline error when no cache and network fails', async () => {
            const fetchHandler = getFetchHandler();

            mockCacheInstance.match.mockResolvedValue(null); // No cache
            global.fetch.mockRejectedValue(new TypeError('network error'));

            const fakeRequest = makeBootstrapRequest();
            const event = { request: fakeRequest, respondWith: vi.fn(), waitUntil: vi.fn() };

            fetchHandler(event);

            const resolved = await event.respondWith.mock.calls[0][0];

            expect(resolved.status).toBe(503);
            const body = await resolved.json();
            expect(body.error).toBe('offline');
        });

        it('serves cached bootstrap when background revalidation fails (offline)', async () => {
            const fetchHandler = getFetchHandler();
            const cachedData = { medications: [], cursor: 1 };
            const cachedResponse = new Response(JSON.stringify(cachedData), {
                headers: { 'Content-Type': 'application/json' }
            });

            mockCacheInstance.match.mockResolvedValue(cachedResponse);
            global.fetch.mockRejectedValue(new TypeError('network error'));

            const fakeRequest = makeBootstrapRequest();
            const event = { request: fakeRequest, respondWith: vi.fn(), waitUntil: vi.fn() };

            fetchHandler(event);

            const resolved = await event.respondWith.mock.calls[0][0];

            // Should still return cached response
            expect(resolved).toBe(cachedResponse);

            // Background revalidation should not throw (caught internally)
            await event.waitUntil.mock.calls[0][0];
            // No clients notified since fetch failed
            expect(global.self.clients.matchAll).not.toHaveBeenCalled();
        });

        it('handles 500 response on cache miss by returning error', async () => {
            const fetchHandler = getFetchHandler();
            const errorResponse = new Response('Internal Server Error', { status: 502 });
            Object.defineProperty(errorResponse, 'ok', { value: false });

            mockCacheInstance.match.mockResolvedValue(null); // No cache
            global.fetch.mockResolvedValue(errorResponse);

            const fakeRequest = makeBootstrapRequest();
            const event = { request: fakeRequest, respondWith: vi.fn(), waitUntil: vi.fn() };

            fetchHandler(event);

            const resolved = await event.respondWith.mock.calls[0][0];

            // With no cache available, should fall through and return the error response
            // (cache.match returns null for the 500 fallback too)
            expect(resolved.status).toBe(502);
        });
    });

    it('bypasses auth navigations so OAuth redirects stay in the browser context', () => {
        const fetchHandler = global.self.addEventListener.mock.calls.find(c => c[0] === 'fetch')[1];

        const fakeRequest = { url: 'https://test.com/auth/oidc/login', method: 'GET', mode: 'navigate' };
        const event = { request: fakeRequest, respondWith: vi.fn(), waitUntil: vi.fn() };

        fetchHandler(event);

        expect(event.respondWith).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
