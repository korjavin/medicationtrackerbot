# Add `mcp_call` single-operation tool + scale `mcp_help` catalog

## Overview

Two improvements to the MCP server's two-tool surface (`mcp_help` + `mcp_execute`):

- **#2 — `mcp_call` (single-operation tool):** Today every MCP action requires authoring a Python script for `mcp_execute`, even a one-shot read like "list my BP." That taxes the common 80% case with extra tokens, a sandbox spawn, and the `output()`-exactly-once footgun. Add a third tool, `mcp_call`, that runs **one** registry operation directly in Go — no Python subprocess — while reusing the *exact* same policy enforcement scripts get (mode/risk blocking, topic clamps, feature gates, path substitution, the bridge). Result: `mcp_help` (discover) → `mcp_call` (one-shot) → `mcp_execute` (composite).

- **#6 — scale `mcp_help`:** The catalog currently returns full `HelpEntry` records (decoded param/body schemas + a patched example) for *every* operation in catalog and topic mode. As the registry grows this is token-heavy, and there's no keyword search — `topic`/`operation_id` are the only axes. Make the **full catalog terse** (id, topic, method, risk, one-line description only), keep **full detail on drill-in** (topic filter + `operation_id` lookup unchanged), and add a **`query` keyword search** that matches across id, description, topic, and response_summary and returns terse matches.

Both changes are server-build only (the MCP server is stripped from the `mobile` build) and add no new HTTP routes, so the MCP HTTP-coverage guard is unaffected.

## Context (from discovery)

Files/components involved:
- `internal/mcp/help.go` — `handleMCPHelp`, `HelpInput`, `HelpResponse`, `TopicCapability`, `buildCapabilities`.
- `internal/mcp/registry/registry.go` — `Operation`, `Registry` (`Get`/`ByTopic`/`All`/`Topics`/`Suggestion`), `HelpEntry`, `MarshalForHelp`. No `Search` / compact marshal exists yet.
- `internal/mcp/execute.go` — `ExecutionService` interface (`Execute` only), `ExecutionRequest`/`ExecutionResult`, `ExecuteStatus*` constants, `handleMCPExecute`, `SetExecutor`, demo rate-limit handling, `truncateIntentForAudit`.
- `internal/mcp/executor/service.go` — `Service` implements `mcp.ExecutionService`; per-run it builds a **fresh** `proxy.NewWithHTTPClient(...)` + `SetMaxQueryDays` + `RunConfig` (service.go:471-477). The proxy-result→status/outcome classification is **inline in `handleCall`** (service.go:813-893). `paramsToStrings`/`paramToString` convert JSON params to the bridge's string form. `fanOutAudit` audits writes (and reads when `AuditAllRuns`).
- `internal/mcp/proxy/proxy.go` — `Proxy.Call(ctx, RunConfig{Mode,MaxAPICalls,TopicAllowlist}, opID, params, pathParams, body) (*CallResult, error)`; returns `*CallError` (registry/policy rejection) or transport `error`; `New`/`NewWithHTTPClient`, `SetMaxQueryDays`, `CallCount`.
- `internal/mcp/mcp.go` — `registerTools()` registers tools via `mcp.AddTool(s.mcpServer, &mcp.Tool{Name, Description, InputSchema}, s.handle*)` (mcp.go:347-409); registry wired at mcp.go:304-306.
- `internal/server/mcp_bridge.go` — `handleMCPBridge`: HMAC verify → registry resolve → feature gate (`featureKeyForOperation`) → `SubstitutePath` → `internalMux.ServeHTTP` → `BridgeResponse` envelope (always HTTP 200; carries `Status`, `Body`, `Truncated`, `PolicyDenial`).

Related patterns found:
- Handler signature: `func (s *Server) handleX(ctx, *sdkmcp.CallToolRequest, Input) (*sdkmcp.CallToolResult, Resp, error)`.
- Stable status taxonomy already defined as `ExecuteStatus*` in execute.go — `mcp_call` reuses these verbatim.
- Tests construct `testServerWithRegistry(t)` (registers `registry.DefaultOperations()`), call handlers directly with `context.Background()`, `nil` request. Executor tests inject a `Spawner`/`fakeExecutionService` and can stand up an `httptest` server as the bridge.

