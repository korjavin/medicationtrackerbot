import 'fake-indexeddb/auto';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { deriveKData, encryptRecord, decryptRecord, encryptSnapshot, decryptSnapshot, generateDEK, toBase64 } from '../crypto.js';
import { listRecords, listRecordsInRange, readAllLiveRecords, pullOnOpen, writeRecord, flushConfirmed, describeSyncStatus, getSyncStatus, recordsPort, resetLocalSync, forceSnapshot, replaceAllRecords, reauthenticate, startReconnectAutoDrain, getRecordsChangeCount, ORIGIN_UI, ORIGIN_EXTERNAL } from '../sync.js';
import { openDb, cachedDb, dropCachedDb, onCachedDbDropped } from '../localdb.js';

// reauthenticate() dynamic-imports unlock.js for the passkey ceremony; the real
// module drives navigator.credentials, which doesn't exist in jsdom.
vi.mock('../unlock.js', () => ({
  assertPasskey: vi.fn(async () => ({ accountId: 'amber-falcon-8k3q9x', dek: null, credentialId: null })),
}));

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
      if (u === '/api/sync/snapshot' && !init?.method) return new Response(null, { status: 204 });
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

  // med-dvr: the original guard here was hasAnyPendingOptimistic(), which is only
  // ever true for writes that go through DataStore.applyOptimistic. Settings
  // writes do not — toggleFeatureSetting POSTs straight through apiCall — so the
  // guard passed, the emit fired, and the user was told "New data is available"
  // about the setting they had just changed. The origin is the real signal.
  it("does not repaint over the UI's own write", async () => {
    stubDataStore();
    stubSync();

    await writeRecord(ctx, 'foodlog', { recordId: 'foodlog-1', clientTs: 1, deleted: false, name: 'oats' }, ORIGIN_UI);

    expect(ds.invalidateTags).not.toHaveBeenCalled();
    expect(ds.requestTabRefresh).not.toHaveBeenCalled();
  });

  // The exact reported bug: a settings toggle has no applyOptimistic anywhere in
  // its path, so the old guard could never have suppressed it.
  it("does not repaint a UI settings write, which never touches applyOptimistic", async () => {
    stubDataStore({ hasAnyPendingOptimistic: vi.fn(() => false) });
    stubSync();

    await writeRecord(ctx, 'features', { recordId: 'features', clientTs: 1, deleted: false, food_enabled: true }, ORIGIN_UI);

    expect(ds.requestTabRefresh).not.toHaveBeenCalled();
  });

  it('suppression does not consult a timing window or the optimistic queue', async () => {
    // No hasAnyPendingOptimistic, no lastOwnWriteAt: origin alone decides.
    stubDataStore({ hasAnyPendingOptimistic: undefined, lastOwnWriteAt: Date.now() });
    stubSync();

    await writeRecord(ctx, 'bp', { recordId: 'bp-1', clientTs: 1, deleted: false, systolic: 120 }, ORIGIN_UI);
    expect(ds.requestTabRefresh).not.toHaveBeenCalled();

    await writeRecord(ctx, 'bp', { recordId: 'bp-2', clientTs: 1, deleted: false, systolic: 121 }, ORIGIN_EXTERNAL);
    expect(ds.requestTabRefresh).toHaveBeenCalledWith(['bp'], 'cloud-write');
  });

  it('an untagged writer repaints — a stale screen beats a silent one', async () => {
    stubDataStore();
    stubSync();

    // No origin argument at all, as a writer added later might call it.
    await writeRecord(ctx, 'bp', { recordId: 'bp-1', clientTs: 1, deleted: false, systolic: 120 });

    expect(ds.requestTabRefresh).toHaveBeenCalledWith(['bp'], 'cloud-write');
  });

  it('recordsPort carries its origin into both put and del', async () => {
    stubDataStore();
    stubSync();

    const uiPort = recordsPort(ctx, ORIGIN_UI);
    await uiPort.put('bp', { recordId: 'bp-1', clientTs: 1, deleted: false, systolic: 120 });
    expect(ds.requestTabRefresh).not.toHaveBeenCalled();
    await uiPort.del('bp', 'bp-1');
    expect(ds.requestTabRefresh).not.toHaveBeenCalled();

    const bgPort = recordsPort(ctx);
    await bgPort.put('bp', { recordId: 'bp-2', clientTs: 1, deleted: false, systolic: 121 });
    expect(ds.requestTabRefresh).toHaveBeenCalledWith(['bp'], 'cloud-write');
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
    await flushConfirmed(ctx); // med-eas.77: the eager push is now background — await it to observe its result

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
    await flushConfirmed(ctx); // med-eas.77: the eager push is now background — await it to observe its result

    expect((await getSyncStatus(ctx)).pendingCount).toBe(1);
    // And it is readable locally — the user's data is on their device.
    const notes = await listRecords(ctx, 'note');
    expect(notes.map((n) => n.recordId)).toContain('note-1');
  });

  it('clears the error once the server accepts a batch again', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    opsStatus = 413;
    await writeRecord(ctx, 'note', { recordId: 'note-1', text: 'hello' });
    await flushConfirmed(ctx); // med-eas.77: the eager push is now background — await it to observe its result
    expect(await readMetaKey('writeError')).toMatchObject({ status: 413 });

    // Quota raised, or space freed.
    opsStatus = 200;
    await writeRecord(ctx, 'note', { recordId: 'note-2', text: 'world' });
    await flushConfirmed(ctx); // med-eas.77: await the now-background push

    expect(await readMetaKey('writeError')).toBeNull();
    expect(await describeSyncStatus(ctx)).not.toContain('Vault is full');
  });

  it('still treats a 5xx as offline — that one really is a network/server fault', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    opsStatus = 503;

    await writeRecord(ctx, 'note', { recordId: 'note-1', text: 'hello' });
    await flushConfirmed(ctx); // med-eas.77: the eager push is now background — await it to observe its result

    const status = await getSyncStatus(ctx);
    expect(status.offline).toBe(true);
    expect(status.authExpired).toBe(false);
    expect(status.writeError).toBeNull();
  });

  it('treats a thrown fetch (genuine network failure) as offline, not auth-expired', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url) === '/api/sync/ops' && init?.method === 'POST') throw new TypeError('network down');
      return new Response(JSON.stringify({ ops: [], next: false }), { status: 200 });
    }));

    await writeRecord(ctx, 'note', { recordId: 'note-1', text: 'hello' });
    await flushConfirmed(ctx); // med-eas.77: the eager push is now background — await it to observe its result

    const status = await getSyncStatus(ctx);
    expect(status.offline).toBe(true);
    expect(status.authExpired).toBe(false);
  });

  it('still treats 403/408/429 as transient, not as a full vault', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    for (const transient of [403, 408, 429]) {
      opsStatus = transient; // a reverse proxy can return these even though cmd/cloud did not

      await writeRecord(ctx, 'note', { recordId: `note-${transient}`, text: 'hello' });
      await flushConfirmed(ctx); // med-eas.77: await the now-background push

      const status = await getSyncStatus(ctx);
      expect(status.offline).toBe(true);
      expect(status.authExpired).toBe(false);
      expect(status.writeError).toBeNull();
    }
  });

  // med-deq.2 — an expired 30-day session returns 401 forever; bucketing it as
  // "Offline" stranded the pending queue with no recovery path.
  it('reports a 401 as auth-expired, not offline, and keeps the write pending', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    opsStatus = 401;

    await writeRecord(ctx, 'note', { recordId: 'note-1', text: 'hello' });
    await flushConfirmed(ctx); // med-eas.77: the eager push is now background — await it to observe its result

    const status = await getSyncStatus(ctx);
    expect(status.authExpired).toBe(true);
    expect(status.offline).toBe(false);
    expect(status.writeError).toBeNull();
    // The queue is preserved — nothing dropped, drained after re-auth.
    expect(status.pendingCount).toBe(1);
    const notes = await listRecords(ctx, 'note');
    expect(notes.map((n) => n.recordId)).toContain('note-1');
  });

  it('leads the status line with the re-authenticate wording when auth-expired', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    opsStatus = 401;

    await writeRecord(ctx, 'note', { recordId: 'note-1', text: 'hello' });
    await flushConfirmed(ctx); // med-eas.77: the eager push is now background — await it to observe its result

    const line = await describeSyncStatus(ctx);
    expect(line).toContain('Session expired — re-authenticate');
    expect(line).not.toContain('Offline');

    // A successful batch (session re-minted) clears the state again.
    opsStatus = 200;
    await writeRecord(ctx, 'note', { recordId: 'note-2', text: 'world' });
    await flushConfirmed(ctx); // med-eas.77: await the now-background push
    const status = await getSyncStatus(ctx);
    expect(status.authExpired).toBe(false);
    expect(await describeSyncStatus(ctx)).not.toContain('Session expired');
  });

  it('reauthenticate re-runs the passkey ceremony, clears auth-expired, and drains the queue', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    opsStatus = 401;
    await writeRecord(ctx, 'note', { recordId: 'note-1', text: 'hello' });
    await flushConfirmed(ctx); // med-eas.77: the eager push is now background — await it to observe its result
    expect(await getSyncStatus(ctx)).toMatchObject({ authExpired: true, pendingCount: 1 });

    // The ceremony re-mints the session cookie server-side; the server accepts
    // again. Re-stub with contiguous seq assignment (the shared counter already
    // burned a seq on the 401 POST, which would mis-predict every retry).
    let nextSeq = 1;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url) === '/api/sync/ops' && init?.method === 'POST') {
        const { ops } = JSON.parse(init.body);
        return new Response(JSON.stringify({ assigned: ops.map(() => nextSeq++) }), { status: 200 });
      }
      if (String(url).startsWith('/api/sync/ops')) return new Response(JSON.stringify({ ops: [], next: false }), { status: 200 });
      if (String(url) === '/api/sync/snapshot') return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const status = await reauthenticate(ctx);

    const { assertPasskey } = await import('../unlock.js');
    expect(assertPasskey).toHaveBeenCalled();
    expect(status.authExpired).toBe(false);
    expect(status.pendingCount).toBe(0);
  });

  it('reports an unnameable permanent refusal honestly, without guessing "full"', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    opsStatus = 400;

    await writeRecord(ctx, 'note', { recordId: 'note-1', text: 'hello' });
    await flushConfirmed(ctx); // med-eas.77: the eager push is now background — await it to observe its result

    const line = await describeSyncStatus(ctx);
    expect(line).toContain('refused');
    expect(line).not.toContain('Vault is full');
  });
});

