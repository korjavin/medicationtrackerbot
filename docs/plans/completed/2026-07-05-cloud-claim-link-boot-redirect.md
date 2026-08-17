# Fix cloud admin invite claim link (boot shim drops the `#claim` fragment)

## Overview

Admin invite links (`https://<account>.cloud.example.com/#claim=<token>`) land on an
unclaimed account subdomain but show the returning-device **"Unlock with passkey"** screen
and fail with *"Could not start unlock — no passkey is registered yet."* — instead of the
signup/claim wizard that registers the account's **first** passkey.

**Root cause (confirmed by tracing the live flow):**

1. The invite URL resolves to path `/`. The router (`internal/cloudserver/router.go:151-154`)
   serves the real `web/static` app at `/` with `web/cloud/js/cloud-boot.js` injected — **not**
   the passkey shell (`signup.html`, served only at `/unlock`, `/claim`, `/recover`).
2. `cloud-boot.js` never reads `location.hash`. It reads the local LDK cache; a fresh/unclaimed
   device has none, so it runs `location.href = '/unlock'` (`cloud-boot.js:24`), a navigation that
   **discards the `#claim=<token>` fragment**.
3. `/unlock` serves `signup.html` → `app.js`. With the fragment gone, `claimToken` is `null`
   (`app.js:6`), so it falls through to `runUnlockFlow()` → `renderLocked` → the unlock button →
   `POST /api/webauthn/login/begin` returns non-OK (no credential) → the error at `unlock.js:68`.

The `#claim=` → `runSignupWizard` dispatch (`app.js:30-32`) is correct but unreachable, because the
invite link enters through `/` (cloud-boot.js), where `app.js` never runs. The backend claim/register
ceremony (`webauthn.go` `RegisterBegin` gate `gateClaim`, claim-token validation) is fully functional —
it's simply never called.

**Fix:** in `cloud-boot.js`, detect a claim token in the URL fragment **before** the warm-unlock
cache read and hand off to the shell **preserving the fragment** (`/unlock` + `location.hash`). This
also covers the edge case where a device carries a stale LDK cache for a *different* account — a bare
hash-preserve on the no-cache redirect alone would let that cache hijack the claim link. One guard in
the one place the fragment is first seen and dropped fixes every entry through `/`.

## Context (from discovery)

- Files involved:
  - `web/cloud/js/cloud-boot.js` — **the only file to change.** Boot shim injected into the
    web/static index served at `/`; redirects to `/unlock` without preserving the fragment.
  - `web/cloud/js/app.js:6,30-32` (reference only) — already routes `#claim=<token>` →
    `runSignupWizard`; needs the fragment to survive the redirect. No change.
  - `internal/cloudserver/router.go:147-154` (reference only) — confirms `/` → web/static +
    cloud-boot, `/unlock` → signup.html shell. No change.
  - `internal/cloudserver/provision.go:56`, `cmd/cloud/admin.go:158` (reference only) — build the
    `/#claim=<token>` link. Correct as-is; no change.
- Related pattern: `app.js:6` parses the token via
  `new URLSearchParams(location.hash.slice(1)).get('claim')` — reuse the identical parse in the guard
  so both sides agree on what "has a claim token" means.
- Device-transfer (`/claim#<slot>.<tk>`) and recovery (`/recover`) links point at explicit shell
  paths, so they're served by `signup.html` directly and never hit `cloud-boot.js` — out of scope.

## Development Approach

- **Testing approach**: NO unit tests. No integration test either — the change is a 3-line redirect
  guard whose only observable effect is a `location.href` navigation preserving a URL fragment.
  jsdom does not implement navigation, so a test would assert a mock rather than real behavior and
  guard nothing manual verification can't. Verified by loading a real claim link (Post-Completion).
- Single focused change in one file. Maintain the existing warm-unlock path untouched for the
  no-claim-token case.

## Testing Strategy

