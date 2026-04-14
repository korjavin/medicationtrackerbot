# Fix: Telegram cancel/undo button for early medication intake

## Overview

The "Cancel (Undo)" button on the Telegram early-intake confirmation message is non-functional because `handleCallback()` in `internal/bot/bot.go` has no case for the `cancel_intake` callback data. Additionally, the callback data lacks the intake IDs needed to perform the cancellation. The WebPush path works correctly (service worker gets IDs from notification data payload).

## Root Cause

1. `internal/server/medication_handlers.go:624` creates notification with action ID `cancel_intake` (no intake IDs)
2. `internal/bot/bot.go` `handleCallback()` has no handler for `cancel_intake` — the click is silently ignored
3. Even if a handler existed, the callback data string contains no intake IDs to cancel

## Context

- Files involved:
  - `internal/domain/medication.go` — MedicationService (add CancelIntake method)
  - `internal/domain/medication_test.go` — tests for the new method
  - `internal/bot/bot.go` — handleCallback (add cancel_intake case)
  - `internal/server/medication_handlers.go` — notification action ID (embed intake IDs)
  - `web/static/sw.js` — service worker action matching (startsWith instead of ===)
- Related patterns: Domain Service Pattern (bot calls medSvc, not store directly)
- Dependencies: None

## Development Approach

- **Testing approach**: TDD — add domain service test first, then implement
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Add CancelIntake to domain service

**Files:**
- Modify: `internal/domain/medication.go`
- Modify: `internal/domain/medication_test.go`

- [x] Add `UpdateIntake(id int64, takenAt time.Time, status string) error` to `MedicationStore` interface
- [x] Add `ErrNotTaken` sentinel error (analogous to `ErrNotPending`)
- [x] Add `CancelIntake(intakeID int64) (medName string, medDosage string, err error)` to `MedicationService` interface
- [x] Implement `CancelIntake` on `medicationService`: check status is TAKEN, revert to PENDING (zero time), increment inventory (DecrementInventory with -1), return med name/dosage
- [x] Add `updateIntakeFn` to `mockMedicationStore` in test file
- [x] Write table-driven tests for CancelIntake: happy path, not-taken returns ErrNotTaken, nil intake returns ErrNotTaken, GetIntake error propagates, UpdateIntake error propagates, DecrementInventory error is non-fatal
- [x] Run `go test ./internal/domain/` — must pass

### Task 2: Embed intake IDs in notification action and add bot callback handler

**Files:**
- Modify: `internal/server/medication_handlers.go`
- Modify: `internal/bot/bot.go`
- Modify: `web/static/sw.js`

- [x] In `medication_handlers.go:624`, change action ID from `"cancel_intake"` to `fmt.Sprintf("cancel_intake:%s", intakeIDList)` where intakeIDList is comma-joined intake IDs
- [x] In `sw.js:512`, change `action === 'cancel_intake'` to `action.startsWith('cancel_intake')` (SW still uses `data.intake_ids` for the API call, so no other change needed)
- [x] In `bot.go` `handleCallback()`, add a new `else if strings.HasPrefix(data, "cancel_intake:")` branch before the existing `confirm:` case:
  - Parse comma-separated intake IDs from the suffix
  - Loop over IDs, call `b.medSvc.CancelIntake(id)` for each
  - Delete the notification message (the one with the cancel button)
  - Send confirmation message: "Intake cancelled, reverted to pending"
  - Handle ErrNotTaken gracefully (intake already processed)
- [x] Run `go test ./...` — must pass

### Task 3: Verify acceptance criteria

- [ ] Run full test suite: `go test ./...`
- [ ] Verify no regressions in existing cancel_intake_handler_test.go (HTTP path)

### Task 4: Update documentation

- [ ] Move this plan to `docs/plans/completed/`
