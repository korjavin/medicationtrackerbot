# Fix: confirm-schedule Does Not Revert Unchecked Already-Taken Intakes

## Overview
When a user opens the medication confirm modal for a time slot where all medications are already TAKEN, unchecks one medication, and saves, the `POST /api/medications/confirm-schedule` endpoint receives only the checked medication IDs. It confirms those (which are already TAKEN, so nothing changes), and never reverts the unchecked one back to PENDING. Fix: after processing confirmations, revert any TAKEN intake at that scheduled_at whose medication_id was not in the provided list.

## Context
- Files involved:
  - `internal/server/server.go` (handleConfirmSchedule function, lines 885-989)
  - `internal/server/store_interfaces.go` (MedicationStore interface)
  - `internal/store/store.go` (store methods)
  - `internal/server/server_handlers_test.go` (new tests)
- Related patterns: existing `UpdateIntake`, `DecrementInventory`, `GetPendingIntakesBySchedule` methods
- No frontend changes needed (frontend already sends the correct checked IDs)

## Development Approach
- Testing approach: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Add store methods

**Files:**
- Modify: `internal/store/store.go`

- [ ] Add `GetTakenIntakesBySchedule(userID int64, scheduledAt time.Time) ([]IntakeLog, error)` — queries intake_log WHERE user_id=? AND scheduled_at=? AND status='TAKEN'
- [ ] Add `IncrementInventory(medID int64, qty int) error` — `UPDATE medications SET inventory_count = inventory_count + ? WHERE id = ? AND inventory_count IS NOT NULL`
- [ ] Write store-level tests for both new methods in `internal/store/store_medication_test.go`
- [ ] Run `go test ./internal/store` — must pass

### Task 2: Update MedicationStore interface and fix the handler

**Files:**
- Modify: `internal/server/store_interfaces.go`
- Modify: `internal/server/server.go`

- [ ] Add `GetTakenIntakesBySchedule(userID int64, scheduledAt time.Time) ([]store.IntakeLog, error)` to the `MedicationStore` interface
- [ ] Add `IncrementInventory(medID int64, qty int) error` to the `MedicationStore` interface
- [ ] In `handleConfirmSchedule` Path 2 (after the medication_ids confirm loop), add revert logic:
  - Build a set of medication IDs that were in the request
  - Call `GetTakenIntakesBySchedule(userID, parsedTime)`
  - For each returned TAKEN intake whose `MedicationID` is NOT in the set:
    - Call `UpdateIntake(intake.ID, time.Time{}, "PENDING")` to revert it
    - Call `IncrementInventory(intake.MedicationID, 1)` to restore stock (only if tracking enabled — the method handles NULL inventory gracefully)
- [ ] Write tests in `internal/server/server_handlers_test.go`:
  - `TestHandleConfirmSchedule_RevertsUncheckedTakenIntake`: set up 2 TAKEN intakes at same scheduled_at, send medication_ids with only one, verify the other reverts to PENDING
  - `TestHandleConfirmSchedule_ConfirmsAndRevertsInSameRequest`: mixed PENDING+TAKEN scenario
- [ ] Run `go test ./internal/server` — must pass

### Task 3: Verify acceptance criteria

- [ ] Manual test: confirm all 4 meds, then open the modal, uncheck one, save → verify it reverts to PENDING in the DB / UI refreshes correctly
- [ ] Run full test suite: `go test ./...`
- [ ] Run linter: `go vet ./...`
- [ ] Move this plan to `docs/plans/completed/`
