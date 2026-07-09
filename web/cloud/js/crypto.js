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
//
// This sits on the snapshot UPLOAD path (sync.js snapshotAt -> toBase64(ct)), so
// it runs on every import and every compaction. Growing `binary` one char at a
// time cost 1096 ms per 24.5 MiB; chunked fromCharCode.apply is 118 ms, and the
// native method is faster still. Chunk stays under the ~65k argument-count limit
// that makes .apply() throw RangeError on large inputs.
const B64_CHUNK = 0x8000;

export function toBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let binary = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK));
  }
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

// K_data = HKDF(DEK, info="mt/v1/data") — oplog record + snapshot encryption
// key (docs/cloud-crypto.md key hierarchy table).
export async function deriveKData(dek) {
  return hkdf(dek, new Uint8Array(0), utf8('mt/v1/data'));
}

// account_seq / snapshot_seq are JS numbers (server int64, well under
// Number.MAX_SAFE_INTEGER at any real workload); fixed 8-byte big-endian
// framing keeps the AAD encoding unambiguous.
function encodeSeq(seq) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(seq), false);
  return out;
}

// record = { account_seq, nonce, ct = AES-GCM(K_data, plaintext, aad) },
// aad = "mt/v1/rec" ‖ account_id ‖ record_type ‖ record_id ‖ account_seq.
// account_seq is unknown to the client until the server assigns it in the
// POST /api/sync/ops response, so it cannot be pre-bound before that call
// returns — see docs' "Seq assignment vs AAD" note. Callers encrypt using
// their best-known (usually correct) predicted seq and must be prepared for
// decryptRecord to reject a record whose true assigned seq differs.
export async function encryptRecord({ kData, accountId, recordType, recordId, seq, plaintext }) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = encodeFields('mt/v1/rec', accountId, recordType, recordId, encodeSeq(seq));
  const ct = await aesGcmEncrypt(kData, nonce, plaintext, aad);
  return { nonce, ct };
}

// Throws (AEAD failure) when the server-claimed seq wasn't the one the
// ciphertext was actually encrypted under — the anti-reorder/replay property.
export async function decryptRecord({ kData, accountId, recordType, recordId, seq, nonce, ct }) {
  const aad = encodeFields('mt/v1/rec', accountId, recordType, recordId, encodeSeq(seq));
  return aesGcmDecrypt(kData, nonce, ct, aad);
}

// gzip/gunzip via Web Streams (CompressionStream). Used to compress snapshot
// JSON *before* encryption so the ciphertext (and POST body) shrinks ~10x. A
// gzip stream always starts with the 2-byte magic 0x1f 0x8b; raw-JSON snapshots
// start with '[' (0x5b) or '{' (0x7b), so the decrypt path can sniff which is
// which — no wire field, and old uncompressed snapshots stay readable.
async function streamThrough(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export function gzip(bytes) {
  return streamThrough(bytes, new CompressionStream('gzip'));
}

export function gunzip(bytes) {
  return streamThrough(bytes, new DecompressionStream('gzip'));
}

export function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

// snapshot = same construction, aad = "mt/v1/snap" ‖ account_id ‖ snapshot_seq.
export async function encryptSnapshot({ kData, accountId, snapshotSeq, plaintext }) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = encodeFields('mt/v1/snap', accountId, encodeSeq(snapshotSeq));
  const ct = await aesGcmEncrypt(kData, nonce, plaintext, aad);
  return { nonce, ct };
}

export async function decryptSnapshot({ kData, accountId, snapshotSeq, nonce, ct }) {
  const aad = encodeFields('mt/v1/snap', accountId, encodeSeq(snapshotSeq));
  return aesGcmDecrypt(kData, nonce, ct, aad);
}

// Push payload (docs/cloud-crypto.md "Push payload"): AES-GCM(NK, payload,
// aad="mt/v1/push"). scheduled_pushes.ct is a single BLOB wire column with no
// separate nonce field, so — same as encryptTransferPayload above — the nonce
// is packed ahead of the ciphertext into one blob rather than adding a column.
const PUSH_AAD = utf8('mt/v1/push');

export async function encryptPushPayload(nk, plaintext) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await aesGcmEncrypt(nk, nonce, plaintext, PUSH_AAD);
  const packed = new Uint8Array(nonce.length + ct.length);
  packed.set(nonce, 0);
  packed.set(ct, nonce.length);
  return packed;
}

// Throws (AEAD failure) on a tampered payload or the wrong NK — the caller
// (sw.js) treats that identically to "NK absent": fall back to a generic
// notification.
export async function decryptPushPayload(nk, packed) {
  const nonce = packed.slice(0, 12);
  const ct = packed.slice(12);
  return aesGcmDecrypt(nk, nonce, ct, PUSH_AAD);
}