Dependencies identified:
- `ExecutionService` is implemented by `executor.Service` and by test fakes (`fakeExecutionService` in `execute_test.go`, and any in `execute_demo_test.go` / `mcp_demo_test.go`). Adding a method to the interface **requires updating all of them**.
- `executor` imports `mcp`, so `CallRequest`/`CallResult` types passed to `Call` must live in the `mcp` package (mirroring `ExecutionRequest`/`ExecutionResult`).

Key design decisions (confirmed with user):
- **`mcp_call` wiring:** Extend the `ExecutionService` interface with a `Call(...)` method that delegates to the executor's per-call proxy (reuses bridge URL + HMAC secret + MaxQueryDays already configured on the executor). Each `Call` builds a **fresh** proxy with `RunConfig{MaxAPICalls: 1}` so counters never bleed across invocations.
- **`mcp_help` detail:** Terse catalog, full on drill-in (topic + operation_id stay full).
- **`query` search scope:** id + description + topic + response_summary, case-insensitive substring.
- **Testing:** Regular (code first, then tests).

## Development Approach

- **Testing approach:** Regular (code first, then tests).
- Complete each task fully before moving to the next.
- Make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task (success + error scenarios), listed as separate checklist items.
- **CRITICAL: all tests must pass before starting the next task.**
- Run `go test ./internal/mcp/...` after each change; `gofmt`/`go vet` clean.
- Maintain backward compatibility: `operation_id` and topic lookups keep returning full detail; existing `mcp_execute` behavior is untouched.

## Testing Strategy

- **Unit tests:** required every task — registry (`registry_test.go`), help (`help_test.go`), executor (`executor/service_test.go`), new `mcp_call` handler (`call_test.go`).
- **No frontend/e2e:** these are backend-only Go changes; no UI surface.
- Bridge-dependent executor tests stand up an `httptest.Server` as the bridge (follow `proxy/proxy_test.go` / `executor/service_test.go` patterns).

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix; blockers with ⚠️ prefix.
- Keep this plan in sync with actual work.

## What Goes Where

- **Implementation Steps** (`[ ]`): Go code + tests + in-repo docs.
- **Post-Completion** (no checkboxes): updating the external `~/.claude/skills/mcp-registry-executor` skill, manual MCP-client smoke test.

## Implementation Steps

### Task 1: Registry — compact marshal + keyword search

- [x] In `internal/mcp/registry/registry.go`, add a `HelpEntryCompact` struct with only `ID`, `Topic`, `Method`, `Risk`, `Description` (all with stable JSON tags) — the terse catalog entry.
- [x] Add `func MarshalForHelpCompact(ops []*Operation) []HelpEntryCompact` returning one compact entry per op (no schemas, no example, no path).
- [x] Add `func (r *Registry) Search(query string) []*Operation`: case-insensitive substring match against `ID`, `Description`, `Topic`, and `ResponseSummary`; return matches sorted by `ID` (reuse the same ordering as `All()`); empty/whitespace query returns nil.
- [x] write tests in `registry_test.go` for `MarshalForHelpCompact` (asserts only the 5 fields are populated; schema/example absent)
- [x] write tests in `registry_test.go` for `Search` (match by id, by description substring e.g. "blood pressure", by response_summary, case-insensitivity, no-match → empty, empty query → nil)
- [x] run `go test ./internal/mcp/registry/...` — must pass before Task 2

### Task 2: `mcp_help` — terse catalog, full drill-in, `query` axis

- [x] In `internal/mcp/help.go`, add `Query string \`json:"query"\`` to `HelpInput`, and `CompactOperations []registry.HelpEntryCompact \`json:"compact_operations,omitempty"\`` to `HelpResponse`.
- [x] Update `handleMCPHelp` branching: `operation_id` lookup → full single entry (unchanged); non-empty `query` → `reg.Search(query)` rendered via `MarshalForHelpCompact` into `CompactOperations` (with `Count`, a query-specific `Note`/`NextStep`, `NextTools`); empty topic+query (full catalog) → `MarshalForHelpCompact(reg.All())` into `CompactOperations` + `Topics` + `Capabilities` (no full `Operations`); topic filter → full `Operations` via `MarshalForHelp` (unchanged behavior).
- [x] Update `Note`/`NextStep` copy: catalog note tells the agent to drill in with `topic=` or `operation_id=` for schemas+examples, or use `query=` to search; topic/op notes mention `mcp_call` for one-shot and `mcp_execute` for composite.
- [x] In `internal/mcp/mcp.go`, update the `mcp_help` `InputSchema` to document the new `query` property, and update the tool `Description` to mention terse catalog + `query` + the existence of `mcp_call`.
- [x] write tests in `help_test.go`: full catalog returns `CompactOperations` (assert no schemas/example present) + `Capabilities`; topic filter returns full `Operations` (schemas + example present); `operation_id` returns full single entry; `query` returns compact matches; `query` no-match returns empty with a helpful `NextStep`.
- [x] run `go test ./internal/mcp/...` — must pass before Task 3

