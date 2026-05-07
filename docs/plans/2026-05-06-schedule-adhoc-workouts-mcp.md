# Schedule One-off Ad-hoc Workouts via MCP

## Overview

Today, the user can either create a recurring workout group (which becomes a permanent rotation) or start an ad-hoc workout immediately via `workouts.sessions.adhoc`. There is no way to create a one-off workout for a future time with a pre-selected list of exercises. This plan adds that capability through a new MCP operation. No web UI work is required for creation; existing session detail / log update flows are reused for execution at workout time.

## Context

- Files involved:
  - `internal/store/workout.go` — `WorkoutSession`, `CreateAdHocWorkoutSession`, `WorkoutExerciseLog` types and queries
  - `internal/store/migrations/` — next migration is 057 (add only if needed; reuse of existing schema is preferred)
  - `internal/workout/service.go` — domain service for compound workout operations
  - `internal/scheduler/workout.go` — workout reminder scheduler
  - `internal/server/workout_adhoc_handlers.go` — current immediate ad-hoc handler
  - `internal/server/workout_handlers.go` — session detail handler that returns session + logs
  - `internal/server/server.go` — route registration
  - `internal/server/store_interfaces.go` — narrow store interface used by server
  - `internal/mcp/registry/operations_workouts.go` — MCP operation catalog
- Related patterns:
  - Domain service pattern (CLAUDE.md rule 1) — bot/HTTP must call `internal/domain/*` or `internal/workout` services, not the store directly
  - Ad-hoc sentinel: `group_id = -1`, `variant_id = -1` already used for immediate ad-hoc
  - Pending exercise logs: `status = ""` (empty) already accepted by `workouts.sessions.logs.create`
  - MCP coverage policy — every new HTTP route must be registered in the MCP operation registry or listed in `mcp_coverage_exempt.go`
  - Scheduler `WorkoutChecker.Check()` already iterates groups and creates sessions; we extend it with a separate pass for pre-existing pending ad-hoc sessions
- Dependencies: none external. Pure Go + SQLite.

## Design Decisions

1. Reuse `workout_sessions` table — a scheduled ad-hoc is just a pending session with `group_id = -1`, `variant_id = -1`, `status = "pending"`, and a future `scheduled_date` + `scheduled_time`. No new table.
2. Pre-create planned exercises as `workout_exercise_logs` rows with `status = ""` (pending), `sets_completed = NULL`, `reps_completed = NULL`, `weight_kg = NULL`, and `source = "library"` (or `"schedule"` if exercise_id is 0 and free-form). The existing `handleGetSessionDetails` and the existing `workouts.sessions.logs.update` flow then work without changes.
3. New MCP operation `workouts.sessions.schedule` (POST `/api/workout/sessions/schedule`) accepts `{scheduled_date, scheduled_time, name?, exercises: [...]}`. Each exercise specifies `exercise_id` (library reference, optional) or free-form `exercise_name`, plus targets.
4. Scheduler enhancement: a second-pass loop over pending ad-hoc sessions (`group_id = -1` AND `status = "pending"`). When `now` is within the notification window, fire a notification and flip status to `notified`. No rotation, no cross-TZ cooldown.
5. Notifications use the same notifier as recurring workouts; the notification body lists the planned exercises. A fixed default advance window of 0 minutes (notify at scheduled time exactly) keeps the design simple — the user picks the moment. If an `advance_minutes` body field is supplied, honour it.
6. Out of scope: editing a scheduled session, recurring scheduled ad-hoc, web UI for creation. Cancellation is via the existing `workouts.sessions.delete`.

## Development Approach

- Testing approach: regular (code first, then tests). No unit tests; integration tests at the store and HTTP-handler boundary, plus an MCP-executor end-to-end test mirroring `internal/mcp/executor/e2e_workouts_test.go`.
- Complete each task fully before moving to the next.
- CRITICAL: all tests must pass before starting the next task.

## Implementation Steps

### Task 1: Store layer — query for pending ad-hoc sessions

**Files:**
- Modify: `internal/store/workout.go`
- Modify: `internal/store/workout_test.go`

- [ ] add `ListPendingAdHocSessions(userID int64, before time.Time) ([]WorkoutSession, error)` returning sessions with `group_id = -1` AND `status = 'pending'` AND `scheduled_date <= before` (date+time combined), ordered by date+time ascending
- [ ] add a helper `CreatePlannedAdHocSession(userID int64, scheduledDate time.Time, scheduledTime string) (*WorkoutSession, error)` that mirrors `CreateAdHocWorkoutSession` but inserts with `status = 'pending'` and `started_at = NULL`
- [ ] write integration tests for both new methods in `internal/store/workout_test.go`
- [ ] run `go test ./internal/store/...` — must pass before task 2

### Task 2: Domain service — schedule operation

**Files:**
- Modify: `internal/workout/service.go`
- Modify: `internal/workout/service_test.go`

