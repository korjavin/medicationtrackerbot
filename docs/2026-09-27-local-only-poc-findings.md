# Explicit local-only passkey POC — findings (med-eas.2.1)

**Date:** 2026-09-27
**Bead:** `med-eas.2.1` (child of `med-eas.2`)
**Research basis:** [2026-07-13-cloud-prf-compatibility-research.md](2026-07-13-cloud-prf-compatibility-research.md)
**Status:** prototype behind an explicit opt-in flag; not a production rollout

## Verdict: keep PRF-only as the production default

The POC proves the mechanism is sound — an explicitly typed `local_only`
credential can authenticate via ordinary WebAuthn while the device-local LDK
wraps the DEK, with no new decrypting material server-side and honest
recovery UX at every dead end. But the research doc sets the acceptance bar
as "honest recovery UX **and** no server-side cryptographic regression,"
and only the second half is fully demonstrated here:

- **Cryptographic boundary: demonstrated.** The server stores one type label
  per credential and rejects any envelope (or other share) on the
  local-only path. `TestRegisterFinish_LocalOnlyViaEnrollmentToken` pins
  that no envelope row exists for a local-only credential, and R1/R5 are
  untouched: no passphrase KEK, no XOR split (still rejected, not
  implemented), no low-entropy verifier.
- **Recovery UX honesty: demonstrated in code, not yet in users.** Every
  local-only dead end names the Emergency Kit or trusted-device transfer
  and never pretends the passkey can recover. But the research doc's core
  open question — "can users understand that an ordinary synced passkey
  will not recover their vault on a fresh device?" — needs comprehension
  testing and a physical authenticator matrix (Bitwarden interception,
  platform passkeys, at least one roaming key) that this POC does not run.
  Until that lab work lands, the mode stays behind its flag.

Recommendation: keep the flag for lab validation and support diagnostics;
do not promote local-only to a first-class enrollment path until (1) the
physical matrix in the research doc's open questions is executed, and
(2) the warned-consent + fresh-profile dead-end copy survives real-user
comprehension testing.

## What was built

Delivered behind two switches that must BOTH be on: the browser opt-in
`?local-only-poc=1` (sticky to localStorage; no in-product toggle, so nobody
enables it by accident) AND the operator flag `CLOUD_LOCAL_ONLY_POC`
(default off), enforced in `register/finish` and advertised on the existing
`GET /api/version` response. A crafted link or stale browser flag alone can
never enable the fallback. Default behavior is byte-identical to the PRF-only
product: PRF stays the default path and its immediate-assertion probe is
unchanged.

| Piece | Where | Notes |
|---|---|---|
| Credential mode label | `internal/cloudstore/migrations/025_credential_mode.sql`, `Credential.Mode` | `'prf'` / `'local_only'`, explicit end to end, never inferred from envelope absence |
| Local-only registration | `internal/cloudserver/webauthn.go` (finish `mode` field) | Enrollment + session gates only; first credential must be PRF (400 otherwise); any envelope on a local-only finish is rejected (400) |
| Envelopeless persistence | `RedeemTransferTokenLocalOnly`, `AddCredentialLocalOnly` | No envelope row; wrong-mode callers rejected at the store layer |
| Last-credential guard | `DeleteCredentialWithEnvelope` | Local-only credentials do not count as unwrap paths: deleting the last PRF credential with only local-only left and no recovery material returns 409 |
| Mode-aware device list | `internal/cloudserver/device.go` | Each entry carries its explicit `mode` |
| Flag + warned copy | `web/cloud/js/credential-mode.js` | `isLocalOnlyPocEnabled()`, research-doc warning copy verbatim |
| Diagnostic harness | `web/cloud/js/prf-diagnostic.js` | Create + immediate-get probe recording outcomes only; sanitized downloadable report |
| Warned enrollment | `web/cloud/js/claim.js` | Consent screen → LDK staged + verified pre-finish → finish (mode, no envelope; 409 without recovery) → recovery re-confirmation → rollback (DELETE) only on post-commit surprise |
| Mode-gated unlock | `web/cloud/js/unlock.js` | Stored mode routes after the assertion verifies: local-only always takes the LDK (even with fresh PRF output); cleared cache / fresh profile throws `local-only-recovery-required` |
| Badges + revocation copy | `web/cloud/js/devices.js`, `web/cloud/css/cloud.css` | `local-only — this browser only` badge, no envelope audit for local-only, distinct removal copy |

## Acceptance criteria — disposition

1. **Diagnostic harness proves create + immediate PRF get without recording
   secret material.** Done. `runEnrollmentDiagnostic` records stage
   outcomes, the create-time `enabled` flag, PRF-result length, and a coarse
   error class; PRF bytes, credential IDs, attestation, and raw error text
   never enter the outcome. `buildDiagnosticReport` re-validates
   (`assertReportSanitized` fails closed) before producing the downloadable
   file. The unsupported-authenticator screen offers a re-probe of the
   failed, never-registered credential behind the flag.
2. **Credentials explicitly typed PRF or local_only.** Done. The label is a
   DB column, a finish-request field, and a device-list field; unknown modes
   are rejected (400) and the client never infers from envelope absence.
