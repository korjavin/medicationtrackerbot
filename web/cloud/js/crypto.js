// Suite v1 client crypto — see docs/cloud-crypto.md "Exact formats". Pure
// WebCrypto (crypto.subtle), no DOM. Every export takes/returns
// Uint8Array/plain objects so it can be unit-tested under Node and reused
// from signup.js/unlock.js without a bundler.

export const SUITE_VERSION = 1;

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// Crockford base32 treats these as human-transcription typos of a canonical symbol.
const CROCKFORD_NORMALIZE = { O: '0', I: '1', L: '1' };

export function utf8(str) {
  return new TextEncoder().encode(str);
}

// Standard base64 (with padding) — matches Go's encoding/json []byte
// marshaling, used for the envelope wire fields (nonce/ct/mac).
export function toBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// base64url (unpadded) — matches the server's credential_ref path segment
// (base64.RawURLEncoding) and WebAuthn's JSON encoding of binary fields.
export function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(str) {
  const padded = str + '='.repeat((4 - (str.length % 4)) % 4);
  return fromBase64(padded.replace(/-/g, '+').replace(/_/g, '/'));
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// uint16-BE length ‖ bytes per field, concatenated in argument order.
export function encodeFields(...parts) {
  const fields = parts.map((part) => (part instanceof Uint8Array ? part : utf8(part)));
  const total = fields.reduce((n, f) => n + 2 + f.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const f of fields) {
    new DataView(out.buffer).setUint16(offset, f.length, false);
    out.set(f, offset + 2);
    offset += 2 + f.length;
  }
  return out;
}

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += CROCKFORD_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const rawChar of str.toUpperCase()) {
    const ch = CROCKFORD_NORMALIZE[rawChar] || rawChar;
    const idx = CROCKFORD_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('invalid recovery code character: ' + rawChar);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function hkdf(ikm, salt, info, lengthBytes = 32) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    lengthBytes * 8
  );
  return new Uint8Array(bits);
}

async function aesGcmEncrypt(rawKey, nonce, plaintext, aad) {
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, plaintext);
  return new Uint8Array(ct);
}

async function aesGcmDecrypt(rawKey, nonce, ciphertext, aad) {
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, ciphertext);
  return new Uint8Array(pt);
}

export async function saltKek() {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', utf8('medtracker/v1/prf-kek')));
}

export function generateDEK() {
  return crypto.getRandomValues(new Uint8Array(32));
}

// KEK_i = HKDF(ikm = PRF_i, salt = account_id, info = "mt/v1/kek" ‖ credential_id_i)
export async function deriveKEK(prfOutput, accountId, credentialId) {
  const info = encodeFields('mt/v1/kek', credentialId);
  return hkdf(prfOutput, utf8(accountId), info);
}

// K_mac = HKDF(DEK, info="mt/v1/envmac") — derived only after DEK is known,
// so a party that can't unwrap any envelope can't mint a valid audit tag.
export async function deriveKMac(dek) {
  return hkdf(dek, new Uint8Array(0), utf8('mt/v1/envmac'));
}

export async function computeEnvelopeMac(kMac, credentialId, nonce, ct) {
  const data = encodeFields('mt/v1/envmac', credentialId, nonce, ct);
  const key = await crypto.subtle.importKey('raw', kMac, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

// envelope_i = { v, credential_id, nonce, ct = AES-GCM(KEK_i, DEK, aad), mac }
export async function wrapEnvelope({ kek, dek, kMac, accountId, credentialId }) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = encodeFields('mt/v1/env', accountId, credentialId);
  const ct = await aesGcmEncrypt(kek, nonce, dek, aad);
  const mac = await computeEnvelopeMac(kMac, credentialId, nonce, ct);
  return { v: SUITE_VERSION, credential_id: credentialId, nonce, ct, mac };
}

// Unwraps DEK. Throws (AEAD failure) on any tampered nonce/ct/aad.
export async function unwrapEnvelope({ kek, envelope, accountId, credentialId }) {
  const aad = encodeFields('mt/v1/env', accountId, credentialId);
  return aesGcmDecrypt(kek, envelope.nonce, envelope.ct, aad);
}

// Audits envelope.mac against a freshly-derived K_mac once DEK is known —
// flags envelopes an operator forged without holding the DEK (docs/cloud-crypto.md
// "Malicious operator adds their own credential").
export async function auditEnvelope({ dek, envelope, credentialId }) {
  const kMac = await deriveKMac(dek);
  const expected = await computeEnvelopeMac(kMac, credentialId, envelope.nonce, envelope.ct);
  return timingSafeEqual(expected, envelope.mac);
}

// Path B device transfer (docs/cloud-crypto.md "Enrolling a new device"): the
// DEK encrypted under a one-shot transfer key TK, never a KEK — the server's
// ct column is opaque, so nonce ‖ ciphertext is packed into one blob rather
// than adding a second wire field.
export async function encryptTransferPayload(tk, dek, accountId) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = encodeFields('mt/v1/xfer', accountId);
  const ct = await aesGcmEncrypt(tk, nonce, dek, aad);
  const packed = new Uint8Array(nonce.length + ct.length);
  packed.set(nonce, 0);
  packed.set(ct, nonce.length);
  return packed;
}

// Throws (AEAD failure) on a tampered or wrong-TK packed payload.
export async function decryptTransferPayload(tk, packed, accountId) {
  const nonce = packed.slice(0, 12);
  const ct = packed.slice(12);
  const aad = encodeFields('mt/v1/xfer', accountId);
  return aesGcmDecrypt(tk, nonce, ct, aad);
}

async function checksumGroup(codeBytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', codeBytes));
  return base32Encode(digest.slice(0, 3)).slice(0, 4);
}

// 160 random bits, Crockford base32, grouped 8x4 plus a trailing 4-char
// checksum group (SHA-256-derived) for offline typo detection.
export async function generateRecoveryCode() {
  const codeBytes = crypto.getRandomValues(new Uint8Array(20));
  const groups = base32Encode(codeBytes).match(/.{1,4}/g);
  groups.push(await checksumGroup(codeBytes));
  return { codeBytes, formatted: groups.join('-') };
}

// Parses a user-typed recovery code, validating the checksum group. Throws
// on malformed input or checksum mismatch.
export async function parseRecoveryCode(formatted) {
  const clean = formatted.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (clean.length !== 36) throw new Error('invalid recovery code length');
  const codeBytes = base32Decode(clean.slice(0, 32));
  const expected = await checksumGroup(codeBytes);
  // Normalize the typed checksum group the same way base32Decode normalizes the
  // body, so an O/I/L transcription typo isn't tolerated in the code but
  // falsely rejected in the checksum.
  const typedChecksum = [...clean.slice(32, 36)].map((c) => CROCKFORD_NORMALIZE[c] || c).join('');
  if (expected !== typedChecksum) throw new Error('invalid recovery code checksum');
  return codeBytes;
}

export async function deriveKEKRec(codeBytes, accountId) {
  return hkdf(codeBytes, utf8(accountId), utf8('mt/v1/kek-rec'));
}

export async function deriveVerifier(codeBytes, accountId) {
  return hkdf(codeBytes, utf8(accountId), utf8('mt/v1/rec-auth'));
}
