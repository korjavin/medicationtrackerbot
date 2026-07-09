# Already-claimed claim link prompts unlock, never passkey creation

## Overview

Re-opening a cloud claim link (`https://<sub>.<base>/#claim=<hex>`) that has **already been claimed**
currently drops the visitor on the signup wizard's "Create your passkey" button. Clicking it produces
the misleading error *"Could not start passkey registration — the invite link may be expired."* and the
button stays on screen. The account is not expired — it is claimed, and this person almost certainly
already owns a passkey for it.

After this change, an already-claimed link never renders passkey-creation UI. It renders an
"already claimed" screen that asks the user to **unlock their vault with their existing passkey**, and
tells them that on a brand-new device they should open the app on their former device and share access
from there.

Two halves, because today neither side can tell "claimed" from "expired":

1. **Server** — `RegisterBegin` folds every claim failure into a plain-text `403 "invalid or expired claim"`.
   It gains a distinct `409 {"error":"already_claimed"}` for the claimed case.
2. **Client** — the signup wizard picks "Create your passkey" purely from the presence of a `#claim=`
   fragment, never asking the server first. It gains a probe on load.

Backward compatible: genuinely expired/garbage tokens still get the existing `403` and the existing
expired-link message. The happy path (a pending invite) renders exactly as it does today.

## Context (from discovery)

Files/components involved:

- `internal/cloudserver/webauthn.go` — `RegisterBegin` at `:235`, its claim branch at `:254-261`,
  `validClaimToken` at `:589-605`, challenge persistence at `:321-333`.
- `internal/cloudserver/webauthn_test.go` — existing handler integration tests.
- `web/cloud/js/signup.js` — `runSignupWizard` at `:19-21`, `renderWelcome` at `:23-44`
  (renders the `#create-passkey` button at `:29`), `startRegistration` at `:47-52`.
- `web/cloud/js/app.js` — dispatch at `:46` (`else if (claimToken)` → `runSignupWizard`) and `:49`
  (`else` → `runUnlockFlow` from `./unlock.js`). **This file needs no change** — the probe lives inside
  `runSignupWizard`, so the dispatch stays as-is.
- `web/cloud/js/tests/cloud-boot.test.js` — the cloud-shell pure-unit test convention to follow.

Related patterns found:

- Claimed state is **not** a column. `consumeClaimTx` (`internal/cloudstore/repo.go:312-314`) sets
  `claim_token_hash = NULL` and `claim_expires_unix = NULL`. Unclaimed = hash non-NULL; claimed = hash NULL.
  The account row always exists. Schema: `internal/cloudstore/migrations/001_init.sql:7-8`.
  **No migration is needed.**
- `webauthnStore` (`internal/cloudserver/webauthn.go:39-47`) **already exposes**
  `CredentialsByAccount(ctx, accountID) ([]cloudstore.Credential, error)` at `:44`. No interface change,
  no new repo method.
- `RegisterFinish` (`:420-429`) already returns `409 "claim already used or expired"` on
  `cloudstore.ErrClaimInvalid` — so `409` is already this handler's idiom for "claim consumed".
- `cloudstore.ErrAlreadyClaimed` (`repo.go:32-35`) exists but is admin-only (`ResetClaim`); it is **not**
  on the claim-link read path and this plan does not touch it.
- `signup.js` deliberately renders error text via `textContent`, never interpolated `innerHTML` — this page
  holds the DEK. New screens must keep that discipline.

Dependencies identified: none new. No migration, no new HTTP route, no new npm/Go dependency.

## Design decisions

- **Probe the existing `POST /api/webauthn/register/begin`; do not add a route.** The client already has to
  call this endpoint, and it is the exact validity check we want. A new `GET /api/claim/state` would be new
  unauthenticated public surface for information the existing endpoint already computes.
- **Double-begin on the happy path is safe and intended.** Each `RegisterBegin` calls `a.challenges.put(...)`
  for a fresh `challengeID` and then `setChallengeCookie(...)` (`webauthn.go:321-333`). The probe's cookie is
  simply overwritten by the click's cookie — last write wins, and the orphaned first challenge expires on its
  own. `RegisterFinish` only ever reads the cookie's challenge, so it always sees the click's.
- **"Already claimed" = `account.ClaimTokenHash == nil` AND the account has ≥ 1 credential.** The credential
  check matters: a freshly provisioned-then-expired-and-swept account also has a NULL hash but no credentials,
  and that is an expired link, not a claimed one.
- **`409` carries JSON; `403` stays plain text.** Only the new claimed case needs a machine-readable code.
  Rewriting the existing `403` to JSON would be a gratuitous contract change for other callers.
