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
// vendor). Throws on a non-ok status so the caller can decide core-vs-optional.
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
// CORE-vs-OPTIONAL split (med-gvk.1): the pre-med-gvk.1 warm was ALL-OR-NOTHING
// — one flaky subresource on the first online visit rejected the whole install,
// so NOTHING cached and the app stayed broken offline until a later navigation
// happened to fetch every asset cleanly. Now:
//   - CORE = the '/' document + its direct <script src>/<link href> tags (the
//     app's styles, vendor bundles, cloud-boot.js + the core/* entry scripts
//     the BROWSER fetches to parse and paint). These have no runtime backfill
//     before the JS even runs, so a CORE miss = a broken/unstyled offline shell.
//     A CORE failure still REJECTS the install: activate prunes the previous
//     version's cache, so we keep the old SW + cache live and let the browser
//     retry the update on the next navigation rather than activate a broken
//     shell. (The disk-backed test in sw.fetch-cache.test.js pins every CORE ref
//     to a real repo file so a bad ref can't permanently wedge updates.)
//   - OPTIONAL = the transitively-crawled ES-module graph (unlock/apishim/sync/
//     domain + lazy feature modules). These are fetched by the RUNNING JS via
//     import(), so the fetch handler below backfills any skipped here on the
//     first online use — and the modules the page actually loads this session
//     are runtime-cached anyway. So one flaky module must NOT poison the whole
//     precache: allSettled over each wave, log+skip failures, keep crawling the
//     successes.
// Crawl one document's subresource + ES-module graph into `cache`, sharing the
// `seen` set across documents so an asset already cached by an earlier call is
// not re-fetched. When `strict` (the '/' app shell), the DIRECT subresource
// wave is Promise.all — a miss rejects (CORE, see above). When not strict (the
// best-effort ceremony shell) the direct refs fold into the allSettled loop so
// nothing rejects. Module-graph waves are always allSettled (log+skip).
async function warmDocGraph(cache, html, seen, strict) {
  const direct = [];
  for (const m of html.matchAll(SHELL_REF_RE)) {
    // SHELL_REF_RE only captures root-relative refs, so origin is the only base.
    const href = new URL(m[1], self.location.origin).href;
    if (!seen.has(href)) {
      seen.add(href);
      direct.push(href);
    }
  }
  let wave;
  if (strict) {
    // CORE wave: Promise.all — any failure rejects install. The module deps
    // these yield become the OPTIONAL frontier.
    const coreDeps = await Promise.all(direct.map((url) => cacheAndCrawl(cache, url)));
    wave = coreDeps.flat().filter((u) => !seen.has(u) && (seen.add(u), true));
  } else {
    wave = direct;
  }
  // OPTIONAL waves: allSettled — cache what succeeds, log+skip what fails, and
  // keep crawling only the successes' deps.
  while (wave.length) {
    const results = await Promise.allSettled(wave.map((url) => cacheAndCrawl(cache, url)));
    const nextDeps = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') nextDeps.push(...r.value);
      else console.warn('[sw] shell warm: skipped optional asset ' + wave[i], r.reason);
    });
    wave = nextDeps.filter((u) => !seen.has(u) && (seen.add(u), true));
  }
}

async function warmShell() {
  const cache = await caches.open(SHELL_CACHE);
  const doc = await fetch('/');
  if (!doc.ok) throw new Error('shell warm: / => ' + doc.status);
  const html = await doc.clone().text();
  await cache.put('/', doc);
  const origin = self.location.origin;
  const seen = new Set([new URL('/', origin).href]);
  // CORE-strict: the '/' shell must fully cache or the install rejects.
  await warmDocGraph(cache, html, seen, true);
  // Best-effort: warm the ceremony document (signup.html) + its module graph so
  // Settings sub-pages (/devices, /connectors, …) open offline. Its failure
  // must NEVER reject the primary-shell install (med-gvk.3, mirrors med-gvk.1's
  // core-vs-optional split at the document level).
  await warmCeremony(cache, seen).catch((e) => console.warn('[sw] ceremony warm failed', e));
}

