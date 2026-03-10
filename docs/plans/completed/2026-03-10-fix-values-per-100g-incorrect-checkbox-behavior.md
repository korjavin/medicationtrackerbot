# Fix values-per-100g incorrect checkbox behavior

## Overview
The "Values are per 100g" checkbox in the food log modal has two bugs:
1. `onFoodCaloriesFocus` silently unchecks the checkbox and converts macro values when the user focuses the calories field — this is invisible to the user and corrupts values.
2. `onFoodPer100gChange` converts macro values in-place when unchecking (multiplies by weight/100). This is irreversible: re-checking doesn't restore the originals, so repeated toggling produces nonsense.

The fix: the checkbox should be a pure mode indicator. Toggling it changes how values are *interpreted*, not the values themselves. `calculateFoodCalories()` and `computeFoodTotals()` already handle the per-100g multiplier correctly — no value mutation is needed on toggle.

## Context
- Files involved: `web/static/js/features/food.js`, `web/static/js/tests/app.food-utils.test.js`
- Related patterns: existing Jest tests in `web/static/js/tests/`
- Dependencies: none

## Two Use Cases

**Case 1 — product/barcode mode**: macros come from DB as per-100g values, checkbox is auto-checked, user enters weight, calories calculate from `macros × weight / 100`. If user edits macros or weight, calories recalculate. Checkbox stays checked.

**Case 2 — manual entry mode**: user enters total calories (and optionally macros as totals), unchecks per-100g. No recalculation triggered by the checkbox toggle itself.

In both cases: toggling the checkbox should NOT mutate the macro values. It only changes how the existing values are interpreted.

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Remove auto-uncheck on calories focus

**Files:**
- Modify: `web/static/js/features/food.js`

- [ ] Delete the body of `onFoodCaloriesFocus` (or the entire function and its binding). When user focuses the calories field, do nothing special — the user can manually edit it without the checkbox changing.
- [ ] Remove or no-op the `bindFocus('food-calories', ...)` call in `bindFoodControls` if it only called `onFoodCaloriesFocus`.
- [ ] Verify `calculateFoodCalories()` only updates calories when `per100g` is true or calories field is empty — this logic already handles it correctly.

### Task 2: Remove value mutation from onFoodPer100gChange

**Files:**
- Modify: `web/static/js/features/food.js`

- [ ] In `onFoodPer100gChange`, remove the block that converts carbs/protein/fat values when unchecking. The function body should only call `calculateFoodCalories()`.
- [ ] After the change, `onFoodPer100gChange` becomes: check/uncheck → recalculate calories display only, without touching macro fields.

### Task 3: Verify behavior of calculateFoodCalories after fix

**Files:**
- Modify: `web/static/js/features/food.js` (no change expected, just confirm)

- [ ] Confirm that `calculateFoodCalories()` already correctly: when `per100g=true`, uses `(macros * weight) / 100` to compute calories; when `per100g=false`, uses macro values directly as totals. No code change needed here.
- [ ] Confirm `computeFoodTotals()` (used on save) applies the `weight/100` multiplier correctly independent of the checkbox fix.

### Task 4: Write tests covering the fixed behavior

**Files:**
- Modify: `web/static/js/tests/app.food-utils.test.js`

Test cases to add:
- [ ] **TC1**: Select product (per-100g=true, carbs=50, weight=200) → calories = 50*200/100*4 = 400. Toggle checkbox off → carbs still 50, calories recalc as 50*4=200. Toggle back on → carbs still 50, calories = 400.
- [ ] **TC2**: Focus calories field while per-100g is checked → checkbox stays checked, calories field is editable, macro values unchanged.
- [ ] **TC3**: Manual entry (per-100g=false, carbs=30, protein=20, fat=10, no weight) → calories = 30*4+20*4+10*9 = 290. Checkbox stays unchecked, no recalculation.
- [ ] **TC4**: Toggle checkbox multiple times → macro values never change (only calories display changes based on mode).
- [ ] Run: `npx jest web/static/js/tests/ --no-coverage` or equivalent

### Task 5: Verify acceptance criteria

- [ ] Manual test: open food modal, scan/select a product → per-100g auto-checked, macros show per-100g values
- [ ] Manual test: click calories field → checkbox does NOT auto-uncheck, values unchanged
- [ ] Manual test: uncheck per-100g → macro values stay the same, calories recalculate using values as totals
- [ ] Manual test: re-check per-100g → macro values still the same (original per-100g), calories recalculate back using weight factor
- [ ] Manual test: save with per-100g checked + weight → stored as totals (correct)
- [ ] Run full test suite: `go test ./...` + JS tests

### Task 6: Update documentation

- [ ] No README changes needed (internal UX fix)
- [ ] Move plan to `docs/plans/completed/`
