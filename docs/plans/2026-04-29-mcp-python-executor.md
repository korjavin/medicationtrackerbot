---
# MCP Python Executor And API Proxy

## Overview
Build a new MCP execution path that lets an agent run constrained Python scripts against the application's existing backend APIs. Add `mcp_help` (catalog of allowed backend operations) and `mcp_execute` (sandboxed Python runner). Authority stays in a local API proxy backed by an allowlisted operation registry; scripts call the app via a narrow `medtracker` Python helper. Decision doc: docs/mcp-python-executor.md.

## Context
- Files involved:
  - `internal/mcp/` — existing MCP server (mcp.go, tools.go, oauth.go, audit.go, cardiovascular.go, fitness.go, food_writer.go, workout_writer.go, vitals.go, notes_helper.go, admin.go)
  - `cmd/mcptool/main.go` — MCP entry point
  - `internal/server/` — backend HTTP handlers (will host the bridge endpoint)
  - `docs/mcp-python-executor.md` — decision doc (keep current)
  - `docs/mcp-deployment.md` — deployment doc to extend
  - `Dockerfile`, `docker-compose.yml` — runtime wiring
- Related patterns:
  - Domain service pattern is mandatory; the bridge calls existing backend HTTP routes / domain services rather than reimplementing logic.
  - HMAC-protected internal endpoints already exist for write tools — reuse the pattern for the bridge.
  - `log/slog` with contextual args for all new logging.
- Dependencies:
  - Python runtime in a separate runner image (no `pip install` at run time).
  - JSON Schema validation for params/body in registry entries (Go side).

## Development Approach
- **Testing approach**: Regular (code first, then tests). Go unit/integration tests; Python smoke tests inside the runner image; sandbox tests for limits.
- Build the authority boundary (registry, bridge, proxy) before broad capabilities.
- Prefer small vertical slices that can be demonstrated end to end; first slice is read-only workouts.
- Keep existing granular and composite MCP tools operational throughout; do not break their tests.
- Treat the operation registry as permission/documentation, not a workflow DSL.
- Use `log/slog` everywhere; no hardcoded secrets; redact bodies and tokens in logs.
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Record decision and initial constraints

**Files:**
- Modify: `docs/mcp-python-executor.md`
- Modify: `docs/mcp-deployment.md`

- [x] keep `docs/mcp-python-executor.md` current as the architectural decision record
- [x] add a short pointer in `docs/mcp-deployment.md` describing where the executor lives and which env vars it consumes (placeholder is fine until Task 14)
- [x] document non-negotiable constraints inline: no user token in script, proxy-only API access, bounded execution, explicit write mode
- [x] document default limits: 30s timeout, 1 GB memory, 100 MB result size, 100 API calls
- [x] decide and record separate stdout/stderr and backend response body limits (concrete numbers in the doc)
- [x] no code/tests in this task; run `go test ./...` as a baseline before Task 2

### Task 2: Operation registry

**Files:**
- Create: `internal/mcp/registry/registry.go`
- Create: `internal/mcp/registry/registry_test.go`
- Create: `internal/mcp/registry/operations_workouts.go`

- [x] define Go data model for an operation entry: ID, topic, method, path, risk (`read`/`write`), params schema, body schema, response summary
- [x] add validation: unique IDs across registry; risk must be `read` or `write`; method/path non-empty; topic non-empty
- [x] add lookup helpers: `Get(id)`, `ByTopic(topic)`, `All()`
- [x] populate initial `workouts` registry entries: groups list, variant list, exercise list, session list, stats read
- [x] add `MarshalForHelp()` that returns compact docs serialization for `mcp_help`
- [x] write tests: registration validation (duplicate ID, bad risk), `Get`, `ByTopic`, `MarshalForHelp` shape
- [x] run `go test ./internal/mcp/...` — must pass before Task 3

### Task 3: Backend bridge for proxied API calls

**Files:**
- Create: `internal/server/mcp_bridge.go`
- Create: `internal/server/mcp_bridge_test.go`
- Modify: `internal/server/router.go` (or wherever HTTP routes are registered)