- **Unit tests**: none.
- **Integration tests**: none — no real boundary a test could guard here (see Development Approach).
- **E2E tests**: none — the repo has no cloud-mode browser E2E suite; do not stand one up for this.

## Progress Tracking

- Mark completed items `[x]` immediately.
- ➕ for newly discovered tasks, ⚠️ for blockers.

## Implementation Steps

### Task 1: Route claim links to the shell wizard before warm-unlock in `cloud-boot.js`

- [x] In `web/cloud/js/cloud-boot.js`, at the very top of the `boot()` async IIFE (before the
      dynamic `import(...)` / `readLdkRecord()` calls at lines 16-22), read the claim token with the
      same parse `app.js` uses:
      `const claimToken = new URLSearchParams(location.hash.slice(1)).get('claim');`
- [x] If `claimToken` is present, redirect to the shell preserving the fragment and return early:
      `if (claimToken) { location.href = '/unlock' + location.hash; return; }`
      — this runs before any cache read, so a stale LDK cache for another account cannot short-circuit
      the claim.
- [x] Leave the existing no-cache redirect (`cloud-boot.js:24`) and error-fallback redirect
      (`cloud-boot.js:37`) as-is — with the claim token handled up front, those only fire for genuine
      returning-device unlock, where dropping the (absent) fragment is correct.
- [x] Confirm no build/lint step flags the change: run `pnpm test` (existing suite must stay green;
      this file has no test of its own) and any frontend lint the repo runs.

### Task 2: Verify acceptance criteria

- [x] Re-read `cloud-boot.js` end-to-end: claim-token branch is first; warm-unlock path unchanged for
      the tokenless case.
- [x] Grep for other bare `location.href = '/unlock'` or root redirects that could also drop a claim
      fragment (`grep -rn "location.href" web/cloud/js`) — confirm cloud-boot is the only entry via `/`.
- [x] Run the existing frontend test suite (`pnpm test`) — must pass.

## Technical Details

Concrete diff shape for `web/cloud/js/cloud-boot.js`:

```js
window.MedTrackerCloudReady = (async function boot() {
    // Invite/claim links (https://<acct>.cloud…/#claim=<token>) resolve to '/',
    // which serves web/static + this shim — not the passkey shell. Hand off to
    // the shell (signup wizard via app.js) with the fragment intact BEFORE the
    // warm-unlock cache read, so a fresh device (no cache) — or a device holding
    // a stale LDK for a different account — still reaches the claim wizard.
    const claimToken = new URLSearchParams(location.hash.slice(1)).get('claim');
    if (claimToken) {
        location.href = '/unlock' + location.hash;
        return;
    }
    try {
        // …existing warm-unlock unchanged…
```

Why `/unlock` (not `/claim`): the `/claim` shell path is the device-transfer hand-off
(`runClaimFlow`, expects `#<slot>.<tk>`). The signup/claim-token wizard dispatch lives in
`app.js`'s `else if (claimToken)` branch, which fires on **any** pathname once `#claim=` survives —
so `/unlock#claim=<token>` correctly lands on `runSignupWizard`.

## Post-Completion

*Manual verification (external — cannot be automated in this repo):*

- Provision a fresh invite (`cmd/cloud admin invite …` or the admin UI), open the resulting
  `https://<account>.cloud…/#claim=<token>` link on a device with **no** prior cache for that account.
  Expect the signup/registration wizard ("Welcome / register your passkey"), not "Unlock with passkey".
  Complete registration and confirm the first passkey + envelope persist and the vault opens.
- Regression check: on a device that has already claimed and warm-unlocks normally, open `/` with
  **no** fragment — confirm the warm-unlock path still redirects to `/unlock` (locked) or loads the
  app (cached) as before.
- Edge check (optional): on a device holding a warm cache for account A, open account B's `#claim=`
  link — confirm it now reaches B's wizard instead of silently loading A.
