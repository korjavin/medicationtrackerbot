// Client sync engine: docs/cloud-mode.md "Sync protocol" + docs/cloud-crypto.md
// "Oplog record / snapshot". Pull-on-open + push-on-write against
// /api/sync/ops and /api/sync/snapshot, with a local IndexedDB mirror (via
// localdb.js) so the unlocked shell has something to render offline. Records
// are { recordId, clientTs, deleted, ...body }, merged by last-write-wins on
// clientTs; recordsPort() below exposes the generic list/put/del trio that
// web/domain/'s domain modules are built on.
import { deriveKData, encryptRecord, decryptRecord, encryptSnapshot, decryptSnapshot, toBase64, fromBase64 } from './crypto.js';
import { openDb } from './localdb.js';

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

async function withStore(storeName, mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const result = fn(store);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readMeta() {
  const db = await openDb();
  try {
    const tx = db.transaction('sync_meta', 'readonly');
    const store = tx.objectStore('sync_meta');
    const [localLastSeq, lastSnapshotSeq, lastSyncedAt, integrityErrors] = await Promise.all([
      reqToPromise(store.get('localLastSeq')),
      reqToPromise(store.get('lastSnapshotSeq')),
      reqToPromise(store.get('lastSyncedAt')),
      reqToPromise(store.get('integrityErrors')),
    ]);
    return {
      localLastSeq: localLastSeq ?? null,
      lastSnapshotSeq: lastSnapshotSeq ?? 0,
      lastSyncedAt: lastSyncedAt ?? null,
      integrityErrors: integrityErrors ?? 0,
    };
  } finally {
    db.close();
  }
}

async function writeMeta(patch) {
  await withStore('sync_meta', 'readwrite', (store) => {
    for (const [key, value] of Object.entries(patch)) store.put(value, key);
  });
}

async function getRecord(recordId) {
  return withStore('records', 'readonly', (store) => reqToPromise(store.get(recordId))).then((r) => r ?? null);
}

async function putRecord(record) {
  await withStore('records', 'readwrite', (store) => store.put(record));
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

// --- remote sync ---------------------------------------------------------

async function applyIncoming(recordType, record) {
  const existing = await getRecord(record.recordId);
  if (!existing || record.clientTs > existing.clientTs) {
    await putRecord({ ...record, recordType });
  }
}

async function bootstrap(ctx) {
  const kData = await getKData(ctx);
  let snapRes;
  try {
    snapRes = await fetch('/api/sync/snapshot');
  } catch {
    offline = true;
    return; // leave localLastSeq null so bootstrapIfNeeded retries next open
  }
  // 204 = fresh account with no snapshot (a legit cursor-0 bootstrap); anything
  // other than 200/204 (5xx behind a proxy, transient error) must NOT poison
  // the cursor to 0 — a device that then pulled ?since=0 after a later
  // compaction would silently skip all snapshotted state. Stay null → retry.
  if (snapRes.status !== 200 && snapRes.status !== 204) {
    offline = true;
    return;
  }
  offline = false;
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
      const records = JSON.parse(new TextDecoder().decode(plaintext));
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
}

async function bootstrapIfNeeded(ctx) {
  const meta = await readMeta();
  if (meta.localLastSeq === null) await bootstrap(ctx);
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
      res = await fetch(`/api/sync/ops?since=${meta.localLastSeq}&limit=${OPS_PAGE_LIMIT}`);
    } catch {
      offline = true;
      return;
    }
    if (!res.ok) {
      offline = true;
      return;
    }
    offline = false;
    const body = await res.json();
    // The server compacted past our cursor (another device snapshotted while we
    // were away): ops between our cursor and body.snapshot_seq no longer exist,
    // so an incremental tail would silently skip them. Re-bootstrap from the
    // snapshot, then resume the tail above it.
    if (typeof body.snapshot_seq === 'number' && body.snapshot_seq > meta.localLastSeq) {
      await bootstrap(ctx);
      if (offline) return; // bootstrap failed transiently — retry next open
      continue;
    }
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
        await applyIncoming(recordType, JSON.parse(new TextDecoder().decode(plaintext)));
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
    if (!body.next) break;
  }
}

// snapshotAt encrypts the whole local record store and POSTs it as the
// compaction floor at `snapshotSeq`. Shared by the threshold-gated
// maybeSnapshot and the C2e forced snapshot after a full-vault import.
async function snapshotAt(ctx, snapshotSeq) {
  const kData = await getKData(ctx);
  const records = await readAllRecords();
  const plaintext = new TextEncoder().encode(JSON.stringify(records));
  const { nonce, ct } = await encryptSnapshot({ kData, accountId: ctx.accountId, snapshotSeq, plaintext });
  let res;
  try {
    res = await fetch('/api/sync/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot_seq: snapshotSeq, nonce: toBase64(nonce), ct: toBase64(ct) }),
    });
  } catch {
    offline = true;
    return;
  }
  if (res.ok) {
    offline = false;
    await writeMeta({ lastSnapshotSeq: snapshotSeq });
  }
}

async function maybeSnapshot(ctx) {
  const meta = await readMeta();
  if (meta.localLastSeq === null || meta.localLastSeq - meta.lastSnapshotSeq < SNAPSHOT_THRESHOLD) return;
  await snapshotAt(ctx, meta.localLastSeq);
}

// forceSnapshot uploads one snapshot at the current cursor regardless of the
// threshold — the C2e full-vault import lands its whole record set via
// replaceAllRecords (not the oplog), so a snapshot at snapshot_seq =
// localLastSeq is the only thing that propagates it: other devices whose
// cursor falls below it re-bootstrap from the snapshot (the designed recovery
// flow, no new server behavior). No-op if the device never bootstrapped.
export async function forceSnapshot(ctx) {
  const meta = await readMeta();
  if (meta.localLastSeq === null) return;
  await snapshotAt(ctx, meta.localLastSeq);
}

