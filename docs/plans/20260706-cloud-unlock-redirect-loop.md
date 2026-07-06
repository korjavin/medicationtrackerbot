# Fix endless `/` → `/unlock` → `/` redirect loop in cloud mode (med-eas.16, P0)

## Problem

In cloud mode, a user hitting `/` on an account subdomain can get stuck in an
endless redirect loop: `/` → `/unlock` → `/` → `/unlock` → …

## Root cause

The two redirect gates are **asymmetric**, and one of them fires on the wrong
condition.

- **`/unlock` → `/`** (`web/cloud/js/unlock.js:29-34`, `runUnlockFlow`): fires
  on a *narrow, correct* condition — the local LDK record exists **and**
  `unwrapWithLdk` succeeds. This means "the device is unlocked, hand off to the
  real app."

- **`/` → `/unlock`** (`web/cloud/js/cloud-boot.js`): the boot shim wraps the
  warm-unlock read together with `import('/js/apishim.js')` (which transitively
  loads ~15 modules) and `import('/js/sync.js')` **plus** all downstream boot
  work (`installApiShim`, `pullOnOpen`, tag invalidation, workout warm, etc.)
  in a **single `try`**. Its `catch` (`cloud-boot.js:102-105`) unconditionally
  does `location.href = '/unlock'`.

So if warm-unlock itself succeeds (LDK present, unwraps fine) but **any later
step in that big try throws** — a module that fails to load/parse, an
`openDb()` hiccup, a `pullOnOpen` error, a bad tag invalidation — the catch
sends the browser to `/unlock`. `/unlock` re-reads the *still-present, still-
valid* LDK record, unwraps it, and bounces straight back to `/`. `/` fails
again for the same unrelated reason, and the loop never ends.

The only condition that should ever send `/` → `/unlock` is **"there is no
usable LDK record"** (`warmUnlock()` returns `null`, or the record is present
but unwrap throws). Every other boot failure should degrade the app in place,
not redirect.

The cold-unlock path already anticipated exactly this trap and guarded it
(`unlock.js:105-113`: if the LDK cache write fails, fall back to an in-memory
menu instead of redirecting to `/` and looping). The warm boot shim has no
equivalent guard.

## Fix

Edit `web/cloud/js/cloud-boot.js` so the **only** thing that can redirect to
`/unlock` is the warm-unlock decision, and it is scoped to just that decision.

1. Move `import('/js/unlock.js')` + `warmUnlock()` into their **own** try/catch,
   ahead of the rest of the boot chain:
   - If `warmUnlock()` returns `null` → `location.href = '/unlock'` (correct:
     no cached key, the device really must unlock). Return.
   - If importing `unlock.js` or `warmUnlock()` itself **throws** → this is the
     genuine "can't even read the vault key" case; log and `location.href =
     '/unlock'` is acceptable here (it will *not* loop: `/unlock` shares the
     same `unlock.js` + `localdb.js`, so if those are truly broken it renders
     the locked/error screen instead of bouncing back). Keep this narrow.

2. Everything **after** obtaining a non-null `ctx` — importing `apishim.js` /
   `sync.js`, `installApiShim`, the `apiCallDirect` accessor wiring,
   `pullOnOpen`, `DataStore.invalidateTags`, workout warm, the fire-and-forget
   `reminders.js` / `mcp-responder.js` imports — must run in a **separate**
   try/catch whose `catch` **logs and continues** (the app is unlocked; boot it
   degraded) and **never** calls `location.href = '/unlock'`. The vault is
   already unlocked at this point; a failed sync or shim-install must not evict
   the user to the unlock screen.

3. Keep the existing `#claim=` early hand-off (`cloud-boot.js:20-24`) unchanged.

Do **not** change `unlock.js`'s gate — its condition is correct. The fix is
entirely in the boot shim's error-handling structure. Preserve all existing
behavior on the happy path (same `window.apiCallDirect` accessor semantics,
same awaited `MedTrackerCloudReady` resolution, same tag invalidation).

## Tasks

- [ ] Restructure `web/cloud/js/cloud-boot.js`: split the single `try` into (a)
      a warm-unlock decision block that may redirect to `/unlock` only when
      there is no usable LDK record, and (b) a post-unlock boot block that logs
      and continues on any error and never redirects to `/unlock`.
- [ ] Verify the happy path is byte-for-byte equivalent in behavior: warm
      unlock succeeds → shim installed, `apiCallDirect` accessor wired the same
      way, `pullOnOpen` + tag invalidation awaited, `MedTrackerCloudReady`
      resolves only after those finish.
- [ ] Add a regression test in `web/cloud/js/tests/` (follow the existing
      `sync.test.js` structure — jsdom + Vitest, mock IndexedDB / dynamic
      imports as needed). Assert:
      - When a valid LDK record is present but a downstream boot step (e.g.
        `pullOnOpen` or the apishim import) throws, the shim does **not**
        set `location.href = '/unlock'` (no loop) and `MedTrackerCloudReady`
        still resolves.
      - When `warmUnlock()` returns `null`, the shim **does** redirect to
        `/unlock`.
- [ ] `pnpm test` passes (run the cloud + static suites).

## Out of scope

- Any change to `unlock.js`'s redirect gate (it is correct).
- The latent `#claim=` coupling note from analysis (not looping today).
- Server-side routing in `internal/cloudserver/router.go` (no server redirect
  is involved).
