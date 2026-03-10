# Make WebPush Notification Channel On Par with Telegram

## Overview

Bring the WebPush notification channel to full feature parity with Telegram across four areas:
1. Broken workout actions (snooze/skip open app URL instead of calling APIs)
2. Missing server-side medication snooze (currently a client-side 10-min timer only)
3. Missing per-medication confirm/skip buttons (only "Confirm ALL" exists in WebPush)
4. Missing notification close-on-confirmation (Telegram deletes the message, WebPush notification stays)

## Context

- Files involved:
  - `web/static/sw.js` - service worker, notification click routing and API handlers
  - `internal/webpush/webpush.go` - payload builder, SendMedicationNotification, SendWorkoutNotification
  - `internal/scheduler/medication.go` - batches medications and sends notification
  - `internal/server/server.go` - REST handlers for push-related API calls
  - `internal/store/store.go` - DB methods for push subscriptions, snooze_until fields
  - `internal/notifier/webpush.go` - notifier adapter (currently returns 0 for message ID)
- Related patterns: existing BP/weight snooze API calls in sw.js (handleBPSnooze, handleWeightSnooze), existing handleMedicationConfirm in sw.js
- Dependencies: none new

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- Every task that touches server code must add/update handler tests
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Add missing server-side API endpoints

**Files:**
- Modify: `internal/server/server.go`
- Modify: `internal/store/store.go` (add SnoozeIntake if missing)

- [x] Add `POST /api/workout/session/snooze` - accepts `{session_id, duration_hours}`, calls existing store snooze method
- [x] Add `POST /api/workout/session/skip` - accepts `{session_id}`, marks session skipped via existing store skip method
- [x] Add `POST /api/medications/snooze` - accepts `{intake_id, duration_minutes}`, sets snooze_until on the intake row
- [x] Add `POST /api/medications/skip` - accepts `{intake_id}`, marks intake as skipped (same effect as Telegram skip_<id> callback)
- [x] Register all four routes in server setup
- [x] Write handler tests for all four endpoints (use httptest, in-memory SQLite like existing server tests)
- [x] Run `go test ./internal/server` - must pass before task 2

### Task 2: Per-medication individual notifications in WebPush

**Files:**
- Modify: `internal/webpush/webpush.go`
- Modify: `internal/scheduler/medication.go`

Currently `SendMedicationNotification` sends one batched notification for all meds due at a time with only a "Confirm ALL" action. Change to:
- [x] Update `SendMedicationNotification` so that when called with individual medication data it sends one notification per medication
- [x] Tag format: `medication-<intake_id>` (one per intake, allows individual close)
- [x] Actions per notification: `[{action: "confirm_<intake_id>", title: "Confirm"}, {action: "skip_<intake_id>", title: "Skip"}]`
- [x] Data payload includes: `intake_id`, `medication_id`, `type: "medication_individual"`
- [x] Update `internal/scheduler/medication.go` to call individual send per medication instead of one batched send (loop over medications in the time slot)
- [x] Remove batched "Confirm ALL" notification in favor of individual ones
- [x] Write tests for the updated payload builder
- [x] Run `go test ./internal/webpush` and `go test ./internal/scheduler` - must pass before task 3

### Task 3: Add service worker handlers for new actions

**Files:**
- Modify: `web/static/sw.js`

- [x] Add `handleWorkoutSnooze(sessionId, hours)` function - POST to `/api/workout/session/snooze` with auth header (follow the same fetch pattern as existing handleBPSnooze)
- [x] Add `handleWorkoutSkip(sessionId)` function - POST to `/api/workout/session/skip`
- [x] In the `notificationclick` handler for `workout` type, route `workout_snooze1` / `workout_snooze2` to `handleWorkoutSnooze(sessionId, 1)` / `handleWorkoutSnooze(sessionId, 2)` instead of opening the app URL
- [x] Route `workout_skip` to `handleWorkoutSkip(sessionId)`
- [x] Add `handleMedicationSkip(intakeId)` function - POST to `/api/medications/skip`
- [x] Add `handleMedicationServerSnooze(intakeId, minutes)` function - POST to `/api/medications/snooze`
- [x] In `medication_individual` type handling: route `confirm_<id>` to existing handleMedicationConfirm pattern, route `skip_<id>` to handleMedicationSkip
- [x] Replace the existing medication snooze `setTimeout` trick with a call to `handleMedicationServerSnooze` (10 min = 600000ms stays as the duration)
- [x] Run manual end-to-end test: trigger a workout WebPush notification, click Snooze - verify server snooze_until is updated

### Task 4: Notification close on confirmation

**Files:**
- Modify: `internal/webpush/webpush.go` - add `SendCloseNotification(userID int64, tag string)`
- Modify: `internal/server/server.go` - call close after successful intake confirmation
- Modify: `web/static/sw.js` - handle `type: "close"` push events

- [x] Add `SendCloseNotification(userID int64, tag string)` to webpush.go: sends a silent push with `{type: "close", tag: "<tag>"}` and no displayed notification
- [x] In sw.js push event handler: if `data.type === "close"`, call `self.registration.getNotifications({tag: data.tag}).then(notifs => notifs.forEach(n => n.close()))` and do NOT show a notification
- [x] In `handleConfirmSchedule` server handler: after successful confirmation, call `webpush.SendCloseNotification` for each confirmed intake_id with tag `medication-<intake_id>`
- [x] For workout completion/skip: after session completed or skipped, send close notification for the workout notification tag
- [x] Write tests for SendCloseNotification payload structure
- [x] Run `go test ./internal/webpush` - must pass before task 5

### Task 5: Verify acceptance criteria

**Files:** none (verification only)

- [x] Manual test: subscribe to WebPush, trigger medication notification, verify individual per-med notifications appear
- [x] Manual test: click "Confirm" on individual med notification, verify intake confirmed in DB and notification closes
- [x] Manual test: click "Skip" on individual med notification, verify intake skipped in DB
- [x] Manual test: trigger workout notification, click "Snooze 1h", verify snooze_until set in DB and no re-notification for 1h
- [x] Manual test: click "Skip" on workout notification, verify session skipped
- [x] Run full test suite: `go test ./...` - must pass
- [x] Run linter: `go vet ./...`

### Task 6: Update documentation

- [x] Update CLAUDE.md webpush notifier note to reflect new close notification mechanism
- [x] Move this plan to `docs/plans/completed/`
