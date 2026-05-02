# MCP Coverage Guard

## Overview

Make it impossible to ship a new backend HTTP route without registering a corresponding MCP `Operation` (with description + schemas) — or explicitly opting out via a reviewed allowlist. Today the discipline is informal; the call transcripts proved this rots into real gaps (no `medications.create`, no per-id deletes, no session-level workout actions, etc.). The guard turns "we should remember to add an MCP entry" into a CI-failing test that names the missing route.

The test is intentionally red on day one: there are 18 user-facing routes that belong in the registry but aren't there. This task includes closing every one of those gaps so the guard ships green.

## Context (from discovery)

- Routing is centralized in `internal/server/server.go` (`apiMux.HandleFunc(...)` and outer `mux.HandleFunc(...)` calls — ~139 routes total).
- Registry lives in `internal/mcp/registry/operations_*.go` (workouts/food/health/medications) — ~49 routes covered today.
- Bridge already supports `path_params` substitution (added in the previous task), so `{id}`-templated routes are registerable without further plumbing.
- Inventory:
  - **Covered**: 49
  - **Uncovered, should-be-MCP**: 18 (BP/weight per-id delete, BP/weight reminder controls, food log/product update+delete, food meal-from-logs, workout session per-id actions, workout session delete, exercise-library CRUD)
  - **Internal-only**: ~75 (auth callbacks, static files, bootstrap/init/changes, webpush infra, MCP bridge endpoints themselves, audit hooks, `/internal/*`)

## Development Approach

- **Testing approach**: TDD-ish — write the guard test first, watch it fail with the expected list, then close gaps cluster by cluster until it passes.
- Each task is one logical cluster (recording wrapper, guard test+allowlist, BP/weight gap, food gap, workout session gap, exercise-library gap, misc). Tests for new registry ops live in `registry_test.go` alongside existing per-topic coverage tests.
- All Go tests must pass before moving to the next task — no exceptions.
- The guard test must move from "fails with N missing" → "fails with N-k missing" → ... → "passes" as gaps close. Don't proceed to "Verify" task until it's green.

## Testing Strategy

- **Unit tests**: every new registry op gets coverage in the per-topic test (existing pattern: `TestMedicationOperations` etc. asserts presence + read/write classification + `BodySchema` for writes + `schemasParse`).
- **Guard test** (`mcp_coverage_test.go`): the load-bearing piece. Diffs `routes recorded by recordingMux` vs `(registered ops by Method+Path) ∪ allowlist`. Reports failures with the exact `METHOD /path` so adding a new route + forgetting MCP yields a copy-pasteable diagnostic.
- No new e2e tests — this is purely a registry/coverage refactor.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document blockers with ⚠️ prefix
- Update plan if implementation deviates

## What Goes Where

- **Implementation Steps** (`[ ]`): code, tests, docs in this repo.
- **Post-Completion**: doc updates suggesting how to maintain the guard going forward.

## Implementation Steps

### Task 1: Add route-recording mux wrapper

- [x] add `internal/server/route_record.go` with `RouteSpec{Method, Path}` and `recordingMux` that wraps `*http.ServeMux` and records every `HandleFunc` pattern parsed into method+path
- [x] swap the inner `apiMux` (and outer `mux`) construction in `server.go` to use `recordingMux`; expose `s.recordedRoutes() []RouteSpec` so tests can read the list
- [x] handle the four pattern shapes: `"METHOD /path"`, `"/path"` (no method = any), trailing-slash subtree (`/static/`), and Handle-vs-HandleFunc (need both)
- [x] write tests for `parseRoutePattern` covering all shapes (including malformed input)
- [x] write a smoke test that builds the full server and asserts `recordedRoutes()` is non-empty and contains a known sample (`POST /api/medications`)
- [x] run `go test ./internal/server/...` — must pass before task 2

### Task 2: Add coverage allowlist + guard test (RED)

- [x] create `internal/server/mcp_coverage_exempt.go` listing internal-only routes as `[]routeExemption{Method, Path, Reason}`
- [x] each exemption has a non-empty `Reason` string
- [x] add `internal/server/mcp_coverage_test.go` with `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt`
- [x] add `TestMCPCoverage_ExemptionsHaveReasons`
- [x] add `TestMCPCoverage_NoStaleExemptions`
- [x] add bonus `TestMCPCoverage_NoDuplicateExemptions`
- [x] **RED checkpoint**: guard reports **42 missing routes** (more than the 18 the inventory pre-counted, because I treat reminder controls / Mi-Band / rotation as user-actionable rather than UI-only — see Tasks 3-7 for the closure plan)
- [x] run rest of the suite — passes before task 3

➕ Discovered while building Task 2: the gap is bigger than 18. The new buckets are (a) BP/Weight reminder controls — 8 routes, (b) Mi Band sync — 4 routes, (c) workout rotation state — 2 routes, (d) workout group/variant DELETE — 2 routes, (e) misc reads (workout/sessions/next, exercises/unique, sessions/adhoc, health/overview, notes DELETE — 5 routes), (f) tz-plan approve/reject — 2 routes. Total: 42. Plan tasks 3-7 already cover most of these; Task 7 (mop-up) absorbs the rest.

