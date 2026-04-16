# Fix: medication intake logged via web is not persisted to the database

## Overview

The user reports that pressing the green "Log" button on the Medications tab shows "Intake logged!" but the intake never lands in the DB (verified by comparing with Telegram /log, which only shows one entry instead of two). The previous iteration's tests covered the happy path but couldn't reproduce the production failure, so this plan combines three angles: (1) eliminate the divergence with the working /log path by routing through the existing MedicationService, (2) strengthen the server response contract and add structured logging so the next reproduction is diagnosable and a silent insert failure returns 500 instead of 200, (3) add frontend defensive cache invalidation and a post-submit visibility check so stale SWR cache or an in-flight deduplicated GET cannot hide the new intake.

## Context

- Web handler: `internal/server/medication_handlers.go:802` `handleLogPastIntake` — currently calls `s.meds.CreateManualIntake(...)` directly, then `s.meds.DecrementInventory(...)`, then returns `{id, status: "created"}` without reading the row back.
- Telegram /log path (working): `internal/bot/bot.go:616` `log:<medID>` callback calls `b.medSvc.LogMedicationNow(userID, medID)`.
- Domain service: `internal/domain/medication.go:158` `LogMedicationNow(userID, medID)` — the only reference to `CreateManualIntake` in the service layer; uses `time.Now()`. No `LogMedicationAt` variant exists.
- MedicationStore interface: `internal/domain/medication.go:22`.
- Store: `internal/store/store.go:573` `CreateManualIntake` — unconditional `INSERT … status='TAKEN'`, no UNIQUE constraints on `intake_log` (migrations 001/005/027/037 verified).
- History handler: `internal/server/server.go:548` `handleListHistory` — default `days=3`, filters `scheduled_at >= now - days*24h`, no `user_id` filter.
- Frontend entry points:
  - `web/static/js/app.js:2538` `confirmLogPast` — POSTs `/api/medications/log-past`, alerts "Intake logged!", calls `loadMeds()` and `loadHistory()` on success.
  - `web/static/js/app.js:2144` `loadHistory` — wraps `loadSWR` with `cacheKey = history_${days}_${medId}` and tag `['history']`.
  - `web/static/js/data-store.js:71` `fetchFresh` — deduplicates in-flight requests per cache key; `invalidateByTag` evicts in-flight and bumps generation.
  - `web/static/js/core/api.js:54` `apiCallDirect` — calls `DataStore.advanceCursorSilently()` after writes (fire-and-forget, not awaited).
- Existing tests (all green):
  - `internal/server/server_handlers_test.go` `TestLogPastIntake_AppearsInListHistory` (HTTP integration)
  - `web/static/js/tests/app.log-past-history.test.js` (JSDOM happy path + stale SWR cache variant)
- Related patterns:
  - Domain Service Pattern (see CLAUDE.md) — web/bot callbacks must go through the domain service, not the store directly. `handleLogPastIntake` currently violates this.
  - JSON golden-file testing is available but not required here; httptest + vitest are the right tools.

## Development Approach

- Testing approach: Regular (code first, then tests) because the goal is changing the contract/logging, not re-proving the happy path.
- Complete each task fully before moving to the next.
- CRITICAL: every task MUST include new/updated tests.
- CRITICAL: all tests must pass before starting next task.

## Implementation Steps

### Task 1: Add `LogMedicationAt` to MedicationService and route the web handler through it

**Files:**
- Modify: `internal/domain/medication.go` (add `LogMedicationAt` method to the interface and impl; refactor `LogMedicationNow` to delegate to it)
- Modify: `internal/server/medication_handlers.go` (`handleLogPastIntake` — call `s.medSvc.LogMedicationAt`, then `GetIntake(id)` to read back the persisted row, return full `IntakeLog` as JSON; return `500` if read-back returns nil; add `slog.Info` with `user_id, med_id, taken_at, id`)
- Modify: `internal/server/server_handlers_test.go` (`TestLogPastIntake_AppearsInListHistory` — assert response body includes `id, medication_id, status=="TAKEN", taken_at, scheduled_at`; add subtest asserting `500` when medication does not exist — currently `handleLogPastIntake` returns 404 before reaching CreateManualIntake; that behavior stays)
- Modify: `internal/server/medication_handlers_test.go` (`TestHandleLogPastIntake` if it asserts the old `{id, status}` response shape — update to new shape)

