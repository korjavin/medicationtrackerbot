---
# Fix Medication History Filter: Show Active Meds Only & Clear on Empty Result

## Overview
Two bugs in the medication history tab:
1. The medication name filter dropdown shows all medications, but should only show those with intakes in the last 7 days (since that's all the history we show anyway)
2. When selecting a medication with no recent intakes, the history list does not clear - it stays showing old data

## Context
Root causes identified:
- Bug 1: `populateMedFilter()` in app.js (line 1678) shows all medications unconditionally. Medications already carry a `last_taken_at` field - we just need to filter by it.
- Bug 2: `GetIntakeHistory` in `internal/store/store.go` (line 606) uses `var logs []IntakeLog` which is a nil slice. Go encodes nil slices as `null` in JSON. The frontend `loadHistory` uses `loadSWR` which only calls `onFresh` when `hasValue(fresh)` is true - `null` fails that check, leaving stale cached data on screen.

Files involved:
- `internal/store/store.go` - fix nil slice encoding
- `web/static/js/app.js` - fix `populateMedFilter` to filter by recent activity
- `web/static/js/tests/app.medication-history.test.js` - update/add tests
- `internal/store/store_medication_test.go` - verify empty result behavior

Related patterns:
- SWR data flow: `loadSWR` in `data-store.js` only triggers `onFresh` when `hasValue(fresh)` returns true
- Store tests use in-memory SQLite (`:memory:`)

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Fix Go to return empty array instead of null for empty history

**Files:**
- Modify: `internal/store/store.go`
- Modify: `internal/store/store_medication_test.go` (or equivalent store test file)

- [ ] Change `var logs []IntakeLog` to `logs := []IntakeLog{}` in `GetIntakeHistory` (~line 606)
- [ ] Verify `json.Encode([])` produces `[]` not `null`
- [ ] Add or update test asserting that querying for a medication with no intakes returns an empty non-nil slice
- [ ] run `go test ./internal/store/...` - must pass before task 2

### Task 2: Fix frontend medication filter to show only meds with recent intakes

**Files:**
- Modify: `web/static/js/app.js`
- Modify: `web/static/js/tests/app.medication-history.test.js`

- [ ] In `populateMedFilter()`, compute a cutoff date 7 days ago
- [ ] Filter `medications` to only include entries where `last_taken_at` is not null and is within the last 7 days before adding to the dropdown
- [ ] Always include "All Medications" option as before
- [ ] Update the existing test to assert that a medication with `last_taken_at` older than 7 days does NOT appear in the filter, while one within 7 days does
- [ ] run `npm test` from `web/static/js/tests/` - must pass before task 3

### Task 3: Defensive fix - ensure history clears on empty fetch result

**Files:**
- Modify: `web/static/js/app.js`
- Modify: `web/static/js/tests/app.medication-history.test.js`

- [ ] In `loadHistory()`, add `allowNullFresh: true` to the `loadSWR` options object so that a null response still triggers `onFresh` and clears the list
- [ ] In `loadHistory` `onFresh`, the existing `renderHistory(fresh || [])` already handles null → empty, so no change needed there
- [ ] Add a test case that verifies: when `loadHistory` is called and `onFresh` receives `null`, `renderHistory` is called with an empty array (not skipped)
- [ ] run full JS test suite - must pass

### Task 4: Verify acceptance criteria

- [ ] manual test: open history tab, confirm filter only lists meds taken in last 7 days
- [ ] manual test: select a medication with no intakes - verify list shows empty state
- [ ] run `go test ./...`
- [ ] run JS test suite
- [ ] run linter
- [ ] move this plan to `docs/plans/completed/`

### Task 5: Update documentation

- [ ] update CLAUDE.md if internal patterns changed
- [ ] move this plan to `docs/plans/completed/`
