# Fix silent failure when un-marking a taken medication in History

## Overview

A user tried to "un-take" a medication from the **History** view (open a grouped
TAKEN intake → uncheck one med → **Update**). The med stayed `✅ Taken`, yet an
**"Updated!"** confirmation appeared. The pill was still in the box, so the user
expected it to revert to not-taken.

### What the investigation found

The revert flow is **functionally correct on current `master`** at every layer —
this was verified by reproductions:

- **Frontend payload** (`web/static/js/app.js:2556` `updateIntakeHistory`) — an
  unchecked med correctly produces `{id, status:'PENDING', taken_at:''}` (verified
  against the real modal + `PushModalState`).
- **Backend single + group persist** (`internal/server/medication_handlers.go:458`
  `handleUpdateIntake` + `internal/store/medication/repo.go:637` `UpdateIntake`) —
  the existing `TestHandleUpdateIntake` proves a single TAKEN→PENDING revert
  persists; a throwaway group test (one POST with a TAKEN re-confirm **and** a
  PENDING revert) also persisted correctly. The `tzStepPlanStatusGateForDedup`
  never blocks a TAKEN→PENDING transition (current status is TAKEN, so
  `status != 'PENDING'` is true).
- **End-to-end re-render** — driving the full round-trip in the jsdom harness
  flips the row from `✅ Taken` to `⏳ Pending`.

