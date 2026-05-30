# MCP explore/execute loop ergonomics — Tier 1 (collapse round-trips) + Tier 2 (self-correcting errors)

## Overview

Make agents fast and comfortable on the MCP surface by shortening the discover→execute loop and turning failures into self-repairing retries. Two groups:

**Tier 1 — collapse discover → execute:**
- **#1 Response shapes in help.** Add a `response_example` to each operation (real sample output), surfaced on drill-in. The #1 cause of a chained `mcp_execute` script failing on first run is the agent *guessing* an op's output shape; showing it lets the agent write correct chained scripts first try.
- **#2 Auto-expand small result sets.** When `query=` matches ≤3 ops, return them FULL (schema + example + response_example) instead of terse — collapses `help(query)`→`help(operation_id)`→execute into `help(query)`→execute.
- **#3 Batch operation lookup.** `mcp_help` accepts `operation_ids: [...]` so an agent that knows the 2–3 ops it will chain fetches all their schemas in one read.
- **#4 Usage protocol + catalog as MCP resource.** Always include a stable `usage_protocol` (the 3-tool decision rule + `output()`-once + params/path_params/tz reminders) and the terse catalog in no-arg `mcp_help`, AND register an `mcp://catalog` MCP resource so preloading clients start already knowing what exists (eliminates the first scan round-trip).

**Tier 2 — self-correcting errors (no help() detour on failure):**
- **#5 Did-you-mean on unknown op.** Enrich the `unknown_operation` denial with the top-N closest op IDs (via `Registry.Search`) so a wrong id becomes a corrected retry, not a help() round-trip.
- **#6 Warn-only pre-flight schema validation.** Validate caller params/body against the op's JSON Schema and attach field-level **warnings** (e.g. `body.systolic: expected integer, got string`) — the call still forwards (warn-only, never blocks), so agents get precise feedback without being stopped by loose/incomplete schemas.
- **#7 Actionable denial messages.** Make existing proxy denials state the fix verbatim (`write_blocked` → "retry with mode='write' and a one-sentence intent"), echoing a minimal usage hint.

Server-build only (MCP stripped from `mobile`). No new HTTP routes (coverage guard unaffected). No new Go dependency — `google/jsonschema-go v0.4.2` is already available (indirect via the MCP SDK).

## Context (from discovery)

Files/components involved:
- `internal/mcp/registry/registry.go` — `Operation` (id, topic, method, path, path_params, risk, ParamsSchema/BodySchema as `json.RawMessage`, ResponseSummary, Description, Example), `HelpEntry` (full, schemas decoded to `any`), `HelpEntryCompact` (terse: id/topic/method/risk/description), `MarshalForHelp`, `MarshalForHelpCompact`, `Registry.Search` (substring over id/desc/topic/response_summary), `Get`/`ByTopic`/`All`/`Topics`/`Suggestion`.
- `internal/mcp/registry/operations_{health,food,workouts,medications}.go` — **98 ops total** (health 24, meds 20, food 14, workouts 40); every op has an `Example`.
- `internal/mcp/help.go` — `HelpInput{Topic, OperationID, Query}`, `HelpResponse{Operations, CompactOperations, Count, Topics, Capabilities, PythonUsage (unused), Note, NextStep, NextTools}`, `handleMCPHelp` branching: operation_id > query > topic > full catalog; `buildCapabilities`.
- `internal/mcp/mcp.go` — `s.mcpServer = mcp.NewServer(...)` (mcp.go:294-299); `registerTools()` registers tools via `mcp.AddTool` with JSON `InputSchema` (mcp_help schema mcp.go:353-369, mcp_call 420-449); **`mcp.AddResource(s.mcpServer, &mcp.Resource{...}, handler)` is available** (SDK v1.4.1) but unused.
- `internal/mcp/proxy/proxy.go` — `Proxy.Call` validation flow (proxy.go:139-173); `CallError{Code, Message}` with codes `ErrUnknownOperation`/`ErrWriteBlocked`/`ErrMaxCallsExceeded`/`ErrTopicNotAllowed`. Note: `Call` receives params already **stringified** (`map[string]string`), so schema validation of params must happen earlier, at the raw-JSON boundary.
- `internal/mcp/call.go` — `handleMCPCall`, `CallResponse{Status, Result, Error, APICalls}` (no `Warnings` field today); has raw `CallInput{Params map[string]json.RawMessage, Body json.RawMessage}` before stringification.
- `internal/mcp/execute.go` — `ExecuteResponse{Status, Result, Error, APICalls, Stdout, Stderr, Warnings}`; `ExecuteStatus*` constants.
- `internal/mcp/executor/service.go` — loopback `handleCall` has raw `req.Params map[string]json.RawMessage` + `req.Body` **before** `paramsToStrings` (service.go ~796-813); per-run `runState`; `classifyProxyResult`/`callOutcome` (service.go:933-1049) maps proxy errors → status + message; `Execute` builds the final result via `mapEnvelope` (runner `Warnings` come from the Python envelope).

