// Service worker for the cloud shell (Task 6, docs/cloud-mode.md "Push relay
// & reminder lifecycle"). Classic script (not `type: module`) for the widest
// browser support. It is fully self-contained: the NK decrypt path inlines the
// tiny bit of WebCrypto + IndexedDB read it needs rather than importing
// crypto.js/localdb.js. Dynamic import() of ES modules inside a classic
// service worker is unreliable across browsers (rejects in Firefox and
// Safari < 16) and importScripts() can't load ES modules — so importing would
// silently degrade every push to a generic notification on those browsers.

// Rewritten to the deploy timestamp by .github/workflows/deploy.yml, exactly as
// web/static/sw.js's CACHE_VERSION is. The value is never read — its only job is
// to make this file's BYTES differ between deploys, which is the sole signal the
// browser uses to decide a service worker has changed. Hardcode it and an
// installed cloud SW is frozen forever, push handler and all (med-jb7.2).
const SW_VERSION = 'CACHE_VERSION_PLACEHOLDER';

const CACHE_PREFIX = 'medtracker-cloud';

// Versioned app-shell cache (med-deq.1). SW_VERSION changes every deploy, so
// each deploy gets a fresh cache and activate prunes the old ones below.
const SHELL_CACHE = `${CACHE_PREFIX}-shell-${SW_VERSION}`;

// This worker's build, as the served document spells it: deploy.yml stamps
// SW_VERSION = 'v' + BUILD_TS and every `?v=` asset fingerprint in index.html
// with the same BUILD_TS (the key the server's buildIDFrom reads). null on an
// unstamped tree (go run, plain docker build): the placeholder does not start
// with 'v', and there is no build to compare, so dev keeps refreshing '/'.
// (Never compare against the placeholder literal — the deploy sed rewrites
// every occurrence in this file.)
const BUILD_TS = SW_VERSION.charAt(0) === 'v' ? SW_VERSION.slice(1) : null;
const DOC_FINGERPRINT_RE = /\?v=([^"'&]+)/;

// How long a cache MISS for a navigation or a render-blocking asset (css,
// script) may wait for response headers before it is treated as offline. The
// browser paints white while respondWith is pending, and a dead connection
// after device sleep can hang for minutes (med-gacq). Bounds time-to-headers
// only: once the response arrives its body streams without a deadline.
const MISS_TIMEOUT_MS = 5000;

// Same-origin subresource refs in a served document: <script src> and
// <link href> tags only — all root-relative in web/static/index.html plus the
// tags router.go injects. Anchor hrefs (<a href="/devices">) are navigation
// targets, not shell assets, and are deliberately excluded: the ceremony
// document is precached separately (with its own css/js module graph) by
// warmCeremony below, not by following a stray <a> from the app shell.
// Cross-origin URLs don't start with '/' and never match.
const SHELL_REF_RE = /<(?:script|link)\b[^>]*?(?:src|href)="(\/[^"]*)"/g;

