# Add Duplicate Medication Check

## Overview
Before creating a new medication, check if one with the same name (case-insensitive) and dosage already exists (including archived). Return HTTP 409 Conflict if a duplicate is found, and show an error in the frontend.

## Context
- Files involved:
  - `internal/server/medication_handlers.go` - handleCreateMedication (add check here)
  - `internal/server/medication_handlers_test.go` - add duplicate test case
  - `web/static/app.js` or the relevant medication creation UI code - surface the 409 error
- Related patterns: existing handler pattern in `handleCreateMedication`, `ListMedications(true)` for fetching all meds including archived
- Dependencies: none

## Development Approach
- Testing approach: Regular (code first, then tests)
- Complete each task fully before moving to the next
- CRITICAL: every task MUST include new/updated tests
- CRITICAL: all tests must pass before starting next task

## Implementation Steps

### Task 1: Add duplicate check in the HTTP handler

**Files:**
- Modify: `internal/server/medication_handlers.go`
- Modify: `internal/server/medication_handlers_test.go`

- [x] In `handleCreateMedication`, after decoding the request and before calling `s.meds.CreateMedication`, call `s.meds.ListMedications(true)` to get all medications including archived
- [x] Loop through the list and compare name (strings.EqualFold) and dosage (exact match) with the request values
- [x] If a match is found, return HTTP 409 Conflict with a descriptive message: `"Medication with this name and dosage already exists"`
- [x] Write test `TestHandleCreateMedication_Duplicate` in `internal/server/medication_handlers_test.go` that creates a medication, then tries to create one with the same name/dosage, and expects HTTP 409
- [x] Run `go test ./internal/server/...` - must pass

### Task 2: Surface the error in the frontend

**Files:**
- Modify: `web/static/app.js` (medication creation form submit handler)

- [x] Find the medication creation form submission code that calls POST `/api/medications`
- [x] If the response is 409, show a user-friendly error message (e.g. using the existing `safeAlert` or inline form error) instead of a generic failure
- [x] Run `go test ./...` - must pass

### Task 3: Verify acceptance criteria

- [ ] Manual test: try to add a medication that already exists (active) - should see error
- [ ] Manual test: try to add a medication that matches an archived one - should see error
- [ ] Manual test: add a medication with same name but different dosage - should succeed
- [ ] Manual test: add a medication with same dosage but different name - should succeed
- [ ] Run `go test ./...`
- [ ] Run `go vet ./...`

### Task 4: Update documentation

- [ ] Move this plan to `docs/plans/completed/`
