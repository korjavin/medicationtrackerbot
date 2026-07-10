# Fix endless `/` → `/unlock` → `/` redirect loop in cloud mode (med-eas.16, P0)

## Overview

In cloud mode, a user hitting `/` on an account subdomain can get stuck in an
endless redirect loop: `/` → `/unlock` → `/` → `/unlock` → …

## Context (from discovery)

The two redirect gates are **asymmetric**, and one fires on the wrong condition.

- **`/unlock` → `/`** (`web/cloud/js/unlock.js:29-34`, `runUnlockFlow`): fires
  on a *narrow, correct* condition — the local LDK record exists **and**
  `unwrapWithLdk` succeeds ("device is unlocked, hand off to the real app").

- **`/` → `/unlock`** (`web/cloud/js/cloud-boot.js`): the boot shim wraps the
  warm-unlock read together with `import('/js/apishim.js')` (which transitively
  loads ~15 modules) and `import('/js/sync.js')` **plus** all downstream boot
  work (`installApiShim`, `pullOnOpen`, tag invalidation, workout warm, etc.)
  in a **single `try`**. Its `catch` (`cloud-boot.js:102-105`) unconditionally
  does `location.href = '/unlock'`.

So if warm-unlock succeeds (LDK present, unwraps fine) but **any later step in
that big try throws** — a module that fails to load/parse, an `openDb()` hiccup,
a `pullOnOpen` error, a bad tag invalidation — the catch sends the browser to
`/unlock`. `/unlock` re-reads the *still-present, still-valid* LDK record,
unwraps it, and bounces straight back to `/`. `/` fails again for the same
unrelated reason, and the loop never ends.

The only condition that should ever send `/` → `/unlock` is **"there is no
usable LDK record"** (`warmUnlock()` returns `null`, or a present record fails
to unwrap). Every other boot failure should degrade the app in place, not
redirect. The cold-unlock path already anticipated this trap and guarded it
(`unlock.js:105-113`: if the LDK cache write fails, fall back to an in-memory
menu instead of redirecting and looping). The warm boot shim has no equivalent.

## Development Approach

Fix is entirely in `web/cloud/js/cloud-boot.js`'s error-handling structure.
**Do not** change `unlock.js`'s gate — its condition is correct. Preserve every
happy-path behavior (same `window.apiCallDirect` accessor semantics, same
awaited `MedTrackerCloudReady` resolution, same tag invalidation ordering).

## Testing Strategy

Add a Vitest regression test in `web/cloud/js/tests/` following the existing
`sync.test.js` structure (jsdom, mock IndexedDB / dynamic imports as needed).
No new test framework. `pnpm test` must stay green.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix

## Implementation Steps

### Task 1: Scope the `/unlock` redirect to the warm-unlock decision only

- [ ] In `web/cloud/js/cloud-boot.js`, keep the existing `#claim=` early
      hand-off (`:20-24`) unchanged.
- [ ] Move `import('/js/unlock.js')` + `warmUnlock()` into their **own**
      try/catch, ahead of the rest of the boot chain:
  - `warmUnlock()` returns `null` → `location.href = '/unlock'` and return
    (correct: no cached key, the device really must unlock).
  - importing `unlock.js` or `warmUnlock()` itself **throws** → log, then
    `location.href = '/unlock'` (acceptable: genuinely can't read the vault key;
    it will **not** loop because `/unlock` shares the same `unlock.js` +
    `localdb.js`, so if those are truly broken it renders the locked/error
    screen instead of bouncing back). Keep this branch narrow.

### Task 2: Make the post-unlock boot chain non-redirecting

- [ ] Everything **after** obtaining a non-null `ctx` — importing `apishim.js` /
      `sync.js`, `installApiShim`, the `apiCallDirect` accessor wiring,
      `pullOnOpen`, `DataStore.invalidateTags`, workout warm, and the
      fire-and-forget `reminders.js` / `mcp-responder.js` imports — must run in
      a **separate** try/catch whose `catch` **logs and continues** (the vault
      is unlocked; boot degraded) and **never** calls `location.href =
      '/unlock'`.
- [ ] Confirm the happy path is behaviorally identical: shim installed,
      `apiCallDirect` accessor wired the same way, `pullOnOpen` + tag
      invalidation still awaited so `MedTrackerCloudReady` resolves only after
      they finish.

### Task 3: Regression test

- [ ] Add a test in `web/cloud/js/tests/` (mirror `sync.test.js`) asserting:
  - Valid LDK record present but a downstream boot step (e.g. `pullOnOpen` or
    the `apishim` import) throws → the shim does **not** set
    `location.href = '/unlock'` (no loop) and `MedTrackerCloudReady` resolves.
  - `warmUnlock()` returns `null` → the shim **does** redirect to `/unlock`.

### Task 4: [Final] Verify

- [ ] `pnpm test` green (cloud + static suites).
- [ ] Manually reason through the loop scenario against the new structure to
      confirm it cannot recur.

## Out of scope

- Any change to `unlock.js`'s redirect gate (it is correct).
- Server-side routing in `internal/cloudserver/router.go` (no server redirect
  is involved).
- The latent `#claim=` coupling note from analysis (not looping today).
