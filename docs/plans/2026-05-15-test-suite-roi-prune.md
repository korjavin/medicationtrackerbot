# Go test suite ROI prune and notifier-test consolidation

## Overview

Two-category cleanup of the 171-file / ~55k-LOC Go test suite to remove maintenance overhead that does not earn its keep. Category 1 deletes test code that catches zero real regressions: bench files with no CI gate, mock-spy assertions in domain tests that re-prove what the handler tests already prove against the real store, and tautological operation-list tests in the MCP registry. Category 2 consolidates `internal/scheduler/notifier_test.go` (1155 LOC) into table-driven cases with shared fixture, keeping its async semantics. No production code changes; full suite must remain green at every task boundary.

## Context (from discovery)

- 171 `*_test.go` files, ~55k LOC, ~80s aggregate runtime. No throughput / CI-time problem to solve.
- Files involved:
  - **Category 1 deletes:**
    - 7 bench files: `internal/scheduler/medication_bench_test.go`, `bp_reminders_bench_test.go`, `weight_reminders_bench_test.go`, `workout_bench_test.go`, `low_stock_bench_test.go`; `internal/store/store_bench_test.go`; `internal/store/workout/miband_bench_test.go` (~435 LOC).
    - `internal/domain/medication_test.go` (970 LOC, 7 tests) — every test uses a hand-rolled mock store that records `lastConfirmedID`, `lastDeletedIntakeID`, `deleteIntakeCalled`, etc. Assertions are spy-style: `if mock.lastConfirmedID != wantID`.
    - `internal/domain/exercise_test.go` (797 LOC, 27 tests) — same pattern; 24 of 27 are error-path branch coverage against mocked store errors.
    - `internal/mcp/registry/registry_test.go` — 4 tests (`TestWorkoutOperations`, `TestFoodOperations`, `TestHealthOperations`, `TestMedicationOperations`, lines 357–750, ~390 LOC) loop hardcoded string IDs and assert `r.Get(id) != nil`. The registry literally lists those operations; the tests assert the registry lists what it lists.
  - **Category 1 keep / consolidate target (replaces what we delete):**
    - `internal/server/server_handlers_test.go` — already covers `TestHandleConfirmSchedule_*`, `TestHandleStartWorkoutSession`, etc. against the real store. Migrate any unique externally-observable assertion here before deleting a domain test.
  - **Category 2 refactor:**
    - `internal/scheduler/notifier_test.go` (1155 LOC, 24 tests) — recording `mockNotifier` with `waitForSendCalls(n, timeout)` poll loops because the scheduler is async. Many tests duplicate the same fixture: open store, create med, set TZ, run scheduler, wait on mock.
- Related patterns found:
  - **Domain service pattern is mandatory** (CLAUDE.md rule 1) — that does NOT require domain-level unit tests; the contract is "bot and HTTP share the same code path." Handler-level tests against the real store satisfy that contract.
  - Store-layer tests (e.g., `internal/store/medication/medication_test.go`) catch SQLite edge cases that handlers do not exercise — UPSERT-WHERE-NULL, RowsAffected on conflict skip, COALESCE semantics (see memory `gotchas_sqlite_upsert_*`). Do NOT touch store tests in this plan.
  - `mockCoverageExempt` enforcement (CLAUDE.md rule + `internal/server/mcp_coverage_exempt.go`) is unaffected by anything in this plan.
- Dependencies identified:
  - Removing `internal/domain/*_test.go` files removes the only consumer of any private helpers that exist only for tests; spot-check that the production code in `internal/domain/medication.go` / `exercise.go` still compiles after deletion (it will — services do not call into their own test helpers).
  - Bench files: grep confirms no `.github/workflows/*.yml`, no `Makefile`, no `go test -bench` references. Safe to delete.

## Development Approach

- **Testing approach**: Regular (not TDD). This work is test-deletion / consolidation; new tests are written only in Task 4 (refactor target). The verification step for every other task is "full suite still passes."
- Complete each task fully before moving to the next.
- Each deletion task is a single commit. The plan is structured so a partial revert is possible if a deletion turns out to remove non-duplicate coverage.
- After each task: `go test ./...` must pass. If a delete causes a test failure elsewhere, the failing test is asserting something the deleted file did NOT in fact duplicate — investigate and migrate the missing assertion to a handler test before re-deleting.
- **CRITICAL: every code-changing task includes the verification step.** For deletion tasks the verification IS the test (run the suite). For Task 4 the new table-driven tests must cover every `it()`-equivalent from the original `notifier_test.go`.
- **CRITICAL: all tests must pass before starting next task.** No exceptions.
- **CRITICAL: update this plan file when scope changes during implementation** — e.g., if a "delete" turns into "migrate then delete," record which assertion moved where.

## Testing Strategy

