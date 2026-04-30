# Implement Tao of Mac (ToM) ideas for mcp_execute help

## Overview
This plan implements "Tao of Mac" (ToM) design principles to improve the `mcp_help` tool. The goal is to make the discovery process more goal-oriented, reduce "import forgetfulness" in generated scripts by providing complete copy-pasteable examples, and prevent hard errors when an unknown topic is requested by suggesting available intents instead.

## Context
- Files involved:
  - `internal/mcp/help.go`: Implementation of the `mcp_help` tool.
  - `internal/mcp/registry/registry.go`: Data structures and transformation logic for help entries.
  - `internal/mcp/help_test.go`: Integration tests for help functionality.
  - `internal/mcp/registry/*.go`: Operation definitions (used for verification).
- Related patterns:
  - The registry uses `MarshalForHelp` to transform internal `Operation` structs into `HelpEntry` for public consumption.
  - `mcp_help` is a tool that provides documentation to the model about available API operations.

## Development Approach
- **Testing approach**: Integration tests in `internal/mcp/help_test.go` and `internal/mcp/registry/registry_test.go`. No unit tests, only integration tests.
- Complete each task fully before moving to the next.
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Update Response Structures and MarshalForHelp

**Files:**
- Modify: `internal/mcp/help.go`
- Modify: `internal/mcp/registry/registry.go`

- [x] Add `NextStep` (string) and `NextTools` ([]string) to `HelpResponse` struct in `internal/mcp/help.go`.
- [x] Update `MarshalForHelp` in `internal/mcp/registry/registry.go` to prepend `from medtracker import api, output\n\n` and append `\noutput(result)` (if not already present) to every non-empty `Example` field to make it a complete script.
- [x] Ensure `MarshalForHelp` does not add redundant imports if they are somehow already present in the source operation.
- [x] Verify `MarshalForHelp` logic with a small test case in `internal/mcp/registry/registry_test.go`.

### Task 2: Implement Goal-Oriented Responses

**Files:**
- Modify: `internal/mcp/help.go`

- [ ] Define a mapping in `handleMCPHelp` to provide context-aware `NextStep` suggestions based on the requested topic:
    - `workouts`: "List the available workout groups to see what you can track."
    - `food`: "Search for a food item or list recent logs to see your nutrition summary."
    - `health`: "List vital logs (weight, blood pressure) to see your progress."
    - `medications`: "List your medication schedule to see what is due or check specific medication details."
    - `all` / empty: "Pick a topic (e.g., 'workouts') or lookup an operation by ID to start building a script."
- [ ] Set `NextTools` to `["mcp_execute"]` for all successful help responses.
- [ ] Update the meta-instructional `Note` to be less about tool usage and more about the specific requested topic.

### Task 3: Graceful Handling for Unknown Topics/Operations

**Files:**
- Modify: `internal/mcp/help.go`

- [ ] Update `handleMCPHelp` to handle unknown `topic` or `operation_id` without returning a hard Go `error`:
    - Return a `HelpResponse` with `Count: 0`.
    - Populate `Topics` with all available topics from the registry.
    - Set `NextStep` to a message like "Topic '[name]' not found. Try one of the available topics listed below."
- [ ] Ensure this "success-with-error-message" pattern correctly informs the model without stopping its execution flow.

### Task 4: Verify and Update Tests

**Files:**
- Modify: `internal/mcp/help_test.go`
- Modify: `internal/mcp/registry/registry_test.go`

- [ ] Update `TestMCPHelp_UnknownTopic` and `TestMCPHelp_UnknownOperationID` in `internal/mcp/help_test.go` to expect success with suggestions instead of an error.
- [ ] Add new test cases to verify `NextStep` and `NextTools` are populated correctly for different topics.
- [ ] Update `TestMCPHelp_WorkoutsTopicHasExamples` to verify the examples now include the boilerplate imports and output call.
- [ ] Run full test suite: `go test ./internal/mcp/... ./internal/mcp/registry/...`

### Task 5: Finalize and Documentation

- [ ] Verify `pythonUsageSnippet` in `help.go` is still useful or update it if it feels redundant with the new complete examples.
- [ ] Run linter: `golangci-lint run ./internal/mcp/...`
- [ ] Update `README.md` if any user-facing help behavior changed significantly.
- [ ] Move this plan to `docs/plans/completed/`.