// Literal ES-module specifiers: `from './x.js'` (incl. re-exports) and
// `import('/js/x.js')`. Only path-like specifiers (leading '/' or '.') are
// followed, which drops prose that happens to follow the keyword `from`.
const MODULE_IMPORT_RE = /\b(?:from|import\s*\()\s*['"]([^'"]+)['"]/g;

// Which cached files get scanned for module imports: any same-origin .js/.mjs
// except vendor bundles (minified, treated as self-contained).
const CRAWLABLE_RE = /^\/(?!static\/vendor\/|vendor\/).*\.m?js$/;

function moduleDeps(url, source) {
  const deps = [];
  for (const m of source.matchAll(MODULE_IMPORT_RE)) {
    const spec = m[1];
    if (spec[0] !== '/' && spec[0] !== '.') continue;
    const dep = new URL(spec, url);
    if (dep.origin === self.location.origin) deps.push(dep.href);
  }
  return deps;
}

// Fetch one asset, cache it, and return its module deps (empty for non-JS or
// vendor). Throws on a non-ok status so the caller can decide fatal-vs-best-effort.
async function cacheAndCrawl(cache, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('shell warm: ' + url + ' => ' + res.status);
  const deps = CRAWLABLE_RE.test(new URL(url).pathname) ? moduleDeps(url, await res.clone().text()) : [];
  await cache.put(url, res);
  return deps;
}

// Warm the app shell: the '/' document, every subresource it references (the
// fingerprinted /static/* URLs it will request offline), and the transitive
// ES-module graph reachable from them (/js/cloud-boot.js → unlock/apishim/sync
// → /domain/*), which never appears in the HTML because it's loaded via
// import(). cache.add('/') alone is not enough — offline, the cached HTML's
// subresource fetches reject (a subresource deliberately never gets the HTML
// shell below) and the app boots blank.
//
// STRICT-vs-BEST-EFFORT (med-gvk.1, tightened by med-5h1t.6). med-gvk.1 made
// the crawled ES-module graph "optional" (allSettled, log+skip) so one flaky
// module could not reject the install. That bought nothing: an imported module
// is not optional at runtime — a missing one breaks its importer anyway — and a
// skipped module was later filled on a cache MISS from the CURRENT server, next
// to siblings from the install's deploy. Across a deploy that changed module
// interfaces (crypto/unlock/sync in med-5h1t) that mixed graph broke boot until
// the update banner was accepted. So the cached graph is COHERENT PER
// GENERATION — all-or-nothing:
//   - Fatal: the '/' document, every one of its direct <script src>/<link href>
//     refs, and in the ceremony shell every non-vendor .js/.mjs (CRAWLABLE_RE,
//     modules and classic scripts alike) — directly referenced or crawled.
//     Any failure REJECTS the install and warmShell deletes the partial cache
//     (only if this install created it). The previous SW + its complete cache
//     keep serving; the browser retries the update on the next navigation.
//     (The disk-backed test in sw.fetch-cache.test.js pins every ref to a real
//     repo file so a bad ref can't permanently wedge updates.)
//   - Best-effort: every OTHER ceremony-shell asset (css, vendor bundles) —
//     logged and skipped; none of them is part of the crawled module graph.
//
// Crawl one document's subresource + ES-module graph into `cache`, sharing the
// `seen` set across documents so an asset already cached by an earlier call is
// not re-fetched. `strict` (the '/' app shell) makes every ref fatal.
async function warmDocGraph(cache, html, seen, strict) {
  let wave = [];
  for (const m of html.matchAll(SHELL_REF_RE)) {
    // SHELL_REF_RE only captures root-relative refs, so origin is the only base.
    const href = new URL(m[1], self.location.origin).href;
    if (!seen.has(href)) {
      seen.add(href);
      wave.push(href);
    }
  }
  while (wave.length) {
    const results = await Promise.allSettled(wave.map((url) => cacheAndCrawl(cache, url)));
    const nextDeps = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') nextDeps.push(...r.value);
      else if (strict || CRAWLABLE_RE.test(new URL(wave[i]).pathname)) throw r.reason;
      else console.warn('[sw] shell warm: skipped best-effort asset ' + wave[i], r.reason);
    });
    wave = nextDeps.filter((u) => !seen.has(u) && (seen.add(u), true));
  }
}

async function warmShell() {
  // A reused stamp (rollback to the active worker's image, same-minute deploys,
  // unstamped dev) means SHELL_CACHE is the ACTIVE worker's cache — never
  // delete what this install did not create.
  const preexisting = await caches.has(SHELL_CACHE);
  try {
    const cache = await caches.open(SHELL_CACHE);
    const doc = await fetch('/');
    if (!doc.ok) throw new Error('shell warm: / => ' + doc.status);
    const html = await doc.clone().text();
    await cache.put('/', doc);
    const origin = self.location.origin;
    const seen = new Set([new URL('/', origin).href]);
    await warmDocGraph(cache, html, seen, true);
    // The ceremony document (signup.html) + its module graph, so Settings
    // sub-pages (/devices, /connectors, …) open offline. Its modules share
    // crypto/unlock/sync with the '/' graph, so a ceremony module failure is
    // fatal too — otherwise it would be filled later from a newer deploy.
    await warmCeremony(cache, seen);
  } catch (e) {
    // No partial graph may survive: the fetch handler's global caches.match
    // searches every cache, so a half-warmed one would leak its modules into
    // the still-active previous generation.
    if (!preexisting) await caches.delete(SHELL_CACHE);
    throw e;
  }
}

