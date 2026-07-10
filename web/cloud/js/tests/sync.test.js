import 'fake-indexeddb/auto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { deriveKData, encryptRecord, decryptRecord, encryptSnapshot, decryptSnapshot, generateDEK, toBase64 } from '../crypto.js';
import { listRecords, listRecordsInRange, readAllLiveRecords, pullOnOpen, writeRecord, describeSyncStatus, getSyncStatus } from '../sync.js';
import { openDb } from '../localdb.js';

const accountId = 'amber-falcon-8k3q9x';

describe('sync record/snapshot AAD binding (docs/cloud-crypto.md "Oplog record / snapshot")', () => {
  it('round-trips a record through encrypt -> "server assigns seq" -> decrypt', async () => {
    const kData = await deriveKData(generateDEK());
    const plaintext = new TextEncoder().encode(JSON.stringify({ recordId: 'note-1', clientTs: 1, text: 'hello', deleted: false }));

    // Client predicts seq before the server assigns one (docs' "Seq assignment
    // vs AAD" note) — here the prediction happens to be correct.
    const { nonce, ct } = await encryptRecord({ kData, accountId, recordType: 'note', recordId: 'note-1', seq: 7, plaintext });
    const assignedSeq = 7;
    const recovered = await decryptRecord({ kData, accountId, recordType: 'note', recordId: 'note-1', seq: assignedSeq, nonce, ct });
    expect(new TextDecoder().decode(recovered)).toBe(new TextDecoder().decode(plaintext));
  });

  it('throws when the server-claimed seq differs from the one encrypted under (reorder/replay detection)', async () => {
    const kData = await deriveKData(generateDEK());
    const plaintext = new TextEncoder().encode('secret note');
    const { nonce, ct } = await encryptRecord({ kData, accountId, recordType: 'note', recordId: 'note-1', seq: 7, plaintext });
    await expect(
      decryptRecord({ kData, accountId, recordType: 'note', recordId: 'note-1', seq: 8, nonce, ct })
    ).rejects.toThrow();
  });

  it('throws when the record_type/record_id used at decrypt differ from encryption (tampered tag)', async () => {
    const kData = await deriveKData(generateDEK());
    const plaintext = new TextEncoder().encode('secret note');
    const { nonce, ct } = await encryptRecord({ kData, accountId, recordType: 'note', recordId: 'note-1', seq: 7, plaintext });
    await expect(
      decryptRecord({ kData, accountId, recordType: 'note', recordId: 'note-2', seq: 7, nonce, ct })
    ).rejects.toThrow();
  });

  it('round-trips a snapshot through encrypt -> decrypt', async () => {
    const kData = await deriveKData(generateDEK());
    const records = [{ recordId: 'note-1', clientTs: 1, text: 'hello', deleted: false }];
    const plaintext = new TextEncoder().encode(JSON.stringify(records));
    const { nonce, ct } = await encryptSnapshot({ kData, accountId, snapshotSeq: 500, plaintext });
    const recovered = await decryptSnapshot({ kData, accountId, snapshotSeq: 500, nonce, ct });
    expect(JSON.parse(new TextDecoder().decode(recovered))).toEqual(records);
  });

  it('throws when the snapshot_seq used at decrypt differs from encryption', async () => {
    const kData = await deriveKData(generateDEK());
    const plaintext = new TextEncoder().encode('[]');
    const { nonce, ct } = await encryptSnapshot({ kData, accountId, snapshotSeq: 500, plaintext });
    await expect(decryptSnapshot({ kData, accountId, snapshotSeq: 501, nonce, ct })).rejects.toThrow();
  });
});

