---
# Allow skipping medications and fix past intake creation

## Overview
Fix two related issues with medication intakes:
  1. When a medication is created without a start date, the scheduler creates "missed" intakes for times that have already passed today (even though the medication didn't exist then)
  2. The skip functionality is currently restricted to supplements only, preventing users from dismissing these incorrectly-created intakes

## Context
- Files involved:
  - `internal/domain/medication.go` - Domain service with skip logic
  - `internal/scheduler/medication.go` - Scheduler that creates intake logs
  - `internal/server/medication_handlers.go` - HTTP handlers including `/api/medications/skip`
  - `internal/bot/bot.go` - Telegram bot callback handling
  - `web/static/js/app.js` - Frontend medication UI
  - `web/static/js/push.js` - Push notification actions (may need skip support)
- Related patterns:
  - The domain service pattern: bot callbacks call domain services, not store directly
  - Skip currently returns `ErrNotSupplement` for non-supplement medications
  - Frontend already has skip concept for workouts
- Root cause:
  - In `internal/scheduler/medication.go:96-105`, the scheduler checks StartDate/EndDate and if `now.Before(target)`, but doesn't check if the medication was created before the scheduled time
  - When user changes StartDate to tomorrow, existing PENDING intakes remain and keep generating reminders

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Remove supplement restriction from skip functionality

**Files:**
- Modify: `internal/domain/medication.go`

- [ ] Rename `SkipSupplementIntake` to `SkipIntake` and remove `ErrNotSupplement` check
- [ ] Update domain service interface `MedicationService` - change method name
- [ ] Update `medicationService` struct to use new method name
- [ ] Remove `ErrNotSupplement` error definition (no longer needed)
- [ ] Write unit tests for the updated `SkipIntake` method
- [ ] Run `go test ./internal/domain/...` - must pass before task 2

### Task 2: Update server handlers and bot callbacks

**Files:**
- Modify: `internal/server/medication_handlers.go`
- Modify: `internal/bot/bot.go`

- [ ] Update `handleSkipMedication` in server to call `SkipIntake` instead of `SkipSupplementIntake`
- [ ] Remove `ErrNotSupplement` error handling in bot's `skip_intake:` callback handler (lines 417-422)
- [ ] Update all references to `SkipSupplementIntake` throughout the codebase
- [ ] Write server handler tests for skip endpoint
- [ ] Write bot callback tests for skip action
- [ ] Run `go test ./internal/server/... ./internal/bot/...` - must pass before task 3

### Task 3: Fix scheduler to avoid creating past intakes

**Files:**
- Modify: `internal/scheduler/medication.go`

- [ ] Add check to prevent creating intake logs for times before the medication was created
- [ ] In the medication iteration loop (lines 62-123), add check: `if target.Before(med.CreatedAt) { continue }`
- [ ] Write scheduler tests to verify past intakes are not created
- [ ] Run `go test ./internal/scheduler/...` - must pass before task 4

### Task 4: Add skip button to web UI for non-supplement medications

**Files:**
- Modify: `web/static/js/app.js`
- Modify: `web/static/js/push.js` (if needed)

- [ ] In `showMedicationConfirmModal`, add a Skip button for PENDING intakes
- [ ] Implement `skipSelectedMedication` function that calls `/api/medications/skip`
- [ ] For push notifications, handle skip action button clicks
- [ ] Write frontend tests for skip functionality
- [ ] Run web tests - must pass before task 5

### Task 5: Clean up test dependencies and documentation

**Files:**
- Modify: `internal/domain/medication_test.go`
- Modify: `CLAUDE.md` (if needed)

- [ ] Update all test mock `SkipIntake` method references
- [ ] Update any documentation that mentions supplement-only skip restriction
- [ ] Run full test suite `go test ./...` - must pass before task 6

### Task 6: Verify acceptance criteria

- [ ] manual test: Create a medication at 22:00 with schedule for 8:00am (no start date) - verify no PENDING intake is created for 8:00am
- [ ] manual test: Create medication, then click Skip button on a PENDING intake - verify it becomes SKIPPED and notifications stop
- [ ] manual test: Test skip in Telegram bot - verify skip works for both supplements and regular medications
- [ ] manual test: Verify push notification skip button works
- [ ] run full test suite (use project-specific command): `go test ./...`
- [ ] run linter (use project-specific command): `go vet ./...`
- [ ] verify test coverage meets 80%+

### Task 7: Update documentation

- [ ] update README.md if user-facing changes (skip now available for all medications)
- [ ] update CLAUDE.md if internal patterns changed (skip is no longer supplement-only)
- [ ] move this plan to `docs/plans/completed/`
