# Today: "Scan food" shortcut tile

## Overview
Add a new shortcut tile on the Today page labelled "Scan food" that, when tapped, opens the Add Food modal and immediately launches the barcode scanner overlay. Currently the user has to: Today → tap Food (nav) → tap "Add food" → tap "Scan" inside the modal. That's 3 taps for a frequent action. After this change it becomes a single tap from Today.

The tile sits in the existing Today shortcut row (`renderShortcutRow` in `web/static/js/features/today.js:706-739`), alongside "Log food" and "Photo meal". It is only shown when the food feature is enabled (same gating as the existing food shortcuts — `state.caloriesTarget.status !== 'disabled'`).

## Context (from discovery)
Files/components involved:
- `web/static/js/features/today.js` — shortcut row + handler wiring (`renderShortcutRow` ~L706, `renderToday` opts ~L990)
- `web/static/js/features/food/log.js:273` — `showAddFoodModal()` (exposed as `window.FoodLog.openAdd`)
- `web/static/js/features/food/scanner.js:177` — `openFoodScannerModal()` (calls `window.ModalManager.foodScanner.open()`)
- `web/static/js/features/food/index.js:38-40` — existing `food-scan-btn` already uses the `'barcode'` icon from `window.WGIcons.iconSvg('barcode', …)`, so the icon is available
- `web/static/js/tests/today.shortcut-photo-meal.test.js` — direct template for the new tile's test
- `web/static/js/tests/today.render.test.js` — render-level smoke test

Related patterns found:
- Each shortcut handler in `renderToday` is sourced from `opts.onX` with a default that hits a global (e.g. `opts.onLogFood || defaultHandler('showAddFoodModal', 'food')`). The default for the new tile must open the modal AND fire the scanner.
- `renderShortcutTile(iconName, label, onClick)` is the helper — no new helper needed.
- Existing `food-scan-btn` (header chip in the Food section) just calls `openFoodScannerModal()` and lets the scanner auto-fill `#food-barcode` once the modal is opened separately. The new tile compresses both steps into one tap from Today.

Dependencies identified:
- `window.FoodLog.openAdd` (must exist for the default handler)
- `window.FoodScanner` and `window.ModalManager.foodScanner.open()` (scanner overlay)
- `window.WGIcons.iconSvg('barcode', …)` (already used by food header, no new icon needed)

## Development Approach
- **Testing approach**: Regular (code first, then tests) — frontend tests in this project are integration-first via `tests/helpers/frontend-harness.js` and the existing `today.shortcut-photo-meal.test.js` is the direct template.
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
- **CRITICAL: all tests must pass before starting next task** — `pnpm test` must be green
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility — defaults for `opts.onScanFood` must work even if a caller passes no handler

## Testing Strategy
- **Unit/integration tests (Vitest)**: extend the existing Today render tests
  - assert the tile is present in the shortcut row when food is enabled
  - assert it is absent when food is disabled (`state.caloriesTarget.status === 'disabled'`)
  - assert clicking it invokes the supplied `onScanFood` handler
  - assert the default `onScanFood` handler calls both `window.FoodLog.openAdd` and `window.FoodScanner.openFoodScannerModal` (or the equivalent global)
- No new e2e tests needed — this project does not use Playwright/Cypress for the frontend.

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): code + tests in this repo
- **Post-Completion** (no checkboxes): manual on-device verification of the tap-through

## Implementation Steps