// med-9z3.4 — listRecords must read through the 'recordType' index. A full-store
// getAll() structured-clones every record of every domain; on a real vault the
// vitals samples alone make that hundreds of MiB per call, so a bp read paid for
// the heart-rate history. ctx is unused by the read path (bootstrapIfNeeded only
// consults sync_meta), so {} suffices once the cursor is seeded.
describe('listRecords reads via the recordType index (med-9z3.4)', () => {
  const seed = async (records, meta = { localLastSeq: 5 }) => {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['records', 'sync_meta'], 'readwrite');
        const store = tx.objectStore('records');
        for (const r of records) store.put(r);
        const metaStore = tx.objectStore('sync_meta');
        for (const [k, v] of Object.entries(meta)) metaStore.put(v, k);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  };

  beforeEach(async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('medtracker-cloud');
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
  });

  it('returns only the requested type, newest-first, skipping tombstones', async () => {
    await seed([
      { recordId: 'bp-1', recordType: 'bp', clientTs: 100, deleted: false, systolic: 120 },
      { recordId: 'bp-2', recordType: 'bp', clientTs: 300, deleted: false, systolic: 130 },
      { recordId: 'bp-3', recordType: 'bp', clientTs: 200, deleted: true },
      { recordId: 'hr-1', recordType: 'hrsample', clientTs: 400, deleted: false, samples: [1, 2, 3] },
    ]);
    const bp = await listRecords({}, 'bp');
    expect(bp.map((r) => r.recordId)).toEqual(['bp-2', 'bp-1']);
  });

  it('never full-scans the records store — the fat other-type records are not cloned', async () => {
    await seed([
      { recordId: 'bp-1', recordType: 'bp', clientTs: 100, deleted: false, systolic: 120 },
      { recordId: 'hr-1', recordType: 'hrsample', clientTs: 400, deleted: false, samples: [1, 2, 3] },
    ]);
    const storeGetAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const indexGetAll = vi.spyOn(IDBIndex.prototype, 'getAll');

    const bp = await listRecords({}, 'bp');

    expect(bp).toHaveLength(1);
    expect(indexGetAll).toHaveBeenCalledWith('bp');
    expect(storeGetAll).not.toHaveBeenCalled();
  });

  it('readAllLiveRecords keeps full-store semantics (snapshotAt must see every type)', async () => {
    await seed([
      { recordId: 'bp-1', recordType: 'bp', clientTs: 100, deleted: false },
      { recordId: 'hr-1', recordType: 'hrsample', clientTs: 400, deleted: false },
      { recordId: 'note-1', recordType: 'note', clientTs: 50, deleted: true },
    ]);
    const all = await readAllLiveRecords({});
    expect(all.map((r) => r.recordId).sort()).toEqual(['bp-1', 'hr-1']);
  });

  // med-9z3.3 — the vitals day-batch recordIds ('hrsample-2026-07-08') are
  // lexicographically chronological, so a 30d window is a primary-key range. No
  // index needed; the store's keyPath IS recordId.
  it('listRecordsInRange returns only the requested type inside an inclusive key range', async () => {
    await seed([
      { recordId: 'hrsample-2026-06-30', recordType: 'hrsample', clientTs: 1, deleted: false },
      { recordId: 'hrsample-2026-07-01', recordType: 'hrsample', clientTs: 2, deleted: false },
      { recordId: 'hrsample-2026-07-05', recordType: 'hrsample', clientTs: 3, deleted: false },
      { recordId: 'hrsample-2026-07-06', recordType: 'hrsample', clientTs: 4, deleted: true },
      { recordId: 'hrsample-2026-07-09', recordType: 'hrsample', clientTs: 5, deleted: false },
    ]);
    const got = await listRecordsInRange({}, 'hrsample', 'hrsample-2026-07-01', 'hrsample-2026-07-06');
    // Bounds inclusive; 06-30 and 07-09 fall outside; the 07-06 tombstone is dropped.
    expect(got.map((r) => r.recordId)).toEqual(['hrsample-2026-07-05', 'hrsample-2026-07-01']);
  });

  it('listRecordsInRange never reads a whole day-batch stream (that is the point)', async () => {
    const days = Array.from({ length: 400 }, (_, i) => {
      const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
      return { recordId: `hrsample-${d}`, recordType: 'hrsample', clientTs: i, deleted: false };
    });
    await seed(days);
    const got = await listRecordsInRange({}, 'hrsample', 'hrsample-2025-03-01', 'hrsample-2025-03-30');
    expect(got).toHaveLength(30);
  });

  it('a key range that spans into another type still returns only the requested type', async () => {
    // 'intake-...' sorts after 'hrsample-...', but a caller passing a sloppy
    // upper bound must not get foreign records back.
    await seed([
      { recordId: 'hrsample-2026-07-01', recordType: 'hrsample', clientTs: 1, deleted: false },
      { recordId: 'intake-1-1751000000', recordType: 'intake', clientTs: 2, deleted: false },
    ]);
    const got = await listRecordsInRange({}, 'hrsample', 'hrsample-2026-07-01', 'zzz');
    expect(got.map((r) => r.recordId)).toEqual(['hrsample-2026-07-01']);
  });

  it('upgrading a v2 database backfills the index from existing rows (no data migration)', async () => {
    // Open at the OLD version/schema — no recordType index — and write a row the
    // way v2 did. The v3 upgrade must make it findable through the index.
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('medtracker-cloud', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('device');
        db.createObjectStore('records', { keyPath: 'recordId' });
        db.createObjectStore('pending', { keyPath: 'recordId' });
        db.createObjectStore('sync_meta');
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['records', 'sync_meta'], 'readwrite');
        tx.objectStore('records').put({ recordId: 'bp-old', recordType: 'bp', clientTs: 1, deleted: false });
        tx.objectStore('sync_meta').put(5, 'localLastSeq');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });

    const bp = await listRecords({}, 'bp'); // openDb() triggers the v2 -> v3 upgrade
    expect(bp.map((r) => r.recordId)).toEqual(['bp-old']);
  });
});

