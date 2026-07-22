// med-deq.1 — the cloud SW's offline app shell: network-first fetch handler
// backed by the versioned SHELL_CACHE. Online navigation always returns the
// network response (fresh per-account CSP) and refreshes the cache; offline
// (fetch rejection or proxy 5xx — docs/technical-decisions.md treats them the
// same) the cached copy renders; the '/' shell fallback applies to navigations
// only and never to ceremony pages (signup.html is a different document);
// /api/* and non-GET are never intercepted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SW_ORIGIN as ORIGIN, loadCloudSw } from './helpers/sw-loader.js';
import { allowConsoleNoise } from '../../../static/js/tests/helpers/setup.js';

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

        expect(self.skipWaiting).toHaveBeenCalled();
        const cached = caches.store.get(SHELL_CACHE);
        for (const key of Object.keys(files)) expect(cached.has(key), key).toBe(true);
        expect(cached.size).toBe(Object.keys(files).length);
    });

    it('install stays usable when an OPTIONAL module-graph asset fails: caches the rest, skips the flaky one (med-gvk.1)', async () => {
        // The headline: pre-med-gvk.1 a single flaky subresource rejected the
        // whole install so NOTHING cached. Now a failure in the transitively-
        // crawled ES-module graph (OPTIONAL — the running JS re-fetches it, and
        // the fetch handler backfills it) is logged + skipped; the core shell
        // and every sibling that succeeded are still cached and install resolves.
        allowConsoleNoise(); // the skipped-optional-asset warning logs by design
        const files = {
            '/': '<script src="/js/boot.js"></script><link rel="stylesheet" href="/static/s.css?v=1">',
            '/static/s.css?v=1': 'body{}',
            // boot.js imports two modules: one resolves, one 404s.
            '/js/boot.js': "import('/js/good.js'); import('/js/flaky.js');",
            '/js/good.js': 'export const ok = 1;',
            // '/js/flaky.js' is absent → 404 → OPTIONAL reject → skipped, not fatal.
        };
        fetchMock.mockImplementation(async (url) => {
            const u = new URL(url, ORIGIN);
            const body = files[u.pathname + u.search];
            return body === undefined ? bodyResponse('', 404) : bodyResponse(body);
        });

        await fireInstall(); // must NOT throw

        const cached = caches.store.get(SHELL_CACHE);
        for (const key of ['/', '/static/s.css?v=1', '/js/boot.js', '/js/good.js']) {
            expect(cached.has(key), key).toBe(true);
        }
        // The flaky optional asset was skipped, not cached, and did not poison
        // the precache.
        expect(cached.has('/js/flaky.js')).toBe(false);
        expect(self.skipWaiting).toHaveBeenCalled();
    });

    it('install still REJECTS when a CORE asset (a direct HTML subresource) fails — a later visit retries (med-gvk.1)', async () => {
        // The other half of the core-vs-optional split: a directly-referenced
        // <script src>/<link href> the browser fetches to paint has no runtime
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
        // No mapping for ceremony paths (/devices, /connectors, …): index.html
        // links to them via <a href>, which the warm must skip — if it fetched
        // one it would fall through to a nonexistent web/cloud/devices, 404,
        // and reject install, failing this test.
        fetchMock.mockImplementation(async (url) => {
            const { pathname } = new URL(url, ORIGIN);
            let body;
            if (pathname === '/') body = appIndex;
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
        // Anchor-linked ceremony pages are never warmed (see mock note above).
        for (const p of ['/unlock', '/claim', '/recover', '/devices', '/connectors']) {
            expect(cached.has(p), p).toBe(false);
        }
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