3. **Local-only enrollment completes only after durable LDK wrapping and
   recovery material are confirmed.** Done, enforced on both sides. The
   client stages and verifies the fresh LDK record (reads back, unwraps to
   the ceremony DEK) *before* finish, so a storage-blocked browser fails
   while its token is still unspent; a failed finish also clears the staged
   record. The server commits only when usable recovery material exists —
   envelope AND verifier row, checked in the same transaction as the
   insert (409 otherwise, token unspent). The client re-confirms the
   recovery envelope post-commit as defense-in-depth and rolls back (DELETE)
   only on a post-commit surprise.
4. **Warm reopen works.** Done with zero new code paths: warm unlock never
   touches PRF, so a local-only device reopens silently from its LDK. Pinned
   by `local-only-unlock.test.js` (real WebCrypto + in-memory IndexedDB).
5. **Site-data deletion and fresh-profile synced passkeys require Emergency
   Kit or trusted-device transfer.** Done. Both present as "assertion valid,
   LDK absent" and throw `local-only-recovery-required`, rendered alongside
   the existing Emergency Kit link. No envelope is ever fetched on this
   path.
6. **No new decrypting share or low-entropy material server-side.** Done.
   Migration 025 adds a label only; the finish handler rejects envelopes on
   local-only registrations; tests assert the envelope table gains no row.
7. **Device removal, last-credential guards, recovery rotation, envelope
   audit specified and tested.** Done:
   - *Removal:* local-only removal is auth-only cleanup with its own copy;
     revoking the last PRF credential while only local-only remains is
     refused (409) unless usable recovery material exists.
   - *Last-credential guard:* counts PRF credentials, not credentials; the
     check stays inside the delete transaction (no TOCTOU).
   - *Recovery rotation:* unchanged code path — `rotateEmergencyKit` takes
     whatever fresh assertion `assertPasskey` returns and re-wraps the DEK
     it hands back (PRF-unwrapped on the default path, LDK-unwrapped for a
     local-only assertion behind the flag). The security property (fresh
     user presence before invalidating someone's kit) holds either way.
   - *Envelope audit:* local-only entries skip the MAC audit (no envelope
     expected) and render their own badge; PRF entries without envelopes
     still render `unverified — remove?`.
8. **PRF default path and immediate assertion probe preserved.** Done. With
   the flag off, signup/claim/unlock render and behave exactly as before
   (all pre-existing cloud suites pass unmodified); the 32-byte immediate
   assertion check is untouched.

## Deliberate POC boundaries (not oversights)

- **Account bootstrap must be PRF-backed.** The server rejects local-only
  enrollment via the claim gate, answering the research doc's open question
  conservatively for the POC: every account starts life with a PRF unwrap
  path plus recovery material. This keeps criterion 3 meaningful instead of
  circular (a first-credential local-only flow would need recovery material
  uploaded before any session exists). This is an enrollment-gate
  restriction, not an account-level invariant — an account whose PRF
  credentials were all revoked can later hold only local-only credentials
  plus recovery material.
- **No session-gate local-only UI.** The server accepts local-only
  enrollment behind plain session auth (an unlocked device adding a local
  passkey), but no client screen drives that gate — the POC's client covers
  the transfer/recovery enrollment-token path only.
- **Sticky POC flag.** A `?local-only-poc=1` opt-in persists to localStorage
  on first sight, because enrollment redirects drop the query string and a
  later reauthentication on a bare URL must not reject the credential just
  enrolled. There is still no in-product toggle.
- **Strict mode incompatibility is specified, not enforced.** Strict mode
  (no LDK) does not exist yet in the product (cloud-crypto.md: "later,
  optional"), so there is no toggle to gate; when it lands, local-only
  credentials must refuse to enroll under it.
- **No manager allowlist, no feature sniff, no XOR split.** As specified.

## Known POC limitations (from the #888 compatibility review)

- The POC unlock path mints a session before rejecting a PRF credential
  whose authenticator dropped PRF output (`finishPocUnlock` runs
  `login/finish`, then finds no output for a PRF-labelled credential and
  throws). Production checks before finish; the DEK is never exposed, but
  the probe ordering differs on flagged browsers.
- Rolling the binary back after migration 025 has run makes local-only rows
  look like broken PRF devices to the old client ("unverified — remove?",
  no envelope), and the old delete guard counts all credentials. Both are
  harmless, and the rollback direction is not a supported POC operation.
- `credentials.mode` has no CHECK constraint; the application validates the
  label on write (unknown modes rejected with 400).
- Failed local-only enrollment restores the LDK record it found (or clears
  the staged one when there was none), but a crash between staging and the
  outer catch — or a tab closed mid-ceremony — can still leave a staged
  cache behind. The next visit then warm-redirects without a valid session
  until the user cold-unlocks; nothing decryptable is stranded server-side.

## Remaining work before any ship decision

1. Execute the physical lab matrix (Bitwarden interception, platform
   passkeys, roaming key, current 1Password / Google / Apple managers) via
   the diagnostic harness; keep the dated results as support diagnostics,
   never as enrollment logic.
2. Comprehension-test the warned consent and the fresh-profile dead end
   with real users; the POC copy is the research doc's draft.
3. Decide the first-credential question for production (keep the POC's
   PRF-first restriction, or design pre-session recovery upload).
4. Decide whether rotation should keep accepting local-only assertions or
   require a PRF ceremony; the POC allows either and the rationale is
   above.
5. External cryptographic review of the mode plumbing (conventional, but
   the project already wants one for C0 before beta).