// med-9z3.5 — a permanent 4xx on the threshold-gated snapshot means compaction
// has STOPPED: the oplog grows without bound and every new device pages the
// whole thing on first sync. It used to be discarded silently. Drive the real
// pullOnOpen path (maybeSnapshot is private, and going through the public entry
// point is what actually regressed).
describe('maybeSnapshot surfaces a permanent snapshot failure instead of failing silently (med-9z3.5)', () => {
  const SNAPSHOT_THRESHOLD = 500;
  let ctx;
  let snapshotPosts;
  let snapshotStatus;

  const seedMeta = async (meta) => {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('sync_meta', 'readwrite');
        const store = tx.objectStore('sync_meta');
        for (const [k, v] of Object.entries(meta)) store.put(v, k);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  };

  const readMetaKey = async (key) => {
    const db = await openDb();
    try {
      const tx = db.transaction('sync_meta', 'readonly');
      return await new Promise((resolve, reject) => {
        const req = tx.objectStore('sync_meta').get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  };

  beforeEach(async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('medtracker-cloud');
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
    ctx = { accountId, dek: await generateDEK() };
    snapshotPosts = 0;
    snapshotStatus = 413; // account storage quota exceeded — permanent

    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).startsWith('/api/sync/ops')) {
        return new Response(JSON.stringify({ ops: [], next: false }), { status: 200 });
      }
      if (String(url) === '/api/sync/snapshot') {
        snapshotPosts++;
        if (snapshotStatus === 200) return new Response('{}', { status: 200 });
        return new Response('account storage quota exceeded', { status: snapshotStatus });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));
  });

  it('records a durable error and surfaces it in the status line on a permanent 4xx', async () => {
    await seedMeta({ localLastSeq: SNAPSHOT_THRESHOLD, lastSnapshotSeq: 0 });

    await pullOnOpen(ctx);

    expect(snapshotPosts).toBe(1);
    const status = await getSyncStatus(ctx);
    expect(status.snapshotError).toMatchObject({ status: 413 });
    expect(await describeSyncStatus(ctx)).toContain('Vault too large to sync');
    // The compaction floor did NOT advance — the snapshot never landed.
    expect(await readMetaKey('lastSnapshotSeq')).toBeFalsy();
    expect(await readMetaKey('snapshotErrorSeq')).toBe(SNAPSHOT_THRESHOLD);
  });

  it('backs off: does not re-upload the oversized snapshot on every later flush', async () => {
    await seedMeta({ localLastSeq: SNAPSHOT_THRESHOLD, lastSnapshotSeq: 0 });
    await pullOnOpen(ctx);
    expect(snapshotPosts).toBe(1);

    // A few more ops land, still short of another full threshold past the failure.
    await seedMeta({ localLastSeq: SNAPSHOT_THRESHOLD + 10 });
    await pullOnOpen(ctx);
    expect(snapshotPosts).toBe(1); // no re-gzip + re-encrypt of the whole vault
  });

  it('retries once the oplog grows another threshold past the failed attempt, and heals on success', async () => {
    await seedMeta({ localLastSeq: SNAPSHOT_THRESHOLD, lastSnapshotSeq: 0 });
    await pullOnOpen(ctx);
    expect(snapshotPosts).toBe(1);

    // Cap raised / vault shrank: the retry lands.
    snapshotStatus = 200;
    await seedMeta({ localLastSeq: SNAPSHOT_THRESHOLD * 2 });
    await pullOnOpen(ctx);

    expect(snapshotPosts).toBe(2);
    expect(await readMetaKey('lastSnapshotSeq')).toBe(SNAPSHOT_THRESHOLD * 2);
    expect(await readMetaKey('snapshotError')).toBeNull();
    expect(await readMetaKey('snapshotErrorSeq')).toBeNull();
    expect(await describeSyncStatus(ctx)).not.toContain('Vault too large to sync');
  });

  it('leaves a transient 5xx unrecorded so the next flush retries immediately', async () => {
    snapshotStatus = 503;
    await seedMeta({ localLastSeq: SNAPSHOT_THRESHOLD, lastSnapshotSeq: 0 });

    await pullOnOpen(ctx);
    expect(snapshotPosts).toBe(1);
    expect(await readMetaKey('snapshotError')).toBeNull();
    expect(await readMetaKey('snapshotErrorSeq')).toBeNull();

    await pullOnOpen(ctx); // no backoff floor was set — retried at once
    expect(snapshotPosts).toBe(2);
  });
});