### Task 3: Executor — extract shared proxy-result classification

- [x] In `internal/mcp/executor/service.go`, extract the inline classification in `handleCall` (service.go:813-893) into a pure helper, e.g. `func classifyProxyResult(result *proxy.CallResult, callErr error) callOutcome` where `callOutcome` carries `{status string (mcp.ExecuteStatus*), httpStatus int, body []byte, outcomeHeader string, errMsg string, denialKind string}` covering: proxy `*CallError` → `proxy_denied`; `result.Response == nil` → `backend_transport_error`; `PolicyDenial != ""` → `proxy_denied`; `Truncated` → `backend_transport_error`; upstream status ≥ 400 → `backend_application_error`; else `ok` + body.
- [x] Refactor `handleCall` to call `classifyProxyResult` and translate the `callOutcome` into the existing HTTP response + `X-MCP-Outcome` header + per-run outcome counters — **behavior must be byte-for-byte unchanged**.
- [x] write tests in `executor/service_test.go` for `classifyProxyResult` covering every branch (proxy denial, transport nil-response, policy denial, truncated, backend 4xx/5xx, ok).
- [x] run `go test ./internal/mcp/executor/...` — must pass (existing `handleCall` tests still green) before Task 4

### Task 4: Executor — `Call()` method + `ExecutionService.Call`

- [x] In `internal/mcp/execute.go`, define `CallRequest{OperationID string; Mode proxy.Mode; Intent string; Params, PathParams map[string]json.RawMessage; Body json.RawMessage}` and `CallResult{Status string; Result json.RawMessage; Error string; APICalls int}`.
- [x] Add `Call(ctx context.Context, req CallRequest) (*CallResult, error)` to the `ExecutionService` interface.
- [x] Implement `func (s *Service) Call(ctx, req mcp.CallRequest) (*mcp.CallResult, error)` in `executor/service.go`: started/stopped guards; build a fresh proxy (`proxy.NewWithHTTPClient(s.opts.Registry, s.opts.BridgeURL, s.opts.HMACSecret, s.opts.HTTPClient)` + `SetMaxQueryDays`); `RunConfig{Mode: req.Mode, MaxAPICalls: 1, TopicAllowlist: nil}`; stringify params via `paramsToStrings`; call `p.Call(...)`; map via `classifyProxyResult`; set `APICalls` from `p.CallCount()`; `fanOutAudit` a `RunSummary` (so writes are audited identically to `mcp_execute`); return `CallResult`.
- [x] Update every other `ExecutionService` implementer/fake to satisfy the new method: `fakeExecutionService` in `execute_test.go` (add a `callFn` field + `Call`), and any fakes in `execute_demo_test.go` / `mcp_demo_test.go`. Keep the `var _ mcp.ExecutionService = (*Service)(nil)` assertion compiling.
- [x] write tests in `executor/service_test.go` for `Service.Call` against an `httptest` bridge: read OK (returns body, `APICalls==1`), write OK is audited (assert `AuditHook` received a `ModeWrite` summary), unknown op → `proxy_denied`, feature-gate `PolicyDenial` → `proxy_denied`, bridge transport failure → `backend_transport_error`, upstream 4xx → `backend_application_error`.
- [x] run `go test ./internal/mcp/...` — must pass before Task 5

### Task 5: `mcp_call` tool — handler + registration