- [x] Add `LogMedicationAt(userID, medID int64, takenAt time.Time) (int64, error)` returning the new intake ID; refactor `LogMedicationNow` to `return s.LogMedicationAt(userID, medID, time.Now())` (single source of truth; matches working /log path)
- [x] Update `MedicationService` interface and any mock implementations in tests
- [x] Rewrite `handleLogPastIntake` to call `s.medSvc.LogMedicationAt(userId, req.MedicationID, takenAt)`, then `s.meds.GetIntake(id)`, return the full struct; keep the 400/404 branches as-is
- [x] Emit `slog.Info("log past intake", "user_id", userId, "med_id", req.MedicationID, "taken_at", takenAt, "id", id)` before writing the response
- [x] Update `TestLogPastIntake_AppearsInListHistory` to decode the POST response into `store.IntakeLog` and assert fields; keep both subtests (now / -5h)
- [x] Update any other test that decodes the old `{id, status}` shape
- [x] Run `go test ./internal/server/... ./internal/domain/... ./internal/bot/...` — must pass before Task 2

### Task 2: Add structured logging to `handleListHistory`

**Files:**
- Modify: `internal/server/server.go` (`handleListHistory` — log `user_id, days, med_id, count` at `Debug`; log at `Warn` if `len(logs) == 0 && medID > 0` since that is a likely symptom of the reported bug)
- Modify: `internal/server/misc_handlers_test.go` (existing `TestHandleListHistory` — ensure the handler still works; no need to assert log output)

- [x] Read `user_id` from context (same pattern as other handlers); include in log line
- [x] Emit `slog.Debug("list history", ...)` after `GetIntakeHistory` with the parsed filters and result count
- [x] Run `go test ./internal/server/...` — must pass before Task 3

### Task 3: Frontend — invalidate `history`/`medications` tags before reload and verify the new intake is visible

**Files:**
- Modify: `web/static/js/app.js` (`confirmLogPast` — after `res` is truthy and before calling `loadHistory`, call `await window.DataStore.invalidateByTag('history')` and `await window.DataStore.invalidateByTag('medications')`; after `loadHistory()` resolves, check that the returned response contains an object with `id === res.id`; if not, call `window.SyncDebug?.warn('log-past: new intake not visible in history after reload', { id: res.id })` and show a non-blocking toast via `SyncManager.showToast('Saved, but history did not refresh — pull to refresh', 'error')`)
- Modify: `web/static/js/tests/app.log-past-history.test.js` (extend existing two tests and add a third)

- [x] Update `confirmLogPast` as described; keep `safeAlert("Intake logged!")` and `closeMedicationConfirmModal()` behavior unchanged so the happy path UX is identical
- [x] Refactor `loadHistory` slightly if needed so `confirmLogPast` can await the fresh fetch result (the cleanest approach is to have `loadHistory` return `{ fresh }` from `loadSWR`, which it already can because `loadSWR` returns that object)
- [x] Extend happy-path test: assert `DataStore.invalidateByTag('history')` and `DataStore.invalidateByTag('medications')` are called between the POST and the history GET
- [x] Extend stale-cache test: make the mocked `/api/history` response NOT include the new intake, then assert `SyncDebug.warn` is called and `SyncManager.showToast` is invoked with an "error" type
- [x] Add third test: POST response returns the full intake; `renderHistory` after refresh contains a DOM node with the same ID
- [x] Run `npx vitest run web/static/js/tests/app.log-past-history.test.js` — all three tests pass before Task 4

### Task 4: Verify acceptance criteria

- [x] Run `go test ./...` — all packages pass
- [x] Run `npx vitest run` — all frontend tests pass (including the extended `app.log-past-history.test.js` and any other test that touched the `MedicationService` or the POST response shape)
- [x] Run `go vet ./...` — clean
- [x] Manually re-read `handleLogPastIntake` and `confirmLogPast` to confirm no leftover TODOs / dead code from the refactor

### Task 5: Update documentation

- [ ] Update CLAUDE.md `## Domain Service Pattern` section — add a note that `LogMedicationAt` exists and that `handleLogPastIntake` goes through the domain service (so future contributors don't regress to a direct store call)
- [ ] Move this plan to `docs/plans/completed/` when everything above is green
