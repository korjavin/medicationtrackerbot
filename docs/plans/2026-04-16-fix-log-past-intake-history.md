# Fix: medication intake logged via schedule page does not appear in history

## Overview
Reproduce and fix a bug where an intake logged via the "Log" button on the medication schedule page does not appear on the intake history page even after refresh. Start with a failing HTTP-level integration test that mirrors the real user flow (POST `/api/medications/log-past` followed by GET `/api/history`), then diagnose and fix the underlying defect (whichever layer it turns out to be in), and add a frontend regression test if the bug turns out to be on the client.

## Context
- Frontend entry point: `web/static/js/app.js`
  - `logMedicationPast` at line 1773, `confirmLogPast` at line 2538 — POSTs to `/api/medications/log-past`
  - `loadHistory` at line 2144 — uses SWR with `/api/history?days=${days}&med_id=${medId}`, default `days=3`
- Backend handlers: `internal/server/medication_handlers.go`
  - `handleLogPastIntake` at line 802 — calls `s.meds.CreateManualIntake`
- Backend handler: `internal/server/server.go`
  - `handleListHistory` at line 548 — calls `s.meds.GetIntakeHistory(medID, days)`
- Store: `internal/store/store.go`
  - `CreateManualIntake` at line 573 (inserts status='TAKEN', scheduled_at = taken_at)
  - `GetIntakeHistory` at line 677 (filters by `scheduled_at >= now - days*24h`, optional `medication_id`)
- Existing tests: `internal/server/server_handlers_test.go:479` (TestHandleLogPastIntake) only asserts via direct store call, not via `/api/history`; `internal/server/misc_handlers_test.go:54` tests `handleListHistory` but with `CreateIntake` + `ConfirmIntake`, not `CreateManualIntake`
- No existing test combines the two HTTP handlers in one flow, so any handler-level or serialization-level bug is currently uncaught
- Patterns to follow:
  - Go httptest handler tests via `createGenericTestServer(t)` and `withUser(req, userID)`
  - JSON golden-file testing is available for scheduler/bot tests but not needed for a simple server handler test
  - Frontend vitest tests in `web/static/js/tests/` for any client-side regression

## Development Approach
- Testing approach: TDD. Write a failing test that mirrors the user's exact flow first, run it to confirm it fails, then diagnose and fix.
- Complete each task fully before moving to the next.
- CRITICAL: every task MUST include new/updated tests.
- CRITICAL: all tests must pass before starting next task.

## Implementation Steps

### Task 1: Add failing end-to-end HTTP integration test

**Files:**
- Modify: `internal/server/server_handlers_test.go` (or add a new test file if length is an issue)

- [x] Add `TestLogPastIntake_AppearsInListHistory` that:
  - Creates a test server and medication via `createGenericTestServer(t)` / `db.CreateMedication`
  - Sends a realistic POST `/api/medications/log-past` with JSON body `{medication_id, taken_at: time.Now().Format(time.RFC3339)}` through `srv.handleLogPastIntake`
  - Asserts 200 OK
  - Sends a follow-up GET `/api/history?days=3&med_id=0` (matching frontend defaults) through `srv.handleListHistory`
  - Decodes the response as `[]store.IntakeLog` and asserts the logged intake is present with `status == "TAKEN"` and correct `medication_id`
- [x] Also add a variant with `taken_at` a few hours in the past (common "log past" scenario) to cover boundary behavior
- [x] Run `go test ./internal/server/ -run TestLogPastIntake_AppearsInListHistory -v` — confirm the test fails (or reveals a surprising pass)
- [x] If the test passes: proceed to Task 2 (investigate the frontend); if it fails: proceed to Task 3 (backend fix)

**Result:** Surprising pass. Both variants (now, -5h) pass — the backend log-past → list-history flow works. The bug must be frontend-side. Next iteration will execute Task 2.

### Task 2: If Task 1 passes — reproduce on the frontend

**Files:**
- Create: `web/static/js/tests/app.log-past-history.test.js`

