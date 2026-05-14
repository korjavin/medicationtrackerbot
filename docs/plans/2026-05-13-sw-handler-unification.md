# Service Worker handler unification

## Overview

The Service Worker (`web/static/sw.js`) defines **11 `async function handleX(…)`**
helpers (lines 559–767) that POST to backend endpoints in response to
notification button taps. They were copy-pasted into existence and have
diverged from the main thread in three concrete ways:

1. **No auth header.** None of them set `X-Telegram-Init-Data`. The main
   thread always does (`web/static/js/core/api.js:8`). In any deployment
   where the Telegram init-data header is the primary identity (Telegram
   Mini App without server-set cookie, local dev with cookie disabled, OIDC
   tail before the cookie is minted), every notification action button
   silently 401s. The user sees no error — the action is just lost.
2. **No retry.** A failing POST is logged via `console.error` and
   discarded. The notification has already been dismissed by the OS, so
   "skip from notification" can be a black hole.
3. **No cache invalidation.** The SW posts `client.postMessage({ type:
   'MEDICATION_CONFIRMED' })` (line 638) and trusts the main thread to
   refresh — but this is opaque from the SW call site, fires only when a
   client window is open, and bypasses `DataStore.invalidateTags`.

This plan extracts a single `swApiCall(endpoint, method, body)` helper,
makes it auth-aware (mirroring `apiCallDirect`), and queues failed POSTs
into a new IndexedDB store the main thread drains on `online`.

**Out of scope** (deferred):
- Replacing the three `client.postMessage(...)` notifications with
  DataStore tag invalidations dispatched from the SW. Today the main
  thread translates these into refreshes; centralizing tag invalidation
  into a single SW→client message is a follow-up.
- Rewriting the medication snooze flow's local 10-min `setTimeout` at
  `sw.js:441-451` (the *only* handler with offline behaviour). Untouched.

