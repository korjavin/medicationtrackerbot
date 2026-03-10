# Testing Patterns

This document describes the testing patterns used in the Medication Tracker Bot.

## JSON Golden-File Pattern

To make tests data-driven, declarative, and easy to extend without writing new Go code, we use a JSON golden-file testing pattern for certain packages, particularly `internal/scheduler` and `internal/bot` callbacks.

### How it works
Tests use a reusable harness from the `internal/testharness` package.
Scenarios are defined in `.json` files inside a `testdata/` directory next to the test files.
The harness reads the JSON scenarios, injects the input data into the system, executes the functionality, and does a deep comparison against the expected outcome defined in the JSON.

### Scenario Structure
A typical scenario JSON looks like this:
```json
[
  {
    "name": "Scenario Name",
    "description": "What this scenario verifies",
    "input": {
      "time_now": "2023-10-27T09:00:00Z",
      ...
    },
    "expected": {
      "notifications": 1,
      ...
    }
  }
]
```
The exact schema of `input` and `expected` depends on the specific component being tested. The Go test file uses `json.Unmarshal` to parse these fields into domain-specific structs.

### Adding a New Test Case
To add a new test case for a covered component:
1. Open the relevant `.json` file in the `testdata/` directory (e.g. `internal/scheduler/testdata/bp_reminder_scenarios.json`).
2. Add a new JSON object to the array following the established schema.
3. Run `go test ./...` to verify it passes.
You do not need to write any new Go code!

### Adopting for New Components
If you want to use this pattern for a new component:
1. Create a `testdata/scenarios.json` file.
2. In your `_test.go` file, import `github.com/korjavin/medicationtrackerbot/internal/testharness`.
3. Use `testharness.RunScenarios` to iterate through the file.
4. Unmarshal `s.Input` and `s.Expected` into your own structs.
5. Setup the environment based on the input.
6. Call the function under test.
7. Build the actual result and compare it using `testharness.CompareJSON(t, expected, actual)`.
