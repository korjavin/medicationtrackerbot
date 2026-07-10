# Promote schedule exercises into the exercise library (both modes)

## Overview
Fix med-spp: after a user creates a workout group/variant with exercises, the
Workouts → Exercises tab (the exercise library) shows nothing. The Exercises tab
reads `GET /api/workout/exercise-library`, which lists only explicit
`exercise_library` rows. Plan/schedule exercises are separate `workout_exercises`
rows (Go) / `workoutexercise` records (cloud) and nothing promotes them into the
library. Bot mode and cloud mode behave identically — both are wrong.

**Fix (user-decided, NOT the FK refactor):** whenever a *plan exercise* is
created, upsert-by-name into the exercise library, seeding defaults from the plan
exercise's target sets/reps/weight. A library row with that name already existing
means no insert (dedupe). Do **not** add an `exercise_library_id` FK or reference
semantics — that is the separate P3 task med-prk.2. This is a create-time upsert
only.

Both implementations must stay contract-identical so `GET
/api/workout/exercise-library` returns the same entries after the same create
sequence in either mode.

## Context (from discovery)
- **Go store choke point:** `internal/store/workout/repo.go:359` `CreateExerciseInVariant`
  — a plain INSERT into `workout_exercises`. All create callers (HTTP handler
  `internal/server/workout_crud_handlers.go:139`, MCP, vault import) route through
  it, so the upsert belongs here, not in the handler. There is **no** domain-service
  create method (`internal/domain/workout/service.go` only does sessions/rotation/stats).
- **user_id resolution:** `CreateExerciseInVariant` only gets `variantID`. Resolve
  the owner via `GetVariant(variantID).GroupID` (repo.go:312) → `GetGroup(groupID).UserID`
  (repo.go:193).
- **Library table:** migration `028_add_exercise_library.sql` — columns
  `id, user_id, name, default_sets, default_reps_min, default_reps_max,
  default_weight_kg, notes, created_at, updated_at`; **unique index
  `idx_exercise_library_user_name(user_id, name)`**. Existing
  `CreateExerciseLibraryItem` (repo.go:594) is a plain INSERT that would violate
  this on a duplicate — the promotion needs a conflict-tolerant insert
  (`INSERT ... ON CONFLICT(user_id, name) DO NOTHING`).
- **List (backs the tab):** `ListExerciseLibrary` (repo.go:516) → handler
  `handleListExerciseLibrary` (workout_crud_handlers.go:236).
- **Field mapping is exact-parallel:** `name←exercise_name, default_sets←target_sets,
  default_reps_min←target_reps_min, default_reps_max←target_reps_max,
  default_weight_kg←target_weight_kg`.
- **Cloud site:** `web/domain/workout.js:455` `createExercise` writes a
  `workoutexercise` record and stops. `createLibraryItem` (workout.js:502) throws on
  a duplicate via `assertNoDuplicateLibraryName` — the promotion must *skip* an
  existing name, not throw. `listLibrary` (workout.js:555) backs the GET.
  `CLOUD_USER_ID = 1` (workout.js:108).
- **Tests:** Go store tests `internal/store/workout/workout_test.go` (`setupTestDB`);
  Go handler tests `internal/server/workout_handlers_exercise_test.go` (shared
  harness `testutil_test.go`). JS shim-contract test that already runs this exact
  CRUD: `web/static/js/tests/cloud.shim-contract.workout-crud.test.js`. No
  cross-language parity harness exists — parity is kept by mirrored assertions in
  each language.

## Development Approach
- NO unit tests. Two integration tests only, each guarding the real API contract
  (create plan exercise → it appears in the library list, in each mode).
- Do the Go path first (Task 1 + 2), fully passing, before the cloud path.
- Keep both modes' dedupe behavior identical to that mode's existing manual
  add-library-item path (so the promotion behaves exactly like the user having
  typed the same name into the library UI).
- No new migration — upsert into the existing `exercise_library` table.
- Small, focused diffs. Do not touch reference/FK semantics (med-prk.2).

## Testing Strategy
- **Unit tests:** none.
- **Integration tests:** two — one Go (httptest or store-level: create exercise →
  `ListExerciseLibrary`/`GET exercise-library` includes it; two same-name creates →
  one library row), one JS shim-contract (same sequence + dedupe) extending the
  existing workout-crud suite.