// MCP relay frame crypto (docs/cloud-mode.md "MCP", Tier 1; wire contract
// documented in internal/mcpshim/frame.go). Frame = nonce(12) ‖
// AES-GCM(pairingKey, payload, aad), aad = encodeFields('mt/v1/mcp',
// pairingId). payload is one JSON-RPC MCP message, utf8-encoded
// (mcp-responder.js owns JSON.stringify/parse + utf8()/TextDecoder); the
// relay pipes the frame opaquely and never sees pairingKey.
export async function sealMCPFrame(pairingKey, pairingId, payload) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = encodeFields('mt/v1/mcp', pairingId);
  const ct = await aesGcmEncrypt(pairingKey, nonce, payload, aad);
  const packed = new Uint8Array(nonce.length + ct.length);
  packed.set(nonce, 0);
  packed.set(ct, nonce.length);
  return packed;
}

// Throws (AEAD failure) on a tampered frame, the wrong key, or a pairingId
// mismatch (cross-pairing replay).
export async function openMCPFrame(pairingKey, pairingId, frame) {
  const nonce = frame.slice(0, 12);
  const ct = frame.slice(12);
  const aad = encodeFields('mt/v1/mcp', pairingId);
  return aesGcmDecrypt(pairingKey, nonce, ct, aad);
}

// --- Inbound sealed mailbox (mt/v1/inbox, bd med-76c.2) --------------------
//
// The cloud relay receives Telegram events it must hand to us without reading
// them. It holds only this account's inbox PUBLIC key and seals each event to
// it (internal/cloudserver/sealedbox.go); the private key below lives in the
// vault and never leaves an unlocked client, so the seal is write-only for the
// server. Anonymous ephemeral-static X25519:
//
//   ephPub(32) ‖ nonce(12) ‖ AES-256-GCM(K, plaintext, aad)
//   K   = HKDF-SHA256(ikm=X25519(ephPriv, inboxPub), salt=ephPub‖inboxPub, info="mt/v1/inbox")
//   aad = encodeFields("mt/v1/inbox", accountId)
//
// internal/cloudserver/testdata/inbox_sealed_vector.json pins this format; both
// the Go and the JS suite decrypt it, so the two implementations cannot drift.
const INBOX_LABEL = 'mt/v1/inbox';

// WebCrypto X25519 is recent (Chrome 133+, Firefox 132+, Safari 17.4+). Without
// it the mailbox cannot be opened at all, so probe explicitly and fail loudly
// rather than silently dropping inbound events.
export async function inboxCryptoSupported() {
  try {
    await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    return true;
  } catch {
    return false;
  }
}

// generateInboxKeypair returns the raw 32-byte public key (uploaded to the
// server) and the PKCS#8 private key (stored as a vault record). Raw export is
// not defined for X25519 private keys, so PKCS#8 is the portable choice.
export async function generateInboxKeypair() {
  const kp = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const privateKey = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  return { publicKey, privateKey };
}

// PKCS#8 wrapper for a raw X25519 scalar: SEQUENCE{ INTEGER 0,
// SEQUENCE{ OID 1.3.101.110 }, OCTET STRING{ OCTET STRING(32) } }. Fixed-length
// for X25519, so a literal prefix is exact — this lets the Go-side test vector
// (which carries a raw scalar) be imported by WebCrypto, which only accepts
// PKCS#8. Raw private keys never appear on the wire in production.
const X25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

export function rawX25519PrivateToPkcs8(raw) {
  if (raw.length !== 32) throw new Error('X25519 private key must be 32 bytes');
  const out = new Uint8Array(X25519_PKCS8_PREFIX.length + 32);
  out.set(X25519_PKCS8_PREFIX, 0);
  out.set(raw, X25519_PKCS8_PREFIX.length);
  return out;
}

// openInboxEvent decrypts one sealed mailbox row. Throws on a tampered payload,
// a foreign account id, or a key that isn't ours — all of which must surface as
// a failed drain rather than a silently skipped event.
export async function openInboxEvent(pkcs8PrivateKey, accountId, packed) {
  if (packed.length < 32 + 12 + 16) throw new Error('sealed inbox payload too short');
  const ephPub = packed.slice(0, 32);
  const nonce = packed.slice(32, 44);
  const ct = packed.slice(44);

  const priv = await crypto.subtle.importKey('pkcs8', pkcs8PrivateKey, { name: 'X25519' }, false, ['deriveBits']);
  const eph = await crypto.subtle.importKey('raw', ephPub, { name: 'X25519' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: eph }, priv, 256));

  // The salt binds the key to this (ephemeral, recipient) pair. We must recover
  // our own public key to rebuild it — derive it from the private key material
  // we were handed, rather than trusting anything in the payload.
  const recipientPub = await inboxPublicFromPrivate(pkcs8PrivateKey);
  const salt = new Uint8Array(64);
  salt.set(ephPub, 0);
  salt.set(recipientPub, 32);

  const key = await hkdf(shared, salt, utf8(INBOX_LABEL));
  const aad = encodeFields(INBOX_LABEL, accountId);
  return aesGcmDecrypt(key, nonce, ct, aad);
}

// WebCrypto cannot export a public key from a private one, so round-trip the
// PKCS#8 through JWK: the `x` member is the base64url raw public key.
export async function inboxPublicFromPrivate(pkcs8PrivateKey) {
  const priv = await crypto.subtle.importKey('pkcs8', pkcs8PrivateKey, { name: 'X25519' }, true, ['deriveBits']);
  const jwk = await crypto.subtle.exportKey('jwk', priv);
  return fromBase64Url(jwk.x);
}
