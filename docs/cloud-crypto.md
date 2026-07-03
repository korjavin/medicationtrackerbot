# Cloud-mode crypto — passkey-only key management (C0 design)

**Status: design proposal, not yet implemented.** Detailed companion to [docs/cloud-mode.md](cloud-mode.md), specifying the C0 phase's key management, envelope formats, and ceremonies.

Core stance: **there are no passphrases anywhere in the system.** Unlock is a passkey ceremony (Face ID / fingerprint / device PIN via WebAuthn). The only thing a user can write down is the optional high-entropy recovery code in the Emergency Kit — a backup credential, not a memorized secret.

## Requirements

- **R1 — no passphrase.** Nothing to memorize, nothing guessable.
- **R2 — multiple independent passkeys.** Each device may hold its own hardware-bound, non-synced passkey. All enrolled devices have identical data visibility. Synced passkeys (iCloud Keychain / Google Password Manager) are supported but never required.
- **R3 — server never reads data.** Full DB theft, subpoena, or active operator malice yields ciphertext and metadata only (modulo the code-serving caveat documented in cloud-mode.md).
- **R4 — self-service device switching.** A new device can be enrolled via any one of: a cross-device passkey ceremony, a QR hand-off from an unlocked device, or the recovery code.
- **R5 — no offline-crackable material server-side.** Every wrap key in the system is ≥128 bits of true entropy. (This is the concrete upgrade over any passphrase design: there is no password hash to brute-force, ever.)

## The enabling primitive: WebAuthn PRF