// Ceremony precache: the router serves signup.html for all five
// CEREMONY_PATHS, so fetch one ('/unlock'), cache that same document body under
// EVERY ceremony path (a fresh clone per put) so an offline navigation to any
// of them is an exact cache hit in cachedNavigationDoc, then crawl its module
// graph (/css/cloud.css + /js/app.js + app.js's dynamic-import ceremony graph).
// A 404 returns quietly (no ceremony pages; synthetic install tests whose mocks
// 404 /unlock) — any other failure rejects the install like a module failure.
async function warmCeremony(cache, seen) {
  const res = await fetch('/unlock');
  if (res.status === 404) return;
  if (!res.ok) throw new Error('shell warm: /unlock => ' + res.status);
  const html = await res.clone().text();
  for (const path of CEREMONY_PATHS) {
    await cache.put(path, res.clone());
  }
  await warmDocGraph(cache, html, seen, false);
}

self.addEventListener('install', (event) => {
  // No skipWaiting: on an UPDATE the new SW WAITS instead of hijacking already-
  // open tabs. The client posts SKIP_WAITING when the user accepts the update
  // banner. A FIRST install (no prior controller) still takes control via
  // clients.claim() in activate — nothing to wait behind, so no hijack.
  event.waitUntil(warmShell());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'PROVIDER_RELOAD_CAPABILITY') {
    event.ports?.[0]?.postMessage({ type: 'PROVIDER_RELOAD_CAPABILITY', version: 1 });
    return;
  }
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE).map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Offline app shell (med-gvk.5): CACHE-FIRST for the versioned shell, not
// network-first. The pre-med-gvk.5 handler did fetch(request) FIRST and only
// fell back to cache on a rejection/5xx — so on a SLOW (not failed) network it
// WAITED on the network for the document and every asset before painting, even
// though a cached copy existed. That defeated local-first entirely. Freshness
// is already handled by the versioned SHELL_CACHE (SW_VERSION bumps every
// deploy → new cache → warmShell re-fetches → activate prunes old), so the
// per-request network round-trip bought nothing but latency. Now:
//   - Static/fingerprinted assets (everything that is NOT the navigation
//     document): CACHE-FIRST. A cached copy is served IMMEDIATELY with zero
//     network wait — the sub-second local-first guarantee. Only a cache MISS
//     goes to the network (fetchAndCache), which caches an ok response and
//     keeps the 5xx-as-offline + offlineFallback behavior.
//   - The navigation document (request.mode === 'navigate', i.e. '/'):
//     STALE-WHILE-REVALIDATE. Serve the cached document IMMEDIATELY (sub-
//     second) and fire a background fetch('/') that refreshes the cache for
//     the NEXT open — the '/' document carries a per-account CSP computed from
//     stored egress hosts and can change without a deploy (user adds a provider
//     key), so it must stay eventually-fresh while still opening instantly. On
//     a cache MISS: network then offlineFallback (unchanged).
//
// /api/* and /mcp/* are dynamic — never cached, never served from cache; non-
// GET and cross-origin pass through untouched.
//
// Offline path shared by fetch rejection and proxy 5xx: the exact cached copy,
// else — for navigations only — the cached '/' app shell (ignoreSearch, so a
// '/?reminder_action=…' cold start from notificationclick still hits a document
// cached under '/', and vice versa). A subresource must NOT get the HTML shell:
// nosniff would block it and a 200 HTML body masks the failure. When nothing is
// cached, `surface` yields the network outcome (returns the 5xx / re-throws).
//
// Ceremony pages (served by signup.html in router.go, a DIFFERENT document
// from '/') must never receive the '/' app shell: the app document's
// cloud-boot.js redirects a locked device to /unlock, so substituting '/' at
// /unlock would reload-loop forever offline (med-eas.16's anti-ping-pong
// guarantee). An exact cached copy from a prior online visit still wins above.
const CEREMONY_PATHS = new Set(['/unlock', '/claim', '/recover', '/devices', '/connectors']);