// med-eas.77 — local-first write: writeRecord's eager oplog push is now
// fire-and-forget. The write must resolve as soon as the local IndexedDB put +
// markPending complete (apiCall returns the LOCAL stamped record, never a server
// ack), while the /api/sync/ops push runs in the background — durably retried
// from 'pending', and never surfacing an unhandled rejection to the caller.
describe('writeRecord does not await the background oplog push (med-eas.77)', () => {
  let ctx;

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
  });

  it('resolves the write before the /api/sync/ops push settles', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    let releasePush;
    const pushGate = new Promise((r) => { releasePush = r; });
    const order = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url) === '/api/sync/ops' && init?.method === 'POST') {
        order.push('push-start');
        await pushGate; // hold the push open so a synchronous await would deadlock the test
        order.push('push-done');
        const { ops } = JSON.parse(init.body);
        return new Response(JSON.stringify({ assigned: ops.map((_, i) => i + 1) }), { status: 200 });
      }
      if (String(url).startsWith('/api/sync/ops')) return new Response(JSON.stringify({ ops: [], next: false }), { status: 200 });
      if (String(url) === '/api/sync/snapshot') return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }));

    const stamped = await writeRecord(ctx, 'note', { recordId: 'note-1', text: 'hello' });
    order.push('write-resolved');

    // The write resolved while the push was still gated — it never awaited it.
    expect(order).not.toContain('push-done');
    expect(stamped.recordId).toBe('note-1');
    // Durable locally and still queued (the push is in flight, not lost).
    expect((await listRecords(ctx, 'note')).map((n) => n.recordId)).toContain('note-1');
    expect((await getSyncStatus(ctx)).pendingCount).toBe(1);

    // Release the gate and drain so the module-global flushChain settles (else a
    // pending flush would leak into the next test).
    releasePush();
    await flushConfirmed(ctx);
    expect((await getSyncStatus(ctx)).pendingCount).toBe(0);
  });

  it('pushes the pending row via the background flush once the network settles', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    let posts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url) === '/api/sync/ops' && init?.method === 'POST') {
        posts++;
        const { ops } = JSON.parse(init.body);
        return new Response(JSON.stringify({ assigned: ops.map((_, i) => i + 1) }), { status: 200 });
      }
      if (String(url).startsWith('/api/sync/ops')) return new Response(JSON.stringify({ ops: [], next: false }), { status: 200 });
      if (String(url) === '/api/sync/snapshot') return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }));

    await writeRecord(ctx, 'note', { recordId: 'note-1', text: 'hello' });
    await flushConfirmed(ctx); // await the background push's settle point

    expect(posts).toBeGreaterThanOrEqual(1);
    expect((await getSyncStatus(ctx)).pendingCount).toBe(0); // reached the cloud & cleared
  });

  it('keeps the pending row and never rejects to the caller when the background push fails', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    const rejections = [];
    const onRej = (e) => rejections.push(e);
    process.on('unhandledRejection', onRej);
    try {
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        if (String(url) === '/api/sync/ops' && init?.method === 'POST') throw new TypeError('network down');
        if (String(url).startsWith('/api/sync/ops')) return new Response(JSON.stringify({ ops: [], next: false }), { status: 200 });
        if (String(url) === '/api/sync/snapshot') return new Response('{}', { status: 200 });
        throw new Error(`unexpected fetch: ${url}`);
      }));

      // The write resolves normally even though its background push will fail.
      await expect(writeRecord(ctx, 'note', { recordId: 'note-1', text: 'hello' }))
        .resolves.toMatchObject({ recordId: 'note-1' });
      await flushConfirmed(ctx); // let the failing flush settle
      await new Promise((r) => setTimeout(r, 0)); // flush the microtask/task queue for any stray rejection

      // Retained for retry, and no unhandled rejection escaped the fire-and-forget catch.
      expect((await getSyncStatus(ctx)).pendingCount).toBe(1);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRej);
    }
  });
});

