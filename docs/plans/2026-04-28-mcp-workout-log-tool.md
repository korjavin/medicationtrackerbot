# MCP workout_log tool — rich payload protocol with smart resolution

## Overview

Add a new MCP tool `workout_log` that lets an external agent log workouts and exercises through a single, flexible entry point. The tool supports four operations (`help`, `get`, `log`, `delete_exercise`) chosen via an `operation` field on the input. To save the agent's context tokens, the tool's static description is short and points to `operation: "help"` for the full protocol, examples, and rules.

The protocol accepts rich payloads (whole workout in one shot, per-set arrays optional) and the server translates to the existing aggregate storage (`workout_exercise_logs`). When the agent omits sets/reps/weight for a known exercise, the server infers defaults from the most recent log of the same exercise. When an exercise name is fuzzy, the server attempts a single confident match and otherwise returns a structured ambiguity / not-found error that names the missing field and lists candidates so the agent can self-correct in one round-trip.

The operating principle: try our best to honour the request, return partial success when some exercises resolve and others don't, and make every error message actionable. Idempotency is enforced by upserting on (session_id, exercise_name_resolved) so re-sends after partial success refine state instead of creating duplicates.

This iteration covers `workout_log` only. `workout_plan` (groups/variants/schedule) is the next iteration.

## Context

Files involved:
- `internal/mcp/mcp.go` — register the new tool and wire a new `WorkoutWriter`
- `internal/mcp/tools.go` — handler `handleWorkoutLog`, input/response types, help-doc constant
- `internal/mcp/workout_writer.go` (new) — HMAC HTTP client mirroring `food_writer.go`
- `internal/mcp/workout_writer_test.go` (new) — writer tests
- `internal/mcp/tools_test.go` — handler tests (route to the four operations, validation, help passthrough)
- `internal/server/mcp_workout_log.go` (new) — bot HTTP endpoint that receives signed payloads, performs resolution + inference + writes, and returns per-exercise outcomes
- `internal/server/mcp_workout_log_test.go` (new) — endpoint tests
- `internal/server/server.go` — wire the `/api/mcp-workout-log` route alongside the existing `/api/mcp-food-log`
- `internal/domain/workout_resolver.go` (new) — exercise name fuzzy match, defaults inference, payload-to-storage translation
- `internal/domain/workout_resolver_test.go` (new) — unit tests for resolver
- `internal/store/workout.go` — add `ListRecentExerciseLogsByName(ctx, userID, name, limit)` and `GetDistinctExerciseNamesForUser(ctx, userID)` if not already present (verify before adding)
- `internal/store/workout_test.go` — tests for new store methods (only if added)
- `cmd/mcptool/main.go` — initialize and pass `WorkoutWriter` to the MCP server (mirror food writer wiring)
- `docs/mcp-deployment.md` — document the new tool and its operations
- `docs/api.md` — document the new HTTP endpoint

Related patterns:
- Food write tool end-to-end: `internal/mcp/food_writer.go`, `internal/mcp/tools.go:handleLogFoodIntake` (line 994), and the bot's food-log endpoint (sibling of what we're adding)
- Domain service pattern (per `CLAUDE.md`): bot transport is thin; resolver lives in `internal/domain/`
- `internal/workout/service.go` for service-style wrapping
- `store.GetAllUniqueExercises()` in `internal/store/workout.go:410` for catalog dedup
- Existing aggregate columns: `workout_exercise_logs.sets_completed`, `reps_completed`, `weight_kg`

Dependencies: none new. Levenshtein implemented inline (small, no external library).

## Protocol (embedded in help response)

`workout_log` input shape:

