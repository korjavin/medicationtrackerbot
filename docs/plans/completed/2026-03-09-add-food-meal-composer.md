# Add Food Meal Composer Feature

## Overview
Add ability to select multiple food log entries, combine them into a named "meal" template stored in food_products, and manage these meals from a dedicated section under the food tab. Meals auto-fill typical serving weight and appear first in search results.

## Context
- Files involved:
  - `internal/store/migrations/` - new migration (028)
  - `internal/store/store.go` - FoodProduct struct + queries update
  - `internal/server/food.go` - new API endpoint + search update
  - `web/static/js/features/food.js` - meal composer UI + management section
  - `web/static/index.html` - new HTML sections and modals
- Related patterns: workout group management (card list + edit/delete modal), food_products UpsertFoodProduct
- Dependencies: none external

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- Every task that modifies Go code must include new/updated tests
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Database Migration

**Files:**
- Create: `internal/store/migrations/028_add_meal_products.sql`

- [ ] Add `is_meal BOOLEAN NOT NULL DEFAULT 0` column to `food_products`
- [ ] Add `total_weight_g INTEGER` column to `food_products` (stores typical serving size in grams)
- [ ] Write goose migration with proper Up/Down sections

### Task 2: Store Layer Update

**Files:**
- Modify: `internal/store/store.go`

- [ ] Add `IsMeal bool` and `TotalWeightG int` fields to `FoodProduct` struct
- [ ] Update `UpsertFoodProduct` to include new columns
- [ ] Update `UpdateFoodProduct` to include new columns
- [ ] Update `GetFoodProducts` query to include new columns in SELECT
- [ ] Update `SearchFoodProducts` to ORDER BY `is_meal DESC, usage_count DESC` so meals appear first
- [ ] Add `CreateMealFromLogs(ctx, userID int64, name string, logIDs []int64) (*FoodProduct, error)` method that:
  - Fetches the given food_log entries (validates user ownership)
  - Sums weight, carbs, protein, fat, calories across entries
  - Computes per-100g values from totals
  - Inserts into food_products with is_meal=true, total_weight_g=sum of weights
  - Returns the created FoodProduct
- [ ] Write tests for CreateMealFromLogs covering: happy path, invalid log IDs, wrong user, empty IDs list
- [ ] Run project test suite - must pass before task 3

### Task 3: API Endpoint

**Files:**
- Modify: `internal/server/food.go` (or wherever food handlers live)
- Modify: `internal/server/server.go` to register the new route

- [ ] Add `POST /api/food/products/from-logs` handler
  - Request body: `{"name": string, "log_ids": [int64...]}`
  - Validates name is non-empty and log_ids is non-empty
  - Calls `store.CreateMealFromLogs`
  - Returns the created FoodProduct as JSON
  - Emits a change event (for frontend cache invalidation)
- [ ] Verify search endpoint already returns is_meal and total_weight_g (update if needed)
- [ ] Write handler tests using httptest
- [ ] Run project test suite - must pass before task 4

### Task 4: Frontend - Save as Meal UI

**Files:**
- Modify: `web/static/js/features/food.js`
- Modify: `web/static/index.html`

- [ ] Add a "Select" toggle button in the food log toolbar (enters multi-select mode)
- [ ] In multi-select mode, each food log entry gets a checkbox
- [ ] When 2+ entries are checked, show a floating "Save as Meal" action button
- [ ] Clicking "Save as Meal" opens a small modal with a name text input (pre-fill with "Meal")
- [ ] On confirm, POST to `/api/food/products/from-logs` with selected log IDs and name
- [ ] On success: show brief confirmation toast, exit multi-select mode, refresh product cache
- [ ] Add HTML for the save-as-meal confirmation modal (`#food-save-meal-modal`)
- [ ] Style multi-select mode to clearly show checkboxes on entries

### Task 5: Frontend - Meals Management Section

**Files:**
- Modify: `web/static/js/features/food.js`
- Modify: `web/static/index.html`

- [ ] Add a "My Meals" card/section under the food settings area (mirrors the exercise management pattern from workout.js)
- [ ] `loadMyMeals()` - fetch from `GET /api/food/products` filtering is_meal=true, render as card list
- [ ] Each meal card shows: name, total weight (typical serving), calories, macros summary
- [ ] Edit button opens a modal pre-populated with meal name and per-100g macros (reuse or extend existing `#food-product-modal`)
- [ ] Delete button shows confirm dialog then calls `DELETE /api/food/products/{id}`
- [ ] After edit/delete, refresh the meals list
- [ ] Add HTML section `#food-meals-section` with heading and list container
- [ ] Meals visually distinguished in autocomplete dropdown (e.g. small "meal" badge)

### Task 6: Search Prioritization Polish

**Files:**
- Modify: `web/static/js/features/food.js`

- [ ] In `renderFoodAutocomplete`, if product has `is_meal=true`, add a visual badge (e.g. "Meal" label)
- [ ] When a meal product is selected for logging, auto-fill the weight field with `total_weight_g`
- [ ] Verify meals appear before regular products in autocomplete (relies on Task 2 ordering)

### Task 7: Verify Acceptance Criteria

- [ ] Manual test: scan/log 3 foods, select all, save as "Test Meal", confirm it appears in search
- [ ] Manual test: log "Test Meal" - verify weight auto-fills and macros are correct
- [ ] Manual test: edit a meal from the Meals section, verify changes persist
- [ ] Manual test: delete a meal from the Meals section, verify it's gone from search
- [ ] Run full test suite: `go test ./...` - must pass
- [ ] Run linter: `go vet ./...`

### Task 8: Update Documentation

- [ ] Update CLAUDE.md to mention the Meals concept under Food Tracking section
- [ ] Move this plan to `docs/plans/completed/`