// The cached document to serve for a navigation, or undefined when nothing is
// servable: an exact cached copy wins; otherwise a non-ceremony navigation may
// fall back to the cached '/' app shell (ignoreSearch), but a ceremony page
// never gets the '/' shell (anti-ping-pong, above).
function cachedNavigationDoc(request) {
  return caches.match(request).then((cached) => {
    if (cached) return cached;
    if (CEREMONY_PATHS.has(new URL(request.url).pathname)) return undefined;
    return caches.match('/', { ignoreSearch: true });
  });
}

function offlineFallback(request, surface) {
  if (request.mode !== 'navigate') {
    return caches.match(request).then((cached) => cached || surface());
  }
  return cachedNavigationDoc(request).then((doc) => doc || surface());
}

// Network path for a cache MISS: fetch, cache an ok response, and keep the
// 5xx-as-offline + offlineFallback behavior. A proxy 5xx (cloud binary
// restarting behind Traefik) is functionally offline — docs/technical-
// decisions.md "5xx-as-offline", same as web/static/sw.js: serve the cached
// copy, the raw 5xx only when nothing is cached.
//
// Navigations and render-blocking assets race the network against
// MISS_TIMEOUT_MS; a timeout takes the rejection path (offlineFallback, so a
// navigation still gets the cached '/' shell when one exists and a ceremony
// page never does). An asset gets the error: unstyled beats a white screen.
// A timer race, not AbortController: fetch(request, { signal }) throws for a
// navigate-mode Request. The losing fetch is simply dropped (never cached).
function boundedFetch(request) {
  const bounded =
    request.mode === 'navigate' || request.destination === 'style' || request.destination === 'script';
  if (!bounded) return fetch(request);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('sw: network timeout ' + request.url)), MISS_TIMEOUT_MS);
  });
  return Promise.race([fetch(request), timeout]).finally(() => clearTimeout(timer));
}

// A navigation that failed or timed out with nothing cached to serve: a
// standalone document, not a rejection — an installed PWA's own network-error
// page has no way back. Never cached (only ok responses are). No script and no
// redirect, so it is safe at ceremony paths too (it is not the app shell, so no
// ping-pong); the link reloads the same URL.
function retryDocument() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      "<title>Med Tracker</title><p>Can't reach the server.</p><p><a href=\"\">Retry</a></p>",
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

function fetchAndCache(event, request) {
  return boundedFetch(request).then(
    (response) => {
      if (response.ok) {
        const clone = response.clone();
        event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.put(request, clone)));
        return response;
      }
      if (response.status >= 500) return offlineFallback(request, () => response);
      return response;
    },
    (err) =>
      offlineFallback(request, () => {
        if (request.mode === 'navigate') return retryDocument();
        throw err;
      })
  );
}

// Background refresh of the '/' app document for stale-while-revalidate. Its
// failure must NEVER reject the already-served cached response, so it swallows
// everything — the next open simply serves whatever last succeeded.
//
// Only a document of THIS worker's build is stored (med-gacq). After a deploy
// the server's '/' references ?v=<new> assets this cache does not hold; stored
// here, the next open served it and every render-blocking asset missed → white
// screen until force-close. A different fingerprint leaves the cached '/'
// untouched: the waiting worker owns the new build. Within one build the
// per-account CSP refresh still lands.
function revalidateShell() {
  return fetch('/')
    .then(async (response) => {
      if (!response.ok) return;
      if (BUILD_TS) {
        const m = (await response.clone().text()).match(DOC_FINGERPRINT_RE);
        if (!m || m[1] !== BUILD_TS) return;
      }
      const cache = await caches.open(SHELL_CACHE);
      await cache.put('/', response);
    })
    .catch(() => {});
}

