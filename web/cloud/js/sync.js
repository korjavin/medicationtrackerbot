// Client sync engine: docs/cloud-mode.md "Sync protocol" + docs/cloud-crypto.md
// "Oplog record / snapshot". Pull-on-open + push-on-write against
// /api/sync/ops and /api/sync/snapshot, with a local IndexedDB mirror (via
// localdb.js) so the unlocked shell has something to render offline. The
// "toy record type" proving the mechanism is an encrypted note: { recordId,
// clientTs, text, deleted }, merged by last-write-wins on clientTs.
import { deriveKData, encryptRecord, decryptRecord, encryptSnapshot, decryptSnapshot, toBase64, fromBase64 } from './crypto.js';
import { openDb } from './localdb.js';

const NOTE_RECORD_TYPE = 'note';
const OPS_PAGE_LIMIT = 200;
// docs/plans/2026-07-03-cloud-c0c-sync-push-relay.md Task 3: snapshot once the
// un-compacted oplog tail passes this many ops.
const SNAPSHOT_THRESHOLD = 500;

// record_type_tag is the only wire field the server stores unencrypted
// alongside the ciphertext (opWire.RecordTypeTag) — packing "<type>:<recordId>"
// into it lets the reading client recover record_id for the AAD binding
// without a schema change, and costs nothing: record_id was never
// confidential (docs/cloud-crypto.md AAD only binds already-visible metadata).
function noteTag(recordId) {
  return `${NOTE_RECORD_TYPE}:${recordId}`;
}
function parseTag(tag) {
  const idx = tag.indexOf(':');
  return { recordType: tag.slice(0, idx), recordId: tag.slice(idx + 1) };
}

let offline = false;
const kDataCache = new WeakMap();

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

async function replaceAllRecords(records) {
  await withStore('records', 'readwrite', (store) => {
    store.clear();
    for (const record of records) store.put(record);
  });
}

async function markPending(recordId) {
  await withStore('pending', 'readwrite', (store) => store.put({ recordId }));
}

async function readPendingIds() {
  const rows = await withStore('pending', 'readonly', (store) => reqToPromise(store.getAll()));
  return rows.map((r) => r.recordId);
}

async function clearPending(recordIds) {
  await withStore('pending', 'readwrite', (store) => {
    for (const id of recordIds) store.delete(id);
  });
}

// --- remote sync ---------------------------------------------------------

async function applyIncoming(record) {
  const existing = await getRecord(record.recordId);
  if (!existing || record.clientTs > existing.clientTs) {
    await putRecord(record);
  }
}

async function bootstrap(ctx) {
  const kData = await getKData(ctx);
  let snapRes;
  try {
    snapRes = await fetch('/api/sync/snapshot');
  } catch {
    offline = true;
    await writeMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
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
      await writeMeta({ integrityErrors: (await readMeta()).integrityErrors + 1 });
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
        await applyIncoming(JSON.parse(new TextDecoder().decode(plaintext)));
      } catch {
        // Tampered ciphertext or a seq the server assigned to a different op
        // than this client predicted (concurrent-writer race) — the record
        // is unreadable; surface it via the sync-status counter rather than
        // silently dropping it or wedging the pull loop.
        await writeMeta({ integrityErrors: (await readMeta()).integrityErrors + 1 });
      }
      await writeMeta({ localLastSeq: op.seq });
    }
    await writeMeta({ lastSyncedAt: Date.now() });
    if (!body.next) break;
  }
}

async function maybeSnapshot(ctx) {
  const meta = await readMeta();
  if (meta.localLastSeq === null || meta.localLastSeq - meta.lastSnapshotSeq < SNAPSHOT_THRESHOLD) return;
  const kData = await getKData(ctx);
  const records = await readAllRecords();
  const plaintext = new TextEncoder().encode(JSON.stringify(records));
  const { nonce, ct } = await encryptSnapshot({ kData, accountId: ctx.accountId, snapshotSeq: meta.localLastSeq, plaintext });
  let res;
  try {
    res = await fetch('/api/sync/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot_seq: meta.localLastSeq, nonce: toBase64(nonce), ct: toBase64(ct) }),
    });
  } catch {
    offline = true;
    return;
  }
  if (res.ok) {
    offline = false;
    await writeMeta({ lastSnapshotSeq: meta.localLastSeq });
  }
}

async function flushPending(ctx) {
  const pendingIds = await readPendingIds();
  if (pendingIds.length === 0) return;
  const kData = await getKData(ctx);
  const meta = await readMeta();
  let seq = meta.localLastSeq;
  const ops = [];
  const includedIds = [];
  for (const recordId of pendingIds) {
    const record = await getRecord(recordId);
    if (!record) continue;
    seq += 1;
    const plaintext = new TextEncoder().encode(JSON.stringify(record));
    const { nonce, ct } = await encryptRecord({
      kData,
      accountId: ctx.accountId,
      recordType: NOTE_RECORD_TYPE,
      recordId,
      seq,
      plaintext,
    });
    ops.push({ record_type_tag: noteTag(recordId), nonce: toBase64(nonce), ct: toBase64(ct) });
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
  await writeMeta({ localLastSeq: Math.max(meta.localLastSeq, ...assigned), lastSyncedAt: Date.now() });
  await clearPending(includedIds);
  await maybeSnapshot(ctx);
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

export async function listNotes(ctx) {
  await bootstrapIfNeeded(ctx);
  const records = await readAllRecords();
  return records.filter((r) => !r.deleted).sort((a, b) => b.clientTs - a.clientTs);
}

async function writeNote(ctx, record) {
  await bootstrapIfNeeded(ctx);
  await putRecord(record);
  await markPending(record.recordId);
  await flushPending(ctx);
  return record;
}

export async function createNote(ctx, text) {
  return writeNote(ctx, { recordId: crypto.randomUUID(), clientTs: Date.now(), text, deleted: false });
}

export async function updateNote(ctx, recordId, text) {
  return writeNote(ctx, { recordId, clientTs: Date.now(), text, deleted: false });
}

export async function deleteNote(ctx, recordId) {
  return writeNote(ctx, { recordId, clientTs: Date.now(), text: '', deleted: true });
}

// Sync-status indicator (Task 3): derived entirely from local sync-engine
// state, no dedicated status API.
export async function getSyncStatus(ctx) {
  await bootstrapIfNeeded(ctx);
  const meta = await readMeta();
  const pendingCount = (await readPendingIds()).length;
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
