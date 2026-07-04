import { describe, expect, it } from 'vitest';
import {
  auditEnvelope,
  deriveKEK,
  deriveKEKRec,
  deriveKMac,
  deriveVerifier,
  generateDEK,
  generateRecoveryCode,
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

  it('rejects a recovery code with a corrupted checksum group', async () => {
    const { formatted } = await generateRecoveryCode();
    const groups = formatted.split('-');
    const lastChar = groups[8][0];
    groups[8] = (lastChar === '0' ? '1' : '0') + groups[8].slice(1);
    await expect(parseRecoveryCode(groups.join('-'))).rejects.toThrow(/checksum/);
  });
});