// Only explicit provider Reload uses a complete bounded network document.
// A late/failed response cannot replace the cache or masquerade as freshness.
function freshProviderDocument(event, request) {
  const controller = new AbortController();
  let expired = false;
  let timer;
  const network = (async () => {
    const response = await fetch(request, { cache: 'no-store', signal: controller.signal });
    if (!response.ok || response.redirected) throw new Error('fresh document unavailable');
    const body = await response.clone().text();
    if (expired) throw new Error('fresh document expired');
    const fingerprint = body.match(DOC_FINGERPRINT_RE);
    if ((BUILD_TS && (!fingerprint || fingerprint[1] !== BUILD_TS))
      || !body.includes('name="medtracker-connect-origins"')
      || !response.headers.get('Content-Security-Policy')?.includes('connect-src')) {
      throw new Error('fresh document does not match this worker');
    }
    // Return the ORIGINAL response/CSP. Only this verified same-build response
    // may refresh '/', exactly as normal background revalidation already does.
    event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.put('/', response.clone())).catch(() => {}));
    return response;
  })();
  return Promise.race([
    network,
    new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; controller.abort(); reject(new Error('fresh document timed out')); }, 5000);
    }),
  ]).catch(() => retryDocument()).finally(() => clearTimeout(timer));
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/mcp/')) return;

  if (request.mode === 'navigate') {
    if (url.pathname === '/' && url.searchParams.get('__wg_provider_reload') === '1') {
      event.respondWith(freshProviderDocument(event, request));
      return;
    }
    // Stale-while-revalidate: cached document now, refresh '/' in the background.
    event.respondWith(
      cachedNavigationDoc(request).then((doc) => {
        if (doc) {
          event.waitUntil(revalidateShell());
          return doc;
        }
        return fetchAndCache(event, request);
      })
    );
    return;
  }

  // Static assets: cache-first — a hit serves with zero network wait.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetchAndCache(event, request))
  );
});

const GENERIC_NOTIFICATION = { title: 'Med Tracker', body: 'Medication reminder' };

