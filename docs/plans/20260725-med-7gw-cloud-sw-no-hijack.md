# med-7gw — Cloud SW must not hijack open tabs on deploy (wait→prompt→SKIP_WAITING)

## Overview
PROD bug: the cloud service worker (`web/cloud/sw.js`) calls unconditional
`self.skipWaiting()` in its `install` handler and `self.clients.claim()` in
`activate`, with NO `SKIP_WAITING` message handler. On every deploy the new SW
activates immediately and claims already-open tabs while those tabs still run
the OLD in-memory JS → old-JS/new-SW/new-fingerprint mismatch → every page shows
"No cached data" until a manual reload.

Fix = adopt the non-hijacking pattern bot mode already uses correctly
(`web/static/js/app-shell.js` `showUpdateToast` + `controllerchange`):
- On an UPDATE, the new SW WAITS instead of hijacking. An open tab keeps working
  on the old SW until the user clicks the existing "new version available"
  banner, which posts `SKIP_WAITING` to the waiting worker and reloads on
  `controllerchange` (2s fallback).
- On a FIRST-EVER install (no prior SW), `clients.claim()` still controls the
  first page with NO reload (skipWaiting is unnecessary — nothing to wait
  behind).
- The SW-waiting path is the PRIMARY, correct update trigger; the existing
  build-ID poll in `update-check.js` stays as the FALLBACK for the
  resumed-stale-PWA case. ONE banner, ONE reload handler.

Operational note for the PR: shipping THIS fix still causes ONE more hijack
transition, because the CURRENT prod SW is the old skipWaiting+claim one and it
will seize tabs when this deploy lands. Only AFTER the new (fixed) SW is active
are future deploys clean.

## Context (from discovery)
- **`web/cloud/sw.js`** — `install` at line 162-165 (`self.skipWaiting()` at 164
  to remove); `activate` at 167-178 (prune old caches + `self.clients.claim()`,
  KEEP as-is); no `message` listener exists today (safe to add). Do NOT touch the
  cache-first fetch handler (med-gvk.5), precache resilience (med-gvk.1), or
  ceremony precache (med-gvk.3).
- **`web/cloud/js/update-check.js`** — owns `renderUpdateBanner(doc,onReload,
  onDismiss)` (toast id `cloud-update-toast`, reload button id
  `cloud-update-reload`) and `startUpdateCheck({doc,win,fetchImpl,showBanner})`
  (build-ID poll; default `showBanner` currently does
  `renderUpdateBanner(doc, () => win.location.reload())`). Auto-starts at bottom
  when `bootBuildID(document)` present.
- **`web/cloud/js/cloud-boot.js`** — classic (non-module) script; registers the
  SW fire-and-forget at line 27-31 (`navigator.serviceWorker.register('/sw.js')`).
  Uses dynamic `import('/js/...')` elsewhere (the test harness rewrites `import(`
  → `__imp(`). No update detection / no `controllerchange` listener today.
- **Reference (do NOT edit)**: `web/static/js/app-shell.js` `showUpdateToast`
  (lines 81-107) posts `{type:'SKIP_WAITING'}` to `registration.waiting`, 2s
  fallback reload; `onupdatefound` → `installing.onstatechange==='installed' &&
  navigator.serviceWorker.controller` → toast (46-56); `controllerchange` →
  reload (66-70).
- **Tests**:
  - `web/cloud/js/tests/sw.fetch-cache.test.js` via
    `web/cloud/js/tests/helpers/sw-loader.js` (`loadCloudSw` captures
    `self`/`listeners`; `self.skipWaiting`, `self.clients.claim`,
    `self.registration` are vi.fn/objects). `fireInstall` helper at line 300;
    `activate` fired directly via `listeners.get('activate')[0]`. THREE install
    tests currently assert `self.skipWaiting` was called: lines 334, 370, 528 —
    these MUST flip to `.not.toHaveBeenCalled()`. Activate prune+claim test at
    531-544 stays.
  - `web/cloud/js/tests/update-check.test.js` — `renderUpdateBanner` +
    `startUpdateCheck` unit tests. The `startUpdateCheck` tests inject a mock
    `showBanner`, so changing the DEFAULT `showBanner` does not break them.
  - `web/cloud/js/tests/cloud-boot.test.js` — runs the real cloud-boot body with
    a fake `window`/`location` and NO `navigator.serviceWorker` (Node global
    `navigator` lacks `serviceWorker`), so the SW-registration block is skipped
    in that harness — existing tests keep passing.

## Development Approach
- **Testing approach**: Regular (code first, then tests) — surgical SW-lifecycle
  fix; each task ships its own test updates and all tests pass before the next.
- **CRITICAL**: run the frontend suite after each task; do not proceed on red.
- No hardcoded colors / inline `.style.` (CLAUDE.md rule 3) — reuse existing
  `renderUpdateBanner` (it already ships no CSS).
