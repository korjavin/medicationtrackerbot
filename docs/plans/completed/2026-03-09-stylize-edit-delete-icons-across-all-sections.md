---
# Stylize Edit/Delete Icons Across All Sections and Tabs

## Overview
Replace the current inconsistent edit/delete UI elements (× character, text labels "Edit"/"Del", clickable divs) with uniformly styled emoji buttons (🗑️ for delete, ✏️ for edit) across all tabs. Two visual variants: inline list icons (compact, subtle) and modal action buttons (larger, more prominent).

## Context
- Files involved:
  - `web/static/css/styles.css` — add two new button style classes
  - `web/static/js/components/action-row.js` — update createDeleteButton() factory
  - `web/static/js/features/bp.js` — delete button on BP readings
  - `web/static/js/features/weight.js` — delete button on weight logs
  - `web/static/js/features/food.js` — delete/edit in daily log, meals, food DB
  - `web/static/js/app.js` — medications schedule delete + edit trigger area
  - `web/static/js/workout.js` — delete button on workout groups
- Related patterns: action-row.js already has a createDeleteButton() factory; extend it
- Dependencies: none (no external libraries)

## Development Approach
- Testing approach: no automated tests needed for pure visual/styling changes; manual verification across tabs
- Complete each task fully before moving to the next

## Implementation Steps

### Task 1: Define shared CSS classes for both button variants

**Files:**
- Modify: `web/static/css/styles.css`

- [ ] Add `.icon-action-btn` class for inline list icons: small (24px), transparent background, subtle hover state, no border, cursor pointer
- [ ] Add `.modal-action-btn` class for modal buttons: slightly larger (32px), pill-shaped with light background, hover highlight, cursor pointer
- [ ] Add color variants: `.icon-action-btn.delete` and `.modal-action-btn.delete` with red tint on hover
- [ ] Keep existing `.delete-btn` temporarily for backwards compat during migration (remove at end)
- [ ] Remove or consolidate `.btn-small` / `.small-btn.secondary` duplication once all consumers updated

### Task 2: Update createDeleteButton() factory and add createEditButton()

**Files:**
- Modify: `web/static/js/components/action-row.js`

- [ ] Change createDeleteButton() to emit 🗑️ emoji with `.icon-action-btn.delete` class instead of `×` with `.delete-btn`
- [ ] Add createEditButton(onClick) factory that emits ✏️ with `.icon-action-btn` class
- [ ] Add createModalDeleteButton(onClick) and createModalEditButton(onClick) factories using `.modal-action-btn` class for use inside modals

### Task 3: Update Blood Pressure tab

**Files:**
- Modify: `web/static/js/features/bp.js`

- [ ] Replace inline delete button construction with createDeleteButton() from action-row.js
- [ ] Verify 🗑️ renders correctly in BP reading list items

### Task 4: Update Weight tab

**Files:**
- Modify: `web/static/js/features/weight.js`

- [ ] Replace inline delete button construction with createDeleteButton() from action-row.js
- [ ] Verify 🗑️ renders correctly in weight log list items

### Task 5: Update Medications tab

**Files:**
- Modify: `web/static/js/app.js`

- [ ] Replace `×` delete button in schedule list with createDeleteButton()
- [ ] Add explicit ✏️ edit icon button next to delete in the actions area (replaces clickable .med-info div pattern or supplements it)
- [ ] Verify both icons render correctly in the schedule list

### Task 6: Update Food tab (all three sub-tabs)

**Files:**
- Modify: `web/static/js/features/food.js`

- [ ] Daily log: replace `×` delete with createDeleteButton(); add createEditButton() for explicit edit trigger alongside the clickable item
- [ ] My Meals: replace "Del" text button with createDeleteButton(); replace "Edit" text button with createEditButton()
- [ ] Food DB: replace "Edit"/"Del" `.btn-small` text buttons with createEditButton()/createDeleteButton()

### Task 7: Update Workout tab

**Files:**
- Modify: `web/static/js/workout.js`

- [ ] Replace `×` delete button on workout group cards with createDeleteButton()
- [ ] Verify 🗑️ renders correctly on group cards

### Task 8: Update modal action buttons (where delete/edit appear inside modals)

**Files:**
- Modify: `web/static/js/features/food.js`, `web/static/js/app.js`, `web/static/js/workout.js`

- [ ] Identify all delete/edit buttons rendered inside modal dialogs
- [ ] Replace those instances with createModalDeleteButton()/createModalEditButton() using `.modal-action-btn` class
- [ ] Visually distinguish modal buttons from list icons (larger, with background)

### Task 9: Cleanup and final verification

**Files:**
- Modify: `web/static/css/styles.css`

- [ ] Remove deprecated `.delete-btn` class now that all consumers are updated
- [ ] Remove unused `.btn-small` / `.small-btn.secondary` if fully replaced
- [ ] Manual test: open each tab and verify icons are uniform
- [ ] Check dark mode / Telegram theme variables still work with new button styles
- [ ] Run `go test ./...` to ensure no backend regressions

### Task 10: Update documentation

- [ ] No README changes needed (visual-only change)
- [ ] Move this plan to `docs/plans/completed/`
---