// med-gvk.2 — a half-open connection (captive portal / hung TCP) leaves a bare
// fetch pending forever, which is what hung the boot's awaited pullOnOpen. Every
// /api/sync/* fetch now goes through timedFetch, aborting after
// SYNC_FETCH_TIMEOUT_MS (10s) and landing in the same `catch { offline = true }`
// degrade path as any network failure — so the pull resolves, pending data is
// kept, and the account is not permanently wedged (retried next open).
describe('sync fetches abort on a half-open connection (med-gvk.2)', () => {
  let ctx;

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

  // Seed a durable record + its 'pending' row directly, so pullOnOpen's flush
  // leg has something to (fail to) push without going through writeRecord's own
  // background flush.
  const seedPending = async (record) => {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['records', 'pending'], 'readwrite');
        tx.objectStore('records').put(record);
        tx.objectStore('pending').put({ recordId: record.recordId, recordType: record.recordType });
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Wiring guard: a bare fetch() carries no signal and can never be aborted, so
  // asserting every /api/sync/* fetch is passed an AbortSignal is what proves the
  // half-open stall is now bounded. (The 10s countdown itself is a plain
  // AbortController + setTimeout; the fired-abort behaviour is exercised below.)
  it('passes an AbortSignal into every /api/sync fetch (bare fetch could never time out)', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    await seedPending({ recordId: 'note-1', recordType: 'note', clientTs: Date.now(), text: 'hi' });

    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url) === '/api/sync/ops' && init?.method === 'POST') {
        const { ops } = JSON.parse(init.body);
        return new Response(JSON.stringify({ assigned: ops.map((_, i) => i + 1) }), { status: 200 });
      }
      if (String(url).startsWith('/api/sync/ops')) return new Response(JSON.stringify({ ops: [], next: false }), { status: 200 });
      if (String(url) === '/api/sync/snapshot') return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }));

    await pullOnOpen(ctx);

    expect(globalThis.fetch).toHaveBeenCalled();
    expect(globalThis.fetch.mock.calls.every(([, init]) => init && init.signal instanceof AbortSignal)).toBe(true);
  });

  it('degrades like offline when the timeout fires (AbortError): keeps pending, does not wedge, no unhandled rejection', async () => {
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    await seedPending({ recordId: 'note-1', recordType: 'note', clientTs: Date.now(), text: 'hi' });

    // Exactly what timedFetch's AbortController produces when the 10s elapses —
    // fetch rejects with an AbortError. No fake timers / no 10s wait needed to
    // exercise the degrade path the timeout lands in.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }));

    const rejections = [];
    const onRej = (e) => rejections.push(e);
    process.on('unhandledRejection', onRej);
    try {
      await pullOnOpen(ctx); // resolves — a bare fetch on a half-open socket would hang here forever
      await new Promise((r) => setTimeout(r, 0)); // flush any stray microtask/rejection

      const status = await getSyncStatus(ctx);
      expect(status.offline).toBe(true);   // degraded like offline
      expect(status.pendingCount).toBe(1); // no data lost — retried next open
      expect(status.wedged).toBe(false);   // transient, not permanently wedged
      expect(rejections).toEqual([]);      // aborts caught, nothing escaped
    } finally {
      process.off('unhandledRejection', onRej);
    }
  });
});

