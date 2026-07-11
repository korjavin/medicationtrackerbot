# Exercise library by reference (med-prk.2)

## Overview
Make `exercise_library` the single source of truth for exercise names. Today `workout_exercises` stores a **copy** of the name (`exercise_name`), so renaming a library exercise changes nothing in plans/history — duplicates, not links. This change adds a reference (`exercise_library_id`) from each plan exercise to its library row, resolves the display name **through** that reference, and does it in **both modes in lockstep** (Go server + cloud `web/domain/workout.js`).

Deliberate, user-visible side effect: **renaming a library exercise renames it in plans and history too** — a link is a link. Surface this in the library edit UI copy.

Closes med-spp as a byproduct (the Exercises tab / library becomes the canonical set by construction).

## Context (from discovery)
- **Go write path**: `internal/store/workout/repo.go` — `CreateExerciseInVariant` (`repo.go:359-406`) already does a two-table write in a `WithTx`: inserts `workout_exercises`, then `INSERT INTO exercise_library ... ON CONFLICT(user_id,name) DO NOTHING` (`repo.go:394-398`). `UpdateExercise` (`repo.go:464-471`) updates `exercise_name`. **This upsert is the seam** — after it, `SELECT id FROM exercise_library WHERE user_id=? AND name=?` gives the FK (ON CONFLICT DO NOTHING returns no id).
- **Go read path**: `ListExercisesByVariant` (`repo.go:408-437`), `GetExercise` (`repo.go:439-462`). Resolve canonical name via LEFT JOIN to `exercise_library`.
- **Handlers** call the store **directly** (no domain service for plan-exercise CRUD): `internal/server/workout_crud_handlers.go` — `handleCreateExercise` (`:139`), `handleUpdateExercise` (`:177`), `handleListExercisesByVariant` (`:119`). Request/response structs at `:140-148`, `:185-192`.
- **Migrations**: highest is `075_weight_goals_nullable_date.sql` → new migration is **`076`**. `exercise_library` has `UNIQUE(user_id,name)` (idx, migration 028:15); `workout_exercises` has **no** unique constraint (012:26-36).
- **Cloud**: `web/domain/workout.js` — `createExercise` (`:455-477`) → `promoteExerciseToLibrary` (`:482-503`, the JS mirror of the Go upsert), `updateExercise` (`:511-524`), `listExercises` (`:505-509`), `toExerciseResponse` (`:162-174`), record types `WORKOUT_RECORD_TYPES` (`:40-43`: `EXERCISE:'workoutexercise'`, `LIBRARY:'exerciselibrary'`). Shim routing `web/cloud/js/apishim.js:525-563`.
- **One-time vault migration**: no existing per-record migrator. Mirror the full-vault import pattern — `web/cloud/js/cloud-boot.js:116-150` (`markForceSnapshotPending → dropPendingForTypes → replaceAllRecords → forceSnapshot`), primitives in `web/cloud/js/sync.js`. Hook after unlock near `cloud-boot.js:~96`.
- **Parity harness**: `web/cloud/js/tests/mcp-responder.test.js` (uses `createApiRouter` + `createInMemoryRecordsPort` from `web/static/js/tests/helpers/cloud-shim-harness.js`); real-frontend-through-shim style in `web/static/js/tests/cloud.shim-contract.*.test.js`. Go handler tests: `internal/server/workout_handlers_exercise_test.go`.

