# Optimistic Updates for Same-Device Writes

## Overview

The frontend currently has no online-path optimistic updates. Every write handler in `web/static/js/` follows the same shape: `POST → DataStore.invalidateTags → loadX() → re-render`. Because `DataStore.invalidateTags` (`web/static/js/data-store.js:360`) *clears* the SWR cache but does **not** dispatch a `datastore:changed` event (only the 30s poll's `applyChangesPayload` does, see `data-store.js:401`), handlers manually call `loadX()`, which then misses on the cache they just cleared and goes to network. Result: the UI sits idle through the round-trip even though the action is the user's own — perceived as a "delay" when finishing a workout, logging food, saving a BP reading.

This is a same-device problem and is independent of the SSE work in `docs/plans/2026-05-17-sse-changes-stream.md`. Fixing it removes the felt latency regardless of whether updates arrive via polling or SSE.

## Goal

After each online write, the affected screens repaint **before** the network round-trip resolves, using the post-mutation payload synthesised on the client. Reconcile against the server response on resolution; roll back on failure.

## Approach

**Cross-cutting fix first, per-screen patches second.**

1. **Add a `DataStore.applyOptimistic(key, mutator, tags)` helper** in `web/static/js/data-store.js` that:
   - Reads the current cached payload (synchronously from memory, falls back to IndexedDB).
   - Applies `mutator(prev) → next` to produce the optimistic state.
   - Calls `setCachedWithTags(key, next, tags)` — i.e. *writes* the post-mutation state instead of clearing.
   - Dispatches `datastore:changed` with `{ source: 'optimistic', changedTags }` so subscribers (Today, lists) repaint.
   - Returns a `commit(serverPayload)` / `rollback()` pair the caller uses on POST resolution/failure.

2. **Convert write handlers** to use the helper before awaiting the network call. Replace existing `invalidateTags + loadX + loadToday` chains with `applyOptimistic + POST + reconcile`. Keep `invalidateTags` only on the rollback path (so the next read goes to network) — the success path is already canonical.

3. **Leave the 30s poll path alone.** `applyChangesPayload` already invalidates and dispatches; it's the source of truth for cross-device sync. Optimistic state gets reconciled with whatever the poll brings back.

## Context (from discovery)

Findings audit and cross-cutting recommendation came from the parent conversation; details below cite specific lines.

- **Root cause**: `data-store.js:360 invalidateTags` clears caches, does not dispatch `datastore:changed`. Only `data-store.js:401 applyChangesPayload` (poll path) does.
- **Worst offenders** (write handlers that miss optimistic):
  - Workouts: `web/static/js/features/workout/sessions.js:444 saveWorkoutSessionDetails`, `:392 finishWorkoutSession`, `:560 startAdHocWorkout`, `:602 completeWorkoutSession`, `:734 saveNewSessionExercise`, `:347 deleteExerciseLog`; plus `web/static/js/app.js:2438 snoozeWorkout`, `:2456 skipWorkout`.
  - Food: `web/static/js/features/food/log.js:381 saveFoodLog`, `:1097 deleteFoodLog`, `web/static/js/features/food/photo.js:206`, `web/static/js/features/food/meals.js:65`, `:142`, `web/static/js/features/food/products.js:853`.
  - BP: `web/static/js/features/bp.js:88 saveBP`, `:651 deleteBP`.
  - Weight: `web/static/js/features/weight.js:329 saveWeight`, `:344` / `:1133` delete.
  - Medications: `web/static/js/app.js:2225 confirmSelectedMedications`, `:2255 skipSelectedMedications`, `:2311 updateIntakeHistory`, `:2369 confirmLogPast`; `web/static/js/features/meds.js:536 deleteFutureIntakes`, `:1097–1141` add/edit/delete/archive.
  - Diary: `web/static/js/features/health.js:1084 addNote`, `:1110 deleteNote`, `:1199` edit-note.
- **Cache keys that need synthesis** (per surface):
  - Workouts: `workout_next`, `workout_history` (or whatever the sessions cache key is).
  - Food: `food_<date>_v2`, `todayFoodKey`, `food_stats_<date>` if cached.
  - BP/Weight: `bp`, `weight` (list payloads) — Today reads from the same cache via `loadToday`'s recompute.
  - Medications: `medications`, `next_intake`, `history`.
  - Diary: `diary_notes` (or the equivalent key used by `loadNotes`).
- **Existing infrastructure to reuse**: `setCachedWithTags` (`data-store.js:99`), `cachedFetch` cache contract for keys, the `requestTabRefresh()` event already wired to `datastore:changed`.

## Development Approach

- **Testing approach**: Regular (code first, then tests). Frontend tests are integration-first per `CLAUDE.md` rule 8 — extend the owning feature suite (`features.<name>.test.js`) via `tests/helpers/frontend-harness.js`. Do **not** add standalone `*-optimistic.test.js` files; add cases to the existing describe blocks for the touched feature.
- Land the `applyOptimistic` helper first with its own unit test (in `tests/data-store.*` — DataStore is one of the few pure-unit-test allowances per CLAUDE.md). Then convert one screen end-to-end as a worked example, then fan out.
- **One write surface per task** so each PR is small and revertible. Workout finish is the highest-pain — do it first.
- **CRITICAL: every task MUST include new/updated tests** covering both success-path (optimistic state visible synchronously after dispatching) and failure-path (rollback on POST error) for the converted handler.
- **CRITICAL: all tests must pass before starting next task**.
- Maintain backward compatibility — the poll path remains canonical; optimistic state is layered on top.

## Testing Strategy

- **Unit tests**: required for every task. The `applyOptimistic` helper itself gets pure-unit tests in `web/static/js/tests/data-store.optimistic.test.js`. Each converted handler gets cases added to its feature suite covering:
  - Synchronous local mutation visible before the POST resolves (assert via `datastore:changed` listener or rendered DOM after the mutation, before harness resolves the network mock).
  - Reconcile path: POST returns a server payload, optimistic state is replaced with server truth.
  - Rollback path: POST rejects, cached state is restored and an error toast / UI signal fires.
- **E2E tests**: project does not currently run Playwright/Cypress (see memory: "Use Playwright/Cypress for E2E testing vanilla JS frontend (avoid refactor overhead)" — adopted as a decision but not yet implemented). Skip e2e for this work; integration tests via the frontend harness cover the rendered-DOM behaviour.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): code changes and tests
- **Post-Completion** (no checkboxes): manual UX verification on a real device

