// Client sync engine: docs/cloud-mode.md "Sync protocol" + docs/cloud-crypto.md
// "Oplog record / snapshot". Pull-on-open + push-on-write against
// /api/sync/ops and /api/sync/snapshot, with a local IndexedDB mirror (via
// localdb.js) so the unlocked shell has something to render offline. Records
// are { recordId, clientTs, deleted, ...body }, merged by last-write-wins on
// clientTs; recordsPort() below exposes the generic list/put/del trio that
// web/domain/'s domain modules are built on.
import { deriveKData, encryptRecord, decryptRecord, encryptSnapshot, decryptSnapshot, toBase64, fromBase64, gzip, gunzip, isGzip } from './crypto.js';
import { cachedDb, dropCachedDb, onCachedDbDropped } from './localdb.js';

// Task 6: the NK (push notification key) is itself a vault record so every
// enrolled device converges on the same one via the ordinary oplog, exactly
// like a note (docs/cloud-crypto.md "The push key (NK)"). Fixed singleton id
// — an account has exactly one NK.
const NK_RECORD_TYPE = 'nk';
const NK_RECORD_ID = 'nk';
const OPS_PAGE_LIMIT = 200;
// docs/plans/2026-07-03-cloud-c0c-sync-push-relay.md Task 3: snapshot once the
// un-compacted oplog tail passes this many ops.
const SNAPSHOT_THRESHOLD = 500;

// flushPending drains 'pending' in successive chunks, each bounded to match the
// server's per-request caps (sync.go maxOpsPerBatch / maxSyncOpsBodyBytes). A
// bulk import (a Mi-Band .nxk drains hundreds of day-batch records; med-0ol) or
// a backlog that piled up while offline queues far more pending than one POST
// may carry — posting them all at once trips the server's 500-op / 1 MiB caps
// with a permanent 400 that blind retries can never clear (med-0ol.2/.5). The
// ordinary 1-2-record write still posts in a single chunk, unchanged.
const MAX_OPS_PER_BATCH = 500; // == sync.go maxOpsPerBatch
const FLUSH_MAX_BODY_BYTES = 900 * 1024; // stay under the server's 1 MiB body cap

// A bare fetch() has no timeout, so a half-open connection (captive portal,
// degraded network — NOT clean airplane mode, which rejects fast) hangs the
// awaited fetch forever. Every /api/sync/* call below therefore goes through
// timedFetch, which aborts after SYNC_FETCH_TIMEOUT_MS and rejects like any
// other network failure — landing in each call site's existing `catch { offline
// = true; ... }` degrade path, so pending rows/markers stay put and the next
// pullOnOpen retries. This is what keeps a stalled boot from wedging the mount
// (med-gvk.2). 10s mirrors rxnorm.js / aiclient.js's FETCH_TIMEOUT_MS.
const SYNC_FETCH_TIMEOUT_MS = 10000;
function timedFetch(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_FETCH_TIMEOUT_MS);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Consecutive permanent-error flush opens before syncing pauses (med-0ol.7).
// #613 stopped the tight loop but a doomed batch still re-POSTs once per open,
// forever. After this many permanent 4xx failures, flushPending gives up and
// sets syncWedged so it stops re-posting the un-acceptable batch; the user
// recovers via resetLocalSync. Transient errors (5xx/offline) never count.
const WRITE_ERROR_BUDGET = 3;

// record_type_tag is the only wire field the server stores unencrypted
// alongside the ciphertext (opWire.RecordTypeTag) — packing "<type>:<recordId>"
// into it lets the reading client recover record_type/record_id for the AAD
// binding without a schema change, and costs nothing: neither was ever
// confidential (docs/cloud-crypto.md AAD only binds already-visible metadata).
function makeTag(recordType, recordId) {
  return `${recordType}:${recordId}`;
}
function parseTag(tag) {
  const idx = tag.indexOf(':');
  return { recordType: tag.slice(0, idx), recordId: tag.slice(idx + 1) };
}

let offline = false;
// 401 = server session expired — distinct from network-offline. Pending ops are
// never dropped; the user re-runs the passkey ceremony to re-mint the session.
let authExpired = false;
const kDataCache = new WeakMap();

// Serializes the record-store mutations that must not interleave:
// replaceAllRecords() clears the whole store and re-lays a snapshot, while a
// write lands as putRecord()→markPending(). If the clear straddles that pair
// (record already in 'records', 'pending' row not yet written), the overlay
// preservation in replaceAllRecords misses it, the clear wipes it, and
// flushPending's getRecord() returns null → the write is silently lost and its
// 'pending' row orphaned. A single-slot promise queue makes the two regions
// mutually exclusive. The two locked regions never nest, so this can't
// deadlock. ponytail: module-global lock; fine for one device's serial sync.
let recordsLock = Promise.resolve();
function withRecordsLock(fn) {
  const run = recordsLock.then(fn, fn);
  recordsLock = run.then(() => {}, () => {}); // keep the queue alive past a failure
  return run;
}

async function getKData(ctx) {
  let kData = kDataCache.get(ctx.dek);
  if (!kData) {
    kData = await deriveKData(ctx.dek);
    kDataCache.set(ctx.dek, kData);
  }
  return kData;
}

// --- local IDB mirror ---------------------------------------------------

// Run fn against the shared cached connection. If the handle was closed out from
// under us (versionchange, external close), db.transaction() throws
// InvalidStateError — drop the cache, reopen once, and retry.
async function withDb(fn) {
  let db = await cachedDb();
  try {
    return await fn(db);
  } catch (err) {
    if (err && err.name === 'InvalidStateError') {
      dropCachedDb();
      db = await cachedDb();
      return await fn(db);
    }
    throw err;
  }
}

