# Demo-mode MCP execute (rate-limited Python executor for the voice agent)

## Overview

The ElevenLabs voice agent connects to our MCP server to read user health data. The project has consolidated the MCP tool surface onto `mcp_help` + `mcp_execute` (Python scripts that call `medtracker.api.call(...)` through the bridge). In demo mode we currently hard-refuse to wire `MCP_EXECUTOR_BRIDGE_URL`, which leaves the agent with no usable tools — the demo at `demo.myhealthbot.ai` cannot answer any data question.

This plan lifts that hard refusal in favor of a metered posture:

1. Allow `MCP_EXECUTOR_BRIDGE_URL` in demo mode.
2. Per-IP rate limit on the `mcp_execute` tool (default 5/hour) using the same `demo_rate_limit` JSON shape the food/elevenlabs endpoints already emit, so the frontend / agent sees a recognisable 429.
3. Tighter per-script caps in demo mode (10s timeout, 10 API calls per script) so even an allowed script can't burn 100 AI calls.
4. Surface the limit in `/api/bootstrap`'s `demo` block for symmetry with the existing rate limits.

The result: the voice agent works in demo deployments, but the cost ceiling per IP per day is bounded and small (≤ 5 scripts × 10 backend calls = 50 calls/hour/IP), and any abuse hits a clear 429 instead of silently piling up.

Demo mode stays opt-in (`DEMO_MODE=1`); production paths are untouched.

## Context (from discovery)

Files involved:

- `internal/config/config.go` — `DemoConfig` already groups demo rate-limit fields; this adds three more (`MCPExecuteCallsPerHour`, `MCPExecutorMaxAPICalls`, `MCPExecutorMaxTimeoutMS`).
- `internal/config/config_test.go` — env-loading tests for `DemoConfig`.
- `internal/mcp/mcp.go` — `LoadConfigFromEnv` and `NewServer`. Currently contains the fail-fast at lines 173–175 that we're replacing. Also where the executor caps (`MCPExecutorMaxTimeoutMS`, `MCPExecutorMaxAPICalls`) are read.
- `internal/mcp/execute.go` — `handleMCPExecute` is the per-call entrypoint; this is the natural place to apply the per-IP rate limit, after the MCP SDK has already dispatched on tool name.
- `cmd/mcptool/main.go` — wires the executor service with the caps; needs to apply demo overrides.
- `internal/server/server.go` — `DemoConfig` (server-side mirror) needs a new field `MCPExecutePerHour` so the bootstrap handler can surface it. `cmd/bot/main_server.go` translates between the two.
- `internal/server/settings_handlers.go` — `handleBootstrap` already emits `demo.limits.*`; adds `mcp_execute_per_hour`.
- `docs/demo-mode.md` — runbook update.

Related patterns found:

- `demoRateLimitMiddleware` (`internal/server/server.go`) — existing per-IP rate-limit middleware for HTTP routes; emits `{"error":"demo_rate_limit","limit":"<label>","retry_after_seconds":N}` + `Retry-After` header. The MCP server isn't an `http.Handler` chain the same way (MCP SDK owns the response), so the rate limit goes inside `handleMCPExecute` instead — but the JSON body shape mirrors the existing one so consumers see one consistent format.
- `clientIP(r, trustProxy)` helper (`internal/server/server.go`) — already handles X-Forwarded-For when `AUTH_TRUST_PROXY=1`. MCP needs the same. Duplicate the helper into `internal/mcp/` (the MCP server is a separate binary; no cross-import).
- `parseBoolEnv` is duplicated in `internal/mcp/mcp.go` already — adding more duplicated helpers follows that pattern.

Dependencies identified:

- `internal/mcp/executor/service.go` — receives the cap values via the executor `Config` struct; already supports lowering them. No change to executor internals needed; just pass smaller numbers from `cmd/mcptool/main.go` when demo is on.
- `time.Hour` window matches the food/photo limiters; reuses the operator's mental model.

## Development Approach

