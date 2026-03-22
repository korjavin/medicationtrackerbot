---
# AI-Powered Natural Language Food Logging

## Overview
Add a `/food` Telegram bot command that accepts free-text meal descriptions (e.g., "chicken breast with rice and broccoli") and uses OpenAI-compatible API to extract structured nutritional data and automatically log it to the food tracker.

## Context
- Files involved: `internal/bot/bot.go`, `internal/bot/food_commands.go`, `internal/domain/food.go`, `cmd/bot/main.go`, `CLAUDE.md`, `README.md`
- Related patterns: Bot command registration in `handleMessage()` switch statement; domain service pattern; environment variable configuration via `os.Getenv()`; food logging via `FoodStore.CreateFoodLog()`
- Dependencies: OpenAI-compatible HTTP client (no new Go dependencies - use standard `net/http`)

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Add OpenAI client package and environment configuration

**Files:**
- Create: `internal/ai/openai.go`
- Modify: `cmd/bot/main.go`
- Create: `.env.openai.example`

- [ ] Create `internal/ai/openai.go` with `Client` struct and `ParseMealFromDescription()` method that calls OpenAI-compatible API
- [ ] The method should send a prompt requesting JSON response with: name, weight_grams, carbs_100g, protein_100g, fat_100g
- [ ] Add environment variable parsing in `cmd/bot/main.go`: `OPENAI_API_KEY`, `OPENAI_URL` (optional, defaults to https://api.openai.com/v1), `OPENAI_MODEL` (optional, defaults to gpt-4o-mini)
- [ ] Create `.env.openai.example` documenting the new environment variables
- [ ] Write tests in `internal/ai/openai_test.go` for error handling (missing API key, API errors, invalid JSON response)
- [ ] Run `go test ./internal/ai/...` - tests must pass

### Task 2: Create domain service for AI-powered food parsing

**Files:**
- Create: `internal/domain/food_ai.go`
- Modify: `internal/domain/food.go`

- [ ] Create `FoodAIService` interface with `ParseMealDescription(ctx, description string) (*FoodLog, error)`
- [ ] Implement `foodAIService` struct using the OpenAI client from Task 1
- [ ] Add constructor `NewFoodAIService(openaiClient *ai.Client) FoodAIService`
- [ ] The service should: call OpenAI, validate response has required fields, calculate total macros, return domain `FoodLog` struct
- [ ] Add `FoodLog` struct to domain if not already present (match store.FoodLog but without database-specific fields)
- [ ] Write tests in `internal/domain/food_ai_test.go` with mock OpenAI client (test happy path and error cases)
- [ ] Run `go test ./internal/domain/...` - tests must pass

### Task 3: Add `/food` command handler to bot

**Files:**
- Modify: `internal/bot/bot.go`
- Modify: `internal/bot/food_commands.go`
- Modify: `internal/bot/store_interfaces.go`
- Modify: `internal/bot/bot.go` (Bot struct)

- [ ] Add `FoodAIService` field to `Bot` struct
- [ ] Update `bot.New()` to accept and store `FoodAIService` (nil if env vars not set)
- [ ] Add `handleFoodCommand()` method in `food_commands.go` that takes description text, calls AI service, logs result via `b.food.CreateFoodLog()`
- [ ] Handle errors gracefully: missing API key, API timeout, invalid response - show user-friendly error messages
- [ ] Add "food" case to `handleMessage()` switch statement
- [ ] Update `buildHelpText()` to show `/food` command usage when enabled and API key is configured
- [ ] Write tests in `internal/bot/food_commands_test.go` for command handler with mock AI service
- [ ] Run `go test ./internal/bot/...` - tests must pass

### Task 4: Wire up FoodAIService in main

**Files:**
- Modify: `cmd/bot/main.go`

- [ ] After environment variable parsing, create OpenAI client if `OPENAI_API_KEY` is set
- [ ] Create `FoodAIService` with the OpenAI client
- [ ] Pass `FoodAIService` to `bot.New()`
- [ ] Log a message when AI food logging is enabled or disabled
- [ ] Run the application manually to verify bot starts without errors when env vars are not set
- [ ] Run the application manually to verify bot starts successfully when env vars ARE set

### Task 5: Verify acceptance criteria

- [ ] Manual test: Set env vars, start bot, send `/food grilled chicken breast 200g with broccoli` - verify food log is created
- [ ] Manual test: Send `/food` without arguments - verify usage help is shown
- [ ] Manual test: Send `/food` without OPENAI_API_KEY set - verify helpful error message
- [ ] Run full test suite: `go test ./...` - all tests must pass
- [ ] Verify test coverage: `go test -cover ./...` - aim for 80%+ on new code

### Task 6: Update documentation

- [ ] Update `README.md` - add `/food` command to bot commands section with usage examples
- [ ] Update `CLAUDE.md` - add environment variable documentation, FoodAIService to domain service pattern, `/food` command to bot commands section
- [ ] Move this plan to `docs/plans/completed/`
