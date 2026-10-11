import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditEnvelope,
  auditEnvelopeWithKey,
  decryptRecord,
  decryptSnapshot,
  deriveDataKeys,
  deriveKData,
  encryptRecord,
  encryptSnapshot,
  decryptSharePayload,
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
  fromBase64Url,
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

// Blind workout-share short link (bd med-1yi5): AES-128-GCM, K = 16 raw
// bytes, nonce ‖ ciphertext packing, AAD utf8('mt/v1/share'). Golden vector
// from the epic (produced with WebCrypto): K = bytes 00 11 22 .. ff,
// nonce = bytes 01..0c.
describe('decryptSharePayload (med-1yi5)', () => {
  const GOLDEN_K = 'ABEiM0RVZneImaq7zN3u_w';
  const GOLDEN_PLAINTEXT =
    'p1.H4sIAAAAAAAAA6tWSkksSVSyUlAqSy0qzszPU9JRUEpJLElUslIqTUlXqgUAcx1dxx4AAAA';
  const GOLDEN_PACKED =
    'AQIDBAUGBwgJCgsMlrcA1gUMJUwCZ2azpTvldqBeivRyBn8Egd/HzcfKBxiMz6ddeZ1b7GVg3mXNe+7fy4twqSSKFUK2gukPwV4h5cTEpgLiSx4+ugIkgK12YG+cp1M3fJstai2c';

  it('decrypts the golden packed blob to the exact golden plaintext', async () => {
    const pt = await decryptSharePayload(fromBase64Url(GOLDEN_K), fromBase64(GOLDEN_PACKED));
    expect(new TextDecoder().decode(pt)).toBe(GOLDEN_PLAINTEXT);
  });

  it('throws on a flipped packed byte (AEAD failure)', async () => {
    const packed = fromBase64(GOLDEN_PACKED);
    packed[20] ^= 0xff;
    await expect(decryptSharePayload(fromBase64Url(GOLDEN_K), packed)).rejects.toThrow();
  });

  it('throws under the wrong key', async () => {
    const wrong = fromBase64Url(GOLDEN_K).slice();
    wrong[0] ^= 0x01;
    await expect(decryptSharePayload(wrong, fromBase64(GOLDEN_PACKED))).rejects.toThrow();
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

// bd med-5h1t.2: leaf keys moved from raw HKDF bytes (deriveKData/deriveKMac,
// imported per op) to non-extractable CryptoKeys (deriveDataKeys). Every
// ciphertext and envelope MAC already in the wild was made by the old path, so
// both directions must interoperate byte-for-byte.
describe('deriveDataKeys interop with the raw-bytes derivation', () => {
  // Known-answer vector produced by the pre-change raw-bytes crypto.js
  // (deriveKData + byte-key AES-GCM, deriveKMac + computeEnvelopeMac).
  const KAT = {
    dek: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
    kData: 'KIWB7gOhiYi5yOrl0JIBzWrTF4W3fHeQ3NmUzThHjao=',
    record: { nonce: '+W4HOjdUTHvMK6Ll', ct: 'WHMQY5v3qCSN1wakGNariRqj8Vge3Xl7oder' },
    snapshot: { nonce: 'Beutn/uRtWywnyt9', ct: 'GcV21lkO+ZJ3qNZAYFyUeBEm4Uk6GtquBd7sIC4yTOYPijHohD9S' },
    envMac: '4Ru1yU+eVCfhZv4Yccgz8l7OlIQzqX6IIQg944RNOT8=',
  };
  const dec = (b) => new TextDecoder().decode(b);
  const seq8 = (n) => { const o = new Uint8Array(8); new DataView(o.buffer).setBigUint64(0, BigInt(n), false); return o; };
  const recAad = (recordId, seq) => encodeFields('mt/v1/rec', accountId, 'note', recordId, seq8(seq));
  const snapAad = (seq) => encodeFields('mt/v1/snap', accountId, seq8(seq));
  // The old path: raw K_data bytes imported per call.
  const rawKey = (bytes, usage) => crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [usage]);
  async function rawEncrypt(kDataBytes, aad, plaintext) {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, await rawKey(kDataBytes, 'encrypt'), plaintext));
    return { nonce, ct };
  }
  async function rawDecrypt(kDataBytes, aad, nonce, ct) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, await rawKey(kDataBytes, 'decrypt'), ct));
  }

  it('derives the same K_data bytes as before (raw path pinned)', async () => {
    expect(toBase64(await deriveKData(fromBase64(KAT.dek)))).toBe(KAT.kData);
  });

  it('decrypts a record and a snapshot encrypted by the old raw-bytes path (known answer)', async () => {
    const { kData } = await deriveDataKeys(fromBase64(KAT.dek));
    const rec = await decryptRecord({ kData, accountId, recordType: 'note', recordId: 'note-1', seq: 7, nonce: fromBase64(KAT.record.nonce), ct: fromBase64(KAT.record.ct) });
    expect(dec(rec)).toBe('hello vault');
    const snap = await decryptSnapshot({ kData, accountId, snapshotSeq: 500, nonce: fromBase64(KAT.snapshot.nonce), ct: fromBase64(KAT.snapshot.ct) });
    expect(dec(snap)).toBe('[{"recordId":"note-1"}]');
  });

  it('verifies an envelope MAC minted by the raw K_mac path, and rejects a tampered one', async () => {
    const { kMac } = await deriveDataKeys(fromBase64(KAT.dek));
    const envelope = { nonce: new Uint8Array(12).fill(9), ct: new Uint8Array(48).fill(3), mac: fromBase64(KAT.envMac) };
    expect(await auditEnvelopeWithKey({ kMac, envelope, credentialId })).toBe(true);
    const bad = { ...envelope, mac: envelope.mac.slice() };
    bad.mac[0] ^= 1;
    expect(await auditEnvelopeWithKey({ kMac, envelope: bad, credentialId })).toBe(false);
    expect(await auditEnvelope({ dek: fromBase64(KAT.dek), envelope, credentialId })).toBe(true);
  });

  it('round-trips records old->new and new->old for a fresh DEK', async () => {
    const dek = generateDEK();
    const kDataBytes = await deriveKData(dek);
    const { kData } = await deriveDataKeys(dek);
    const plaintext = utf8Bytes('{"recordId":"note-9","clientTs":1}');

    const old = await rawEncrypt(kDataBytes, recAad('note-9', 42), plaintext);
    expect(dec(await decryptRecord({ kData, accountId, recordType: 'note', recordId: 'note-9', seq: 42, ...old }))).toBe(dec(plaintext));

    const fresh = await encryptRecord({ kData, accountId, recordType: 'note', recordId: 'note-9', seq: 42, plaintext });
    expect(dec(await rawDecrypt(kDataBytes, recAad('note-9', 42), fresh.nonce, fresh.ct))).toBe(dec(plaintext));
  });

  it('the golden vault fixture (tests/fixtures/vault-v1.json) survives a snapshot round trip across both paths', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const fixture = fs.readFileSync(path.join(root, 'tests/fixtures/vault-v1.json'));
    const plaintext = await gzip(new Uint8Array(fixture));
    const dek = generateDEK();
    const kDataBytes = await deriveKData(dek);
    const { kData } = await deriveDataKeys(dek);

    const old = await rawEncrypt(kDataBytes, snapAad(11), plaintext);
    const viaNew = await gunzip(await decryptSnapshot({ kData, accountId, snapshotSeq: 11, ...old }));
    expect(JSON.parse(dec(viaNew))).toEqual(JSON.parse(dec(fixture)));

    const fresh = await encryptSnapshot({ kData, accountId, snapshotSeq: 11, plaintext });
    const viaOld = await gunzip(await rawDecrypt(kDataBytes, snapAad(11), fresh.nonce, fresh.ct));
    expect(JSON.parse(dec(viaOld))).toEqual(JSON.parse(dec(fixture)));
  });

  it('leaf keys are non-extractable with least-privilege usages', async () => {
    const { kData, kMac } = await deriveDataKeys(generateDEK());
    expect(kData.extractable).toBe(false);
    expect(kMac.extractable).toBe(false);
    expect([...kData.usages].sort()).toEqual(['decrypt', 'encrypt']);
    expect(kMac.usages).toEqual(['verify']);
    expect(kMac.algorithm.length).toBe(256);
    await expect(crypto.subtle.exportKey('raw', kData)).rejects.toThrow();
  });
});

function utf8Bytes(s) {
  return new TextEncoder().encode(s);
}