- **Testing approach**: Regular (project pattern: extend the owning feature's existing `_test.go` instead of TDD per-task).
- Complete each task fully before moving to the next.
- Make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task.
- **CRITICAL: all tests must pass before starting next task** — no exceptions.
- **CRITICAL: update this plan file when scope changes during implementation.**
- Run `go build ./...` AND `go build -tags mobile ./...` after each task that touches server code, since the mobile build excludes MCP wiring.
- Maintain backward compatibility: in non-demo mode, behavior is unchanged.

## Testing Strategy

- **Unit tests**: required for every task.
- **Go tests**: extend `internal/config/config_test.go`, `internal/mcp/mcp_demo_test.go`, `internal/server/settings_handlers_test.go`. New: `internal/mcp/execute_demo_test.go` for the per-IP rate-limit path.
- **Frontend tests**: not needed for this plan (no UI changes; the bootstrap `demo.limits.mcp_execute_per_hour` field is informational, surfaced through the existing banner format string only if we choose to message it — see Task 5).
- **No e2e tests**: the project doesn't run E2E for MCP; manual verification in Post-Completion covers the agent path.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): code in `internal/config`, `internal/mcp`, `internal/server`, `cmd/mcptool`, `cmd/bot`, and `docs/demo-mode.md`.
- **Post-Completion** (no checkboxes): deploy stack update (set `MCP_EXECUTOR_BRIDGE_URL=http://medtracker-:8080/internal/mcp/bridge` in the demo Portainer env), manual verification that the voice agent gets a tool list and that the rate limit kicks in after 5 calls.

## Implementation Steps

### Task 1: Extend DemoConfig with MCP execute knobs

- [x] add `MCPExecuteCallsPerHour int`, `MCPExecutorMaxAPICalls int`, `MCPExecutorMaxTimeoutMS int` to `DemoConfig` in `internal/config/config.go`
- [x] in `LoadFromEnv`, read `DEMO_MCP_EXECUTE_PER_HOUR` (default 5), `DEMO_MCP_EXECUTOR_MAX_API_CALLS` (default 10), `DEMO_MCP_EXECUTOR_MAX_TIMEOUT_MS` (default 10000); follow the existing malformed-value-falls-back-to-default pattern
- [x] extend the table-driven test in `internal/config/config_test.go` with new cases covering: unset → defaults, set → custom, malformed → defaults, demo-off → ignored
- [x] run `go test ./internal/config/...` — must pass before next task

### Task 2: Remove the demo-mode fail-fast and apply caps in MCP

- [x] in `internal/mcp/mcp.go`, replace the `MCP_EXECUTOR_BRIDGE_URL must not be set when DEMO_MODE=1` error with a `slog.Warn` line and a comment pointing at the rate limiter as the replacement defence
- [x] thread the three new caps (`DemoExecuteCallsPerHour`, `DemoExecutorMaxAPICalls`, `DemoExecutorMaxTimeoutMS`) into the MCP `Config` struct so the executor wiring can read them
- [x] in `LoadConfigFromEnv`, populate the new caps from env vars (same names as Task 1), defaults wired identically
- [x] when `cfg.DemoMode` is true, override the executor's `MaxAPICalls` and `MaxTimeoutMS` with the demo values before constructing the executor service in `cmd/mcptool/main.go`
- [x] extend `internal/mcp/mcp_demo_test.go` with: (a) demo + bridge URL set → no error, warning logged, (b) caps applied when demo=on, (c) caps untouched when demo=off
- [x] run `go test ./internal/mcp/...` and `go build ./... && go build -tags mobile ./...` — all must pass before next task

### Task 3: Per-IP rate limit inside handleMCPExecute

- [x] in `internal/mcp/`, add a `clientIP(r *http.Request, trustProxy bool) string` helper mirroring `internal/server/server.go`'s (small dup is fine; we already duplicate `parseBoolEnv` here)
- [x] add an HTTP middleware on `/mcp` in `internal/mcp/mcp.go`'s `buildPublicMux` that, when `cfg.DemoMode` is true, injects the client IP into the request context using a typed key (e.g. `mcpClientIPKey`)
- [x] add a `*rateLimiter` field to the MCP `Server` struct that's constructed only when `cfg.DemoMode` is true, using `cfg.DemoExecuteCallsPerHour` and `time.Hour`. Mirror the constructor pattern from `internal/server/server.go`'s `newRateLimiter`
- [x] at the top of `handleMCPExecute` (`internal/mcp/execute.go`), if `s.demoLimiter != nil`, read the client IP from ctx and call `Allow(ip)`. On reject, return an `mcp.ToolResponse` whose JSON content is `{"error":"demo_rate_limit","limit":"mcp_execute","retry_after_seconds":3600}` so callers see the same shape as the other demo-rate-limited routes
- [x] add `internal/mcp/execute_demo_test.go` covering: (a) demo off → no limit, (b) demo on, 5 calls succeed, 6th returns demo_rate_limit body, (c) per-IP keying (IP A's bucket doesn't affect IP B), (d) ctx without IP → caller treated as a single shared bucket (defensive)
- [x] run `go test ./internal/mcp/...` — must pass before next task

### Task 4: Surface mcp_execute_per_hour in /api/bootstrap

- [x] add `MCPExecutePerHour int` to `server.DemoConfig` in `internal/server/server.go`
- [x] in `cmd/bot/main_server.go`, populate it from `cfg.Demo.MCPExecuteCallsPerHour` when calling `SetDemoConfig`
- [x] in `handleBootstrap` (`internal/server/settings_handlers.go`), add `"mcp_execute_per_hour": s.demoCfg.MCPExecutePerHour` to the `demo.limits` map
- [x] extend the existing demo-on / demo-off cases in `internal/server/settings_handlers_test.go` to assert the new key
- [x] run `go test ./internal/server/...` — must pass before next task

### Task 5: Verify acceptance criteria

- [x] verify `go build ./... && go build -tags mobile ./...` both succeed
- [x] verify `go vet ./...` is clean
- [x] run the full Go suite (`go test ./...`) — must pass
- [x] verify the demo runbook in `docs/demo-mode.md` is consistent with the new env vars and that the env-var table lists the three new `DEMO_MCP_*` knobs and the new bootstrap field, and removes the "MCP refuses to start when DEMO_MODE=1 and MCP_EXECUTOR_BRIDGE_URL is set" sentence (inspected — Task 6 will apply the edits)

### Task 6: Update docs/demo-mode.md

- [x] add `DEMO_MCP_EXECUTE_PER_HOUR`, `DEMO_MCP_EXECUTOR_MAX_API_CALLS`, `DEMO_MCP_EXECUTOR_MAX_TIMEOUT_MS` rows to the environment-variable table with their defaults and meaning
- [x] update the "Mutual exclusivity" section: the MCP no longer refuses to start with the bridge URL in demo mode; instead it warns + rate-limits
- [x] update the "Bootstrap payload" example to include `mcp_execute_per_hour`
- [x] update the "Rate-limit response shape" section: the `limit` field now includes `mcp_execute` as a possible value

*Note: ralphex automatically moves completed plans to `docs/plans/completed/`*

## Technical Details

### New env vars

| Var | Default | Meaning |
|-----|---------|---------|
| `DEMO_MCP_EXECUTE_PER_HOUR` | `5` | Per-IP limit on `mcp_execute` tool calls. Returns 429 with `demo_rate_limit` body when exceeded. |
| `DEMO_MCP_EXECUTOR_MAX_API_CALLS` | `10` | Per-script cap on the executor's `medtracker.api.call(...)` count when demo is on. Replaces the production default of 100. |
| `DEMO_MCP_EXECUTOR_MAX_TIMEOUT_MS` | `10000` | Per-script timeout in ms when demo is on. Replaces the production default of 30000. |

### 429 response shape (MCP tool-level)

The MCP SDK doesn't expose HTTP status codes directly to the tool handler; the rate-limit signal travels in the tool response body. Voice-agent clients pattern-match on the JSON shape, identical to the HTTP routes:

```json
{"error":"demo_rate_limit","limit":"mcp_execute","retry_after_seconds":3600}
```

### Bootstrap addition

```json
{
  "demo": {
    "enabled": true,
    "limits": {
      "agent_calls_per_day": 1,
      "agent_uploads_per_day": 20,
      "food_logs_per_hour": 1,
      "food_photos_per_hour": 1,
      "food_descriptions_per_hour": 1,
      "mcp_execute_per_hour": 5
    }
  }
}
```

### Build seam check

Demo mode remains a runtime flag, not a build tag. The mobile build (`//go:build mobile`) does not include the MCP binary and is untouched by this plan. The server build's `cmd/mcptool/main.go` is unaffected when `DEMO_MODE` is unset. No new build tags introduced.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only.*

**Demo stack env update** (in Portainer demo stack env):
- Set `MCP_EXECUTOR_BRIDGE_URL=http://medtracker-:8080/internal/mcp/bridge` (the demo container name has the trailing dash because `INSTANCE` is empty in the demo stack)
- Optional: override defaults if 5/hour is too tight or too loose: `DEMO_MCP_EXECUTE_PER_HOUR=10`

**Manual verification** after the new image deploys:
- voice agent on `demo.myhealthbot.ai` connects and answers a "what's my last weight?" question with real seeded data
- 6 rapid `mcp_execute` calls from one browser session → the 6th returns `demo_rate_limit` body (agent should surface a friendly "demo limit reached" message)
- voice agent calls do not exceed the new per-script caps (script that tries 11 `medtracker.api.call(...)` invocations is cut off after the 10th)
- `curl https://demo.myhealthbot.ai/api/bootstrap` shows `demo.limits.mcp_execute_per_hour` in the JSON
