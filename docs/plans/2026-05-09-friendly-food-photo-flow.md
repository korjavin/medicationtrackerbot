# Friendly Food-from-Photo Flow

## Overview

The "log food from photo" feature already works end-to-end (Photo button → upload → AI vision → save), but the UX has rough edges:

1. **Save confirmation is a browser `alert()`** — jarring, blocks the page, and offers no recovery if the AI parsed something wrong.
2. **The Photo button looks subordinate to Add** — it uses the secondary (outline) toolbar variant, while Add is primary (yellow filled), suggesting Photo is a lesser action when in fact it's the most useful one for a busy user.
3. **No fast access from Today** — users must first navigate to the Food section before they can snap a meal, even though "log a meal right now" is the most common Today action.

This plan addresses all three:

- **Replace the alert with a friendly in-app summary card/toast** that shows the parsed items, total kcal/macros, and an Undo button (deletes all just-logged items via the existing `DELETE /api/food/log/{id}` endpoint).
- **Restyle the Photo button** to match the Add button (primary yellow), with a small camera icon to differentiate.
- **Add an "Add food from photo" shortcut tile to the Today screen** that opens the camera/gallery picker directly (no Food-section detour) and routes results into the same summary card.

## Context (from discovery)

**Files involved:**
- `web/static/index.html` — toolbar button markup (`#add-food-photo-btn`, `#add-food-inline-btn`) at lines 234–239
- `web/static/js/features/food.js` — `triggerFoodPhotoPicker()` (804–810), `uploadFoodPhoto()` (812–871), `deleteFoodLog()` (existing delete path)
- `web/static/js/features/today.js` — `renderShortcutTile()` (595–615), `renderShortcutRow()` (617–646), `iconSvgOrNull()` icon helper
- `web/static/js/components/wg-icons.js` — icon registry (camera icon already exists at line 39)
- `web/static/js/sync.js` — `window.SyncManager.showToast(message, type)` exists at lines ~140–150 (used elsewhere in food.js for save success)
- `web/static/js/core/modal-controller.js` — `withSubmit()` double-submit guard (12–29)
- `web/static/css/styles.css` — `.wg-toolbar-btn--primary/--secondary` (3427–3483), `.wg-shortcut-tile` styles
- `internal/server/food_handlers.go` — `POST /api/food/log/from-photo` handler (155–284); `handleDeleteFoodLog` for undo
- `internal/domain/food_ai.go` — `ParseMealPhoto()` AI vision wrapper (64–78)

**Patterns found:**
- The app already has a toast system (`SyncManager.showToast`) but the photo flow uses a plain `alert()` instead. We just need to swap to a richer summary component for this case.
- `wg-shortcut-tile` is the established Today shortcut pattern; new tiles slot into `renderShortcutRow()`.
- The Vision endpoint returns `{ items: [{id, name, weight, carbs, protein, fat, calories}], failed }` — the `id` field is what we need for Undo (call `DELETE /api/food/log/{id}` for each).
- Camera icon is already in the icon registry — no SVG work needed.

**Dependencies:** none new. All endpoints, helpers, and design tokens needed already exist.

## Development Approach

- **Testing approach**: Regular (code first, then tests), per project convention.
- Complete each task fully before moving to the next.
- Make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task — write Vitest tests for new frontend logic (summary card render, undo handler, shortcut wiring) and Go unit tests for any backend response-shape changes.
- **CRITICAL: all tests must pass before starting next task** — run `go test ./...` and `pnpm test` after each change.
- **CRITICAL: update this plan file when scope changes during implementation.**

## Testing Strategy

