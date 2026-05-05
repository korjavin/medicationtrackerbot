# Steer the agent toward reusing food_products via MCP

## Overview

Make the LLM agent prefer existing `food_products` names over inventing new ones. Strengthen the MCP guidance so the agent searches first, plumb the resolved `product_id` through the `food.log.create` response so the agent learns when it matched vs. created, add a frequent-products MCP op, fix the legacy `/api/mcp-food-log` handler so it also upserts into `food_products`, and update the Python example to demonstrate the search-first pattern.

## Context

- Files involved:
  - `internal/mcp/registry/registry.go` — food topic suggestion text (line 92)
  - `internal/mcp/registry/operations_food.go` — `food.log.create` / `food.products.search` / `food.products.list` / new `food.products.frequent` op
  - `internal/server/food_handlers.go` — `handleCreateFoodLog` (line 20); upsert already works (lines 79–105) but discards the resolved `product_id`
  - `internal/server/mcp_food_log.go` — legacy HMAC handler (line 34) does NOT upsert into `food_products` today
  - `internal/server/store_interfaces.go` — `FoodStore` interface (line 134)
  - `internal/store/store.go` — `FoodProduct` type, `UpsertFoodProduct` (line 1896); add `GetFoodProductByName`
  - `python/examples/food_log.py` — write-mode example for agents
  - `internal/server/food_handlers_test.go` — `TestHandleLogFood`
  - `internal/server/mcp_food_log_test.go` — `TestHandleMCPFoodLog_ValidRequest`
- Related patterns:
  - `Registry.Operation` validation does not forbid two ops sharing the same `Method+Path`, so `food.products.frequent` can reuse `GET /api/food/products` with `sort=usage` (already the handler default).
  - The coverage guard in `mcp_coverage_test.go` indexes by `Method+Path`; one op per route is enough.
  - Modern `food.log.create` already silently upserts `food_products` from `name`; the legacy `mcp-food-log` path is the gap the user described.
  - Existing `UpsertFoodProduct` uses `ON CONFLICT(user_id, name)` so name is the natural key for a follow-up id lookup.
- Dependencies: none external.

## Development Approach

- Testing approach: Regular (code first, then tests). No unit tests; integration tests where appropriate (handler-level + registry-level).
- Complete each task fully before moving to the next.
- CRITICAL: all tests must pass before starting next task.
- Do NOT change `food.log.create`'s request schema; only the response shape gets a new `product_id` field.
- Two ops sharing `GET /api/food/products` is intentional (`food.products.list` and `food.products.frequent`) — different agent guidance, same endpoint.

## Implementation Steps

### Task 1: Plumb resolved product_id through food.log.create response

**Files:**
- Modify: `internal/store/store.go` (add `GetFoodProductByName`)
- Modify: `internal/server/store_interfaces.go` (add to `FoodStore` interface)
- Modify: `internal/server/food_handlers.go` (return `product_id`)

- [ ] Add `Store.GetFoodProductByName(ctx, userID, name) (*FoodProduct, error)` returning the id of the product matching `(user_id, name)` — used after the existing upsert to surface the resolved id.
- [ ] Add the new method to the `FoodStore` interface in `store_interfaces.go`.
- [ ] In `handleCreateFoodLog`, after the existing `UpsertFoodProduct` call, look up the product id by name and include it in the JSON response. If `req.ProductID` was already provided by the caller, echo it back. Response shape becomes `{"status": "created", "id": <log_id>, "product_id": <resolved_id_or_null>, "name": <req.Name>}`.
- [ ] Run `go test ./internal/store/... ./internal/server/...` — must pass.

### Task 2: Make the legacy /api/mcp-food-log handler upsert into food_products

**Files:**
- Modify: `internal/server/mcp_food_log.go`

- [ ] After the successful `CreateFoodLog` call in `handleMCPFoodLog`, mirror the upsert logic from `handleCreateFoodLog`: compute per-100g macros from `req.WeightG` (treat the request macros as totals — there is no `per_100g` flag on the legacy payload), build a `store.FoodProduct`, call `s.food.UpsertFoodProduct`. Ignore the upsert error (best-effort, matches modern handler).
- [ ] Update `TestHandleMCPFoodLog_ValidRequest` in `mcp_food_log_test.go` to assert that calling the endpoint twice with the same name produces a `food_products` row with `usage_count=2`.
- [ ] Run `go test ./internal/server/...` — must pass.

### Task 3: Add food.products.frequent MCP op + strengthen food.log.create description

**Files:**
- Modify: `internal/mcp/registry/operations_food.go`

- [ ] Add a new Operation `food.products.frequent` — `Method` GET, `Path` `/api/food/products`, `Risk` `RiskRead`. `ParamsSchema` exposes only `limit` (default 10). Description explains: "Top-N most frequently logged products for this user (highest `usage_count` first). Use this to discover canonical names the user has logged before, so reused meals share the same `food_product` entry." Example shows `limit=10` and reading product `id` and `name` from the response.
- [ ] Update `food.log.create` Description to instruct: "Before logging, prefer to search the user's catalog with `food.products.search` or `food.products.frequent` and pass the matching `product_id` so this entry rolls up under the same product. If you only pass `name` (no `product_id`), the server upserts a `food_products` row by name and the response includes the resolved `product_id`."
- [ ] Update `food.log.create` `ResponseSummary` to match the new shape from Task 1: "{status, id, product_id, name} — `product_id` is the `food_products` row that was matched or upserted from `name`; null only if no name was provided."
- [ ] Update `food.products.search` Description to: "Search the user's saved food products (and the open_food_facts cache) by name. Always call this before `food.log.create` unless you already have a `product_id` — reusing an existing product keeps the user's history consistent."
- [ ] Run `go test ./internal/mcp/... ./internal/server/...` — must pass (the coverage guard must still be green; verify no duplicate-path regression).

### Task 4: Strengthen the food topic suggestion + update the python example

**Files:**
- Modify: `internal/mcp/registry/registry.go`
- Modify: `python/examples/food_log.py`

- [ ] Replace the "food" topic suggestion in `registry.go` with text that names the search-first workflow: "Before logging a meal, call `food.products.search` (or `food.products.frequent`) to find a matching saved product and reuse its `product_id` in `food.log.create` — this keeps the user's history consistent. Only invent a new name when nothing matches; the server will upsert it into the user's catalog automatically."
- [ ] Rewrite `python/examples/food_log.py` `main()` so it: (a) calls `food.products.search` with a query like "chicken rice", (b) if the result list contains a product whose name reasonably matches the planned meal, calls `food.log.create` with that `product_id` and no `name` field, (c) otherwise calls `food.log.create` with `name` only, (d) reads the resolved `product_id` from the create response and includes it in the returned summary.
- [ ] Add a comment block at the top of `food_log.py` describing the search-first contract so future readers/agents see it.
- [ ] Run `go test ./internal/mcp/...` and `pytest python/tests/` if a corresponding test exists; otherwise just `go test ./...` — must pass.

### Task 5: Verify acceptance criteria

- [ ] `go test ./...` — full suite green.
- [ ] `go vet ./...` — clean.
- [ ] `pnpm test` — frontend suite still green (no frontend changes expected, but the project rule is to verify).
- [ ] Manually inspect the `mcp_help` topic output for "food" by running the relevant test or eyeballing `registry.go` — confirm the new suggestion is what the agent will see.

### Task 6: Update documentation

- [ ] Update `docs/features.md` food section if it documents the agent workflow (search-first reuse, response includes `product_id`).
- [ ] No `CLAUDE.md` change required — no new internal pattern.
- [ ] Move this plan to `docs/plans/completed/`.