// med-d5t.10 — the voice agent, the Claude connector, the sealed Telegram inbox
// drain and incoming sync pulls all write through writeRecord/applyIncoming and
// none of them repainted the screen. These assert the notification at both choke
// points, and that a UI write (already repainting via applyOptimistic) does not
// paint twice.
describe('non-UI writes repaint the open tab (med-d5t.10)', () => {
  let ctx;
  let ds;

  const stubDataStore = (overrides = {}) => {
    ds = {
      invalidateTags: vi.fn(async () => {}),
      requestTabRefresh: vi.fn(),
      hasAnyPendingOptimistic: vi.fn(() => false),
      ...overrides,
    };
    vi.stubGlobal('window', { DataStore: ds });
    return ds;
  };

  // Fresh account: 204 snapshot (cursor-0 bootstrap), empty tail, ops POST
  // assigns contiguously from our cursor. `pulledOps` seeds the tail.
  const stubSync = (pulledOps = []) => {
    let assignNext = 1;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url);
      if (u === '/api/sync/snapshot' && !init) return new Response(null, { status: 204 });
      if (u.startsWith('/api/sync/ops?')) {
        const ops = pulledOps.splice(0, pulledOps.length);
        return new Response(JSON.stringify({ ops, next: false }), { status: 200 });
      }
      if (u === '/api/sync/ops' && init?.method === 'POST') {
        const { ops } = JSON.parse(init.body);
        const assigned = ops.map(() => assignNext++);
        return new Response(JSON.stringify({ assigned }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u} ${init?.method || 'GET'}`);
    }));
  };

  beforeEach(async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('medtracker-cloud');
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
    ctx = { accountId, dek: await generateDEK() };
  });

  it('a food log written outside the UI (voice agent / MCP relay) invalidates and repaints', async () => {
    stubDataStore();
    stubSync();

    await writeRecord(ctx, 'foodlog', { recordId: 'foodlog-1', clientTs: 1, deleted: false, name: 'oats' });

    expect(ds.invalidateTags).toHaveBeenCalledWith(['food']);
    expect(ds.requestTabRefresh).toHaveBeenCalledWith(['food'], 'cloud-write');
  });

  it('a Telegram-drained /bp repaints the BP screen', async () => {
    stubDataStore();
    stubSync();

    await writeRecord(ctx, 'bp', { recordId: 'bp-1', clientTs: 1, deleted: false, systolic: 120, diastolic: 80 });

    expect(ds.requestTabRefresh).toHaveBeenCalledWith(['bp'], 'cloud-write');
  });

  it('does not repaint over the UI\'s own optimistic write', async () => {
    stubDataStore({ hasAnyPendingOptimistic: vi.fn(() => true) });
    stubSync();

    await writeRecord(ctx, 'foodlog', { recordId: 'foodlog-1', clientTs: 1, deleted: false, name: 'oats' });

    expect(ds.invalidateTags).not.toHaveBeenCalled();
    expect(ds.requestTabRefresh).not.toHaveBeenCalled();
  });

  it('a record type no tag-cached screen reads (nk) emits nothing', async () => {
    stubDataStore();
    stubSync();

    await writeRecord(ctx, 'nk', { recordId: 'nk', clientTs: 1, deleted: false, nk: 'AAAA' });

    expect(ds.requestTabRefresh).not.toHaveBeenCalled();
  });

  it('an incoming sync pull repaints once per page, with the union of the pulled types', async () => {
    stubDataStore();
    const kData = await deriveKData(ctx.dek);
    const seal = async (recordType, recordId, seq, record) => {
      const { nonce, ct } = await encryptRecord({
        kData, accountId, recordType, recordId, seq,
        plaintext: new TextEncoder().encode(JSON.stringify(record)),
      });
      return { seq, record_type_tag: `${recordType}:${recordId}`, nonce: toBase64(nonce), ct: toBase64(new Uint8Array(ct)) };
    };
    stubSync([
      await seal('bp', 'bp-1', 1, { recordId: 'bp-1', clientTs: 10, deleted: false, systolic: 120 }),
      await seal('weight', 'w-1', 2, { recordId: 'w-1', clientTs: 10, deleted: false, weight: 80 }),
    ]);

    await pullOnOpen(ctx);

    expect(ds.requestTabRefresh).toHaveBeenCalledTimes(1);
    expect(ds.requestTabRefresh).toHaveBeenCalledWith(['bp', 'weight'], 'cloud-write');
  });
});

// bd med-d5t.4 — the account storage quota. Enforcement was already correct
// (sync.go returns a clean 413 on both the ops and snapshot paths), but the
// everyday WRITE path reported that 413 as `offline`. So a user whose vault was
// full saw "Offline", was told in effect to check their wifi, and watched the
// pending queue grow forever against a server that was healthy and would refuse
// them every single time.
describe('a full vault reads as full, not as offline (med-d5t.4)', () => {
  let ctx;
  let opsStatus;
  let opsPosts;

  const readMetaKey = async (key) => {
    const db = await openDb();
    try {
      const tx = db.transaction('sync_meta', 'readonly');
      return await new Promise((resolve, reject) => {
        const req = tx.objectStore('sync_meta').get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  };

  // A non-null localLastSeq is what marks the device bootstrapped; without it
  // flushPending returns early and never reaches the POST under test.
  const seedMeta = async (meta) => {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('sync_meta', 'readwrite');
        const store = tx.objectStore('sync_meta');
        for (const [k, v] of Object.entries(meta)) store.put(v, k);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  };

  beforeEach(async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('medtracker-cloud');
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
    ctx = { accountId, dek: await generateDEK() };
    opsStatus = 200;
    opsPosts = 0;

    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).startsWith('/api/sync/ops') && (!init || init.method !== 'POST')) {
        return new Response(JSON.stringify({ ops: [], next: false }), { status: 200 });
      }
      if (String(url) === '/api/sync/ops') {
        opsPosts++;
        if (opsStatus !== 200) return new Response('account storage quota exceeded', { status: opsStatus });
        return new Response(JSON.stringify({ assigned: [opsPosts] }), { status: 200 });
      }
      if (String(url) === '/api/sync/snapshot') return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }));
  });

  it('names the quota rather than blaming the network on a 413', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    opsStatus = 413;

    await writeRecord(ctx, 'note', { recordId: 'note-1', text: 'hello' });

    const status = await getSyncStatus(ctx);
    expect(status.writeError).toMatchObject({ status: 413 });
    // The crux: the server answered. We are not offline.
    expect(status.offline).toBe(false);

    const line = await describeSyncStatus(ctx);
    expect(line).toContain('Vault is full');
    expect(line).not.toContain('Offline');
  });

  it('keeps the record pending, so a full vault never loses a write', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    opsStatus = 413;

    await writeRecord(ctx, 'note', { recordId: 'note-1', text: 'hello' });

    expect((await getSyncStatus(ctx)).pendingCount).toBe(1);
    // And it is readable locally — the user's data is on their device.
    const notes = await listRecords(ctx, 'note');
    expect(notes.map((n) => n.recordId)).toContain('note-1');
  });

  it('clears the error once the server accepts a batch again', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    opsStatus = 413;
    await writeRecord(ctx, 'note', { recordId: 'note-1', text: 'hello' });
    expect(await readMetaKey('writeError')).toMatchObject({ status: 413 });

    // Quota raised, or space freed.
    opsStatus = 200;
    await writeRecord(ctx, 'note', { recordId: 'note-2', text: 'world' });

    expect(await readMetaKey('writeError')).toBeNull();
    expect(await describeSyncStatus(ctx)).not.toContain('Vault is full');
  });

  it('still treats a 5xx as offline — that one really is a network/server fault', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    opsStatus = 503;

    await writeRecord(ctx, 'note', { recordId: 'note-1', text: 'hello' });

    const status = await getSyncStatus(ctx);
    expect(status.offline).toBe(true);
    expect(status.writeError).toBeNull();
  });

  it('still treats 401/403/408/429 as transient, not as a full vault', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    opsStatus = 429; // a reverse proxy can return this even though cmd/cloud did not

    await writeRecord(ctx, 'note', { recordId: 'note-1', text: 'hello' });

    const status = await getSyncStatus(ctx);
    expect(status.offline).toBe(true);
    expect(status.writeError).toBeNull();
  });

  it('reports an unnameable permanent refusal honestly, without guessing "full"', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    opsStatus = 400;

    await writeRecord(ctx, 'note', { recordId: 'note-1', text: 'hello' });

    const line = await describeSyncStatus(ctx);
    expect(line).toContain('refused');
    expect(line).not.toContain('Vault is full');
  });
});

// bd med-d5t.6 — convergence is last-writer-wins on clientTs, and clientTs was
// the writing device's raw Date.now(). No server timestamp, no Lamport counter,
// no monotonic guard.
//
// The failure needs no exotic assumptions: a friend's phone clock runs 10
// minutes fast. They edit a medication dose on the phone. Ten minutes later, on
// a correctly-clocked laptop, they fix a typo in the same record — and that edit
// carries an EARLIER clientTs, so applyIncoming drops it. The wrong dose
// persists, silently.
describe('clock skew must not silently drop the newer edit (med-d5t.6)', () => {
  let ctx;
  let serverDate;

  const readMetaKey = async (key) => {
    const db = await openDb();
    try {
      const tx = db.transaction('sync_meta', 'readonly');
      return await new Promise((resolve, reject) => {
        const req = tx.objectStore('sync_meta').get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  };

  const seedMeta = async (meta) => {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('sync_meta', 'readwrite');
        const store = tx.objectStore('sync_meta');
        for (const [k, v] of Object.entries(meta)) store.put(v, k);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  };

  // A record already in the local mirror, as a pull from the fast phone left it.
  const seedRecord = async (record) => {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite');
        tx.objectStore('records').put(record);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  };

  const getRecordRaw = async (recordId) => {
    const db = await openDb();
    try {
      const tx = db.transaction('records', 'readonly');
      return await new Promise((resolve, reject) => {
        const req = tx.objectStore('records').get(recordId);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  };

  beforeEach(async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('medtracker-cloud');
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
    ctx = { accountId, dek: await generateDEK() };
    serverDate = null;

    let posted = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const headers = new Headers();
      if (serverDate) headers.set('Date', serverDate);
      const method = (init && init.method) || 'GET';
      if (String(url).startsWith('/api/sync/ops') && method !== 'POST') {
        return new Response(JSON.stringify({ ops: [], next: false }), { status: 200, headers });
      }
      if (String(url) === '/api/sync/ops') {
        posted++;
        return new Response(JSON.stringify({ assigned: [posted] }), { status: 200, headers });
      }
      if (String(url) === '/api/sync/snapshot') return new Response('{}', { status: 200, headers });
      throw new Error(`unexpected fetch: ${url}`);
    }));
  });

  it('a fresh edit outranks the record it overwrites, even from a slow clock', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    // The fast phone's write, already merged into this laptop's mirror.
    const phoneTs = Date.now() + 10 * 60 * 1000;
    await seedRecord({ recordId: 'med-1', recordType: 'medication', clientTs: phoneTs, deleted: false, dose: 'WRONG' });

    // The laptop, whose clock is correct, fixes the typo. Its raw Date.now() is
    // ten minutes BEHIND the value the phone stamped.
    await writeRecord(ctx, 'medication', { recordId: 'med-1', clientTs: Date.now(), deleted: false, dose: 'RIGHT' });

    const stored = await getRecordRaw('med-1');
    expect(stored.dose).toBe('RIGHT');
    // And it must beat the phone's stamp, or the next pull would resurrect it.
    expect(stored.clientTs).toBeGreaterThan(phoneTs);
  });

  it('the corrected write survives a pull of the older record it replaced', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    const phoneTs = Date.now() + 10 * 60 * 1000;
    await seedRecord({ recordId: 'med-1', recordType: 'medication', clientTs: phoneTs, deleted: false, dose: 'WRONG' });

    const written = await writeRecord(ctx, 'medication', { recordId: 'med-1', clientTs: Date.now(), deleted: false, dose: 'RIGHT' });

    // Simulate the phone's op arriving again on a later pull: LWW must keep ours.
    expect(written.clientTs).toBeGreaterThan(phoneTs);
    expect(await listRecords(ctx, 'medication')).toEqual([expect.objectContaining({ dose: 'RIGHT' })]);
  });

  it('leaves a first write of a brand-new record alone when the clock is right', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    const t = Date.now();

    const written = await writeRecord(ctx, 'note', { recordId: 'note-1', clientTs: t, deleted: false, text: 'hi' });

    expect(written.clientTs).toBe(t);
  });

  it("learns the server's clock from the Date header and corrects new writes", async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    // Server says it is 10 minutes earlier than this device believes.
    const skewMs = 10 * 60 * 1000;
    serverDate = new Date(Date.now() - skewMs).toUTCString();

    await pullOnOpen(ctx);

    const learned = await readMetaKey('clockSkewMs');
    expect(learned).toBeGreaterThan(skewMs - 5000);
    expect(learned).toBeLessThan(skewMs + 5000);

    // A new record on this fast device is stamped on the SERVER's scale, so a
    // correctly-clocked peer's later edit still reads as later.
    const before = Date.now();
    const written = await writeRecord(ctx, 'note', { recordId: 'note-1', clientTs: Date.now(), deleted: false, text: 'hi' });
    expect(written.clientTs).toBeLessThan(before - skewMs + 5000);
  });

  it('tells the user their clock is wrong instead of losing edits quietly', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    serverDate = new Date(Date.now() - 10 * 60 * 1000).toUTCString();

    await pullOnOpen(ctx);

    const line = await describeSyncStatus(ctx);
    expect(line).toMatch(/clock is 10 min fast/);
    expect(line).toMatch(/losing edits/);
  });

  it('reports a slow clock as slow', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    serverDate = new Date(Date.now() + 10 * 60 * 1000).toUTCString();

    await pullOnOpen(ctx);

    expect(await describeSyncStatus(ctx)).toMatch(/clock is 10 min slow/);
  });

  it('says nothing about ordinary sub-threshold drift', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    serverDate = new Date(Date.now() - 3000).toUTCString(); // 3 seconds

    await pullOnOpen(ctx);

    expect(await describeSyncStatus(ctx)).not.toMatch(/clock/);
  });

  it('survives a response with no usable Date header', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    serverDate = 'not a date';

    await pullOnOpen(ctx);

    expect(await readMetaKey('clockSkewMs')).toBeNull();
    expect(await describeSyncStatus(ctx)).not.toMatch(/clock/);
  });
});