- **Unit tests (Go)**: cover any backend response-shape changes to `/api/food/log/from-photo` (e.g. ensuring `id` is present in each item so the frontend can issue Undo deletes).
- **Frontend tests (Vitest + jsdom)**: cover the new summary card render, the undo handler (mock fetch, assert N delete calls), the photo button restyle (asserting class change), and the Today shortcut wiring (assert tile renders + click triggers picker).
- **Architecture tests**: confirm no inline `.style.` assignments or hardcoded colors are introduced (project rule from CLAUDE.md).
- **Manual UI verification**: see Post-Completion (running dev server + checking the actual photo flow in browser).

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]`): code changes, tests, doc updates achievable in-repo.
- **Post-Completion**: manual UI verification, deployment notes — no checkboxes.

## Implementation Steps

### Task 1: Verify backend returns item IDs in photo-log response

The summary card's Undo needs to delete each just-logged food item by ID. Before building the frontend, confirm the backend already returns IDs (it appears to, but verify and lock it in with a test).

- [x] read `internal/server/food_handlers.go` `handlePostFoodLogFromPhoto` (155–284) and verify the response includes `id` for each item
- [x] if `id` is missing, update the handler to include it (use the ID returned by `s.food.CreateFoodLog`) — already present (savedItem.ID at line 232, populated at line 261); no handler change needed
- [x] write/extend a Go unit test in `internal/server/food_handlers_test.go` that posts a photo (with a stub vision client) and asserts each item in the response has a non-zero `id`
- [x] run `go test ./internal/server/...` — must pass before next task

### Task 2: Restyle Photo button to match Add button (primary + camera icon)

- [x] in `web/static/index.html` (lines 234–239), change `#add-food-photo-btn` class from `wg-toolbar-btn wg-toolbar-btn--secondary` to `wg-toolbar-btn wg-toolbar-btn--primary`
- [x] add a camera icon span inside the button before the label — already injected at runtime by `renderFoodInlineAddIcon()` in `food.js:37-40` via `WGIcons.iconSvg('camera', { size: 14 })`, matching how the inline Add button gets its plus icon (project pattern is `WGIcons.iconSvg`, not a `<wg-icon>` custom element); no markup change required
- [x] CSS rule for icon spacing — not needed: the base `.wg-toolbar-btn` rule already sets `display: inline-flex` + `gap: var(--space-xs)` + `align-items: center`, so the prepended SVG and the `.wg-toolbar-btn__label` span sit side-by-side with the canonical token-driven gap (same path the Add button uses for its plus icon — no per-button CSS there either)
- [x] verify the existing "Analyzing…" label-swap in `food.js:823` (`originalLabel.textContent = 'Analyzing…'`) still works with the icon present — the swap targets `.wg-toolbar-btn__label`, which remains a separate sibling of the prepended icon, so it's unaffected
- [x] update `food.toolbar-row.test.js` to assert the Photo button has `wg-toolbar-btn--primary` (was `--secondary`) AND contains an `svg[data-wg-icon="camera"]` child rendered by `WGIcons.iconSvg` at bind time
- [x] run `pnpm test` — passes (the only 2 failures are pre-existing date-sensitive flakes in `components.wg-sleep-chart.test.js` and `components.wg-steps-chart.test.js`, confirmed by re-running on `git stash`'d clean tree)

### Task 3: Build the in-app summary card component

A reusable card/toast that shows after a successful photo upload: lists each item (name, weight, kcal), shows total kcal + macros, and offers an Undo button.

- [ ] create `web/static/js/features/food-photo-summary.js` exporting `showFoodPhotoSummary({ items, onUndo })` — appends a card to a designated mount point (e.g. body or a toast region) with auto-dismiss after ~8s and an explicit close button
- [ ] structure the card with semantic markup using `wg-*` tokens for all colors/spacing (no inline styles, no hardcoded colors — enforced by architecture tests)
- [ ] include: header ("Logged from photo"), per-item rows (name, weight in g, kcal), totals row (sum of kcal/carbs/protein/fat), Undo button, close button
- [ ] add the corresponding CSS rules in `web/static/css/styles.css` under a `.wg-food-photo-summary` block, using existing tokens
- [ ] register the new script in `web/static/index.html` in the correct load order (after `food.js` is loaded, or imported by it)
- [ ] write Vitest tests covering: card renders with correct items + totals; clicking Undo fires the `onUndo` callback exactly once; clicking close dismisses the card; auto-dismiss timer dismisses the card
- [ ] run `pnpm test` — must pass before next task

### Task 4: Wire summary card + Undo into the photo upload flow

Replace the `alert()` in `uploadFoodPhoto` with the new summary card and implement the Undo handler.

- [ ] in `web/static/js/features/food.js` `uploadFoodPhoto()` (812–871), after a successful response, replace the `alert(\`Logged ${n} items: ...\`)` call with `showFoodPhotoSummary({ items: data.items, onUndo: () => undoFoodPhotoLog(data.items) })`
- [ ] add a new `undoFoodPhotoLog(items)` function in `food.js` that issues `DELETE /api/food/log/{id}` for each item in parallel (`Promise.all`), invalidates the food-log cache, and reloads the food list + Today (mirroring what `deleteFoodLog` already does)
- [ ] on Undo success, swap the summary card content to a brief "Removed N items" confirmation with the close button, then auto-dismiss
- [ ] on Undo failure (any delete returns non-OK), show an error state in the card with a retry button
- [ ] keep the existing `loadFoodLogs()` / `loadToday()` refresh on the original success path
- [ ] write Vitest tests: success → summary shown; clicking Undo → fetch called N times with DELETE; partial failure → error state displayed
- [ ] run `pnpm test` — must pass before next task

### Task 5: Expose photo picker as a callable function

For the Today shortcut to trigger the same picker, factor `triggerFoodPhotoPicker()` so it's invokable from outside the food section even before the user has navigated there.

- [ ] in `web/static/js/features/food.js`, ensure `triggerFoodPhotoPicker()` is exposed as `window.FoodActions = window.FoodActions || {}; window.FoodActions.triggerPhotoPicker = triggerFoodPhotoPicker;` (or add to the existing food namespace if one exists)
- [ ] **add `window.FoodActions` to the allowlist** in `tests/architecture.globals.test.js` with a justification comment per CLAUDE.md rule #4
- [ ] confirm the file input (`#food-photo-input`) is rendered into the DOM at startup, not lazily when the food section mounts — if it's lazy, hoist its markup to `index.html` so the picker works from Today without first visiting Food
- [ ] verify the change handler that calls `uploadFoodPhoto(input)` is bound at startup (not on food-section mount) for the same reason
- [ ] write a Vitest test that mocks the file input and asserts `window.FoodActions.triggerPhotoPicker()` calls `.click()` on the input
- [ ] run `pnpm test` — must pass before next task

### Task 6: Add "Add food from photo" shortcut to Today

- [ ] in `web/static/js/features/today.js` `renderShortcutRow()` (617–646), add a new tile after the existing "Log food" tile, only when the food feature is enabled
- [ ] use `renderShortcutTile('camera', 'Photo meal', () => window.FoodActions.triggerPhotoPicker())` (label can be tuned — keep it short to match existing tiles)
- [ ] verify the row layout still looks balanced with one extra tile (consider whether to wrap to a second row if it overflows; check existing `.wg-today-shortcuts` CSS for flex/wrap behavior)
- [ ] write a Vitest test in `tests/` that renders the Today shortcut row with food enabled and asserts a tile with label "Photo meal" exists; clicking it invokes `window.FoodActions.triggerPhotoPicker`
- [ ] run `pnpm test` — must pass before next task

### Task 7: Verify acceptance criteria

- [ ] Photo button on Food section uses primary style + camera icon
- [ ] Photo upload no longer shows a browser `alert()` — the in-app summary card appears instead
- [ ] Summary card lists items with weight + kcal and a totals row
- [ ] Undo button on summary deletes all just-logged items and refreshes Food + Today
- [ ] Today screen shows a "Photo meal" shortcut tile when food feature is enabled
- [ ] Tapping the Today shortcut opens the picker directly (no navigation to Food first)
- [ ] After picking a photo from Today, the same summary card flow runs
- [ ] No hardcoded colors or inline `.style.` assignments introduced (architecture tests pass)
- [ ] No new `window.*` global without an allowlist entry
- [ ] Run `go test ./...` — all pass
- [ ] Run `pnpm test` — all pass
- [ ] Run linter (whatever the project uses, e.g. `go vet ./...`) — clean

### Task 8: Update documentation

- [ ] update `docs/features.md` food section to mention the photo flow (new behavior: in-app summary + Undo, Today shortcut)
- [ ] no `docs/api.md` change needed if the photo endpoint response shape didn't change (only verified `id` presence in Task 1)

*Note: ralphex automatically moves completed plans to `docs/plans/completed/`*

## Technical Details

**Summary card data shape** (input to `showFoodPhotoSummary`):
```js
{
  items: [{ id, name, weight, carbs, protein, fat, calories }, ...],
  onUndo: () => Promise<void>
}
```

**Totals computed inside the card** (sum across items):
- kcal, carbs (g), protein (g), fat (g)

**Undo flow:**
1. User clicks Undo
2. Disable Undo button (use `withSubmit` pattern)
3. `Promise.all(items.map(it => fetch(\`/api/food/log/${it.id}\`, { method: 'DELETE', headers: { 'X-Telegram-Init-Data': window.userInitData } })))`
4. On all-success: invalidate food cache, call `loadFoodLogs()` + `loadToday()`, swap card to "Removed N items"
5. On any failure: show error state with retry

**Today shortcut wiring:** lives behind `window.FoodActions.triggerPhotoPicker`, which is the same function the in-section Photo button uses. The hidden `<input id="food-photo-input">` and its `change` handler must be bound at app startup (not on food-section mount) so a Today tap works even on a cold session.

**Button restyle:** purely a class change + icon insertion in `index.html`; no JS behavior change. The "Analyzing…" label swap continues to work because it targets `.wg-toolbar-btn__label`, which remains a sibling of the new icon.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only*

**Manual UI verification:**
- Open the app in a browser via `go run ./cmd/bot`, navigate to Food, tap Photo, pick a real food image. Confirm the summary card looks polished (correct totals, no overflow on small screens, Undo works).
- Repeat from the Today screen via the new shortcut tile — confirm it opens the picker without first visiting Food.
- Test on a Telegram WebApp host (real device) since native file pickers behave differently than desktop browsers.
- Test the error path: stub the AI to fail (e.g. unset the vision API key) and confirm the error message surfaces in a friendly way (not as a card stuck in the "analyzing" state).

**Performance check:**
- A large photo (~8 MB) + 60 s vision timeout means users stare at "Analyzing…" for a while. The current label swap is fine; consider whether the Today shortcut tile should also indicate progress (out of scope for this plan, but worth noting).