### Task 3: Close BP/Weight per-id and reminder gaps

- [x] add `health.bp.delete` and `health.weight.delete`
- [x] add `health.bp.reminder.test`
- [x] register reminder controls (toggle/snooze/dontbug/status × bp+weight) — decision: user-actionable, in MCP
- [x] update `TestHealthOperations` to require the new ops
- [x] run guard test — gap dropped 42→32 (10 closed)
- [x] full registry/server suite green

### Task 4: Close food log + product mutation gaps

- [x] add `food.log.update`, `food.log.delete`
- [x] add `food.products.update`, `food.products.delete`, `food.products.from_logs`
- [x] update `TestFoodOperations`
- [x] run guard test — gap dropped 32→26 (6 closed)
- [x] full registry/server suite green

### Task 5: Close workout session per-id action gaps

- [x] add `workouts.sessions.next` (read), `workouts.sessions.adhoc`, `workouts.sessions.delete` (query-param id)
- [x] add `workouts.sessions.snooze/skip/preskip/cancel_preskip/next_variant/start` (path-templated)
- [x] add `workouts.groups.delete`, `workouts.variants.delete` (these were also missing and fit naturally here)
- [x] legacy `/api/workout/session/{snooze,skip}` already in allowlist as compat shims
- [x] update `TestWorkoutOperations`
- [x] run guard test — gap dropped 26→15 (11 closed)
- [x] full registry/server suite green

### Task 6: Close exercise-library mutation gaps

- [x] add `workouts.exercise_library.list`, `.create`, `.update`, `.delete`
- [x] update `TestWorkoutOperations`
- [x] run guard test — gap dropped 15→11 (4 closed)
- [x] full registry/server suite green

### Task 7: Mop up remaining gaps

- [x] add `health.overview`, `health.notes.delete`
- [x] add `medications.tz_plan.approve`, `medications.tz_plan.reject`
- [x] add `workouts.exercises.unique`, `workouts.miband.{list,gps,update,delete}`, `workouts.rotation.{state,initialize}`
- [x] update per-topic tests for the new ids
- [x] **guard test GREEN** — 0 missing routes
- [x] full `go test ./...` green

### Task 8: Verify acceptance criteria

- [x] guard test passes with zero "missing" entries
- [x] every exemption in `mcp_coverage_exempt.go` has a non-empty `Reason` (TestMCPCoverage_ExemptionsHaveReasons)
- [x] no stale exemptions (TestMCPCoverage_NoStaleExemptions)
- [x] `go vet ./...` clean
- [x] `go test ./...` all packages green
- [x] python `pytest` 78 pass / 2 skip (unchanged)

### Task 9: Document the policy

- [x] update `CLAUDE.md`: added "Adding a new HTTP route" section + doc index entry
- [x] create `docs/mcp-coverage.md` with the full policy, recording mux, allowlist buckets, guard test, and how to add routes
- [x] save memory note `feedback_mcp_coverage_guard.md` for future sessions

## Technical Details

**RouteSpec / recordingMux:**

```go
type RouteSpec struct { Method, Path string }
type recordingMux struct {
    *http.ServeMux
    routes []RouteSpec
}
func (m *recordingMux) HandleFunc(pattern string, h http.HandlerFunc) {
    m.routes = append(m.routes, parseRoutePattern(pattern))
    m.ServeMux.HandleFunc(pattern, h)
}
```

**Allowlist shape:**

```go
type routeExemption struct { Method, Path, Reason string }
var mcpCoverageExempt = []routeExemption{
    {"GET",  "/api/init",      "UI bootstrap aggregate; agent uses topic-specific reads"},
    {"GET",  "/api/bootstrap", "UI bootstrap aggregate; agent uses topic-specific reads"},
    // ...
}
```

**Match algorithm:**

Two routes match iff `strings.EqualFold(a.Method, b.Method) && a.Path == b.Path`. Path comparison is literal — `{id}` placeholders must match exactly. The guard does **not** attempt to canonicalize handler-side variations like leading-slash differences; route patterns come from a single source (the recording mux), so they're already normalized.

**Guard failure format:**

```
mcp_coverage_test.go:42: 3 backend route(s) lack MCP coverage:
  POST   /api/foo
  DELETE /api/foo/{id}
  PUT    /api/foo/{id}/bar

Either register an Operation in internal/mcp/registry/operations_<topic>.go
or add to mcp_coverage_exempt.go with a reason.
```

## Post-Completion

**Manual verification** (optional, for confidence):
- Spot-check a couple of new ops via `mcptool` or a script: `medications.update` archive flow, `food.log.delete`, `workouts.sessions.skip`. Not blocking; the unit tests cover the registration shape.

**External system updates**: none. This is purely internal to the bot binary.
