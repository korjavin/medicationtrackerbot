# Improve Food Daily Log Calendar Navigation

## Overview
Make the date navigation in the Food Daily Log tab more compact, show a human-friendly date label that opens the native date picker on click/focus, add a small "Today" chip that appears only when viewing a past date, and disable the next button when already on today.

## Context
- Files involved:
  - `web/static/index.html` (date nav HTML, lines 161-171)
  - `web/static/js/features/food.js` (shiftFoodDate, loadFoodLogs, bindFoodControls)
  - `web/static/css/styles.css` (food-date-nav styles, lines 1447-1466)
- Related patterns: shiftFoodDate uses `food-date-filter` input; food-week-display overlays label with pointer-events:none
- Dependencies: none

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Compact nav with click-to-open date picker and Today chip

**Files:**
- Modify: `web/static/index.html`
- Modify: `web/static/js/features/food.js`
- Modify: `web/static/css/styles.css`

- [ ] Reduce button size in `.food-date-shift-btn`: shrink to 36px height/width, smaller font
- [ ] Reduce `.food-date-nav` gap and margin-bottom
- [ ] Add a `<span id="food-date-label">` inside the date input wrapper; style it to overlay the raw input with a human-friendly label (Today / Yesterday / Mon Mar 9), pointer-events:none so clicks pass through to the underlying `<input type="date">` — this gives "open calendar on focus/click" without any extra icon
- [ ] Add `<button id="food-today-btn" class="food-today-chip">Today</button>` after the next button; hidden (display:none) when already on today
- [ ] Add `.food-today-chip` CSS: small inline chip style (compact height, muted appearance)
- [ ] Implement `formatFoodDateLabel(dateStr)` in food.js: returns "Today", "Yesterday", or short locale date
- [ ] Implement `updateFoodDateNav()`: updates label text, hides/shows Today chip, disables next button when on today
- [ ] Bind `food-today-btn` click to set date to today and reload
- [ ] Call `updateFoodDateNav()` at end of `shiftFoodDate()`, `goFoodToday()`, and `loadFoodLogs()`
- [ ] Write tests for `formatFoodDateLabel` and `updateFoodDateNav` logic in `app.food-utils.test.js`
- [ ] Run `cd web/static/js/tests && npm test` — must pass before task 2

### Task 2: Verify acceptance criteria

- [ ] Manual test: Food tab → Daily Log shows compact nav row (noticeably smaller than before)
- [ ] Manual test: clicking/tapping the date label area opens the native calendar picker
- [ ] Manual test: navigate back a few days → Today chip appears; click it → returns to today
- [ ] Manual test: on today → next button is disabled, Today chip is hidden
- [ ] Manual test: label reads "Today", "Yesterday", or short date correctly
- [ ] Run full test suite: `go test ./...` and `cd web/static/js/tests && npm test`

### Task 3: Update documentation

- [ ] No README changes needed (internal UI improvement)
- [ ] Move this plan to `docs/plans/completed/`
