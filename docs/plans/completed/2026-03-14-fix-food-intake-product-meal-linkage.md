---
# Fix Food Intake Product/Meal Linkage

## Overview
Implement the backend changes to support the product/meal linkage feature that was partially implemented in commit 6c43ca1. The frontend already expects `product_id` and `is_meal` fields on food logs and displays visual indicators and navigation links, but the backend does not persist or return these fields.

## Context
- Files involved:
  - `internal/store/migrations/` - add new migration for product_id column
  - `internal/store/store.go` - update FoodLog struct and CRUD methods
  - `internal/server/food_handlers.go` - update handlers to accept product_id
- Related patterns: Follow existing migration pattern (numbered sequentially), use LEFT JOIN pattern from other queries
- Dependencies: None

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Create database migration

**Files:**
- Create: `internal/store/migrations/038_add_food_log_product_id.sql`

- [ ] Add migration to create `product_id` column in `food_log` table as nullable INTEGER FK
- [ ] Add index on `product_id` for query performance
- [ ] Write test to verify migration can be applied and rolled back
- [ ] Run project test suite - must pass before task 2

### Task 2: Update FoodLog struct

**Files:**
- Modify: `internal/store/store.go`

- [ ] Add `ProductID *int64` field to FoodLog struct (nullable for backward compatibility)
- [ ] Add `IsMeal bool` field to FoodLog struct
- [ ] Write tests to verify struct serialization/deserialization
- [ ] Run project test suite - must pass before task 3

### Task 3: Update CreateFoodLog store method

**Files:**
- Modify: `internal/store/store.go`

- [ ] Update INSERT statement to include `product_id` column
- [ ] Add test for creating food log with product_id
- [ ] Add test for creating food log without product_id (backward compatibility)
- [ ] Run project test suite - must pass before task 4

### Task 4: Update UpdateFoodLog store method

**Files:**
- Modify: `internal/store/store.go`

- [ ] Update UPDATE statement to include `product_id` column
- [ ] Add test for updating food log with product_id
- [ ] Run project test suite - must pass before task 5

### Task 5: Update GetFoodLogs store method

**Files:**
- Modify: `internal/store/store.go`

- [ ] Add LEFT JOIN with `food_products` table to fetch `is_meal` status
- [ ] Update SELECT to include `product_id` and `is_meal` columns
- [ ] Update rows.Scan to populate new fields
- [ ] Add test to verify is_meal is correctly populated for meal-linked logs
- [ ] Run project test suite - must pass before task 6

### Task 6: Update handleCreateFoodLog handler

**Files:**
- Modify: `internal/server/food_handlers.go`

- [ ] Add `product_id` field to request struct
- [ ] Pass `product_id` to store.FoodLog struct when creating
- [ ] Add test for creating food log with product_id
- [ ] Run project test suite - must pass before task 7

### Task 7: Update handleUpdateFoodLog handler

**Files:**
- Modify: `internal/server/food_handlers.go`

- [ ] Add `product_id` field to request struct
- [ ] Pass `product_id` to store.FoodLog struct when updating
- [ ] Add test for updating food log with product_id
- [ ] Run project test suite - must pass before task 8

### Task 8: Verify acceptance criteria

- [ ] manual test: Create a meal in My Meals tab, then log that meal and verify it shows "🍽" icon and "→ View Meal" link when editing
- [ ] manual test: Create a product in Food DB, log it, and verify "→ View in Products" link appears when editing
- [ ] manual test: Click navigation link and verify it switches to correct tab and opens edit modal
- [ ] run full test suite (go test ./...)
- [ ] run linter (if applicable)
- [ ] verify test coverage is adequate

### Task 9: Update documentation

- [ ] Update README.md if user-facing behavior changes needed
- [ ] Update CLAUDE.md if internal patterns changed
- [ ] Move this plan to `docs/plans/completed/`