```
{
  "operation": "help" | "get" | "log" | "delete_exercise",
  "session_id": int64,           // optional for log (creates ad-hoc if omitted), required for delete_exercise
  "session_ref": "last" | "today" | "YYYY-MM-DD",  // alt to session_id for log/get
  "occurred_at": "YYYY-MM-DD HH:MM" | RFC3339,     // optional for log; defaults to now
  "exercises": [                 // for log
    {
      "name": "biceps curls",
      "sets": 3,                 // optional — inferred from history if omitted
      "reps": 10,                // optional
      "weight_kg": 12.5,         // optional
      "duration_minutes": 0,     // optional, for cardio
      "notes": "",               // optional
      "per_set": [               // optional rich form; aggregates: sets=len, reps=max, weight_kg=max
        {"reps": 10, "weight_kg": 10},
        {"reps": 8,  "weight_kg": 12.5}
      ]
    }
  ],
  "exercise_name": "string",     // for delete_exercise
  "limit": 10                    // for get
}
```

`log` response shape (always 200; the agent inspects per-exercise status):

```
{
  "session_id": 123,
  "occurred_at": "2026-04-28 18:30",
  "results": [
    {"input_name": "biceps curls", "resolved_name": "Biceps Curls", "status": "logged", "log_id": 901, "applied": {"sets":3,"reps":10,"weight_kg":12.5}, "source": "agent"|"inferred"},
    {"input_name": "press",        "status": "ambiguous", "candidates": ["Bench Press","Inclined Press"], "hint": "re-send with one of: ..."},
    {"input_name": "curl",         "status": "missing_defaults", "missing": ["sets","reps","weight_kg"], "hint": "no prior log for this exercise; provide sets/reps/weight"}
  ],
  "summary": "2 logged, 1 ambiguous, 1 missing_defaults"
}
```

Resolution rules:
- Exact case-insensitive name match → resolved.
- Otherwise: substring containment + Levenshtein distance ≤ 2 against catalog (union of `exercise_library.name` and distinct `workout_exercise_logs.exercise_name` for the user). One match → resolved. >1 → `ambiguous` with candidates. 0 → create new exercise name (literal trimmed input) when sets/reps/weight are present; else `missing_defaults`.
- Defaults inference: if any of sets/reps/weight is omitted and the resolved exercise has at least one prior log, fill from the most recent log; mark `source: "inferred"` per applied field.
- Idempotent upsert: `(session_id, resolved_name)` is the conflict key; re-sending with new values updates instead of inserting.

## Development Approach

- Testing approach: regular (code first, then tests). Each task ships with new/updated tests.
- Resolver is pure-ish (takes store reads + a payload, returns a translation plan) so it's heavily unit-tested.
- HTTP endpoint test uses `httptest` like the existing food-log endpoint.
- Handler test mocks `WorkoutWriter` via interface (extract `WorkoutWriter` interface in tools.go, like the food writer is plain struct — see if interface is needed for testability; if so, extract).
- CRITICAL: every task MUST include new/updated tests
- CRITICAL: all tests must pass before starting next task

## Implementation Steps

### Task 1: Domain resolver — fuzzy match, inference, translation

Files:
- Create: `internal/domain/workout_resolver.go`
- Create: `internal/domain/workout_resolver_test.go`
- Modify (only if methods missing): `internal/store/workout.go` — add `ListRecentExerciseLogsByName(ctx, userID, name, limit)` and `GetDistinctExerciseNamesForUser(ctx, userID)`
- Modify (matching): `internal/store/workout_test.go`

- [x] define `ResolverInput` (rich payload) and `ResolverPlan` (per-exercise status + applied values + source) types
- [x] implement `ResolveExercise(ctx, userID, input) (ResolverPlan, error)` with: exact match → substring → Levenshtein ≤ 2 over user catalog (exercise_library ∪ distinct historical names)
- [x] implement defaults inference from most-recent matching log; per-field `source` tracking
- [x] implement per-set aggregation: sets = len(per_set), reps = max(per_set.reps), weight_kg = max(per_set.weight_kg); when both flat fields and per_set are present, prefer per_set
- [x] add missing store helpers (only if not already present) with tests
- [x] write resolver unit tests covering: exact, substring, Levenshtein, ambiguous, no-match-with-defaults, no-match-no-defaults, per-set aggregation, mixed flat+per-set
- [x] run `go test ./internal/domain/... ./internal/store/...` — must pass before task 2

### Task 2: Bot HTTP endpoint /api/mcp-workout-log

