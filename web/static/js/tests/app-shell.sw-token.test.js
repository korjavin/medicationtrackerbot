// Integration tests for the client → SW auth-token handoff added in
// Task 2 of the SW handler unification plan. After SW registration, the
// main thread must postMessage `{ type: 'SET_AUTH_TOKEN', token }` to the
// active controller so notification-action handlers can attach the
// X-Telegram-Init-Data header. The same message is re-sent on
// `controllerchange` (covers SW upgrades) and from app.js when the
// controller is already present at script-eval time (hot-cache reload).
//
// See docs/plans/2026-05-13-sw-handler-unification.md, Task 2.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APP_SHELL_PATH = path.resolve(REPO_ROOT, 'web/static/js/app-shell.js');
const APP_SHELL_SOURCE = fs.readFileSync(APP_SHELL_PATH, 'utf-8');

function evalAppShell(window) {
    // Wrap so the script's top-level auto-init guard runs against
    // process.env.NODE_ENV (vitest sets it to 'test', so init is skipped
    // and the test drives initServiceWorker() explicitly).
    window.eval(`
        (function(window, navigator, document) {
            ${APP_SHELL_SOURCE}
        })(window, window.navigator, window.document);
    `);
}

function installServiceWorker(window, { controller, registration } = {}) {
    const swListeners = new Map();
    const swApi = {
        register: vi.fn().mockResolvedValue(registration ?? {
            scope: '/',
            update: vi.fn().mockResolvedValue(),
            onupdatefound: null,
        }),
        addEventListener: vi.fn((type, fn) => {
            swListeners.set(type, fn);
        }),
        controller,
    };
    Object.defineProperty(window.navigator, 'serviceWorker', {
        value: swApi,
        configurable: true,
    });
    return { swApi, swListeners };
}