// med-deq.2 — reconnect auto-drain: queued offline edits must sync when the
// browser comes back online (or the tab regains visibility while online)
// without waiting for the next user write or a reload. The vitest env is node,
// so window/document are stubbed with bare EventTargets — exactly the surface
// startReconnectAutoDrain touches.
describe('reconnect auto-drain (med-deq.2)', () => {
  let ctx;
  let teardown;
  let doc;
  let opsGets;

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

  // med-tc1.9 — no wall-clock sleep is a synchronization point in here. The old
  // `settle()` slept 400ms hoping the 250ms debounce had fired AND pullOnOpen
  // had reached its fetch; 150ms of slack over a real timer is exactly the
  // margin a loaded runner eats (same flake class as med-tc1.8 / #716). Three
  // progress-bounded barriers replace it:
  //
  //   fireDebounce() — DRIVES the debounce with fake timers instead of
  //     out-waiting it, so "the debounce has fired" is a fact, not a guess.
  //     Only setTimeout/clearTimeout are faked: fake-indexeddb dispatches its
  //     requests on setImmediate, which must stay real for the store to run.
  //   nextOpsGet() — resolves from inside the fetch mock the moment the drain's
  //     ops GET is entered (the #716 pattern: the mock reports progress).
  //   idle() — a run of real IndexedDB round-trips, for the negative assertions
  //     ("no second drain started"). Each round yields to the macrotask queue
  //     the store's requests run on, so anything that *could* have progressed
  //     has. The round count is a unit of WORK, not of time: a pullOnOpen needs
  //     ~12-14 round-trips to reach its ops GET (measured by mutation — 10
  //     rounds let an uncoalesced drain survive, 15 killed it), and that number
  //     is a property of the code path, not of how loaded the machine is. 60 is
  //     ~4x margin that a slow runner cannot erode, which is exactly what the
  //     400ms-over-a-250ms-debounce sleep could not promise.
  const fireDebounce = () => vi.advanceTimersByTimeAsync(250);

  let notifyOpsGet = () => {};
  const nextOpsGet = () => new Promise((r) => { notifyOpsGet = r; });
  const countOpsGet = () => { opsGets++; notifyOpsGet(); };

  const idbRoundTrip = async () => {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const req = db.transaction('pending', 'readonly').objectStore('pending').getAll();
        req.onsuccess = resolve;
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  };
  const idle = async (rounds = 60) => { for (let i = 0; i < rounds; i++) await idbRoundTrip(); };

  beforeEach(async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('medtracker-cloud');
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
    ctx = { accountId, dek: await generateDEK() };
    await seedMeta({ localLastSeq: 0, lastSnapshotSeq: 0 });
    opsGets = 0;
    notifyOpsGet = () => {};
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    vi.stubGlobal('window', new EventTarget());
    doc = new EventTarget();
    doc.visibilityState = 'visible';
    vi.stubGlobal('document', doc);
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).startsWith('/api/sync/ops') && (!init || init.method !== 'POST')) {
        countOpsGet();
        return new Response(JSON.stringify({ ops: [], next: false }), { status: 200 });
      }
      if (String(url) === '/api/sync/snapshot') return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }));
  });

  afterEach(async () => {
    teardown?.();
    teardown = null;
    // `await nextOpsGet()` proves a drain *entered* its fetch, not that it
    // finished — pullOnOpen still has flushPending + maybeSnapshot to go. A
    // drain left running past afterEach is module-global state: the next test's
    // startReconnectAutoDrain would coalesce into the stale `drainInFlight` and
    // never fire its own ops GET, and the leaked run would hit unstubbed
    // globals. reauthenticate() is the one exported barrier that provably waits
    // the slot empty (`while (drainInFlight) await drainInFlight`) and leaves it
    // empty; teardown() above already set `stopped`, so no rerun can re-fill it.
    await reauthenticate(ctx).catch(() => {});
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('an online event triggers a drain with no user write', async () => {
    teardown = startReconnectAutoDrain(ctx);
    expect(opsGets).toBe(0); // starting the listeners alone must not drain
    const entered = nextOpsGet();
    window.dispatchEvent(new Event('online'));
    await fireDebounce();
    await entered;
    expect(opsGets).toBeGreaterThan(0); // pullTail's ops GET fired — no writeRecord involved
  });

  it('a visibility regain while online triggers the same drain', async () => {
    teardown = startReconnectAutoDrain(ctx);
    const entered = nextOpsGet();
    document.dispatchEvent(new Event('visibilitychange'));
    await fireDebounce();
    await entered;
    expect(opsGets).toBeGreaterThan(0);
  });

  it('rapid online events coalesce into a single in-flight drain, then one follow-up run', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).startsWith('/api/sync/ops') && (!init || init.method !== 'POST')) {
        countOpsGet();
        await gate; // hold the first drain in flight
        return new Response(JSON.stringify({ ops: [], next: false }), { status: 200 });
      }
      if (String(url) === '/api/sync/snapshot') return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }));
    teardown = startReconnectAutoDrain(ctx);
    const first = nextOpsGet();
    window.dispatchEvent(new Event('online'));
    await fireDebounce();
    await first; // first drain is now in flight, blocked on the gate
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));
    await fireDebounce(); // the re-trigger's debounce fires while the drain holds the slot
    await idle(); // …and nothing it could have started gets to start
    expect(opsGets).toBe(1); // the in-flight guard coalesced the re-triggers
    const followUp = nextOpsGet();
    release();
    await followUp; // the mid-drain events must not be swallowed: the in-flight
    // run may have already missed the reconnect they signalled (e.g. it was
    // stuck on a dying fetch), so exactly one follow-up drain runs after it.
    expect(opsGets).toBe(2);
    await idle(); // `rerun` is a single boolean — the follow-up must not chain another
    expect(opsGets).toBe(2);
  });

  it('reauthenticate serializes with an in-flight auto-drain instead of overlapping it', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).startsWith('/api/sync/ops') && (!init || init.method !== 'POST')) {
        countOpsGet();
        await gate; // hold the auto-drain in flight
        return new Response(JSON.stringify({ ops: [], next: false }), { status: 200 });
      }
      if (String(url) === '/api/sync/snapshot') return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }));
    teardown = startReconnectAutoDrain(ctx);
    const first = nextOpsGet();
    window.dispatchEvent(new Event('online'));
    await fireDebounce();
    await first; // auto-drain in flight, blocked on the gate

    // Two concurrent pullOnOpen runs would double-flush the same pending set;
    // reauthenticate must wait for the in-flight drain before draining itself.
    const reauth = reauthenticate(ctx);
    await idle(); // an unserialized reauth reaches its own ops GET well inside this
    expect(opsGets).toBe(1); // reauthenticate's drain has not started yet
    release();
    await reauth;
    expect(opsGets).toBe(2); // it ran after the auto-drain finished
  });

  it('an online event during a reauthenticate-owned drain still gets its follow-up run', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).startsWith('/api/sync/ops') && (!init || init.method !== 'POST')) {
        countOpsGet();
        await gate; // hold the reauth-owned drain in flight
        return new Response(JSON.stringify({ ops: [], next: false }), { status: 200 });
      }
      if (String(url) === '/api/sync/snapshot') return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }));
    teardown = startReconnectAutoDrain(ctx);
    const first = nextOpsGet();
    const reauth = reauthenticate(ctx); // owns the drain slot, blocked on the gate
    await first;
    expect(opsGets).toBe(1);

    window.dispatchEvent(new Event('online'));
    await fireDebounce(); // debounce fired mid-reauth-drain: coalesced, not dropped
    await idle();
    expect(opsGets).toBe(1);
    const followUp = nextOpsGet();
    release();
    await reauth;
    await followUp; // the queued follow-up must run after the reauth drain settles
    expect(opsGets).toBe(2);
  });

  it('a concurrent flush entry point serializes behind an in-flight flush instead of double-posting', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let postsInFlight = 0;
    let maxPostsInFlight = 0;
    let opsPosted = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url) === '/api/sync/ops' && init?.method === 'POST') {
        postsInFlight++;
        maxPostsInFlight = Math.max(maxPostsInFlight, postsInFlight);
        const { ops } = JSON.parse(init.body);
        opsPosted += ops.length;
        await gate; // hold the first flush mid-POST
        postsInFlight--;
        return new Response(JSON.stringify({ assigned: ops.map((_, i) => i + 1) }), { status: 200 });
      }
      if (String(url).startsWith('/api/sync/ops')) return new Response(JSON.stringify({ ops: [], next: false }), { status: 200 });
      if (String(url) === '/api/sync/snapshot') return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }));
    // writeRecord's inline flush blocks mid-POST on the gate…
    const write = writeRecord(ctx, 'note', { recordId: 'note-1', text: 'hello' });
    await vi.waitFor(() => expect(postsInFlight).toBe(1));
    // …while the inbox ack barrier enters flushPending through its own door.
    // Unserialized, it would re-read the same 'pending' set and re-POST note-1
    // under the same predicted seq — a guaranteed mis-predict.
    const confirmed = flushConfirmed(ctx);
    await idle(); // an unserialized flushConfirmed re-reads 'pending' and re-POSTs inside this
    release();
    await write;
    await expect(confirmed).resolves.toBe(true);
    expect(maxPostsInFlight).toBe(1); // never two flushes in flight at once
    expect(opsPosted).toBe(1); // note-1 posted exactly once
  });

  it('a drain that settles auth-expired invokes onAuthExpired (mid-session expiry surface)', async () => {
    // The boot-time banner check runs exactly once; a session expiring under a
    // long-lived tab is only ever detected by these event-driven drains, so
    // the drain must hand the state to the caller instead of queueing silently.
    let surfaced = 0;
    let sessionValid = false;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).startsWith('/api/sync/ops') && (!init || init.method !== 'POST')) {
        countOpsGet();
        if (!sessionValid) return new Response('unauthorized', { status: 401 });
        return new Response(JSON.stringify({ ops: [], next: false }), { status: 200 });
      }
      if (String(url) === '/api/sync/snapshot') return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }));
    // The callback itself is the settle point — it runs in the drain's .finally,
    // after a full pullOnOpen tail (pullTail + flushPending + maybeSnapshot).
    let notifyExpiry = () => {};
    const expired = new Promise((r) => { notifyExpiry = r; });
    teardown = startReconnectAutoDrain(ctx, { onAuthExpired: () => { surfaced++; notifyExpiry(); } });
    window.dispatchEvent(new Event('online'));
    await fireDebounce();
    await expired;
    expect(opsGets).toBe(1);
    expect(surfaced).toBe(1); // the 401 drain surfaced the expiry

    // Session restored (e.g. re-auth completed): a successful drain must not
    // re-fire the callback (this also clears the module auth-expired state).
    sessionValid = true;
    const second = nextOpsGet();
    window.dispatchEvent(new Event('online'));
    await fireDebounce();
    await second;
    // Proving a NEGATIVE needs the drain's .finally to have run. Re-trigger
    // mid-drain: the event coalesces into `rerun`, and the follow-up drain is
    // launched from onDrainSettled() — the same .finally, one line above the
    // onAuthExpired check. Its ops GET is therefore proof the check ran.
    const followUp = nextOpsGet();
    window.dispatchEvent(new Event('online'));
    await fireDebounce();
    await followUp;
    expect(surfaced).toBe(1);
  });

  it('a post-teardown online event no longer drains', async () => {
    teardown = startReconnectAutoDrain(ctx);
    teardown();
    teardown = null;
    window.dispatchEvent(new Event('online'));
    await fireDebounce();
    await idle();
    expect(opsGets).toBe(0);
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

// med-0ol.2/.3/.5 — a bulk import (a Mi-Band .nxk drains hundreds of day-batch
// records) queues far more 'pending' than one POST may carry. flushPending must
// drain it in ≤500-op chunks, not one giant body the server 400s and blind
// retries can never clear; a transient failure must retry without losing a
// record; a permanent 4xx must surface once, not storm.
describe('flushPending drains a bulk backlog in bounded batches (med-0ol.2/.3/.5)', () => {
  let ctx;

  const seedPending = async (records, meta = { localLastSeq: 0 }) => {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['records', 'pending', 'sync_meta'], 'readwrite');
        const rs = tx.objectStore('records');
        const ps = tx.objectStore('pending');
        for (const r of records) {
          rs.put(r);
          ps.put({ recordId: r.recordId, recordType: r.recordType });
        }
        const ms = tx.objectStore('sync_meta');
        for (const [k, v] of Object.entries(meta)) ms.put(v, k);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  };

  const readPendingCount = async () => {
    const db = await openDb();
    try {
      const tx = db.transaction('pending', 'readonly');
      return await new Promise((resolve, reject) => {
        const req = tx.objectStore('pending').getAll();
        req.onsuccess = () => resolve((req.result || []).length);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  };

  const makeRecords = (n, type = 'hrsample') => Array.from({ length: n }, (_, i) => ({
    recordId: `${type}-${i}`, recordType: type, clientTs: i + 1, deleted: false, samples: [{ date_time: '2026-01-01T00:00:00Z', value: i }],
  }));

  beforeEach(async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('medtracker-cloud');
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
    ctx = { accountId, dek: await generateDEK() };
  });

  it('posts a 1200-record backlog in three ≤500-op batches, never one giant body', async () => {
    await seedPending(makeRecords(1200));
    const batches = [];
    let assignNext = 1;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url);
      if (u === '/api/sync/ops' && init?.method === 'POST') {
        const { ops } = JSON.parse(init.body);
        batches.push(ops.length);
        const assigned = ops.map(() => assignNext++);
        return new Response(JSON.stringify({ assigned }), { status: 200 });
      }
      if (u === '/api/sync/snapshot' && init?.method === 'POST') return new Response('{}', { status: 200 });
      if (u.startsWith('/api/sync/ops?')) return new Response(JSON.stringify({ ops: [], next: false }), { status: 200 });
      if (u === '/api/sync/snapshot') return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch: ${u} ${init?.method || 'GET'}`);
    }));

    const ok = await flushConfirmed(ctx);

    expect(ok).toBe(true);
    expect(batches.length).toBe(3);
    expect(Math.max(...batches)).toBeLessThanOrEqual(500);
    expect(batches.reduce((a, b) => a + b, 0)).toBe(1200);
    expect(await readPendingCount()).toBe(0);
  });

  it('a transient 5xx leaves the backlog pending; a later flush lands every record (retry, no loss)', async () => {
    await seedPending(makeRecords(600));
    let failNext = true;
    const posted = [];
    let assignNext = 1;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url);
      if (u === '/api/sync/ops' && init?.method === 'POST') {
        if (failNext) { failNext = false; return new Response('busy', { status: 503 }); }
        const { ops } = JSON.parse(init.body);
        posted.push(...ops.map((o) => o.record_type_tag));
        const assigned = ops.map(() => assignNext++);
        return new Response(JSON.stringify({ assigned }), { status: 200 });
      }
      if (u === '/api/sync/snapshot' && init?.method === 'POST') return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch: ${u} ${init?.method || 'GET'}`);
    }));

    const first = await flushConfirmed(ctx);
    expect(first).toBe(false); // transient — reported not-confirmed, nothing acked
    expect(await readPendingCount()).toBe(600); // no record dropped

    const second = await flushConfirmed(ctx);
    expect(second).toBe(true);
    expect(await readPendingCount()).toBe(0);
    expect(new Set(posted).size).toBe(600); // every record landed exactly once
  });

  it('a permanent 400 does exactly one POST, surfaces the error, and keeps the records (no retry storm)', async () => {
    await seedPending(makeRecords(700));
    let posts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url);
      if (u === '/api/sync/ops' && init?.method === 'POST') {
        posts++;
        return new Response('batch size out of range', { status: 400 });
      }
      throw new Error(`unexpected fetch: ${u} ${init?.method || 'GET'}`);
    }));

    const ok = await flushConfirmed(ctx);

    expect(ok).toBe(false);
    expect(posts).toBe(1); // a 4xx is not blindly retried in a tight loop
    expect(await readPendingCount()).toBe(700); // nothing lost
    const status = await getSyncStatus(ctx);
    expect(status.writeError).toMatchObject({ status: 400 });
  });
});