- **Unit tests**: This project's Go tests run via `go test ./...`. There is no separate unit/integration split — the same command runs both.
- **E2E tests**: None at the Go level. Frontend has Vitest tests under `web/static/js/tests/`; this plan does not touch them. Run `pnpm test` once at the final verification step to confirm nothing in the frontend depends on a Go test artifact (it shouldn't, but cheap to verify).
- **Coverage gate**: do NOT chase a coverage percentage. The point of this plan is to remove coverage that comes from low-signal tests. Measure coverage before/after for the record, but a small drop is expected and acceptable.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.
- If a "delete" task discovers a non-duplicate assertion, record the migration target (which handler test received it) inline as a `➕ migrated assertion: X → server_handlers_test.go:Y` line.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): file deletions, test consolidations, suite runs.
- **Post-Completion** (no checkboxes): record the LOC delta in the PR description; optionally circulate a one-paragraph "testing posture" summary for `docs/architecture.md` (out of scope for this plan).

## Implementation Steps

### Task 1: Delete bench files with no CI gate

**Rationale:** seven `*_bench_test.go` files exist in `internal/scheduler/`, `internal/store/`, and `internal/store/workout/`. Grep across `.github/workflows/`, root, and `Makefile*` confirms nothing runs `go test -bench` or `go test ... -run Benchmark`. They are runnable documentation, not regression protection — the perf fixes in git log (`6b66ef6d`, `e786390d`, `e1cbfecb`) were driven by profiling, not by these benches failing.

**Files:**
- Delete: `internal/scheduler/medication_bench_test.go`
- Delete: `internal/scheduler/bp_reminders_bench_test.go`
- Delete: `internal/scheduler/weight_reminders_bench_test.go`
- Delete: `internal/scheduler/workout_bench_test.go`
- Delete: `internal/scheduler/low_stock_bench_test.go`
- Delete: `internal/store/store_bench_test.go`
- Delete: `internal/store/workout/miband_bench_test.go`

Steps:
- [x] re-grep one more time at execution to confirm zero references: `git grep -nE 'go test.*-bench|Benchmark[A-Z]' .github/ Makefile* docs/ scripts/ 2>/dev/null` — expected empty
- [x] delete the 7 files in a single commit
- [x] run `go test ./...` — must pass
- [x] record LOC removed (expect ~435) — actual: 435 LOC removed

### Task 2: Trim tautological operation-list tests in MCP registry

**Rationale:** `internal/mcp/registry/registry_test.go` contains four tests (`TestWorkoutOperations`, `TestFoodOperations`, `TestHealthOperations`, `TestMedicationOperations`) that iterate over hardcoded string IDs and assert each is registered. The registry is built from `operations_*.go` files that literally list those same IDs — the tests assert "the data file lists what the data file lists." The actual behaviors (registration validation, duplicate-ID detection, path-param matching, topic ordering, help marshalling) are covered by other tests in the same file.

**Files:**
- Modify: `internal/mcp/registry/registry_test.go`

Steps:
- [x] delete `TestWorkoutOperations` (lines 357–496 in current file)
- [x] delete `TestFoodOperations` (lines 497–566)
- [x] delete `TestHealthOperations` (lines 567–663)
- [x] delete `TestMedicationOperations` (lines 664–750)
- [x] keep all other tests in the file (`TestRegister_Validation`, `TestRegister_DuplicateID`, `TestGet`, `TestByTopic`, `TestAll`, `TestNormalization`, `TestTopics_Order`, `TestMarshalForHelp_Examples`, `TestMarshalForHelp_Shape`, `TestDefaultOperations`, `TestRegister_PathParamsMustMatchPlaceholders`, `TestSubstitutePath`) — these test actual logic
- [x] verify `TestDefaultOperations` (line 751) still provides a basic "all operations register cleanly" smoke; if it does not, add a single-assertion smoke test that loads the default registry and asserts `len(r.All()) > 0` and no duplicate IDs returned — confirmed: TestDefaultOperations registers all ops, runs `uniqueIDs`, runs `schemasParse`, checks all 4 topics populated, checks every op has description + response_summary, and validates MarshalForHelp output
- [x] run `go test ./internal/mcp/registry/...` — must pass
- [x] run `go test ./...` — must pass (registry: 360 LOC removed; file 904 → 544)

### Task 3: Delete domain mock-spy tests, migrating any unique assertions to handler tests

**Rationale:** `internal/domain/medication_test.go` (970 LOC, 7 tests) and `internal/domain/exercise_test.go` (797 LOC, 27 tests) use hand-rolled mock stores that record call args (`lastConfirmedID`, `logExerciseCalls[...]`, `updateExerciseLogCalls[...]`) and assert on those call records. This pins implementation, not behavior — every refactor that changes the relay path breaks the tests without indicating a real bug. The same business logic is exercised end-to-end against the real store in `internal/server/server_handlers_test.go` (`TestHandleConfirmSchedule_*`, `TestHandleStartWorkoutSession`, `TestHandleLogExercise`, etc.).

