// med-deq.1 / med-gvk.5 — the cloud SW's offline app shell: CACHE-FIRST fetch
// handler backed by the versioned SHELL_CACHE. A cached static asset is served
// immediately with no network wait (the sub-second local-first guarantee); the
// navigation document is stale-while-revalidate (cached now, background
// fetch('/') refreshes for next open). A cache MISS goes to the network,
// caches an ok response, and — on rejection or proxy 5xx (docs/technical-
// decisions.md treats them the same) — the cached copy renders; the '/' shell
// fallback applies to navigations only and never to ceremony pages (signup.html
// is a different document); /api/* and non-GET are never intercepted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SW_ORIGIN as ORIGIN, loadCloudSw } from './helpers/sw-loader.js';
import { allowConsoleNoise } from '../../../static/js/tests/helpers/setup.js';
import { createAIClient } from '../aiclient.js';

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
        has: vi.fn(async (name) => store.has(name)),
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

    it('offline: a ceremony page never gets the / app shell — it gets the script-free retry document (no reload loop)', async () => {
        // '/' would boot cloud-boot.js, which redirects a locked device back to
        // /unlock → served '/' again → infinite reload loop (med-eas.16).
        const appShell = { ok: true, body: 'app html' };
        caches.seed(SHELL_CACHE, '/', appShell);
        fetchMock.mockRejectedValue(new TypeError('network down'));

        for (const path of ['/unlock', '/claim', '/recover', '/devices', '/connectors']) {
            const { response } = await fireFetch(listeners, navigate(path));
            expect(response).not.toBe(appShell);
            expect(response.status).toBe(503);
            expect(await response.text()).not.toContain('<script');
        }
    });

    it('offline: a navigation with nothing cached gets the 503 retry document, never written to cache (med-gacq)', async () => {
        fetchMock.mockRejectedValue(new TypeError('network down'));

        const { response } = await fireFetch(listeners, navigate('/'));
        expect(response.status).toBe(503);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        const body = await response.text();
        expect(body).toContain("Can't reach the server.");
        expect(body).toContain('<a href="">Retry</a>');
        expect(caches.store.get(SHELL_CACHE)).toBeUndefined();
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

    // med-gvk.5 — cache-first shell. The headline: a cached asset is served with
    // ZERO network wait, so a slow (not failed) network can no longer stall the
    // cold open.
    it('cache-first: a cached static asset is served WITHOUT awaiting the network', async () => {
        const cachedAsset = { ok: true, body: 'cached app.js' };
        caches.seed(SHELL_CACHE, '/static/js/app.js?v=1', cachedAsset);
        // A network-first handler would await this forever; cache-first never asks.
        fetchMock.mockReturnValue(new Promise(() => {}));

        const { response } = await fireFetch(listeners, req('/static/js/app.js?v=1'));
        expect(response).toBe(cachedAsset);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('cache-first miss: an uncached asset is fetched, returned, and cached', async () => {
        const fresh = networkResponse();
        fetchMock.mockResolvedValue(fresh);

        const { response } = await fireFetch(listeners, req('/static/js/new.js?v=2'));
        expect(response).toBe(fresh);
        expect(caches.store.get(SHELL_CACHE).get('/static/js/new.js?v=2')).toBe(fresh.__clone);
    });

    it('stale-while-revalidate: the cached / shell is served immediately AND a background revalidate refreshes it', async () => {
        const cachedShell = { ok: true, body: 'cached shell' };
        caches.seed(SHELL_CACHE, '/', cachedShell);
        const fresh = networkResponse();
        fetchMock.mockResolvedValue(fresh);

        const { response } = await fireFetch(listeners, navigate('/'));
        // Served from cache — NOT the fresh network response.
        expect(response).toBe(cachedShell);
        // A background fetch('/') was issued and it refreshed the cache for next open.
        expect(fetchMock).toHaveBeenCalledWith('/');
        expect(caches.store.get(SHELL_CACHE).get('/')).toBe(fresh);
    });

    it('stale-while-revalidate: a failing background revalidate does not reject the served cached shell', async () => {
        const cachedShell = { ok: true, body: 'cached shell' };
        caches.seed(SHELL_CACHE, '/', cachedShell);
        fetchMock.mockRejectedValue(new TypeError('network down'));

        // fireFetch also drains waitUntil (where the revalidate runs) — a leaked
        // rejection there would surface here.
        const { response } = await fireFetch(listeners, navigate('/'));
        expect(response).toBe(cachedShell);
        expect(fetchMock).toHaveBeenCalledWith('/');
    });

    // HTML/CSP fixture mirrors the owning router's
    // TestRouter_AppDocumentReflectsEgressHosts exact-response contract.
    const policyDocument = (host, build = 'checked') => new Response(
        `<head><meta name="medtracker-connect-origins" content='["https://${host}"]'><script src="/static/js/app.js?v=${build}"></script></head>`,
        { headers: { 'Content-Security-Policy': `default-src 'self'; connect-src 'self' https://${host}` } });

    it('acknowledges fresh-navigation support without claiming any origin permission', () => {
        const postMessage = vi.fn();
        listeners.get('message')[0]({ data: { type: 'PROVIDER_RELOAD_CAPABILITY' }, ports: [{ postMessage }] });
        expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'PROVIDER_RELOAD_CAPABILITY', version: 1 });
    });

    it('explicit Reload uses the first fresh response/CSP after registration, not cached policy A', async () => {
        const old = policyDocument('a.example');
        caches.seed(SHELL_CACHE, '/', old);
        const next = policyDocument('b.example');
        fetchMock.mockResolvedValue(next);
        const args = { intent: 'draft', draft: { api_key: 'fixture-only', url: 'https://b.example/v1' } };
        const oldClient = createAIClient({ documentPolicy: { origins: '["https://a.example"]', origin: ORIGIN } });
        expect(oldClient.keyCheckPermission(args).state).toBe('needs_reload');
        // The registration POST is outside the SW; its success grants nothing.
        expect((await fireFetch(listeners, req('/api/egress-hosts', { method: 'POST' }))).response).toBeUndefined();
        expect(oldClient.keyCheckPermission(args).state).toBe('needs_reload');
        const request = navigate('/?__wg_provider_reload=1');
        const { response } = await fireFetch(listeners, request);
        expect(response).toBe(next);
        expect(fetchMock).toHaveBeenCalledWith(request, { cache: 'no-store', signal: expect.any(AbortSignal) });
        expect(response.headers.get('Content-Security-Policy')).toContain('https://b.example');
        const origins = (await response.clone().text()).match(/content='([^']+)'/)[1];
        expect(createAIClient({ documentPolicy: { origins, origin: ORIGIN } }).keyCheckPermission(args).state).toBe('ready');
        expect(oldClient.keyCheckPermission(args).state).toBe('needs_reload');
        expect(caches.store.get(SHELL_CACHE).get('/').headers.get('Content-Security-Policy')).toContain('https://b.example');
    });

    it.each([401, 503])('fresh navigation HTTP %i returns retry, never a cached success', async (status) => {
        caches.seed(SHELL_CACHE, '/', policyDocument('a.example'));
        fetchMock.mockResolvedValue(new Response('unavailable', { status }));
        const { response } = await fireFetch(listeners, navigate('/?__wg_provider_reload=1'));
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain('medtracker-connect-origins');
        expect(caches.store.get(SHELL_CACHE).get('/').headers.get('Content-Security-Policy')).toContain('a.example');
    });

    it('rejects a newer-build response instead of putting it into an older coherent graph', async () => {
        const version = 'vchecked';
        ({ listeners } = loadCloudSw({ fetch: fetchMock, caches, swVersion: version }));
        caches.seed('medtracker-cloud-shell-' + version, '/', policyDocument('a.example'));
        fetchMock.mockResolvedValue(policyDocument('b.example', 'newer'));
        const { response } = await fireFetch(listeners, navigate('/?__wg_provider_reload=1'));
        expect(response.status).toBe(503);
        expect(caches.store.get('medtracker-cloud-shell-' + version).get('/').headers.get('Content-Security-Policy')).toContain('a.example');
    });

    it.each(['offline', 'redirect', 'missing-meta', 'missing-csp'])('fresh %s failure does not poison the ordinary offline shell', async (failure) => {
        const old = policyDocument('a.example');
        caches.seed(SHELL_CACHE, '/', old);
        let next = policyDocument('b.example');
        if (failure === 'offline') fetchMock.mockRejectedValue(new TypeError('offline'));
        else {
            if (failure === 'redirect') Object.defineProperty(next, 'redirected', { value: true });
            if (failure === 'missing-meta') next = new Response('<head>sign in</head>', { headers: next.headers });
            if (failure === 'missing-csp') next = new Response(await next.text());
            fetchMock.mockResolvedValue(next);
        }
        const { response } = await fireFetch(listeners, navigate('/?__wg_provider_reload=1'));
        expect(response.status).toBe(503);
        expect(caches.store.get(SHELL_CACHE).get('/')).toBe(old);
    });

    it('bounds the full fresh body and never caches a late successful response after timeout', async () => {
        vi.useFakeTimers();
        try {
            const old = policyDocument('a.example');
            caches.seed(SHELL_CACHE, '/', old);
            let finishBody;
            const next = policyDocument('b.example');
            fetchMock.mockResolvedValue({ ok: true, headers: next.headers, clone: () => ({ text: () => new Promise((resolve) => { finishBody = resolve; }) }) });
            const { promise } = fireFetchRaw(listeners, navigate('/?__wg_provider_reload=1'));
            await vi.advanceTimersByTimeAsync(5001);
            expect((await promise).status).toBe(503);
            finishBody(await next.text());
            await vi.advanceTimersByTimeAsync(1);
            expect(caches.store.get(SHELL_CACHE).get('/')).toBe(old);
        } finally { vi.useRealTimers(); }
    });

    // A body-carrying response for the install warm: clone() and text() are
    // what warmShell consumes.
    const bodyResponse = (body, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        clone() { return this; },
        text: async () => body,
    });

    const fireInstall = () => {
        const handler = listeners.get('install')[0];
        let waited;
        handler({ waitUntil: (p) => { waited = p; } });
        return waited;
    };

    it('install warms the complete shell: document, its subresources, and the crawled module graph', async () => {
        const files = {
            // The two <a> tags must be SKIPPED: same-origin /devices serves a
            // different HTML document whose own subresources the warm doesn't
            // crawl — caching it would break the ceremony page offline. There
            // is no /devices entry in `files`, so fetching it would 404 and
            // reject install; this test passing proves anchors are ignored.
            '/': '<script src="/static/a.js?v=1"></script><link rel="stylesheet" href="/static/s.css?v=1">'
                + '<script src="/js/boot.js"></script><a href="/devices">nav</a>'
                + '<a href="https://example.com/off-origin">x</a>',
            '/static/a.js?v=1': '// classic script, no imports',
            '/static/s.css?v=1': 'body{}',
            // Dynamic import + static re-export + relative resolution across mounts.
            '/js/boot.js': "const m = await import('/js/mod.js'); // from 'not a path'",
            '/js/mod.js': "export { x } from '../../domain/pure.js';\nimport('/static/vendor/opaque.min.js');",
            '/domain/pure.js': 'export const x = 1;',
            // Vendor is cached but NOT crawled — its `from "./chunk.js"` must be ignored.
            '/static/vendor/opaque.min.js': 'z=1;from"./chunk-does-not-exist.js"',
        };
        fetchMock.mockImplementation(async (url) => {
            const u = new URL(url, ORIGIN);
            const body = files[u.pathname + u.search];
            return body === undefined ? bodyResponse('', 404) : bodyResponse(body);
        });

        await fireInstall();

        expect(self.skipWaiting).not.toHaveBeenCalled();
        const cached = caches.store.get(SHELL_CACHE);
        for (const key of Object.keys(files)) expect(cached.has(key), key).toBe(true);
        expect(cached.size).toBe(Object.keys(files).length);
    });

    it('install REJECTS when a crawled module fails, leaves no partial cache and the previous generation untouched; a clean retry succeeds (med-5h1t.6)', async () => {
        // A skipped module used to be filled later on a cache miss from the
        // NEWER deploy, next to this generation's siblings — a mixed crypto/
        // unlock/sync graph. The crawled graph is all-or-nothing now.
        const OLD_CACHE = 'medtracker-cloud-shell-PREVIOUS';
        const oldBoot = bodyResponse('// generation N boot');
        caches.seed(OLD_CACHE, '/js/boot.js', oldBoot);
        const files = {
            '/': '<script src="/js/boot.js"></script><link rel="stylesheet" href="/static/s.css?v=1">',
            '/static/s.css?v=1': 'body{}',
            // boot.js imports two modules: one resolves, one 404s (transient).
            '/js/boot.js': "import('/js/good.js'); import('/js/flaky.js');",
            '/js/good.js': 'export const ok = 1;',
        };
        fetchMock.mockImplementation(async (url) => {
            const u = new URL(url, ORIGIN);
            const body = files[u.pathname + u.search];
            return body === undefined ? bodyResponse('', 404) : bodyResponse(body);
        });

        await expect(fireInstall()).rejects.toThrow('/js/flaky.js');

        // No half-warmed generation survives for the global caches.match to
        // leak into the still-active previous SW; the previous cache is intact.
        expect(caches.store.has(SHELL_CACHE)).toBe(false);
        expect(caches.store.get(OLD_CACHE).get('/js/boot.js')).toBe(oldBoot);

        // The browser retries the update on a later navigation; now it is clean.
        files['/js/flaky.js'] = 'export const back = 1;';
        await fireInstall();
        const cached = caches.store.get(SHELL_CACHE);
        for (const key of Object.keys(files)) expect(cached.has(key), key).toBe(true);
        expect(self.skipWaiting).not.toHaveBeenCalled();
    });

    it('a failed install never deletes a SAME-NAME cache it did not create (reused stamp = the active worker\'s cache) (med-5h1t.6)', async () => {
        // Rollback to the active image, same-minute deploys, or unstamped dev
        // reuse SW_VERSION, so SHELL_CACHE already belongs to the live worker.
        const liveBoot = bodyResponse('// active worker boot');
        caches.seed(SHELL_CACHE, '/js/boot.js', liveBoot);
        fetchMock.mockImplementation(async (url) =>
            new URL(url, ORIGIN).pathname === '/'
                ? bodyResponse('<script src="/js/boot.js"></script>')
                : bodyResponse('', 404)
        );

        await expect(fireInstall()).rejects.toThrow('/js/boot.js');

        expect(caches.delete).not.toHaveBeenCalled();
        expect(caches.store.get(SHELL_CACHE).get('/js/boot.js')).toBe(liveBoot);
    });

    it('install REJECTS when a module in the ceremony graph fails — a non-module ceremony asset (css) stays best-effort (med-5h1t.6)', async () => {
        // Ceremony modules share crypto/unlock/sync with the '/' graph, so a
        // skipped one would later be filled from a newer deploy — fatal too.
        allowConsoleNoise(); // the skipped-best-effort-css warning logs by design
        const files = {
            '/': '<script src="/static/a.js?v=1"></script>',
            '/static/a.js?v=1': '// no imports',
            '/unlock': '<link rel="stylesheet" href="/css/cloud.css"><script src="/js/app.js" type="module"></script>',
            // '/css/cloud.css' absent → skipped, not fatal.
            '/js/app.js': "await import('/js/unlock.js');",
            '/js/unlock.js': 'export const x = 1;',
        };
        fetchMock.mockImplementation(async (url) => {
            const u = new URL(url, ORIGIN);
            const body = files[u.pathname + u.search];
            return body === undefined ? bodyResponse('', 404) : bodyResponse(body);
        });

        await fireInstall(); // a missing stylesheet cannot skew a module graph
        expect(caches.store.get(SHELL_CACHE).has('/js/unlock.js')).toBe(true);
        expect(caches.store.get(SHELL_CACHE).has('/css/cloud.css')).toBe(false);

        delete files['/js/unlock.js'];
        await caches.delete(SHELL_CACHE);
        await expect(fireInstall()).rejects.toThrow('/js/unlock.js');
        expect(caches.store.has(SHELL_CACHE)).toBe(false);
    });

    it('install REJECTS when a direct HTML subresource of / fails — a later visit retries (med-gvk.1)', async () => {
        // A directly-referenced <script src>/<link href> the browser fetches to paint has no runtime
        // backfill before the JS runs, so a miss = a broken offline shell.
        // Rejecting keeps the old SW + complete cache live for the retry.
        fetchMock.mockImplementation(async (url) =>
            new URL(url, ORIGIN).pathname === '/'
                ? bodyResponse('<link rel="stylesheet" href="/static/core.css?v=1">')
                : bodyResponse('', 404)
        );
        await expect(fireInstall()).rejects.toThrow('/static/core.css');
    });

    it('install REJECTS on a failed warm-up, so activate never prunes the old complete cache', async () => {
        // The inverse of the pre-med-deq.1 "best effort" behavior: a partial
        // warm must not activate, because activation deletes the previous
        // version's complete cache.
        fetchMock.mockRejectedValue(new TypeError('network down'));
        await expect(fireInstall()).rejects.toThrow();
    });

    it('install REJECTS when a referenced subresource 404s', async () => {
        fetchMock.mockImplementation(async (url) =>
            new URL(url, ORIGIN).pathname === '/'
                ? bodyResponse('<script src="/static/gone.js"></script>')
                : bodyResponse('', 404)
        );
        await expect(fireInstall()).rejects.toThrow('/static/gone.js');
    });

    // Disk-backed install: replay the warm against the REAL repo files, routed
    // the way router.go routes them. install rejects on any 404, so this test
    // fails the moment index.html or the /js + /domain module graph references
    // a file that doesn't exist — the guard that keeps the atomic install from
    // permanently wedging SW updates in production (med-jb7.2).
    it('install warm resolves against the real repo tree and caches the boot-critical module graph', async () => {
        const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
        const routerGo = fs.readFileSync(path.join(REPO_ROOT, 'internal/cloudserver/router.go'), 'utf8');
        // The served '/' document is index.html plus router.go's injected
        // scripts; pin the emulation to router.go's actual srcs.
        for (const injected of ['/js/cloud-boot.js', '/js/update-check.js']) {
            expect(routerGo, `router.go no longer injects ${injected}`).toContain(injected);
        }
        const appIndex = fs
            .readFileSync(path.join(REPO_ROOT, 'web/static/index.html'), 'utf8')
            .replace(
                '<head>',
                '<head><script src="/js/cloud-boot.js"></script><script type="module" src="/js/update-check.js"></script>'
            );
        // router.go rewrites all five ceremony paths to /signup.html internally
        // (router.go L334-337), so the mock serves that same document for each —
        // exactly what warmCeremony fetches ('/unlock') and caches under every
        // ceremony path. The ceremony warm then crawls signup's
        // module graph against the real /js + /css tree.
        const CEREMONY = new Set(['/unlock', '/claim', '/recover', '/devices', '/connectors']);
        fetchMock.mockImplementation(async (url) => {
            const { pathname } = new URL(url, ORIGIN);
            let body;
            if (pathname === '/') body = appIndex;
            else if (CEREMONY.has(pathname)) body = fs.readFileSync(path.join(REPO_ROOT, 'web/cloud/signup.html'), 'utf8');
            else {
                let file;
                if (pathname === '/static/config.js') return { ok: true, status: 200, clone() { return this; }, text: async () => '// generated by router.go' };
                if (pathname.startsWith('/static/')) file = 'web/static/' + pathname.slice('/static/'.length);
                else if (pathname.startsWith('/domain/')) file = 'web/domain/' + pathname.slice('/domain/'.length);
                else file = 'web/cloud' + pathname;
                const abs = path.join(REPO_ROOT, file);
                if (!fs.existsSync(abs)) return { ok: false, status: 404, clone() { return this; } };
                body = fs.readFileSync(abs, 'utf8');
            }
            return { ok: true, status: 200, clone() { return this; }, text: async () => body };
        });

        await fireInstall();

        const cached = caches.store.get(SHELL_CACHE);
        const keys = [...cached.keys()];
        // The offline boot chain: document → cloud-boot → dynamic imports →
        // apishim's relative ../../domain/* — each layer must be warmed.
        expect(cached.has('/')).toBe(true);
        for (const mod of ['/js/cloud-boot.js', '/js/unlock.js', '/js/apishim.js', '/js/sync.js', '/domain/vault.js', '/domain/bp.js']) {
            expect(cached.has(mod), mod).toBe(true);
        }
        // The HTML's fingerprinted classic scripts are cached under their full URL.
        expect(keys).toContain('/static/js/core/utils.js?v=TIMESTAMP_PLACEHOLDER');
        expect(keys.filter((k) => k.startsWith('/static/')).length).toBeGreaterThan(50);
        // med-gvk.3: the ceremony document (signup.html) is now warmed under
        // EVERY ceremony path so an offline navigation to any of them is an
        // exact cache hit (cachedNavigationDoc), plus signup's boot-critical
        // module graph reachable from /js/app.js's dynamic imports.
        for (const p of ['/unlock', '/claim', '/recover', '/devices', '/connectors']) {
            expect(cached.has(p), p).toBe(true);
        }
        for (const mod of ['/js/app.js', '/js/unlock.js', '/js/devices.js', '/js/connectors.js', '/js/claim.js', '/js/recover.js', '/js/signup.js']) {
            expect(cached.has(mod), mod).toBe(true);
        }
    });

    it('install warms the ceremony shell under EVERY ceremony path plus its css + module graph (med-gvk.3)', async () => {
        // The router serves signup.html for all five ceremony paths; warmCeremony
        // fetches one ('/unlock') and caches that body under every path so an
        // offline navigation to any of them is an exact cache hit.
        const signup = '<link rel="stylesheet" href="/css/cloud.css">'
            + '<script src="/js/app.js" type="module"></script>';
        const files = {
            '/': '<script src="/static/a.js?v=1"></script>',
            '/static/a.js?v=1': '// no imports',
            '/unlock': signup,
            '/css/cloud.css': 'body{}',
            // app.js dynamic-imports the ceremony graph — crawled via MODULE_IMPORT_RE.
            '/js/app.js': "await import('/js/unlock.js');",
            '/js/unlock.js': 'export const x = 1;',
        };
        fetchMock.mockImplementation(async (url) => {
            const u = new URL(url, ORIGIN);
            const body = files[u.pathname + u.search];
            return body === undefined ? bodyResponse('', 404) : bodyResponse(body);
        });

        await fireInstall();

        const cached = caches.store.get(SHELL_CACHE);
        // Primary '/' shell still cached alongside the ceremony shell.
        expect(cached.has('/')).toBe(true);
        expect(cached.has('/static/a.js?v=1')).toBe(true);
        // Ceremony doc cached under all five paths + its css + dynamic-import graph.
        for (const p of ['/unlock', '/claim', '/recover', '/devices', '/connectors']) {
            expect(cached.has(p), p).toBe(true);
        }
        expect(cached.has('/css/cloud.css')).toBe(true);
        expect(cached.has('/js/app.js')).toBe(true);
        expect(cached.has('/js/unlock.js')).toBe(true);
    });

    it('a 404 ceremony document does NOT reject install — the primary / shell is still cached (med-gvk.3)', async () => {
        // The ceremony document 404s (no /unlock in the mock), so warmCeremony
        // returns quietly and install still resolves with the strict '/' shell
        // fully cached. (A ceremony MODULE failure rejects — med-5h1t.6.)
        const files = {
            '/': '<script src="/static/a.js?v=1"></script>',
            '/static/a.js?v=1': '// no imports',
            // '/unlock' absent → 404 → warmCeremony skips silently.
        };
        fetchMock.mockImplementation(async (url) => {
            const u = new URL(url, ORIGIN);
            const body = files[u.pathname + u.search];
            return body === undefined ? bodyResponse('', 404) : bodyResponse(body);
        });

        await fireInstall(); // must NOT throw

        const cached = caches.store.get(SHELL_CACHE);
        expect(cached.has('/')).toBe(true);
        expect(cached.has('/static/a.js?v=1')).toBe(true);
        expect(cached.has('/unlock')).toBe(false);
        expect(self.skipWaiting).not.toHaveBeenCalled();
    });

    it('SKIP_WAITING message calls skipWaiting; unrelated messages do not (no-hijack update dance)', () => {
        const handler = listeners.get('message')[0];

        handler({ data: { type: 'x' } });
        expect(self.skipWaiting).not.toHaveBeenCalled();

        handler({ data: { type: 'SKIP_WAITING' } });
        expect(self.skipWaiting).toHaveBeenCalled();
    });

    // med-gacq — the white screen after a deploy. The old worker stored the NEW
    // build's '/' in its own cache; the next open served it and every ?v=<new>
    // render-blocking asset missed and hung on the network.
    describe('stamped build (med-gacq)', () => {
        const BUILD = '20261026-0543';
        const STAMPED_CACHE = 'medtracker-cloud-shell-v' + BUILD;
        const htmlResponse = (v) => ({
            ok: true,
            status: 200,
            clone() { return this; },
            text: async () => `<link rel="stylesheet" href="/static/css/styles.css?v=${v}">`,
        });

        beforeEach(() => {
            ({ self, listeners } = loadCloudSw({ fetch: fetchMock, caches, swVersion: 'v' + BUILD }));
        });

        it('revalidateShell leaves the cached / untouched when the served document is another build', async () => {
            const cachedShell = { ok: true, body: 'this build' };
            caches.seed(STAMPED_CACHE, '/', cachedShell);
            fetchMock.mockResolvedValue(htmlResponse('20261026-0600'));

            const { response } = await fireFetch(listeners, navigate('/'));
            expect(response).toBe(cachedShell);
            expect(fetchMock).toHaveBeenCalledWith('/');
            expect(caches.store.get(STAMPED_CACHE).get('/')).toBe(cachedShell);
        });

        it('revalidateShell replaces the cached / with a same-build document (per-account CSP refresh)', async () => {
            caches.seed(STAMPED_CACHE, '/', { ok: true, body: 'old csp' });
            const fresh = htmlResponse(BUILD);
            fetchMock.mockResolvedValue(fresh);

            await fireFetch(listeners, navigate('/'));
            expect(caches.store.get(STAMPED_CACHE).get('/')).toBe(fresh);
        });
    });

    describe('bounded network wait on a cache miss (med-gacq)', () => {
        beforeEach(() => { vi.useFakeTimers(); });
        afterEach(() => { vi.useRealTimers(); });

        it('a navigation miss whose fetch never settles gets a retry document within the bound — ceremony paths too, never the / shell', async () => {
            fetchMock.mockReturnValue(new Promise(() => {}));
            for (const path of ['/', '/unlock']) {
                const { promise } = fireFetchRaw(listeners, navigate(path));
                await vi.advanceTimersByTimeAsync(5000);
                const response = await promise;
                expect(response.status).toBe(503);
                expect(response.headers.get('Content-Type')).toContain('text/html');
                const body = await response.text();
                expect(body).toContain("Can't reach the server.");
                expect(body).toContain('<a href="">Retry</a>');
                expect(body).not.toContain('<script');
            }
        });


        it('a navigation miss that times out falls back to a cached / shell when one appears', async () => {
            // A deep link with no exact copy: cachedNavigationDoc misses only if
            // '/' is absent at lookup; offlineFallback re-checks after the timeout.
            const shell = { ok: true, body: 'shell html' };
            fetchMock.mockReturnValue(new Promise(() => {}));
            const { promise } = fireFetchRaw(listeners, navigate('/some/route'));
            await vi.advanceTimersByTimeAsync(0);
            caches.seed(SHELL_CACHE, '/', shell);
            await vi.advanceTimersByTimeAsync(5000);
            await expect(promise).resolves.toBe(shell);
        });

        it('a render-blocking CSS miss whose fetch never settles errors within the bound', async () => {
            fetchMock.mockReturnValue(new Promise(() => {}));
            const css = { ...req('/static/css/styles.css?v=2'), destination: 'style' };
            const { promise } = fireFetchRaw(listeners, css);
            const settled = expect(promise).rejects.toThrow('network timeout');
            await vi.advanceTimersByTimeAsync(5000);
            await settled;
        });

        it('a slow but live response within the bound is served and cached', async () => {
            const fresh = networkResponse();
            fetchMock.mockReturnValue(new Promise((r) => setTimeout(() => r(fresh), 4000)));
            const css = { ...req('/static/css/styles.css?v=3'), destination: 'style' };
            const { evt, promise } = fireFetchRaw(listeners, css);
            await vi.advanceTimersByTimeAsync(4000);
            await expect(promise).resolves.toBe(fresh);
            await Promise.all(evt.waitUntil.mock.calls.map((c) => c[0]));
            expect(caches.store.get(SHELL_CACHE).get('/static/css/styles.css?v=3')).toBe(fresh.__clone);
        });
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