// readAllLiveRecords returns every non-tombstoned record (with its recordType)
// — the flat input recordsToVault regroups for a full-vault export. Bootstraps
// first so a just-unlocked device exports the synced set, not an empty store.
export async function readAllLiveRecords(ctx) {
  await bootstrapIfNeeded(ctx);
  return (await readAllRecords()).filter((r) => !r.deleted);
}

// Max re-post attempts when a concurrent writer keeps interleaving (below).
const FLUSH_MAX_ATTEMPTS = 5;

async function flushPending(ctx) {
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
  for (let attempt = 0; attempt < FLUSH_MAX_ATTEMPTS; attempt++) {
    const pending = await readPending();
    if (pending.length === 0) return;
    const meta = await readMeta();
    // Not bootstrapped yet (bootstrap failed transiently): localLastSeq is null,
    // so `seq += 1` would predict seqs from 1 and AAD-bind every op to the wrong
    // seq. Keep the writes safely in 'pending' until a real bootstrap sets the
    // cursor.
    if (meta.localLastSeq === null) return;
    let seq = meta.localLastSeq;
    const ops = [];
    const includedIds = [];
    for (const { recordId, recordType } of pending) {
      const record = await getRecord(recordId);
      if (!record) continue;
      seq += 1;
      // recordType is already carried by the wire tag (parseTag) — omit it from
      // the encrypted body so the local-only bookkeeping field never round-trips.
      const { recordType: _recordType, ...wireBody } = record;
      const plaintext = new TextEncoder().encode(JSON.stringify(wireBody));
      const { nonce, ct } = await encryptRecord({
        kData,
        accountId: ctx.accountId,
        recordType,
        recordId,
        seq,
        plaintext,
      });
      ops.push({ record_type_tag: makeTag(recordType, recordId), nonce: toBase64(nonce), ct: toBase64(ct) });
      includedIds.push(recordId);
    }
    if (ops.length === 0) return;
    let res;
    try {
      res = await fetch('/api/sync/ops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ops }),
      });
    } catch {
      offline = true;
      return; // left in 'pending' — retried on the next pullOnOpen/write
    }
    if (!res.ok) {
      offline = true;
      return;
    }
    offline = false;
    const { assigned } = await res.json();
    await writeMeta({ lastSyncedAt: Date.now() });
    if (assigned[0] === meta.localLastSeq + 1) {
      // Assigned contiguously from our cursor — predicted seqs equal assigned
      // seqs, so every op's AAD is correct and other devices can decrypt them.
      // We already hold these records locally, so just clear and advance.
      await clearPending(includedIds);
      await writeMeta({ localLastSeq: Math.max(...assigned) });
      await maybeSnapshot(ctx);
      return;
    }
    // Mis-predicted: a concurrent device interleaved. Re-pull to advance past
    // the peer ops (and our own now-dead ops — pullTail skips those unreadable
    // rows; our optimistic local copies survive since 'pending' is kept),
    // then loop to re-post these records under fresh seqs.
    await pullTail(ctx);
    if (offline) return; // couldn't advance — retry next open
  }
}

// --- public API ------------------------------------------------------------

// Pull-on-open: bootstrap (snapshot + tail) on first run, incremental tail
// pull otherwise, then retry any writes a previous session couldn't push.
export async function pullOnOpen(ctx) {
  await bootstrapIfNeeded(ctx);
  await pullTail(ctx);
  await flushPending(ctx);
  await maybeSnapshot(ctx);
}

// Generic record-store read: live (non-tombstoned) records of a type from the
// local mirror, newest-first by clientTs. Backs recordsPort() below
// (web/domain/'s storage port).
export async function listRecords(ctx, recordType) {
  await bootstrapIfNeeded(ctx);
  const records = await readAllRecords();
  return records
    .filter((r) => r.recordType === recordType && !r.deleted)
    .sort((a, b) => b.clientTs - a.clientTs);
}

export async function writeRecord(ctx, recordType, record) {
  await bootstrapIfNeeded(ctx);
  // Atomic w.r.t. replaceAllRecords' clear (see withRecordsLock): the record
  // and its 'pending' row must both be visible, or neither, when a concurrent
  // bootstrap snapshots what to preserve.
  await withRecordsLock(async () => {
    await putRecord({ ...record, recordType });
    await markPending(record.recordId, recordType);
  });
  await flushPending(ctx);
  return record;
}

// Storage port handed to web/domain/'s createXDomain() factories: the generic
// list/put/del trio, closed over ctx so domain code stays free of sync
// internals (crypto, seq prediction, IndexedDB). del writes a tombstone via
// writeRecord — same convergence semantics (LWW on clientTs) as every other
// write.
export function recordsPort(ctx) {
  return {
    list: (recordType) => listRecords(ctx, recordType),
    put: (recordType, record) => writeRecord(ctx, recordType, record),
    del: (recordType, recordId) => writeRecord(ctx, recordType, { recordId, clientTs: Date.now(), deleted: true }),
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
    integrityErrors: meta.integrityErrors,
  };
}

export async function describeSyncStatus(ctx) {
  const status = await getSyncStatus(ctx);
  const parts = [];
  parts.push(status.offline ? 'Offline' : status.lastSyncedAt ? `Synced ${new Date(status.lastSyncedAt).toLocaleTimeString()}` : 'Not yet synced');
  if (status.pendingCount > 0) parts.push(`${status.pendingCount} pending`);
  if (status.integrityErrors > 0) parts.push(`${status.integrityErrors} sync-integrity warning(s)`);
  return parts.join(' · ');
}