// NK plaintext cache lives in the 'device' object store under key 'nk'
// (docs/cloud-crypto.md: "plaintext copy in device IndexedDB" for the SW).
// Opened without a version so the SW never triggers a schema upgrade — the app
// page always creates the DB before any subscription can receive a push, so the
// store exists; if it somehow doesn't, the transaction throws and decodePush
// falls back to the generic notification.
async function readNK() {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('medtracker-cloud');
    req.onsuccess = () => {
      // Same versionchange auto-close invariant as localdb.js openDb(): a push
      // arriving mid-account-deletion must never block deleteDatabase.
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('device', 'readonly');
      const req = tx.objectStore('device').get('nk');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

// Task 7's stale-sync warning is a server-composed, content-free push sent
// outside the NK app-layer encryption path (the server has no NK to encrypt
// with). It's plain JSON tagged kind=="server-warning" — anything else is NK
// ciphertext and falls through to the decrypt attempt below.
const STALE_SYNC_WARNING = { title: 'Med Tracker', body: 'Open the app to keep reminders running' };

// The inbox wake (bd med-5fo) is the second such payload: the server sends it
// the instant it seals a Telegram event, so an open tab drains it now instead
// of at its next poll (a backgrounded page is throttled to ~1/min, a frozen one
// never polls). It is a nudge, not news — the text below is only shown when no
// window is open to take the nudge, and like every non-NK payload it is a FIXED
// client-side constant.
const INBOX_WAKE_KIND = 'inbox-wake';
const INBOX_WAKE_NOTIFICATION = { title: 'Med Tracker', body: 'Open the app to record what you sent' };

// The add-device claim (bd med-r1j2.9): a device claimed one of this account's
// slots and the origin must come back to compare the code and approve. The push
// is a bare kind tag — no slot, platform or expiry — so the text is generic
// (internal/cloudserver/nativepush.go transferClaimed* is its native twin). The
// tap opens Settings → Devices → Add a device: the live Approve screen when
// this window holds the flow, else the "not open here" end state.
const TRANSFER_CLAIMED_KIND = 'transfer_claimed';
const TRANSFER_CLAIMED_NOTIFICATION = {
  title: 'Approve the new device?',
  body: 'A new device is waiting · approve it before the code expires',
  kind: TRANSFER_CLAIMED_KIND,
  url: '/?tab=settings&page=add-device',
};
// The tap's "which window holds the live code?" probe (transfer.js answers).
const TRANSFER_PROBE_TYPE = 'transfer-live-probe';

// Inlined from crypto.js encryptPushPayload/decryptPushPayload: NK app-layer is
// AES-GCM(NK, payload, aad="mt/v1/push") with the 12-byte nonce packed ahead of
// the ciphertext (single BLOB wire column). Kept here so the worker needs no
// module import (see top-of-file note).
const PUSH_AAD = new TextEncoder().encode('mt/v1/push');

async function decryptPushPayload(nk, packed) {
  const nonce = packed.slice(0, 12);
  const ct = packed.slice(12);
  const key = await crypto.subtle.importKey('raw', nk, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: PUSH_AAD }, key, ct);
  return new Uint8Array(pt);
}

function tryDecodeServerPayload(data) {
  try {
    const payload = JSON.parse(new TextDecoder().decode(data));
    // The server is untrusted in the zero-knowledge model: render a fixed
    // client-side constant keyed only on the `kind` flag, never the
    // server-supplied title/body, so a hostile server can't inject arbitrary
    // (phishing) notification text on this one non-NK-encrypted channel.
    if (payload && payload.kind === 'server-warning') return { ...STALE_SYNC_WARNING };
    if (payload && payload.kind === INBOX_WAKE_KIND) return { ...INBOX_WAKE_NOTIFICATION, kind: INBOX_WAKE_KIND };
    if (payload && payload.kind === TRANSFER_CLAIMED_KIND) return { ...TRANSFER_CLAIMED_NOTIFICATION };
  } catch {
    // Not JSON — real NK ciphertext, ignore.
  }
  return null;
}

// NK absent, or the app-layer ciphertext fails to decrypt (tampered, or this
// device's vault was never provisioned) — fall back to the content-free
// generic notification rather than surfacing an error to the user.
async function decodePush(data) {
  const serverComposed = tryDecodeServerPayload(data);
  if (serverComposed) return serverComposed;
  try {
    const nk = await readNK();
    if (!nk) return GENERIC_NOTIFICATION;
    const plaintext = await decryptPushPayload(nk, new Uint8Array(data));
    const payload = JSON.parse(new TextDecoder().decode(plaintext));
    return {
      title: payload.title || GENERIC_NOTIFICATION.title,
      body: payload.body || GENERIC_NOTIFICATION.body,
      kind: payload.kind || '',
      // The tap target (med-9d1a); absent on payloads from older clients.
      url: reminderOpenUrl(payload.url),
    };
  } catch {
    return GENERIC_NOTIFICATION;
  }
}

// A notification tap may only open the app's own root with the query keys the
// reminder deeplink uses (web/cloud/js/reminder-deeplink.js) — never an
// arbitrary string out of a payload. Anything else opens '/'.
// 'page' is the Settings sub-page key of ?tab=settings&page=… (deeplink-router.js
// routes only a fixed list of pages).
const REMINDER_URL_KEYS = new Set(['tab', 'action', 'ids', 'scheduled', 'page']);
function reminderOpenUrl(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/?')) return '/';
  try {
    const u = new URL(raw, self.location.origin);
    if (u.origin !== self.location.origin || u.pathname !== '/' || u.hash) return '/';
    for (const key of u.searchParams.keys()) if (!REMINDER_URL_KEYS.has(key)) return '/';
    return '/?' + u.searchParams.toString();
  } catch {
    return '/';
  }
}

// Snooze / don't-bug buttons, mirroring web/static/sw.js's bot-mode actions.
// Only bp/weight have them — medication Confirm/Skip needs an intake id the
// payload doesn't carry (bot mode reads it from the notification's data).
const NOTIFICATION_ACTIONS = {
  bp: [
    { action: 'bp_snooze', title: 'Snooze 2h' },
    { action: 'bp_dontbug', title: "Don't bug me" },
  ],
  weight: [
    { action: 'weight_snooze', title: 'Snooze 2h' },
    { action: 'weight_dontbug', title: "Don't bug me" },
  ],
};

// The shim routes each action hits. Unlike bot mode — where the SW POSTs
// straight to the server — the cloud shim lives in the PAGE and needs the DEK,
// which the service worker does not have. So an action tap can only be handed
// to an unlocked client; see the notificationclick handler below.
const ACTION_ROUTES = {
  bp_snooze: '/api/bp/reminder/snooze',
  bp_dontbug: '/api/bp/reminder/dontbug',
  weight_snooze: '/api/weight/reminder/snooze',
  weight_dontbug: '/api/weight/reminder/dontbug',
};

// How long a window gets to answer a wake before we assume nobody took it.
// Generous for a live page (one postMessage round trip), short enough that the
// user still gets a timely notification when no page can act.
const WAKE_ACK_TIMEOUT_MS = 1500;

// nudgeWindow posts the wake to one window and resolves whether it answered.
// The reply rides a per-push MessageChannel rather than a global SW `message`
// listener: the port IS the correlation, so there is nothing to match up and
// nothing to clean up but the port itself.
function nudgeWindow(client, type = INBOX_WAKE_KIND, timeoutMs = WAKE_ACK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (acked) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(acked);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    channel.port1.onmessage = () => finish(true);
    client.postMessage({ type }, [channel.port2]);
  });
}

