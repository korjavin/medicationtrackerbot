# Sync-pipeline factory

## Overview

`web/static/js/sync.js` defines three offline-write sync methods, each
~50 lines, each near-identical:

- `syncBPReadings()` — sync.js:436–485
- `syncWeightLogs()` — sync.js:488–533
- `syncIntakeLogs()` — sync.js:536–578

They differ only in: store reference (`BPStore` / `WeightStore` /
`IntakeQueueStore`), endpoint URL, payload shape, and `confirmDelete`
vs `markSynced` semantics. Otherwise: identical try/catch shape,
identical `isPermanentSyncError` branching, identical
`markRejected`/`markError` fallback.

The shape repeats further downstream:

- `handleOfflineBPRead`, `handleOfflineWeightRead` — sync.js:749–765
- `handleOfflineBPWrite`, `handleOfflineWeightWrite`,
  `handleOfflineIntakeWrite` — sync.js:697–839

Adding offline support for a 4th entity (food logs, currently
explicitly out of scope per `docs/frontend.md`) means writing another
~120-line copy. A `defineOfflineEntity({…})` factory would compress
these to per-entity config and force consistency on retry behaviour,
toast wording, and rejected-vs-error semantics.

This plan introduces the factory, refactors the three existing
entities to use it, and writes integration tests that exercise each
entity through the factory.

**Out of scope:**
- Adding a 4th offline entity. Plan exists to make adding one cheap;
  actually adding food / notes / workouts is a follow-up product
  decision.
- The new `pending_sw_actions` queue from the
  [SW handler unification plan](2026-05-13-sw-handler-unification.md)
  Task 4 — that's a different shape (notification-action queue, not
  user-write queue) and stays separate. Optional future work: unify
  both queues behind the same factory once both have shipped.

