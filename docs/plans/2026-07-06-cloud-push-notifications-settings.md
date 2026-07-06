# Cloud-mode Notifications in main-app Settings (subscribe + test push)

## Overview

In cloud mode the main-app Settings hides the entire Notifications block, and
push subscription only exists on the separate `/unlock` shell — so a cloud user
has no way to subscribe to push or send a test notification from Settings. This
implements a cloud-mode Notifications section in the **main app** Settings
(`web/static`) that lets the user (1) subscribe/unsubscribe to web push and
(2) send a test push, reusing the existing cloud push routes and vault-NK
encryption. Closes bd **med-eas.7** (no test push in cloud settings) and
**med-eas.11** (no way to subscribe to push in cloud).

## Context (from discovery)

Files/components involved:
- `web/static/js/features/settings.js:94-95` — currently adds `wg-settings-hidden`
  to `.wg-settings-notifications` when `window.__MEDTRACKER_CLOUD__`, hiding the
  server Web-Push toggle + Test buttons (correct: those hit unregistered
  `/api/webpush/*` routes in cloud). This is the branch we extend.
- `web/static/index.html` — the `.wg-settings-notifications` markup lives here;
  we add a cloud-only sibling block.
- `web/cloud/js/push.js` — cloud push module. `pushSchedule(ctx, reminders)`
  (exported, DOM-free) and `subscribe()` (module-internal, DOM-free, needs an
  `export`). `renderPush`/`renderPushScreen` are shell-DOM-bound — NOT reused.
- `web/cloud/js/sync.js:474 getOrCreateNK(ctx)` — generates a random 32-byte NK,
  stores it as a DEK-encrypted vault record AND as a device-local plaintext copy
  in IndexedDB (`medtracker-cloud` → store `device` → key `nk`) that the shell
  `sw.js:50 readNK` reads. Called transitively by `pushSchedule`, so subscribing
  + scheduling provisions the NK automatically.
- `web/cloud/js/reminders.js` — `recomputeAndPush(ctx)` computes the real
  reminder set and PUTs it (replace-all). This is the owner of the real
  schedule; the test push must not clobber it.
- `web/cloud/js/cloud-boot.js:34-37` — obtains `ctx = { accountId, dek }` from
  `warmUnlock()` but keeps it trapped in the `boot()` closure. Nothing on
  `window.*` exposes it. This is the sole missing wire.
- `web/cloud/js/apishim.js` — sets `window.offlineAwareApiCall`,
  `window.CloudFoodAI`, `window.CloudFoodSearch`; cloud-boot sets the
  `window.apiCallDirect` accessor. No push/ctx facade exists yet.
- `internal/cloudserver/push.go` — the real cloud routes (no backend change
  needed): `GET /api/push/vapid-public-key` → `{ public_key }`;
  `POST /api/push/subscriptions` `{ endpoint, p256dh, auth }` → 204;
  `DELETE /api/push/subscriptions` `{ endpoint }` → 204;
  `PUT /api/push/schedule` `{ entries: [{ fire_at_unix, ct }] }` (replace-all,
  `ct` = base64, `fire_at_unix` = Unix seconds) → 204.

Related patterns:
- cloud-boot already does dynamic `import('/js/reminders.js')` etc. — Settings
  (a classic script) can likewise `await import('/js/push.js')` since `/js/*`
  resolves to the shell modules from the main-app origin.
- `subscribe()` registers `/sw.js` itself (`navigator.serviceWorker.register`),
  which in cloud mode serves the cloud `web/cloud/sw.js` (push handler + readNK).

Key constraint discovered: **`PUT /api/push/schedule` is replace-all**
(`ReplaceSchedule`). A test push must be sent together with the recomputed real
reminders, or it wipes the user's real schedule until the next recompute.

## Development Approach

- No unit tests. Add ONE integration test (Task 5) that guards the real
  boundary: cloud-mode Settings renders the notifications section (not hidden)
  and its Enable/Test controls drive the cloud push seam; server mode unchanged.
- No backend change — reuse the existing `internal/cloudserver/push.go` routes.
- Do not touch server-mode Notifications behavior. The cloud controls are a
  separate, cloud-only DOM block; the existing server block stays hidden in
  cloud mode as today.
- Follow CLAUDE.md: no hardcoded colors / inline `.style` (use `--wg-*` classes;
  `hidden` attribute is fine); integration-first tests via
  `tests/helpers/frontend-harness.js`; `DataStore.applyOptimistic` only for real
  state writes (subscription state is device/browser state, not a cached API
  resource — no optimistic-cache wrapping needed here).