The [`prf` extension](https://w3c.github.io/webauthn/#prf-extension) (CTAP2 `hmac-secret`) lets a passkey act as a keyed pseudo-random function:

- During an assertion (`navigator.credentials.get()`), the client supplies a salt; the authenticator returns `PRF(credential_secret, salt)` — 32 bytes, **deterministic per (credential, salt)**, released only after user verification (biometric/PIN).
- The output is delivered to client JS only (`clientExtensionResults`); it is **not part of the signed response the server verifies**. Our client never transmits it.
- The per-credential secret never leaves the authenticator; 32 bytes of output entropy make the derived key non-brute-forceable.

Per passkey `i`: `PRF_i = PRF(credential_i, salt_kek)` → HKDF → `KEK_i` → wraps the DEK. Different credential ⇒ different `KEK_i` ⇒ one envelope per passkey.

**Availability policy**: feature-detect, don't version-sniff. At enrollment, request `extensions: { prf: {} }`; if the created credential reports PRF unsupported, delete it and tell the user (offering a hardware security key — YubiKey-class keys support `hmac-secret` — or a different device). Current platform authenticators (iOS/iPadOS 18+, Android with Google Password Manager, Windows Hello on current Windows 11, Safari 18+/macOS, Chrome/Edge/Firefox current) support PRF; the matrix keeps improving, but cloud mode simply **requires** a PRF-capable authenticator for the first credential.

**Registration caveat**: some authenticators do not return PRF *outputs* during `create()` (only `enabled: true`). The enrollment ceremony therefore always follows registration with an immediate `get()` on the new credential to obtain the output. Never rely on PRF-at-creation.

**RP ID**: the per-user instance host (`amber-falcon-8k3q9x.app.<cloud-domain>`), giving per-account credential isolation for free. Consequence: the cloud domain is effectively permanent — a future domain migration would need WebAuthn Related Origin Requests as the escape hatch. `residentKey: "required"`, `userVerification: "required"` on all ceremonies.

## Key hierarchy

```
passkey₁ ──PRF(salt_kek)──► PRF₁ ──HKDF──► KEK₁ ──AES-GCM──► envelope₁ ┐
passkey₂ ──PRF(salt_kek)──► PRF₂ ──HKDF──► KEK₂ ──AES-GCM──► envelope₂ ├──► DEK (random 256-bit)
recovery code (160-bit, Emergency Kit) ──HKDF──► KEK_rec ──► envelope_rec ┘        │
                                                                                    ├─► K_data  (HKDF "data")   — record/snapshot encryption
server stores: envelopes, ciphertext, WebAuthn                                      ├─► K_mac   (HKDF "envmac") — envelope-audit MAC
public keys — never any key material                                                └─► vault records: NK (push key), inbox keypair
```

| Key | Nature | Lives | Purpose |
|---|---|---|---|
| **DEK** | random 256-bit, generated at signup | memory of unlocked clients; server only inside envelopes | root of the vault; everything derives from or is encrypted under it |
| **KEK_i** | HKDF(PRF output of passkey `i`) | ephemeral, derived per ceremony | wraps DEK into `envelope_i` |
| **KEK_rec** | HKDF(recovery code) | derived only when the code is typed | last-resort envelope |
| **K_data** | HKDF(DEK, "data") | derived in memory | AES-GCM over oplog records + snapshots |
| **K_mac** | HKDF(DEK, "envmac") | derived in memory | envelope-audit MAC (see Security analysis) |
| **NK** | random 256-bit, stored *as an encrypted vault record* | inside vault; plaintext copy in device IndexedDB | push-payload app-layer key — the SW must decrypt pushes with no ceremony (see below) |
| **inbox keypair** | ECDH P-256 (X25519 where available), private key a vault record, public key on server | inside vault | sealed inbound mailbox (Telegram callbacks, cross-device messages) |
| **LDK** | per-device, non-extractable WebCrypto AES key in IndexedDB | device only | warm-unlock cache: wraps DEK locally so sync doesn't demand a biometric per launch |

DEK rotation (device revocation after suspected compromise) = generate DEK′, upload a fresh snapshot under it, re-wrap the remaining envelopes, rotate NK. Cheap because the snapshot/compaction machinery already exists. Per-epoch content keys were considered and rejected: snapshot-based rotation makes them redundant complexity.

## Exact formats (suite v1)

All constructions carry a leading version byte `0x01`; a future suite bumps it. Multi-field byte strings (AAD, HKDF info) are encoded as fixed-order, length-prefixed fields (`uint16-BE length ‖ bytes`) — no delimiter ambiguity.

Constants:

```
salt_kek   = SHA-256("medtracker/v1/prf-kek")          # PRF eval.first, same for every credential
           # PRF eval.second reserved: SHA-256("medtracker/v1/prf-kek-next") — lets one ceremony
           # derive current + next KEK during a future suite rotation
HKDF       = HKDF-SHA-256
AEAD       = AES-256-GCM, 12-byte random nonce, 16-byte tag (WebCrypto)
```

**KEK derivation** (per credential `i`):

```
KEK_i = HKDF(ikm = PRF_i, salt = account_id, info = "mt/v1/kek" ‖ credential_id_i)   → 32 bytes
```

**Envelope** (one row per credential, stored server-side):

```
envelope_i = {
  v: 1,
  credential_id: <bytes>,
  nonce: <12B random>,
  ct: AES-GCM(KEK_i, DEK, aad = "mt/v1/env" ‖ account_id ‖ credential_id_i),
  mac: HMAC-SHA-256(K_mac, "mt/v1/envmac" ‖ credential_id_i ‖ nonce ‖ ct)   # audit tag, see below
}
```

**Recovery envelope**: same shape with `credential_id = "recovery"` and `KEK_rec`:

```
code      = 160 random bits, Crockford base32, grouped 8×4 + checksum group (printed in Emergency Kit)
KEK_rec   = HKDF(code_bytes, salt = account_id, info = "mt/v1/kek-rec")
verifier  = HKDF(code_bytes, salt = account_id, info = "mt/v1/rec-auth")     # server stores SHA-256(verifier)
```

The verifier lets the server authenticate a recovery attempt (and rate-limit: e.g. 5 attempts/hour) without learning anything that unwraps the envelope — domain separation guarantees `verifier` and `KEK_rec` are independent. At 160 bits, online guessing is moot anyway; the limit is hygiene.

**Oplog record / snapshot**:

```
record = { v: 1, account_seq, nonce, ct = AES-GCM(K_data, plaintext,
           aad = "mt/v1/rec" ‖ account_id ‖ record_type ‖ record_id ‖ account_seq) }
snapshot = same, aad = "mt/v1/snap" ‖ account_id ‖ snapshot_seq
```

Binding `account_seq` into the AAD makes server-side reordering/replay of ciphertexts detectable at decrypt time. GCM's 96-bit random nonces are safe far beyond this workload's message counts (health-tracking volumes are ≪ 2³²).

**Push payload** (app layer, inside the RFC 8291 wrap): `AES-GCM(NK, payload, aad = "mt/v1/push")`.

**Sealed mailbox item** (ECIES): ephemeral ECDH P-256 against the inbox public key → HKDF → AES-GCM. X25519 via WebCrypto where available; P-256 is the universal floor.

## Ceremonies

### Signup (first device)

1. Client generates `account_id`, subdomain, DEK, NK, inbox keypair, recovery code.
2. `navigator.credentials.create()` with `rp.id = <instance-host>`, `residentKey: required`, `uv: required`, `extensions: {prf: {}}`. If PRF unsupported → delete credential, abort with guidance.
3. Immediate `get()` on the new credential (with `salt_kek`) → `PRF₁` → `KEK₁` → `envelope₁`.
4. Upload in one transaction: WebAuthn public key, `envelope₁`, `envelope_rec`, `SHA-256(verifier)`, inbox public key. Server issues the first device session token.
5. Emergency Kit (URL + recovery code + QR) rendered client-side; explicit "I saved it" gate.
6. NK and inbox private key written into the vault as encrypted records; NK plaintext cached in IndexedDB for the SW.

### Unlock

- **Warm** (normal launch): unwrap DEK from the local LDK-wrapped cache in IndexedDB. Silent — no biometric, sync just works. API calls use the stored device session token.
- **Cold** (fresh browser profile, cleared storage, strict mode): server returns the account's credential-id list → `get()` with `allowCredentials = [ids]` and top-level `prf.eval = salt_kek` (the salt applies to whichever credential the user picks) → `KEK_i` → download `envelope_i` → DEK. Re-establish LDK cache. The same assertion doubles as server auth (signature verified → fresh session token).

### Enrolling a new device

The crux: a new passkey's PRF output exists only on the new device, and the plaintext DEK exists only on unlocked devices. Three paths, all ending identically — the new device holds DEK, creates its own passkey, and uploads its own envelope:

**Path A — cross-device passkey ceremony (preferred; no app needed on the old device).** The new device runs the *cold unlock* flow above; the browser offers the hybrid transport (QR + Bluetooth proximity), the user scans with the phone that holds an existing passkey, approves with biometrics, and the PRF output is delivered to the new device's JS. PRF-over-hybrid works on current Chrome/Safari against iOS/Android passkeys, but the matrix isn't universal — hence Path B. Then: create local passkey → `get()` for PRF → `envelope_new` → upload (session already authenticated by the assertion).

**Path B — QR hand-off from an unlocked device (works regardless of PRF-over-hybrid support).**

1. Old device (unlocked): "Add a device" → generates one-shot transfer key `TK` (256-bit) and uploads a transfer slot: `{slot_id, enrollment_token, ct = AES-GCM(TK, DEK, aad = "mt/v1/xfer" ‖ account_id)}`. TTL 10 minutes, single fetch, then deleted. `TK` never touches the server.
2. Old device displays QR = `{instance URL, slot_id, TK}` (typed fallback: full-strength base32 code).
3. New device scans, fetches the slot (the `enrollment_token` authorizes it), decrypts DEK, creates its passkey, uploads `envelope_new` + credential.

A malicious server cannot substitute the slot contents: it doesn't know `TK`, so any tampered ciphertext fails AEAD and the client aborts.

**Path C — recovery code (all devices lost).** Fresh device → instance URL → "Recover" → type the code → client sends `verifier` (server checks hash, rate-limits) → downloads `envelope_rec` → `KEK_rec` unwraps DEK → enroll a new passkey as above. The UI then **forces recovery-code rotation** (new code, new `envelope_rec`, new kit) — a used code is treated as burned.

### Removing a device / revocation

- Routine removal (device retired): delete its WebAuthn credential, envelope, push subscription. Data keys unchanged.
- Suspected compromise (stolen unlocked device): removal **plus DEK rotation** — DEK′, fresh snapshot under `K_data′`, re-wrap surviving envelopes, rotate NK and device session tokens. Initiated from any remaining device or via recovery code; this is why the onboarding pushes a second enrolled credential so hard.
- Orphaned envelopes (user deleted the passkey at the OS level): harmless ciphertext; the device-list UI surfaces credentials that haven't asserted in N days for cleanup.

## The push key (NK) — why it exists

Push arrives at the service worker in the background: **no user gesture, no WebAuthn possible**. Rich reminder text therefore cannot be gated on a passkey ceremony. NK is the deliberate, documented compromise:

- NK encrypts *only* scheduled reminder payloads — never vault records.
- It lives plaintext in device IndexedDB (SW-reachable) and as an encrypted vault record (so every device holds the same NK).
- Exposure of NK reveals reminder texts, not health data; users who reject even that run generic-notification mode ("Medication reminder") and NK is never provisioned.

## Local at-rest posture

Same stance as the Capacitor build's Phase 2c decision: **the E2EE boundary is the cloud; the local boundary is the OS.**

- Local plaintext cache (Dexie/IndexedDB) and NK are protected by device unlock + OS full-disk encryption, exactly like the APK's SQLite file.
- The LDK is a **non-extractable** WebCrypto key structured-cloned into IndexedDB. That is a *script-level* guarantee: on-origin JS (e.g. an XSS payload) can *use* it but can never export raw bits. It is **not** disk-forensics protection — the browser profile on disk is the OS's problem. Stating this precisely matters; non-extractable keys are commonly oversold.
- **Strict mode** (later, optional): no LDK cache — a passkey ceremony on every launch, DEK memory-only. One biometric tap per open; offered, not default.

## Server data model (per account)

```
account            { account_id, subdomain, created_at, quota, email? }
credentials[]      { credential_id, webauthn_pubkey, last_asserted_at }
envelopes[]        { credential_id | "recovery", v, nonce, ct, mac }
recovery_auth      { sha256(verifier), attempt_counters }
inbox_pubkey       { P-256 point }
oplog / snapshots  ciphertext only
push_subscriptions, scheduled_pushes, transfer_slots (TTL'd)
```

Everything in `envelopes`, `oplog`, `snapshots`, `scheduled_pushes` is ciphertext under keys derived from ≥160-bit secrets the server never sees. Nothing stored server-side is offline-attackable (R5).

## Security analysis

| Threat | Outcome |
|---|---|
| Full server DB theft | Ciphertext + envelopes. No KDF to grind — every wrap key is high-entropy (R5). ✅ |
| Malicious operator adds their own credential to an account | Gains what a session grants: ciphertext. Cannot mint a valid envelope (needs DEK) or unwrap existing ones. Flagged in the device list: their envelope lacks a valid `mac` (they don't have `K_mac`), so every unlocked client renders it as **unverified — remove?**. ✅ |
| Server tampers with a Path-B transfer slot | AEAD failure under `TK` → client aborts. ✅ |
| Server replays / reorders ciphertext | `account_seq` in AAD → decrypt-time detection. Withholding data (DoS) remains possible — availability is never zero-knowledge. ⚠️ known limit |
| Phishing / fake login page | Passkeys are origin-bound: a look-alike site cannot run an assertion for the real RP ID, so neither auth nor PRF output is obtainable. Stronger than any passphrase flow. ✅ |
| Stolen **locked** device | OS boundary: passkey needs UV; LDK cache needs the unlocked browser profile. Remote-revoke from another device regardless. ✅ |
| Stolen **unlocked** device | Full read of that device's copy — true of every E2EE app. Response: revoke + DEK rotation from a surviving credential. ⚠️ inherent |
| XSS on the instance origin | Catastrophic while unlocked (reads plaintext, uses LDK). Non-extractable keys block raw-key exfil, but the real defenses are upstream: strict CSP, zero third-party script, SRI, SW-pinned bundles (cloud-mode.md code-serving caveat). ⚠️ inherent to web crypto |
| Loss of all passkeys **and** the recovery code | Data unrecoverable, by design. Mitigated by onboarding: enroll ≥2 credentials, keep the Kit. ⚠️ stated plainly |

## Edge cases

- **Synced passkey (iCloud/Google)**: same credential ⇒ same PRF ⇒ the *same envelope* serves every device in the sync fabric — multi-device for free, and phone loss becomes a non-event. Supported, never assumed.
- **Browser storage cleared**: passkeys live in the platform authenticator, not browser storage → cold unlock fully recovers; only the LDK cache and local plaintext cache are lost.
- **PRF-capable check on every new credential** — a mixed account (one PRF passkey + one non-PRF) is never created; enrollment of a non-PRF credential aborts before any envelope is written.
- **Concurrent enrollments**: envelopes are independent rows keyed by credential id — no coordination needed.
- **Sign counters**: platform authenticators commonly report 0; do not use counters for clone detection.
- **WebAuthn needs a top-level secure context + user gesture**: all ceremonies are button-initiated in the installed PWA; none are needed for background sync (session tokens) or push decrypt (NK).

## Open questions

- PRF-over-hybrid (Path A) support matrix at ship time — decides how prominent Path B is in the UI.
- Strict mode scope: ceremony-per-launch only, or also ciphertext-at-rest locally?
- Should envelope `mac` verification failures hard-block sync or only warn? (Lean: warn + red banner; hard-block adds a server-controlled DoS lever.)
- Typed-fallback UX for Path B on devices without cameras.
- Formal review: the construction is conventional (envelope encryption + HKDF domain separation + AEAD with bound AAD), but C0 should include an external cryptographic review before beta.