// med-0ol.7 — #613 stopped the *tight loop* on a permanent 4xx but the doomed
// batch still re-POSTed once per open, forever, and a bloated oplog re-downloaded
// every open. A failed bulk import could brick a real account with no recovery.
// The self-heal is a write-error retry budget (pause after N permanent-error
// opens) plus resetLocalSync (rebuild this device cheaply from the server snapshot).
describe('write-error retry budget wedges a doomed batch, resetLocalSync un-wedges it (med-0ol.7)', () => {
  const WRITE_ERROR_BUDGET = 3;
  let ctx;

  const seedPending = async (records, meta = { localLastSeq: 0 }) => {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['records', 'pending', 'sync_meta'], 'readwrite');
        const rs = tx.objectStore('records');
        const ps = tx.objectStore('pending');
        for (const r of records) {
          rs.put(r);
          ps.put({ recordId: r.recordId, recordType: r.recordType });
        }
        const ms = tx.objectStore('sync_meta');
        for (const [k, v] of Object.entries(meta)) ms.put(v, k);
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
  });

  it('pauses syncing after the budget is spent and stops re-posting the doomed batch', async () => {
    await seedPending([{ recordId: 'note-1', recordType: 'note', clientTs: 1, deleted: false, text: 'x' }]);
    let opsPosts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url);
      if (u === '/api/sync/ops' && init?.method === 'POST') {
        opsPosts++;
        return new Response('account storage quota exceeded', { status: 413 });
      }
      throw new Error(`unexpected fetch: ${u} ${init?.method || 'GET'}`);
    }));

    // Each permanent-error flush spends one of the budget; the batch stays pending.
    for (let i = 0; i < WRITE_ERROR_BUDGET; i++) {
      expect(await flushConfirmed(ctx)).toBe(false);
    }
    expect(opsPosts).toBe(WRITE_ERROR_BUDGET);

    // Budget spent → syncing is wedged and the recovery is named.
    expect((await getSyncStatus(ctx)).wedged).toBe(true);
    expect(await describeSyncStatus(ctx)).toMatch(/reset local sync/i);

    // A subsequent open no longer re-POSTs the un-acceptable batch (nothing lost —
    // the record is still queued in 'pending').
    expect(await flushConfirmed(ctx)).toBe(false);
    expect(opsPosts).toBe(WRITE_ERROR_BUDGET); // no further POST
    expect((await getSyncStatus(ctx)).pendingCount).toBe(1);
  });

  it('a transient 5xx never spends the budget, so a flaky network cannot wedge the device', async () => {
    await seedPending([{ recordId: 'note-1', recordType: 'note', clientTs: 1, deleted: false, text: 'x' }]);
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url);
      if (u === '/api/sync/ops' && init?.method === 'POST') return new Response('busy', { status: 503 });
      throw new Error(`unexpected fetch: ${u} ${init?.method || 'GET'}`);
    }));

    for (let i = 0; i < WRITE_ERROR_BUDGET + 2; i++) await flushConfirmed(ctx);

    expect((await getSyncStatus(ctx)).wedged).toBe(false);
  });

  it('resetLocalSync clears local pending + records and rebuilds this device from the server snapshot', async () => {
    // A wedged device with an unsynced pending write and a stale local record.
    await seedPending(
      [{ recordId: 'note-stale', recordType: 'note', clientTs: 1, deleted: false, text: 'unsynced' }],
      { localLastSeq: 7, syncWedged: true, writeError: { status: 413, at: 1 }, writeErrorStreak: 3 },
    );

    // The server's compacted snapshot holds a different, canonical record set.
    const kData = await deriveKData(ctx.dek);
    const snapshotSeq = 42;
    const snapRecords = [{ recordId: 'bp-1', recordType: 'bp', clientTs: 10, deleted: false, systolic: 120 }];
    const snapPlain = new TextEncoder().encode(JSON.stringify(snapRecords));
    const { nonce, ct } = await encryptSnapshot({ kData, accountId, snapshotSeq, plaintext: snapPlain });
    const snapshotBody = JSON.stringify({ snapshot_seq: snapshotSeq, nonce: toBase64(nonce), ct: toBase64(new Uint8Array(ct)) });

    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url);
      if (u === '/api/sync/snapshot' && !init?.method) return new Response(snapshotBody, { status: 200 });
      if (u.startsWith('/api/sync/ops?')) return new Response(JSON.stringify({ ops: [], next: false }), { status: 200 });
      if (u === '/api/sync/snapshot' && init?.method === 'POST') return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch: ${u} ${init?.method || 'GET'}`);
    }));

    await resetLocalSync(ctx);

    const status = await getSyncStatus(ctx);
    expect(status.wedged).toBe(false); // sync_meta was wiped — the wedge is cleared
    expect(status.writeError).toBeNull();
    expect(status.pendingCount).toBe(0); // the unsynced local write was discarded by design
    // The local mirror now matches the server snapshot, not the pre-reset state.
    expect((await listRecords(ctx, 'note')).map((r) => r.recordId)).toEqual([]);
    expect((await listRecords(ctx, 'bp')).map((r) => r.recordId)).toEqual(['bp-1']);
  });
});

// med-0ol.8 — the full-vault CloudVault import must land as a SINGLE snapshot
// (replaceAllRecords + forceSnapshot), never as per-record oplog ops. forceSnapshot
// posts exactly one throwaway bump op to advance last_seq, then one gzip'd snapshot
// — a CONSTANT 2 requests regardless of vault size. A regression to per-op writes
// (thousands of POSTs) is exactly what would re-introduce the med-0ol import storm.
describe('full-vault import snapshots in a constant 2 requests, not per-record ops (med-0ol.8)', () => {
  let ctx;

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
  });

  it('a 1500-record import issues exactly 1 ops POST (bump) + 1 snapshot POST', async () => {
    // The import lands its whole record set locally, zero ops — exactly what
    // CloudVault.importAll does via replaceAllRecords before forceSnapshot.
    const records = Array.from({ length: 1500 }, (_, i) => ({
      recordId: `hrsample-${i}`, recordType: 'hrsample', clientTs: i + 1, deleted: false, v: i,
    }));
    await replaceAllRecords(records);
    // A wedged device (repeated permanent write errors) that recovers via import:
    // forceSnapshot must clear the wedge, or later writeRecords stay blocked (med-0ol.7).
    await seedMeta({ localLastSeq: 10, syncWedged: true, writeErrorStreak: 3 }); // bootstrapped device (import runs post-unlock)

    let opsPosts = 0;
    let snapshotPosts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url);
      if (u === '/api/sync/ops' && init?.method === 'POST') {
        opsPosts++;
        const { ops } = JSON.parse(init.body);
        return new Response(JSON.stringify({ assigned: ops.map((_, i) => 11 + i) }), { status: 200 });
      }
      if (u === '/api/sync/snapshot' && init?.method === 'POST') {
        snapshotPosts++;
        return new Response('{}', { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u} ${init?.method || 'GET'}`);
    }));

    await forceSnapshot(ctx);

    // Constant, NOT proportional to the 1500 records — proves no per-op fallback.
    expect(opsPosts).toBe(1);
    expect(snapshotPosts).toBe(1);
    // Import recovered the device: the wedge is cleared so writes sync again.
    expect((await getSyncStatus(ctx)).wedged).toBe(false);
  });
});

