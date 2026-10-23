# Cloud-mode crypto — passkey-only key management (C0 design)

**Status: suite v1 implemented** (`web/cloud/js/crypto.js` — HKDF/AES-GCM formats, recovery-code + envelope-audit derivations; server-side WebAuthn ceremonies in `internal/cloudserver`). C0a shipped signup/unlock; **C0b shipped Path B (QR/typed-code hand-off), recovery redemption + forced rotation, and revocation** — see `docs/plans/2026-07-03-cloud-c0b-device-lifecycle.md`. **Path A (cross-device hybrid-transport enrollment) is explicitly deferred** — out of scope for C0, no implementation exists; Path B covers cross-device enrollment unconditionally. **DEK rotation is a documented gap**: revocation today removes the credential + envelope but does not rotate DEK/NK, so a stolen-and-unlocked device retains a readable copy of data synced before revocation (see "Removing a device / revocation" below). Detailed companion to [docs/cloud-mode.md](cloud-mode.md), specifying the C0 phase's key management, envelope formats, and ceremonies.

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

**RP ID**: the per-user instance host (`amber-falcon-8k3q9x.app.<cloud-domain>`), giving per-account credential isolation for free. Consequence: the cloud domain is effectively permanent — a future domain migration would need WebAuthn Related Origin Requests as the escape hatch. `residentKey: "required"`, `userVerification: "required"` on all ceremonies. Accepted origins are the instance host's https origin plus, only when `ANDROID_CERT_SHA256S` is set, one exact-match `android:apk-key-hash:<base64url cert SHA-256>` per Android signing cert — the origin the Android WebView shell signs into `clientDataJSON` (bd med-nt9p.14); the RP ID (and so `rpIdHash`) stays the instance host either way.

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
| **LDK cache** | per-device record in IndexedDB holding the leaf keys `K_data` (AES-GCM) + `K_mac` (HMAC, verify-only) as non-extractable CryptoKeys | device only | warm-unlock cache so sync doesn't demand a biometric per launch; holds no DEK bytes (`web/cloud/js/unlock.js`) |

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

**Snapshot plaintext is gzip-then-encrypt.** The snapshot `plaintext` is `gzip(utf8(JSON(records)))`, not raw JSON — compressing before encryption shrinks the ciphertext (and POST body) ~10x so a large vault fits (a 24 MB vault → ~2–3 MB body). Compression must precede encryption to be effective, so this is a client-owned payload-format detail; the AAD, `{snapshot_seq, nonce, ct}` wire shape, and server storage are unchanged — `ct` stays opaque to the server. The read path (only `sync.js` `bootstrap` decrypts snapshots) sniffs the first two plaintext bytes after decrypt: `0x1f 0x8b` → gunzip; otherwise parse as raw UTF-8 JSON, so pre-existing uncompressed snapshots on deployed accounts still bootstrap. No version field. Server snapshot caps (`internal/cloudserver/sync.go`) allow a **64 MiB decoded ciphertext** (`maxSnapshotCTLen`); the request-body cap (`maxSnapshotBodyBytes`) is **96 MiB** to cover base64 expansion of that CT (`ct` decodes from base64, so the JSON body carries ~4/3 the decoded bytes). Headroom well above a compressed large vault so the cap stops being the binding limit and oplog compaction keeps working as the store grows.

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

- **Warm** (normal launch): read the leaf keys from the local cache in IndexedDB (no DEK). Silent — no biometric, sync just works. API calls use the stored device session token.
- **Cold** (fresh browser profile, cleared storage, strict mode): server returns the account's credential-id list → `get()` with `allowCredentials = [ids]` and top-level `prf.eval = salt_kek` (the salt applies to whichever credential the user picks) → `KEK_i` → download `envelope_i` → DEK. Re-establish LDK cache. The same assertion doubles as server auth (signature verified → fresh session token).

### Enrolling a new device

