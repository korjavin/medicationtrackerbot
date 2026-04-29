# Smart Weight Unit Preference (KG/LB)

## Overview

Track each user's preferred weight unit (KG or LB) by remembering the last unit they used when entering weight. Display all weight values in that preferred unit across the web app and bot replies. Provide an explicit override in Settings. Storage remains in KG; preference only affects user-facing input default and display. The MCP contract is explicitly fixed to KG with `_kg`-suffixed fields and must never be influenced by the user preference, so AI agents always see one canonical unit.

## Context

- Files involved:
  - `internal/store/migrations/` (new migration on the singleton `settings` table)
  - `internal/store/store.go` (preference get/set methods)
  - `internal/server/` (bootstrap response + new PATCH endpoint)
  - `internal/bot/bot.go` (`handleWeightCommand`, ~line 1288)
  - `internal/mcp/tools.go` (audit `WeightResult` field tags)
  - `internal/mcp/fitness.go` (audit `WeightSection` field tags)
  - `internal/mcp/mcp.go` (tool descriptions)
  - `web/static/js/features/weight.js` (modal toggle + display conversion)
  - `web/static/js/features/today.js` (weight tile display)
  - `web/static/js/features/settings.js` (explicit override toggle)
- Related patterns:
  - Singleton `settings` table (migration 006) — add column there, matching `weight_goal`, `bp_target_systolic`, etc.
  - Bootstrap API delivers settings on app load — extend it with `weight_unit_preference`
  - Existing modal toggle in `weight.js` uses `WEIGHT_KG_PER_LB = 0.45359237` constant
  - MCP already names weight fields `weight_kg`, `trend_kg`, `current_kg`, `change_kg` — preserve and make explicit
- Dependencies: none new
- DB stores weight in KG always (no schema change to `weight_logs`); preference is display/input UX only
- MCP rule: read tools always emit kg with explicit `_kg` field names; tool descriptions document the unit; the user preference is NOT exposed via MCP

## Development Approach

- Testing approach: Regular (code first, then tests)
- Complete each task fully before moving to the next
- Smart inference: when a user submits weight via modal in LB, save 'lb' as preference; same for bot text command with explicit `lb` suffix
- Explicit Settings override: latest action wins (Settings PATCH or modal/bot inference both update the same column)
- MCP boundary: the unit preference lives only in the web/bot user surface; MCP tools and responses must remain unit-explicit (kg)
- CRITICAL: every task MUST include new/updated tests
- CRITICAL: all tests must pass before starting next task

## Implementation Steps

### Task 1: Add weight_unit_preference column and store methods

**Files:**
- Create: `internal/store/migrations/0XX_add_weight_unit_preference.sql`
- Modify: `internal/store/store.go`
- Modify: `internal/store/store_weight_test.go` (or new `store_settings_test.go`)

- [x] add migration: `ALTER TABLE settings ADD COLUMN weight_unit_preference TEXT NOT NULL DEFAULT 'kg' CHECK (weight_unit_preference IN ('kg','lb'))`
- [x] add `GetWeightUnitPreference(ctx)` returning 'kg' or 'lb' (default 'kg' on no-row)
- [x] add `SetWeightUnitPreference(ctx, unit string)` with validation (reject anything other than 'kg'/'lb')
- [x] write store tests covering default, set kg, set lb, set-invalid-rejected, persistence across reads
- [x] run `go test ./internal/store/...`

### Task 2: Expose preference via bootstrap and PATCH endpoint

**Files:**
- Modify: `internal/server/` (bootstrap assembly + new handler file)
- Modify: `internal/server/server.go` (route registration)
- Create: `internal/server/weight_unit_preference_test.go`

- [x] include `weight_unit_preference` in the bootstrap JSON response
- [x] add `PATCH /api/settings/weight-unit` handler accepting `{"unit":"kg"|"lb"}`
- [x] auth-protect like other settings endpoints
- [x] write handler tests: bootstrap default, bootstrap after set, PATCH kg, PATCH lb, PATCH invalid rejected (400), unauthenticated rejected
- [x] run `go test ./internal/server/...`

### Task 3: MCP contract - keep kg explicit, lock the boundary

**Files:**
- Modify: `internal/mcp/mcp.go` (get_weight and analyze_fitness tool descriptions)
- Modify: `internal/mcp/tools.go` (audit and confirm `WeightResult` field tags use `_kg`)
- Modify: `internal/mcp/fitness.go` (audit and confirm `WeightSection` field tags use `_kg`)
- Modify: `internal/mcp/tools_test.go` and `internal/mcp/fitness_test.go`

