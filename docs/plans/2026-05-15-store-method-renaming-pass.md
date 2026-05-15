# Store Method-Naming Consistency Pass

## Overview

After the per-domain store split, each repo's method names are still a snapshot of the historical `*Store` god-object's vocabulary. The result is a grab-bag of synonyms: `Create…` vs `Add…` for inserts, `Get…` vs `Fetch…` vs `Find…` vs `List…` for reads, and repo-package-qualified method names that re-state the domain redundantly (e.g. `medication.Repo.CreateMedication` reads as `medication.Repo.Create` would).

This plan applies a mechanical rename pass across all per-domain repos to converge on one verb per operation, drop redundant domain suffixes where the package name already provides them, and fix pluralization (`Get` for single-row, `List` for multi-row). It is a pure rename with no behavior or SQL change.

## Context

- Adopted from `docs/plans/2026-05-14-store-method-renaming-pass.md` (stub captured as follow-up from the completed split-store-package plan).
- Impacted packages: `internal/store/{medication,bp,weight,food,workout,vitals,diary,tz,settings,auth,push}` plus consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`.
- Adapter structs at `internal/scheduler/adapter.go`, `internal/bot/adapter.go`, `internal/mcp/adapter.go`, and `cmd/bot/tz_planner_adapter.go` forward to repos and may need explicit bridges when consumer-interface names diverge from repo method names.
- MCP registry operations in `internal/mcp/registry/operations_*.go` may reference store methods by string name — grep before each Task.
- The `store.Store = store.Repos` alias and type-name aliases (`store.Medication = medication.Medication`) are out of scope and must be left untouched.
- Per-PR validation: `go test ./...` + `go test -race ./...` + `golangci-lint run` must remain green at every Task boundary.

## Development Approach

- Testing approach: regular (renames are mechanical; existing tests catch behavior regressions)
- One Task per repo package, mirroring the original split order — keep each Task mechanical and reviewable
- Update consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go` together with each repo rename — they are renamed together or not at all (CI catches mismatch)
- Complete each task fully (rename → adapters → consumer interfaces → tests green → linter clean) before moving to the next
- Update this plan when scope changes during implementation

## Testing Strategy

- Run `go test ./...` after every Task — must pass before proceeding
- Run `go test -race ./...` after every Task — must pass before proceeding
- Run `golangci-lint run` after every Task — must pass before proceeding
- No new tests required for renames themselves; existing tests verify behavior is preserved
- Add or adjust a unit test only if a method-name change requires a corresponding test-side update (e.g., a reflect-based adapter test)

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Update plan if implementation deviates from original scope

## Technical Details

### Naming rules to apply

- **One verb per operation**: `Create` / `Get` / `List` / `Update` / `Delete` / `Set` / `Upsert` / `Import` / `Batch…`. Drop `Add`, `Fetch`, `Find`.
- **Drop domain redundancy** where the package name already provides it: `medication.Repo.Create` (not `CreateMedication`), `bp.Repo.GetReadings` (not `GetBloodPressureReadings`). Keep the suffix only when a single repo owns multiple distinct entities (e.g. `medication.Repo.CreateIntake`, `medication.Repo.CreateRestock` are siblings).
- **Resolve `Get…` vs `Fetch…` to `Get…`** everywhere.
- **Pluralization**: `Get` for single-row, `List` for multi-row. Rename slice-returning readers like `GetExerciseLogs`, `GetIntakesSince` to `List…`.

### Out of scope

- Domain types / column names.
- Renames inside `internal/store/migrations/` SQL files.
- Splitting any repo or moving methods between repos.
- Removing the `store.Store = store.Repos` alias.

### Known risks

