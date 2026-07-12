// med-deq.1 — the cloud SW's offline app shell: network-first fetch handler
// backed by the versioned SHELL_CACHE. Online navigation always returns the
// network response (fresh per-account CSP) and refreshes the cache; offline
// (fetch rejection or proxy 5xx — docs/technical-decisions.md treats them the
// same) the cached copy renders; the '/' shell fallback applies to navigations
// only and never to ceremony pages (signup.html is a different document);
// /api/* and non-GET are never intercepted.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SW_ORIGIN as ORIGIN, loadCloudSw } from './helpers/sw-loader.js';

// SW_VERSION is CACHE_VERSION_PLACEHOLDER at rest (rewritten per deploy).
const SHELL_CACHE = 'medtracker-cloud-shell-CACHE_VERSION_PLACEHOLDER';

// In-memory Cache API stand-in: name → Map(fullUrlKey → response). Like the
// real Cache API it keys on the full URL including the query string; a query
// is only ignored when a match passes { ignoreSearch: true }. Both the
// per-cache match/put/add and the global caches.match route through it.
function makeCaches(fetchImpl) {
    const store = new Map();
    const keyOf = (r) => {
        const u = typeof r === 'string' ? new URL(r, ORIGIN) : new URL(r.url);
        return u.pathname + u.search;
    };
    const lookup = (cache, r, opts) => {
        const key = keyOf(r);
        if (cache.has(key)) return cache.get(key);
        if (opts && opts.ignoreSearch) {
            const want = key.split('?')[0];
            for (const [k, v] of cache) if (k.split('?')[0] === want) return v;
        }
        return undefined;
    };
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
                match: async (r, opts) => lookup(cache, r, opts),
                put: async (r, resp) => { cache.set(keyOf(r), resp); },
                add: async (r) => {
                    const resp = await fetchImpl(r);
                    if (!resp || !resp.ok) throw new TypeError('cache.add: response not ok');
                    cache.set(keyOf(r), resp);
                },
            };
        }),
        match: vi.fn(async (r, opts) => {
            for (const cache of store.values()) {
                const hit = lookup(cache, r, opts);
                if (hit) return hit;
            }
            return undefined;
        }),
        keys: vi.fn(async () => [...store.keys()]),
        delete: vi.fn(async (name) => store.delete(name)),
    };
}

// Drive the fetch handler without settling the respondWith promise, for
// asserting rejection.
function fireFetchRaw(listeners, request) {
    const handler = listeners.get('fetch')[0];
    const evt = { request, respondWith: vi.fn(), waitUntil: vi.fn() };
    handler(evt);
    const promise = evt.respondWith.mock.calls.length > 0 ? evt.respondWith.mock.calls[0][0] : undefined;
    return { evt, promise };
}

// Drive the fetch handler, resolve the respondWith promise (if any), and
// drain waitUntil (the cache write happens there).
async function fireFetch(listeners, request) {
    const { evt, promise } = fireFetchRaw(listeners, request);
    const response = promise ? await promise : undefined;
    await Promise.all(evt.waitUntil.mock.calls.map((c) => c[0]));
    return { evt, response };
}

function req(pathname, { method = 'GET', origin = ORIGIN, mode } = {}) {
    return { method, url: origin + pathname, mode };
}

const navigate = (pathname) => req(pathname, { mode: 'navigate' });

function networkResponse(status = 200) {
    const clone = { cloned: true };
    return { ok: status >= 200 && status < 300, status, clone: () => clone, __clone: clone };
}

