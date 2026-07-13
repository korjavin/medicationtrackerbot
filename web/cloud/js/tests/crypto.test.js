import { describe, expect, it } from 'vitest';
import {
  auditEnvelope,
  decryptTransferPayload,
  deriveKEK,
  deriveKEKRec,
  deriveKMac,
  deriveVerifier,
  encodeFields,
  encryptTransferPayload,
  generateDEK,
  generateRecoveryCode,
  gunzip,
  gzip,
  isGzip,
  parseRecoveryCode,
  toBase64,
  toBase64Url,
  fromBase64,
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

describe('encodeFields length guard', () => {
  it('accepts a field at the uint16 ceiling and rejects one past it', () => {
    expect(() => encodeFields(new Uint8Array(0xffff))).not.toThrow();
    expect(() => encodeFields(new Uint8Array(0x10000))).toThrow(RangeError);
  });
});

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

// med-9z3.8 — toBase64 sits on the snapshot upload path (snapshotAt -> toBase64(ct)),
// so it runs on every import and every compaction. It used to grow the binary
// string one char at a time (1096 ms per 24.5 MiB). Both the native path and the
// chunked fallback must agree with each other and with Go's encoding/base64.
describe('toBase64 (med-9z3.8)', () => {
  const withoutNative = (fn) => {
    const native = Uint8Array.prototype.toBase64;
    // eslint-disable-next-line no-extend-native
    if (native) delete Uint8Array.prototype.toBase64;
    try {
      return fn();
    } finally {
      // eslint-disable-next-line no-extend-native
      if (native) Uint8Array.prototype.toBase64 = native;
    }
  };

  // getRandomValues caps at 65,536 bytes, and a deterministic fill makes a
  // failure reproducible anyway. Every byte value recurs, so a mangled chunk
  // seam shows up as a base64 mismatch.
  const filled = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + (i >> 8)) & 0xff);

  const cases = [
    ['empty', new Uint8Array(0)],
    ['1 byte', new Uint8Array([0])],
    ['every byte value', Uint8Array.from({ length: 256 }, (_, i) => i)],
    // Straddle the 0x8000 chunk boundary: an off-by-one there corrupts the
    // base64 mid-stream, and .apply() past ~65k args throws RangeError.
    ['chunk boundary - 1', filled(0x8000 - 1)],
    ['chunk boundary', filled(0x8000)],
    ['chunk boundary + 1', filled(0x8000 + 1)],
    ['multi-chunk, not a multiple of 3', filled(0x8000 * 2 + 7)],
  ];

  for (const [name, bytes] of cases) {
    it(`matches Go's base64 and round-trips: ${name}`, () => {
      const expected = Buffer.from(bytes).toString('base64');
      expect(toBase64(bytes)).toBe(expected);
      expect(withoutNative(() => toBase64(bytes))).toBe(expected);
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    });
  }

  it('the chunked fallback agrees with the native method on a snapshot-sized buffer', () => {
    const bytes = filled(1 << 20);
    expect(withoutNative(() => toBase64(bytes))).toBe(toBase64(bytes));
  });

  it('toBase64Url still produces unpadded base64url over the fast path', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe, 0x00]);
    expect(toBase64(bytes)).toBe('+//+AA==');
    expect(toBase64Url(bytes)).toBe('-__-AA');
    expect(withoutNative(() => toBase64Url(bytes))).toBe('-__-AA');
  });
});