- **Adapter structs** (`internal/scheduler/adapter.go`, `internal/bot/adapter.go`, `internal/mcp/adapter.go`, `cmd/bot/tz_planner_adapter.go`) define method names that satisfy a consumer interface and forward to a repo. Renaming the repo method changes both sides. If a consumer interface is intentionally kept under the old name for callsite stability, the adapter needs an explicit one-line bridge instead of a same-name forward.
- **MCP registry** operations in `internal/mcp/registry/operations_*.go` reference store methods by string name in some handlers. Grep before each rename Task.
- **Reflect-based tests**: a handful of tests use reflect to assert method-name presence on adapters. Grep step above catches these.

## Implementation Steps

### Task 1: Inventory and rename mapping

- [ ] grep every repo package under `internal/store/` for exported method names and produce an old→new mapping per package
- [ ] confirm the mapping against the naming rules in Technical Details (one verb, drop redundancy, `Get` vs `List`)
- [ ] grep the codebase for string references to store method names (`internal/mcp/registry/operations_*.go`, reflect-based tests, comments) and note any callsites that need manual updates beyond `gopls rename`
- [ ] note adapter methods in `internal/scheduler/adapter.go`, `internal/bot/adapter.go`, `internal/mcp/adapter.go`, `cmd/bot/tz_planner_adapter.go` that will need to follow consumer-interface names
- [ ] document the mapping inline in this plan (append a "Rename mapping" subsection under Technical Details) so each subsequent Task can reference it
- [ ] run project tests - must pass before next task

### Task 2: Rename medication repo methods

- [ ] apply rename mapping to `internal/store/medication/` (e.g. `CreateMedication` → `Create`, `AddRestock` → `CreateRestock`, `AddIntakeReminder` → `CreateIntakeReminder`)
- [ ] update consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go` to match
- [ ] update adapter forwarders in `internal/scheduler/adapter.go`, `internal/bot/adapter.go`, `internal/mcp/adapter.go`, `cmd/bot/tz_planner_adapter.go` where they touch medication
- [ ] update MCP registry operation handlers in `internal/mcp/registry/operations_medication*.go` if they reference renamed methods
- [ ] update tests inside `internal/store/medication/` and any caller tests
- [ ] run project tests - must pass (`go test ./...`, `go test -race ./...`, `golangci-lint run`)

### Task 3: Rename BP repo methods

- [ ] apply rename mapping to `internal/store/bp/` (e.g. `GetBloodPressureReadings` → `GetReadings` or `ListReadings`; `Get…` vs `Fetch…` collapses to `Get…`)
- [ ] update consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`
- [ ] update adapter forwarders in scheduler/bot/mcp adapters and `cmd/bot/tz_planner_adapter.go`
- [ ] update MCP registry operation handlers in `internal/mcp/registry/operations_bp*.go`
- [ ] update tests inside `internal/store/bp/` and any caller tests
- [ ] run project tests - must pass (`go test ./...`, `go test -race ./...`, `golangci-lint run`)

### Task 4: Rename weight repo methods

- [ ] apply rename mapping to `internal/store/weight/`
- [ ] update consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`
- [ ] update adapter forwarders in scheduler/bot/mcp adapters and `cmd/bot/tz_planner_adapter.go`
- [ ] update MCP registry operation handlers in `internal/mcp/registry/operations_weight*.go`
- [ ] update tests inside `internal/store/weight/` and any caller tests
- [ ] run project tests - must pass (`go test ./...`, `go test -race ./...`, `golangci-lint run`)

### Task 5: Rename food repo methods

- [ ] apply rename mapping to `internal/store/food/`
- [ ] update consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`
- [ ] update adapter forwarders in scheduler/bot/mcp adapters and `cmd/bot/tz_planner_adapter.go`
- [ ] update MCP registry operation handlers in `internal/mcp/registry/operations_food*.go`
- [ ] update tests inside `internal/store/food/` and any caller tests
- [ ] run project tests - must pass (`go test ./...`, `go test -race ./...`, `golangci-lint run`)

### Task 6: Rename workout repo methods