The crux: a new passkey's PRF output exists only on the new device, and the plaintext DEK exists only on unlocked devices. Three paths were designed, all ending identically — the new device holds DEK, creates its own passkey, and uploads its own envelope:

**Path A — cross-device passkey ceremony — deferred, out of scope for C0.** Would run the *cold unlock* flow on the new device via the browser's hybrid transport (QR + Bluetooth proximity) against an existing passkey. PRF-over-hybrid support isn't universal enough yet to be the primary path; Path B covers the same use case unconditionally, so Path A stayed a design note. Revisit if/when the platform support matrix matures.

**Path B — QR hand-off from an unlocked device: protocol v2, approve-on-origin (server implemented in med-r1j2.1; clients in med-r1j2.2/.3; epic med-r1j2 is normative).** v1 handed the DEK ciphertext and the enrollment token to whoever fetched the slot first, so a leaked QR inside its 10-minute window yielded the DEK before the owner knew. v2 releases the key only after the owner compares a match code on both screens and approves on the origin, and only in a form the approved receiver can open.

Actors: O = origin device, N = new device, S = server (blind relay, possibly hostile). Out-of-band channel = the QR/link carrying `TK` (16 random bytes); the slot id is derived from it, `slot = base64url(SHA-256(TK))[:22]`, so the server stores the id and never sees `TK`, never validates a MAC and never derives the match code — it enforces states and immutability only. Transcript `T` = length-prefixed `"wg-transfer-v2" ‖ accountId ‖ slot ‖ platform ‖ commit ‖ n_pub ‖ o_pub`, `commit = SHA-256(o_pub)`, keys compressed P-256, `platform ∈ {web, android, ios}`. Slot states: `pending → claimed → revealed → approved → enrolled`; every transition is a single guarded UPDATE from exactly one state, so nothing is re-claimed or re-revealed on a slot — a different receiver needs a fresh pairing. `DELETE` (Deny / Cancel), revoking the approving credential (for every state but `enrolled`), and the 10-minute TTL end a slot from any state.

1. O (unlocked) → "Add a device" → a fresh passkey assertion (`assertPasskey`) whose `account_id` must equal the vault's and whose DEK is the one handed over — the warm ctx holds no raw DEK (bd med-5h1t.3); a device whose passkey is gone or lacks PRF cannot originate (the Emergency Kit, Path C, still can). O makes `TK` and an ephemeral `o_pub/o_priv`, derives `slot`, and `POST /api/transfer {slot_id, commit}` (session) → state `pending` (a reused id is 409). `o_pub` is **not** posted yet; nothing secret is stored. QR/link fragment = `<slot>.<base64url TK>` on `https://<base>/d/<sub>`; the typed fallback ("Code for a computer") is `TK` alone as 28 letters (base-26, 3-letter groups), from which N re-derives `slot` — letters only, so it cannot be confused with the 6-digit match code.
2. N: `GET /api/transfer/{slot}` (unauthenticated) → `{status, commit, expires_at}`; N enforces the expiry locally. N makes `n_pub/n_priv` and `POST /api/transfer/{slot}/claim {n_pub, platform, mac_n}`, `mac_n = HMAC-SHA256(TK, "claim" ‖ accountId ‖ slot ‖ platform ‖ commit ‖ n_pub)` → state `claimed`, `n_pub`/`platform`/`mac_n` immutable (second claim → 409, gone → 410). The response carries a `claim_token` that authenticates N's later polls (`X-Transfer-Token`) and becomes its enrollment token — inert until approved.
3. O polls `GET /api/transfer/{slot}` (session → origin view: claim fields, later `conf_n`). On `claimed` it verifies `mac_n` with `TK` (fail → "someone else used this code", Cancel), **freezes `n_pub`/`platform`** in memory (any later change → Cancel), derives `K = HKDF-SHA256(ECDH(o_priv, n_pub), salt = SHA-256(T))`, `sas = HKDF-expand(K,"sas") mod 10^6`, `K_wrap`, `K_conf`, and `POST /api/transfer/{slot}/reveal {o_pub, mac_o}` (session, only from `claimed`), `mac_o = HMAC-SHA256(TK, "reveal" ‖ T)` → `revealed`. No ciphertext, no token. O shows "<platform> wants to join · <sas> — Approve / Deny".
4. N's poll on `revealed` returns `{o_pub, mac_o}`; N checks `SHA-256(o_pub) == commit` and `mac_o`, derives the same `sas` and shows it. Nothing has been released; the owner compares the two codes.
5. Approve (an explicit second tap): `ct = AES-256-GCM(K_wrap, DEK, aad = T)`, `POST /api/transfer/{slot}/approve {ct, approving_credential_id?}` (session, only from `revealed`) → `approved`. Deny = `DELETE`.
6. N's poll on `approved` **with its claim token** returns `ct` + `enrollment_token` + `account_id` (without the token: status only). N decrypts (AES-GCM failure = abort), registers its own passkey via `register/begin {enrollment_token, conf_n}` (`conf_n = HMAC(K_conf, "n-confirm" ‖ T)`, mandatory for a v2 slot at both begin and redeem) + `finish`; `RedeemTransferToken` moves the slot to `enrolled` atomically with the credential (labelled with the slot's `platform`) + envelope insertion, drops `ct`, and stores `conf_n`, which O's final poll verifies. The enrollment token validates only while the slot is `approved`, so a duplicate finish, or a finish after `DELETE`/expiry, fails.