// med-yor.3 — a live openDb() handle must not block account-delete's verified
// deleteDatabase(): openDb registers onversionchange to auto-close itself.
describe('openDb auto-closes on versionchange (med-yor.3)', () => {
  it('a live connection does not block deleteDatabase', async () => {
    const db = await openDb();
    expect(typeof db.onversionchange).toBe('function');
    let blocked = false;
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('medtracker-cloud');
      req.onblocked = () => { blocked = true; };
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
    expect(blocked).toBe(false);
  });
});

// med-90w.1 Task 1 — sync.js reuses one shared IndexedDB connection via
// cachedDb() instead of open/close per call; a dropped connection resets the
// cache and fires listeners.
describe('cachedDb shared handle + drop-listener (med-90w.1)', () => {
  beforeEach(async () => {
    dropCachedDb();
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('medtracker-cloud');
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
  });

  it('returns the same handle identity across calls', async () => {
    const a = await cachedDb();
    const b = await cachedDb();
    expect(a).toBe(b);
  });

  it('returns a NEW handle after dropCachedDb()', async () => {
    const a = await cachedDb();
    dropCachedDb();
    const b = await cachedDb();
    expect(b).not.toBe(a);
  });

  it('fires onCachedDbDropped listeners on drop, and unsubscribe stops them', async () => {
    let fired = 0;
    const unsub = onCachedDbDropped(() => { fired += 1; });
    await cachedDb();
    dropCachedDb();
    expect(fired).toBe(1);
    unsub();
    await cachedDb();
    dropCachedDb();
    expect(fired).toBe(1);
  });

  it('drops the cache on versionchange so deleteDatabase is not blocked', async () => {
    let fired = 0;
    const unsub = onCachedDbDropped(() => { fired += 1; });
    await cachedDb();
    let blocked = false;
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('medtracker-cloud');
      req.onblocked = () => { blocked = true; };
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
    expect(blocked).toBe(false);
    expect(fired).toBe(1);
    unsub();
  });

  // med-4jf — a failed open must never stay cached: withDb awaits cachedDb()
  // OUTSIDE its try, so a cached rejection wedges every DB access for the page.
  it('retries the open after indexedDB.open throws SYNCHRONOUSLY', async () => {
    const spy = vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
      throw new DOMException('storage denied', 'SecurityError');
    });
    await expect(cachedDb()).rejects.toThrow('storage denied');
    spy.mockRestore();
    // Second call must re-open, not hand back the cached rejection.
    expect(await cachedDb()).toBeTruthy();
  });

  it('retries the open after the request fires onerror', async () => {
    const spy = vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
      const req = { error: new Error('open failed'), onupgradeneeded: null, onsuccess: null, onerror: null };
      setTimeout(() => req.onerror(), 0);
      return req;
    });
    await expect(cachedDb()).rejects.toThrow('open failed');
    spy.mockRestore();
    expect(await cachedDb()).toBeTruthy();
  });
});

