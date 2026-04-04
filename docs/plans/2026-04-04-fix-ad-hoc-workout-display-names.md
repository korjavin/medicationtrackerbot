---
# Fix Ad-Hoc Workout Display Names

## Overview
Ad-hoc workout sessions currently show as "Unknown - Unknown" in the history list. This fix changes the display to "Ad-hoc" / "<biggest exercise by volume>" (e.g. "Ad-hoc - Squats") by updating the session list handler. When no exercises are logged, the session shows just "Ad-hoc".

## Context
- Files involved:
  - `internal/server/workout_handlers.go` — handleListWorkoutSessions (lines 467-541)
  - `web/static/js/workout.js` — session history rendering (lines 1366-1370)
- Related patterns: `WorkoutExerciseLog.ExerciseName` is already stored denormalized in workout_exercise_logs, so no new store query is needed
- Ad-hoc sessions are identified by group_id == -1 and variant_id == -1
- The logs fetched at line 502 already contain ExerciseName and volume info — no extra DB call needed

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Update session list handler to generate better ad-hoc names

**Files:**
- Modify: `internal/server/workout_handlers.go`

- [x] In handleListWorkoutSessions, after fetching logs, add ad-hoc detection: when session.GroupID == -1, set groupName = "Ad-hoc"
- [x] Find the biggest exercise from logs by total volume (sets * reps * weight); if found, set variantName = that exercise's ExerciseName (e.g. "Squats"); if no exercises logged, variantName = "" (display will show just "Ad-hoc")
- [x] Keep existing non-ad-hoc logic unchanged
- [x] Write a server handler test covering: ad-hoc session with exercises shows "Ad-hoc"/"Squats" (biggest by volume), ad-hoc session with no exercises shows "Ad-hoc"/"", regular session unchanged
- [x] Run go test ./internal/server/... — must pass

### Task 2: Update frontend to conditionally show variant name

**Files:**
- Modify: `web/static/js/workout.js`

- [x] At line 1370, change the unconditional ` - ${s.variant_name}` append to only append ` - ${s.variant_name}` when s.variant_name is non-empty (so ad-hoc with no exercises shows just "Ad-hoc" not "Ad-hoc - ")
- [x] Run go test ./... — must pass

### Task 3: Verify acceptance criteria

- [ ] Run full test suite: go test ./...

### Task 4: Update documentation

- [ ] Move this plan to docs/plans/completed/