// The claim tap's probe budget. A click only grants focus()/openWindow() for a
// short while (Firefox: ~1 s), so the tap goes to the first window that acks,
// and falls back after this much — never the 1.5 s wake budget.
const TRANSFER_PROBE_TIMEOUT_MS = 250;

// Resolves the first window that acks the live-code probe, or null once every
// window has declined or timed out.
function firstLiveWindow(windows) {
  return new Promise((resolve) => {
    let pending = windows.length;
    if (!pending) resolve(null);
    for (const w of windows) {
      nudgeWindow(w, TRANSFER_PROBE_TYPE, TRANSFER_PROBE_TIMEOUT_MS).then((acked) => {
        if (acked) resolve(w);
        else if (--pending === 0) resolve(null);
      });
    }
  });
}

self.addEventListener('push', (event) => {
  // PushMessageData.arrayBuffer() is synchronous (returns an ArrayBuffer, not a
  // Promise — unlike Response.arrayBuffer()), so wrap the result rather than
  // calling .then() on it directly.
  const buf = event.data ? event.data.arrayBuffer() : null;
  event.waitUntil(
    Promise.resolve(buf && buf.byteLength ? decodePush(buf) : GENERIC_NOTIFICATION).then(async (n) => {
      if (n.kind === INBOX_WAKE_KIND) {
        // Hand the nudge to every open window — the page holds the DEK, so only
        // it can drain the mailbox — and stay silent only if one ACKS. Existence
        // is the wrong signal: matchAll also returns a window that is frozen,
        // still loading, or LOCKED, and the ack listener is installed in
        // cloud-boot's post-unlock path, so a locked window never handles the
        // wake. That is exactly the case where the notification is the only
        // thing that gets the event recorded.
        //
        // KNOWN TAX: the subscription is userVisibleOnly (see resubscribeAndUpload),
        // so Chrome tolerates only a bounded number of notification-less pushes
        // before it shows its own "site updated in the background" one. A chatty
        // day in Telegram can therefore surface a notification per burst anyway.
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const acks = await Promise.all(windows.map((w) => nudgeWindow(w)));
        if (acks.some(Boolean)) return undefined;
      }
      return self.registration.showNotification(n.title, {
        body: n.body,
        actions: NOTIFICATION_ACTIONS[n.kind] || [],
        // A newer claim replaces the shade entry rather than stacking.
        ...(n.kind === TRANSFER_CLAIMED_KIND ? { tag: TRANSFER_CLAIMED_KIND } : {}),
        data: { url: n.url || '/' },
      });
    })
  );
});