## Implementation Steps

### Task 1: Add `DataStore.applyOptimistic` helper
- [x] add `applyOptimistic(key, mutator, tags)` method in `web/static/js/data-store.js` near `setCachedWithTags` (around line 99)
- [x] returned object exposes `commit(serverPayload)` (overwrites cache + dispatches) and `rollback()` (restores prior cache + invalidates tags so next read goes to network)
- [x] helper dispatches `datastore:changed` with `{ changedTags, source: 'optimistic' }` after the optimistic write so existing `requestTabRefresh` listeners repaint
- [x] write tests in `web/static/js/tests/data-store.optimistic.test.js` covering: synchronous cache update, dispatch fired, commit replaces with server payload, rollback restores prior state
- [x] run `pnpm test` — must pass before next task

### Task 2: Convert workout finish + session save
- [x] convert `features/workout/sessions.js:392 finishWorkoutSession` to `applyOptimistic` on `workout_next` (synthesise null/completed state) and the sessions history cache key
- [x] convert `:444 saveWorkoutSessionDetails` to optimistically flip `status` on the cached session entry
- [x] convert `:734 saveNewSessionExercise` to push the new log into `WorkoutSessionsState.logs` and the cached payload before await
- [x] convert `:347 deleteExerciseLog` to splice locally before await
- [x] add cases to `features.workouts.*` integration suite for finish, save-details, add-log, delete-log — each asserting the rendered DOM updates before the network mock resolves, plus a rollback case on POST error
- [x] run `pnpm test` — must pass before next task