### Task 1: Add "Scan food" shortcut tile to Today
- [x] in `web/static/js/features/today.js` `renderShortcutRow`, append a third tile under the food-enabled block: `renderShortcutTile('barcode', 'Scan food', () => handlers.onScanFood && handlers.onScanFood())`. Order in the row: Log food → Scan food → Photo meal (Scan placed between because it's the new fast-path and the user wants it prominent).
- [x] in `renderToday`, add `const onScanFood = opts.onScanFood || ...defaultHandler...` that:
  - calls `window.FoodLog.openAdd()` if present (opens the Add Food modal)
  - then calls `window.FoodScanner.openFoodScannerModal()` if `window.FoodScanner` is present, otherwise falls back to `window.ModalManager?.foodScanner?.open?.()`
  - both calls are guarded (`typeof === 'function'`) so the handler is a no-op if globals aren't loaded yet (matches how `onPhotoMeal` guards `window.FoodActions`)
- [x] pass `onScanFood` into the `renderShortcutRow(state, { onLogFood, onPhotoMeal, onAddBp, onAddWeight, onScanFood })` call (~L1056-1058)
- [x] write Vitest test `web/static/js/tests/today.shortcut-scan-food.test.js` modeled on `today.shortcut-photo-meal.test.js`:
  - tile renders with label "Scan food" when food is enabled
  - tile is absent when `state.caloriesTarget.status === 'disabled'`
  - clicking the tile invokes the provided `onScanFood` spy
- [x] write a second Vitest test (same file or extend the first) for the default handler path:
  - stub `window.FoodLog.openAdd` and `window.FoodScanner.openFoodScannerModal` as spies, omit `onScanFood` from opts, click the tile, assert both spies fired
  - additionally cover the `ModalManager.foodScanner.open` fallback path when `window.FoodScanner` is not defined
- [x] run `pnpm test` — all tests must pass before next task

### Task 2: Verify Today render snapshot/golden tests still pass
- [x] run the full `pnpm test` suite — `today.render.test.js`, `today.render.wg.test.js`, `today.aggregate.test.js`, `bootstrap.today-default.test.js`, and any architecture tests (`tests/architecture.globals.test.js`) must stay green
- [x] update existing render tests that hard-coded the shortcut tile count (4 → 5) and the photo-meal positional assertion (`logFoodIdx + 1` → `> logFoodIdx`) — `today.render.test.js` and `today.shortcut-photo-meal.test.js`
- [x] no `window.*` allowlist change needed — only reads existing globals (`window.FoodLog`, `window.FoodScanner`, `window.ModalManager`)

### Task 3: Verify acceptance criteria
- [x] re-read the Overview — tile is named "Scan food", visible on Today when food is enabled, single tap opens add-food modal + scanner overlay
- [x] no other section needs editing (BP / weight / workouts untouched)
- [x] full test suite green except for one pre-existing TZ-Berlin flake in `health.dexie-hydration.test.js:230` (the test asserts the harness TZ ≠ Europe/Berlin, which fails on this machine; unrelated to this change)
- [x] no architecture-test regressions

### Task 4: [Final] Update documentation if needed
- [x] `docs/frontend.md` does not enumerate Today shortcut tiles, so no doc edit is needed
- [x] CLAUDE.md unchanged (bottom-nav rule is unaffected — shortcut tiles are not nav)

## Technical Details

### Why this UX is one tap
The Add Food modal and the Food Scanner overlay are independent global modals (both opened via `window.ModalManager`). They can be opened in sequence without `switchTab('food')`, because the modals float over whatever section is active. So a tap on the Today tile that fires `FoodLog.openAdd()` + `FoodScanner.openFoodScannerModal()` lands the user directly in the scanner with the Add Food modal queued behind it.

When the scanner detects a barcode, `scanner.js` already:
1. sets `#food-barcode` input (which is inside the now-open Add Food modal)
2. calls `onFoodBarcodeChange()` to autofill product details from the products DB
3. closes the scanner overlay automatically

The user is left with a pre-filled Add Food modal ready to confirm — exactly the desired flow.

### Tile placement and gating
- Gating: the new tile sits inside the `if (foodCell && foodCell.status !== 'disabled')` block so it shares the same enable/disable logic as Log food + Photo meal.
- Order: `Log food → Scan food → Photo meal`. Scan food sits second because (a) it is the new fast-path the user explicitly asked for, (b) keeping Log food first preserves muscle memory for users who tap by position.
- Icon: `'barcode'` (already in `WGIcons` and used by `food-scan-btn` — proves it renders at small sizes).

### Default-handler signature
```js
const onScanFood = opts.onScanFood || (() => {
    if (typeof window === 'undefined') return;
    if (window.FoodLog && typeof window.FoodLog.openAdd === 'function') {
        window.FoodLog.openAdd();
    }
    if (window.FoodScanner && typeof window.FoodScanner.openFoodScannerModal === 'function') {
        window.FoodScanner.openFoodScannerModal();
    } else if (window.ModalManager
        && window.ModalManager.foodScanner
        && typeof window.ModalManager.foodScanner.open === 'function') {
        window.ModalManager.foodScanner.open();
    }
});
```

### Files touched
- `web/static/js/features/today.js` (one new tile, one new handler, one new opts key)
- `web/static/js/tests/today.shortcut-scan-food.test.js` (new test file)

## Post-Completion
*Items requiring manual intervention or external systems — no checkboxes, informational only*

**Manual verification on a real phone** (this is a camera-dependent feature, jsdom can't cover it):
- Open the Mini App on a phone, land on Today, tap "Scan food"
- The Add Food modal should open AND the scanner overlay should appear on top
- Point camera at a product barcode (EAN-13 e.g. any grocery item)
- After decode: scanner overlay closes, Add Food modal stays open with name/barcode/macros pre-filled from the products DB
- Confirm + submit the entry, check it shows up in today's food log
- Edge: tap "Scan food" while the food feature is disabled in Settings — tile should not be rendered (verified by unit test, but confirm on device)
- Edge: deny camera permission → scanner shows a permission error (existing behavior, unchanged)