// A push service can revoke and re-issue a subscription (Chrome fires this on
// VAPID-key change or its own expiry housekeeping). Re-subscribe and re-upload,
// or the endpoint the relay holds is dead and reminders stop silently.
//
// This is the BELT. Safari's support for this event is unreliable — and the
// eviction case that actually bites iOS users (an unopened PWA) may fire it
// never — so the braces are ensurePushSubscription() on every app boot
// (web/cloud/js/push.js). Neither alone is enough; do not delete either.
//
// urlBase64ToUint8Array is duplicated from push.js rather than imported: this
// worker is a classic script and deliberately self-contained (see top of file).
function urlBase64ToUint8Array(base64) {
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function resubscribeAndUpload(oldSubscription) {
  // Reuse the exact applicationServerKey the dead subscription carried: this
  // account's VAPID keypair is per-account and never rotated (rotation would
  // orphan every subscription), so refetching is only a fallback for browsers
  // that hand us no oldSubscription.
  let key = oldSubscription && oldSubscription.options && oldSubscription.options.applicationServerKey;
  if (!key) {
    const keyRes = await fetch('/api/push/vapid-public-key', { credentials: 'same-origin' });
    if (!keyRes.ok) throw new Error('vapid key unavailable');
    const body = await keyRes.json();
    key = urlBase64ToUint8Array(body.public_key);
  }
  const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON();
  const res = await fetch('/api/push/subscriptions', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth }),
  });
  if (!res.ok) throw new Error('subscription upload failed: ' + res.status);
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    resubscribeAndUpload(event.oldSubscription).catch((e) => {
      // The session cookie may be gone, or we may be offline. The boot-time
      // reconcile retries on the next app open — swallow rather than leaving
      // an unhandled rejection in the worker.
      console.error('[sw] push resubscribe failed', e);
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const route = ACTION_ROUTES[event.action];
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      let client = clients.find((c) => 'focus' in c);
      if (!route && event.notification.data && event.notification.data.url === TRANSFER_CLAIMED_NOTIFICATION.url) {
        // The live add-device flow lives in the memory of the tab that made the
        // code, not necessarily the first one: ask every window (content-free
        // probe, transfer.js acks only while it holds a live code) and route
        // the tap to the owner. No ack → the first window, which lands on AD4.
        client = (await firstLiveWindow(clients.filter((c) => 'focus' in c))) || client;
      }
      if (!route) {
        // A body tap opens the reminder's own target (med-9d1a): a dose's take
        // sheet, or its section. Warm unlocked tab → the page navigates
        // (cloud-boot.js); cold start → the URL carries it to handleDeepLinks.
        // KNOWN LIMIT: a LOCKED app loses it — a warm locked tab has no
        // listener (it is installed after unlock), and a cold start goes
        // / → /unlock → / with unlock forwarding only the hash — so it opens on
        // its default tab, same as the ?reminder_action paths below.
        const url = reminderOpenUrl(event.notification.data && event.notification.data.url);
        if (client) {
          if (url !== '/') client.postMessage({ type: 'reminder-open', url });
          return client.focus();
        }
        return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
      }
      // An open tab may still be locked, so the page — not the SW — decides
      // whether it can apply the action now or must wait for unlock. A cold
      // start carries the action in the URL, which cloud-boot.js drains after
      // the vault opens. Either way the SW never touches the vault.
      if (client) {
        client.postMessage({ type: 'reminder-action', route });
        return client.focus();
      }
      return self.clients.openWindow
        ? self.clients.openWindow(`/?reminder_action=${encodeURIComponent(event.action)}`)
        : undefined;
    })
  );
});