## Testing Strategy

- Unit tests: none.
- Integration test: one Vitest suite (Task 5) through the frontend harness,
  asserting the cloud-mode branch renders + wires the controls and the test-push
  builds an additive (non-clobbering) schedule. Server-mode assertion that the
  cloud block stays hidden.
- E2E: none (no existing suite covers push).

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from scope

## Implementation Steps

### Task 1: Expose the cloud vault `ctx` and reusable push primitives to main-app code

- [x] In `web/cloud/js/push.js`, add `export` to `subscribe` (currently
      module-internal at ~line 70) and to `getSubscription`/`unsubscribe` if a
      DOM-free unsubscribe helper exists (add a small DOM-free `unsubscribe()`
      that reads the current `PushSubscription`, `POST`s nothing but
      `DELETE /api/push/subscriptions` with the endpoint, and calls
      `subscription.unsubscribe()`), leaving `renderPush`/`renderPushScreen`
      untouched.
- [x] In `web/cloud/js/cloud-boot.js`, after `warmUnlock()` returns a non-null
      `ctx` (the post-unlock block), publish a small facade once:
      `window.MedTrackerCloud = { ctx }`. Keep it inside the post-unlock block so
      it only exists for an unlocked vault. Do not let its assignment throw the
      boot (it is a plain field set).
- [x] Confirm ordering: `window.MedTrackerCloudReady` still resolves after the
      facade is published, so Settings code that `await`s it can rely on
      `window.MedTrackerCloud.ctx` being present.

### Task 2: Add a DOM-free "send a test push" helper that does not clobber the real schedule

- [x] Add an exported helper — prefer `web/cloud/js/reminders.js`
      `sendTestPush(ctx)` — that: computes the current real reminder entries the
      same way `recomputeAndPush` does (extract/reuse the compute step so it can
      return the entry array without PUTting), appends one test entry
      `{ fireAtUnix: nowUnix + N, text: 'Test notification from Med Tracker' }`
      (N a few seconds), and calls `pushSchedule(ctx, [...realEntries, testEntry])`
      in a single replace-all PUT.
- [x] If `recomputeAndPush` cannot be cleanly split, factor its compute step into
      a `computeReminderEntries(ctx)` that both it and `sendTestPush` call — no
      behavior change to the existing recompute path.
- [x] Document (code comment) that the test relies on the relay ticker, so it
      arrives within the tick interval, not instantly.

### Task 3: Add the cloud Notifications DOM block