// med-90w.1 Task 2 — sync.js routes every DB access through withDb, which reuses
// the cached handle and reopens once on InvalidStateError. A read must survive
// the handle being closed out from under it.
describe('withDb reopens the cached handle after an external close (med-90w.1)', () => {
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
    dropCachedDb();
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('medtracker-cloud');
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
  });

  it('listRecords still succeeds after the cached handle is externally closed', async () => {
    await seed([
      { recordId: 'bp-1', recordType: 'bp', clientTs: 100, deleted: false, systolic: 120 },
      { recordId: 'w-1', recordType: 'weight', clientTs: 100, deleted: false, kg: 70 },
    ]);
    // First read opens and caches the shared handle (and memoizes 'bp').
    expect((await listRecords({}, 'bp')).map((r) => r.recordId)).toEqual(['bp-1']);
    // Close it out from under sync.js without going through dropCachedDb — the
    // cache still points at a now-dead connection, so the next transaction()
    // throws InvalidStateError and withDb must transparently reopen.
    (await cachedDb()).close();
    // Read a type that was NEVER listed, so this is a memo MISS that actually
    // reaches withDb and drives the closed handle into the reopen guard — a
    // 'bp' re-read would be served from the memo and never touch the DB.
    expect((await listRecords({}, 'weight')).map((r) => r.recordId)).toEqual(['w-1']);
  });
});