- [x] Set up a vitest JSDOM test that loads `app.js` in the existing harness (see `web/static/js/tests/app.med-confirm-edit-modes.test.js` for reference)
- [x] Stub `apiCall`/`offlineAwareApiCall` to return success for `/api/medications/log-past` and to return a list including the new intake for `/api/history`
- [x] Trigger the full flow: open the log-past modal via `showMedicationConfirmModal([medId], [name], new Date(), 'log_past')`, invoke `confirmLogPast()`, then assert `loadHistory` calls the API and that `renderHistory` produces a DOM node for the new intake (not "No history yet.")
- [x] If reproducing: fix the offending frontend code path (likely SWR cache interaction or `renderHistory` missing the item because `medications` lookup fails) and assert the fix; otherwise skip to Task 3

**Result:** Both frontend variants pass. The first test exercises the happy path (log-past POST -> loadHistory() -> renderHistory() renders the new intake). The second test simulates a previously cached stale-empty `history_3_0` SWR entry and verifies SWR's `fetchFresh` overwrites it with the new intake on refresh. The frontend pathway is not reproducing the bug either. Combined with the Task 1 backend result, this means the reported bug is not reproducible at either isolated layer — the current `confirmLogPast` -> `loadHistory` -> `/api/history` flow is correct. The bug was likely fixed by an earlier change (for example the recent change-polling / SW precache / SWR overhaul) or depends on environment-specific cache state (e.g. a SW `DYNAMIC_CACHE` entry that network-first has already superseded). No frontend fix is warranted; proceed to close out Task 3 without a code change and document the verified behavior.

### Task 3: Fix the bug based on Task 1/Task 2 findings

**Files (to be determined from failure):**
- Likely modify one of: `internal/server/server.go`, `internal/server/medication_handlers.go`, `internal/store/store.go`, or `web/static/js/app.js`

- [x] Diagnose the exact failure mode from the failing test — no failing test produced. Task 1 (HTTP integration) and Task 2 (frontend JSDOM) both passed, including the stale-SWR-cache variant. The backend `handleLogPastIntake` → `handleListHistory` path correctly surfaces the new intake, and the frontend `confirmLogPast` → `loadHistory` → `renderHistory` path correctly re-renders when SWR `fetchFresh` resolves.
- [x] Apply the minimal fix (do not refactor surrounding code) — no code change required. The principle "don't add error handling, fallbacks, or validation for scenarios that can't happen" applies: adding a speculative fix for an unreproducible bug would be worse than no change.
- [x] Re-run the failing test(s) to confirm they now pass — `go test ./internal/server/ -run TestLogPastIntake_AppearsInListHistory -v` passes (both `now` and `a_few_hours_ago` subtests); `npx vitest run web/static/js/tests/app.log-past-history.test.js` passes (2 tests). Both are committed as regression tests (ab3f886, f6ed437) and will catch any future regression.
- [x] Add or update unit tests adjacent to the fix if the root cause points at an untested store/handler branch — no root cause identified. The two new tests (server HTTP integration + frontend SWR cache) are themselves the value delivered by this plan: they close the previously uncovered "log-past then list-history" end-to-end gap noted in Context (line 18).

**Result:** No bug fix applied; the reported bug is not reproducible in the current codebase. The deliverables are the two regression tests added in Tasks 1 and 2, which now pin the correct behavior at both HTTP and frontend layers. The original report most likely reflected environment-specific cache state (stale SW `DYNAMIC_CACHE` entry superseded by a later network-first fetch, or a pre-SWR-overhaul cache that no longer exists). If the user can reproduce it again, they should capture the `DYNAMIC_CACHE` contents and `/api/changes` polling state at the moment of failure — that will make the next diagnosis tractable.

### Task 4: Verify acceptance criteria

- [ ] Run `go test ./...` and confirm all Go tests pass
- [ ] Run the frontend test suite (`npm test --prefix web/static` or the equivalent used by this project) and confirm all JS tests pass
- [ ] Run `go vet ./...` and the repo's linter, confirm clean
- [ ] Manually verify via the bug description: log a past intake, reload, confirm it appears in history (document the manual verification in the PR description, not here)

### Task 5: Update documentation

- [ ] No README or CLAUDE.md changes expected unless the fix changes a documented contract
- [ ] Move this plan to `docs/plans/completed/`
