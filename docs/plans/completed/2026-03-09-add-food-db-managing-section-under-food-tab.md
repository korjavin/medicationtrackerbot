# Add Food DB Managing Section Under Food Tab

## Overview

Add a new "Food DB" sub-tab under the food tab that shows a browsable, searchable, sortable list of all locally saved food products (non-meals). Users can edit or delete any product. Supports pagination and sorting by usage count, last used date, or name.

## Context

- Files involved: `web/static/index.html`, `web/static/js/features/food.js`, `web/static/css/styles.css`, `internal/server/food_handlers.go`, `internal/store/store.go`, `internal/server/food_handlers_test.go`
- Related patterns: My Meals tab (same pattern - fetchable list with edit/delete); existing `showEditFoodProductModal()` and `deleteFoodProduct()` reused as-is
- Dependencies: none new

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Extend backend food products list API

**Files:**
- Modify: `internal/store/store.go` (GetFoodProducts method)
- Modify: `internal/server/food_handlers.go` (handleGetFoodProducts)
- Modify: `internal/server/food_handlers_test.go`

- [ ] Add a `FoodProductsFilter` struct with fields: `IsMeal *bool`, `Query string`, `Offset int`, `Limit int`, `Sort string` (values: "usage", "last_used", "name")
- [ ] Update `GetFoodProducts(ctx, userID, limit int)` signature to `GetFoodProducts(ctx, userID int64, filter FoodProductsFilter) ([]FoodProduct, int, error)` where the second return value is total count for pagination
- [ ] Build the SQL query dynamically: filter by `is_meal` if set, filter by `name LIKE ?` if Query non-empty, apply ORDER BY based on Sort, apply LIMIT/OFFSET
- [ ] Run a COUNT query with the same WHERE clause to return total
- [ ] Update `handleGetFoodProducts` to read query params: `q`, `offset`, `limit` (default 20, max 100), `sort` (usage/last_used/name), `is_meal` (true/false)
- [ ] When no params given (existing `/api/food/products` call from frontend cache init): apply defaults that preserve current behavior (all products, limit 100, sorted by usage)
- [ ] Return JSON object `{"products": [...], "total": N}` instead of bare array - update existing JS cache init to read `.products`
- [ ] Write handler tests: test filtering by is_meal=false, search query, pagination offset, sort by name
- [ ] Run `go test ./internal/server ./internal/store` - must pass

### Task 2: Add Food DB sub-tab to HTML

**Files:**
- Modify: `web/static/index.html`

- [ ] Add a third sub-tab button "Food DB" (`data-tab="fooddb"`) in the `.food-tabs` container after "My Meals"
- [ ] Add content div `#food-fooddb-tab` with class `food-tab-content` containing:
  - Search input `#fooddb-search` with placeholder "Search products..."
  - Sort controls: three small buttons ("Most Used", "Recently Used", "A-Z") with `data-sort` attribute
  - Product list container `#fooddb-list`
  - Pagination row: "Showing X-Y of Z" text + Prev/Next buttons

### Task 3: Implement Food DB tab JavaScript

**Files:**
- Modify: `web/static/js/features/food.js`

- [ ] Add state variables: `foodDBPage`, `foodDBSort` (default "usage"), `foodDBQuery` (default ""), `foodDBTotal`
- [ ] Implement `loadFoodDB()`: call `GET /api/food/products?is_meal=false&q=...&offset=...&limit=20&sort=...`, render results
- [ ] Implement `renderFoodDBList(products, total)`: render product cards (product name, macros per 100g row, usage count + last used date, Edit/Delete buttons) - similar structure to My Meals cards
- [ ] Add search input event listener with 300ms debounce: resets page to 0 and calls `loadFoodDB()`
- [ ] Add sort button click handlers: set `foodDBSort`, reset page, call `loadFoodDB()`
- [ ] Add Prev/Next button handlers with correct offset calculation
- [ ] Update `switchFoodTab()` to call `loadFoodDB()` when switching to "fooddb" tab
- [ ] After successful `deleteFoodProduct()` call from the fooddb tab context, re-call `loadFoodDB()` instead of `loadMyMeals()`
- [ ] Update cache init: read products from `response.products` (matching the new API response shape)

### Task 4: CSS styling

**Files:**
- Modify: `web/static/css/styles.css`

- [ ] Add styles for sort button group (active state highlight, small button row)
- [ ] Add styles for pagination row (space-between layout, disabled state on Prev/Next)
- [ ] Add styles for product card meta line (usage count + last-used date in muted text)

### Task 5: Verify acceptance criteria

- [ ] Manual test: open Food tab → Food DB sub-tab → list loads showing only non-meal products
- [ ] Manual test: type in search box → list filters; clear search → all products show
- [ ] Manual test: click sort buttons → order changes
- [ ] Manual test: paginate forward/backward
- [ ] Manual test: click Edit on a product → edit modal opens with correct values → save → card updates
- [ ] Manual test: click Delete on a product → confirm → product removed from list
- [ ] Manual test: existing My Meals tab still works correctly
- [ ] Manual test: existing food log autocomplete still works correctly
- [ ] Run `go test ./...`
- [ ] Run `go vet ./...`

### Task 6: Update documentation

- [ ] No README changes needed (internal UI feature)
- [ ] No CLAUDE.md changes needed
- [ ] Move this plan to `docs/plans/completed/`