// med-90w.1 Task 3 — the plaintext records memo. listRecords fires ~8+ times per
// section-open; each used to re-open IDB and getAll+clone+filter+sort a type's
// whole history. A module-level Map serves repeat reads from memory, invalidated
// PRECISELY at every physical write funnel. A stale memo shows wrong health data,
// so invalidation completeness is the whole ballgame.
describe('plaintext records memo (med-90w.1)', () => {
  const accountId = 'acct-memo';

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

  // Bootstrapped device: an empty snapshot GET is never reached (cursor already
  // known); the tail GET replays `pulledOps`, and any flush POST assigns seqs.
  const stubSync = (pulledOps = []) => {
    let assignNext = 100;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url);
      if (u === '/api/sync/snapshot' && !init?.method) return new Response(null, { status: 204 });
      if (u.startsWith('/api/sync/ops?')) {
        const ops = pulledOps.splice(0, pulledOps.length);
        return new Response(JSON.stringify({ ops, next: false }), { status: 200 });
      }
      if (u === '/api/sync/ops' && init?.method === 'POST') {
        const { ops } = JSON.parse(init.body);
        return new Response(JSON.stringify({ assigned: ops.map(() => assignNext++) }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u} ${init?.method || 'GET'}`);
    }));
  };

  let ctx;
  beforeEach(async () => {
    // dropCachedDb() fires onCachedDbDropped → clears the module-level memo +
    // bootstrapped flag, so no state leaks between tests.
    dropCachedDb();
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('medtracker-cloud');
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
    ctx = { accountId, dek: await generateDEK() };
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('repeat list(type) hits memory: only ONE index getAll, identical result', async () => {
    stubSync();
    await seed([
      { recordId: 'bp-1', recordType: 'bp', clientTs: 100, deleted: false, systolic: 120 },
      { recordId: 'bp-2', recordType: 'bp', clientTs: 300, deleted: false, systolic: 130 },
    ]);
    const indexGetAll = vi.spyOn(IDBIndex.prototype, 'getAll');

    const first = await listRecords(ctx, 'bp');
    const second = await listRecords(ctx, 'bp');
    const third = await listRecords(ctx, 'bp');

    expect(indexGetAll).toHaveBeenCalledTimes(1);
    expect(first.map((r) => r.recordId)).toEqual(['bp-2', 'bp-1']);
    expect(second.map((r) => r.recordId)).toEqual(['bp-2', 'bp-1']);
    expect(third.map((r) => r.recordId)).toEqual(['bp-2', 'bp-1']);
    // Each caller gets its own array — mutating one must not corrupt the cache.
    expect(second).not.toBe(first);
  });

  it('(a) a same-type write invalidates the memo', async () => {
    stubSync();
    await seed([{ recordId: 'bp-1', recordType: 'bp', clientTs: 100, deleted: false, systolic: 120 }]);
    expect((await listRecords(ctx, 'bp')).map((r) => r.recordId)).toEqual(['bp-1']);

    await writeRecord(ctx, 'bp', { recordId: 'bp-2', clientTs: 200, deleted: false, systolic: 130 });

    expect((await listRecords(ctx, 'bp')).map((r) => r.recordId)).toEqual(['bp-2', 'bp-1']);
  });

  it('(b) an inbound sync apply of a previously-listed type is reflected', async () => {
    await seed([{ recordId: 'bp-1', recordType: 'bp', clientTs: 100, deleted: false, systolic: 120 }]);
    // List first so 'bp' is memoized before the inbound op lands.
    expect((await listRecords(ctx, 'bp')).map((r) => r.recordId)).toEqual(['bp-1']);

    const kData = await deriveKData(ctx.dek);
    const seal = async (recordType, recordId, seq, record) => {
      const { nonce, ct } = await encryptRecord({
        kData, accountId, recordType, recordId, seq,
        plaintext: new TextEncoder().encode(JSON.stringify(record)),
      });
      return { seq, record_type_tag: `${recordType}:${recordId}`, nonce: toBase64(nonce), ct: toBase64(new Uint8Array(ct)) };
    };
    stubSync([await seal('bp', 'bp-2', 6, { recordId: 'bp-2', clientTs: 200, deleted: false, systolic: 140 })]);

    await pullOnOpen(ctx);

    expect((await listRecords(ctx, 'bp')).map((r) => r.recordId)).toEqual(['bp-2', 'bp-1']);
  });

  it('(c) replaceAllRecords import supersedes the pre-import memo', async () => {
    stubSync();
    await seed([{ recordId: 'note-1', recordType: 'note', clientTs: 100, deleted: false, text: 'old' }]);
    expect((await listRecords(ctx, 'note')).map((r) => r.text)).toEqual(['old']);

    await replaceAllRecords([{ recordId: 'note-9', recordType: 'note', clientTs: 500, deleted: false, text: 'imported' }]);

    expect((await listRecords(ctx, 'note')).map((r) => r.text)).toEqual(['imported']);
  });

  it('(d) cross-type isolation: writing weight neither serves stale bp nor evicts bp', async () => {
    stubSync();
    await seed([
      { recordId: 'bp-1', recordType: 'bp', clientTs: 100, deleted: false, systolic: 120 },
      { recordId: 'w-1', recordType: 'weight', clientTs: 100, deleted: false, weight: 80 },
    ]);
    await listRecords(ctx, 'bp'); // memoize bp
    const indexGetAll = vi.spyOn(IDBIndex.prototype, 'getAll');

    await writeRecord(ctx, 'weight', { recordId: 'w-2', clientTs: 200, deleted: false, weight: 81 });

    // bp memo untouched by the weight write — second bp list is a pure hit.
    expect((await listRecords(ctx, 'bp')).map((r) => r.recordId)).toEqual(['bp-1']);
    expect(indexGetAll).not.toHaveBeenCalled();
    // weight reflects the new row (its own memo was invalidated).
    expect((await listRecords(ctx, 'weight')).map((r) => r.recordId)).toEqual(['w-2', 'w-1']);
  });

  it('(e) resetLocalSync clears every type; re-bootstrap reflects the server snapshot', async () => {
    await seed([{ recordId: 'bp-1', recordType: 'bp', clientTs: 100, deleted: false, systolic: 120 }]);
    expect((await listRecords(ctx, 'bp')).map((r) => r.recordId)).toEqual(['bp-1']);

    // Reset wipes local + re-bootstraps from a snapshot carrying a different row.
    const kData = await deriveKData(ctx.dek);
    const snapRecords = [{ recordId: 'bp-server', recordType: 'bp', clientTs: 900, deleted: false, systolic: 111 }];
    const { nonce, ct } = await encryptSnapshot({
      kData, accountId, snapshotSeq: 10,
      plaintext: new TextEncoder().encode(JSON.stringify(snapRecords)),
    });
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url);
      if (u === '/api/sync/snapshot' && !init?.method) {
        return new Response(JSON.stringify({ snapshot_seq: 10, nonce: toBase64(nonce), ct: toBase64(new Uint8Array(ct)) }), { status: 200 });
      }
      if (u.startsWith('/api/sync/ops?')) return new Response(JSON.stringify({ ops: [], next: false }), { status: 200 });
      throw new Error(`unexpected fetch: ${u} ${init?.method || 'GET'}`);
    }));

    await resetLocalSync(ctx);

    expect((await listRecords(ctx, 'bp')).map((r) => r.recordId)).toEqual(['bp-server']);
  });

  it('getRecordsChangeCount is monotonic: bumps on each write path, unchanged by a pure read', async () => {
    stubSync();
    await seed([{ recordId: 'bp-1', recordType: 'bp', clientTs: 100, deleted: false, systolic: 120 }]);

    await listRecords(ctx, 'bp'); // pure read
    const afterRead = getRecordsChangeCount();
    await listRecords(ctx, 'bp'); // pure read (memo hit)
    expect(getRecordsChangeCount()).toBe(afterRead);

    await writeRecord(ctx, 'bp', { recordId: 'bp-2', clientTs: 200, deleted: false, systolic: 130 });
    const afterPut = getRecordsChangeCount();
    expect(afterPut).toBeGreaterThan(afterRead);

    await replaceAllRecords([{ recordId: 'bp-3', recordType: 'bp', clientTs: 300, deleted: false, systolic: 140 }]);
    expect(getRecordsChangeCount()).toBeGreaterThan(afterPut);
  });
});

// med-qhpu — a derived row (a read path materializing into a deterministic
// recordId) is stamped clientTs: 0 so it loses every LWW merge against a real
// write. That floor was NOT enough on the local write path: writeRecord's
// nextClientTs promotes any write to `existing.clientTs + 1` when a raw row —
// tombstone included — already occupies the slot, which is exactly how a stale
// device's placeholder ends up outranking the completed workout it should have
// lost to (bd med-9a87). recordsPort.putIfAbsent is the fix: write only into an
// EMPTY raw slot, stamp verbatim, and hand back the stored winner.
describe('derived writes are put-if-absent, not floor-then-hope (med-qhpu)', () => {
  const accountId = 'acct-qhpu';
  const SLOT = 'session-7-2026-08-31';

  const seed = async (records, meta = { localLastSeq: 5, lastSnapshotSeq: 0 }) => {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['records', 'sync_meta'], 'readwrite');
        for (const r of records) tx.objectStore('records').put(r);
        for (const [k, v] of Object.entries(meta)) tx.objectStore('sync_meta').put(v, k);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  };

  const getRaw = async (recordId) => {
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

  let ctx;
  let posted;
  let pulledOps;

  const derived = (extra = {}) => ({
    recordId: SLOT, clientTs: 0, deleted: false, id: 1000000000001, status: 'pending', ...extra,
  });

  beforeEach(async () => {
    dropCachedDb();
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('medtracker-cloud');
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
    ctx = { accountId, dek: await generateDEK() };
    posted = [];
    pulledOps = [];
    let assignNext = 100;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url);
      if (u === '/api/sync/snapshot' && !init?.method) return new Response(null, { status: 204 });
      if (u.startsWith('/api/sync/ops?')) {
        const ops = pulledOps.splice(0, pulledOps.length);
        return new Response(JSON.stringify({ ops, next: false }), { status: 200 });
      }
      if (u === '/api/sync/ops' && init?.method === 'POST') {
        const { ops } = JSON.parse(init.body);
        posted.push(...ops.map((o) => o.record_type_tag));
        return new Response(JSON.stringify({ assigned: ops.map(() => assignNext++) }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u} ${init?.method || 'GET'}`);
    }));
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('writes an empty slot verbatim — the floor survives, un-skewed', async () => {
    // A learned clock skew must NOT shift a derived stamp: two devices deriving
    // the same slot have to produce byte-identical bodies (bd med-8j12), and
    // `0 - skewMs` is not.
    await seed([], { localLastSeq: 5, lastSnapshotSeq: 0, clockSkewMs: 10 * 60 * 1000 });

    const stored = await recordsPort(ctx).putIfAbsent('workoutsession', derived());

    expect(stored.clientTs).toBe(0);
    expect((await getRaw(SLOT)).clientTs).toBe(0);
    expect((await getRaw(SLOT)).status).toBe('pending');
  });

  it('a TOMBSTONE counts as occupied: no write, no promotion, no oplog op', async () => {
    await seed([{ recordId: SLOT, recordType: 'workoutsession', clientTs: 7000, deleted: true }]);

    const stored = await recordsPort(ctx).putIfAbsent('workoutsession', derived());

    // Pre-fix this came back at 7001 — promoted above the tombstone and above
    // every real write a peer had made since.
    expect(stored.deleted).toBe(true);
    expect(stored.clientTs).toBe(7000);
    const raw = await getRaw(SLOT);
    expect(raw.deleted).toBe(true);
    expect(raw.clientTs).toBe(7000);
    expect(posted).toEqual([]); // nothing changed, so nothing to push
  });

  it('a real row already in the slot is returned untouched', async () => {
    await seed([{
      recordId: SLOT, recordType: 'workoutsession', clientTs: 9000, deleted: false,
      id: 42, status: 'completed',
    }]);

    const stored = await recordsPort(ctx).putIfAbsent('workoutsession', derived());

    expect(stored.status).toBe('completed');
    expect(stored.id).toBe(42);
    expect((await getRaw(SLOT)).status).toBe('completed');
    expect(posted).toEqual([]);
  });

  it('a plain put of the same body IS still promoted — that is the contrast', async () => {
    await seed([{ recordId: SLOT, recordType: 'workoutsession', clientTs: 7000, deleted: true }]);

    // Guard 2 is intact for REAL writes: an edit of a record you can see must
    // outrank the version it replaces. Only derived writes opt out.
    const stored = await recordsPort(ctx).put('workoutsession', derived());

    expect(stored.clientTs).toBe(7001);
    expect((await getRaw(SLOT)).status).toBe('pending');
  });

  it('a materialization racing an incoming completed row keeps the completed row', async () => {
    await seed([]);
    const kData = await deriveKData(ctx.dek);
    const completed = { recordId: SLOT, clientTs: 9000, deleted: false, id: 42, status: 'completed' };
    const { nonce, ct } = await encryptRecord({
      kData, accountId, recordType: 'workoutsession', recordId: SLOT, seq: 6,
      plaintext: new TextEncoder().encode(JSON.stringify(completed)),
    });
    pulledOps.push({
      seq: 6, record_type_tag: `workoutsession:${SLOT}`,
      nonce: toBase64(nonce), ct: toBase64(new Uint8Array(ct)),
    });

    // applyIncoming and writeRecord share withRecordsLock, so the two get/put
    // pairs cannot interleave. Whichever wins the lock, the completed row is the
    // survivor: it either blocks the put-if-absent outright, or lands on top of a
    // floored placeholder that cannot outrank it.
    await Promise.all([
      pullOnOpen(ctx),
      recordsPort(ctx).putIfAbsent('workoutsession', derived()),
    ]);

    const raw = await getRaw(SLOT);
    expect(raw.status).toBe('completed');
    expect(raw.clientTs).toBe(9000);
    expect(raw.id).toBe(42);
  });
});
