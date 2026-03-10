---
# Improve Backend Test Coverage and Test Suite Quality

## Overview

Add missing tests for the scheduler package and bot callback handlers using a JSON golden-file pattern. Test cases are defined as structured JSON scenarios in testdata/ folders; a reusable test harness executes them and compares against golden answers from the same files. Adding a new test case means adding one JSON record, not writing new code. This pattern will be documented so it can be adopted project-wide.

## Context

- Files involved:
  - internal/scheduler/medication.go, medication_reminder.go, bp_reminders.go, weight_reminders.go, workout.go, low_stock.go, helpers.go
  - internal/bot/bp_callbacks.go, weight_callbacks.go, workout_callbacks.go, sleep_import.go
  - internal/testharness/ (new shared package)
- Related patterns: table-driven tests, inline mock structs, in-memory SQLite, httptest for HTTP handlers, botTestEnv from internal/bot/common_test.go
- Current state: 500 passing tests; scheduler and some bot callbacks are the main untested areas

## Development Approach

- **Testing approach**: TDD - read source, define JSON scenarios, implement harness, verify tests pass
- Design the JSON scenario format and harness first (Task 1), then apply it to each package
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Design and Implement the JSON Golden-File Test Harness

**Files:**
- Create: `internal/testharness/harness.go`
- Create: `internal/testharness/harness_test.go`

The harness provides reusable helpers for any package to load JSON test scenarios and compare actual vs expected output. A scenario file contains an array of objects with fields like `name`, `input`, `state` (mock store data to seed), and `expected` (golden output). The harness loads the file, iterates scenarios, sets up mocks from `state`, runs the function under test, and does a deep comparison with `expected`.

- [ ] Design the scenario JSON schema: `{name, description, input, state, expected}` covering the needs of scheduler and bot tests
- [ ] Implement harness.go: LoadScenarios(), RunScenarios(), diffing helpers (use encoding/json and reflect.DeepEqual or go-cmp)
- [ ] Write harness_test.go to verify the harness itself works against a small example scenario file in internal/testharness/testdata/
- [ ] Run `go test ./internal/testharness/...` - must pass

### Task 2: Scheduler - Medication Notification Logic with JSON Scenarios

**Files:**
- Read: `internal/scheduler/medication.go`, `internal/scheduler/medication_reminder.go`, `internal/scheduler/helpers.go`
- Create: `internal/scheduler/testdata/medication_scenarios.json`
- Create: `internal/scheduler/medication_test.go`

- [ ] Read scheduler/medication.go and medication_reminder.go to understand what to test
- [ ] Define JSON scenarios covering: pending intakes within 15-min window, already-notified intakes (no duplicate), no upcoming intakes
- [ ] Write medication_test.go using the harness: load scenarios, build inline mock store from state, invoke scheduler function, compare result
- [ ] Run `go test ./internal/scheduler/...` - must pass

### Task 3: Scheduler - BP and Weight Reminder Logic with JSON Scenarios

**Files:**
- Read: `internal/scheduler/bp_reminders.go`, `internal/scheduler/weight_reminders.go`
- Create: `internal/scheduler/testdata/bp_reminder_scenarios.json`
- Create: `internal/scheduler/testdata/weight_reminder_scenarios.json`
- Create or extend: `internal/scheduler/bp_reminders_test.go`, `internal/scheduler/weight_reminders_test.go`

- [ ] Read bp_reminders.go and weight_reminders.go
- [ ] Define JSON scenarios for BP: frequency windows, snooze state, blocked state
- [ ] Define JSON scenarios for weight: weekly check, already-reminded case, no weight logged
- [ ] Write test files using the harness
- [ ] Run `go test ./internal/scheduler/...` - must pass

### Task 4: Scheduler - Workout and Low Stock Logic with JSON Scenarios

**Files:**
- Read: `internal/scheduler/workout.go`, `internal/scheduler/low_stock.go`
- Create: `internal/scheduler/testdata/workout_scheduler_scenarios.json`
- Create: `internal/scheduler/testdata/low_stock_scenarios.json`
- Create: `internal/scheduler/workout_scheduler_test.go`, `internal/scheduler/low_stock_test.go`

- [ ] Read workout.go and low_stock.go
- [ ] Define JSON scenarios for workout scheduling: advance time, already-notified, rotation state
- [ ] Define JSON scenarios for low_stock: below threshold, above threshold, deduplication
- [ ] Write test files using the harness
- [ ] Run `go test ./internal/scheduler/...` - must pass

### Task 5: Bot Callbacks - BP, Weight, Workout with JSON Scenarios

**Files:**
- Read: `internal/bot/bp_callbacks.go`, `internal/bot/weight_callbacks.go`, `internal/bot/workout_callbacks.go`
- Create: `internal/bot/testdata/bp_callback_scenarios.json`
- Create: `internal/bot/testdata/weight_callback_scenarios.json`
- Create: `internal/bot/testdata/workout_callback_scenarios.json`
- Create: `internal/bot/bp_callbacks_test.go`, `internal/bot/weight_callbacks_test.go`, `internal/bot/workout_callbacks_test.go`

Bot scenarios encode the incoming Telegram callback data and initial store state as `input`/`state`, and the expected Telegram messages sent and store mutations as `expected`.

- [ ] Read callback files to understand what state changes and messages to capture
- [ ] Define JSON scenarios for BP callbacks: create, edit, delete confirmations
- [ ] Define JSON scenarios for weight callbacks: similar pattern
- [ ] Define JSON scenarios for workout callbacks: start session, log exercise, complete session
- [ ] Write test files using setupBotTest() from common_test.go adapted to load from JSON scenarios
- [ ] Run `go test ./internal/bot/...` - must pass

### Task 6: Document the Golden-File Test Pattern

**Files:**
- Modify: `CLAUDE.md` (Testing Patterns section)
- Create: `docs/TESTING_PATTERNS.md`

- [ ] Document the JSON scenario schema (fields, types, conventions)
- [ ] Document how to add a new test case (one-liner: add a JSON object to the relevant testdata file)
- [ ] Document how to add a new test file for a new component (use the harness, link scenario file)
- [ ] Update CLAUDE.md Testing Patterns section to reference the new pattern and docs/TESTING_PATTERNS.md

### Task 7: Verify Acceptance Criteria

- [ ] Run full test suite: `go test ./...`
- [ ] All tests pass with no failures
- [ ] Scheduler package coverage meaningfully improved (was effectively 0% for most files)
- [ ] Bot callback coverage improved for BP, weight, workout handlers
- [ ] Adding a test case for any covered area requires only adding a JSON record, not writing Go code
- [ ] No new external test dependencies introduced (only stdlib + go-cmp if adopted)

### Task 8: Update Documentation

- [ ] Update CLAUDE.md Testing Patterns section with new golden-file pattern
- [ ] Move this plan to `docs/plans/completed/`
