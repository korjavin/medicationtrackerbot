# Promote schedule exercises into the exercise library (cloud mode)

## Overview
Fix med-spp: after a user creates a workout group/variant with exercises, the
Workouts → Exercises tab (the exercise library) shows nothing. The Exercises tab
reads `GET /api/workout/exercise-library`, which lists only explicit
`exercise_library` rows. Plan/schedule exercises are separate `workoutexercise`
records and nothing promotes them into the library.

**Fix (user-decided, NOT the FK refactor):** whenever a *plan exercise* is
created, upsert-by-name into the exercise library, seeding defaults from the plan
exercise's target sets/reps/weight. A library row with that name already existing
means no insert (dedupe). Do **not** add an `exercise_library_id` FK or reference
semantics — that is the separate P3 task med-prk.2. This is a create-time upsert
only.

## Context (from discovery)
- **Cloud site:** `web/domain/workout.js:455` `createExercise` writes a
  `workoutexercise` record and stops. `createLibraryItem` (workout.js:502) throws on
  a duplicate via `assertNoDuplicateLibraryName` — the promotion must *skip* an
  existing name, not throw. `listLibrary` (workout.js:555) backs the GET.
  `CLOUD_USER_ID = 1` (workout.js:108).
- **Tests:** JS shim-contract test that already runs this exact CRUD:
  `web/static/js/tests/cloud.shim-contract.workout-crud.test.js`.

## Development Approach
- NO unit tests. One integration test guarding the real API contract
  (create plan exercise → it appears in the library list).
- Keep the promotion's dedupe behavior identical to the existing manual
  add-library-item path (so the promotion behaves exactly like the user having
  typed the same name into the library UI).
- No new record type — upsert into the existing `exerciselibrary` records.
- Small, focused diffs. Do not touch reference/FK semantics (med-prk.2).

## Testing Strategy
- **Unit tests:** none.
- **Integration tests:** one — a JS shim-contract test (create plan exercise → it
  appears in the library list; two same-name creates → one library entry)
  extending the existing workout-crud suite.
- **E2E tests:** none (no existing suite covers this flow).

## Progress Tracking
- Mark `[x]` immediately when done. ➕ for new tasks, ⚠️ for blockers.

## Implementation Steps

### Task 1: Promote plan exercise into the library in web/domain/workout.js
- [ ] in `createExercise` (web/domain/workout.js:455), after `records.put` of the
      `workoutexercise` record, upsert an `exerciselibrary` record by name: if no
      non-deleted library record with that name exists (using the same case handling as
      the existing `assertNoDuplicateLibraryName` dedupe so behavior matches the manual
      add path), create one with `user_id: CLOUD_USER_ID` and defaults seeded from the
      exercise's target sets/reps/weight; if one exists, skip (do not throw).
- [ ] ensure the promoted record has the same shape `listLibrary` (workout.js:555)
      and the shim `exercise-library` GET expect, so it appears on the tab.

### Task 2: Shim-contract test for promotion + dedupe
- [ ] extend `web/static/js/tests/cloud.shim-contract.workout-crud.test.js`: after the
      existing create-exercise sequence, assert the `exercise-library` list includes the
      created exercise's name with matching defaults.
- [ ] dedupe case: two same-name exercise creates → one library entry.
- [ ] run `pnpm test` (at least the workout suites) — must pass.

### Task 3: Verify acceptance criteria
- [ ] `pnpm test` passes.
- [ ] no new `window.*` globals, no hardcoded colors / inline `.style.` (frontend rules).

## Technical Details
- Library defaults on promotion: `default_sets = target_sets`,
  `default_reps_min = target_reps_min`, `default_reps_max = target_reps_max`,
  `default_weight_kg = target_weight_kg`, `notes` empty. Nullable target fields map to
  nullable defaults unchanged.
- Dedupe uses the module's existing name-uniqueness check, matching "the user
  already added a library item with this name".

## Post-Completion
**Manual verification:** create a group → variant → add an exercise → open
Workouts → Exercises; the exercise appears. No console errors.