- [x] In `web/static/index.html`, add a cloud-only Notifications block adjacent
      to `.wg-settings-notifications` (e.g. `.wg-settings-notifications-cloud`),
      `hidden` by default, using existing `--wg-*` settings classes (mirror the
      server block's card/heading/button markup). Controls: an Enable/Disable
      push button (`#cloud-push-toggle` or a labeled button reflecting state) and
      a "Send test push" button (`#cloud-push-test-btn`), plus a small status
      line element for feedback (e.g. "Push enabled on this device").
- [x] No inline styles or hardcoded colors — reuse the notification section's
      existing classes/tokens.

### Task 4: Wire the cloud Notifications controls in settings.js

- [x] In `web/static/js/features/settings.js`, in the existing
      `if (window.__MEDTRACKER_CLOUD__)` branch (~line 94): keep hiding the
      server `.wg-settings-notifications` block, and instead un-hide
      `.wg-settings-notifications-cloud` and bind its controls.
- [x] Enable button → `await import('/js/push.js')` then `subscribe()`; reflect
      result in the status line; on `Notification.permission === 'denied'` show a
      clear "blocked in browser settings" message. Disable button → the DOM-free
      `unsubscribe()`.
- [x] Test button → `await import('/js/reminders.js')` then
      `sendTestPush(window.MedTrackerCloud.ctx)`; show "Test push scheduled —
      it should arrive shortly." Guard on `window.MedTrackerCloud?.ctx` being
      present (vault unlocked) and on push being subscribed first.
- [x] Reflect current subscription state on section mount (check
      `navigator.serviceWorker` registration + `pushManager.getSubscription()`)
      so the button shows Enable vs Disable correctly.

### Task 5: Integration test

- [x] Add a Vitest suite via `tests/helpers/frontend-harness.js` (extend the
      settings feature suite, not a new coverage-driven file) asserting, in
      cloud mode (`window.__MEDTRACKER_CLOUD__ = true`, a stubbed
      `window.MedTrackerCloud.ctx`, mocked dynamic `/js/push.js` +
      `/js/reminders.js` modules): the `.wg-settings-notifications-cloud` block
      is visible (not `hidden`) and the server block is hidden; clicking Enable
      calls the mocked `subscribe`; clicking Test calls `sendTestPush`/
      `pushSchedule` with an entry array that includes the appended test entry
      (asserting the real entries are preserved — the non-clobber guarantee).
      Added `web/static/js/tests/settings.cloud-notifications.test.js`: DOM
      visibility + Enable/Disable/Test wiring against
      `window.loadCloudPushModule`/`window.loadCloudRemindersModule` stubs, plus
      a dedicated describe block exercising the real (non-mocked)
      `sendTestPush`/`computeReminderEntries` from `web/cloud/js/reminders.js`
      (only `web/cloud/js/push.js`'s `pushSchedule` and
      `web/domain/reminders.js`'s `createRemindersDomain` mocked) to prove the
      non-clobber guarantee against production logic.
- [x] Assert server mode (no cloud flag) leaves the cloud block hidden and the
      server block visible (unchanged behavior).

### Task 6: Verify acceptance criteria

- [x] `pnpm test` green (full frontend suite). 265 test files / 2820 tests
      passed, 29 skipped, 0 failed.
- [x] `go build ./...` and `go build -tags mobile ./...` green (no backend
      change expected, but the shared HTML/embed must still build/serve).
      Both build clean.
- [x] Manually reason through: subscribe provisions the NK (device + vault),
      the cloud `sw.js` can `readNK` and decrypt, and the test push fires via the
      relay without wiping real reminders. Confirmed by reading
      `web/cloud/js/push.js` (`pushSchedule` calls `getOrCreateNK(ctx)`, which
      writes the plaintext NK to IndexedDB `device→nk` that `sw.js:readNK`
      consumes) and `web/cloud/js/reminders.js` (`sendTestPush` builds
      `[...realEntries, testEntry]` and PUTs them together in one call, so the
      replace-all schedule endpoint never drops the real reminders).
- [x] Run the frontend linter / architecture tests — no inline-style or globals
      violations. `architecture.globals.test.js` passes; `window.MedTrackerCloud`
      is assigned in `web/cloud/js/cloud-boot.js`, which sits outside the
      scanned `web/static/js` tree (same precedent as the existing
      `window.__MEDTRACKER_CLOUD__` / `window.MedTrackerCloudReady` entries), so
      the regex guard does not trip. Formal allowlist documentation entry is
      Task 7.

### Task 7: [Final] Update documentation

- [x] `docs/cloud-mode.md` (push relay / reminder lifecycle section): note that
      the main-app Settings now surfaces cloud push subscribe + test, reusing the
      `/api/push/*` routes and vault-NK encryption; the `/unlock` shell push
      screen remains for the pre-app flow.
- [x] If a new `window.*` global was added, record it in the globals allowlist
      as required by CLAUDE.md rule 4. Added `window.MedTrackerCloud` to
      `web/static/js/tests/architecture.globals.test.js` (documentation entry,
      same precedent as `__MEDTRACKER_CLOUD__`/`MedTrackerCloudReady` — the
      assignment lives in `cloud-boot.js`, outside the scanned `web/static/js`
      tree).

## Technical Details

- Test-push wire entry: `{ fire_at_unix: Math.floor(Date.now()/1000) + N, ct }`
  where `ct = toBase64(encryptPushPayload(nk, JSON.stringify({ title, body })))`
  (AES-GCM, AAD `mt/v1/push`) — all via the existing `pushSchedule` path, so
  Settings never touches crypto directly.
- `subscribe()` body: `{ endpoint, p256dh, auth }` from `sub.toJSON()`; VAPID key
  from `GET /api/push/vapid-public-key`; SW registered as `/sw.js` (cloud SW).
- The only new cross-module surface is `window.MedTrackerCloud = { ctx }` and the
  added `export`s on `push.js` (`subscribe`, `unsubscribe`) + `reminders.js`
  (`sendTestPush`). No backend, no new endpoint, no relay change.

## Post-Completion

**Manual verification** (real device/deploy — cannot be automated here):
- On a deployed cloud account subdomain: unlock, open Settings → Notifications,
  Enable push (grant the browser prompt), then Send test push; confirm the
  notification arrives within the relay tick and that existing scheduled med
  reminders still fire afterward (non-clobber holds in production).
- Confirm on iOS/Safari (installed PWA) that the permission prompt fires within
  the user-activation gesture (subscribe requests permission before any await).
