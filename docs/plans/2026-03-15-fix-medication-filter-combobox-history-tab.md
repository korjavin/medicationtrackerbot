---
# Fix: Medication Filter Combobox Not Populated on History Tab

## Overview
Call `populateMedFilter()` in `loadHistory()` so the combobox is populated even when medications are already loaded from bootstrap. Currently the filter only gets populated inside `loadMeds()`, which is skipped when `medications.length > 0`.

## Context
- Files involved: `web/static/js/app.js`, `web/static/js/tests/app.medication-history.test.js`
- Root cause: `loadHistory()` skips `loadMeds()` when `medications.length > 0`. `populateMedFilter()` is only ever called inside `loadMeds()`. So navigating directly to the history tab (or the history sub-tab being active on load) leaves the combobox with only the default "All Medications" option.
- Bootstrap populates `medications` (with `last_taken_at`) before any tab loads, so the data IS available — it's just that `populateMedFilter()` never runs.

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Fix loadHistory to always populate the filter

**Files:**
- Modify: `web/static/js/app.js`

- [x] In `loadHistory()`, add a `populateMedFilter()` call after the guard that ensures medications are loaded:
  ```javascript
  async function loadHistory() {
      // Ensure medications are loaded for name resolution
      if (medications.length === 0) await loadMeds();
      populateMedFilter();   // <-- add this line
      ...
  ```
- [x] Add a test to `web/static/js/tests/app.medication-history.test.js` that verifies the filter is correctly populated when `medications` is already pre-populated (simulating the bootstrap path where `loadMeds()` is skipped)
- [x] Run frontend tests (`npx vitest run` from `web/static/js`) — must pass

### Task N: Verify acceptance criteria

- [ ] manual test: open the app, navigate directly to the History sub-tab without visiting Schedule first — combobox should show medication names
- [ ] manual test: navigate to History sub-tab after visiting Schedule — combobox still works correctly
- [ ] run full test suite: `go test ./...` and frontend tests
- [ ] move this plan to `docs/plans/completed/`
---
