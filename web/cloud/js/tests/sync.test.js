import 'fake-indexeddb/auto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { deriveKData, encryptRecord, decryptRecord, encryptSnapshot, decryptSnapshot, generateDEK } from '../crypto.js';
import { listRecords, listRecordsInRange, readAllLiveRecords } from '../sync.js';
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
