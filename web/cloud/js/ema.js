// Browser implementation of the ema port (bd med-3u28.2): the EU register
// check over the bundled EMA Article 57 asset, entirely on this device. The
// asset is same-origin (router.go static, the native shells' local adapters),
// so no medicine name leaves the phone.
//
// Lazy: nothing loads until the first EU check, and only with 'eu' picked in
// Settings → Features → "Check names in" (a device-local, per-account
// localStorage choice, never vault data). One fetch per page (single-flight),
// parsed once into createEMACatalogue.
//
// Own Cache API cache, named OUTSIDE the service worker's 'medtracker-cloud'
// prefix (sw.js activate wipes every prefixed cache but the shell's):
// medtracker-ema-<revision>. Read cache-first; written only after a fetched
// copy validated; older revisions are deleted only after the new one is
// stored, so a switch never drops the last usable copy first. Every cache
// step is best-effort: denial, quota or eviction leaves the in-memory
// register working.
import { createEMACatalogue } from '../../domain/ema-catalogue.js';

export const EMA_REVISION = 'rev90-v1';
export const EMA_CACHE_PREFIX = 'medtracker-ema-';
// Decoded size of the revision's asset, for progress when the response is
// content-encoded (Content-Length is then the compressed size).
const EMA_BYTES = 13274325;

export function emaAssetUrl(revision = EMA_REVISION) {
  return `/static/data/ema-article57-${revision}.json`;
}

// The register choice. The key matches features/meds-history.js
// medRegisterKey (same accountId expression, so local mode agrees too).
export function medRegister(win) {
  try {
    const accountId = (win && win.MedTrackerCloud && win.MedTrackerCloud.ctx && win.MedTrackerCloud.ctx.accountId) || 'unknown';
    return win.localStorage.getItem(`medRegister:${accountId}`) === 'eu' ? 'eu' : 'us';
  } catch {
    return 'us';
  }
}

// A half-open connection (captive portal, a phone waking up) never settles a
// fetch; with no byte for this long the load fails, so the editor reaches
// "Couldn't load" with Retry instead of loading forever.
const EMA_STALL_MS = 15000;

async function readText(res, bytes, onProgress, onBytes) {
  const length = Number(res.headers && res.headers.get('content-length'));
  const encoded = res.headers && res.headers.get('content-encoding');
  const total = !encoded && length > 0 ? length : bytes;
  if (!res.body || typeof res.body.getReader !== 'function') return res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  onProgress(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onBytes();
    chunks.push(value);
    loaded += value.length;
    onProgress(Math.min(loaded / total, 0.99));
  }
  return new Blob(chunks).text();
}

export function createEmaLoader({
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  caches: cacheStorage = globalThis.caches,
  revision = EMA_REVISION,
  bytes = EMA_BYTES,
  stallMs = EMA_STALL_MS,
} = {}) {
  const url = emaAssetUrl(revision);
  const cacheName = EMA_CACHE_PREFIX + revision;
  let catalogue = null;
  let inflight = null;
  let progress = null; // 0..1 while the network download runs; null otherwise
  let failed = false;

  async function openCache() {
    try { return cacheStorage ? await cacheStorage.open(cacheName) : null; } catch { return null; }
  }

  async function store(cache, text) {
    try {
      await cache.put(url, new Response(text, { headers: { 'Content-Type': 'application/json' } }));
      const names = await cacheStorage.keys();
      await Promise.all(names.filter((n) => n.startsWith(EMA_CACHE_PREFIX) && n !== cacheName).map((n) => cacheStorage.delete(n)));
    } catch { /* best-effort: the in-memory register still works */ }
  }

  async function load() {
    const cache = await openCache();
    const hit = cache ? await cache.match(url).catch(() => null) : null;
    if (hit) {
      try {
        catalogue = createEMACatalogue(JSON.parse(await hit.text()));
        return;
      } catch { /* a corrupt copy is replaced below */ }
    }
    // Stall guard: re-armed on every chunk; firing aborts the request and
    // rejects even if the fetch ignores the signal.
    const ctrl = new AbortController();
    let timer;
    let stalled;
    const stall = new Promise((_, reject) => { stalled = reject; });
    stall.catch(() => {});
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { ctrl.abort(); stalled(new Error('ema asset stalled')); }, stallMs);
    };
    let text;
    try {
      arm();
      // no-store: this cache, not the HTTP one, holds the copy.
      const res = await Promise.race([fetchImpl(url, { cache: 'no-store', signal: ctrl.signal }), stall]);
      if (!res.ok) throw new Error(`ema asset ${res.status}`);
      text = await Promise.race([readText(res, bytes, (p) => { progress = p; }, arm), stall]);
    } finally {
      clearTimeout(timer);
    }
    const next = createEMACatalogue(JSON.parse(text));
    catalogue = next;
    if (cache) await store(cache, text);
  }

  function ensure() {
    if (catalogue || inflight) return inflight;
    failed = false;
    inflight = load()
      .catch(() => { failed = true; })
      .finally(() => { inflight = null; progress = null; });
    return inflight;
  }

  function state() {
    if (catalogue) return { status: 'ready', catalogue };
    if (inflight) return { status: 'loading', progress };
    return { status: failed ? 'unavailable' : 'idle' };
  }

  return { ensure, state, cacheName, url };
}

let sharedLoader = null; // module-state: one register per page lifetime, shared by both routers

// The domain's ema port. register() never waits for a download: it starts
// the load and reports where it is, so the editor can paint real progress.
// start: false (the editor's polls) only reads the state, so a failed load
// stays 'unavailable' until the next check (or Retry) starts another.
export function createEmaPort({ win, loader } = {}) {
  return {
    async register({ start = true } = {}) {
      if (medRegister(win) !== 'eu') return { status: 'off' };
      const l = loader || (sharedLoader = sharedLoader || createEmaLoader());
      if (start) l.ensure();
      return l.state();
    },
  };
}