**Files:**
- Delete: `internal/domain/medication_test.go`
- Delete: `internal/domain/exercise_test.go`

Steps:
- [x] for each `func Test*` in `medication_test.go` (7 functions: `TestCancelIntake`, `TestConfirmIntakeWithCleanup`, `TestSkipIntake`, `TestLogMedicationNow`, `TestConfirmScheduleWithCleanup`, `TestConfirmMedicationByMedID`, `TestDeleteFutureIntake`):
  - find the corresponding handler test in `internal/server/` (`grep -rn "TestHandle.*Intake\|TestHandle.*Confirm\|TestHandle.*Skip\|TestHandle.*LogMed"`)
  - confirm the handler test asserts the same externally-observable outcome (DB row state, HTTP response code, response JSON). Spy-on-mock assertions do NOT need to be preserved.
  - if a unique externally-observable assertion exists ONLY in the domain test (rare), migrate it to the matching handler test as a new `t.Run("<scenario>", ...)` case — DO NOT recreate a mock store at the handler level
  - confirmed coverage exists in: `cancel_intake_handler_test.go` (TestHandleCancelIntake_*), `delete_intake_handler_test.go` (TestHandleDeleteFutureIntake_*), `server_handlers_test.go` (TestHandleConfirmSchedule_*, TestHandleLogPastIntake), `medication_handlers_test.go` (TestHandleSkipMedication), `trigger_next_intake_test.go` (TestHandleTriggerNextIntake_*). No unique externally-observable assertion needed migration.
- [x] for each `func Test*` in `exercise_test.go` (27 functions): same protocol. Likely outcomes:
  - the 3 happy-path tests (`TestLogExercise_NewLog`, `TestCheckSessionCompletion_AllDone`, `TestLogExercise_LibraryItem_NewLog`) — confirm coverage exists in `server_handlers_test.go` workout-session tests; migrate one assertion if needed — already covered by `workout_new_test.go` `TestExerciseDone_CreatesLog`, `TestExerciseSkip_CreatesLogAsSkipped`, `TestExerciseDone_ExistingSkippedLogBecomesCompleted` (bot path against real store)
  - the ~20 error-path tests (`TestLogExercise_StoreError`, `TestLogExercise_GetLogError`, etc.) — these mock a store error and assert the error is returned. Delete; the production error paths are simple `return err` and the value lies in real failures, not synthetic ones — deleted
  - the ID-collision / library-item differentiation tests (`TestLogExercise_IDCollision_FallsThruToLibrary`, `TestLogExercise_SameVariant_UsesWorkoutExercise`) — these encode a non-obvious resolution rule; migrate them to handler-level tests against the real store — migrated assertions: `TestExerciseDone_VariantMismatch_FallsThruToLibrary` and `TestExerciseDone_SameVariant_UsesWorkoutExercise` in `internal/bot/workout_new_test.go`, exercising `exerciseSvc.LogExercise` end-to-end through the bot callback against a real SQLite store (with a best-effort id-collision loop and t.Skipf fallback)
- [x] delete both files
- [x] run `go test ./internal/domain/...` — must pass (the package may have other test files that should remain) — pass (0.045s)
- [x] run `go test ./internal/server/...` — must pass (handler tests + any migrated assertions) — pass (16.351s)
- [x] run `go test ./...` — must pass — full suite green
- [x] record LOC removed and assertions migrated in the PR description — 970 + 797 = 1767 LOC removed; ~170 LOC of migrated integration tests added in `internal/bot/workout_new_test.go` (net ≈ 1600 LOC removed)

### Task 4: Consolidate `internal/scheduler/notifier_test.go` to table-driven

**Rationale:** the file is 1155 LOC with 24 tests, each repeating the `setupTestSchedulerWithMock` → seed-DB → run-scheduler → `waitForSendCalls(N, timeout)` pattern. The recording mock and the wait loops are correct for async scheduler tests and must stay. The savings come from (a) grouping related scenarios into table-driven `t.Run` cases under a single fixture, (b) extracting shared seed helpers into the existing `helpers_test.go`, and (c) deleting any test whose only assertion duplicates another test in the same file (spot-check needed).

**Files:**
- Modify: `internal/scheduler/notifier_test.go`
- Modify: `internal/scheduler/helpers_test.go` (extract seed helpers if needed)