- [ ] extend the `WorkoutStore` interface (in service.go) with `CreatePlannedAdHocSession` plus the existing `CreateExerciseLog` (already exists on the store) — wire whichever methods are missing
- [ ] add `WorkoutService.SchedulePlannedAdHocSession(userID int64, scheduledDate time.Time, scheduledTime string, exercises []PlannedExercise) (*store.WorkoutSession, error)` which (a) validates the scheduled time is in the future in user's TZ, (b) creates the session via the store, (c) creates one `workout_exercise_logs` row per planned exercise with `status=""` and `sets_completed=NULL` etc., (d) returns the session
- [ ] define the small `PlannedExercise` struct in the same file: `{ExerciseID int64, ExerciseName string, TargetSets int, TargetRepsMin int, TargetRepsMax *int, TargetWeightKg *float64}`
- [ ] write integration tests in `internal/workout/service_test.go` (uses the real store)
- [ ] run `go test ./internal/workout/...` — must pass before task 3

### Task 3: HTTP handler + route registration + MCP coverage

**Files:**
- Modify: `internal/server/workout_adhoc_handlers.go` (or create `internal/server/workout_schedule_handlers.go`)
- Modify: `internal/server/server.go`
- Modify: `internal/server/store_interfaces.go` (if any new method must be exposed to the server's narrow interface)
- Modify: `internal/server/workout_handlers_test.go`

- [ ] add `handleScheduleAdHocWorkoutSession` that (a) reads `userID` from request, (b) parses JSON body `{scheduled_date, scheduled_time, exercises: [...]}`, (c) validates date format `YYYY-MM-DD` and time `HH:MM`, (d) calls `s.workouts.SchedulePlannedAdHocSession`, (e) returns `{session, planned: <count>}` with HTTP 201
- [ ] register `apiMux.HandleFunc("POST /api/workout/sessions/schedule", s.handleScheduleAdHocWorkoutSession)` in `server.go`
- [ ] write a handler test covering the happy path, past-date rejection, empty exercise list rejection
- [ ] run `go test ./internal/server/...` — must pass before task 4

### Task 4: MCP registry operation

**Files:**
- Modify: `internal/mcp/registry/operations_workouts.go`
- Modify: `internal/mcp/executor/e2e_workouts_test.go`

- [ ] add `Operation{ID: "workouts.sessions.schedule", Topic: "workouts", Method: "POST", Path: "/api/workout/sessions/schedule", Risk: RiskWrite, BodySchema: ..., Description: ..., ResponseSummary: ..., Example: ...}` next to the existing `workouts.sessions.adhoc` entry
- [ ] schema describes all body fields: `scheduled_date` (YYYY-MM-DD), `scheduled_time` (HH:MM, 24h), `exercises[]` with `exercise_id`, `exercise_name`, `target_sets`, `target_reps_min`, `target_reps_max?`, `target_weight_kg?`
- [ ] description clarifies: ad-hoc one-off, not recurring; uses library exercise IDs when given, free-form name otherwise; user can later complete via `workouts.sessions.logs.update` after `workouts.sessions.start`
- [ ] add an end-to-end test that schedules a session through the MCP executor and reads it back via `workouts.sessions.details`
- [ ] run `go test ./internal/mcp/...` and the MCP coverage guard test — must pass before task 5

### Task 5: Scheduler — notify pending ad-hoc sessions

**Files:**
- Modify: `internal/scheduler/workout.go`
- Modify: `internal/scheduler/workout_test.go`

- [ ] extend the `WorkoutStore` interface in `scheduler/workout.go` with `ListPendingAdHocSessions(userID int64, before time.Time) ([]store.WorkoutSession, error)`
- [ ] in `WorkoutChecker.Check()`, after the existing groups loop, add a pass that fetches pending ad-hoc sessions whose `scheduled_date + scheduled_time` is `<= now` (in user TZ) and: (a) sends a workout-due notification listing planned exercises, (b) flips status to `notified`, (c) reuses existing notification helpers and `SetSessionNotificationMessageID`
- [ ] do not run rotation/cooldown logic for these (no group); skip the cross-TZ cooldown
- [ ] keep handling for already-notified-but-stale ad-hoc sessions — same auto-skip / re-notify rules already applied to recurring sessions, branch on `group_id == -1` only where we'd otherwise touch rotation
- [ ] write tests covering: (a) future pending ad-hoc not notified, (b) due pending ad-hoc notified and flipped, (c) ad-hoc with no exercises still notifies but message is generic
- [ ] run `go test ./internal/scheduler/...` — must pass before task 6

### Task 6: Verify acceptance criteria

- [ ] run `go test ./...` (full Go test suite) — must pass
- [ ] run `pnpm test` (frontend tests) — should be untouched, but verify architecture-globals and MCP-coverage guard tests still pass
- [ ] run `go vet ./...`

### Task 7: Update documentation

- [ ] update `docs/api.md` with the new `POST /api/workout/sessions/schedule` route
- [ ] update `docs/features.md` workout section with one paragraph on scheduled ad-hoc workouts (MCP-only creation)
- [ ] add the new operation to `docs/mcp-coverage.md` if it lists ops explicitly (otherwise covered automatically by registry)
- [ ] move this plan to `docs/plans/completed/`