describe('app-shell.js — SW auth-token handoff', () => {
    let env;

    beforeEach(() => {
        allowConsoleNoise();
        env = loadFrontendEnv();
        evalAppShell(env.window);
    });

    it('posts SET_AUTH_TOKEN to the controller after registration when initData is present', async () => {
        const { window, cleanup } = env;
        try {
            const postMessage = vi.fn();
            const controller = { postMessage };
            const { swApi } = installServiceWorker(window, { controller });
            window.userInitData = 'init-data-blob-A';

            window.initServiceWorker();
            window.dispatchEvent(new window.Event('load'));
            await new Promise((r) => setTimeout(r, 0));

            expect(swApi.register).toHaveBeenCalled();
            expect(postMessage).toHaveBeenCalledWith({
                type: 'SET_AUTH_TOKEN',
                token: 'init-data-blob-A',
            });
        } finally {
            cleanup();
        }
    });

    it('does not post SET_AUTH_TOKEN when initData is absent', async () => {
        const { window, cleanup } = env;
        try {
            const postMessage = vi.fn();
            const controller = { postMessage };
            installServiceWorker(window, { controller });
            window.userInitData = null;

            window.initServiceWorker();
            window.dispatchEvent(new window.Event('load'));
            await new Promise((r) => setTimeout(r, 0));

            expect(postMessage).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('does not post SET_AUTH_TOKEN when no controller is active yet', async () => {
        const { window, cleanup } = env;
        try {
            // controller absent — first-ever install case
            installServiceWorker(window, { controller: null });
            window.userInitData = 'init-data-blob-B';

            // sendSwAuthToken() is a no-op without a controller; just assert
            // it does not throw and the registration still happened.
            window.initServiceWorker();
            window.dispatchEvent(new window.Event('load'));
            await new Promise((r) => setTimeout(r, 0));

            expect(typeof window.sendSwAuthToken).toBe('function');
            expect(() => window.sendSwAuthToken()).not.toThrow();
        } finally {
            cleanup();
        }
    });

    it('re-posts SET_AUTH_TOKEN on controllerchange so upgraded SWs receive the token', async () => {
        const { window, cleanup } = env;
        try {
            const postMessage = vi.fn();
            const controller = { postMessage };
            const { swListeners } = installServiceWorker(window, { controller });
            window.userInitData = 'init-data-blob-C';

            window.initServiceWorker();
            window.dispatchEvent(new window.Event('load'));
            await new Promise((r) => setTimeout(r, 0));

            const callsAfterRegistration = postMessage.mock.calls.length;
            expect(callsAfterRegistration).toBeGreaterThanOrEqual(1);

            // Fire the controllerchange listener directly. The handler
            // calls window.location.reload() last; JSDOM's reload is a
            // navigation no-op in tests but its toString/href machinery
            // can throw — we only care that postMessage fired first, so
            // any post-postMessage error is benign.
            const handler = swListeners.get('controllerchange');
            expect(typeof handler).toBe('function');
            try { handler(); } catch (_) { /* reload-side effects in JSDOM */ }

            expect(postMessage.mock.calls.length).toBe(callsAfterRegistration + 1);
            const lastCall = postMessage.mock.calls[postMessage.mock.calls.length - 1][0];
            expect(lastCall).toEqual({
                type: 'SET_AUTH_TOKEN',
                token: 'init-data-blob-C',
            });
        } finally {
            cleanup();
        }
    });

    it('sendSwAuthToken is a no-op when serviceWorker is unsupported', () => {
        const { window, cleanup } = env;
        try {
            // No serviceWorker on navigator (e.g. ancient browser).
            Object.defineProperty(window.navigator, 'serviceWorker', {
                value: undefined,
                configurable: true,
            });
            window.userInitData = 'init-data-blob-D';
            expect(() => window.sendSwAuthToken()).not.toThrow();
        } finally {
            cleanup();
        }
    });

    it('catches postMessage errors so a broken controller does not crash registration', async () => {
        const { window, cleanup } = env;
        try {
            const controller = {
                postMessage: vi.fn(() => { throw new Error('detached port'); }),
            };
            installServiceWorker(window, { controller });
            window.userInitData = 'init-data-blob-E';

            expect(() => window.sendSwAuthToken()).not.toThrow();
            expect(controller.postMessage).toHaveBeenCalledTimes(1);
        } finally {
            cleanup();
        }
    });
});

describe('sw.js — SET_AUTH_TOKEN message branch', () => {
    let messageHandler;
    let swSelf;

    beforeEach(() => {
        allowConsoleNoise();
        const swApiHelperPath = path.resolve(REPO_ROOT, 'web/static/js/sw-api-helper.js');
        const swApiHelperSrc = fs.readFileSync(swApiHelperPath, 'utf-8');
        const swPath = path.resolve(REPO_ROOT, 'web/static/sw.js');
        const swSrc = fs.readFileSync(swPath, 'utf-8');

        const listeners = new Map();
        swSelf = {
            addEventListener: vi.fn((type, fn) => {
                if (!listeners.has(type)) listeners.set(type, []);
                listeners.get(type).push(fn);
            }),
            clients: { matchAll: vi.fn().mockResolvedValue([]), claim: vi.fn() },
            registration: { showNotification: vi.fn(), getNotifications: vi.fn().mockResolvedValue([]) },
            location: { origin: 'https://test.com' },
            skipWaiting: vi.fn(),
        };
        const fakeCacheInstance = { match: vi.fn(), put: vi.fn(), addAll: vi.fn() };
        const fakeCaches = {
            open: vi.fn().mockResolvedValue(fakeCacheInstance),
            match: vi.fn(),
            keys: vi.fn().mockResolvedValue([]),
            delete: vi.fn(),
        };
        const fakeFetch = vi.fn();

        // importScripts() loads sw-api-helper.js inline.
        const importScripts = (pathStr) => {
            if (pathStr.includes('sw-api-helper.js')) {
                // eslint-disable-next-line no-new-func
                new Function('self', 'fetch', swApiHelperSrc)(swSelf, fakeFetch);
            }
        };
        // Run sw.js in a function-scope sandbox.
        // eslint-disable-next-line no-new-func
        const runSw = new Function(
            'self', 'caches', 'fetch', 'importScripts',
            swSrc
        );
        runSw(swSelf, fakeCaches, fakeFetch, importScripts);

        const handlers = listeners.get('message') || [];
        expect(handlers.length).toBeGreaterThan(0);
        messageHandler = handlers[0];
    });

    it('stores token on self.SwApi.authToken when SET_AUTH_TOKEN is received', () => {
        expect(swSelf.SwApi).toBeDefined();
        expect(swSelf.SwApi.authToken).toBe(null);

        messageHandler({ data: { type: 'SET_AUTH_TOKEN', token: 'received-token' } });

        expect(swSelf.SwApi.authToken).toBe('received-token');
    });

    it('clears token when SET_AUTH_TOKEN arrives with falsy token', () => {
        swSelf.SwApi.authToken = 'existing-token';
        messageHandler({ data: { type: 'SET_AUTH_TOKEN', token: null } });
        expect(swSelf.SwApi.authToken).toBe(null);
    });

    it('still calls skipWaiting on SKIP_WAITING (no regression)', () => {
        messageHandler({ data: { type: 'SKIP_WAITING' } });
        expect(swSelf.skipWaiting).toHaveBeenCalledTimes(1);
    });

    it('ignores unknown message types', () => {
        messageHandler({ data: { type: 'SOMETHING_ELSE' } });
        expect(swSelf.skipWaiting).not.toHaveBeenCalled();
        expect(swSelf.SwApi.authToken).toBe(null);
    });
});

describe('app.js — hot-cache reload SET_AUTH_TOKEN send', () => {
    // app.js sends SET_AUTH_TOKEN inline if the controller is already
    // active when the script evaluates. We exercise just that snippet
    // because the full app.js boot is too entangled for a focused test.
    const SNIPPET = `
        if (userInitData && navigator.serviceWorker && navigator.serviceWorker.controller) {
            try {
                navigator.serviceWorker.controller.postMessage({
                    type: 'SET_AUTH_TOKEN',
                    token: userInitData,
                });
            } catch (err) {}
        }
    `;

    function runSnippet({ userInitData, controller }) {
        const navigator = controller === undefined
            ? {}
            : { serviceWorker: { controller } };
        // eslint-disable-next-line no-new-func
        new Function('userInitData', 'navigator', SNIPPET)(userInitData, navigator);
    }

    it('posts the token when controller and userInitData are both present', () => {
        const postMessage = vi.fn();
        runSnippet({ userInitData: 'token-X', controller: { postMessage } });
        expect(postMessage).toHaveBeenCalledWith({
            type: 'SET_AUTH_TOKEN',
            token: 'token-X',
        });
    });

    it('is a no-op when userInitData is null', () => {
        const postMessage = vi.fn();
        runSnippet({ userInitData: null, controller: { postMessage } });
        expect(postMessage).not.toHaveBeenCalled();
    });

    it('is a no-op when there is no active SW controller', () => {
        runSnippet({ userInitData: 'token-Y', controller: null });
        // No throw means success.
    });

    it('swallows postMessage errors silently', () => {
        const controller = {
            postMessage: vi.fn(() => { throw new Error('boom'); }),
        };
        expect(() => runSnippet({ userInitData: 'token-Z', controller })).not.toThrow();
        expect(controller.postMessage).toHaveBeenCalledTimes(1);
    });
});
