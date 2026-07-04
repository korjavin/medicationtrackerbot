import { describe, expect, it } from 'vitest';
import { deriveKData, encryptRecord, decryptRecord, encryptSnapshot, decryptSnapshot, generateDEK } from '../crypto.js';

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
