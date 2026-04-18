# /food command: English normalization + multi-item splitting

## Overview

Rework the `/food` Telegram command so the AI returns an ordered list of atomic food items (instead of one aggregated entry), with dish names normalized to common English terms regardless of the input language. Each item becomes its own row in `food_log`. The bot logs all items immediately and replies with a single summary message listing every entry and an aggregate total.

## Context

- Files involved:
  - `internal/ai/openai.go` — AI client, `MealData` struct, `mealSchema`, `ParseMealFromDescription`, prompt
  - `internal/domain/food_ai.go` — `FoodAIService` interface, `ParseMealDescription`, `AIClient` interface
  - `internal/domain/food_ai_test.go` — existing mock-based tests
  - `internal/domain/food.go` — `FoodLog` type, `CalculateMacros` helper
  - `internal/bot/food_commands.go` — `handleFoodCommand` (single-entry persistence + reply)
  - `internal/bot/food_commands_test.go` — bot-layer tests
  - `internal/ai/openai_test.go` — httptest fixtures for AI client
  - `CLAUDE.md` — documents food feature behavior
- Related patterns:
  - Domain service pattern (`internal/domain/food_ai.go`) — bot calls domain, domain calls AI client
  - JSON schema + strict mode + response_format fallback in `openai.go` (mirror the approach already used for `ActivityData`, which already returns a slice)
  - Per-item persistence via existing `food.CreateFoodLog` (called N times in a loop)
- Dependencies: no new external dependencies; reuses existing `openai`-compatible client

## Development Approach

- Regular (code first, then tests)
- Keep `MealData` public type for backward compatibility only if it's already consumed elsewhere; otherwise rename to `ParsedMeal` with an `Items []MealItem` field
- Log each item immediately after parsing; no preview UI (per user answer: "Log immediately - trust the AI")
- No web frontend changes — this is Telegram-only
- CRITICAL: every task MUST include new/updated tests
- CRITICAL: all tests must pass before starting the next task

## Implementation Steps

### Task 1: Extend AI client to return multiple meal items in English

**Files:**
- Modify: `internal/ai/openai.go`
- Modify: `internal/ai/openai_test.go`

- [x] Replace `MealData` with `MealItem` (per-item: `name`, `weight_grams`, `carbs_100g`, `protein_100g`, `fat_100g`) and a wrapping `ParsedMeal{ Items []MealItem }`
- [x] Update `mealSchema` to match: top-level object with `items` array of per-item objects; `required` + `additionalProperties:false` at both levels (matches the `activitySchema` pattern already in this file)
- [x] Rewrite the system prompt to require: (a) all dish names in English regardless of input language, (b) common/generic names (e.g., "chicken breast" not "grilled marinated chicken breast with lemon"), (c) split complex meals into atomic items — one item per distinct food/ingredient; avoid combining unrelated foods into one row; but don't over-split (e.g., a single sandwich stays one item, not bread+cheese+ham)
- [x] Rename method to `ParseMealFromDescription` returning `*ParsedMeal`; update the `response_format` fallback branch to keep the new JSON key instructions
- [x] Reject empty `items` slice (return an error, matching the activity parser's behavior)
- [x] Update `openai_test.go` httptest fixtures to return the new schema (success, error, response_format fallback)
- [x] Add fixture verifying a Russian-language input still requests and receives English names (mock server assertions only — verify the request payload contains the prompt instructions; response returns English)
- [x] run `go test ./internal/ai/...` — must pass before Task 2

### Task 2: Update domain service to return N FoodLogs

**Files:**
- Modify: `internal/domain/food_ai.go`
- Modify: `internal/domain/food_ai_test.go`

- [x] Change `FoodAIService.ParseMealDescription` signature from `(*FoodLog, error)` to `([]FoodLog, error)`
- [x] Update `AIClient` interface: `ParseMealFromDescription` now returns `*ai.ParsedMeal`
- [x] In `ParseMealDescription`, iterate `mealData.Items`, call `CalculateMacros` per item, build one `FoodLog` per item; propagate error if any item is missing required fields
- [x] Update `mockAIClient` in `food_ai_test.go` to return `*ai.ParsedMeal`
- [x] Update `TestParseMealDescription_Success` to assert a multi-item case (e.g., two items with different per-100g macros) and a single-item case
- [x] Add `TestParseMealDescription_EmptyItems` — parsed meal with zero items must return error
- [x] run `go test ./internal/domain/...` — must pass before Task 3

### Task 3: Update bot /food handler to log N items and summarize

**Files:**
- Modify: `internal/bot/food_commands.go`
- Modify: `internal/bot/food_commands_test.go`

- [ ] Replace the single `CreateFoodLog` call with a loop: for each returned `FoodLog`, set `UserID` + `EatenAt` (all items share the same `msg.Date` timestamp), call `CreateFoodLog`
- [ ] On a per-item persistence error, log via `slog.Error`, continue with remaining items, and surface a partial-success message (e.g., "Logged 2 of 3 items; 1 failed to save")
- [ ] Compose the reply: header "Logged N items", then one bullet per item with `name` / `weight` / per-item macros, then an aggregate footer line with total carbs/protein/fat/calories
- [ ] Keep the "Analyzing your meal..." placeholder + delete behavior unchanged
- [ ] Update `food_commands_test.go` to cover: single-item reply, multi-item reply with aggregate totals, partial failure (one item errors out), AI returns zero items
- [ ] run `go test ./internal/bot/...` — must pass before Task 4

### Task 4: Verify acceptance criteria

- [ ] run `go test ./...` — full suite green
- [ ] run `go vet ./...` and `gofmt -l .` — no output
- [ ] add a dry-run assertion test that renders the full AI prompt string and verifies key constraint phrases ("English", "common", "atomic") are present

### Task 5: Update documentation

- [ ] Update `CLAUDE.md` Feature Implementation Patterns section: note that `/food` now splits complex meals into atomic entries with normalized English names
- [ ] Move this plan file to `docs/plans/completed/`