Files:
- Create: `internal/server/mcp_workout_log.go`
- Create: `internal/server/mcp_workout_log_test.go`
- Modify: `internal/server/server.go` — register route under same HMAC verification used by `/api/mcp-food-log`

- [x] copy HMAC verification pattern from existing `/api/mcp-food-log` handler
- [x] decode payload, fan out to resolver per exercise, call store upsert (`(session_id, resolved_name)` upsert via existing `LogExerciseWithSource` semantics; add a thin upsert helper if needed)
- [x] implement `operation: "log"` (with optional `session_id`/`session_ref`; create ad-hoc session via `store.CreateAdHocWorkoutSession` when both omitted)
- [x] implement `operation: "get"` (recent N sessions with their exercise logs by user)
- [x] implement `operation: "delete_exercise"` (delete log for `(session_id, exercise_name)`)
- [x] return aggregated response with per-exercise statuses; HTTP 200 even on partial success (only auth/transport errors return non-2xx)
- [x] tests: full payload happy path, partial success (mix of logged/ambiguous/missing_defaults), idempotent re-send, ad-hoc session creation, get, delete_exercise, HMAC failure
- [x] run `go test ./internal/server/...` — must pass before task 3

### Task 3: MCP-side WorkoutWriter (HMAC HTTP client)

Files:
- Create: `internal/mcp/workout_writer.go`
- Create: `internal/mcp/workout_writer_test.go`
- Modify: `cmd/mcptool/main.go` — construct and inject `WorkoutWriter` (mirror food writer wiring; share same `MCP_AUDIT_ENDPOINT`/`MCP_AUDIT_SECRET` envs, derive `/api/mcp-workout-log` from base if present, otherwise allow override env)
- Modify: `internal/mcp/mcp.go` — add `workoutWriter` field on `Server`, plumb through constructor

- [x] implement `WorkoutWriter.Call(ctx, payload) (rawJSON, error)` returning the bot's full response unchanged
- [x] envelope error responses (transport vs application) so handler can pass body through to the agent verbatim
- [x] tests using `httptest.Server` to verify HMAC header, body, status handling
- [x] run `go test ./internal/mcp/...` — must pass before task 4

### Task 4: MCP tool handler + registration + help docs

Files:
- Modify: `internal/mcp/tools.go` — add `WorkoutLogInput`, `WorkoutLogResponse`, `handleWorkoutLog`, `workoutLogHelpDoc` constant
- Modify: `internal/mcp/mcp.go` — `registerTools()` add `mcp.AddTool(...)` for `workout_log`
- Modify: `internal/mcp/tools_test.go` — handler tests

- [ ] author the `workoutLogHelpDoc` constant (full protocol, examples, resolution rules; the same content as the Protocol section above) and return it verbatim under `operation: "help"` without calling the writer or DB
- [ ] short tool description that mentions `operation: "help"` as the entry point and lists the four operations
- [ ] dispatch on `operation`: validate, call `WorkoutWriter`, pass response through; on `help` return the doc; on unknown operation return an error suggesting `help`
- [ ] feature gate via `ensureFeatureEnabled(ctx, "workouts")` (or current workout feature key — verify in code)
- [ ] handler tests for each operation including help (no network call), invalid operation, writer error passthrough
- [ ] run `go test ./internal/mcp/...` — must pass before task 5

### Task 5: Verify acceptance criteria

- [ ] run `go test ./...` — full suite must pass
- [ ] run `go vet ./...` and `gofmt -l .` — must be clean
- [ ] confirm idempotency in tests: re-send same `log` payload, verify no duplicate rows in `workout_exercise_logs`

### Task 6: Update documentation

- [ ] update `docs/mcp-deployment.md` with the new tool name, brief operation summary, and a pointer to call `operation: "help"` for the full protocol
- [ ] update `docs/api.md` with the `/api/mcp-workout-log` endpoint
- [ ] update `CLAUDE.md` "Adding an MCP tool" cross-reference if the procedure changed
- [ ] move this plan to `docs/plans/completed/`