- No new `window.*` globals (CLAUDE.md rule 4) — cross-path single-banner dedupe
  uses the DOM id `cloud-update-toast`, not a global flag.
- Node 20 required for vitest (Node 18 silently skips it).

## Testing Strategy
- **Unit tests**: extend `sw.fetch-cache.test.js` (install no longer skips;
  SKIP_WAITING message → skipWaiting; activate still prunes+claims) and
  `update-check.test.js` (`showUpdateBanner`: waiting-SW → postMessage
  SKIP_WAITING + no double toast; no-registration → plain reload).
- No E2E harness for the SW lifecycle; unit tests via the sw-loader + jsdom are
  the coverage surface.

## Progress Tracking
- Mark completed items `[x]` immediately.
- `➕` newly discovered tasks; `⚠️` blockers.

## What Goes Where
- Implementation Steps are code + tests only.
- Manual prod deploy verification goes in Post-Completion (no checkboxes).

## Implementation Steps

### Task 1: sw.js — stop hijacking on install, add SKIP_WAITING handler
- [x] In `web/cloud/sw.js` `install` handler (line 162-165), REMOVE the
      `self.skipWaiting();` call. Keep `event.waitUntil(warmShell());`. Add a
      short comment: on an UPDATE the new SW now WAITS (no hijack); the client
      posts SKIP_WAITING when the user accepts the banner; a FIRST install still
      controls via `clients.claim()` in activate (nothing to wait behind).
- [x] Add a top-level `message` listener (place it right after the `install`
      handler): `self.addEventListener('message', (event) => { if (event.data
      && event.data.type === 'SKIP_WAITING') self.skipWaiting(); });`
- [x] Leave the `activate` handler (prune old prefixed caches +
      `self.clients.claim()`) UNCHANGED. Do NOT touch the fetch/push/
      notificationclick handlers.
- [x] In `sw.fetch-cache.test.js`, flip the three install assertions at lines
      ~334, ~370, ~528 from `expect(self.skipWaiting).toHaveBeenCalled()` to
      `expect(self.skipWaiting).not.toHaveBeenCalled()` (install must NOT skip
      anymore); keep the rest of each test (cache contents) intact.
- [x] Add a new test in the same `describe`: fire the `message` listener with
      `{ data: { type: 'SKIP_WAITING' } }` and assert `self.skipWaiting` WAS
      called; fire it with an unrelated message (e.g. `{ data: { type: 'x' } }`)
      and assert it was NOT called. Use `listeners.get('message')[0]` (mirror how
      `activate` is fired at line 536).
- [x] Confirm the existing activate test (line 531-544) still asserts
      `caches.delete` on the old prefixed cache + `self.clients.claim` called —
      no change needed, just verify it passes.
- [x] Run `npx vitest run web/cloud/js/tests/sw.fetch-cache.test.js` (Node 20) —
      must pass before Task 2.

### Task 2: update-check.js — unified showUpdateBanner with the SKIP_WAITING dance
- [x] In `web/cloud/js/update-check.js`, add and export
      `showUpdateBanner({ doc, win, registration } = {})` (default `doc` /`win`
      to `document`/`window`): if `doc.getElementById('cloud-update-toast')`
      already exists, return without adding a second banner (single-banner
      dedupe across the SW-waiting and build-ID paths). Otherwise call
      `renderUpdateBanner(doc, onReload)` where `onReload` = `activateAndReload`.
- [x] Add an internal `activateAndReload(registration, win)`: if
      `registration && registration.waiting`, `registration.waiting.postMessage(
      { type: 'SKIP_WAITING' })` then `win.setTimeout(() => win.location.reload(),
      2000)` (the real reload comes from `controllerchange`; 2s is the fallback,
      mirroring app-shell.js). Else `win.location.reload()` (build-ID fallback
      path where no SW is waiting).
- [x] Change the DEFAULT `showBanner` inside `startUpdateCheck` from
      `() => renderUpdateBanner(doc, () => win.location.reload())` to
      `() => showUpdateBanner({ doc, win })` (build-ID poll → no registration →
      plain reload, and now deduped against the SW path via the toast id). Keep
      `showBanner` an injectable param so existing tests still pass.
- [x] Add tests in `update-check.test.js`: (a) `showUpdateBanner` with a fake
      `registration.waiting` (a `{ postMessage: vi.fn() }`) — clicking the
      `cloud-update-reload` button posts `{type:'SKIP_WAITING'}` and does NOT
      call `win.location.reload()` synchronously (the 2s fallback is scheduled,
      not immediate — assert with fake timers or assert postMessage only);
      (b) `showUpdateBanner` with NO registration → clicking reload calls
      `win.location.reload()`; (c) calling `showUpdateBanner` twice adds only ONE
      `#cloud-update-toast` (dedupe).
