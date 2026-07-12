// med-deq.1 — the cloud SW's offline app shell: network-first fetch handler
// backed by the versioned SHELL_CACHE. Online navigation always returns the
// network response (fresh per-account CSP) and refreshes the cache; offline
// the cached copy renders; /api/* and non-GET are never intercepted.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const ORIGIN = 'https://acct.medtracker.example';
// SW_VERSION is CACHE_VERSION_PLACEHOLDER at rest (rewritten per deploy).
const SHELL_CACHE = 'medtracker-cloud-shell-CACHE_VERSION_PLACEHOLDER';

// In-memory Cache API stand-in: name → Map(pathname → response). Both the
// per-cache match/put and the global caches.match(request) route through it.
function makeCaches() {
    const store = new Map();
    const keyOf = (r) => (typeof r === 'string' ? r : new URL(r.url).pathname);
    return {
        store,
        seed(name, key, response) {
            if (!store.has(name)) store.set(name, new Map());
            store.get(name).set(key, response);
        },
        open: vi.fn(async (name) => {
            if (!store.has(name)) store.set(name, new Map());
            const cache = store.get(name);
            return {
                match: async (r) => cache.get(keyOf(r)),
                put: async (r, resp) => { cache.set(keyOf(r), resp); },
            };
        }),
        match: vi.fn(async (r) => {
            for (const cache of store.values()) {
                const hit = cache.get(keyOf(r));
                if (hit) return hit;
            }
            return undefined;
        }),
        keys: vi.fn(async () => [...store.keys()]),
        delete: vi.fn(async (name) => store.delete(name)),
    };
}

function loadCloudSw(fetchMock) {
    const swSrc = fs.readFileSync(path.resolve(REPO_ROOT, 'web/cloud/sw.js'), 'utf-8');
    const listeners = new Map();
    const self = {
        addEventListener: vi.fn((type, fn) => {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        }),
        location: { origin: ORIGIN },
        clients: { matchAll: vi.fn().mockResolvedValue([]), openWindow: vi.fn(), claim: vi.fn() },
        registration: { showNotification: vi.fn() },
        skipWaiting: vi.fn(),
    };
    const caches = makeCaches();
    // eslint-disable-next-line no-new-func
    new Function('self', 'caches', 'fetch', 'indexedDB', swSrc)(self, caches, fetchMock, {});
    return { self, listeners, caches };
}

// Drive the fetch handler. Resolves the respondWith promise (if any) and
// drains waitUntil (the cache write happens there).
async function fireFetch(listeners, request) {
    const handler = listeners.get('fetch')[0];
    const evt = { request, respondWith: vi.fn(), waitUntil: vi.fn() };
    handler(evt);
    if (evt.respondWith.mock.calls.length === 0) return { evt, response: undefined };
    const response = await evt.respondWith.mock.calls[0][0];
    await Promise.all(evt.waitUntil.mock.calls.map((c) => c[0]));
    return { evt, response };
}

function req(pathname, method = 'GET', origin = ORIGIN) {
    return { method, url: origin + pathname };
}

function networkResponse() {
    const clone = { cloned: true };
    return { ok: true, clone: () => clone, __clone: clone };
}

describe('cloud sw.js — offline app-shell fetch cache (med-deq.1)', () => {
    let fetchMock;
    let self;
    let listeners;
    let caches;

    beforeEach(() => {
        fetchMock = vi.fn();
        ({ self, listeners, caches } = loadCloudSw(fetchMock));
    });

    it('offline: a document request falls back to the cached shell', async () => {
        const shell = { ok: true, body: 'shell html' };
        caches.seed(SHELL_CACHE, '/', shell);
        fetchMock.mockRejectedValue(new TypeError('network down'));

        const { response } = await fireFetch(listeners, req('/'));
        expect(response).toBe(shell);
    });

    it('offline: a deep link with no exact cache entry falls back to the cached / shell', async () => {
        const shell = { ok: true, body: 'shell html' };
        caches.seed(SHELL_CACHE, '/', shell);
        fetchMock.mockRejectedValue(new TypeError('network down'));

        const { response } = await fireFetch(listeners, req('/devices'));
        expect(response).toBe(shell);
    });

    it('online: returns the network response and refreshes the versioned cache for / and /static/*', async () => {
        const docResp = networkResponse();
        const assetResp = networkResponse();
        fetchMock.mockResolvedValueOnce(docResp).mockResolvedValueOnce(assetResp);

        const doc = await fireFetch(listeners, req('/'));
        const asset = await fireFetch(listeners, req('/static/js/app.js?v=123'));

        // Network response wins — a cached document is never served online.
        expect(doc.response).toBe(docResp);
        expect(asset.response).toBe(assetResp);
        // Both writes landed in the SW_VERSION-keyed cache.
        expect(caches.store.get(SHELL_CACHE).get('/')).toBe(docResp.__clone);
        expect(caches.store.get(SHELL_CACHE).get('/static/js/app.js')).toBe(assetResp.__clone);
    });

    it('/api/* is never intercepted, cached, or served from cache — even offline', async () => {
        caches.seed(SHELL_CACHE, '/api/whatever', { ok: true, body: 'stale api' });
        fetchMock.mockRejectedValue(new TypeError('network down'));

        const { evt } = await fireFetch(listeners, req('/api/whatever'));
        expect(evt.respondWith).not.toHaveBeenCalled();
        expect(caches.match).not.toHaveBeenCalled();
    });

    it('/mcp/* is never intercepted', async () => {
        const { evt } = await fireFetch(listeners, req('/mcp/relay'));
        expect(evt.respondWith).not.toHaveBeenCalled();
    });

    it('non-GET requests pass through untouched', async () => {
        const { evt } = await fireFetch(listeners, req('/api/bp', 'POST'));
        const { evt: putEvt } = await fireFetch(listeners, req('/static/x.js', 'PUT'));
        expect(evt.respondWith).not.toHaveBeenCalled();
        expect(putEvt.respondWith).not.toHaveBeenCalled();
    });

    it('cross-origin requests pass through untouched', async () => {
        const { evt } = await fireFetch(listeners, req('/anything', 'GET', 'https://api.elevenlabs.io'));
        expect(evt.respondWith).not.toHaveBeenCalled();
    });

    it('activate prunes old prefixed caches, keeps the current shell cache and unrelated caches', async () => {
        caches.seed('medtracker-cloud-shell-vOLD', '/', {});
        caches.seed(SHELL_CACHE, '/', {});
        caches.seed('some-other-app', '/', {});

        const handler = listeners.get('activate')[0];
        let waited;
        handler({ waitUntil: (p) => { waited = p; } });
        await waited;

        expect(caches.delete).toHaveBeenCalledWith('medtracker-cloud-shell-vOLD');
        expect(caches.delete).not.toHaveBeenCalledWith(SHELL_CACHE);
        expect(caches.delete).not.toHaveBeenCalledWith('some-other-app');
        expect(self.clients.claim).toHaveBeenCalled();
    });
});
