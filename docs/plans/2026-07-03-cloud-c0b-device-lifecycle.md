# Cloud C0b — device lifecycle: QR add-device, recovery, revocation

Second of three sequential C0 plans. **Depends on `2026-07-03-cloud-c0a-foundation-passkey-signup.md` being completed** (cmd/cloud, cloudstore, WebAuthn ceremonies, envelope API, client shell + crypto.js all exist). Normative spec: [docs/cloud-crypto.md](../cloud-crypto.md) — ceremonies "Enrolling a new device" (Path B is primary per product decision; Path A hybrid is out of scope for C0) and "Removing a device / revocation".

## Overview

A user with one enrolled device can, entirely self-service: (1) add a second device by scanning a QR code (or typing a fallback code), which hands the DEK over through a server-blind transfer slot and enrolls a new passkey + envelope on the new device; (2) recover on a fresh device with the Emergency Kit recovery code, with forced code rotation afterwards; (3) see all enrolled devices/passkeys, verify their envelopes via the audit MAC, and revoke any of them.

QR mechanics (the trick that avoids shipping a camera/scanner): the QR encodes a plain URL `https://<sub>.<base>/claim#<slot_id>.<TK>` — the new phone scans it with its **native camera app** and just opens the link; the transfer key rides the URL fragment and never reaches the server. Desktops type the fallback code instead.

## Context (from discovery)

- Transfer-slot crypto and formats: docs/cloud-crypto.md "Path B — QR hand-off" (`TK` 256-bit, `ct = AES-GCM(TK, DEK, aad="mt/v1/xfer"‖account_id)`, TTL 10 min, single fetch, enrollment token authorizes credential registration).
- `internal/cloudserver` register/begin from C0a already supports claim-token-gated first registration; this plan generalizes the gate: claim token (signup) OR enrollment token (transfer) OR session (an already-unlocked device adding a local passkey).
- QR encoder already vendored in `web/cloud/vendor/` (C0a Task 9).
- Recovery verifier storage + rate-limit columns (`recovery_auth.failed_attempts`, `window_start_unix`) exist from C0a migration 001.
- Envelope audit MAC (`K_mac` HMAC) is implemented in `web/cloud/js/crypto.js` (C0a Task 8); this plan adds the UI that computes/verifies it.

## Development Approach

- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data migration, cross-component flow) and gives a guarantee manual checking can't
  - if no integration test adds a real guarantee, the task has NO test items — that is correct and expected
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: if a task adds an integration test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility (C0a flows must keep working unchanged)

## Testing Strategy

- **Unit tests**: none. Do not add unit tests.
- **Integration tests**: three real boundaries — (1) transfer-slot lifecycle (single fetch, TTL expiry, tamper = AEAD failure is client-side but slot consumption is server contract), (2) recovery redemption incl. rate limiting and forced-rotation sequence, (3) revocation cascade (credential + envelope removed, session invalidated).
- **E2E tests**: none.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope

## What Goes Where

- **Implementation Steps**: migrations, endpoints, client flows, integration tests
- **Post-Completion**: real two-phone walkthrough, paper-kit recovery drill

## Implementation Steps

### Task 1: transfer slots (server)

- [x] migration `002_transfer_slots.sql`: `transfer_slots(id TEXT PK, account_id TEXT NOT NULL, enrollment_token_hash BLOB NOT NULL, ct BLOB NOT NULL, created_at_unix INTEGER NOT NULL, expires_at_unix INTEGER NOT NULL, fetched INTEGER NOT NULL DEFAULT 0)`
- [x] `POST /api/transfer` (session auth, i.e. an unlocked device): body `{ct}`; server generates `slot_id` + enrollment token, stores hash, returns `{slot_id, enrollment_token, expires_at}` — note the plaintext `TK` never appears in any request
- [x] `POST /api/transfer/{slot_id}/claim` (unauthenticated, subdomain host): valid+unexpired+unfetched slot → mark fetched, return `{ct, enrollment_token}`; single use enforced atomically (UPDATE ... WHERE fetched=0 + RowsAffected check)
- [x] lazy cleanup: expired/fetched slots deleted on each transfer API call (`ponytail:` no background sweeper; slot volume is trivial)
- [x] integration test: create → claim → second claim 410s; expired slot 410s — guards single-use + TTL contract

### Task 2: register/begin accepts enrollment tokens

- [x] extend `POST /api/webauthn/register/begin|finish` gate from C0a: accept `enrollment_token` (from a claimed slot) as an alternative to the signup claim token; token is single-use, bound to the slot's account, invalidated at finish
- [x] also allow plain session auth on register/begin (an unlocked device enrolling an additional local passkey — e.g. adding a security key)
- [x] integration test: registration via enrollment token succeeds; reuse of the token fails — guards the generalized gate

### Task 3: "Add device" flow on the old device (client)