- [x] update `get_weight` tool description to explicitly say "All weights are returned in kilograms (kg)" so AI agents know the unit unambiguously
- [x] update `analyze_fitness` description to explicitly say weight is in kilograms
- [x] confirm response structs only expose `weight_kg`, `trend_kg`, `current_kg`, `change_kg` (no plain `weight` field) — fix any field tag that drops the unit
- [x] add a regression test that calls `handleGetWeight` after `SetWeightUnitPreference(ctx, "lb")` and asserts the response is still in kg with `_kg` field names (i.e. user preference does NOT leak into MCP)
- [x] add equivalent assertion in fitness test for `WeightSection`
- [x] do NOT add unit input parameter, do NOT add a unit field in the response, do NOT add a write-weight MCP tool
- [x] run `go test ./internal/mcp/...`

### Task 4: Frontend - persist last-used unit on weight entry

**Files:**
- Modify: `web/static/js/features/weight.js`
- Modify: `tests/` (Vitest spec for weight.js)

- [x] on modal open, default `weightModalUnit` to the user's saved preference from bootstrap (instead of always 'kg')
- [x] on successful weight submit, if the chosen unit differs from saved preference, PATCH `/api/settings/weight-unit` and update local cache
- [x] keep modal-internal toggle behavior unchanged
- [x] write Vitest test: modal opens in saved unit; submit-with-changed-unit triggers PATCH; submit-same-unit does not PATCH
- [x] run `pnpm test`

### Task 5: Frontend - render all weight values in preferred unit

**Files:**
- Modify: `web/static/js/features/weight.js` (renderWeightGoalCard, history, chart legend)
- Modify: `web/static/js/features/today.js` (weight tile)
- Modify: any module rendering literal "kg" (search for "kg" in `web/static/js`)
- Create or modify: `web/static/js/lib/format.js` (or wherever shared formatters live) for the helper

- [ ] add a single `formatWeight(kg, unit)` helper returning `{value, label}` (e.g. `{value: 154.3, label: 'lb'}`)
- [ ] route every weight display through it: Today tile, goal card, delta-to-goal, chart legend, history list
- [ ] keep stored values in kg; convert only at render time
- [ ] write Vitest tests: kg passthrough, lb conversion, rounding, label correctness
- [ ] run `pnpm test`

### Task 6: Bot - parse unit suffix and update preference

**Files:**
- Modify: `internal/bot/bot.go` (`handleWeightCommand`)
- Modify: `internal/domain/` (add a small parser helper if it keeps bot thin)
- Modify: bot/domain tests

- [ ] parse trailing `kg`, `lb`, `lbs`, `pound`, `pounds` (case-insensitive) from `/weight 150lb`; default to user's saved preference if no suffix
- [ ] convert to kg before validation/storage (storage stays in kg)
- [ ] when an explicit suffix was used, persist it as the new preference via the store method from Task 1
- [ ] update reply to confirm in the user's preferred unit, with kg shown in parentheses (e.g. `Weight recorded: 154.3 lb (70.0 kg)`)
- [ ] write tests: bare number uses preference, "150lb" sets preference to lb, "70kg" sets to kg, invalid suffix rejected, reply format matches preference
- [ ] run `go test ./internal/bot/... ./internal/domain/...`

### Task 7: Settings UI - explicit override toggle

**Files:**
- Modify: `web/static/js/features/settings.js`
- Modify: corresponding HTML/template if applicable
- Modify: Vitest spec for settings

- [ ] add Weight Unit segmented control (KG / LB) in Settings, bound to bootstrap value
- [ ] on change, PATCH `/api/settings/weight-unit` and refresh in-memory state so dashboards rerender
- [ ] write Vitest test: toggle dispatches PATCH and updates display state
- [ ] run `pnpm test`

### Task 8: Verify acceptance criteria

- [ ] run full test suite: `go test ./...` and `pnpm test`
- [ ] verify no hardcoded "kg" literals remain in user-facing weight display paths (grep `web/static/js`)
- [ ] verify MCP response field names only use `_kg`-suffixed weight keys (grep `internal/mcp`)

### Task 9: Update documentation

- [ ] update `docs/features.md` weight section noting unit preference behavior
- [ ] update `docs/api.md` with the new `PATCH /api/settings/weight-unit` endpoint and the bootstrap field
- [ ] add a short note in `docs/mcp-deployment.md` (or wherever MCP tools are documented) stating that MCP weight responses are always in kg and unaffected by user preference
- [ ] move this plan to `docs/plans/completed/`