Related patterns:
- Help/registry changes mirror the just-merged PR #367 (compact marshal, query). Tests: `registry_test.go`, `help_test.go`, `proxy/proxy_test.go`, `call_test.go`, `executor/service_test.go`; handlers called directly with `context.Background()`, `nil` request; executor tests stand up an `httptest` bridge.

Dependencies/constraints identified:
- **JSON Schema validation:** use `github.com/google/jsonschema-go/jsonschema` (already in go.sum). Compile each op's `ParamsSchema`/`BodySchema` once and cache (keyed by op id) to avoid recompiling per call.
- **Param stringification boundary:** validation must run on raw JSON, so it lives at `handleMCPCall` (mcp_call) and the executor's `handleCall` *before* `paramsToStrings` (scripts) — via one shared validator. `proxy.Call` keeps its `map[string]string` signature unchanged.
- **Warn-only plumbing:** `CallResponse` needs a new `Warnings []string`; script-side warnings accumulate in `runState` (mutex-guarded) and merge into the final `ExecuteResponse.Warnings`.

Key design decisions (confirmed with user):
- **#1 response_example scope:** add the field to all 98 ops (omitempty); hand-populate only the ~40 read/list/get/overview ops that feed chains. Writes filled incrementally.
- **#4 delivery:** both — help-embedded `usage_protocol` (guaranteed reachable) AND an `mcp://catalog` MCP resource (for preloading clients).
- **#6 validation:** **warn-only, never block** — reject nothing; attach field-level warnings; lenient (check required + declared-field types, ignore unknown/extra fields).
- **Testing:** Regular (code first, then tests).

## Development Approach

- **Testing approach:** Regular (code first, then tests).
- Complete each task fully before the next; small focused changes.
- **CRITICAL: every task includes new/updated tests** (success + error cases), as separate checklist items.
- **CRITICAL: all tests pass before starting the next task.**
- Run `go test ./internal/mcp/...` after each change; `gofmt`/`go vet` clean.
- Backward compatibility: `operation_id`/topic lookups keep returning full detail; existing `mcp_execute`/`mcp_call` success paths unchanged; validation is warn-only so no previously-working call starts failing.

## Testing Strategy

- **Unit tests** every task: `registry_test.go` (response_example marshal, validator), `help_test.go` (batch lookup, auto-expand, usage_protocol, resource), `proxy/proxy_test.go` (did-you-mean, actionable messages), `call_test.go` + `executor/service_test.go` (warnings plumbing).
- **No frontend/e2e** — backend Go only.
- Schema-validation and bridge-dependent tests use table-driven cases and an `httptest` bridge (existing patterns).

## Progress Tracking

- Mark items `[x]` immediately when done. New tasks `➕`, blockers `⚠️`. Keep the plan in sync.

## What Goes Where

- **Implementation Steps** (`[ ]`): Go code + tests + in-repo docs.
- **Post-Completion** (no checkboxes): updating the external `~/.claude/skills/mcp-registry-executor` skill; manual MCP-client smoke test.

## Implementation Steps

### Task 1: Registry — `response_example` field + surface on drill-in + populate read ops

- [x] In `internal/mcp/registry/registry.go`, add `ResponseExample string \`json:"response_example,omitempty"\`` to `Operation`, and `ResponseExample string \`json:"response_example,omitempty"\`` to `HelpEntry` (NOT to `HelpEntryCompact`).
- [x] In `MarshalForHelp`, copy `op.ResponseExample` into the `HelpEntry`; leave `MarshalForHelpCompact` unchanged (terse stays terse).
- [x] Populate `ResponseExample` (a small, realistic JSON sample) for the read/chain-source ops across `operations_health.go`, `operations_food.go`, `operations_workouts.go`, `operations_medications.go` — the list/get/overview ops (~40). Leave write ops empty for now. (35 read ops populated.)
- [x] write tests in `registry_test.go`: `MarshalForHelp` includes `ResponseExample` when set; `MarshalForHelpCompact` never includes it; a guard test that every populated `ResponseExample` is valid JSON.
- [x] run `go test ./internal/mcp/registry/...` — must pass before Task 2

### Task 2: `mcp_help` — batch `operation_ids` + auto-expand small query results