Exact formats (the wire contract between the two devices; helpers in `web/cloud/js/crypto.js`, "Path B protocol v2" block, used by both the origin screen `transfer.js` and `/claim`): every `‖` above is `encodeFields` framing (uint16-BE length ‖ bytes per field, strings UTF-8), including `mac_o`'s and `conf_n`'s `"reveal"`/`"n-confirm" ‖ T` (T is one field there). `accountId` in T and `mac_n` is the account **subdomain** — the one name the new device knows before approval. Public keys are compressed SEC1 P-256 points (33 bytes); the server's JSON carries all byte fields as standard base64. `K` is HKDF-Extract(salt = SHA-256(T), ikm = the 32-byte ECDH x-coordinate); `sas` = the first 8 bytes of HKDF-Expand(K, `"sas"`) as a big-endian integer mod 10^6, zero-padded to 6 digits and shown 3+3; `K_wrap`/`K_conf` = 32 bytes of HKDF-Expand(K, `"wrap"`/`"confirm"`). `ct` = 12-byte nonce ‖ AES-256-GCM(K_wrap, DEK, aad = T). The typed code is TK as a big-endian base-26 number, 28 letters `A`–`Z`, shown in 3-letter groups; input drops spaces, dots and dashes and ignores case. Until the base-domain `/d/<sub>` hand-off ships (med-r1j2.4) the QR/link opens `https://<sub>.<base>/claim#<slot>.<base64url TK>` and the typed code is entered at `/claim`.

Why each piece: `commit` before `n_pub`, `o_pub` after it → a relay cannot pick `o_pub'` after seeing `n_pub` nor `n_pub'` after seeing `o_pub` (the ZRTP ordering, RFC 6189 §4.4.1.1 — design intent, not an inherited proof). `mac_n`/`mac_o` under `TK` → a relay without `TK` cannot substitute anything. Reveal before Approve → both devices show the code while nothing is released. O's frozen `n_pub` + `aad = T` + server-side immutability → the envelope opens only for the receiver the owner saw the code for. A thief holding a leaked QR can claim, but the owner's own device then sees 409 and the origin shows a code no device of the owner displays → Deny; nothing was released. Limits are listed in [cloud-mode.md → The honest caveat](cloud-mode.md).

