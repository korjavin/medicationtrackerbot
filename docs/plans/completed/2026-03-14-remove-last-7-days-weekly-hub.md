---
# Remove Last 7 Days Weekly Hub from Medicine Schedule Tab

## Overview
Remove the "Last 7 Days" round-indicator widget from the medication schedule tab and clean up all related code. The backend `/api/history` endpoint is kept because the History tab still uses it.

## Context
- Files involved:
  - `web/static/js/app.js` — contains local `renderWeeklyHub()` that renders circles, and the `loadMeds` wrapper that invokes it
  - `web/static/index.html` — contains `#weekly-hub-container` div in the schedule tab
  - `web/static/css/styles.css` — contains `#weekly-hub-container`, `.weekly-header`, `.weekly-days`, `.day-column`, `.day-label`, `.day-circle`, `.day-date` rules
  - `web/static/js/features/hub.js` — dead code file (never loaded in index.html), defines `window.loadWeeklyHub` / `window.renderWeeklyHub` as a stats card variant; delete it
  - `web/static/js/tests/app.medication-history.test.js` — last ~14 lines of one test assert on `renderWeeklyHub` output
  - `web/static/js/tests/app.loadmeds-bp-swipe-edges.test.js` — first test verifies `renderWeeklyHub` is called after `loadMeds`
  - `web/static/js/tests/architecture.globals.test.js` — allowlist includes `window.loadWeeklyHub` and `window.renderWeeklyHub`
- Related patterns: standard frontend deletion — remove HTML, CSS, JS, and corresponding tests
- Dependencies: none; backend `/api/history` is untouched

## Development Approach
- Testing approach: Regular (update existing tests to reflect removed code)
- Complete each task fully before moving to the next
- All tests must pass before moving to next task
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Remove weekly hub from app.js

**Files:**
- Modify: `web/static/js/app.js`

- [ ] Remove the `MED_COLORS` array constant (~5 lines)
- [ ] Remove the `getMedColor()` function (~3 lines)
- [ ] Remove `async function renderWeeklyHub()` entire function (~130 lines, including the `// --- Weekly Adherence Visualization ---` comment header)
- [ ] Remove the `loadMeds` wrapper block that calls `renderWeeklyHub()` (~6 lines)
- [ ] Run frontend tests to verify no regressions

### Task 2: Remove weekly hub HTML and CSS

**Files:**
- Modify: `web/static/index.html`
- Modify: `web/static/css/styles.css`

- [ ] Remove `<div id="weekly-hub-container"></div>` from the schedule tab in index.html
- [ ] Remove `/* Weekly Hub */` section from styles.css: `#weekly-hub-container`, `.weekly-header`, `.weekly-days`, `.day-column`, `.day-label`, `.day-circle`, `.day-date` blocks

### Task 3: Delete dead hub.js file

**Files:**
- Delete: `web/static/js/features/hub.js`

- [ ] Delete `web/static/js/features/hub.js` (never loaded in index.html, entirely dead code)

### Task 4: Update tests

**Files:**
- Modify: `web/static/js/tests/app.medication-history.test.js`
- Modify: `web/static/js/tests/app.loadmeds-bp-swipe-edges.test.js`
- Modify: `web/static/js/tests/architecture.globals.test.js`

- [ ] In `app.medication-history.test.js`: remove the weekly hub block at the end of the "next intake trigger" test (seedMedications call, apiCall mock, `renderWeeklyHub()` call, and the two `expect` assertions); update the test name to drop "weekly hub segmentation"
- [ ] In `app.loadmeds-bp-swipe-edges.test.js`: update "wrapped loadMeds runs original loader and then refreshes weekly hub" — remove `window.renderWeeklyHub = vi.fn()` mock and the `expect(window.renderWeeklyHub).toHaveBeenCalledTimes(1)` assertion; rename test to reflect it no longer checks hub refresh
- [ ] In `architecture.globals.test.js`: remove `window.loadWeeklyHub` and `window.renderWeeklyHub` entries and the `// features/hub.js — weekly summary widget` comment line
- [ ] Run frontend test suite — all tests must pass

### Task 5: Verify acceptance criteria

- [ ] Manual check: open schedule tab in browser, confirm no "Last 7 Days" section appears
- [ ] Run full frontend test suite: `npm test` (or equivalent in web/static)
- [ ] Run backend tests: `go test ./...`
- [ ] Confirm history tab still works (uses `/api/history` as before)

### Task 6: Update documentation

- [ ] Update CLAUDE.md to remove `window.loadWeeklyHub` and `window.renderWeeklyHub` entries from the Global Namespace Policy table
- [ ] Move this plan to `docs/plans/completed/`