- [ ] `web/cloud/js/transfer.js`: unlocked device → "Add device" → generate `TK` (256-bit), encrypt DEK per spec (`aad="mt/v1/xfer"‖account_id`), `POST /api/transfer`, render QR of `https://<sub>.<base>/claim#<slot_id>.<base64url(TK)>` plus the typed-fallback string (`<slot_id>.<TK-base32>`), live TTL countdown
- [ ] device-list screen entry point (Task 5 hosts the button; render standalone screen now)

### Task 4: claim flow on the new device (client)

- [ ] `/claim` route in the shell: parse fragment (or show typed-code input when fragment absent) → `POST .../claim` → decrypt DEK with `TK` (AEAD failure → explicit "code invalid or tampered" error, abort) → hold DEK in memory
- [ ] proceed into the existing registration ceremony (register/begin with enrollment token) → create local passkey → immediate `get()` for PRF → wrap DEK → `PUT` envelope (computing its audit `mac` with `K_mac`) → session established → warm-unlock cache (LDK) seeded
- [ ] PRF-unsupported error state reused from C0a signup (abort before envelope upload)

### Task 5: device list, envelope audit, revocation

- [ ] `GET /api/devices` (session auth): credentials joined with envelopes — `{credential_id, created_at, last_asserted_at, envelope: {v, nonce, ct, mac}}`
- [ ] `DELETE /api/devices/{credential_id}` (session auth): delete credential + its envelope in one tx; reject deleting the **last** verified credential unless a recovery envelope exists (never strand an account); invalidate outstanding sessions minted for that credential (session tokens carry credential_id — verification now checks the credential still exists)
- [ ] client device-list screen: verify each envelope's `mac` with `K_mac` (unlocked device has DEK) → render verified / **unverified — remove?** badge per spec's malicious-credential defense; revoke button with confirm
- [ ] revocation UX copy distinguishes "retire device" from "device stolen" — the latter points to DEK rotation (out of C0 scope, documented as known limitation in docs/cloud-crypto.md status note)
- [ ] integration test: revocation cascade — credential gone, envelope gone, old session token rejected — guards the security-relevant cleanup

### Task 6: recovery redemption + forced rotation

- [ ] `POST /api/recover` (unauthenticated, subdomain host): body `{verifier}`; constant-time compare against `recovery_auth.verifier_hash`; rate limit 5 attempts/hour per account (use `failed_attempts` + `window_start_unix` columns); success returns the `recovery` envelope + a one-time enrollment token
- [ ] client `/recover` route: type recovery code → derive `verifier` + `KEK_rec` (crypto.js has both from C0a) → redeem → unwrap DEK → enroll new passkey via enrollment token (reuse Task 4 machinery)
- [ ] forced rotation immediately after: generate new recovery code, upload new `recovery` envelope + new verifier (old one overwritten in the same flow), re-render Emergency Kit with "I saved it" gate — a used code is burned, per spec
- [ ] integration test: redemption happy path; 6th attempt within the hour rejected; old verifier rejected after rotation — guards the recovery contract + rate limit

### Task 7: Verify acceptance criteria

- [ ] local two-browser-profile walkthrough (`CLOUD_BASE_DOMAIN=localhost`): enroll profile A → add "device" profile B via typed fallback code → both unlock independently → revoke B from A → B's session dead, A unaffected
- [ ] recovery walkthrough: lock A, redeem recovery code in fresh profile, confirm forced rotation, old code rejected
- [ ] `go test ./...`, `pnpm test`, both build modes, linter — all pass/fixed

### Task 8: [Final] Update documentation

- [ ] docs/cloud-crypto.md: mark Path B + recovery + revocation as implemented; note Path A (hybrid PRF) explicitly deferred and DEK rotation as the documented gap
- [ ] docs/cloud-mode.md recovery matrix: verify rows match shipped behavior
- [ ] docs/api.md or docs/cloud-deployment.md: new endpoints

## Technical Details

- **QR-as-URL**: native camera scanning means zero scanner code and works iOS+Android; the fragment (`#slot.TK`) is never sent to the server by browsers. Typed fallback covers desktops and camera-less cases.
- **Token hygiene**: enrollment tokens and claim tokens share storage shape (hash, TTL, single-use); reuse the C0a helper rather than a second implementation.
- **Session↔credential binding**: revocation relies on session verification checking credential existence — this is the one behavior change to C0a's middleware; keep it in the shared verify path so all routes inherit it (root-cause placement, not per-handler checks).

## Post-Completion

**Manual verification**:
- Real two-phone walkthrough: iPhone displays QR → Android native camera scans → claim → enroll → both unlocked; then the reverse direction
- Paper drill: print Emergency Kit, recover on a freshly-wiped browser profile from the printed code + QR
- Confirm revoked device's PWA lands on the locked screen and cannot re-auth