**Path C — recovery code (all devices lost) — implemented, C0b.** Fresh device → instance URL → "Recover" → type the code → client sends `verifier` to `POST /api/recover` (server checks hash, rate-limits 5 attempts/hour/account via `recovery_auth.failed_attempts` + `window_start_unix`) → downloads `envelope_rec` + a one-time enrollment token → `KEK_rec` unwraps DEK → enroll a new passkey via the same enrollment-token machinery as Path B. The UI then **forces recovery-code rotation** immediately after (new code, new `envelope_rec`, new verifier, re-rendered Emergency Kit with its own "I saved it" gate) — a used code is burned, per spec.

The `register/begin|finish` gate (`internal/cloudserver/webauthn.go`) generalizes across all three entry points: a signup claim token (C0a), a transfer/recovery enrollment token (C0b), or an existing session (an already-unlocked device enrolling an additional local passkey, e.g. a hardware security key) — each single-use where applicable, invalidated at finish.

### Removing a device / revocation

The device-list UI (`web/cloud/js/devices.js`) renders inside the app's Settings → Devices & connectors page (cloud builds only; `features/settings.js` `mountCloudDevices`), and in the unlock shell's warm-cache-write-failure fallback menu. The old `/devices` shell page redirects to that Settings page; only the Emergency Kit rotation (fresh passkey assertion) still runs on the shell, at `/devices?flow=emergency-kit` — see the C0b entry in the Phasing section of [docs/cloud-mode.md](cloud-mode.md).

