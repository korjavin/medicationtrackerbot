# Claim wizard delivers the app instead of promising it

## Overview

bd `med-8eh`. The claim wizard's final screen is a dead-end that lies:

```js
// web/cloud/js/signup.js — renderDone()
<h1>You're set up</h1>
<p>Your vault is unlocked on this device. The full app arrives with
   the next update.</p>
```

The app is already here. A freshly-claimed user reads that, closes the tab, and never reaches it. There is no
button and no redirect.

After this change the wizard ends by **entering the app**: establish the LDK warm cache, then
`location.href = '/'`. The real app boots, `/api/bootstrap` reports `needs_first_run: true` (shipped in
`med-4pz.5`, PR #512), and the onboarding overlay mounts. That completes epic `med-l3q`'s acceptance
criterion — *"a friend … claims it, creates a passkey, saves the Emergency Kit, and lands in a working app."*

## Context (from discovery)

- `web/cloud/js/signup.js` — wizard sequence: `renderWelcome` → `startRegistration` → `renderLossProtection`
  → `renderEmergencyKit` → `renderTelegramStep` → `renderDone`.
  - `startRegistration` holds `{accountId, dek}` after `POST /api/webauthn/register/finish` succeeds, and
    hands them on as `ctx` via `renderLossProtection(app, { accountId, dek })`.
  - `renderEmergencyKit(app, ctx)` is **exported** and reused by `recover.js`. Its `#kit-continue` handler is
    `ctx.onKitSaved ? ctx.onKitSaved() : renderTelegramStep(app)`.
  - `renderTelegramStep(app)` takes **only `app`** today — `ctx` is not threaded into it. `mountTelegram`
    self-gates and calls `onDone` immediately when Telegram is disabled/resolved, so the wizard falls straight
    through. Both its success and `catch` paths call `renderDone(app)`.
  - `renderDone(app)` is the dead-end. Nothing else calls it.
  - **signup.js never calls `establishLdkCache`** and never writes a vault record. That is precisely why it
    dead-ends: without a warm cache, navigating to `/` would bounce to `/unlock`.
- `web/cloud/js/unlock.js:187` — `export async function establishLdkCache(dek, accountId)`.
- `web/cloud/js/claim.js:20,167-173` — the **precedent to copy**: `import { establishLdkCache } from './unlock.js'`,
  then immediately after a successful `register/finish`:
  ```js
  try { await establishLdkCache(dek, accountId); }
  catch { /* Warm-cache is an optimization; a storage-blocked browser must
             still reach the vault after a successful enrollment */ }
  ```
  Failure is swallowed on purpose.
- `web/cloud/js/recover.js:99` — `renderEmergencyKit(app, { accountId, dek, onKitSaved: () => { location.href = '/'; } })`.
  Recover already redirects into the app; its warm cache was established earlier by `enrollWithToken`
  (`claim.js:169`). **`onKitSaved` must keep overriding**, so recover's behavior is unchanged.
- `web/cloud/js/cloud-boot.js` — on `/`, `warmUnlock()` succeeds when the LDK cache exists; otherwise it
  redirects to `/unlock`. So a failed `establishLdkCache` degrades to "unlock with your passkey", not a dead end.
- `web/cloud/js/apishim.js` — `bootstrapPayload()` now reports `needs_first_run: !firstRunComplete` (PR #512),
  so landing in the app is what triggers the onboarding overlay.
- Tests: `web/cloud/js/tests/signup.claimed-link.test.js` is the owning suite for `signup.js`
  (`environment: 'node'` + an explicit JSDOM document; `crypto.js` imports cleanly, no WebCrypto stub needed).
  `web/cloud/js/tests/cloud-boot.test.js` is the precedent for asserting navigation against a fake `location`.

**Does not exist:** any test of `renderDone` / the wizard tail; any `ctx` parameter on `renderTelegramStep`.

## Design decisions

- **Establish the warm cache at the *end* of the wizard, not right after `register/finish`.** `claim.js` caches
  immediately after finish because enrollment *is* its last step. Here, caching early would let a user who
  abandons at the Emergency Kit screen reload into the app having never saved a recovery code. Today that user
  bounces to `/unlock` instead. Do not change abandonment behavior as a side effect of this bead — cache at the
  moment we actually enter the app.
- **Thread `ctx` through `renderTelegramStep`.** It needs `{accountId, dek}` to hand to the new `enterApp(ctx)`.
  This is the only signature change.
- **`renderDone` becomes `enterApp(ctx)`** — one function that caches then navigates. Renaming it (rather than
  gutting the body) keeps the name honest; nothing else references it.
- **Swallow `establishLdkCache` failure and navigate anyway**, exactly as `claim.js` does. A storage-blocked
  browser lands on `/`, `warmUnlock` fails, `cloud-boot` sends it to `/unlock`, and the user signs in with the
  passkey they just created. That is a correct outcome, not an error path.
- **`ctx.onKitSaved` keeps taking precedence** so `recover.js` is untouched.
- **No "You're set up" confirmation screen.** The bead's whole point is that the terminal screen is the
  problem. The app itself, with the onboarding overlay on top, is the confirmation.
- **No change to the onboarding overlay, `VALID_STEPS`, or any screen module.** Out of scope: `med-4pz.2/.3/.4`,
  `med-4pz.6`.

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

- **Unit tests**: none.
- **Integration tests**: the wizard tail is a real boundary — "the user ends up in the app with a warm cache"
  is the entire deliverable, and it is exactly the kind of thing manual checking forgets to re-verify. Extend
  the owning suite (`web/cloud/js/tests/signup.claimed-link.test.js`); do not add a file (repo rule 8).
- **E2E tests**: none.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope
- Keep plan in sync with actual work done

## Implementation Steps

### Task 1: `enterApp` replaces the dead-end screen

- [x] in `web/cloud/js/signup.js`, add `import { establishLdkCache } from './unlock.js';` (static, as
      `claim.js:20` does — `unlock.js` does not import `signup.js`, so there is no cycle)
- [x] replace `renderDone(app)` with `async function enterApp(ctx)` that does:
      `try { await establishLdkCache(ctx.dek, ctx.accountId); } catch { /* comment */ }` then
      `location.href = '/'`
- [x] copy `claim.js:169-172`'s rationale into the `catch`: the warm cache is an optimization; a storage-blocked
      browser must still reach the vault, and `cloud-boot` will route it to `/unlock` to sign in with the passkey
      it just created
- [x] delete the "The full app arrives with the next update." copy entirely — no replacement screen
- ➕ [x] `renderEmergencyKit`'s doc comment referenced the deleted "You're set up" screen — updated to describe
      the telegram-step-then-enter-app tail
- ⚠️ Task 2's first and third items (`renderTelegramStep(app, ctx)` signature + the `#kit-continue` pass-through)
      were done here out of necessity: `enterApp(ctx)` has no valid `ctx` without them, so deferring them would
      have committed a module that crashes on wizard completion. Their checkboxes are left for Task 2 to confirm.

### Task 2: Thread `ctx` to the wizard tail

- [x] change `renderTelegramStep(app)` to `renderTelegramStep(app, ctx)` (landed in Task 1; confirmed at
      `signup.js:310`)
- [x] both call sites inside it — `mountTelegram(app, { onDone: ... })` and the `catch` fallback — call
      `enterApp(ctx)` instead of `renderDone(app)` (landed in Task 1; confirmed at `signup.js:313,316`)
- [x] in `renderEmergencyKit`'s `#kit-continue` handler, pass ctx through:
      `ctx.onKitSaved ? ctx.onKitSaved() : renderTelegramStep(app, ctx)` (landed in Task 1; confirmed at
      `signup.js:303`)
- [x] verify `recover.js:99` still wins via `ctx.onKitSaved` and is otherwise untouched (it supplies its own
      `location.href = '/'` and its cache was established by `enrollWithToken`) — `git diff` on `recover.js` is
      empty, and `#kit-continue` evaluates `ctx.onKitSaved` before `renderTelegramStep` is ever reached
- [x] update `signup.js`'s top-of-file comment, which describes the wizard as ending at the Emergency Kit — it
      now ends by entering the app

### Task 3: Cover the wizard tail

- [x] extend `web/cloud/js/tests/signup.claimed-link.test.js` (owning suite, do not add a file), following the
      fake-`location` convention of `cloud-boot.test.js`
- [x] case: completing the wizard calls `establishLdkCache` with the ceremony's `dek` + `accountId`, then sets
      `location.href === '/'`
- [x] case: `establishLdkCache` rejecting still navigates to `/` (the storage-blocked browser path) — this is
      the regression guard for the swallowed `catch`
- [x] case: a `ctx.onKitSaved` override (recover's path) is called instead of `enterApp`, and `enterApp` never
      runs — pins that `recover.js` is unaffected
- [x] ⚠️ `enterApp` is module-private; drive it through the exported `renderEmergencyKit(app, ctx)` +
      `#kit-continue` click rather than exporting it just to test it
- ➕ [x] `unlock.js` (static import) and `telegram.js` (dynamic import) are `vi.mock`ed; the helper must tick
      `#kit-saved-checkbox` and dispatch `change` before clicking, since `#kit-continue` starts disabled

### Task 4: Verify acceptance criteria

- [x] verify the claim wizard no longer renders "The full app arrives with the next update." — `grep` over
      `web/` returns nothing; the only surviving hits are this plan and `docs/onboarding-wizard.md` (Task 5)
- [x] verify a completed claim lands on `/` with a warm cache, so `cloud-boot`'s `warmUnlock` succeeds —
      covered by "warms the LDK cache with the ceremony DEK, then enters the app"
- [x] verify a failed `establishLdkCache` still lands on `/` (and would bounce to `/unlock`, not dead-end) —
      covered by "still enters the app when the warm cache cannot be written (storage-blocked browser)"
- [x] verify `recover.js`'s `onKitSaved` override still short-circuits the telegram/enter-app tail — covered by
      "lets ctx.onKitSaved override the tail, so recover.js is unaffected"; `git diff master -- recover.js` empty
- [x] verify the Telegram step still falls straight through when Telegram is disabled, now into `enterApp` —
      `mountTelegram`'s `onDone` invokes `enterApp(ctx)` (`signup.js:313`); the mocked `onDone` drives the two
      enter-app cases above
- [x] `pnpm test` passes (284 files, 3041 tests, 29 skipped)
- [x] `go build ./...` and `go vet ./...` pass; `git diff master --stat -- '*.go'` is empty

### Task 5: [Final] Update documentation

- [x] `docs/onboarding-wizard.md`: mark the claim→app seam as implemented (status header, the "revive one"
      ordering list, the seam section, and the work-breakdown row)
- [x] `docs/cloud-mode.md`: update the Onboarding description — the claim wizard now ends by entering the app,
      where the first-run overlay mounts
- [x] note the degraded path (storage-blocked browser → `/unlock`) wherever the warm cache is described — both
      doc sites; `docs/cloud-crypto.md:149` already named the warm-cache-write-failure fallback

## Technical Details

**Wizard tail, before → after:**

```
before:  kit --#kit-continue--> renderTelegramStep(app) --onDone--> renderDone(app)
                                                                    [dead-end screen]

after:   kit --#kit-continue--> renderTelegramStep(app, ctx) --onDone--> enterApp(ctx)
                                                                          |
                                                    establishLdkCache(dek, accountId)
                                                            |            |
                                                          ok           throws
                                                            |            |
                                                     location.href = '/' (both)
                                                            |            |
                                              warmUnlock ok        warmUnlock fails
                                                    app             -> /unlock -> passkey -> app
```

`recover.js` is unchanged: `ctx.onKitSaved` still short-circuits at `#kit-continue`.

**Why this closes the epic:** landing on `/` with a warm cache boots the real app, whose `/api/bootstrap` now
reports `needs_first_run: true` (PR #512), mounting `WGFirstRun`. Claim → passkey → kit → app → onboarding.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only*

**Manual verification:**

- Mint an invite, claim it in a fresh browser profile, save the Emergency Kit, and confirm you land in the
  working app with the onboarding overlay on top — never on a "arrives with the next update" screen.
- Repeat in a browser with storage blocked for the site: you should land on `/unlock` and sign in with the
  passkey just created, not on a blank page.
- Confirm the recovery flow (`/recover`) still ends by redirecting into the vault.

**External system updates:**

- None. No migration, no new route, no config, no deployment change.
- Closes the last gap in epic `med-l3q`'s acceptance criterion.