- [x] Run `npx vitest run web/cloud/js/tests/update-check.test.js` (Node 20) —
      must pass before Task 3.

### Task 3: cloud-boot.js — detect waiting SW, show banner, guarded controllerchange reload
- [ ] In `web/cloud/js/cloud-boot.js` SW-registration block (line 27-31), capture
      `hadController = !!navigator.serviceWorker.controller` BEFORE registering
      (records whether an existing SW controls this page — the FIRST-install case
      has no controller).
- [ ] Change the registration to await/`.then` the registration object and wire
      update detection (keep it fire-and-forget / non-blocking so a slow/failed
      registration never gates the mount, per med-gvk.1): if `registration.waiting
      && navigator.serviceWorker.controller` → a SW is already waiting for this
      already-controlled page → show the banner now. Also set
      `registration.onupdatefound` → `const nw = registration.installing; if(!nw)
      return; nw.onstatechange = () => { if (nw.state === 'installed' &&
      navigator.serviceWorker.controller) showBanner(); }`. `showBanner()` =
      `import('/js/update-check.js').then((m) => m.showUpdateBanner({
      registration }))` (dynamic import matches the existing cloud-boot pattern;
      keep the `.catch` logging).
- [ ] Add a single `navigator.serviceWorker.addEventListener('controllerchange',
      …)` listener that reloads ONLY when `hadController` is true (an update
      replaced an existing controller). On a FIRST install `hadController` is
      false → the `clients.claim()` controllerchange must NOT reload (bead
      requirement: first-ever install controls the page with NO reload). Guard
      against a double reload with a module-local `let reloading = false;`.
      Call `window.sendSwAuthToken?.()` before reload if that helper exists in
      cloud context (mirror app-shell), otherwise just reload.
- [ ] Keep the whole block inside the existing `if (typeof navigator !==
      'undefined' && 'serviceWorker' in navigator)` guard so `cloud-boot.test.js`
      (no `navigator.serviceWorker`) still skips it and existing tests pass.
- [ ] Run `npx vitest run web/cloud/js/tests/cloud-boot.test.js` (Node 20) —
      existing tests must still pass (the SW block is skipped in that harness).

### Task 4: Verify acceptance criteria
- [ ] Re-read the bead correctness list: (1) first-ever install controls the page
      with NO reload and no stuck-waiting; (2) an UPDATE waits (no auto-activate/
      claim) until the banner's Reload triggers SKIP_WAITING→controllerchange→
      reload; (3) no double banner (build-ID poll vs SW-waiting unified via the
      toast id).
- [ ] Confirm NO change to bot mode (`web/static/sw.js`, `web/static/js/
      app-shell.js`) and no change to the cache-first fetch handler / precache
      logic in `web/cloud/sw.js`.
- [ ] Run `npx vitest run web/cloud/js/tests/ web/static/js/tests/architecture`
      (Node 20) — cloud SW/boot/update tests + architecture (design-token /
      globals) guards green.
- [ ] Run `npx vitest run` (full frontend suite, Node 20) — green.
- [ ] Run `go build ./...` — must be a no-op (no Go changed) and succeed.

### Task 5: [Final] Documentation touch
- [ ] If `docs/cloud-mode.md` documents the cloud SW update behavior, add a short
      note that cloud now uses the wait→prompt→SKIP_WAITING→controllerchange
      pattern (matching bot mode). If no such section exists, skip — do not invent
      a new doc section.

## Technical Details
- `SKIP_WAITING` message contract: client posts `{ type: 'SKIP_WAITING' }` to
  `registration.waiting`; SW `message` handler calls `self.skipWaiting()`. Same
  string used by bot mode — identical contract.
- First-install vs update decision is entirely `navigator.serviceWorker.
  controller` presence: absent = first install (claim controls, no banner, no
  reload); present = update (new SW waits, banner shown, user-triggered
  activation + guarded reload).
- Single-banner invariant is the DOM id `cloud-update-toast` (set by
  `renderUpdateBanner`), checked at the top of `showUpdateBanner` — no
  cross-module shared state, no new global.

## Post-Completion
*Manual / external — no checkboxes*

**Manual verification (prod deploy):**
- Expect ONE last bumpy deploy: the CURRENT prod SW is the old skipWaiting+claim
  one and will still seize open tabs when this deploy lands. Future deploys (with
  the fixed SW active) are clean — verify the next deploy after this one shows the
  update banner on an open tab instead of the "No cached data" breakage.
- Sanity-check on a real browser: (a) fresh profile / no prior SW → app loads and
  is controlled with no reload; (b) with the app open, deploy a new build → the
  banner appears, the old tab keeps working, clicking Reload activates the new SW
  and reloads once into the new version.
