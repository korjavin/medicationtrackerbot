# Propagate exercise weight/reps changes to workout schedule

## Overview

When a user edits weight, reps, or sets for an exercise in a workout session (via web UI) that is pending/notified/in-progress, automatically propagate those changes to the workout_exercises schedule definition -- but only if the exercise belongs to the session's variant (not user-added exercises).

## Context

- Files involved:
  - `internal/store/workout.go` -- store methods for workout data
  - `internal/server/store_interfaces.go` -- WorkoutStore interface
  - `internal/server/workout_handlers.go` -- HTTP handlers (handleUpdateExerciseLog, handleAddExerciseToSession)
  - `internal/store/workout_test.go` -- store tests
  - `internal/server/workout_handlers_test.go` -- handler tests (if exists, otherwise new)
- Related patterns: Server handlers call store methods directly for workout operations (no domain service layer for exercise CRUD)
- Key data model insight: `workout_exercise_logs.exercise_id` points to `workout_exercises.id` for scheduled exercises, but to `exercise_library.id` for user-added exercises. The variant_id check naturally filters out user-added exercises since their exercise_id won't match any workout_exercises row in the session's variant.

## Development Approach

- **Testing approach**: TDD -- write store tests first, then implement
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Add store methods for propagation

**Files:**
- Modify: `internal/store/workout.go`

- [x] Add `GetExerciseLogByID(id int64) (*WorkoutExerciseLog, error)` method that fetches a single exercise log by its primary key
- [x] Add `PropagateExerciseToSchedule(sessionID, exerciseID int64, sets *int, reps *int, weight *float64) error` method that executes a conditional UPDATE:
  ```sql
  UPDATE workout_exercises
  SET target_sets = COALESCE(?, target_sets),
      target_reps_min = COALESCE(?, target_reps_min),
      target_weight_kg = COALESCE(?, target_weight_kg)
  WHERE id = ?
  AND variant_id = (
      SELECT variant_id FROM workout_sessions
      WHERE id = ? AND status IN ('pending', 'notified', 'in_progress')
  )
  ```
  This single query handles all conditions: session status check, variant ownership check, and the update -- atomically. Returns nil even if 0 rows updated (no error for non-matching conditions).
- [x] Write store tests: (a) propagation succeeds for scheduled exercise in pending session, (b) propagation succeeds for in_progress session, (c) no propagation for completed session, (d) no propagation when exercise_id doesn't belong to session's variant, (e) no propagation for ad-hoc sessions (variant_id=-1)
- [x] Run `go test ./internal/store/...` -- must pass

### Task 2: Update WorkoutStore interface and wire into handlers

**Files:**
- Modify: `internal/server/store_interfaces.go`
- Modify: `internal/server/workout_handlers.go`

- [x] Add `GetExerciseLogByID(id int64) (*store.WorkoutExerciseLog, error)` to WorkoutStore interface
- [x] Add `PropagateExerciseToSchedule(sessionID, exerciseID int64, sets *int, reps *int, weight *float64) error` to WorkoutStore interface
- [x] In `handleUpdateExerciseLog`: after the existing `UpdateExerciseLog` call succeeds, fetch the log via `GetExerciseLogByID(req.ID)` to get session_id and exercise_id, then call `PropagateExerciseToSchedule`. Log errors with slog but do not fail the request (propagation is best-effort).
- [x] In `handleAddExerciseToSession`: after the existing `LogExercise` call succeeds, call `PropagateExerciseToSchedule(req.SessionID, req.ExerciseID, &sets, &reps, weight)`. Same best-effort error handling.
- [x] Write handler tests: mock store that verifies PropagateExerciseToSchedule is called with correct args after log update/create
- [x] Run `go test ./internal/server/...` -- must pass

### Task 3: Verify acceptance criteria

- [x] Run full test suite: `go test ./...`
- [x] Verify: editing exercise weight in pending session updates workout_exercises
- [x] Verify: editing exercise weight in completed session does NOT update workout_exercises
- [x] Verify: editing user-added exercise does NOT update workout_exercises
- [x] Verify: ad-hoc workout exercises do NOT propagate

### Task 4: Update documentation

- [x] Update CLAUDE.md workout tracking section to mention propagation behavior
- [x] Move this plan to `docs/plans/completed/`