- [ ] create an internal HMAC-protected endpoint `/internal/mcp/bridge` (separate from public browser auth)
- [ ] reuse existing HMAC verification pattern from current MCP write tools
- [ ] execute calls as the configured allowed user; reject any attempt to override user identity in the request
- [ ] route only operation-registry calls through this bridge (validate op ID against registry)
- [ ] normalize backend responses into a JSON envelope: `{status, body, headers_subset, duration_ms}`
- [ ] enforce request and response body size limits (use values from Task 1)
- [ ] emit slog audit metadata: operation ID, risk, status, duration, truncated error
- [ ] tests: HMAC required, identity cannot be spoofed, unknown op rejected, size limits enforced, audit fields present
- [ ] run `go test ./internal/server/...` and `go test ./internal/mcp/...` — must pass before Task 4

### Task 4: API proxy boundary

**Files:**
- Create: `internal/mcp/proxy/proxy.go`
- Create: `internal/mcp/proxy/proxy_test.go`

- [ ] add a proxy component used by the executor service; in-process Go component that talks to the bridge over HTTP+HMAC
- [ ] reject unknown operation IDs (registry lookup)
- [ ] reject write operations when run mode is `read_only`
- [ ] enforce per-run max API calls (counter passed in run context)
- [ ] enforce optional `topic_allowlist` per run
- [ ] forward allowed calls to the backend bridge with internal auth (HMAC)
- [ ] return structured call traces: `{operation_id, risk, status, duration_ms, error?}`
- [ ] tests with a fake bridge: unknown op rejected, write blocked in read-only, max-calls enforcement, topic-allowlist enforcement, trace fields populated
- [ ] run `go test ./internal/mcp/...` — must pass before Task 5

### Task 5: `mcp_help` tool

**Files:**
- Create: `internal/mcp/help.go`
- Create: `internal/mcp/help_test.go`
- Modify: `internal/mcp/mcp.go` (register tool)

- [ ] register `mcp_help` in the MCP server tool list
- [ ] support `topic` filter (default: `all`)
- [ ] support `operation_id` exact lookup
- [ ] include compact Python examples using `from medtracker import api, output`
- [ ] keep static MCP tool description short; put detailed docs in the tool response
- [ ] tests: full catalog, topic filter, operation_id lookup, unknown topic, unknown operation ID
- [ ] run `go test ./internal/mcp/...` — must pass before Task 6

### Task 6: `mcp_execute` request handling

**Files:**
- Create: `internal/mcp/execute.go`
- Create: `internal/mcp/execute_test.go`
- Modify: `internal/mcp/mcp.go` (register tool)

- [ ] register `mcp_execute` in the MCP server
- [ ] define input schema: `script`, `mode` (`read_only`|`write`), `intent`, `timeout_ms`, `max_api_calls`, `topic_allowlist`
- [ ] default `mode` to `read_only`
- [ ] require `intent` when `mode == "write"`; non-empty string
- [ ] cap caller-provided limits by server config; defaults: 30s, 1 GB memory, 100 MB result, 100 API calls
- [ ] return structured success envelope: `{status, result, api_calls, stdout, stderr, warnings}`
- [ ] return structured failure envelope distinguishing: `script_error`, `timeout`, `sandbox_startup_failure`, `proxy_denied`, `backend_application_error`, `backend_transport_error`
- [ ] integration tests using a fake execution service: schema validation, mode defaulting, intent required for write, limit capping, success/failure envelope shapes for each error type
- [ ] run `go test ./internal/mcp/...` — must pass before Task 7

### Task 7: Python helper package `medtracker`

**Files:**
- Create: `python/medtracker/__init__.py`
- Create: `python/medtracker/api.py`
- Create: `python/medtracker/output.py`
- Create: `python/medtracker/exceptions.py`
- Create: `python/tests/test_api.py`
- Create: `python/tests/test_output.py`
- Create: `python/pyproject.toml`

- [ ] implement `api.call(operation_id, params=None, body=None)` posting to the local proxy URL from env
- [ ] implement `output(value)` recording the final result; reject non-JSON-serializable input
- [ ] define typed exceptions: `ProxyDenied`, `BackendError`, `TimeoutError`, `SerializationError`
- [ ] expose no raw token, host, secret, or generic HTTP client
- [ ] tests with a mocked proxy: success, params/body, proxy 4xx denial, backend 5xx, non-serializable output, single `output(...)` enforced
- [ ] run `pytest python/` — must pass before Task 8