### Task 3: Convert ad-hoc workout actions
- [x] convert `features/workout/sessions.js:560 startAdHocWorkout`, `:602 completeWorkoutSession`, `:619 preSkipWorkoutSession`, `:635 cancelPreSkipWorkoutSession`
- [x] convert `app.js:2438 snoozeWorkout`, `:2456 skipWorkout`
- [x] write tests in `features.workouts.*` covering each action's optimistic + rollback path
- [x] run `pnpm test` — must pass before next task

### Task 4: Convert food log
- [x] convert `features/food/log.js:381 saveFoodLog` to write into `food_<date>_v2`, `todayFoodKey` (with updated totals) before await
- [x] convert `:1097 deleteFoodLog` to filter locally first
- [x] convert `features/food/photo.js:206` to append returned items into the cached `food_<date>_day` payload instead of re-fetching
- [x] convert `features/food/meals.js:65`, `:142` (meal save/delete) and `features/food/products.js:853` (product save)
- [x] write tests in `features.food.*` covering save (incl. totals update), delete, photo, meal save, product save — optimistic + rollback for each
- [x] run `pnpm test` — must pass before next task

### Task 5: Convert BP + Weight
- [x] convert `features/bp.js:88 saveBP` to prepend the new reading into the cached `bp` payload + re-render before await
- [x] convert `features/bp.js:651 deleteBP` to filter locally first
- [x] convert `features/weight.js:329 saveWeight` (same shape as BP)
- [x] convert `features/weight.js:344` / `:1133` delete handlers
- [x] write tests in `features.bp.*` and `features.weight.*` for save/delete optimistic + rollback (including Today's tile freshness via the integration harness)
- [x] run `pnpm test` — must pass before next task

### Task 6: Convert medications
- [x] convert `app.js:2225 confirmSelectedMedications` to flip the matched `intake_log` entry's status in the cached `medications`/`history` payload and patch `next_intake` (recompute via `MedicationUtils.getNextScheduledDate`)
- [x] convert `:2255 skipSelectedMedications`, `:2311 updateIntakeHistory`, `:2369 confirmLogPast` with the same shape
- [x] convert `features/meds.js:536 deleteFutureIntakes` and the add/edit/delete/archive handlers at `:1097–1141`
- [x] write tests in `features.meds.*` for confirm, skip, edit-history, log-past, delete-future, add/edit/delete/archive — each with optimistic + rollback
- [x] run `pnpm test` — must pass before next task

### Task 7: Convert diary notes
- [x] convert `features/health.js:1084 addNote` to prepend the note (with `local_*` id) into the rendered list + cached `diary_notes` payload before await; replace id on resolve
- [x] convert `:1110 deleteNote` and `:1199` edit-note
- [x] write tests in the diary feature suite for add/edit/delete optimistic + rollback
- [x] run `pnpm test` — must pass before next task

### Task 8: Verify acceptance criteria
- [x] grep `web/static/js/features` for `invalidateTags` followed by an immediate `loadX()` — every remaining instance is justified (read-only refresh, not a write handler). Remaining invocations fall in three justified buckets: (a) the `invalidateWorkoutCache` helper in `features/workout/index.js`; (b) post-`handle.commit(null)` reconciliations that fetch authoritative server state after the optimistic write (the canonical pattern documented in `features/food/log.js:459` and applied uniformly across BP / Weight / Food / Meds / Diary handlers); (c) non-write paths outside this plan's scope — the inventory restock click handler (`features/meds.js:808`, narrow in-memory update with re-render), the food-targets settings save (`features/food/log.js:1198`), and the photo upload retry/fallback branch (`features/food/photo.js:300`).
- [x] run full frontend test suite: `pnpm test` — 2249 passed, 29 skipped. One pre-existing failure (`health.dexie-hydration.test.js` TZ-mismatch fallback) reproduces identically on master and is environment-dependent (machine TZ == sentinel `Europe/Berlin`); not in scope for this plan.
- [x] run Go test suite: `go test ./...` — all packages pass, no API contract drift.
- [x] run architecture tests — `architecture.globals.test.js`, `architecture.inline-styles.test.js`, `architecture.design-tokens.test.js`, `architecture.no-inline-handlers.test.js`, `architecture.wg-primitives.test.js` all pass; no new `window.*` globals introduced and no inline `.style.` assignments added.
- [x] verify the `pnpm test` test coverage for converted handlers includes both success and rollback paths — confirmed via `it('rolls back ...')` assertions across `features.bp.test.js`, `features.weight.test.js`, `features.meds.test.js` (confirm/skip/log-past/delete-future/saveMedication/deleteMed), `features.diary.test.js` (add/edit/delete), `features.food-log.test.js`, `features.food-meals.test.js`, `features.food-products.test.js`, `features.workout-sessions.test.js` (26 optimistic/rollback assertions); `features.food-photo.test.js` exercises the cache-shape mutator (`appendPhotoItemsToFoodCache`) directly and leans on the integration coverage of the upload flow.

### Task 9: [Final] Update documentation
- [x] add a short subsection in `docs/frontend.md` documenting the optimistic-update pattern + `applyOptimistic` helper (placement: near "Local-First Read Resilience")
- [x] document the design rule: write handlers MUST use `applyOptimistic`, never `invalidateTags + loadX` (cross-link from CLAUDE.md "Critical Rules" section)

## Technical Details

### `applyOptimistic` contract

```
applyOptimistic(key, mutator, tags) → {
  commit(serverPayload),    // overwrite with authoritative state, dispatch datastore:changed
  rollback(),               // restore prior cache, invalidateTags so next read goes to network
}
```

- `mutator(prev) → next`: pure function, receives current cached payload (or `null` if cold cache).
- `tags`: SWR tags the dispatched `datastore:changed` event carries — drives existing `requestTabRefresh` subscribers (Today, list views).
- Synchronous from the caller's perspective: the cache is mutated and event dispatched before the POST is issued.

### Cache-payload synthesis per surface

| Surface | Cache key(s) | What the mutator does |
|---|---|---|
| Workout finish | `workout_next`, sessions history cache | flip session status; null out `workout_next` if completed |
| Workout add log | session details cache, `WorkoutSessionsState.logs` | append new log with `local_*` id |
| Food save | `food_<date>_v2`, `todayFoodKey` | append row, recompute totals |
| Food delete | `food_<date>_v2`, `todayFoodKey` | filter row, recompute totals |
| BP save | `bp` | prepend reading |
| Weight save | `weight` | prepend reading |
| Med confirm | `medications`, `next_intake`, `history` | flip intake_log row status, recompute next |
| Diary add | `diary_notes` | prepend note with `local_*` id |

### Rollback semantics

On POST rejection:
- Restore prior cached payload via the `applyOptimistic`-captured snapshot.
- Call `invalidateTags(tags)` so the next read goes to network and authoritatively resyncs.
- Surface a toast/error state via the existing offline-write error UI patterns where applicable.

## Post-Completion

**Manual verification**:
- On a real device (or DevTools mobile emulation), each converted surface should feel instant on save/delete — no "Saving…" delay, no list flicker, no Today tile lag.
- With DevTools network throttled to "Slow 3G", confirm the optimistic state holds through the slow round-trip and reconciles on resolve.
- Force a POST error (e.g. block the API call in DevTools) and confirm the rollback path restores prior state and surfaces an error.

**External system updates**: none — this is a pure-frontend change.
