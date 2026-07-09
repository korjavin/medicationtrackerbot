import { describe, expect, it } from 'vitest';
import {
  auditEnvelope,
  decryptTransferPayload,
  deriveKEK,
  deriveKEKRec,
  deriveKMac,
  deriveVerifier,
  encryptTransferPayload,
  generateDEK,
  generateRecoveryCode,
  gunzip,
  gzip,
  isGzip,
  parseRecoveryCode,
  unwrapEnvelope,
  wrapEnvelope
} from '../crypto.js';

const accountId = 'amber-falcon-8k3q9x';
const credentialId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

async function makeEnvelope() {
  const prfOutput = crypto.getRandomValues(new Uint8Array(32));
  const dek = generateDEK();
  const kek = await deriveKEK(prfOutput, accountId, credentialId);
  const kMac = await deriveKMac(dek);
  const envelope = await wrapEnvelope({ kek, dek, kMac, accountId, credentialId });
  return { prfOutput, dek, kek, kMac, envelope };
}

describe('cloud crypto suite v1', () => {
  it('wraps and unwraps the DEK round-trip', async () => {
    const { dek, kek, envelope } = await makeEnvelope();
    const recovered = await unwrapEnvelope({ kek, envelope, accountId, credentialId });
    expect(Array.from(recovered)).toEqual(Array.from(dek));
  });

  it('passes the envelope-audit MAC check with the correct DEK', async () => {
    const { dek, envelope } = await makeEnvelope();
    const valid = await auditEnvelope({ dek, envelope, credentialId });
    expect(valid).toBe(true);
  });

  it('throws on a tampered ciphertext byte (AEAD failure)', async () => {
    const { kek, envelope } = await makeEnvelope();
    const tampered = { ...envelope, ct: envelope.ct.slice() };
    tampered.ct[0] ^= 0xff;
    await expect(unwrapEnvelope({ kek, envelope: tampered, accountId, credentialId })).rejects.toThrow();
  });

  it('throws on a tampered AAD (wrong account id)', async () => {
    const { kek, envelope } = await makeEnvelope();
    await expect(
      unwrapEnvelope({ kek, envelope, accountId: 'someone-else', credentialId })
    ).rejects.toThrow();
  });

  it('fails the audit MAC when the envelope was forged without the DEK', async () => {
    const { envelope } = await makeEnvelope();
    const forgedDek = generateDEK();
    const valid = await auditEnvelope({ dek: forgedDek, envelope, credentialId });
    expect(valid).toBe(false);
  });

  it('derives independent KEK_rec and verifier from the same recovery code (domain separation)', async () => {
    const { codeBytes } = await generateRecoveryCode();
    const kekRec = await deriveKEKRec(codeBytes, accountId);
    const verifier = await deriveVerifier(codeBytes, accountId);
    expect(Array.from(kekRec)).not.toEqual(Array.from(verifier));
  });

  it('round-trips a formatted recovery code through parseRecoveryCode', async () => {
    const { codeBytes, formatted } = await generateRecoveryCode();
    expect(formatted).toMatch(/^([0-9A-Z]{4}-){8}[0-9A-Z]{4}$/);
    const parsed = await parseRecoveryCode(formatted);
    expect(Array.from(parsed)).toEqual(Array.from(codeBytes));
  });

  it('tolerates Crockford transcription typos (O/I/L) in the checksum group', async () => {
    // The code body already normalizes O→0 / I,L→1 via base32Decode; the
    // checksum group must too. Find a code whose checksum contains a 0 or 1,
    // substitute its typo-alias, and confirm parse still accepts it.
    const alias = { 0: 'O', 1: 'L' };
    for (let i = 0; i < 100; i++) {
      const { codeBytes, formatted } = await generateRecoveryCode();
      const groups = formatted.split('-');
      const checksum = groups[8];
      const idx = [...checksum].findIndex((c) => alias[c]);
      if (idx === -1) continue;
      groups[8] = checksum.slice(0, idx) + alias[checksum[idx]] + checksum.slice(idx + 1);
      const parsed = await parseRecoveryCode(groups.join('-'));
      expect(Array.from(parsed)).toEqual(Array.from(codeBytes));
      return;
    }
    throw new Error('no checksum with a 0/1 char found in 100 tries');
  });

  it('rejects a recovery code with a corrupted checksum group', async () => {
    const { formatted } = await generateRecoveryCode();
    const groups = formatted.split('-');
    const lastChar = groups[8][0];
    groups[8] = (lastChar === '0' ? '1' : '0') + groups[8].slice(1);
    await expect(parseRecoveryCode(groups.join('-'))).rejects.toThrow(/checksum/);
  });

  it('round-trips a device-transfer payload under TK', async () => {
    const tk = crypto.getRandomValues(new Uint8Array(32));
    const dek = generateDEK();
    const packed = await encryptTransferPayload(tk, dek, accountId);
    const recovered = await decryptTransferPayload(tk, packed, accountId);
    expect(Array.from(recovered)).toEqual(Array.from(dek));
  });

  it('rejects a device-transfer payload under the wrong TK (AEAD failure)', async () => {
    const tk = crypto.getRandomValues(new Uint8Array(32));
    const wrongTk = crypto.getRandomValues(new Uint8Array(32));
    const dek = generateDEK();
    const packed = await encryptTransferPayload(tk, dek, accountId);
    await expect(decryptTransferPayload(wrongTk, packed, accountId)).rejects.toThrow();
  });
});

// Snapshot gzip helpers: the decrypt path sniffs the gzip magic bytes to decide
// whether to gunzip, with no wire field — so a wrong sniff silently corrupts
// every bootstrap. These pin the round-trip and the magic-byte discrimination.
describe('snapshot gzip (web/cloud/js/crypto.js gzip/gunzip/isGzip)', () => {
  it('round-trips arbitrary bytes through gzip -> gunzip', async () => {
    const records = Array.from({ length: 500 }, (_, i) => ({ recordId: `note-${i}`, text: `dose ${i}` }));
    const bytes = new TextEncoder().encode(JSON.stringify(records));
    const round = await gunzip(await gzip(bytes));
    expect(new TextDecoder().decode(round)).toBe(new TextDecoder().decode(bytes));
  });

  it('round-trips the empty-records edge case', async () => {
    const bytes = new TextEncoder().encode('[]');
    expect(new TextDecoder().decode(await gunzip(await gzip(bytes)))).toBe('[]');
  });

  it('isGzip is true for gzip output and false for raw JSON snapshots', async () => {
    const gzipped = await gzip(new TextEncoder().encode('[]'));
    expect(isGzip(gzipped)).toBe(true);
    expect(gzipped[0]).toBe(0x1f);
    expect(gzipped[1]).toBe(0x8b);
    // Legacy uncompressed snapshots start with '[' (0x5b) or '{' (0x7b).
    expect(isGzip(new TextEncoder().encode('[{"recordId":"note-1"}]'))).toBe(false);
    expect(isGzip(new TextEncoder().encode('{}'))).toBe(false);
    expect(isGzip(new Uint8Array([0x1f]))).toBe(false); // too short to sniff
  });
});
