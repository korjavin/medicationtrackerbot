import { describe, expect, it, vi, beforeEach } from 'vitest';
import { loadFrontendEnv, createMockResponse } from './helpers/frontend-harness.js';
import fs from 'fs';
import path from 'path';

// Load the newly extracted app-shell.js logic since it's not automatically loaded by harness yet
const appShellCode = fs.readFileSync(path.resolve(__dirname, '../app-shell.js'), 'utf-8');

describe('PWA Registration and App Shell behavior', () => {
    let env;

    beforeEach(() => {
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
            skipWaiting: vi.fn()
        };
        global.fetch = vi.fn().mockResolvedValue(new Response());
        // Load the sw.js script securely without executing any global conflicts
        const swCode = fs.readFileSync(path.resolve(__dirname, '../../sw.js'), 'utf-8');
        // Simple wrap to inject our mocks
        eval(`(function(self, caches, fetch) { ${swCode} })(global.self, global.caches, global.fetch)`);
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
        expect(mockCacheInstance.put).toHaveBeenCalledWith('/__app_shell__', networkFreshResponse);
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

        expect(finalResponse).toStrictEqual(networkResponse);
        // It should have cached the fresh network response against APP_SHELL_CACHE_KEY
        expect(mockCacheInstance.put).toHaveBeenCalledWith('/__app_shell__', networkResponse);
    });
});