- [ ] apply rename mapping to `internal/store/workout/` including the mi-band sub-area (e.g. `GetExerciseLogs` → `ListExerciseLogs`)
- [ ] update consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`
- [ ] update adapter forwarders in scheduler/bot/mcp adapters and `cmd/bot/tz_planner_adapter.go`
- [ ] update MCP registry operation handlers in `internal/mcp/registry/operations_workout*.go`
- [ ] update tests inside `internal/store/workout/` and any caller tests
- [ ] run project tests - must pass (`go test ./...`, `go test -race ./...`, `golangci-lint run`)

### Task 7: Rename vitals repo methods

- [ ] apply rename mapping to `internal/store/vitals/` (sleep + day stats; rename slice-returning readers like `GetIntakesSince` → `ListIntakesSince` if applicable)
- [ ] update consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`
- [ ] update adapter forwarders in scheduler/bot/mcp adapters and `cmd/bot/tz_planner_adapter.go`
- [ ] update MCP registry operation handlers in `internal/mcp/registry/operations_vitals*.go`
- [ ] update tests inside `internal/store/vitals/` and any caller tests
- [ ] run project tests - must pass (`go test ./...`, `go test -race ./...`, `golangci-lint run`)

### Task 8: Rename tz repo methods

- [ ] apply rename mapping to `internal/store/tz/` (timezone history + transition plans/steps)
- [ ] update consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`
- [ ] update adapter forwarders especially `cmd/bot/tz_planner_adapter.go`
- [ ] update MCP registry operation handlers in `internal/mcp/registry/operations_tz*.go` if any
- [ ] update tests inside `internal/store/tz/` and any caller tests
- [ ] run project tests - must pass (`go test ./...`, `go test -race ./...`, `golangci-lint run`)

### Task 9: Rename settings repo methods

- [ ] apply rename mapping to `internal/store/settings/` (incl. download cursor + change_events)
- [ ] update consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`
- [ ] update adapter forwarders in scheduler/bot/mcp adapters
- [ ] update MCP registry operation handlers in `internal/mcp/registry/operations_settings*.go` if any
- [ ] update tests inside `internal/store/settings/` and any caller tests
- [ ] run project tests - must pass (`go test ./...`, `go test -race ./...`, `golangci-lint run`)

### Task 10: Rename auth repo methods

- [ ] apply rename mapping to `internal/store/auth/` — specifically rename `FindAPITokenByHash` → `GetAPITokenByHash` (the only `Find…` in the codebase), plus any other Find/Fetch holdovers
- [ ] update consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`
- [ ] update adapter forwarders in scheduler/bot/mcp adapters
- [ ] update MCP registry operation handlers in `internal/mcp/registry/operations_auth*.go` if any
- [ ] update tests inside `internal/store/auth/` and any caller tests
- [ ] run project tests - must pass (`go test ./...`, `go test -race ./...`, `golangci-lint run`)

### Task 11: Verify acceptance criteria

- [ ] grep the codebase for any remaining `Add`, `Fetch`, `Find` prefixed exported methods on `internal/store/**/Repo` — should be zero
- [ ] grep for redundant domain suffixes (`CreateMedication`, `GetBloodPressureReadings`, etc.) — should be zero where the package name already provides the domain
- [ ] verify `store.Store = store.Repos` alias is untouched
- [ ] verify `internal/store/migrations/` SQL files are untouched
- [ ] verify type aliases (`store.Medication = medication.Medication`) are untouched
- [ ] run full project test suite: `go test ./...` and `go test -race ./...`
- [ ] run project linter: `golangci-lint run` - all issues must be fixed

## Post-Completion

*Items requiring manual intervention - no checkboxes, informational only*

- This pass is mechanical and ships as ~9 PRs (one per repo). Squash-merging is not used here — follow the project's "merge with merge commit" rule.
- The Open Questions from the original stub (renaming `Repo` itself, aligning `Repos` aggregator field names) are deferred and not part of this plan.
- After completion, consider a follow-up to revisit type-name awkwardness (`medication.Medication` → `medication.Record` or `medication.Entry`) as a separate pass.
