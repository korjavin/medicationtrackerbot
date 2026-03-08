---
# Add Delete/Edit Support for Mi Band Imported Workouts

## Overview

Add the ability to delete or edit field values (steps, distance, duration, calories, heart rate, SpO2) of Mi Band imported workouts from the workout history UI. Clicking a Mi Band workout card will open a detail/edit modal with editable fields and a delete option.

## Context

- Files involved:
  - `internal/store/miband_workouts.go` - add store methods for delete and update
  - `internal/server/miband_handlers.go` - add HTTP handlers for DELETE and PATCH
  - `internal/server/server.go` - register new routes
  - `web/static/js/workout.js` - add click handler, edit modal, and API calls
- Related patterns:
  - BP delete: `DELETE /api/bp/{id}` with user ownership verification via `WHERE id=? AND user_id=?`
  - Weight delete: `DELETE /api/weight/{id}` with same pattern
  - Session delete modal in workout.js as UI reference
- Dependencies: none external

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Store layer - delete and update Mi Band workouts

**Files:**
- Modify: `internal/store/miband_workouts.go`
- Modify (or create): `internal/store/miband_workouts_test.go`

- [ ] Add `DeleteMiBandWorkout(ctx context.Context, id, userID int64) error` method — deletes by id AND user_id, returns sql.ErrNoRows if not found (cascades to gps_tracks via FK)
- [ ] Define `UpdateMiBandWorkoutFields` struct with pointer fields so zero-values are distinguishable from "not set" (fields: Steps, DistanceM, DurationSec, Calories, HeartRateAvg, SpO2Avg)
- [ ] Add `UpdateMiBandWorkout(ctx context.Context, id, userID int64, fields UpdateMiBandWorkoutFields) error` — updates only the non-nil fields where id AND user_id match
- [ ] Write tests in `internal/store/miband_workouts_test.go` covering: delete own workout, delete other user's workout (expect ErrNoRows), update steps only, update multiple fields, update nonexistent id
- [ ] Run `go test ./internal/store/...` — must pass

### Task 2: HTTP handlers and route registration

**Files:**
- Modify: `internal/server/miband_handlers.go`
- Modify: `internal/server/server.go`

- [ ] Add `handleDeleteMiBandWorkout` handler: extract userID from context, parse path param `{id}`, call store delete, return 404 on ErrNoRows, 204 on success
- [ ] Add `handleUpdateMiBandWorkout` handler: extract userID, parse path param `{id}`, decode JSON body into UpdateMiBandWorkoutFields, call store update, return 404 or 200
- [ ] Register routes in server.go: `DELETE /api/workout/miband/{id}` and `PATCH /api/workout/miband/{id}`
- [ ] Write handler tests in `internal/server/miband_handlers_test.go` (or add to existing test file if present): delete success, delete not found, update steps field, update with invalid id
- [ ] Run `go test ./internal/server/...` — must pass

### Task 3: Frontend edit/delete modal

**Files:**
- Modify: `web/static/js/workout.js`

- [ ] Make `_buildMiBandCard(w)` cards clickable — attach click handler that opens a detail/edit modal
- [ ] Build modal HTML (reuse existing modal pattern from session detail modal): show activity name and date as title; render editable number inputs for steps, distance_m, duration_sec, calories, heart_rate_avg, spo2_avg; include Save and Delete buttons
- [ ] Save handler: collect changed field values (only those differing from original), send PATCH to `/api/workout/miband/{id}` with only modified fields, close modal and refresh history tab on success
- [ ] Delete handler: confirm dialog ("Delete this workout?"), send DELETE to `/api/workout/miband/{id}`, close modal and refresh history tab on success
- [ ] No automated frontend tests (project has none); manual test checklist in final task

### Task 4: Verify acceptance criteria

- [ ] Manual test: import a Mi Band workout, open history, click the card, edit the steps field, save — verify value updates in the list
- [ ] Manual test: click a Mi Band card and delete — verify it disappears from history
- [ ] Manual test: attempt to edit/delete with a different user ID (if testable) — verify 404
- [ ] Run full test suite: `go test ./...` — must pass
- [ ] Run linter: `go vet ./...`

### Task 5: Update documentation

- [ ] No README changes needed (internal feature)
- [ ] Move this plan to `docs/plans/completed/`