// Best-effort ceremony precache: the router serves signup.html for all five
// CEREMONY_PATHS, so fetch one ('/unlock'), cache that same document body under
// EVERY ceremony path (a fresh clone per put) so an offline navigation to any
// of them is an exact cache hit in cachedNavigationDoc, then crawl its module
// graph (/css/cloud.css + /js/app.js + app.js's dynamic-import ceremony graph).
// A miss returns quietly (no top-level warn) so synthetic install tests whose
// mocks 404 /unlock stay green — only the per-asset skip warnings remain.
async function warmCeremony(cache, seen) {
  const res = await fetch('/unlock');
  if (!res.ok) return;
  const html = await res.clone().text();
  for (const path of CEREMONY_PATHS) {
    await cache.put(path, res.clone());
  }
  await warmDocGraph(cache, html, seen, false);
}

self.addEventListener('install', (event) => {
  event.waitUntil(warmShell());
  self.skipWaiting();
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
function fetchAndCache(event, request) {
  return fetch(request).then(
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
        throw err;
      })
  );
}

// Background refresh of the '/' app document for stale-while-revalidate. Its
// failure must NEVER reject the already-served cached response, so it swallows
// everything — the next open simply serves whatever last succeeded.
function revalidateShell() {
  return fetch('/')
    .then((response) => {
      if (response.ok) return caches.open(SHELL_CACHE).then((cache) => cache.put('/', response));
    })
    .catch(() => {});
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/mcp/')) return;

  if (request.mode === 'navigate') {
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

function tryDecodeServerWarning(data) {
  try {
    const payload = JSON.parse(new TextDecoder().decode(data));
    if (payload && payload.kind === 'server-warning') {
      // The server is untrusted in the zero-knowledge model: render a fixed
      // client-side constant keyed only on the `kind` flag, never the
      // server-supplied title/body, so a hostile server can't inject arbitrary
      // (phishing) notification text on this one non-NK-encrypted channel.
      return { ...STALE_SYNC_WARNING };
    }
  } catch {
    // Not JSON — real NK ciphertext, ignore.
  }
  return null;
}

// NK absent, or the app-layer ciphertext fails to decrypt (tampered, or this
// device's vault was never provisioned) — fall back to the content-free
// generic notification rather than surfacing an error to the user.
async function decodePush(data) {
  const warning = tryDecodeServerWarning(data);
  if (warning) return warning;
  try {
    const nk = await readNK();
    if (!nk) return GENERIC_NOTIFICATION;
    const plaintext = await decryptPushPayload(nk, new Uint8Array(data));
    const payload = JSON.parse(new TextDecoder().decode(plaintext));
    return {
      title: payload.title || GENERIC_NOTIFICATION.title,
      body: payload.body || GENERIC_NOTIFICATION.body,
      kind: payload.kind || '',
    };
  } catch {
    return GENERIC_NOTIFICATION;
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

self.addEventListener('push', (event) => {
  // PushMessageData.arrayBuffer() is synchronous (returns an ArrayBuffer, not a
  // Promise — unlike Response.arrayBuffer()), so wrap the result rather than
  // calling .then() on it directly.
  const buf = event.data ? event.data.arrayBuffer() : null;
  event.waitUntil(
    Promise.resolve(buf && buf.byteLength ? decodePush(buf) : GENERIC_NOTIFICATION).then((n) =>
      self.registration.showNotification(n.title, {
        body: n.body,
        actions: NOTIFICATION_ACTIONS[n.kind] || [],
      })
    )
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
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const client = clients.find((c) => 'focus' in c);
      if (!route) {
        if (client) return client.focus();
        return self.clients.openWindow ? self.clients.openWindow('/') : undefined;
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