### Task 8: Sandboxed runner

**Files:**
- Create: `python/runner/runner.py`
- Create: `python/runner/runner_test.py`
- Create: `python/runner/limits.py`

- [ ] runner entrypoint that receives script + run config (timeout, max_api_calls, mode, topic_allowlist) over stdin or local socket
- [ ] execute scripts with a hard wall-clock timeout
- [ ] capture bounded stdout and stderr (limits from Task 1)
- [ ] collect final `output(...)` value via the helper
- [ ] strip secrets from the env passed to script (only proxy URL + run token reach the script)
- [ ] document runner-side prohibitions: arbitrary HTTP, package installs, filesystem writes outside scratch, long-running loops
- [ ] tests: timeout kills script, stdout/stderr truncation, env scrubbed, single-output enforced, proxy URL is the only network knob
- [ ] run `pytest python/` — must pass before Task 9

### Task 9: Side container / execution service

**Files:**
- Create: `internal/mcp/executor/service.go`
- Create: `internal/mcp/executor/service_test.go`
- Create: `docker/runner/Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `Dockerfile` (or coordinate base image)

- [ ] implement an MVP long-lived execution service in Go that spawns subprocesses with per-run isolation
- [ ] add `docker/runner/Dockerfile` for the runner image: non-root user, read-only root FS in deployment, only the `medtracker` helper baked in, no `pip` at runtime
- [ ] configure compose network so the runner can reach only the local API proxy
- [ ] set CPU and memory limits in compose (use defaults from Task 1)
- [ ] ensure the MCP container does not mount the Docker socket
- [ ] add health/startup checks for the execution service
- [ ] tests: service start/stop, run isolation, run failure does not crash service, max concurrent runs respected
- [ ] run `go test ./internal/mcp/...` — must pass before Task 10

### Task 10: Read-only workout vertical slice

**Files:**
- Modify: `internal/mcp/registry/operations_workouts.go`
- Create: `internal/mcp/executor/e2e_workouts_test.go`
- Create: `python/examples/workouts_overview.py`

- [ ] expose read-only workout operation entries: groups, variants, exercises, sessions, stats
- [ ] verify `mcp_help(topic="workouts")` returns useful docs and the example script
- [ ] add an `mcp_execute` E2E test that lists groups, finds a variant, lists exercises, and returns a summary
- [ ] assert the same workflow works without direct DB access from the script
- [ ] assert audit/call trace contains every proxied operation ID
- [ ] add a Python example script under `python/examples/`
- [ ] run `go test ./internal/mcp/...` and `pytest python/` — must pass before Task 11

### Task 11: Write mode

**Files:**
- Modify: `internal/mcp/execute.go`
- Modify: `internal/mcp/proxy/proxy.go`
- Modify: `internal/mcp/registry/operations_workouts.go`
- Modify: `internal/mcp/executor/e2e_workouts_test.go`

- [ ] enable `mode: "write"` end-to-end in `mcp_execute`
- [ ] require non-empty `intent` for every write run; include `intent` in audit metadata
- [ ] reject writes in `read_only` mode at the proxy layer (already wired in Task 4 — verify and test)
- [ ] add the first write op to the registry (low-risk workout op, e.g. `workouts.exercises.update`)
- [ ] require operation-level write classification in the registry before any mutating route can be exposed
- [ ] assert writes flow through backend domain validation and existing change/audit behavior
- [ ] tests: write succeeds in write mode, accidental write attempt in read-only mode is rejected with `proxy_denied`, missing intent rejected, audit contains intent
- [ ] run `go test ./...` — must pass before Task 12

### Task 12: Expand domain coverage

**Files:**
- Create: `internal/mcp/registry/operations_food.go`
- Create: `internal/mcp/registry/operations_health.go`
- Create: `internal/mcp/registry/operations_medications.go`
- Modify: `internal/mcp/registry/registry.go` (wire new topics)
- Modify: `internal/mcp/registry/registry_test.go`

- [ ] add food read operations
- [ ] add food write operations (where backend validation is already strong)
- [ ] add health read operations: BP, weight, sleep, vitals, steps, notes
- [ ] add medication read/write operations only after user identity and write audit behavior are confirmed (gate behind a verification subtask)
- [ ] add workout plan mutation operations needed for group, variant, and exercise editing
- [ ] keep operation docs concise enough for agent context
- [ ] tests: each new topic appears in `mcp_help`, lookup by ID works, write ops carry `risk: "write"`, schemas validate
- [ ] run `go test ./...` — must pass before Task 13

### Task 13: Observability and failure handling

**Files:**
- Modify: `internal/mcp/executor/service.go`
- Modify: `internal/mcp/proxy/proxy.go`
- Modify: `internal/mcp/execute.go`
- Modify: `internal/server/mcp_bridge.go`

- [ ] structured slog logs for run ID, mode, duration, exit reason, API call count
- [ ] audit fan-out for write runs (and optionally read runs, behind config)
- [ ] redact secrets and large payloads from logs (truncate bodies, redact bearer/HMAC headers)
- [ ] stable error codes for common failures (string constants reused across envelope and tests)
- [ ] max concurrent runs enforced (config + slog)
- [ ] cleanup for abandoned/timeout runner processes
- [ ] tests: log fields present, redaction works, max-concurrency rejection, abandoned run cleaned up
- [ ] run `go test ./...` — must pass before Task 14

### Task 14: Deployment and user docs

**Files:**
- Modify: `docs/mcp-deployment.md`
- Modify: `docs/environment.md`
- Modify: `docs/api.md`
- Modify: `docker-compose.yml`
- Create: `python/examples/food_log.py`
- Create: `python/examples/workout_plan_edit.py`

- [ ] document new env vars and defaults (proxy URL, HMAC key var, runner image, limits)
- [ ] update Docker Compose with the runner/proxy pieces
- [ ] document local development setup
- [ ] document production hardening assumptions (read-only root FS, no Docker socket, capability drops, network isolation)
- [ ] add example scripts for read-only analysis, workout inspection, workout plan editing, and food logging
- [ ] explain why scripts use `medtracker.api.call` instead of raw HTTP
- [ ] run `go test ./...` and `pytest python/` — must pass before Task 15

### Task 15: Transition strategy for existing tools

**Files:**
- Modify: `internal/mcp/mcp.go` (no removals)
- Modify: `docs/mcp-deployment.md`
- Modify: `README.md`
- Modify: `docs/features.md`

- [ ] keep granular tools while the executor is experimental (no deletions)
- [ ] keep `workout_log` while its inference is better than raw orchestration
- [ ] stop adding new composite tools unless there is a clear stable use case (note this in docs)
- [ ] evaluate whether `analyze_fitness` and `analyze_cardiovascular` become compatibility tools after executor coverage is broad — record decision in docs (no removal yet)
- [ ] update README/features docs when the stable MCP recommendation changes
- [ ] tests: existing MCP tool registration tests still pass (`./internal/mcp/...`)
- [ ] run `go test ./...` — must pass before Task 16

### Task 16: Verify acceptance criteria

- [ ] run `go test ./...` (all Go tests)
- [ ] run `pytest python/` (helper + runner tests)
- [ ] run runner sandbox tests (timeout, limits, env scrub, output bounds)
- [ ] run MCP execute fake-service tests
- [ ] run backend bridge/proxy integration tests
- [ ] run the read-only E2E workout script test
- [ ] run the write-mode E2E script test
- [ ] verify slog audit logs contain operation IDs, risk, intent (for writes), and run IDs
- [ ] verify test coverage for `internal/mcp/...` and `python/medtracker/` meets 80%+

### Task 17: Update documentation

- [ ] update `README.md` if user-facing changes (mention `mcp_help` / `mcp_execute`)
- [ ] update `CLAUDE.md` if internal patterns changed (registry/proxy/bridge layering)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
Expected final state:
- Agents can discover backend capabilities with `mcp_help`.
- Agents can complete complex multi-step workflows with one `mcp_execute` call.
- Python scripts can compose logic but cannot hold user authority.
- The backend remains the source of validation and mutation semantics.
- The MCP tool list remains small even as available backend capabilities grow.
- Existing MCP tools continue working until intentionally deprecated.