- **The probe lives in `runSignupWizard`, not `app.js`.** Keeps the dispatch table untouched and keeps all
  claim-screen knowledge in one module.

## Development Approach

- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data migration, cross-component
    flow) and gives a guarantee manual checking can't
  - if no integration test adds a real guarantee, the task has NO test items — that is correct and expected
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: if a task adds an integration test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility

## Testing Strategy

- **Unit tests**: none. Do not add unit tests.
- **Integration tests**: two, both guarding real boundaries.
  - Go: the `RegisterBegin` HTTP contract has three distinct outcomes that the client now branches on. That is
    an API contract worth pinning.
  - Frontend: the "never render passkey creation on a claimed link" guarantee is the entire bug. Per repo rule 8,
    new behavior belongs in the owning feature suite via `tests/helpers/frontend-harness.js` — but the cloud shell
    (`web/cloud/js/`) has **no integration entry point**, which is exactly the documented exception. Follow the
    existing pure-unit convention of `web/cloud/js/tests/cloud-boot.test.js`.
- **E2E tests**: none. The project has no e2e suite for the cloud shell.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope
- Keep plan in sync with actual work done

## Implementation Steps

### Task 1: `RegisterBegin` distinguishes already-claimed from expired

- [x] in `internal/cloudserver/webauthn.go`, in the `case req.ClaimToken != "":` branch (`:254-261`), when
      `validClaimToken` returns `valid == false`, check for the claimed case before falling through to the `403`:
      if `account.ClaimTokenHash == nil`, call `a.store.CredentialsByAccount(r.Context(), account.ID)` and, when
      it returns ≥ 1 credential, respond `writeJSON(w, http.StatusConflict, map[string]string{"error": "already_claimed"})`
- [x] on a `CredentialsByAccount` error respond `500 "server error"` and log with `slog.Error("register begin: credential lookup", "error", err, "account_id", account.ID)` (repo rule 5: `log/slog` with contextual args)
- [x] leave the existing `http.Error(w, "invalid or expired claim", http.StatusForbidden)` as the fallback for
      genuinely expired / mismatched / swept tokens (NULL hash + zero credentials → still `403`)
- [x] add a short comment on the branch explaining why the credential count is the discriminator (NULL hash alone
      also matches an expired-and-swept account)
- [x] integration test in `internal/cloudserver/webauthn_test.go`: drive the real handler over `httptest` for all
      three outcomes — pending invite → `200`; claimed account (consume the claim + add a credential, then re-POST
      the same token) → `409` with body `{"error":"already_claimed"}`; unknown/expired token → `403`

### Task 2: Signup wizard probes claim state before rendering

- [x] in `web/cloud/js/signup.js`, change `runSignupWizard(claimToken)` to `await` a probe of
      `POST /api/webauthn/register/begin` (same body shape as `startRegistration`: `{ claim_token: claimToken }`)
      before rendering anything
- [x] on `res.status === 409` with a body whose `error === 'already_claimed'` → `renderAlreadyClaimed(app)`
      (minimal screen added here; Task 3 fleshes out copy + unlock hand-off)
- [x] on `res.ok` → `renderWelcome(document.getElementById('app'), claimToken)` exactly as today (the probe's
      challenge cookie is harmlessly overwritten when the user clicks "Create your passkey" and `startRegistration`
      calls begin again — see Design decisions)
- [x] on any other non-OK status (incl. `403`) → `renderWelcome(app, claimToken, <existing expired-link message>)`
      so today's expired-link behavior is preserved
- [x] if the probe itself throws (network/offline) → `renderWelcome(app, claimToken, err.message)`, matching the
      existing failure affordance rather than leaving `#app` blank

### Task 3: The "already claimed" screen