- **E2E tests:** none (no existing suite covers this flow).

## Progress Tracking
- Mark `[x]` immediately when done. ➕ for new tasks, ⚠️ for blockers.

## Implementation Steps

### Task 1: Go — promote plan exercise into the library on create
- [ ] add a conflict-tolerant library upsert in `internal/store/workout/repo.go`:
      a helper (e.g. `upsertLibraryFromPlanExercise(userID int64, ex *WorkoutExercise)`
      or inline) that runs `INSERT INTO exercise_library (user_id, name, default_sets,
      default_reps_min, default_reps_max, default_weight_kg, created_at, updated_at)
      VALUES (...) ON CONFLICT(user_id, name) DO NOTHING`, seeding defaults from the
      plan exercise's target fields.
- [ ] in `CreateExerciseInVariant` (repo.go:359), after the workout_exercises INSERT,
      resolve `user_id` via `GetVariant(variantID).GroupID` → `GetGroup(...).UserID`
      and call the upsert with the created exercise's name + targets.
- [ ] wrap the two writes so a library-upsert failure does not silently lose the
      exercise create (reuse the package's existing tx/error pattern; a failed upsert
      should surface, not corrupt the exercise insert).
- [ ] confirm `ListExerciseLibrary` (repo.go:516) now returns the promoted entry
      (no code change expected — verify it reads the same columns).

### Task 2: Go — integration test for library promotion + dedupe
- [ ] integration test (in `internal/store/workout/workout_test.go` or a handler-level
      test in `internal/server/workout_handlers_exercise_test.go`): create a group →
      variant → exercise, then assert the exercise-library list contains an entry with
      that name and matching defaults.
- [ ] dedupe case: create two plan exercises with the same name (same user) → exactly
      one library row for that name.
- [ ] run `go test ./internal/store/workout/... ./internal/server/...` — must pass.

### Task 3: Cloud — promote plan exercise into the library in web/domain/workout.js
- [ ] in `createExercise` (web/domain/workout.js:455), after `records.put` of the
      `workoutexercise` record, upsert an `exerciselibrary` record by name: if no
      non-deleted library record with that name exists (using the same case handling as
      the existing `assertNoDuplicateLibraryName` dedupe so behavior matches the manual
      add path), create one with `user_id: CLOUD_USER_ID` and defaults seeded from the
      exercise's target sets/reps/weight; if one exists, skip (do not throw).
- [ ] ensure the promoted record has the same shape `listLibrary` (workout.js:555)
      and the shim `exercise-library` GET expect, so it appears on the tab.

### Task 4: Cloud — shim-contract test for parity + dedupe
- [ ] extend `web/static/js/tests/cloud.shim-contract.workout-crud.test.js`: after the
      existing create-exercise sequence, assert the `exercise-library` list includes the
      created exercise's name with matching defaults (mirror of the Go assertion).
- [ ] dedupe case: two same-name exercise creates → one library entry.
- [ ] run `pnpm test` (at least the workout suites) — must pass.

### Task 5: Verify acceptance criteria
- [ ] `go build ./...` and `go build -tags mobile ./...` succeed.
- [ ] `go test ./...` passes.
- [ ] `pnpm test` passes.
- [ ] confirm the two modes return identical library entries for the same create
      sequence (the Go and JS assertions encode this).
- [ ] no new `window.*` globals, no hardcoded colors / inline `.style.` (frontend rules).

## Technical Details
- Library defaults on promotion: `default_sets = target_sets`,
  `default_reps_min = target_reps_min`, `default_reps_max = target_reps_max`,
  `default_weight_kg = target_weight_kg`, `notes` empty. Nullable target fields map to
  nullable defaults unchanged.
- Go dedupe is enforced by the existing unique index `(user_id, name)` +
  `ON CONFLICT DO NOTHING`. Cloud dedupe uses the module's existing name-uniqueness
  check. Both must match "the user already added a library item with this name".
- created_at/updated_at follow the table's existing unix-seconds convention (see how
  `CreateExerciseLibraryItem` sets them).

## Post-Completion
**Manual verification:** in cloud mode, create a group → variant → add an exercise →
open Workouts → Exercises; the exercise appears. Repeat in bot mode. No console errors.
