# Fix: Medication Confirmation from Push Notification Not Saving

## Overview

The bug is a missing `intake_ids` field in the push notification → confirm modal → API request chain. When a web push notification is clicked and opens the app, `handlePushAction` reads `ids`, `names`, and `scheduled` from URL params but **ignores `intake_ids`**. As a result, `confirmSelectedMedications` always sends `{ scheduled_at, medication_ids }` without `intake_ids`. The server's reliable `intake_ids` path is never triggered; the fragile `scheduled_at` timestamp-matching fallback is used instead and silently fails (returning HTTP 200 with no actual DB write).

Two-line fix in `app.js` with a matching server test.

## Context

- Files involved:
  - `web/static/js/app.js` — `handlePushAction` (reads URL params) and `confirmSelectedMedications` (builds API body)
  - `internal/server/server_handlers_test.go` — existing tests for `handleConfirmSchedule`
- Related patterns: server handler at `internal/server/server.go:885` prefers `intake_ids` over `scheduled_at+medication_ids`
- The SW at `web/static/sw.js:387` already puts `intake_ids` in the URL; the bug is purely in JS reading it back

## Development Approach

- **Testing approach**: Regular (fix first, then add test)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Fix `handlePushAction` to read `intake_ids` from URL params

**Files:**
- Modify: `web/static/js/app.js`

The function reads `ids`, `names`, `scheduled` from URL params but discards `intake_ids`. Fix: read `intake_ids` and pass them to `showMedicationConfirmModal`.

- [ ] In `handlePushAction`, after reading `scheduled`, add: `const intakeIds = params.get('intake_ids') ? params.get('intake_ids').split(',').map(Number) : [];`
- [ ] Change the `showMedicationConfirmModal` call from `showMedicationConfirmModal(ids, names, scheduled)` to `showMedicationConfirmModal(ids, names, scheduled, 'confirm', intakeIds)`
- [ ] Run full test suite: `go test ./...` — must pass before task 2

### Task 2: Fix `confirmSelectedMedications` to include `intake_ids` in API request

**Files:**
- Modify: `web/static/js/app.js`

The function builds the request body with only `scheduled_at` and `medication_ids`. Fix: when `pendingMedConfirmIntakeIds` is populated, also compute and send `intake_ids` for the selected medications.

- [ ] After computing `selectedIds`, compute `selectedIntakeIds`: map each `selectedId` to its intake ID using the parallel `pendingMedConfirmIds` / `pendingMedConfirmIntakeIds` arrays
- [ ] Include `intake_ids: selectedIntakeIds` in the API request body (alongside `scheduled_at` and `medication_ids` for backwards compatibility; the server prefers `intake_ids` when present)
- [ ] Run full test suite: `go test ./...` — must pass before task 3

### Task 3: Add server test for the push-notification confirm flow

**Files:**
- Modify: `internal/server/server_handlers_test.go`

The existing tests already cover `intake_ids` path (`TestHandleConfirmSchedule_WithIntakeIDs`). Add a test that mirrors the push-notification scenario: a single medication confirmed by `intake_ids` coming from a click on a `medication_individual` push notification (a single intake ID).

- [ ] Add `TestHandleConfirmSchedule_SingleIntakeFromPush`: creates one intake, sends `{ intake_ids: [id] }`, asserts status TAKEN and inventory decremented
- [ ] Run `go test ./internal/server/...` — must pass

### Task 4: Verify acceptance criteria

- [ ] Manual test: trigger a web push notification, click body to open confirm modal, confirm, check intake history tab — entry must appear
- [ ] Run full test suite: `go test ./...`
- [ ] Run linter: `go vet ./...`

### Task 5: Update documentation

- [ ] No CLAUDE.md changes needed (internal bug fix, no pattern change)
- [ ] Move this plan to `docs/plans/completed/`