- [x] add `renderAlreadyClaimed(app)` to `web/cloud/js/signup.js`: heading that states the invite has already
      been claimed, body copy telling the user to unlock with the passkey they already created, and a separate
      line of new-device guidance ("If this is a new device, open Med Tracker on your former device and share
      access from there.")
- [x] primary action button hands off to the unlock flow: `const { runUnlockFlow } = await import('./unlock.js'); await runUnlockFlow();`
      — the same module `app.js:49` uses, so a claimed link converges on the normal returning-device path
- [x] reuse the existing `wizard-step` section markup/classes; **no hardcoded colors and no inline `.style.`
      assignments** (repo rule 3) — design tokens / existing CSS classes only. If a new class is needed, define it
      with `--wg-*` tokens (none needed — `wizard-step` / `wizard-error` cover it)
- [x] render all copy via `textContent` / static markup, never interpolated `innerHTML` (this page holds the DEK,
      per the comment at `signup.js:33-34`)
- [x] introduce **no** new `window.*` global (repo rule 4)

### Task 4: Frontend coverage for the claimed-link branch

- [x] add `web/cloud/js/tests/signup.claimed-link.test.js` following the `web/cloud/js/tests/cloud-boot.test.js`
      convention (cloud shell has no integration entry point — the documented rule-8 exception)
- [x] case: probe returns `409 {"error":"already_claimed"}` → the rendered DOM contains the already-claimed copy
      and the new-device guidance, and **does not** contain a `#create-passkey` element (this is the regression guard)
- [x] case: probe returns `200` → `#create-passkey` renders, as today
- [x] case: probe returns `403` → `#create-passkey` renders alongside the expired-link error text
- [x] ⚠️ resolved — no stub needed. `crypto.js` only calls WebCrypto inside functions, never at module scope, and
      Node provides `globalThis.crypto`, so `import { runSignupWizard } from '../signup.js'` works as-is under the
      suite's `environment: 'node'` + explicit `JSDOM` document (the `telegram.test.js` pattern). `signup.js` untouched.

### Task 5: Verify acceptance criteria

- [ ] verify a claimed link never renders passkey-creation UI, and its primary action leads to unlock-with-passkey
- [ ] verify an expired/garbage token still shows the existing expired-link message (no `409`, no new screen)
- [ ] verify a pending invite still completes signup end to end (probe → welcome → create passkey → finish),
      confirming the double-begin does not break `RegisterFinish`
- [ ] verify the edge case where an account is claimed but all its credentials were later deleted → falls back to
      `403` expired-link copy (acceptable; note it in the docs task)
- [ ] `go test ./...` passes
- [ ] `pnpm test` passes
- [ ] `go vet ./...` passes

### Task 6: [Final] Update documentation

- [ ] in `docs/cloud-mode.md`, under the Onboarding section, document that `POST /api/webauthn/register/begin`
      returns `409 {"error":"already_claimed"}` when the account is already claimed, and that the wizard probes it
      on load so a claimed link routes to unlock
- [ ] in `docs/api.md`, if the cloud WebAuthn endpoints are catalogued there, add the `409` response to
      `POST /api/webauthn/register/begin`
- [ ] note the claimed-but-no-credentials edge case (falls back to `403`) wherever the `409` is documented

## Technical Details

**Server, `internal/cloudserver/webauthn.go`, claim branch:**

```
case req.ClaimToken != "":
    hash, valid := validClaimToken(account, req.ClaimToken, time.Now().UTC())
    if !valid {
        // A NULL claim hash means either "already claimed" or "expired and swept".
        // Registered credentials are what tell the two apart.
        if account.ClaimTokenHash == nil {
            creds, err := a.store.CredentialsByAccount(r.Context(), account.ID)
            if err != nil { /* slog.Error + 500 */ }
            if len(creds) > 0 {
                writeJSON(w, http.StatusConflict, map[string]string{"error": "already_claimed"})
                return
            }
        }
        http.Error(w, "invalid or expired claim", http.StatusForbidden)
        return
    }
    gate, tokenHash = gateClaim, hash
```

**Response contract for `POST /api/webauthn/register/begin` with a `claim_token`:**

| account state                       | status | body                          |
|-------------------------------------|--------|-------------------------------|
| pending invite, token matches        | 200    | WebAuthn creation options     |
| claimed (NULL hash, ≥1 credential)   | 409    | `{"error":"already_claimed"}` |
| expired / swept / bad token          | 403    | `invalid or expired claim` (text) |

**Client flow, `web/cloud/js/signup.js`:**

```
runSignupWizard(claimToken)
  └─ probe POST /api/webauthn/register/begin { claim_token }
       ├─ 409 already_claimed → renderAlreadyClaimed()  → [Unlock with your passkey] → runUnlockFlow()
       ├─ 200                 → renderWelcome()         → [Create your passkey]      → startRegistration()
       └─ 403 / other / throw → renderWelcome(errorText)
```

Challenge lifecycle on the happy path: probe `put()`s challenge A and sets the cookie to A; the click `put()`s
challenge B and overwrites the cookie to B; `RegisterFinish` reads the cookie and verifies against B. A expires
untouched.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only*

**Manual verification:**

- Mint a real invite, claim it on device 1, then re-open the same `#claim=` link (same device and a second
  browser profile). Both should land on "already claimed" with an unlock button, never on "Create your passkey".
- Open a deliberately expired invite link and confirm the old expired-link copy still appears.
- Confirm the unlock hand-off works on a browser that has no passkey for the account — the WebAuthn picker should
  simply find nothing, which is the correct new-device story the guidance text points at.

**External system updates:**

- None. No new route, no migration, no config, no deployment change.
