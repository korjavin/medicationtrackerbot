---
# Allow deleting archived medications without intake history

## Overview
Enable permanent deletion of medications that have no intake logs. The existing "Archive" button (bin icon) will behave differently based on medication state: for active medications it archives; for archived medications without intake history it deletes; for archived medications with intake history it shows an error message.

## Context
- Files involved:
  - `internal/store/store.go` - Add method to check if medication has intakes
  - `internal/server/medication_handlers.go` - Update DELETE handler to check intake count
  - `web/static/js/app.js` - Modify `deleteMed()` to call DELETE for archived meds
  - `internal/server/medication_handlers_test.go` - Update tests
  - `internal/store/store_medication_test.go` - Test new store method
- Related patterns:
  - DELETE endpoints return 409 Conflict for constraint violations
  - Archive vs Delete pattern already used in the medication UI
- Database constraints:
  - `intake_log.medication_id` FK has no CASCADE (prevents deletion with history)
  - `medication_restocks.medication_id` FK has CASCADE (OK to delete)

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Add store method to check if medication can be deleted

**Files:**
- Modify: `internal/store/store.go`

- [ ] Add `CanDeleteMedication(id int64) (bool, error)` method
  - Query `SELECT COUNT(*) FROM intake_log WHERE medication_id = ?`
  - Return true if count is 0, false otherwise
- [ ] Write unit tests in `internal/store/store_medication_test.go`
  - Test with medication that has no intakes → returns true
  - Test with medication that has intakes → returns false
- [ ] Run `go test ./internal/store/...` - must pass before task 2

### Task 2: Update DELETE handler to check deletability

**Files:**
- Modify: `internal/server/medication_handlers.go`

- [ ] Update `handleDeleteMedication` to:
  - Call `CanDeleteMedication(id)` before deletion
  - If false, return 409 Conflict with error message "Cannot delete medication with intake history"
  - If true, proceed with deletion
- [ ] Update test `TestHandleDeleteMedication` in `medication_handlers_test.go`
  - Test deletion succeeds for medication without intakes
  - Test deletion returns 409 for medication with intakes
- [ ] Run `go test ./internal/server/...` - must pass before task 3

### Task 3: Update frontend to call DELETE for archived medications

**Files:**
- Modify: `web/static/js/app.js`

- [ ] Modify `deleteMed(id)` function:
  - Get medication from `medications` array
  - If medication is archived:
    - Change confirm message to "Delete this medication permanently?"
    - Call `DELETE /api/medications/${id}` via `apiCallDirect()`
    - On 409 error: `safeAlert("Cannot delete: medication has intake logged already")`
    - On success: reload meds list
  - If medication is NOT archived:
    - Keep existing archive behavior (no changes)
- [ ] Manual test: Create duplicate med (active) → click bin → archives correctly
- [ ] Manual test: Archive med with no intakes → click bin → deletes successfully
- [ ] Manual test: Archive med with intakes → click bin → shows error message

### Task 4: Verify acceptance criteria

- [ ] Manual test: Delete archived medication without history succeeds
- [ ] Manual test: Archive active medication works (existing behavior)
- [ ] Manual test: Attempt to delete archived medication with history shows error
- [ ] Run full test suite: `go test ./...`
- [ ] Verify test coverage for modified files is >80%

### Task 5: Update documentation

- [ ] Update CLAUDE.md if medication deletion behavior changed
- [ ] Move this plan to `docs/plans/completed/`