## Development Approach
- **Testing approach**: NO unit tests. The one integration test that adds a real guarantee is the **contract-parity test** the bead explicitly requires (create / duplicate-name / rename sequence → identical library + plan-exercise behavior across Go and the shim). That guards a genuine cross-mode contract boundary — include it. No other new test scaffolding.
- **Backward compatible & additive**: `exercise_library_id` is **nullable**; keep the existing `exercise_name` column as a denormalized cache (it's read across logs/history — dropping it is needless blast radius). Reads resolve the canonical name via the FK, falling back to the cached `exercise_name` when the FK is null.
- Any `/api` response-shape change lands in Go **and** `web/domain/workout.js` together.
- Complete each task fully (build + existing tests green) before the next.
- **CRITICAL: if a task adds the integration test, it must pass before the next task.**
- **CRITICAL: update this plan file if scope changes during implementation.**

## Testing Strategy
- **Unit tests**: none.
- **Integration tests**: exactly one — the cross-mode contract-parity test (Task 6). Extend the existing Go `workout_handlers_exercise_test.go` and the shim `mcp-responder.test.js`/parity harness; do not stand up new infrastructure.
- **E2E**: none (no relevant existing suite to reuse).

## Progress Tracking
- Mark `[x]` immediately when an item is done.
- ➕ prefix for newly discovered tasks; ⚠️ prefix for blockers.
- Keep this file in sync with actual work.

## What Goes Where
- Implementation Steps (`[ ]`) = code + migration + the one parity test.
- Post-Completion (no checkboxes) = manual cloud-vault migration smoke, med-spp closure note.

## Implementation Steps

### Task 1: Migration 076 — add `exercise_library_id` FK + backfill
- [x] create `internal/store/migrations/076_workout_exercise_library_ref.sql` (goose Up/Down)
- [x] Up: `ALTER TABLE workout_exercises ADD COLUMN exercise_library_id INTEGER REFERENCES exercise_library(id)` (nullable; SQLite adds nullable columns without table rebuild)
- [x] Up backfill: for each `workout_exercises` row, ensure a library row exists for its owner+name (`INSERT INTO exercise_library(user_id,name,default_sets,default_reps_min,default_reps_max,default_weight_kg) SELECT ... ON CONFLICT(user_id,name) DO NOTHING`, owner resolved via `variant → group.user_id`), then `UPDATE workout_exercises SET exercise_library_id = (SELECT el.id FROM exercise_library el JOIN workout_variants wv ON ... JOIN workout_groups wg ON ... WHERE el.user_id=wg.user_id AND el.name=workout_exercises.exercise_name)`
- [x] Down: `DROP` the column (verified modernc SQLite 3.50.4 allows `ALTER TABLE ... DROP COLUMN` even with the inline FK, since FK enforcement is off — no table rebuild needed)
- [x] `go build ./...` and confirm migration runs on a fresh DB (existing migration test / `go test ./internal/store/...`)

### Task 2: Go store — write FK on create/update
- [x] `CreateExerciseInVariant` (`repo.go:359-406`): after the `ON CONFLICT DO NOTHING` library upsert, `SELECT id FROM exercise_library WHERE user_id=? AND name=?` and set `exercise_library_id` on the just-inserted `workout_exercises` row (all inside the existing `WithTx`)
- [x] `UpdateExercise` (`repo.go:464-471`): when the name changes, run the same upsert-by-name into `exercise_library` for the owning user and set `exercise_library_id` alongside `exercise_name`
- [x] add `ExerciseLibraryID *int64` (nullable) to the exercise row struct returned by the store

### Task 3: Go store — resolve canonical name on read
- [x] `ListExercisesByVariant` (`repo.go:408-437`) and `GetExercise` (`repo.go:439-462`): `LEFT JOIN exercise_library el ON el.id = workout_exercises.exercise_library_id`, select `COALESCE(el.name, workout_exercises.exercise_name) AS exercise_name`, and also return `exercise_library_id`
- [x] confirm rename propagation: updating a library row's `name` changes what these reads return (by construction — reads COALESCE to `el.name` via the FK; the dedicated parity test lands in Task 6)

### Task 4: Go handlers — expose `exercise_library_id` in the API
- [ ] `internal/server/workout_crud_handlers.go`: include `exercise_library_id` in the create/update/list exercise JSON responses (structs at `:140-148`, `:185-192`, and the list mapper)
- [ ] no new route is added (fields only) → MCP coverage guard unaffected; **but** if `/api/workout/exercises*` is a registry op with a `ResponseExample`, update the example and run `go run ./cmd/genmcpcatalog` + commit (per CLAUDE.md); otherwise note "no registry op touched"

### Task 5: Cloud — mirror reference + resolve-on-read in `web/domain/workout.js`
- [ ] `promoteExerciseToLibrary` (`:482-503`): return the (existing or new) `exerciselibrary` record's numeric id
- [ ] `createExercise` (`:455-477`) and `updateExercise` (`:511-524`): store `exercise_library_id` on the `workoutexercise` record (upsert-by-name, dedupe via `assertNoDuplicateLibraryName`/the non-deleted-name lookup at `:486`)
- [ ] `toExerciseResponse` (`:162-174`): resolve `exercise_name` from the referenced `exerciselibrary` record when the id is set (fallback to stored name), and include `exercise_library_id` — matching the Go JSON shape exactly

### Task 6: Cloud — one-time vault migration + the contract-parity test
- [ ] add a one-time, idempotent boot migration (after unlock, `web/cloud/js/cloud-boot.js` near `:96`) that backfills `exerciselibrary` records from distinct `workoutexercise` names and sets `exercise_library_id` refs, landing via the `importAll` snapshot shape (`markForceSnapshotPending → dropPendingForTypes(['workoutexercise','exerciselibrary']) → replaceAllRecords → forceSnapshot`); guard so it runs at most once (skip if every non-deleted `workoutexercise` already has a ref)
- [ ] **integration test (real boundary — required by the bead)**: same sequence on both sides — create plan exercise "Bench", create another "Bench" (dedupe), rename library "Bench"→"Bench Press" — assert (a) exactly **one** library row, (b) the plan-exercise read now returns "Bench Press". Add it to the shim side via `web/cloud/js/tests/mcp-responder.test.js` (or the `cloud-shim-harness.js` parity harness) and mirror the same assertions in Go `internal/server/workout_handlers_exercise_test.go`. Must pass before Task 7.

### Task 7: UI copy — surface the rename-propagates behavior
- [ ] in the library edit modal (`web/static/js/features/workout/library.js`), add a short note that renaming updates the exercise everywhere it's used (plans + history)

### Task 8: Verify acceptance criteria
- [ ] `go build ./...` (server) and `go build -tags mobile ./...` (mobile build still compiles)
- [ ] `go test ./...` — all pass
- [ ] `pnpm test` — all pass, **including** the repo-wide `tests/architecture.*.test.js` (feature-suite green ≠ CI green — run the full suite)
- [ ] migration number contiguity: `076` is the sole new migration, no gaps
- [ ] if a registry `ResponseExample` changed: `internal/mcp/catalogjs/drift_test.go` and MCP coverage tests pass; cloud catalog regenerated
- [ ] verify the dedupe + rename acceptance criteria from Overview are satisfied by the Task 6 test

### Task 9: [Final] Update docs
- [ ] note the new reference model in `docs/features.md` (workouts) if it documents the exercise/library relationship
- [ ] leave a one-line pointer that med-spp is closed by this change

## Technical Details
- Name resolution SQL (read): `SELECT we.id, we.variant_id, COALESCE(el.name, we.exercise_name) AS exercise_name, we.target_sets, we.target_reps_min, we.target_reps_max, we.target_weight_kg, we.order_index, we.exercise_library_id FROM workout_exercises we LEFT JOIN exercise_library el ON el.id = we.exercise_library_id WHERE we.variant_id = ? ORDER BY we.order_index ASC`.
- Dedupe guarantee: `exercise_library(user_id,name)` UNIQUE + `ON CONFLICT DO NOTHING` upsert → "same name twice = one library row" holds on both create paths.
- Cloud id parity: cloud mints synthetic numeric ids (`mintNumericId`, workout.js) — store that numeric id in `exercise_library_id` so the JSON shape matches the Go autoincrement id.
- Keep `exercise_name` populated on write (cache) so null-FK rows and existing logs/history keep working unchanged.

## Post-Completion
*No checkboxes — manual/external.*

**Manual verification:**
- Cloud: unlock an existing vault that has pre-migration `workoutexercise` records; confirm the one-time migration backfills library refs once, a snapshot is written, and a subsequent reload does not re-run it.
- Rename an exercise in the library UI (both modes); confirm the new name shows in existing plans and in past session history.

**Issue tracker:**
- On merge, close med-prk.2 and note med-spp is resolved by construction (library = canonical set).