So the exact production trigger is **not reproducible from test data** — it is
almost certainly data-specific (a particular intake row / gate / constraint /
race we can't see). **But the reason the failure is invisible — and looks like
"Updated! but nothing changed" — is a real, fixable defect:**

> `handleUpdateIntake` always returns `200` with an **empty body** and `continue`s
> past **every** per-update error (`medication_handlers.go:504-512`, `:542`). The
> frontend treats any `200` as full success — it commits the optimistic flip and
> shows **"Updated!"** (`app.js:2630`). So whenever the backend fails to persist a
> revert for *any* reason, the user is told it worked, then the next refresh
> repaints the med back to `✅ Taken`.

### What this plan does (chosen approach: fix + diagnostics, regular testing)

1. **Make per-update outcomes explicit** — the handler returns a structured result
   (`updated` / `failed` / `failures[]`) and logs the *reason* each `UpdateIntake`
   failed (intake id, prev status, target status, source, tz_plan_id, error). The
   log lines are the **diagnostic** that will reveal the real production trigger.
2. **Stop lying to the user** — the frontend only shows "Updated!" + commits the
   optimistic flip when **all** updates succeeded; on any failure it rolls back the
   affected rows and surfaces an error naming the failed med(s).
3. **Close the test gaps** — add the missing Go group/multi-update revert test and
   the missing frontend end-to-end uncheck→update→re-render test.
4. **Production diagnosis** (post-completion, manual) — after deploy, inspect the
   user's actual `intake_log` row and watch the new failure logs via `prod-debug`.

## Context (from discovery)

- **Files/components involved:**
  - `internal/server/medication_handlers.go` — `handleUpdateIntake` (~line 458)
  - `internal/store/medication/repo.go` — `UpdateIntake` (~line 637), gate
    `tzStepPlanStatusGateForDedup` (~line 491)
  - `web/static/js/app.js` — `updateIntakeHistory` (~line 2556), optimistic
    helpers `_applyOptimisticHistoryFlip` / `_commitOptimistic` / `_rollbackOptimistic`
    (~line 2300-2407), `refreshMedsAfterMutation` (~line 1817)
  - `web/static/js/features/meds.js` — history render + cluster click →
    `showMedicationConfirmModal` (~line 458-481, 1245)
  - `web/static/js/core/api.js` — `apiCall` empty-body → `true` (~line 159-174)
- **Related patterns found:**
  - Domain-service / optimistic-write rules (CLAUDE.md #9): writes use
    `DataStore.applyOptimistic` with `commit(serverPayload)` / `rollback()`.
  - `commit(null)` keeps the optimistic value (only overwrites when the server
    payload `hasValue`) — `data-store.js:262-276`.
- **Existing tests:** `internal/server/medication_handlers_test.go`
  (`TestHandleUpdateIntake`, `TestHandleUpdateIntake_OrphanTZStepDoesNotDecrementInventory`);
  `web/static/js/tests/app.medication-history.test.js` (mocks the modal — does
  **not** exercise the update round-trip).

## Development Approach

- **Testing approach: Regular** (implement the behavior change, then add/extend
  tests in the same task).
- Complete each task fully before moving to the next; small, focused changes.
- **CRITICAL: every task includes new/updated tests** (success + error scenarios).
- **CRITICAL: all tests pass before starting the next task.**
- Backend changes go through the existing handler (no domain-service signature
  changes needed — `UpdateIntake` already returns typed errors).
- Frontend write path keeps using `DataStore.applyOptimistic` (CLAUDE.md #9) —
  we change *when* we commit vs roll back based on the new response body, we do
  **not** switch to `invalidateTags + loadX`.
- Use `log/slog` with contextual args (CLAUDE.md #5), not `log.Printf`.

## Testing Strategy

- **Unit/integration (Go):** `go test ./internal/server/...` and
  `go test ./internal/store/medication/...`.
- **Frontend (Vitest + jsdom):** extend the **owning** suite
  `web/static/js/tests/app.medication-history.test.js` (CLAUDE.md #8 — no new
  `*-branches`/`*-characterization` files). Reuse the per-key `loadSWR` routing
  pattern that proved out the end-to-end round-trip during investigation.
- No Playwright/Cypress E2E exists for this surface; jsdom harness is the
  integration entry point.

## Progress Tracking

- Mark completed items `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix; blockers with ⚠️ prefix.
- Keep this file in sync if scope changes.

## What Goes Where

- **Implementation Steps** (`[ ]`): handler + frontend code, Go tests, Vitest tests.
- **Post-Completion** (no checkboxes): production diagnosis on the user's real
  data, deploy verification — requires SSH/prod access and the user's record.

## Implementation Steps

### Task 1: Handler returns per-update outcomes + diagnostic logging
- [x] In `internal/server/medication_handlers.go` `handleUpdateIntake`, track per-update
      results in the loop: a counter `updated`, a slice `failures []struct{ID int64; Reason string}`.
- [x] On the ownership-skip path (`intake == nil || intake.UserID != userId`,
      ~line 482), record a failure with reason `"not_found_or_forbidden"` instead
      of a bare `continue`.
- [x] On the `UpdateIntake` error path (~line 504), classify the reason:
      `"no_row_matched"` for `errors.Is(err, sql.ErrNoRows)` (gate/no-op), else
      `"update_error"`; record the failure and `continue`.
- [x] Upgrade the failure log to `slog.Warn` carrying full diagnostic context:
      `intakeID`, `prevStatus` (`intake.Status`), `targetStatus` (`up.Status`),
      `source` (`intake.Source`), `tzPlanID` (`intake.TZPlanID`), and `error`.
      This is the line that will reveal the real production trigger.
- [x] On success, increment `updated`.
- [x] Replace the bare `w.WriteHeader(http.StatusOK)` with a JSON body:
      `{"updated": <n>, "failed": <len(failures)>, "failures": [{"id":..,"reason":..}]}`.
      Keep status `200` (frontend drives UX off the body; avoids breaking other callers).
      Set `Content-Type: application/json`.
- [x] write Go test: group revert (one POST = `{A:TAKEN, B:PENDING}` on two
      already-TAKEN intakes) → response body `updated:2, failed:0`, DB shows
      `A=TAKEN, B=PENDING` (success path with the new body).
- [x] write Go test: forced failure (orphan `tz_step` row whose plan is CANCELLED,
      reusing the setup in `TestHandleUpdateIntake_OrphanTZStepDoesNotDecrementInventory`)
      → response body reports `failed:1` with reason `"no_row_matched"`, and the
      row is unchanged (error/edge case).
- [x] run `go test ./internal/server/...` — must pass before Task 2.

### Task 2: Frontend surfaces failures instead of always showing "Updated!"
- [x] In `web/static/js/app.js` `updateIntakeHistory`, after `apiCall('/api/intakes/update', ...)`,
      interpret the response body: treat `res === true` (legacy empty body) **or**
      `res.failed === 0` as full success; treat `res.failed > 0` as partial/total failure.
- [x] Full success: keep current behavior — `_commitOptimistic(handles)`,
      `safeAlert("Updated!")`, `refreshMedsAfterMutation()`.
- [x] Failure: `_rollbackOptimistic(handles)` (restores prior cache + invalidates
      tags per CLAUDE.md #9), do **not** show "Updated!", and show an error naming
      the failed med(s) — map `res.failures[].id` back to med names via the modal's
      `ids`/`names`/`intakeIds`. Still call `refreshMedsAfterMutation()` so the list
      reflects authoritative server state.
- [x] Keep the network-error `catch` path (`_rollbackOptimistic` + throw) unchanged.
- [x] write Vitest test in `web/static/js/tests/app.medication-history.test.js`:
      handler stub returns `{updated:0, failed:1, failures:[{id:101, reason:'no_row_matched'}]}`
      → assert optimistic rollback happened, an error message was surfaced (spy on
      `safeAlert`/`Telegram.WebApp.showAlert`), and **no** "Updated!" toast.
- [x] write Vitest test: handler stub returns `{updated:1, failed:0}` → assert
      "Updated!" shown and commit path taken (success regression guard).
- [x] run `pnpm test` (the meds-history suite) — must pass before Task 3.

### Task 3: Add the missing end-to-end frontend revert test (happy path)
- [x] In `web/static/js/tests/app.medication-history.test.js`, add a case to the
      existing history `describe` block that drives the **real** flow with a
      per-key `loadSWR` mock: route `key==='medications'`→meds and
      `key.startsWith('history_')`→`options.fetcher()`, and a stateful `apiCall`
      that applies `/api/intakes/update` to an in-memory `serverLogs` and returns
      it for `/api/history`.
- [x] Scenario: 2-med TAKEN cluster → open edit modal via group click → uncheck
      the second med (id 101) → `updateIntakeHistory()` → after refresh assert the
      Magnesium row has `data-status="PENDING"` / renders `⏳ Pending`, and the
      Aspirin row stays `✅ Taken`. (This is the regression guard the codebase
      currently lacks — it is why a future break here would be silent.)
- [x] run `pnpm test` — must pass before Task 4.

### Task 4: Verify acceptance criteria
- [x] Re-read the Overview: confirm (a) handler reports per-update outcomes +
      logs reasons, (b) frontend no longer shows "Updated!" on failure, (c) group
      and end-to-end tests exist and pass.
      Confirmed: (a) `handleUpdateIntake` encodes `intakeUpdateResult{updated,
      failed, failures}` (medication_handlers.go:576) and logs each failure via
      `slog.Warn` with `intakeID`/`targetStatus`/`reason`/`error`; reasons are
      `not_found_or_forbidden`/`no_row_matched`/`update_error`. (b) app.js:2664-2680
      gates "Updated!" behind `failed === 0`; on `failed > 0` it `_rollbackOptimistic`
      + surfaces `_describeIntakeUpdateFailures(res.failures)` — no false "Updated!".
      (c) `TestHandleUpdateIntake_GroupRevertReportsOutcomes`,
      `TestHandleUpdateIntake_ForcedFailureReportsNoRowMatched`, and the e2e
      frontend revert test all pass.
- [x] run full backend suite: `go test ./...`. Plan-relevant packages pass
      (`internal/server`, `internal/store/medication`). The only failures are the
      pre-existing, date-dependent `TestAnalyzeFitness_*` in `internal/mcp`
      (fixed-date weight seeds 2026-03-10/15 fall outside the 90-day window from
      today 2026-06-07 → "got 1 weight log") — unrelated to this plan; the branch
      never touched `internal/mcp`.
- [x] run full frontend suite: `pnpm test`. 240 files, 2590 passed, 29 skipped.
- [x] run `go vet ./...` and the frontend architecture tests
      (`tests/architecture.*`) — must be clean. `go vet ./...` exits 0; all
      `architecture.*` suites pass.
- [x] confirm no new `window.*` globals were introduced (CLAUDE.md #4) and the
      write path still uses `applyOptimistic` (CLAUDE.md #9). `architecture.globals.test.js`
      passes (no new globals); `updateIntakeHistory` routes through
      `_applyOptimisticHistoryFlip` → `DataStore.applyOptimistic` with
      `_commitOptimistic`/`_rollbackOptimistic`.

### Task 5: [Final] Documentation
- [x] If the `/api/intakes/update` response shape is documented in `docs/api.md`,
      update it to describe the new `{updated, failed, failures}` body.
      The endpoint was not previously listed; added a Health Data row for
      `POST /api/intakes/update` documenting the request body, the always-200
      `{updated, failed, failures[]}` outcome body, the three failure reasons,
      the frontend commit-only-when-`failed===0` rule, and the legacy empty-body
      backward-compat note.
- [x] Add a short note to `docs/features.md` (meds/history section) that
      un-marking a taken med reverts it to `⏳ Pending`, and that partial failures
      are now surfaced rather than swallowed.
      Added an "Un-marking a taken med" bullet under Medication Tracking covering
      the `PENDING` revert → `⏳ Pending` flip, the per-update outcome body, and
      that failures now roll back + show an error naming the failed med(s) instead
      of a false "Updated!"; links to the api.md endpoint row.

## Technical Details

- **Response contract** (`POST /api/intakes/update`): still `200`; body becomes
  ```json
  { "updated": 2, "failed": 0, "failures": [] }
  ```
  On failure, e.g. `{ "updated": 1, "failed": 1, "failures": [ { "id": 101, "reason": "no_row_matched" } ] }`.
  Reasons: `"not_found_or_forbidden"`, `"no_row_matched"` (gate/no-op), `"update_error"`.
- **Backward compatibility:** the frontend treats a bare `true` (legacy empty
  body, e.g. during a rolling deploy) as success, so an old server + new client
  keeps working; a new server + old client ignores the body and behaves as today.
- **Inventory logic** (`DecrementInventory` revert at `medication_handlers.go:515`)
  is unchanged — it already runs only after a successful `UpdateIntake`.
- **Status code decision:** keep `200` rather than `207`/`409` to avoid the
  `apiCall` non-2xx path (`api.js:142` throws on `!res.ok`) and any reverse-proxy
  handling; the structured body is sufficient for the frontend to drive UX.

## Post-Completion
*Manual / external — no checkboxes.*

**Production diagnosis (the actual root-cause hunt):**
- After this ships, reproduce on the user's account and read the new
  `slog.Warn` lines from `handleUpdateIntake` to capture `prevStatus`, `source`,
  `tzPlanID`, and the `error`/`reason` for the failing med — this identifies the
  real trigger (gate, constraint, race, or stale row).
- Use the `prod-debug` skill to inspect the user's actual `intake_log` row(s) for
  the affected medication/slot (status, source, tz_plan_id, taken_at_unix, and any
  sibling rows at the same `scheduled_at_unix`).
- If the logs pinpoint a specific persistable bug (e.g. an unexpected gate block or
  a duplicate row), open a follow-up plan/PR for the targeted fix.

**Manual verification:**
- In the deployed app: take a grouped dose, then un-mark one med from History and
  confirm it now shows `⏳ Pending` (or, if it genuinely can't be reverted, that a
  clear error is shown instead of "Updated!").

## Out of scope (noticed during investigation, not addressed here)
- `internal/store/medication/repo.go:762` `ListIntakeHistory(medID, days)` takes
  **no `user_id`** and `handleListHistory` (`server.go:1010`) passes none — worth a
  separate look for multi-user/demo deployments, but unrelated to this revert bug.