describe('cloud sw.js — offline app-shell fetch cache (med-deq.1)', () => {
    let fetchMock;
    let self;
    let listeners;
    let caches;

    beforeEach(() => {
        fetchMock = vi.fn();
        caches = makeCaches(fetchMock);
        ({ self, listeners } = loadCloudSw({ fetch: fetchMock, caches }));
    });

    it('offline: a document request falls back to the cached shell', async () => {
        const shell = { ok: true, body: 'shell html' };
        caches.seed(SHELL_CACHE, '/', shell);
        fetchMock.mockRejectedValue(new TypeError('network down'));

        const { response } = await fireFetch(listeners, navigate('/'));
        expect(response).toBe(shell);
    });

    it('offline: a deep-link navigation with no exact cache entry falls back to the cached / shell', async () => {
        const shell = { ok: true, body: 'shell html' };
        caches.seed(SHELL_CACHE, '/', shell);
        fetchMock.mockRejectedValue(new TypeError('network down'));

        const { response } = await fireFetch(listeners, navigate('/some/app/route'));
        expect(response).toBe(shell);
    });

    it('offline: a ceremony page never gets the / app shell — it surfaces the network outcome (no reload loop)', async () => {
        // '/' would boot cloud-boot.js, which redirects a locked device back to
        // /unlock → served '/' again → infinite reload loop (med-eas.16).
        caches.seed(SHELL_CACHE, '/', { ok: true, body: 'app html' });
        const err = new TypeError('network down');
        fetchMock.mockRejectedValue(err);

        for (const path of ['/unlock', '/claim', '/recover', '/devices', '/connectors']) {
            const { promise } = fireFetchRaw(listeners, navigate(path));
            await expect(promise).rejects.toBe(err);
        }
    });

    it('offline: a ceremony page with its own cached copy still renders it', async () => {
        const signupDoc = { ok: true, body: 'signup html' };
        caches.seed(SHELL_CACHE, '/unlock', signupDoc);
        caches.seed(SHELL_CACHE, '/', { ok: true, body: 'app html' });
        fetchMock.mockRejectedValue(new TypeError('network down'));

        const { response } = await fireFetch(listeners, navigate('/unlock'));
        expect(response).toBe(signupDoc);
    });

    it('offline: a notificationclick cold start (/?reminder_action=…) still hits the / shell', async () => {
        const shell = { ok: true, body: 'shell html' };
        caches.seed(SHELL_CACHE, '/', shell);
        fetchMock.mockRejectedValue(new TypeError('network down'));

        const { response } = await fireFetch(listeners, navigate('/?reminder_action=bp_snooze'));
        expect(response).toBe(shell);
    });

    it('offline: an uncached subresource rejects — it must NOT get the HTML shell', async () => {
        caches.seed(SHELL_CACHE, '/', { ok: true, body: 'shell html' });
        const err = new TypeError('network down');
        fetchMock.mockRejectedValue(err);

        const { promise } = fireFetchRaw(listeners, req('/static/js/app.js?v=123'));
        await expect(promise).rejects.toBe(err);
    });

    it('online: returns the network response and refreshes the versioned cache for / and /static/*', async () => {
        const docResp = networkResponse();
        const assetResp = networkResponse();
        fetchMock.mockResolvedValueOnce(docResp).mockResolvedValueOnce(assetResp);

        const doc = await fireFetch(listeners, navigate('/'));
        const asset = await fireFetch(listeners, req('/static/js/app.js?v=123'));

        // Network response wins — a cached document is never served online.
        expect(doc.response).toBe(docResp);
        expect(asset.response).toBe(assetResp);
        // Both writes landed in the SW_VERSION-keyed cache; the asset is keyed
        // on its full fingerprinted URL, like the real Cache API.
        expect(caches.store.get(SHELL_CACHE).get('/')).toBe(docResp.__clone);
        expect(caches.store.get(SHELL_CACHE).get('/static/js/app.js?v=123')).toBe(assetResp.__clone);
    });

    it('a 404 is returned as-is and not cached', async () => {
        const notFound = networkResponse(404);
        fetchMock.mockResolvedValue(notFound);

        const { response } = await fireFetch(listeners, req('/static/gone.js'));
        expect(response).toBe(notFound);
        expect(caches.store.get(SHELL_CACHE)).toBeUndefined();
    });

    it('a proxy 5xx serves the cached copy (5xx-as-offline)', async () => {
        const shell = { ok: true, body: 'shell html' };
        caches.seed(SHELL_CACHE, '/', shell);
        fetchMock.mockResolvedValue(networkResponse(502));

        const { response } = await fireFetch(listeners, navigate('/'));
        expect(response).toBe(shell);
    });

    it('a proxy 5xx with nothing cached returns the 5xx response itself', async () => {
        const bad = networkResponse(503);
        fetchMock.mockResolvedValue(bad);

        const { response } = await fireFetch(listeners, req('/static/js/app.js'));
        expect(response).toBe(bad);
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
        const { evt } = await fireFetch(listeners, req('/api/bp', { method: 'POST' }));
        const { evt: putEvt } = await fireFetch(listeners, req('/static/x.js', { method: 'PUT' }));
        expect(evt.respondWith).not.toHaveBeenCalled();
        expect(putEvt.respondWith).not.toHaveBeenCalled();
    });

    it('cross-origin requests pass through untouched', async () => {
        const { evt } = await fireFetch(listeners, req('/anything', { origin: 'https://api.elevenlabs.io' }));
        expect(evt.respondWith).not.toHaveBeenCalled();
    });

    it('install warms the shell document into the versioned cache', async () => {
        fetchMock.mockResolvedValue(networkResponse());

        const handler = listeners.get('install')[0];
        let waited;
        handler({ waitUntil: (p) => { waited = p; } });
        await waited;

        expect(self.skipWaiting).toHaveBeenCalled();
        expect(caches.store.get(SHELL_CACHE).get('/')).toBeDefined();
    });

    it('install survives a failed warm-up fetch', async () => {
        fetchMock.mockRejectedValue(new TypeError('network down'));

        const handler = listeners.get('install')[0];
        let waited;
        handler({ waitUntil: (p) => { waited = p; } });
        await expect(waited).resolves.toBeUndefined();
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