- **Routine removal (implemented, C0b)**: `DELETE /api/devices/{credential_id}` deletes the WebAuthn credential and its envelope in one transaction. Rejects deleting the **last** verified credential unless usable recovery material exists (the recovery envelope **and** its verifier row — an interrupted setup with envelope but no verifier doesn't count), so an account can never be stranded. Session verification checks the credential still exists (the shared verify path, not a per-handler check), so any outstanding session token minted for that credential is rejected on its next use. Data keys unchanged — this is a credential-and-envelope-only removal.
- **Suspected compromise (stolen unlocked device) — documented gap, not implemented.** The spec calls for removal **plus DEK rotation** (DEK′, fresh snapshot under `K_data′`, re-wrap surviving envelopes, rotate NK). C0b ships only the routine-removal path above; a stolen-and-unlocked device retains a readable copy of any data it synced before revocation. The device-list UI's revocation copy distinguishes "retire device" (safe today) from "device stolen" (points at this limitation) until rotation lands. Initiated from any remaining device or via recovery code once implemented; this is why onboarding pushes a second enrolled credential so hard.
- Orphaned envelopes (user deleted the passkey at the OS level): harmless ciphertext; the device-list UI surfaces credentials that haven't asserted in N days for cleanup.
- Malicious/unverified envelopes: the device-list UI recomputes each envelope's `mac` with `K_mac` (available on any unlocked device) and renders **unverified — remove?** for any that fail — the client-side defense against a server or attacker inserting a credential it can't produce a valid MAC for (see Security analysis).

## The push key (NK) — why it exists

Push arrives at the service worker in the background: **no user gesture, no WebAuthn possible**. Rich reminder text therefore cannot be gated on a passkey ceremony. NK is the deliberate, documented compromise:

- NK encrypts *only* scheduled reminder payloads — never vault records.
- It lives plaintext in device IndexedDB (SW-reachable) and as an encrypted vault record (so every device holds the same NK).
- Exposure of NK reveals reminder texts, not health data; users who reject even that run generic-notification mode ("Medication reminder") and NK is never provisioned.

## Local at-rest posture

**The E2EE boundary is the cloud; the local boundary is the OS.**

- Local plaintext cache (Dexie/IndexedDB) and NK are protected by device unlock + OS full-disk encryption, the same posture any locally-stored database gets.
- The warm-unlock cache (`web/cloud/js/unlock.js`, `warmUnlock()`) holds only the leaf keys `K_data` and `K_mac` as **non-extractable** WebCrypto keys structured-cloned into IndexedDB (record v2 `{v:2, accountId, kData, kMac}` under device-store key `ldk2`); no DEK bytes live on disk or in the operational ctx. The raw DEK exists only inside ceremonies (signup, cold unlock, recovery, device transfer, kit rotation). A v1 record from an older shell (the DEK AES-wrapped under a local key, key `ldk`) is migrated on the next warm unlock and the `ldk` slot is emptied; a failed migration keeps v1 and retries next launch. v2 lives in its own slot so a rolled-back pre-v2 `/unlock` shell sees no cache (renders locked, deletes nothing) rather than a record it can't open (which it would delete); if that shell's cold unlock writes a fresh v1, it wins and is re-migrated. Every write is probed before it counts: a challenge sealed with `K_data` derived afresh from the ceremony DEK must open with the stored key, and a MAC minted from the ceremony DEK must verify with the stored `K_mac`. This removes the portable raw DEK but is **not** bounded XSS compromise: a non-extractable `CryptoKey` can still be `postMessage`-cloned to an attacker-origin window and kept as a decryption oracle (W3C WebCrypto §6.2), and the plaintext Dexie cache stays readable. It is also **not** disk-forensics protection — the browser profile on disk is the OS's problem. Stating this precisely matters; non-extractable keys are commonly oversold.
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
| Server tampers with a Path-B transfer slot | `mac_n`/`mac_o` under `TK` fail → the device aborts; `ct` is AES-GCM under a key only the frozen receiver derives, `aad = T`. ✅ |
| Server replays / reorders ciphertext | `account_seq` in AAD → decrypt-time detection. Withholding data (DoS) remains possible — availability is never zero-knowledge. ⚠️ known limit |
| Phishing / fake login page | Passkeys are origin-bound: a look-alike site cannot run an assertion for the real RP ID, so neither auth nor PRF output is obtainable. Stronger than any passphrase flow. ✅ |
| Stolen **locked** device | OS boundary: passkey needs UV; LDK cache needs the unlocked browser profile. Remote-revoke from another device regardless. ✅ |
| Stolen **unlocked** device | Full read of that device's copy — true of every E2EE app. Response: revoke + DEK rotation from a surviving credential. ⚠️ inherent |
| XSS on the instance origin | Catastrophic while unlocked (reads plaintext, uses LDK). The warm-unlock cache holds only non-extractable leaf keys, so same-origin script cannot read the raw DEK from it — but a non-extractable `CryptoKey` can still be cloned out as a decryption oracle and plaintext in Dexie stays readable (see Local at-rest posture). The real defenses are upstream: strict CSP, zero third-party script, SRI, SW-pinned bundles (cloud-mode.md code-serving caveat). **Exfil is now bounded by a per-account `connect-src` allowlist** — see below. ⚠️ inherent to web crypto |
| Loss of all passkeys **and** the recovery code | Data unrecoverable, by design. Mitigated by onboarding: enroll ≥2 credentials, keep the Kit. ⚠️ stated plainly |

## Edge cases

- **Synced passkey (iCloud/Google)**: same credential ⇒ same PRF ⇒ the *same envelope* serves every device in the sync fabric — multi-device for free, and phone loss becomes a non-event. Supported, never assumed.
- **Browser storage cleared**: passkeys live in the platform authenticator, not browser storage → cold unlock fully recovers; only the LDK cache and local plaintext cache are lost.
- **PRF-capable check on every new credential** — a mixed account (one PRF passkey + one non-PRF) is never created; enrollment of a non-PRF credential aborts before any envelope is written.
- **Concurrent enrollments**: envelopes are independent rows keyed by credential id — no coordination needed.
- **Sign counters**: platform authenticators commonly report 0; do not use counters for clone detection.
- **WebAuthn needs a top-level secure context + user gesture**: all ceremonies are button-initiated in the installed PWA; none are needed for background sync (session tokens) or push decrypt (NK).

## Per-account egress allowlist (CSP `connect-src`)

The account app document (`/` on the account subdomain) holds the in-memory DEK and
decrypted records, so its `connect-src` governs where an on-origin XSS could POST
that plaintext. It used to relax `connect-src` to `'self' https: wss:` because the
browser-direct BYO-provider calls (AI, food-DB, ElevenLabs) go to user-configured
origins the server couldn't know — a wildcard that let an XSS exfil to **any**
`https:` origin instantly.

That wildcard is gone. The client registers its provider **hostnames** — never keys,
never health data — via `PUT /api/egress-hosts` after unlock (from `apishim.js`) and
again on a Settings integrations save (with a "reload to apply" hint, since the CSP
updates on the next document load). The server persists a short per-account hostname
list and emits a scoped `connect-src`:

```
connect-src 'self' https://<host1> https://<host2> https://api.elevenlabs.io wss://api.elevenlabs.io
```

`api.elevenlabs.io` (https + wss) is always included — its host is operator-known and
fixed; only its API key is BYO. Static/asset paths (`/static/*`, `/domain/*`) get
`connect-src 'self'`. **No document anywhere on the origin serves a wildcard `https:`
`connect-src`**, so an XSS spawning a same-origin child frame inherits the same scoped
allowlist and gains no new reach — unlike the earlier sandboxed-iframe attempt, whose
relaxed-CSP document was itself a bypass gadget.

**What the operator learns:** which provider *hostname* each account uses. The API key
and all health data stay client-only / encrypted — only the hostname list is
server-side.

**Honest residual:** an on-origin XSS can call `PUT /api/egress-hosts` to add an
attacker host and then force a reload to pick up the widened CSP. This is strictly
harder than the old instant arbitrary-origin exfil — it needs persistence plus a
navigation — but it is **not** a total close. Enforced by `TestRouter_HostVariants` /
`TestRouter_AppDocumentReflectsEgressHosts` (served CSP reflects stored hosts, no bare
`https:`/`wss:` token). See [cloud-mode.md](cloud-mode.md).

`script-src` is the other half of this and is now a plain `'self'` on every document,
including this one — the `blob: data:` allowance the voice SDK's AudioWorklets used to
force is gone (the worklets are self-hosted and handed to the SDK as paths). The SDK's
libsamplerate resampler, which it otherwise pulls from jsdelivr on engines that cannot
pin the AudioContext sample rate, is self-hosted the same way (bd med-yor.17) rather
than allowed through as a CDN host. `img-src` is likewise a plain `'self'`: the photo
barcode path decodes with `createImageBitmap` onto a canvas instead of loading a
`blob:` URL into an `<img>` (bd med-bje). What that
does **not** fix is that the operator serves the script in the first place: see
[security/release-integrity.md](security/release-integrity.md) for that boundary stated
plainly, the build-provenance / published-hash evidence that makes a divergence
detectable, and the verification commands.

## Open questions

- PRF-over-hybrid (Path A) support matrix — still deferred; revisit if the platform matrix matures enough to justify a second enrollment path alongside Path B.
- DEK rotation on suspected-compromise revocation — the documented C0b gap above; needs the snapshot/re-wrap/NK-rotation flow designed and built.
- Strict mode scope: ceremony-per-launch only, or also ciphertext-at-rest locally?
- **Decided (C0b)**: envelope `mac` verification failures warn (device-list "unverified — remove?" badge), not hard-block — avoids a server-controlled DoS lever.
- **Decided (C0b, revised med-r1j2)**: typed-fallback UX for Path B on devices without cameras — TK alone as 28 letters (base-26, 3-letter groups, "Code for a computer"); the slot id is derived from it.
- Formal review: the construction is conventional (envelope encryption + HKDF domain separation + AEAD with bound AAD), but C0 should include an external cryptographic review before beta.