- [x] In `internal/mcp/help.go`, add `OperationIDs []string \`json:"operation_ids"\`` to `HelpInput`. In `handleMCPHelp`, when `operation_ids` (and/or `operation_id`) is set, return FULL `Operations` for all found ids (precedence: ids > query > topic > catalog); note any ids not found in `Note`.
- [x] Auto-expand: when `query=` matches ≤3 ops, return them as FULL `Operations` (schemas + example + response_example) instead of `CompactOperations`; >3 stays terse. Update the query-branch `Note`/`NextStep` accordingly.
- [x] In `internal/mcp/mcp.go`, update the `mcp_help` `InputSchema` to document `operation_ids` and the auto-expand behavior.
- [x] write tests in `help_test.go`: batch `operation_ids` returns multiple full entries (+ missing-id note); `query` with ≤3 matches returns full `Operations`; `query` with >3 stays compact.
- [x] run `go test ./internal/mcp/...` — must pass before Task 3

### Task 3: `mcp_help` usage protocol + `mcp://catalog` MCP resource (#4)

- [x] Add a stable `usageProtocol` constant (the 3-tool decision rule: scan/search → drill-in → `mcp_call` for one op / `mcp_execute` for multi-step; `output()` exactly once; params are query-string + `path_params` for `{placeholders}`; timestamps in the user's tz). Surface it via `HelpResponse.PythonUsage` (rename JSON tag to `usage_protocol` or add a new field) in the no-arg/full-catalog branch. (Renamed field to `UsageProtocol`/`usage_protocol`.)
- [x] In `internal/mcp/mcp.go`, register an `mcp://catalog` resource with `mcp.AddResource(s.mcpServer, &mcp.Resource{URI:"mcp://catalog", Name:..., MimeType:"application/json", Description:...}, handler)`; the handler returns `{usage_protocol, topics, capabilities, compact_operations}` (reuse `MarshalForHelpCompact(reg.All())` + `buildCapabilities`). (SDK API is `s.mcpServer.AddResource(...)`, field `MIMEType`.)
- [x] write tests: `help_test.go` asserts the full-catalog response carries `usage_protocol`; a new test invokes the resource handler and asserts it returns the protocol + terse catalog JSON.
- [x] run `go test ./internal/mcp/...` — must pass before Task 4

### Task 4: Self-correcting denials — did-you-mean + actionable messages (#5, #7)

- [x] In `internal/mcp/proxy/proxy.go`, when `Get(operationID)` misses, enrich the `ErrUnknownOperation` `CallError.Message` with up to 3 closest ids from `p.reg.Search(operationID)` (fall back to searching the last dot-segment if the full id yields nothing): e.g. `operation "health.bp.lst" not found. Did you mean: health.bp.list, health.bp.get?`. (Added `suggestOperations` helper; full-id Search then trailing-segment fallback.)
- [x] Make the other denial messages actionable: `ErrWriteBlocked` → "...retry with mode='write' and a one-sentence intent."; `ErrTopicNotAllowed` → name the allowed topics; `ErrMaxCallsExceeded` → state the cap. (All four denials live inline in `proxy.Call`; messages reworded.)
- [x] Confirm these messages propagate unchanged through `classifyProxyResult` (`callOutcome.errMsg`) into `CallResponse.Error` / `ExecuteResponse.Error` (no mapping changes needed; add an assertion). (`classifyProxyResult` copies `ce.Code + ": " + ce.Message` verbatim; `service_test.go` asserts the did-you-mean message reaches `CallResult.Error`.)
- [x] write tests in `proxy/proxy_test.go`: unknown-op message contains suggestions; write-blocked message contains the actionable fix. Add a `service_test.go` case asserting the enriched message reaches the `callOutcome`/result.
- [x] run `go test ./internal/mcp/...` — must pass before Task 5

### Task 5: Shared warn-only schema validator (#6)

- [x] Add `func ValidateInput(op *Operation, params map[string]json.RawMessage, body json.RawMessage) []string` (new file e.g. `internal/mcp/registry/validate.go`): compile `op.ParamsSchema`/`op.BodySchema` via `github.com/google/jsonschema-go/jsonschema` (cache compiled schemas keyed by op id, compile-once); assemble the params object from the raw map; return field-level warning strings. Lenient: report missing-required and wrong-type of DECLARED fields only; do NOT enforce `additionalProperties`/unknown fields. Returns nil when schemas are absent or input is valid. (jsonschema-go parses each op's schemas into `*jsonschema.Schema` cached in a `sync.Map` keyed by op id; lenient walk over `Properties`/`Required`/`Type`/`Types`; integer satisfies number, fractional fails integer.)
- [x] write tests in `registry_test.go` (or `validate_test.go`): type-mismatch warns with `field: expected X, got Y`; missing-required warns; extra/unknown field does NOT warn; nil schema → no warnings; valid input → nil. (`validate_test.go` table-driven; also covers nil op + non-object body leniency.)
- [x] run `go test ./internal/mcp/registry/...` — must pass before Task 6

### Task 6: Wire validation warnings into `mcp_call` and `mcp_execute` (#6)

- [x] Add `Warnings []string \`json:"warnings,omitempty"\`` to `CallResponse` in `internal/mcp/call.go`; in `handleMCPCall`, call `registry.ValidateInput(op, input.Params, input.Body)` (look up the op from `s.reg`) and set `CallResponse.Warnings` (merge with any executor warnings). The call still proceeds regardless (warn-only). (Nil-guarded `s.reg` so handler stays safe when no registry is wired.)
- [x] For scripts: in the executor's `handleCall` (before `paramsToStrings`), call `ValidateInput(op, req.Params, req.Body)` and append results to a new mutex-guarded `runState.warnings`; in `Execute`, merge `runState.warnings` into the final `ExecutionResult.Warnings` (alongside the runner-envelope warnings).
- [x] write tests: `call_test.go` — a type-mismatched `mcp_call` returns `status:"ok"` (or backend result) WITH `warnings` populated (+ a no-warnings-on-valid case); `executor/service_test.go` — a script whose `api.call` passes a bad body surfaces the warning in the final `Execute` result `Warnings`.
- [x] run `go test ./internal/mcp/...` — must pass before Task 7

### Task 7: Verify acceptance criteria

- [ ] Verify Tier 1: `response_example` present on read ops via drill-in and absent from terse catalog; `operation_ids` batch + ≤3-query auto-expand return full entries; no-arg `mcp_help` carries `usage_protocol`; `mcp://catalog` resource returns the protocol + terse catalog.
- [ ] Verify Tier 2: unknown-op error suggests close ids; write-blocked error states the fix; a bad-typed param/body yields a warning while the call still proceeds (warn-only).
- [ ] `go build ./...` and `go build -tags mobile ./...` both pass (MCP stripped from mobile — guards cross-package breakage).
- [ ] run full `go test ./...` — all green; `gofmt -l` clean on touched files; `go vet ./internal/mcp/...` clean.
- [ ] Confirm no new HTTP route added — `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` still passes.

### Task 8: Documentation

- [ ] Update `docs/mcp-python-executor.md` and `docs/mcp-deployment.md`: document `response_example`, `operation_ids` batch lookup, query auto-expand, the `usage_protocol` + `mcp://catalog` resource, did-you-mean errors, and warn-only validation warnings.
- [ ] Update `CLAUDE.md`'s MCP section if the discovery/usage surface description needs it.
- [ ] run `go test ./internal/mcp/...` — must pass

## Technical Details

- **Warn-only, never block:** `ValidateInput` returns warnings only; no path returns an error that aborts a call. This is why `CallResponse` grows a `Warnings` field and scripts accumulate warnings in `runState` — there is no new denial status.
- **Validation placement vs stringification:** params reach `proxy.Call` as `map[string]string`, so validating there would false-fail typed schemas (`"days":"7"` vs `{type:integer}`). Validation therefore runs at the two raw-JSON boundaries (`handleMCPCall`, executor `handleCall`) through one shared `registry.ValidateInput`; `proxy.Call`'s signature is untouched.
- **Schema compilation caching:** compile each op's schemas once (lazily, keyed by op id) inside the validator module; the 98 ops' schemas are static after registry build.
- **did-you-mean source:** reuse `Registry.Search`; for a typo'd full id, fall back to searching the trailing segment so `health.bp.lst` still surfaces `health.bp.list`.
- **Auto-expand threshold:** K=3 (small enough to keep token cost bounded, large enough to cover most focused queries).
- **Resource vs help redundancy is intentional:** help-embedded `usage_protocol` guarantees reach for clients that only call tools (e.g. SSE clients); the `mcp://catalog` resource is the zero-round-trip bonus for clients that preload resources.

## Post-Completion

*Items requiring manual intervention or external systems — informational only.*

**External system updates:**
- Fold these patterns into the external skill at `~/.claude/skills/mcp-registry-executor/` (the planned `references/tradeoffs.md`): response-shapes-in-help, auto-expand, usage-protocol-as-resource, did-you-mean, warn-only validation.

**Manual verification:**
- Smoke-test against a real MCP client: confirm `mcp://catalog` is visible to the client (Claude config) and ignored gracefully by an SSE client (ElevenLabs); confirm a typo'd op id returns a did-you-mean; confirm a bad-typed body returns a warning but still writes.
- Measure the loop (optional, follow-up): log help→execute round-trips and first-try execute success rate before/after to confirm the loop actually shortened.