async function withStore(storeName, mode, fn) {
  return withDb((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = fn(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readMeta() {
  return withDb(async (db) => {
    const tx = db.transaction('sync_meta', 'readonly');
    const store = tx.objectStore('sync_meta');
    const [localLastSeq, lastSnapshotSeq, lastSyncedAt, integrityErrors, forceSnapshotPending, snapshotError, snapshotErrorSeq, writeError, clockSkewMs, writeErrorStreak, syncWedged] = await Promise.all([
      reqToPromise(store.get('localLastSeq')),
      reqToPromise(store.get('lastSnapshotSeq')),
      reqToPromise(store.get('lastSyncedAt')),
      reqToPromise(store.get('integrityErrors')),
      reqToPromise(store.get('forceSnapshotPending')),
      reqToPromise(store.get('snapshotError')),
      reqToPromise(store.get('snapshotErrorSeq')),
      reqToPromise(store.get('writeError')),
      reqToPromise(store.get('clockSkewMs')),
      reqToPromise(store.get('writeErrorStreak')),
      reqToPromise(store.get('syncWedged')),
    ]);
    return {
      localLastSeq: localLastSeq ?? null,
      lastSnapshotSeq: lastSnapshotSeq ?? 0,
      lastSyncedAt: lastSyncedAt ?? null,
      integrityErrors: integrityErrors ?? 0,
      forceSnapshotPending: forceSnapshotPending ?? false,
      snapshotError: snapshotError ?? null,
      writeError: writeError ?? null,
      clockSkewMs: clockSkewMs ?? 0,
      snapshotErrorSeq: snapshotErrorSeq ?? null,
      writeErrorStreak: writeErrorStreak ?? 0,
      syncWedged: syncWedged ?? false,
    };
  });
}

async function writeMeta(patch) {
  await withStore('sync_meta', 'readwrite', (store) => {
    for (const [key, value] of Object.entries(patch)) store.put(value, key);
  });
}

async function getRecord(recordId) {
  return withStore('records', 'readonly', (store) => reqToPromise(store.get(recordId))).then((r) => r ?? null);
}

// --- plaintext records memo (med-90w.1) ----------------------------------
// listRecords is fired ~8+ times per section-open and each call re-opened IDB,
// getAll'd + structured-cloned + filtered + sorted a type's whole history. This
// module-level cache holds the canonical filtered+sorted array per type,
// invalidated PRECISELY at every physical write funnel (putRecord ←
// writeRecord+applyIncoming, replaceAllRecords, resetLocalSync). recordsChangeCount
// is a monotonic generation counter: it doubles as the race guard for uncached
// reads and as the getRecordsChangeCount() signal the gamification bead (med-90w.2)
// polls. A stale memo shows wrong health data — invalidation must be exhaustive.
const recordsMemo = new Map();
let recordsChangeCount = 0;
let bootstrapped = false;

export function getRecordsChangeCount() {
  return recordsChangeCount;
}

function invalidateRecords(type) {
  if (type) recordsMemo.delete(type);
  else recordsMemo.clear();
  recordsChangeCount++;
}

// A dropped cached connection (versionchange / deleteDatabase / account-delete)
// means the underlying store may have changed identity out from under the memo,
// so reset every derived cache. Also the reset hook that clears module state
// between tests (fake-indexeddb's deleteDatabase fires onversionchange).
onCachedDbDropped(() => {
  recordsMemo.clear();
  recordsChangeCount++;
  bootstrapped = false;
});

async function putRecord(record) {
  await withStore('records', 'readwrite', (store) => store.put(record));
  invalidateRecords(record && record.recordType);
}

async function readAllRecords() {
  return withStore('records', 'readonly', (store) => reqToPromise(store.getAll()));
}

export async function replaceAllRecords(records) {
  // Preserve optimistic copies of not-yet-flushed writes: a snapshot bootstrap
  // (or a compaction re-bootstrap from pullTail) clears the whole store, but
  // pending writes are unsynced local truth the snapshot doesn't contain yet —
  // wiping them loses the user's note and orphans its 'pending' row forever.
  // Re-overlay them after the clear; the oplog tail LWW-corrects them once the
  // server assigns their real seq.
  await withRecordsLock(async () => {
    const pending = await readPending();
    const overlay = [];
    for (const { recordId } of pending) {
      const r = await getRecord(recordId);
      if (r) overlay.push(r);
    }
    await withStore('records', 'readwrite', (store) => {
      store.clear();
      for (const record of records) store.put(record);
      for (const record of overlay) store.put(record);
    });
  });
  invalidateRecords();
}

// Drop not-yet-flushed writes for the given record types. A destructive
// full-vault import is replace-only: it supersedes every managed record, so a
// pending managed write (create/update/delete) must NOT survive the replace —
// replaceAllRecords re-overlays all pending after its clear (correct for a
// bootstrap, wrong here: it would resurrect a pending create, override a backup
// value with a pending update, or re-tombstone a record the backup restored),
// and the row would later flush over the imported backup. importAll calls this
// before replaceAllRecords so only non-managed pending (nk, reminder prefs)
// stays queued. Held under withRecordsLock so it's atomic w.r.t. writeRecord.
export async function dropPendingForTypes(types) {
  await withRecordsLock(async () => {
    const stale = (await readPending()).filter((p) => types.has(p.recordType));
    await clearPending(stale.map((p) => p.recordId));
  });
}

// Rebuild this device from the server's compacted snapshot (med-0ol.7 recovery).
// DISCARDS un-synced local pending writes by design — it's the escape hatch a
// wedged device (WRITE_ERROR_BUDGET spent, syncWedged set) or a bloated-oplog
// device uses to recover without support. Clearing 'sync_meta' nulls
// localLastSeq (so the next bootstrap re-pulls the snapshot from the floor) plus
// syncWedged / writeError / writeErrorStreak / forceSnapshotPending, so syncing
// resumes clean. The 'device' store (NK / LDK / crypto state) is left intact.
//
// records + pending + sync_meta are wiped in ONE readwrite transaction under
// withRecordsLock, so a crash mid-reset can't leave records without their cursor
// — either all three clear or none do, and a null cursor the next bootstrap
// heals is the worst case. pullOnOpen then re-bootstraps from the server.
export async function resetLocalSync(ctx) {
  await withRecordsLock(async () => {
    await withDb((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(['records', 'pending', 'sync_meta'], 'readwrite');
      tx.objectStore('records').clear();
      tx.objectStore('pending').clear();
      tx.objectStore('sync_meta').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  });
  invalidateRecords();
  bootstrapped = false;
  offline = false;
  authExpired = false;
  await pullOnOpen(ctx);
  // pullOnOpen swallows a transient bootstrap failure (offline / 5xx behind the
  // proxy) and leaves localLastSeq null — the mirror is now WIPED and empty. If
  // the caller reloaded on a resolved promise it would drop the user into a blank
  // app with the reset framed as done. Throw so the UI (doResetSync) surfaces the
  // failure and skips the reload; the data is still on the server and the next
  // successful open re-bootstraps it. A fresh account bootstraps to seq 0 (not
  // null), so a legitimately-empty vault still resolves cleanly.
  if ((await readMeta()).localLastSeq === null) {
    throw new Error('Reset could not reach the server — reconnect and try again.');
  }
}

async function markPending(recordId, recordType) {
  await withStore('pending', 'readwrite', (store) => store.put({ recordId, recordType }));
}

async function readPending() {
  return withStore('pending', 'readonly', (store) => reqToPromise(store.getAll()));
}

// --- device-local plaintext values (NK, demo reminders) -------------------
// Shares the 'device' object store with unlock.js's LDK cache (localdb.js),
// keyed by name — plain out-of-line values, no schema bump needed.

async function readDeviceValue(key) {
  return withStore('device', 'readonly', (store) => reqToPromise(store.get(key))).then((r) => r ?? null);
}

async function writeDeviceValue(key, value) {
  await withStore('device', 'readwrite', (store) => store.put(value, key));
}

async function deleteDeviceValue(key) {
  await withStore('device', 'readwrite', (store) => store.delete(key));
}

async function clearPending(recordIds) {
  await withStore('pending', 'readwrite', (store) => {
    for (const id of recordIds) store.delete(id);
  });
}

// --- repaint on write ----------------------------------------------------
//
// In cloud mode most writers are NOT the UI: the ElevenLabs voice agent's client
// tools, the Claude connector over the MCP relay, the sealed Telegram inbox
// drain, and incoming sync pulls all land records without any screen knowing.
// Bot mode's /api/changes + SSE repaint loop is a deliberate no-op here
// (data-store.js startChangePolling), so before this emit those writes were
// durable but invisible until a reload.
//
// Every one of them funnels through writeRecord (via recordsPort) or
// applyIncoming, so one notification at each covers today's writers and whatever
// we add next. Sprinkling invalidateTags across the four call sites would be N
// edits now and silently wrong for writer N+1.
const RECORD_TAGS = {
  bp: ['bp'],
  bpgoal: ['bp'],
  weight: ['weight'],
  weightgoal: ['weight'],
  foodlog: ['food'],
  foodproduct: ['food'],
  foodtargets: ['food', 'food_targets'],
  medication: ['medications'],
  restock: ['medications'],
  intake: ['medications', 'history'],
  note: ['notes', 'health-notes'],
  sleep: ['health'],
  hrsample: ['health'],
  spo2sample: ['health'],
  stresssample: ['health'],
  daystats: ['health'],
  workoutgroup: ['workout'],
  workoutvariant: ['workout'],
  workoutexercise: ['workout'],
  workoutsession: ['workout'],
  workoutrotation: ['workout'],
  exerciselog: ['workout'],
  exerciselibrary: ['workout', 'exercise_library'],
  miband: ['workout', 'health'],
  settings: ['settings'],
  features: ['settings', 'feature_settings'],
  taborder: ['settings'],
  integrations: ['settings'],
  // ponytail: unmapped types (nk, firstrun, tzplan, *reminderpref, voiceprovisioning)
  // back no tag-cached screen, so they emit nothing. Add a row when one does.
};

// Where a write came from. Only the UI's own writes are suppressed: the screen
// that issued them has already repainted, and telling the user "New data is
// available" about the setting they just changed is nonsense (med-dvr).
//
// Everything else — voice, the Claude connector, the Telegram inbox drain, the
// background materialization sweep, and incoming sync pulls — MUST repaint, so
// ORIGIN_EXTERNAL is the default. An untagged writer added later renders a
// stale screen at worst, never a silent one; the reverse default would make
// med-d5t.10 regress silently.
export const ORIGIN_UI = 'ui';
export const ORIGIN_EXTERNAL = 'external';

// Fire-and-forget: a repaint must never fail a durable write. Runs in the page
// (window.DataStore); a no-op in the service worker and in node tests that do
// not stub a DataStore.
//
// The previous guard was hasAnyPendingOptimistic(), which is only ever true for
// writes that go through DataStore.applyOptimistic. Settings writes do not —
// toggleFeatureSetting POSTs straight through apiCall — so the guard passed,
// the emit fired, and the user was told there was new data about the toggle
// they had just flipped. The origin is known at the call site; use it.
function notifyRecordsChanged(recordTypes, origin) {
  if (origin === ORIGIN_UI) return;
  const tags = [...new Set([...recordTypes].flatMap((t) => RECORD_TAGS[t] || []))];
  if (tags.length === 0) return;
  const ds = typeof window !== 'undefined' && window.DataStore;
  if (!ds || typeof ds.requestTabRefresh !== 'function') return;
  Promise.resolve(typeof ds.invalidateTags === 'function' ? ds.invalidateTags(tags) : undefined)
    .then(() => ds.requestTabRefresh(tags, 'cloud-write'))
    .catch(() => {});
}

// --- clock skew (med-d5t.6) ----------------------------------------------
//
// Convergence is last-writer-wins on clientTs, and clientTs was the WRITING
// DEVICE's Date.now(). No server timestamp, no Lamport counter, no monotonic
// guard. So, with no exotic assumptions:
//
//   A friend's phone clock runs 10 minutes fast. They edit a medication dose on
//   the phone (clientTs = T+10min). Ten minutes later, on a correctly-clocked
//   laptop, they fix a typo in the same record (clientTs = T+2min of real time,
//   which is LESS). applyIncoming sees the laptop write as older and silently
//   drops it. The wrong dose persists, with no warning and no trace.
//
// For a medication tracker that is the failure mode that matters most: silent,
// plausible, and about dosage. Two local fixes, neither touching the envelope
// format (whose versioning med-jb7.5 deferred), neither needing a server change:
//
//   1. SERVER-REFERENCED TIME. Every sync response carries a `Date` header — the
//      server's own clock, for free. Measure the offset and subtract it, so a
//      fast device stamps corrected times and every device's clientTs is
//      comparable on the same scale.
//   2. A PER-RECORD MONOTONIC GUARD. A write to a record you can already see
//      must beat the version you are overwriting, whatever either clock says.
//      This alone fixes the scenario above: the laptop is editing the record the
//      phone wrote, so it stamps phoneTs+1 and wins.
//
// (1) is the general correction, (2) is the guarantee. Neither orders two blind
// concurrent writes on skewed devices — that needs an HLC — but the user is
// warned when their clock is the reason.

// Beyond this the status line tells the user their clock is wrong. Small enough
// to ignore ordinary drift (the Date header is second-granular, and a phone that
// syncs NTP is within seconds), large enough that a real misconfiguration shows.
const CLOCK_SKEW_WARN_MS = 2 * 60 * 1000;

// skew > 0 means this device's clock is AHEAD of the server's.
function nextClientTs(existing, proposed, skewMs) {
  const base = typeof proposed === 'number' ? proposed : Date.now();
  const corrected = base - (skewMs || 0);
  // An edit of a record we hold must outrank the version it replaces, even if
  // that version came from a device whose clock is far in the future.
  if (existing && typeof existing.clientTs === 'number') {
    return Math.max(corrected, existing.clientTs + 1);
  }
  return corrected;
}

// Learn the server's clock from any sync response, at no cost: net/http sets a
// `Date` header on every one, and it is readable same-origin. The RTT is folded
// into the estimate, which is irrelevant against a minutes-scale threshold.
async function noteServerDate(res) {
  const header = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('Date') : null;
  if (!header) return;
  const serverMs = Date.parse(header);
  if (Number.isNaN(serverMs)) return;

  const skewMs = Date.now() - serverMs;
  const meta = await readMeta();
  // The header is second-granular, so persisting every jitter would rewrite meta
  // on every sync for no gain.
  if (Math.abs(skewMs - (meta.clockSkewMs || 0)) > 1000) {
    await writeMeta({ clockSkewMs: skewMs });
  }
}

// --- remote sync ---------------------------------------------------------

// Returns the recordType when the incoming record actually won (LWW on
// clientTs), so the caller can batch one repaint per pulled page rather than one
// per record.
async function applyIncoming(recordType, record) {
  const existing = await getRecord(record.recordId);
  if (!existing || record.clientTs > existing.clientTs) {
    await putRecord({ ...record, recordType });
    return recordType;
  }
  return null;
}

// Returns true once the local mirror is at a known cursor. False means "did not
// bootstrap" — callers that would otherwise proceed on a stale cursor must bail.
async function bootstrap(ctx) {
  // A stranded full-vault import (forceSnapshotPending) means the LOCAL store is
  // authoritative and has not been pushed yet. Replacing it with the server's
  // stale snapshot would destroy the import. pullOnOpen also guards this, but
  // bootstrap is reachable from pullTail's compaction branch — which flushPending
  // reaches on any write — so the guard has to live here, at the one place that
  // calls replaceAllRecords.
  if ((await readMeta()).forceSnapshotPending) return false;
  const kData = await getKData(ctx);
  let snapRes;
  try {
    snapRes = await timedFetch('/api/sync/snapshot');
  } catch {
    offline = true;
    return false; // leave localLastSeq null so bootstrapIfNeeded retries next open
  }
  // 204 = fresh account with no snapshot (a legit cursor-0 bootstrap); anything
  // other than 200/204 (5xx behind a proxy, transient error) must NOT poison
  // the cursor to 0 — a device that then pulled ?since=0 after a later
  // compaction would silently skip all snapshotted state. Stay null → retry.
  if (snapRes.status !== 200 && snapRes.status !== 204) {
    if (isAuthExpiredStatus(snapRes.status)) {
      authExpired = true;
      offline = false;
    } else {
      offline = true;
    }
    return false;
  }
  offline = false;
  authExpired = false;
  let lastSnapshotSeq = 0;
  if (snapRes.status === 200) {
    const body = await snapRes.json();
    try {
      const plaintext = await decryptSnapshot({
        kData,
        accountId: ctx.accountId,
        snapshotSeq: body.snapshot_seq,
        nonce: fromBase64(body.nonce),
        ct: fromBase64(body.ct),
      });
      // Snapshots are gzip-then-encrypt (magic 0x1f 0x8b); legacy uncompressed
      // ones start with raw JSON, so sniff and gunzip only when compressed.
      const json = isGzip(plaintext) ? await gunzip(plaintext) : plaintext;
      const records = JSON.parse(new TextDecoder().decode(json));
      await replaceAllRecords(records);
      lastSnapshotSeq = body.snapshot_seq;
    } catch {
      // Undecryptable snapshot (tampered ct or key mismatch): surface it and
      // still advance the cursor past the compaction floor. Otherwise pullTail
      // sees snapshot_seq > localLastSeq(0), re-bootstraps, fails again, and
      // spins in a tight fetch loop that never resolves. Mirrors the per-op
      // decrypt-failure handling below (advance past the bad seq).
      await writeMeta({ integrityErrors: (await readMeta()).integrityErrors + 1 });
      lastSnapshotSeq = body.snapshot_seq;
    }
  }
  await writeMeta({ localLastSeq: lastSnapshotSeq, lastSnapshotSeq });
  return true;
}

async function bootstrapIfNeeded(ctx) {
  // Once we know our cursor, skip the 11-key sync_meta read on every list call.
  // A dropped connection / resetLocalSync clears this flag so a re-bootstrap
  // still runs.
  if (bootstrapped) return;
  const meta = await readMeta();
  if (meta.localLastSeq !== null) { bootstrapped = true; return; }
  if (await bootstrap(ctx)) bootstrapped = true;
}

async function pullTail(ctx) {
  const kData = await getKData(ctx);
  for (;;) {
    const meta = await readMeta();
    // Not bootstrapped (bootstrap failed transiently, cursor still null): a
    // ?since=null request is a guaranteed 400, and pulling before we know our
    // floor is meaningless. Bail; the next open retries bootstrap first.
    if (meta.localLastSeq === null) return;
    let res;
    try {
      res = await timedFetch(`/api/sync/ops?since=${meta.localLastSeq}&limit=${OPS_PAGE_LIMIT}`);
    } catch {
      offline = true;
      return;
    }
    // Cheapest possible clock reference: the response's own `Date` header.
    await noteServerDate(res);
    if (!res.ok) {
      if (isAuthExpiredStatus(res.status)) {
        authExpired = true;
        offline = false;
      } else {
        offline = true;
      }
      return;
    }
    offline = false;
    authExpired = false;
    const body = await res.json();
    // The server compacted past our cursor (another device snapshotted while we
    // were away): ops between our cursor and body.snapshot_seq no longer exist,
    // so an incremental tail would silently skip them. Re-bootstrap from the
    // snapshot, then resume the tail above it.
    if (typeof body.snapshot_seq === 'number' && body.snapshot_seq > meta.localLastSeq) {
      // Transient failure, or a stranded import that must be pushed first: either
      // way the cursor didn't move, so looping would spin. Retry next open.
      if (!(await bootstrap(ctx))) return;
      continue;
    }
    const applied = new Set();
    for (const op of body.ops || []) {
      const { recordType, recordId } = parseTag(op.record_type_tag);
      try {
        const plaintext = await decryptRecord({
          kData,
          accountId: ctx.accountId,
          recordType,
          recordId,
          seq: op.seq,
          nonce: fromBase64(op.nonce),
          ct: fromBase64(op.ct),
        });
        const won = await applyIncoming(recordType, JSON.parse(new TextDecoder().decode(plaintext)));
        if (won) applied.add(won);
      } catch {
        // Unreadable op — almost always the benign seq-in-AAD mis-prediction
        // junk a concurrent writer leaves behind (flushPending re-posts a good
        // copy under a fresh seq), not tampering. Counting these as
        // "integrity" warnings would fire on ordinary multi-device use, so
        // just skip the row and advance. Genuine tamper detection lives on the
        // snapshot decrypt path (bootstrap), which has no benign-failure case.
      }
      await writeMeta({ localLastSeq: op.seq });
    }
    await writeMeta({ lastSyncedAt: Date.now() });
    notifyRecordsChanged(applied, ORIGIN_EXTERNAL);
    if (!body.next) break;
  }
}

// snapshotAt encrypts the whole local record store and POSTs it as the
// compaction floor at `snapshotSeq`. Shared by the threshold-gated
// maybeSnapshot and the C2e forced snapshot after a full-vault import. Returns
// whether the snapshot landed; a rejected body (oversized, seq ahead of the
// server) is only "offline" for the forced path, where it strands the import —
// maybeSnapshot runs after a successful pull+flush, so failing it must not flip
// a healthy app to offline for good.
async function snapshotAt(ctx, snapshotSeq) {
  const kData = await getKData(ctx);
  const records = await readAllRecords();
  // gzip the JSON before encryption so the ciphertext (POST body) shrinks ~10x;
  // bootstrap sniffs the gzip magic bytes on decrypt. AAD/nonce unchanged.
  const plaintext = await gzip(new TextEncoder().encode(JSON.stringify(records)));
  const { nonce, ct } = await encryptSnapshot({ kData, accountId: ctx.accountId, snapshotSeq, plaintext });
  let res;
  try {
    res = await timedFetch('/api/sync/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot_seq: snapshotSeq, nonce: toBase64(nonce), ct: toBase64(ct) }),
    });
  } catch {
    offline = true;
    return { ok: false, status: 0 }; // network error — retryable
  }
  if (isAuthExpiredStatus(res.status)) {
    authExpired = true;
    offline = false;
    return { ok: false, status: res.status };
  }
  if (!res.ok) return { ok: false, status: res.status }; // 4xx=won't-fit, 5xx=retryable; caller decides offline
  offline = false;
  authExpired = false;
  // A successful snapshot means the store now fits the server cap, so clear any
  // stale "too large" error a prior oversized snapshot recorded. Covers both the
  // forced path and the threshold-gated maybeSnapshot (e.g. the store shrank, or
  // a peer re-bootstrap healed this device) — otherwise the banner sticks forever.
  // snapshotErrorSeq goes with it, so the backoff floor drops back to lastSnapshotSeq.
  await writeMeta({ lastSnapshotSeq: snapshotSeq, snapshotError: null, snapshotErrorSeq: null });
  return { ok: true, status: res.status };
}

// maybeSnapshot compacts the oplog once it has grown SNAPSHOT_THRESHOLD ops past
// the last snapshot. Its failure mode is the quiet one that matters: a permanent
// 4xx (body over the server cap, account quota exhausted) means the snapshot will
// never land, so compaction STOPS and the oplog grows without bound — and every
// new device then pages the whole thing on first sync. snapshotAt's {ok,status}
// used to be discarded here, so that state was invisible and unbounded: each
// later flush re-read, re-gzipped and re-encrypted the entire vault into a body
// the server would refuse again.
//
// So: record the permanent failure durably (surfaced by describeSyncStatus, and
// cleared by any later successful snapshotAt), and back off to one retry per
// SNAPSHOT_THRESHOLD ops by holding snapshotErrorSeq as an additional floor. A
// vault that shrinks, or a server whose cap is raised, still heals on its own —
// it just doesn't re-attempt the oversized upload on every single flush.
//
// Transient failures (5xx, network) record nothing: snapshotAt has already set
// `offline` where appropriate, the floor stays put, and the next flush retries.
async function maybeSnapshot(ctx) {
  const meta = await readMeta();
  if (meta.localLastSeq === null) return;
  // A wedged device holds unsynced optimistic records in 'records' that the
  // server REFUSED as ops (flushPending early-returned without clearing them).
  // Snapshotting publishes the whole local store as the compaction floor, so it
  // would republish exactly the writes the wedge stopped pushing — undoing the
  // pause. pullOnOpen calls this right after a wedged flushPending, so guard it
  // here (the flushPending-internal callers already return before reaching it).
  // resetLocalSync clears syncWedged, so compaction resumes after recovery.
  if (meta.syncWedged) return;
  const floor = Math.max(meta.lastSnapshotSeq, meta.snapshotErrorSeq ?? 0);
  if (meta.localLastSeq - floor < SNAPSHOT_THRESHOLD) return;
  const snap = await snapshotAt(ctx, meta.localLastSeq);
  if (!snap.ok && isPermanentSyncStatus(snap.status)) {
    await writeMeta({
      snapshotError: { status: snap.status, at: Date.now() },
      snapshotErrorSeq: meta.localLastSeq,
    });
  }
}

// A throwaway tombstone whose only purpose is to advance the account seq below.
// Not vault-managed, always deleted, so it never renders, exports, or survives.
const IMPORT_BUMP_RECORD_ID = '__vault_import_bump__';

// forceSnapshot propagates a C2e full-vault import to the account's other
// devices. The import lands its whole record set via replaceAllRecords (not the
// oplog), so last_seq hasn't moved — but the ONLY "re-bootstrap" signal a peer
// gets is snapshot_seq > its cursor (pullTail), and the server rejects
// snapshot_seq <= 0. Snapshotting at the unchanged cursor therefore reaches
// neither a fully-synced peer (same seq) nor a fresh account (seq 0), leaving
// the import stranded on this one browser. So append one throwaway tombstone op
// first: it advances last_seq by >=1, so the snapshot below lands strictly above
// every peer cursor (and above 0) and they re-bootstrap from it. That op is
// compacted away by the very snapshot that supersedes it. No-op if the device
// never bootstrapped.
//
// Both steps (bump post, snapshot upload) can fail transiently offline, and
// their swallow-and-return error handling would otherwise leave the import
// stranded on this device until the threshold-gated maybeSnapshot eventually
// fired (peers stuck on stale data for up to SNAPSHOT_THRESHOLD ops). So set a
// durable forceSnapshotPending marker first and drive the actual work through
// tryForceSnapshot, which pullOnOpen also re-runs (before any pull) every open
// until the snapshot lands.
export async function forceSnapshot(ctx) {
  await markForceSnapshotPending();
  await tryForceSnapshot(ctx);
}

// Set the durable marker BEFORE the destructive replaceAllRecords. Between the
// replace landing and the marker being written, bootstrap()/pullOnOpen() see no
// marker and re-bootstrap the stale server snapshot over the fresh import — and
// the pre-import data is already gone. Marking first makes that window safe: a
// crash leaves a pending forced snapshot, which the next open retries.
export async function markForceSnapshotPending() {
  // Clear any stale error from a previous oversized import so this fresh
  // attempt doesn't inherit a "too large" banner while it's merely pending.
  // Also un-wedge (med-0ol.7): a full-vault import replaces exactly the records
  // that a permanent write-error wedged on, and its snapshot bump bypasses the
  // wedge-guarded flushPending — so without clearing here the device lands the
  // import but leaves syncWedged set, silently blocking every later writeRecord.
  await writeMeta({ forceSnapshotPending: true, snapshotError: null, snapshotErrorSeq: null, syncWedged: false, writeErrorStreak: 0 });
}

// A permanent 4xx means the request reached a server that refused it and will
// keep refusing (oversized body → 400, quota exceeded → 413). Retrying wedges
// the app forever, so the force-snapshot path records a durable error instead.
// 401/403/408/429 are transient (auth expiry / proxy timeout / rate-limit — a
// reverse proxy in front of cmd/cloud can return these even though the Go server
// didn't); mirrors web/static/js/sync.js isPermanentSyncError.
function isPermanentSyncStatus(status) {
  return status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
}

// 401 routes to the distinct auth-expired state (never permanent, never
// offline): the non-sliding 30-day session lapsed and only a passkey re-auth
// can clear it. 403/408/429 stay transient-offline.
function isAuthExpiredStatus(status) {
  return status === 401;
}

// Drives (or retries) a pending forced snapshot to completion: advance last_seq
// with one throwaway op, then upload the snapshot at the server-assigned seq.
// Clears the marker only once the snapshot upload actually succeeds
// (lastSnapshotSeq caught up); any transient failure along the way leaves it set
// for the next pullOnOpen to retry. No-op when nothing is pending.
//
// The bump is posted DIRECTLY to /api/sync/ops, NOT through writeRecord/
// flushPending. The imported records live only in the 'records' store, never in
// 'pending', so flushPending's mis-predict handling — which re-pulls the tail
// and, if the server compacted while we were away, re-bootstraps the stale
// server snapshot straight over the just-imported records — would silently wipe
// the import and then snapshot that loss as success. Posting the op ourselves
// and snapshotting at the server-assigned seq keeps last_seq moving above every
// peer cursor and compaction floor without any pull touching the local store.
// The op's AAD-bound seq is irrelevant (its prediction may be wrong after a
// compaction): it's a tombstone the snapshot below compacts away, never
// decrypted by anyone.
async function tryForceSnapshot(ctx) {
  const meta = await readMeta();
  if (!meta.forceSnapshotPending || meta.localLastSeq === null) return;
  const kData = await getKData(ctx);
  const bumpBody = new TextEncoder().encode(
    JSON.stringify({ recordId: IMPORT_BUMP_RECORD_ID, clientTs: Date.now(), deleted: true }),
  );
  const { nonce, ct } = await encryptRecord({
    kData,
    accountId: ctx.accountId,
    recordType: 'importbump',
    recordId: IMPORT_BUMP_RECORD_ID,
    seq: meta.localLastSeq + 1,
    plaintext: bumpBody,
  });
  let res;
  try {
    res = await timedFetch('/api/sync/ops', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops: [{ record_type_tag: makeTag('importbump', IMPORT_BUMP_RECORD_ID), nonce: toBase64(nonce), ct: toBase64(ct) }] }),
    });
  } catch {
    offline = true;
    return; // couldn't reach the server — marker stays set, retried next open
  }
  if (!res.ok) {
    // A permanent 4xx on the bump (e.g. 413 quota exceeded) will keep failing.
    // Unlike the snapshot leg below — which advances localLastSeq to the
    // server-assigned seq before its upload, keeping this device's cursor at/above
    // the compaction floor — the bump was REJECTED, so we have no assigned seq and
    // the cursor stays where bootstrap left it, below the floor. Clearing the
    // marker here would let pullOnOpen fall through to pullTail, which re-bootstraps
    // the stale server snapshot straight over the just-imported records (the exact
    // silent wipe the header comment guards against). So surface the error for the
    // status line but KEEP the marker set: pullOnOpen returns early (no pull, no
    // wipe), and re-attempting the tiny bump op each open is cheap (not the
    // oversized-snapshot re-encrypt wedge). The user must free account quota for
    // the import to sync.
    if (isAuthExpiredStatus(res.status)) {
      authExpired = true;
      offline = false;
      return; // marker stays set — retried after re-auth
    }
    if (isPermanentSyncStatus(res.status)) {
      await writeMeta({ snapshotError: { status: res.status, at: Date.now() } });
      offline = false;
      return;
    }
    offline = true;
    return;
  }
  offline = false;
  authExpired = false;
  const { assigned } = await res.json();
  if (!Array.isArray(assigned) || assigned.length === 0) {
    offline = true; // malformed response — don't poison the cursor with -Infinity
    return;
  }
  const snapshotSeq = Math.max(...assigned);
  // Advance our cursor to the bump so a subsequent pull sees our own snapshot as
  // the floor (no re-bootstrap) once the marker clears.
  await writeMeta({ localLastSeq: snapshotSeq });
  // A rejected snapshot leaves forceSnapshotPending set, which blocks every later
  // pull/flush. A permanent 4xx means the snapshot is larger than the server cap
  // and will NEVER fit, so re-encrypting it every open wedges the app forever and
  // blocks all pulls. Record a durable error, clear the pending marker so the
  // pull/flush path proceeds, and surface it in the status line. A 5xx/offline
  // failure is transient: leave the marker set and retry next open.
  const snap = await snapshotAt(ctx, snapshotSeq);
  if (!snap.ok) {
    if (isAuthExpiredStatus(snap.status)) return; // snapshotAt already flagged authExpired
    if (isPermanentSyncStatus(snap.status)) {
      await writeMeta({ forceSnapshotPending: false, snapshotError: { status: snap.status, at: Date.now() } });
      offline = false;
      return;
    }
    offline = true;
    return;
  }
  if ((await readMeta()).lastSnapshotSeq >= snapshotSeq) {
    await writeMeta({ forceSnapshotPending: false, snapshotError: null, snapshotErrorSeq: null });
  }
}

// readAllLiveRecords returns every non-tombstoned record (with its recordType)
// — the flat input recordsToVault regroups for a full-vault export. Bootstraps
// first so a just-unlocked device exports the synced set, not an empty store.
export async function readAllLiveRecords(ctx) {
  await bootstrapIfNeeded(ctx);
  return (await readAllRecords()).filter((r) => !r.deleted);
}

// True once bootstrap has established the account cursor. A full-vault import
// MUST NOT wipe local records before this: with a null cursor forceSnapshot
// no-ops (nothing propagates, no durable retry marker), and the next open's
// bootstrap re-bootstraps the (stale) server snapshot straight over the just-
// imported records — silent data loss the UI reports as success. importAll
// guards on this and fails visibly instead.
export async function isBootstrapped() {
  return (await readMeta()).localLastSeq !== null;
}

// Max re-post attempts when a concurrent writer keeps interleaving (below).
const FLUSH_MAX_ATTEMPTS = 5;

// Returns true only when every pending op is CONFIRMED persisted server-side
// (the contiguous-assignment branch below), and false when writes were left in
// 'pending' for a later retry — offline, un-bootstrapped, or a concurrent-writer
// collision we couldn't resolve within FLUSH_MAX_ATTEMPTS. The mailbox drain
// (bd med-76c.2) relies on this distinction: it may only ack an inbound event
// once the ops it produced are durably on the server. Every other caller
// ignores the value, exactly as before.
// Every flushPending entry point (pullOnOpen, writeRecord's inline push,
// flushConfirmed) serializes through this chain: two concurrent flushes read
// the same 'pending' set and predict the same seqs, so the loser's whole batch
// is AAD-mis-bound — undecryptable junk ops in the oplog plus a wasted
// re-pull/re-post cycle. The drainInFlight slot only covers drain-vs-drain;
// this covers writes and the inbox ack barrier too. Safe as a non-reentrant
// lock: nothing inside flushPendingUnlocked calls back into flushPending
// (pullTail and maybeSnapshot don't).
let flushChain = Promise.resolve();
function flushPending(ctx) {
  const run = flushChain.then(() => flushPendingUnlocked(ctx));
  flushChain = run.catch(() => {});
  return run;
}

async function flushPendingUnlocked(ctx) {
  // A wedged device stops re-posting the doomed batch (med-0ol.7): after
  // WRITE_ERROR_BUDGET consecutive permanent errors, syncing pauses until the
  // user runs resetLocalSync. Writes still queue durably to 'pending' — nothing
  // is lost — but we no longer re-POST a batch the server will keep refusing.
  if ((await readMeta()).syncWedged) return false;
  const kData = await getKData(ctx);
  // Convergence under concurrent writers. Each record's AAD binds account_seq
  // (docs' "Seq assignment vs AAD"), but the client can't know its assigned
  // seq until POST returns. The server assigns a batch a contiguous block in
  // one tx, so it's all-or-nothing: if another device appended between our
  // cursor read and our POST, our whole batch lands at a *higher* block than
  // we predicted and every op is AAD-bound to the wrong seq — undecryptable on
  // every device (including us on re-pull). So on a mis-predicted batch we
  // must re-pull past the interleaved peer ops (and our now-dead ones) and
  // re-encrypt+re-post the same records under freshly predicted seqs. Bounded
  // so a continuously-writing peer can't spin us forever; leftover 'pending'
  // is retried on the next open/write.
  // ponytail: each collision leaks its mis-bound ops as undecryptable oplog
  // junk (rare for the toy note set); snapshot compaction eventually drops them.
  //
  // 'pending' is drained in successive ≤MAX_OPS_PER_BATCH / ≤FLUSH_MAX_BODY_BYTES
  // chunks (med-0ol.2/.5): a bulk import queues thousands of records, and one
  // giant POST would trip the server caps with a permanent 400 no retry can
  // clear. Chunk progress is unbounded (a big import legitimately needs many
  // chunks); only a mis-predict (concurrent writer) that we can't resolve
  // consumes one of the FLUSH_MAX_ATTEMPTS retries.
  let flushedAny = false;
  let mispredicts = 0;
  for (;;) {
    const pending = await readPending();
    if (pending.length === 0) {
      // Compact once the whole backlog has landed, not per chunk — a per-chunk
      // snapshot would re-gzip+re-upload the entire (growing) store on every
      // 500-op boundary of a bulk import, the very amplification med-0ol.2 is about.
      if (flushedAny) await maybeSnapshot(ctx);
      return true; // nothing left to flush — confirmed
    }
    const meta = await readMeta();
    // Not bootstrapped yet (bootstrap failed transiently): localLastSeq is null,
    // so `seq += 1` would predict seqs from 1 and AAD-bind every op to the wrong
    // seq. Keep the writes safely in 'pending' until a real bootstrap sets the
    // cursor.
    if (meta.localLastSeq === null) return false;
    let seq = meta.localLastSeq;
    const ops = [];
    const includedIds = [];
    let bodyBytes = 0;
    for (const { recordId, recordType } of pending) {
      if (ops.length >= MAX_OPS_PER_BATCH) break;
      const record = await getRecord(recordId);
      if (!record) continue;
      // recordType is already carried by the wire tag (parseTag) — omit it from
      // the encrypted body so the local-only bookkeeping field never round-trips.
      const { recordType: _recordType, ...wireBody } = record;
      const plaintext = new TextEncoder().encode(JSON.stringify(wireBody));
      const { nonce, ct } = await encryptRecord({
        kData,
        accountId: ctx.accountId,
        recordType,
        recordId,
        seq: seq + 1,
        plaintext,
      });
      const op = { record_type_tag: makeTag(recordType, recordId), nonce: toBase64(nonce), ct: toBase64(ct) };
      // Base64 lengths are the wire size; +48 covers each op's JSON scaffolding.
      const opBytes = op.nonce.length + op.ct.length + op.record_type_tag.length + 48;
      // Always send at least one op even if it alone exceeds the soft body
      // budget — the server's per-op cap (maxOpCTLen), not this budget, is the
      // real ceiling, and a lone large op still fits a 1 MiB request.
      if (ops.length > 0 && bodyBytes + opBytes > FLUSH_MAX_BODY_BYTES) break;
      seq += 1;
      ops.push(op);
      includedIds.push(recordId);
      bodyBytes += opBytes;
    }
    if (ops.length === 0) {
      // Every remaining 'pending' row referenced a deleted record — nothing to
      // send (matches the pre-chunk behaviour: vacuously confirmed).
      if (flushedAny) await maybeSnapshot(ctx);
      return true;
    }
    let res;
    try {
      res = await timedFetch('/api/sync/ops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ops }),
      });
    } catch {
      offline = true;
      return false; // left in 'pending' — retried on the next pullOnOpen/write
    }
    if (!res.ok) {
      // A permanent 4xx here is NOT offline. 413 means the account's storage
      // quota is exhausted: the server is reachable, healthy, and will refuse
      // this batch forever. Reporting it as "Offline" told the user to check
      // their wifi while their vault quietly stopped accepting writes, and the
      // pending queue grew without bound (med-d5t.4). A 400 (e.g. an
      // over-cap batch before chunking existed) is likewise permanent, so blind
      // retries can't clear it — surface it rather than spin (med-0ol.5).
      //
      // Records stay in 'pending' either way — nothing is lost, and the next
      // open retries — but the status line must name the real cause.
      if (isAuthExpiredStatus(res.status)) {
        authExpired = true;
        offline = false;
        return false; // pending kept intact — drained after re-auth
      }
      if (isPermanentSyncStatus(res.status)) {
        // Count consecutive permanent failures against a budget: once it's spent
        // the batch is genuinely doomed, so wedge syncing rather than re-POST it
        // on every open forever (med-0ol.7). Transient (5xx/offline) failures
        // fall through below and never touch the streak.
        const streak = (meta.writeErrorStreak ?? 0) + 1;
        await writeMeta({
          writeError: { status: res.status, at: Date.now() },
          writeErrorStreak: streak,
          ...(streak >= WRITE_ERROR_BUDGET ? { syncWedged: true } : {}),
        });
        offline = false;
        return false;
      }
      offline = true;
      return false;
    }
    offline = false;
    authExpired = false;
    await noteServerDate(res);
    const { assigned } = await res.json();
    // Cleared on the first batch the server accepts: the quota was raised, or
    // the user freed space. Reset the permanent-error streak too — the server is
    // accepting writes again, so the budget starts fresh.
    await writeMeta({ lastSyncedAt: Date.now(), writeError: null, writeErrorStreak: 0 });
    if (assigned[0] === meta.localLastSeq + 1) {
      // Assigned contiguously from our cursor — predicted seqs equal assigned
      // seqs, so every op's AAD is correct and other devices can decrypt them.
      // We already hold these records locally, so just clear and advance, then
      // loop to flush the next chunk (if any).
      await clearPending(includedIds);
      await writeMeta({ localLastSeq: Math.max(...assigned) });
      flushedAny = true;
      continue;
    }
    // Mis-predicted: a concurrent device interleaved. Re-pull to advance past
    // the peer ops (and our own now-dead ops — pullTail skips those unreadable
    // rows; our optimistic local copies survive since 'pending' is kept),
    // then loop to re-post these records under fresh seqs. Bounded so a
    // continuously-writing peer can't spin us forever.
    mispredicts++;
    if (mispredicts >= FLUSH_MAX_ATTEMPTS) return false;
    await pullTail(ctx);
    if (offline || authExpired) return false; // couldn't advance — retry next open / after re-auth
  }
}

// --- public API ------------------------------------------------------------

// Pull-on-open: bootstrap (snapshot + tail) on first run, incremental tail
// pull otherwise, then retry any writes a previous session couldn't push.
export async function pullOnOpen(ctx) {
  await bootstrapIfNeeded(ctx);
  // A pending forced snapshot (a C2e full-vault import a prior session couldn't
  // complete offline) means the LOCAL store is authoritative and must be PUSHED
  // before anything is pulled. The imported records live only in 'records',
  // never in 'pending', so pullTail's compaction re-bootstrap (or flushPending's
  // mis-predict re-pull) would wipe them with the stale server snapshot and then
  // snapshot that loss as success. Land the forced snapshot first; if it can't
  // land (offline), skip the pull entirely and retry next open — never let a
  // pull run while the import is still stranded on this device.
  if ((await readMeta()).forceSnapshotPending) {
    await tryForceSnapshot(ctx);
    if ((await readMeta()).forceSnapshotPending) return;
  }
  await pullTail(ctx);
  await flushPending(ctx);
  await maybeSnapshot(ctx);
}

// med-deq.2 — session-expiry recovery. Re-runs the passkey ceremony (unlock.js
// assertPasskey — its /api/webauthn/login/finish re-mints the non-sliding
// 30-day session cookie; the returned dek/accountId are discarded), then
// immediately drains the queue the 401s stranded. Dynamic import because
// unlock.js already dynamic-imports sync.js — a static edge here would be a
// cycle.
export async function reauthenticate(ctx) {
  const { assertPasskey } = await import('./unlock.js');
  await assertPasskey();
  authExpired = false;
  // Serialize with any reconnect auto-drain in flight — two concurrent
  // pullOnOpen runs would flush the same pending set under the same predicted
  // seqs (duplicate ops + a guaranteed mis-predict retry).
  while (drainInFlight) await drainInFlight;
  drainInFlight = pullOnOpen(ctx).finally(() => { drainInFlight = null; onDrainSettled(); });
  await drainInFlight;
  return getSyncStatus(ctx);
}

// med-deq.2 — reconnect auto-drain. Without this, queued offline edits sit
// until the next write or a reload. On window 'online' and on the tab becoming
// visible while navigator.onLine, re-run the boot drain path (pullOnOpen). A
// short setTimeout debounce coalesces event bursts; a single-slot in-flight
// guard (same posture as recordsLock) prevents overlapping drains. Returns a
// teardown removing both listeners. No-op outside a DOM context.
let drainInFlight = null;
// Installed by startReconnectAutoDrain; reauthenticate's .finally calls it too,
// so a rerun queued while a reauth-owned drain held the slot is still consumed
// instead of leaking into a spurious drain after the NEXT auto-drain.
let onDrainSettled = () => {};
export function startReconnectAutoDrain(ctx, { onAuthExpired } = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  let debounce = null;
  let stopped = false;
  let rerun = false;
  const drain = () => {
    // An event landing mid-drain coalesces into a run that may already have
    // missed it (e.g. a drain stuck on a dying fetch when connectivity
    // returned) — remember it and run once more after the current one settles.
    if (drainInFlight) { rerun = true; return drainInFlight; }
    drainInFlight = pullOnOpen(ctx)
      .catch(() => {}) // failures already land in sync status; retried on the next event
      .finally(() => {
        drainInFlight = null;
        onDrainSettled();
        // A mid-session expiry (the common case for a non-sliding 30-day
        // cookie in a long-lived PWA tab) is only ever detected by these
        // event-driven drains — the boot-time check already ran. Hand it to
        // the caller so the UI can surface it instead of queueing silently.
        if (authExpired && !stopped && onAuthExpired) onAuthExpired();
      });
    return drainInFlight;
  };
  onDrainSettled = () => { if (rerun && !stopped) { rerun = false; drain(); } };
  const trigger = () => {
    clearTimeout(debounce);
    debounce = setTimeout(drain, 250);
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible' && navigator.onLine) trigger();
  };
  window.addEventListener('online', trigger);
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    stopped = true;
    clearTimeout(debounce);
    window.removeEventListener('online', trigger);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

// Generic record-store read: live (non-tombstoned) records of a type from the
// local mirror, newest-first by clientTs. Backs recordsPort() below
// (web/domain/'s storage port).
export async function listRecords(ctx, recordType) {
  await bootstrapIfNeeded(ctx);
  const cached = recordsMemo.get(recordType);
  // Callers always get a .slice() (shallow copy): the domain layer sorts/reverses
  // its input in place, which would otherwise corrupt the cached array.
  if (cached) return cached.slice();
  // Miss: read the type via the 'recordType' index, not getAll()+filter — a
  // full-store scan structured-clones every record of every domain (a real vault
  // is hundreds of MiB of vitals samples), so the clone cost dwarfed the read.
  // Capture the generation BEFORE the async read: a write that invalidated this
  // type mid-read must not let us cache the now-stale result.
  const gen = recordsChangeCount;
  const records = await withStore('records', 'readonly', (store) => (
    reqToPromise(store.index('recordType').getAll(recordType))
  ));
  const result = records
    .filter((r) => !r.deleted)
    .sort((a, b) => b.clientTs - a.clientTs);
  if (recordsChangeCount === gen) recordsMemo.set(recordType, result);
  return result.slice();
}

// Bounded record-store read over the PRIMARY key, for types whose recordId
// embeds a lexicographically-chronological suffix (the vitals day-batches:
// 'hrsample-2026-07-08'). Reading a 30-day window then costs 30 clones instead
// of one per stored day — a multi-year account would otherwise re-expand every
// day of history on every overview() call. Bot mode never loads those rows
// either (SQL `date_time >=`, internal/store/vitals/repo.go).
//
// fromId/toId are INCLUSIVE. No index is needed: the store's keyPath is
// recordId, and IDBKeyRange.bound over it is the primary-key range.
export async function listRecordsInRange(ctx, recordType, fromId, toId) {
  await bootstrapIfNeeded(ctx);
  const records = await withStore('records', 'readonly', (store) => (
    reqToPromise(store.getAll(IDBKeyRange.bound(fromId, toId)))
  ));
  return records
    .filter((r) => r.recordType === recordType && !r.deleted)
    .sort((a, b) => b.clientTs - a.clientTs);
}

// flushConfirmed is the ack barrier for the inbound mailbox drain: it resolves
// true only once every locally-pending op is durably on the server. Callers that
// must not ack until their writes are safe (drainInbox) await this AFTER the
// domain write and only delete the mailbox event when it returns true.
export async function flushConfirmed(ctx) {
  return flushPending(ctx);
}

// isSyncWedged reports the same syncWedged meta flushPending gates on. The inbox
// drain (med-eas.51) reads it to skip the whole GET /api/inbox fetch while sync
// is wedged — a wedged flush can never ack, so re-fetching the (up to 160MB)
// backlog every poll is pure waste. Derived purely from meta, so resetLocalSync
// clearing syncWedged un-pauses the drain automatically. No bootstrap: a
// not-yet-bootstrapped account is not wedged.
export async function isSyncWedged() {
  return (await readMeta()).syncWedged === true;
}

// `flush` defaults true: a single write pushes its op inline, as every UI /
// voice / MCP / single-command writer expects. A BULK writer (the .nxk inbox
// import lands hundreds of records per event) passes flush:false so each write
// only queues to 'pending' — the drain's post-apply flushConfirmed then pushes
// the whole batch in chunks, turning ~1330 one-op POSTs into a handful of
// ≤500-op ones (med-0ol.2). Repaint still fires per write; the caller decides
// pushing, not painting.
export async function writeRecord(ctx, recordType, record, origin = ORIGIN_EXTERNAL, { flush = true } = {}) {
  await bootstrapIfNeeded(ctx);
  const meta = await readMeta();
  let stamped = record;
  // Atomic w.r.t. replaceAllRecords' clear (see withRecordsLock): the record
  // and its 'pending' row must both be visible, or neither, when a concurrent
  // bootstrap snapshots what to preserve.
  await withRecordsLock(async () => {
    const existing = await getRecord(record.recordId);
    stamped = { ...record, clientTs: nextClientTs(existing, record.clientTs, meta.clockSkewMs), recordType };
    await putRecord(stamped);
    await markPending(record.recordId, recordType);
  });
  // Local-first (med-eas.77): the write is already durable in 'pending'
  // (markPending, above) and apiCall returns the LOCAL stamped record, never a
  // server ack — so the eager oplog push must NOT be awaited or the confirm
  // flow perceives the /api/sync/ops round-trip as latency. Fire it in the
  // background: flushPending keeps the pending row on any transient failure and
  // it is retried on the next pullOnOpen/write, so nothing is lost. The .catch
  // only guards an unhandled rejection if flushPendingUnlocked *throws*
  // (crypto/IndexedDB) — a thrown flush also leaves 'pending' intact — mirroring
  // the flushChain swallow inside flushPending itself.
  if (flush) flushPending(ctx).catch(() => {});
  notifyRecordsChanged([recordType], origin);
  return stamped;
}

// Storage port handed to web/domain/'s createXDomain() factories: the generic
// list/listRange/put/del quartet, closed over ctx so domain code stays free of
// sync internals (crypto, seq prediction, IndexedDB). del writes a tombstone via
// writeRecord — same convergence semantics (LWW on clientTs) as every other
// write.
// `origin` is bound per port, not per call: the domain modules are pure and must
// stay ignorant of who is calling them. A port is therefore created once per
// writer (the UI's router, the voice/MCP router, the inbox applier), which is
// also why the background materialization sweep runs on the external port — it
// is a timer, not a user action, and its due doses must repaint Today.
// `deferFlush` makes put/del queue to 'pending' WITHOUT an inline oplog push —
// only the inbox drain uses it (the drain flushes once, chunked, after each
// event via flushConfirmed), so a bulk .nxk import stops emitting one POST per
// record (med-0ol.2). Every other writer keeps the eager per-write push.
export function recordsPort(ctx, origin = ORIGIN_EXTERNAL, { deferFlush = false } = {}) {
  const flush = !deferFlush;
  return {
    list: (recordType) => listRecords(ctx, recordType),
    listRange: (recordType, fromId, toId) => listRecordsInRange(ctx, recordType, fromId, toId),
    put: (recordType, record) => writeRecord(ctx, recordType, record, origin, { flush }),
    del: (recordType, recordId) => writeRecord(ctx, recordType, { recordId, clientTs: Date.now(), deleted: true }, origin, { flush }),
  };
}

// --- NK (push notification key) provisioning (Task 6, docs/cloud-crypto.md
// "The push key (NK)") -------------------------------------------------

// True once this device holds a plaintext NK copy (SW-reachable IndexedDB) —
// i.e. "rich notifications" mode is on for this device.
export async function hasRichNotifications() {
  return (await readDeviceValue('nk')) !== null;
}

// Deletes only this device's plaintext NK copy — the vault record (and other
// devices' copies) are untouched, matching the spec's per-device toggle.
export async function disableRichNotifications() {
  await deleteDeviceValue('nk');
}

// Returns this device's NK, provisioning one if the account doesn't have one
// yet: check the local plaintext cache, then the synced vault record (another
// device may already have created it), and only generate+upload a new one if
// neither exists.
export async function getOrCreateNK(ctx) {
  const cached = await readDeviceValue('nk');
  if (cached) return cached;
  await pullOnOpen(ctx);
  const existing = await getRecord(NK_RECORD_ID);
  if (existing && existing.recordType === NK_RECORD_TYPE && !existing.deleted) {
    const nk = fromBase64(existing.nk);
    await writeDeviceValue('nk', nk);
    return nk;
  }
  const nk = crypto.getRandomValues(new Uint8Array(32));
  await writeRecord(ctx, NK_RECORD_TYPE, { recordId: NK_RECORD_ID, clientTs: Date.now(), nk: toBase64(nk), deleted: false });
  // A peer device may have created a *different* NK concurrently. writeRecord's
  // flush re-pulls the tail on a seq collision, so the vault record now holds
  // the LWW-converged NK — adopt that, not our just-generated one, or this
  // device would cache an orphan key and its push payloads would decrypt
  // nowhere but here. ponytail: exactly-equal clientTs across two devices
  // (strict-`>` LWW tie) leaves a residual divergence window; rare enough to
  // accept for the C0 toy path, where rich-notification decrypt failures
  // degrade gracefully to a generic notification.
  const converged = await getRecord(NK_RECORD_ID);
  const finalNk = converged && converged.recordType === NK_RECORD_TYPE && !converged.deleted ? fromBase64(converged.nk) : nk;
  await writeDeviceValue('nk', finalNk);
  return finalNk;
}

// Sync-status indicator (Task 3): derived entirely from local sync-engine
// state, no dedicated status API.
export async function getSyncStatus(ctx) {
  await bootstrapIfNeeded(ctx);
  const meta = await readMeta();
  const pendingCount = (await readPending()).length;
  return {
    lastSyncedAt: meta.lastSyncedAt,
    pendingCount,
    offline,
    authExpired,
    integrityErrors: meta.integrityErrors,
    snapshotError: meta.snapshotError || null,
    writeError: meta.writeError || null,
    clockSkewMs: meta.clockSkewMs || 0,
    wedged: meta.syncWedged,
  };
}

export async function describeSyncStatus(ctx) {
  const status = await getSyncStatus(ctx);
  const parts = [];
  // auth-expired leads: an expired session is the actionable root cause, and
  // "Offline" for it is exactly the red herring this state exists to replace.
  parts.push(status.authExpired ? 'Session expired — re-authenticate' : status.offline ? 'Offline' : status.lastSyncedAt ? `Synced ${new Date(status.lastSyncedAt).toLocaleTimeString()}` : 'Not yet synced');
  if (status.pendingCount > 0) parts.push(`${status.pendingCount} pending`);
  if (status.integrityErrors > 0) parts.push(`${status.integrityErrors} sync-integrity warning(s)`);
  // 413 is the quota; any other permanent 4xx is a refusal we can't name, so
  // say the honest general thing rather than guessing "full".
  if (status.writeError) {
    parts.push(status.writeError.status === 413 ? 'Vault is full — new entries are not syncing' : 'Server refused this device\'s writes');
  }
  if (status.snapshotError) parts.push('Vault too large to sync');
  if (status.wedged) parts.push('Sync paused after repeated failures — reset local sync to recover');
  // A skewed clock silently reorders edits across devices. Say so: the merge
  // guards below keep the common case correct, but the user should fix the clock.
  if (Math.abs(status.clockSkewMs) > CLOCK_SKEW_WARN_MS) {
    const minutes = Math.round(Math.abs(status.clockSkewMs) / 60000);
    parts.push(`This device's clock is ${minutes} min ${status.clockSkewMs > 0 ? 'fast' : 'slow'} — fix it to avoid losing edits`);
  }
  return parts.join(' · ');
}