- [x] Create `internal/mcp/call.go` with `CallInput{OperationID string \`json:"operation_id"\`; Params map[string]json.RawMessage \`json:"params"\`; PathParams map[string]json.RawMessage \`json:"path_params"\`; Body json.RawMessage \`json:"body"\`; Mode string \`json:"mode"\`; Intent string \`json:"intent"\`}` and `CallResponse{Status string; Result any; Error string; APICalls int}`.
- [x] Implement `handleMCPCall`: demo per-IP rate limit (reuse `s.demoLimiter` + `clientIPFromExtra`, mirroring `handleMCPExecute`); require non-empty `operation_id`; default `mode` to `read_only` and validate it's `read_only`/`write`; require non-empty `intent` when `mode==write`; error if `s.executor == nil`; log a structured line (`operation_id`, `mode`, `has_intent`, `truncateIntentForAudit`); build `mcp.CallRequest`; call `s.executor.Call(ctx, req)`; unmarshal `Result` JSON into `any`; return `CallResponse`.
- [x] In `internal/mcp/mcp.go` `registerTools()`, register `mcp_call` via `mcp.AddTool(...)` with an `InputSchema` (required `operation_id`; optional `params`/`path_params`/`body`/`mode`/`intent`) and a `Description` steering the agent: "Run ONE backend operation directly — use this for single reads/writes; use mcp_execute only for multi-step scripts. Discover operations via mcp_help. Writes need mode='write' + intent."
- [x] Update `mcp_help` steering (`NextTools`) and the `mcp_execute` tool `Description` to reference `mcp_call` as the one-shot path.
- [x] Update any test asserting the registered tool set (e.g. `tools_test.go` / `mcp_test.go`) to include `mcp_call`. (No tool-set assertion test exists; updated the `help_test.go` `NextTools` assertion to expect `mcp_call` first.)
- [x] write tests in new `internal/mcp/call_test.go` (use a `fakeExecutionService` with a `callFn`): read OK, write + intent OK, write missing intent → error, empty `operation_id` → error, `executor == nil` → error, proxy-denied status passthrough, demo rate-limit path returns `demo_rate_limit`.
- [x] run `go test ./internal/mcp/...` — must pass before Task 6

### Task 6: Documentation

- [ ] Update `docs/mcp-python-executor.md` (and/or `docs/mcp-deployment.md`) to document `mcp_call` (single-op, no script) and the new `mcp_help` terse-catalog + `query` behavior; show the discover → `mcp_call` / `mcp_execute` decision.
- [ ] Update the "Adding an MCP tool" section of `CLAUDE.md` only if the tool-count/surface description needs it (the two-tool framing becomes three).
- [ ] run `go test ./internal/mcp/...` — must pass before Task 7

### Task 7: Verify acceptance criteria

- [ ] Verify Overview goals: `mcp_call` runs a single op end-to-end through proxy→bridge with identical policy; full catalog is terse; topic/operation_id still full; `query` searches and returns compact matches.
- [ ] `go build ./...` and `go build -tags mobile ./...` (confirm mobile build still compiles — MCP is stripped, so this guards against accidental cross-package breakage).
- [ ] run full `go test ./...` — all green.
- [ ] `gofmt -l` clean on touched files; `go vet ./internal/mcp/...` clean.
- [ ] Confirm no new HTTP route was added (MCP HTTP-coverage guard `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` unaffected) and it still passes.

## Technical Details

- **Status taxonomy reuse:** `mcp_call` returns the same `ExecuteStatus*` strings (`ok`, `proxy_denied`, `backend_application_error`, `backend_transport_error`, plus `demo_rate_limit`). It can never return `timeout`/`sandbox_startup_failure`/`script_error` (no script/subprocess). This keeps one mental model across both execution tools.
- **Per-call proxy isolation:** A fresh `proxy.Proxy` per `Call` with `MaxAPICalls: 1` mirrors the per-run isolation `Execute` already relies on (service.go:476) and sidesteps the shared `callCount` atomic.
- **Param stringification:** `CallInput` accepts arbitrary JSON scalars in `params`/`path_params`; the executor's existing `paramsToStrings`/`paramToString` convert them to the bridge's string form — same path scripts use, so number/bool params behave identically.
- **Classification single-source:** Extracting `classifyProxyResult` (Task 3) means `handleCall` (script path) and `Service.Call` (mcp_call path) cannot diverge in how they map proxy/bridge outcomes to statuses.
- **Help envelope:** `CompactOperations` is a separate `omitempty` field rather than overloading `Operations`, so the JSON shape unambiguously signals "this is the terse menu, drill in for detail" and full-mode output is untouched.

## Post-Completion

*Items requiring manual intervention or external systems — informational only.*

**External system updates:**
- Update the portable skill at `~/.claude/skills/mcp-registry-executor/` to fold in the `mcp_call` third-tool variant and the terse-catalog/`query` guidance (this lives outside the repo; the earlier `references/tradeoffs.md` discussion is the natural home).

**Manual verification:**
- Smoke-test against a real MCP client (e.g. ElevenLabs / Claude config): `mcp_help` (catalog terse), `mcp_help(query="blood pressure")`, `mcp_call` a read op, `mcp_call` a write op with intent, confirm a write without intent is rejected.
