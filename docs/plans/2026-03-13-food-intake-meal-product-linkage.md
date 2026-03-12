# Food Intake: Visual Meal Indicator and Product/Meal Navigation Link

## Overview
Add linkage between food log entries and their source food products/meals. When a food log entry was added by selecting a product or meal from the local database, store the reference. In the food intake list and edit modal, visually indicate that the entry came from a local meal/product and provide a navigation link to it.

## Context
- Files involved:
  - `internal/store/migrations/` - new migration adding `product_id` to `food_log`
  - `internal/store/store.go` - FoodLog struct, AddFoodLog/UpdateFoodLog/GetFoodLogs methods
  - `internal/server/food_handlers.go` - request/response handling
  - `web/static/js/features/food.js` - frontend list rendering, edit modal, autocomplete
  - `web/static/index.html` - food modal HTML (add hidden field)
- Related patterns: existing goose migrations (numbered sequentially, currently up to 037)
- Key constraint: `food_log.product_id` must be nullable (SET NULL on delete) since products can be deleted independently

## Development Approach
- Testing approach: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: DB Migration — add product_id to food_log

**Files:**
- Create: `internal/store/migrations/038_food_log_product_id.sql`

- [ ] Create migration adding `product_id INTEGER REFERENCES food_products(id) ON DELETE SET NULL` to `food_log`
- [ ] No data tests needed for this task (migration only); verify it applies cleanly with `go run ./cmd/bot` dry-run or by checking goose output

### Task 2: Backend — update FoodLog struct and store methods

**Files:**
- Modify: `internal/store/store.go`

- [ ] Add `ProductID *int64 json:"product_id,omitempty"` and `IsMeal bool json:"is_meal,omitempty"` to `FoodLog` struct
- [ ] Update `AddFoodLog` to accept and persist `product_id`
- [ ] Update `UpdateFoodLog` to accept and persist `product_id`
- [ ] Update `GetFoodLogs` (or equivalent query) to LEFT JOIN `food_products` and populate `is_meal` based on `food_products.is_meal`
- [ ] Write store tests for AddFoodLog with product_id, and GetFoodLogs returning is_meal flag
- [ ] Run `go test ./internal/store` — must pass

### Task 3: Backend — update HTTP handlers

**Files:**
- Modify: `internal/server/food_handlers.go`

- [ ] Update `addFoodLogHandler` to read optional `product_id` from request JSON and pass to store
- [ ] Update `updateFoodLogHandler` similarly
- [ ] `getFoodLogsHandler` already returns FoodLog structs — no change needed if store returns is_meal
- [ ] Write/update handler tests for product_id round-trip
- [ ] Run `go test ./internal/server` — must pass

### Task 4: Frontend — track selected product_id in autocomplete

**Files:**
- Modify: `web/static/js/features/food.js`
- Modify: `web/static/index.html`

- [ ] Add hidden `<input type="hidden" id="food-product-id">` to the food modal in index.html
- [ ] When autocomplete item is selected (product chosen), set `food-product-id` value to the product's ID
- [ ] Clear `food-product-id` when name field is cleared/typed manually (not from autocomplete selection)
- [ ] In `showAddFoodModal()` and `editFoodLog()`, populate `food-product-id` from log's `product_id` if present
- [ ] In `saveFoodLog()`, include `product_id` in the POST/PUT payload (parse as int or null)
- [ ] Run frontend tests if any exist; verify manually

### Task 5: Frontend — visual meal indicator in food log list

**Files:**
- Modify: `web/static/js/features/food.js`

- [ ] In `_renderFoodData()` / food log entry rendering, when `log.is_meal === true`, add a small visual badge or icon next to the food name (e.g., a small 🍽 emoji, or a styled "meal" pill/tag)
- [ ] Style the indicator to be subtle but noticeable (inline, small font)
- [ ] Keep existing layout intact for non-meal entries

### Task 6: Frontend — navigation link in edit modal and list

**Files:**
- Modify: `web/static/js/features/food.js`
- Modify: `web/static/index.html`

- [ ] In the food edit modal, when `product_id` is set, show a small "→ View in Products" or "→ View Meal" link/button below the name field
- [ ] Implement `navigateToFoodProduct(productId, isMeal)` function that: closes the edit modal, switches to the correct sub-tab (Meals tab if `isMeal`, Products/DB tab if not), scrolls to and briefly highlights the item with the given ID
- [ ] Optionally: in the food log list, add a small icon next to meal entries that triggers the same navigation (clicking navigates directly from the list without opening the edit modal)
- [ ] Run `go test ./...` — must pass

### Task 7: Verify acceptance criteria

- [ ] Manual test: add a food log entry by selecting a meal from autocomplete; verify the entry shows the meal badge in the list
- [ ] Manual test: open edit modal for that entry; verify the "View Meal" link appears; click it and verify navigation to the correct meal in the Meals tab
- [ ] Manual test: add a food log entry by selecting a regular product; verify a "View in Products" link appears in edit modal
- [ ] Manual test: add a food log entry by typing a new name (not from autocomplete); verify no badge or link appears
- [ ] Manual test: delete the linked meal; verify the food log entry remains (product_id becomes null) without errors
- [ ] Run `go test ./...`
- [ ] Run `go vet ./...`

### Task 8: Update documentation

- [ ] No README/CLAUDE.md changes required (internal feature linkage, no new patterns introduced)
- [ ] Move this plan to `docs/plans/completed/`