From the [2026-05-13 frontend review §4](../2026-05-13-frontend-code-review.md#4-service-worker-duplicates-main-thread-business-logic)
and recommended-priority item #1.

## Context (from discovery)

- **All 11 handlers** in `web/static/sw.js` (lines 559–767):
  `handleTZPlanAction`, `handleCancelIntake`, `handleMedicationConfirm`,
  `handleBPSnooze`, `handleBPDontBug`, `handleWeightSnooze`,
  `handleWeightDontBug`, `handleWorkoutSnooze`, `handleWorkoutSkip`,
  `handleMedicationSkip`, `handleMedicationServerSnooze`.
- **Auth-header source of truth**: `core/api.js:7-9` —
  `headers = { "X-Telegram-Init-Data": window.userInitData };` Reading
  `window.userInitData` from a SW context requires either: (a) clients
  postMessage it on registration, OR (b) the SW reads from IndexedDB
  (`db.js` exposes `MedTrackerDB`).
- **The SW cannot import db.js** — it's loaded with `importScripts(...)`
  semantics; `db.js` uses `Dexie` and writes to `window`. The SW would
  need its own minimal IDB wrapper for the queued-write store.
- **Existing client→SW message channel**: `sw.js:381-385` already handles
  `{ type: 'SKIP_WAITING' }`. Adding `{ type: 'AUTH_TOKEN', token: <...>}`
  is one new branch.
- **Clients-side hand-off**: `app-shell.js:36-78` (`initServiceWorker`)
  is the right place to send the token after registration (we already
  call `navigator.serviceWorker.controller.postMessage(...)` from sync.js,
  pattern is established).
- **Architecture test** `web/static/js/tests/architecture.sw-precache.test.js`
  validates the precache list — the new helper file (if extracted) must
  be added there.
- **Existing offline-write queue** for the main thread:
  `db.js:545-613` (`IntakeQueueStore`), drained by
  `sync.js:536-578` (`syncIntakeLogs`). Use the same shape for the new
  notification-action queue.
- **Endpoints touched**:
  - `/api/medications/confirm-schedule` (POST, intake_ids body)
  - `/api/medications/skip` (POST, intake_id body)
  - `/api/medications/snooze` (POST, intake_id + duration_minutes)
  - `/api/medications/cancel-intake` (POST, intake_ids body)
  - `/api/bp/reminder/snooze`, `/api/bp/reminder/dontbug` (POST no body)
  - `/api/weight/reminder/snooze`, `/api/weight/reminder/dontbug` (POST no body)
  - `/api/workout/sessions/{id}/snooze` (POST, minutes body)
  - `/api/workout/sessions/{id}/skip` (POST no body)
  - `/api/tz-plan/{id}/{approve|reject}` (POST no body)

## Development Approach

- **Testing approach**: Regular (code first, then tests). Matches the
  existing low-stock plan and the project's broader pattern.
- The SW is hand-tested awkwardly — Vitest can mock `fetch` and
  `IndexedDB`, and we already have a precedent for SW-shaped unit tests in
  `tests/architecture.sw-precache.test.js`. Tests will exercise the
  helper directly by importing it as plain JS (extracted to a precached
  module); the SW continues to call it via `importScripts`.
- Ship as one PR. Bumping `BUILD_REVISION` in `sw.js:6` is part of the
  PR so existing clients pick up the new SW on next visit.

## Testing Strategy

- **Unit tests**: required. Cover (1) helper sends correct headers when
  token present, (2) falls back gracefully when token absent (cookie-only
  path), (3) failed POSTs land in the queue, (4) successful POSTs do not
  queue, (5) auth-header-only deployments work end-to-end.
- **Integration test**: simulate the full "push → handler → queue →
  drain on online" cycle via Vitest with mocked SW context.
- **No e2e impact directly**, but manual smoke-test in a real browser
  with a Telegram bot push is part of Post-Completion.

## Progress Tracking

- Mark completed items with `[x]` immediately.
- Add ➕ for newly discovered tasks; ⚠️ for blockers.

## Implementation Steps

### Task 1: Extract `swApiCall` helper

- [x] create `web/static/js/sw-api-helper.js` — exports global
  `swApiCall(endpoint, method, body)` (attached to `self.SwApi`); reads
  `self.SwApi.authToken` (set by message handler) and adds
  `X-Telegram-Init-Data` header when present; always sends
  `credentials: 'include'` so the cookie path keeps working
- [x] register `importScripts('/static/js/sw-api-helper.js')` at the top
  of `web/static/sw.js`
- [x] add `'/static/js/sw-api-helper.js'` to `STATIC_ASSETS` in
  `sw.js:12-80`
- [x] add the helper path to `web/static/js/tests/architecture.sw-precache.test.js`
  expected-list assertion if the test enumerates each entry (added
  to the `SW_SELF_IMPORTS` allowlist used by the orphan check)
- [x] write tests in `web/static/js/tests/sw-api-helper.test.js`:
  helper sends header when token set; helper omits header when token
  unset; helper attaches `credentials: 'include'`; helper returns the
  parsed JSON body for 2xx; helper throws an `Error` with `.status` for
  non-2xx (matches main-thread `apiCallDirect` shape)
- [x] run `pnpm test sw-api-helper` — must pass before next task

### Task 2: Wire client → SW token handoff

- [ ] in `web/static/js/app-shell.js` `initServiceWorker()` (after the
  registration resolves), if `window.userInitData` exists, post
  `{ type: 'SET_AUTH_TOKEN', token: window.userInitData }` to the
  controller; also re-post on `controllerchange` event so updated SWs
  receive the token
- [ ] in `web/static/sw.js` message listener (line 381), add a branch
  for `event.data.type === 'SET_AUTH_TOKEN'` that sets
  `self.SwApi.authToken = event.data.token`
- [ ] in `web/static/js/app.js:5-13` (the early Telegram init), if the
  SW controller is already present at this point, also send the token —
  covers the hot-cache reload case
- [ ] write tests in `web/static/js/tests/app-shell.sw-token.test.js`:
  registration + token send sequence; controllerchange resends token;
  no-op when initData absent
- [ ] run `pnpm test app-shell` — must pass before next task

### Task 3: Replace bodies of all 11 handlers

- [ ] rewrite `handleMedicationConfirm` (`sw.js:614-640`) to call
  `swApiCall('/api/medications/confirm-schedule', 'POST', { scheduled_at,
  medication_ids, intake_ids })`; on failure call new `enqueueFailedAction`
  helper (Task 4) instead of `console.error`
- [ ] rewrite `handleMedicationSkip` (`sw.js:735-750`) similarly
- [ ] rewrite `handleMedicationServerSnooze` (`sw.js:752-767`) similarly
- [ ] rewrite `handleCancelIntake` (`sw.js:583-612`) similarly
- [ ] rewrite `handleBPSnooze` (`sw.js:642-655`) and `handleBPDontBug`
  (`sw.js:657-670`)
- [ ] rewrite `handleWeightSnooze` (`sw.js:672-685`) and
  `handleWeightDontBug` (`sw.js:687-700`)
- [ ] rewrite `handleWorkoutSnooze` (`sw.js:702-717`) and
  `handleWorkoutSkip` (`sw.js:719-733`)
- [ ] rewrite `handleTZPlanAction` (`sw.js:559-581`) — keep the result
  notification logic; only the underlying fetch changes
- [ ] verify each handler still posts the matching `client.postMessage`
  notification (`MEDICATION_CONFIRMED`, `WORKOUT_SKIPPED`, etc.) on
  success; do NOT post on failure
- [ ] write integration tests in
  `web/static/js/tests/sw-handlers.test.js` covering one happy-path and
  one queue-on-failure case per *category* (med, bp, weight, workout,
  tz-plan, cancel) — 6 happy + 6 fail = 12 cases minimum
- [ ] run `pnpm test sw-handlers` — must pass before next task

### Task 4: Failed-action queue

- [ ] add `pending_sw_actions` Dexie store to `web/static/js/db.js` —
  bump version to 6, schema:
  `pending_sw_actions: '++localId, endpoint, syncStatus, createdAt'`;
  expose as `MedTrackerDB.SwActionQueue` with `save(action)`,
  `getPending()`, `markSynced(localId)`, `markRejected(localId, errorMsg)`
- [ ] in `sw-api-helper.js`, add `enqueueFailedAction({ endpoint, method,
  body })` that opens an IndexedDB connection directly (cannot import
  Dexie from SW) and writes to `pending_sw_actions` with
  `syncStatus: 'pending'`, `createdAt: Date.now()`
- [ ] add `drainSwActionQueue()` to `web/static/js/sync.js` that runs in
  `SyncManager.syncAll()` after the existing three syncers; for each
  pending action, calls `apiCallDirect(endpoint, method, body)`, marks
  synced or rejected (using `isPermanentSyncError` for the 4xx vs 5xx
  branch — established pattern from sync.js:11-25)
- [ ] in `SyncManager.updateStatus()`, add the queue's pending count to
  `totalPending` so the status bar displays it
- [ ] write tests in `web/static/js/tests/sw-action-queue.test.js`:
  enqueue write, drain success path, drain transient-error path
  (re-queues), drain permanent-error path (marks rejected, does not
  re-queue)
- [ ] write Dexie migration test (mirror existing migration tests in
  `web/static/js/tests/`) verifying v5 → v6 upgrade preserves existing
  stores
- [ ] run full `pnpm test` — must pass before next task

### Task 5: Bump SW revision and verify acceptance

- [ ] bump `BUILD_REVISION` in `web/static/sw.js:6` from `'2'` to `'3'`
  so existing clients pick up the new SW
- [ ] grep for `await fetch(` inside `web/static/sw.js` returns zero
  hits (proves all handlers route through `swApiCall`); the only
  remaining `fetch(` should be inside `sw-api-helper.js`
- [ ] grep for `console.error` inside `web/static/sw.js` returns zero
  hits in the handler bodies (proves failures are queued, not dropped)
- [ ] run full `pnpm test` clean
- [ ] run `go test ./...` clean (defensive — sw changes don't touch Go,
  but architecture tests sometimes cross-validate)
- [ ] verify `architecture.sw-precache.test.js` still passes

## Technical Details

### `sw-api-helper.js` shape

```javascript
self.SwApi = {
    authToken: null,
    async call(endpoint, method = 'GET', body = null) {
        const headers = { 'Content-Type': 'application/json' };
        if (this.authToken) headers['X-Telegram-Init-Data'] = this.authToken;
        const res = await fetch(endpoint, {
            method,
            headers,
            credentials: 'include',
            body: body ? JSON.stringify(body) : null,
        });
        if (!res.ok) {
            const err = new Error(await res.text() || res.statusText);
            err.status = res.status;
            throw err;
        }
        const txt = await res.text();
        return txt ? JSON.parse(txt) : true;
    },
    async enqueueFailedAction(action) { /* IDB direct write */ },
};

self.swApiCall = (endpoint, method, body) => self.SwApi.call(endpoint, method, body);
```

### Handler shape (after rewrite)

```javascript
async function handleMedicationSkip(intakeId) {
    try {
        await self.swApiCall('/api/medications/skip', 'POST', { intake_id: intakeId });
        const cs = await self.clients.matchAll();
        cs.forEach(c => c.postMessage({ type: 'MEDICATION_SKIPPED' }));
    } catch (e) {
        await self.SwApi.enqueueFailedAction({
            endpoint: '/api/medications/skip',
            method: 'POST',
            body: { intake_id: intakeId },
        });
    }
}
```

### IndexedDB direct write from SW

The SW cannot use Dexie (it lives on `window`). Use a tiny direct
`indexedDB.open('MedTrackerDB')` wrapper inside `sw-api-helper.js`. The
schema must already exist (created by the main thread on first load),
so the SW only opens the existing DB and writes — no schema definition
in the SW.

## Post-Completion

**Manual verification** (recommended pre-merge):
- In a real Telegram WebApp client, dismiss the app; trigger a med
  reminder; tap "Skip" on the notification with the device offline;
  verify the badge count rises and the action appears in the
  `pending_sw_actions` Dexie table; bring device online and verify the
  POST fires and the queue empties.
- Repeat for BP-snooze and workout-skip notifications.

**No external system updates needed.** Backend endpoints are unchanged;
this is purely a client/SW refactor.