Steps:
- [ ] read all 24 `Test*` functions and group them by scenario family (e.g., "send on schedule", "snooze handling", "delete on dismiss", "low-stock notification", "TZ-aware send"). Expect 4–6 families.
- [ ] for each family, write one table-driven `Test<Family>(t *testing.T)` that:
  - sets up the scheduler + DB once (or once per row if seed differs materially)
  - iterates `[]struct{name string; seed func(t,db); want sendCalls/deleteCalls assertion}`
  - uses the existing `waitForSendCalls` / `waitForDeleteCalls` for async assertions — DO NOT replace these with `time.Sleep`
  - preserves every externally-observable assertion from the source tests
- [ ] delete the original 24 `Test*` functions as each family's replacement passes
- [ ] keep `mockNotifier`, `setupTestSchedulerWithMock`, and the `waitFor*` helpers — they are correct
- [ ] write tests for any case that was an isolated `Test*` and does not fit any family (likely 1–3 edge cases) — keep these as standalone tests
- [ ] run `go test ./internal/scheduler/... -count=1 -run TestNotif` — must pass with same number of t.Run cases as the original test count (24)
- [ ] run `go test ./internal/scheduler/... -count=3` — must pass three times in a row (catches flakiness introduced by the consolidation)
- [ ] run `go test ./...` — must pass
- [ ] target reduction: ~30–40% (≈ 350–450 LOC). If reduction is < 200 LOC, the refactor is not earning its keep — revert and leave the file alone

### Task 5: Verify acceptance criteria

- [ ] run `go test ./... -count=1` — full suite passes
- [ ] run `go test ./... -count=1 -race` — race detector clean
- [ ] run `pnpm test` — frontend suite passes (sanity; should be untouched)
- [ ] confirm `go test ./... -cover` percentage delta is reported in PR description (expect a small drop — that is the point)
- [ ] confirm `find . -name '*_bench_test.go' -not -path './node_modules/*' -not -path './.git/*' | wc -l` returns 0
- [ ] confirm `git grep -nE 'TestWorkoutOperations|TestFoodOperations|TestHealthOperations|TestMedicationOperations' internal/mcp/registry/` returns no matches
- [ ] confirm `ls internal/domain/medication_test.go internal/domain/exercise_test.go 2>&1` returns "No such file"
- [ ] confirm `wc -l internal/scheduler/notifier_test.go` is < 800 (if Task 4 ran) OR unchanged at 1155 (if Task 4 was reverted)
- [ ] verify no compilation errors via `go build ./...`
- [ ] verify `go vet ./...` is clean
- [ ] record final LOC delta in PR description: target ≈ 2200–2800 LOC removed across all 4 tasks combined

### Task 6: Update documentation

- [ ] no CLAUDE.md change required — the domain-service rule is a *production code* rule, not a "must have unit tests with mocks" rule. Confirm this by re-reading the rule and verifying it still reads correctly after the deletions.
- [ ] no `docs/architecture.md` change unless we want to document the testing posture explicitly. If documenting: append a short paragraph stating "domain services are tested end-to-end via handler tests against the real store; package-level domain mock-spy tests are not added." Decide at execution time; skip if redundant with the deletions themselves.

*Note: ralphex automatically moves completed plans to `docs/plans/completed/`*

## Technical Details

- **Bench files**: pure deletions, no replacement. The relevant N+1 query fix in `BPReminderChecker` (commit `6b66ef6d`) does not depend on the bench file existing.
- **Registry list-mirror tests**: deletions only. `TestDefaultOperations` (kept) already smoke-tests that the default registry builds without panic; that is sufficient.
- **Domain mock-spy tests**: deletions, possibly with 0–3 assertion migrations to `internal/server/server_handlers_test.go`. Each migration is a new `t.Run("<scenario>", ...)` block, not a new file.
- **Notifier consolidation**: structural refactor inside one file. `mockNotifier`, the wait loops, and `setupTestSchedulerWithMock` are correct and must be preserved — they encode the async contract of the scheduler. The cuts come from collapsing per-scenario `Test*` functions into table rows under shared fixtures.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only*

**Reporting:**
- PR description must include: total LOC removed, test count before/after, coverage % before/after (informational, not a gate), and a one-line note that "domain-layer mock-spy coverage was retired in favor of handler-level end-to-end tests against the real store."

**Watch for regressions (manual, post-merge):**
- Over the next 2–4 weeks, watch the CI failure log for any handler-level test that newly catches a bug a deleted domain test would have caught. If that happens (it should not — handler tests already exercise these paths), recover the relevant scenario as a handler-level test, NOT by recreating the domain mock-spy test.

**Out of scope (do not do in this plan):**
- Touching store-layer tests (`internal/store/*/*_test.go`). These catch SQL/migration gotchas — see project memory entries on SQLite UPSERT semantics. Defer.
- Touching MCP tools tests (`internal/mcp/tools_test.go`, 1317 LOC). Refactor candidate but separate plan.
- Adding a CI bench-tracking system. If perf regressions become a concern, file a separate plan for benchstat-based gating.