From the [2026-05-13 frontend review §7](../2026-05-13-frontend-code-review.md#7-sync-layer-three-near-identical-pipelines)
and recommended-priority item #9.

## Context (from discovery)

- **Three syncers** in `web/static/js/sync.js`:
  - `syncBPReadings` (line 436) → `BPStore`, `/api/bp`, `confirmDelete`
  - `syncWeightLogs` (line 488) → `WeightStore`, `/api/weight`,
    `confirmDelete`
  - `syncIntakeLogs` (line 536) → `IntakeQueueStore`,
    `/api/medications/confirm-schedule`, `markSynced` (different
    semantics: queue is single-use; main stores keep records as
    "synced" until user deletes)
- **Three offline-write handlers** (`handleOfflineXWrite` at lines
  697, 722, 813) — same shape: `Store.save(body)`, register
  background sync, show toast, return mock with `id: 'local_<id>',
  isLocal: true`. Differences: store reference, sync tag, toast
  wording.
- **Two offline-read handlers** (`handleOfflineXRead` at lines 749,
  759) — same shape: read from store, map adding `id` and `isLocal`
  flag. Differences: store reference.
- **`isPermanentSyncError`** (line 11) is the shared 4xx-vs-5xx
  decision; reused by every syncer.
- **Background sync tags** registered with the SW: `'sync-bp-readings'`,
  `'sync-weight-logs'`, `'sync-intake-logs'` — handled by SW message
  listeners (sw.js:159-170). Factory output must continue to use
  these tag names.
- **DB stores** (`web/static/js/db.js`):
  - `BPStore` (line 80), `WeightStore` (line 238) — full lifecycle
    (`save`, `markSynced`, `markError`, `markRejected`, `getPending`,
    `confirmDelete`, `getRejected`, `syncFromServer`)
  - `IntakeQueueStore` (line 546) — narrower (no `confirmDelete`,
    uses `markSynced` to delete since it's a one-shot queue)
  - All three stores share the same `pending` / `error` / `rejected`
    statuses, same `markError(localId, msg)` / `markRejected(localId,
    msg)` shape

## Development Approach

- **Testing approach**: Regular.
- Single PR. The factory is added in Task 1, the three syncers are
  rewritten to call it in Task 2, then offline reads/writes get the
  same treatment in Task 3. Architecture test (Task 4) prevents new
  ad-hoc syncers from being added.
- Backwards-compatible at the user level — toasts, error messages,
  background-sync tags all unchanged.

## Testing Strategy

- **Unit tests**: required for the factory itself. Cover (1) success
  drains queue and calls correct DB delete/mark API, (2) transient
  error marks-error, leaves item for retry, (3) permanent error
  marks-rejected, removes from retry pool, (4) queue-empty path is
  no-op.
- **Existing tests** (`tests/sync.retry.test.js`,
  `tests/sync.manager-flow.test.js`) load the SyncManager and
  exercise each syncer; they stay valid and ensure the rewrite is
  behaviour-preserving.
- **No e2e impact**: user-visible behaviour (toasts, status bar)
  unchanged.

## Progress Tracking

- Mark completed items with `[x]` immediately.
- Add ➕ for new tasks; ⚠️ for blockers.

## Implementation Steps

### Task 1: Define `defineOfflineEntity` factory

- [ ] add `defineOfflineEntity(config)` to `web/static/js/sync.js`
  (above the `SyncManager` definition); config schema:
  - `name` (string, e.g. `'BP'`) — used in log messages
  - `store` (one of `BPStore`/`WeightStore`/`IntakeQueueStore`)
  - `endpoint` (string, e.g. `'/api/bp'`)
  - `buildPayload(entry)` (function returning the POST body)
  - `onSuccess(localId, serverId, store)` (function — calls either
    `confirmDelete` or `markSynced`)
  - `backgroundSyncTag` (string, e.g. `'sync-bp-readings'`)
  - `toastSingular`, `toastPlural` (strings used by offline-write
    toast)
- [ ] factory returns an object with two methods:
  - `syncPending()` — drains the store's pending list, mirroring the
    existing 50-line shape
  - `handleOfflineWrite(body)` — saves body to store, registers
    background sync, shows toast, returns mock response shape
- [ ] keep `isPermanentSyncError` and `isNetworkError` as shared
  helpers (already exported)
- [ ] write tests in `web/static/js/tests/sync.factory.test.js`
  covering: success drain, transient error retry, permanent error
  reject, queue-empty no-op, background-sync registration, toast
  emit (use a mock store that records calls)
- [ ] run `pnpm test sync.factory` — must pass before next task

### Task 2: Define and substitute the three entities

- [ ] define `BPSync = defineOfflineEntity({name:'BP', store: ...,
  endpoint:'/api/bp', buildPayload: r => ({measured_at:r.measured_at,
  systolic:r.systolic, ...}), onSuccess:(id,sid,s)=>s.confirmDelete(id),
  backgroundSyncTag:'sync-bp-readings', toastSingular:'BP reading
  saved locally', toastPlural:'BP readings saved locally'})`
- [ ] define `WeightSync` and `IntakeSync` analogously; for
  `IntakeSync.onSuccess`, call `IntakeQueueStore.markSynced(id)`
  instead of `confirmDelete`
- [ ] replace `SyncManager.syncBPReadings`, `syncWeightLogs`,
  `syncIntakeLogs` (sync.js:436, 488, 536) with one-line forwarders:
  `syncBPReadings() { return BPSync.syncPending(); }` etc — keep the
  method names so existing callers (SW message handlers, periodic
  `syncAll`) don't change
- [ ] replace `handleOfflineBPWrite`, `handleOfflineWeightWrite`,
  `handleOfflineIntakeWrite` (sync.js:697, 722, 813) with one-line
  forwarders to `BPSync.handleOfflineWrite(body)` etc
- [ ] verify `tests/sync.retry.test.js` and
  `tests/sync.manager-flow.test.js` still pass without changes (the
  rewrite is behaviour-preserving)
- [ ] verify `db.js` Store imports are unchanged
- [ ] run `pnpm test sync.` — must pass before next task

### Task 3: Generalize the offline-read handlers

- [ ] add `entity.handleOfflineRead()` to the factory; default
  implementation reads `store.getAll()` and maps each entry to
  `{ id: r.serverId || `local_${r.localId}`, ...r, isLocal: !r.serverId }`
- [ ] replace `handleOfflineBPRead`, `handleOfflineWeightRead`
  (sync.js:749, 759) with `BPSync.handleOfflineRead()` /
  `WeightSync.handleOfflineRead()`
- [ ] keep `handleOfflineHistoryRead` (sync.js:769) and
  `handleOfflineWorkoutRead` (sync.js:789) **out of the factory** —
  they read from cache stores (`IntakeHistoryStore`, `WorkoutStore`)
  not pending-write stores; different shape
- [ ] write tests in `web/static/js/tests/sync.offline-read.test.js`
  verifying both refactored reads return the same payload shape as
  before
- [ ] run `pnpm test sync.` — must pass before next task

### Task 4: Architecture test prevents recurrence + acceptance

- [ ] add `web/static/js/tests/architecture.sync-factory.test.js`
  scanning `web/static/js/sync.js` for raw `await window.apiCallDirect(`
  calls outside the factory function — assert the only such call lives
  inside `defineOfflineEntity`'s closure (i.e. nobody added a new
  ad-hoc syncer)
- [ ] run `pnpm test architecture.sync-factory` — must pass
- [ ] line count: `wc -l web/static/js/sync.js` < 700 (started at
  875; expect ~600 after dedup of three 50-line copies + offline
  reads/writes)
- [ ] grep for `markRejected\|markError` outside the factory in
  `sync.js` returns zero hits (proves the error-branching is centralized)
- [ ] full `pnpm test` clean

## Technical Details

### Factory shape

```javascript
function defineOfflineEntity(config) {
    const { name, store, endpoint, buildPayload, onSuccess,
            backgroundSyncTag, toastSingular } = config;

    async function syncPending() {
        if (!SyncManager.isOnline) return;
        const pending = await store.getPending();
        if (pending.length === 0) {
            SyncDebug.info(`No pending ${name}`);
            return;
        }
        SyncDebug.info(`Syncing ${pending.length} ${name}...`);
        for (const entry of pending) {
            try {
                const payload = buildPayload(entry);
                const result = await window.apiCallDirect(endpoint, 'POST', payload);
                if (result && result.id) {
                    await onSuccess(entry.localId, result.id, store);
                    SyncDebug.info(`${name} synced`, { localId: entry.localId, serverId: result.id });
                } else {
                    throw new Error('No ID returned from server');
                }
            } catch (err) {
                SyncDebug.error(`${name} sync failed for ${entry.localId}`, { error: err.message });
                if (isPermanentSyncError(err)) {
                    await store.markRejected(entry.localId, err.message);
                } else {
                    await store.markError(entry.localId, err.message);
                }
            }
        }
        SyncManager.updateStatus();
    }

    async function handleOfflineWrite(body) {
        const localEntry = await store.save(body);
        SyncManager.registerBackgroundSync(backgroundSyncTag);
        SyncManager.showToast(toastSingular + ' — will sync when online', 'info');
        SyncManager.updateStatus();
        return { ...body, id: `local_${localEntry.localId}`, localId: localEntry.localId, isLocal: true };
    }

    async function handleOfflineRead() {
        const items = await store.getAll();
        return items.map(r => ({ id: r.serverId || `local_${r.localId}`, ...r, isLocal: !r.serverId }));
    }

    return { syncPending, handleOfflineWrite, handleOfflineRead };
}
```

### Why keep the legacy method names

`syncBPReadings()` etc. are referenced by:
- the SW message handlers (`sw.js:161-167`)
- `SyncManager.syncAll()` (`sync.js:413-418`)
- existing tests

Renaming them would balloon the PR. The forwarder shape preserves
the names while moving logic into the factory.

### Why intake stays slightly different

`IntakeQueueStore.markSynced(id)` deletes the row (single-use queue);
`BPStore.confirmDelete(id)` also deletes but is named differently
(BP rows have a longer lifecycle). The factory absorbs the difference
via the `onSuccess` callback so callers don't need to know the
underlying semantics.

## Post-Completion

**Manual verification** (recommended):
- Take device offline, log a BP reading + a weight reading + a med
  confirmation; bring online; verify all three sync without error and
  the status bar reaches "Synced" state.
- Force a 400 response from the BP endpoint (manual server tweak in
  dev) and verify the entry is marked-rejected (not retried).

**No external system updates needed.** Backend endpoints are
unchanged.
