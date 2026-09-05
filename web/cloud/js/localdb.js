// Single shared per-device IndexedDB handle for the cloud shell. unlock.js
// (LDK warm-unlock cache) and sync.js (local record mirror) both open this
// same database — centralizing name/version here means adding a sync.js
// object store can never collide with unlock.js opening an older version.
const DB_NAME = 'medtracker-cloud';
// v3: 'recordType' index on records. Without it every records.list(type) was a
// full-store getAll() + JS filter, structured-cloning every record of every
// domain (sync.js listRecords).
// v4: 'feedback_outbox' store (med-dni.3) — durable age-ciphertext submit queue,
// keyed by client_id. Independent of the sync oplog stores.
const DB_VERSION = 4;

// Shared store/index creation, used by both openDb (fresh handle) and cachedDb
// (shared handle). Keep this the single source of truth for the schema.
function applyUpgrade(req) {
  const db = req.result;
  if (!db.objectStoreNames.contains('device')) db.createObjectStore('device');
  if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'recordId' });
  if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending', { keyPath: 'recordId' });
  if (!db.objectStoreNames.contains('sync_meta')) db.createObjectStore('sync_meta');
  if (!db.objectStoreNames.contains('feedback_outbox')) db.createObjectStore('feedback_outbox', { keyPath: 'client_id' });
  // Existing v2 rows already carry recordType (putRecord always writes it),
  // so createIndex backfills the index from them — no data migration.
  const records = req.transaction.objectStore('records');
  if (!records.indexNames.contains('recordType')) records.createIndex('recordType', 'recordType');
}

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => applyUpgrade(req);
    req.onsuccess = () => {
      // Auto-close on versionchange so a live handle never blocks
      // account-delete's deleteDatabase() (or a future version upgrade).
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
}

// --- Cached connection (sync.js only) -------------------------------------
// sync.js opens/closes this DB many times per section-open. openDb stays
// fresh-handle-per-call for push/feedback/mcp-responder/unlock; sync.js reuses
// one shared connection via cachedDb() to skip the open/close churn. Two
// concurrent connections at the same DB_VERSION are safe; the only hazard is a
// version upgrade, handled by onversionchange dropping the cache.
let dbPromise = null;
const dropListeners = new Set();

// `owner` is the cachedDb() promise the handle firing this belongs to. A drop
// that lands while an open is in flight leaves that open resolving an ORPHAN
// handle — never cached, but still wired to onversionchange/onclose. Without
// this guard the orphan's eventual close would clear the NEWER cached promise
// and spuriously fire the drop listeners (blowing sync.js's records memo and
// resetting `bootstrapped`). Explicit dropCachedDb() passes no owner and always
// drops. Mirrors the p.catch identity guard on the reject side.
function dropCache(owner) {
  if (owner && dbPromise !== owner) return;
  dbPromise = null;
  for (const cb of dropListeners) {
    try { cb(); } catch { /* one bad listener can't break the rest */ }
  }
}

// Register a callback fired whenever the cached connection is dropped
// (versionchange, onclose, or explicit dropCachedDb). Returns an unsubscribe.
export function onCachedDbDropped(cb) {
  dropListeners.add(cb);
  return () => dropListeners.delete(cb);
}

// Shared connection accessor: opens one if none is cached, otherwise reuses.
export function cachedDb() {
  if (dbPromise) return dbPromise;
  const p = new Promise((resolve, reject) => {
    // indexedDB.open can throw SYNCHRONOUSLY (storage denied / SecurityError,
    // document unloading) — that path never reaches onerror. The executor turns
    // the throw into a rejection; the p.catch below is what keeps it from being
    // cached forever.
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => applyUpgrade(req);
    req.onsuccess = () => {
      const db = req.result;
      // An orphaned handle still closes on versionchange (so it can never block
      // deleteDatabase), it just no longer touches the cache — see dropCache.
      db.onversionchange = () => { db.close(); dropCache(p); };
      db.onclose = () => dropCache(p);
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  dbPromise = p;
  // ANY failure (async onerror or a synchronous throw above) uncaches, so the
  // next caller retries the open instead of inheriting a permanently rejected
  // promise — withDb (sync.js) awaits cachedDb() outside its try, so a cached
  // rejection would wedge every DB access for the page's lifetime. The identity
  // guard keeps a late rejection from clearing a NEWER promise after a
  // drop+reopen interleave.
  p.catch(() => { if (dbPromise === p) dbPromise = null; });
  return p;
}

// Force the next cachedDb() to reopen (sync.js's InvalidStateError reopen guard).
export function dropCachedDb() {
  dropCache();
}
