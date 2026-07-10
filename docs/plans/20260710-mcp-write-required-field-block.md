# MCP write ops block on missing required fields (bd med-tc1.5)

## Overview
Today `registry.ValidateInput` (Go) and `validateInput` in `web/cloud/js/mcp-responder.js`
are **warn-only**. For a WRITE op, a required field that is simply *absent* produces only a
warning and the call still proceeds into the domain layer, where the record becomes whatever
the domain tolerates — a silent data-loss bug. med-d5t.11 was exactly this: `food.log.create`
with no `eaten_at` produced a record invisible to every windowed read, and the agent reported
success. The #557 domain guard closed that *one* hole; this closes the general shape.

**Settled decision (implement, do not re-open):** when an op is a WRITE
(`Risk == RiskWrite` in Go / `risk === 'write'` in the JS catalog), a **missing required
field** must BLOCK the call with a clear agent-facing error instead of a warning. Type
mismatches stay warn-only (coercion is defensible). Read ops stay entirely warn-only.

## Context (from discovery)
- Files/components involved:
  - `internal/mcp/registry/validate.go` — `ValidateInput` + `checkObject`. `checkObject`
    already emits missing-required warnings as `"<prefix>.<field>: required field missing"`
    separately from type-mismatch warnings.
  - `internal/mcp/registry/registry.go` — `Operation.Risk` (`RiskRead`/`RiskWrite`).
  - `internal/mcp/call.go:118-121` — `mcp_call`: appends `ValidateInput` warnings, always proceeds.
  - `internal/mcp/executor/service.go:899-903` — `mcp_execute` per-`api.call` proxy handler:
    appends `ValidateInput` warnings to `rs.warnings`, always forwards via `rs.p.Call`.
    (The aggregation at 598-615 only merges warnings into the final result — the *block* must
    happen at 899, before `rs.p.Call`.)
  - `web/cloud/js/mcp-responder.js:526-539` — cloud responder write path (`mode: write`):
    `validateInput` warnings attached to `resp.warnings`, always dispatches.
  - JS catalog entries in `web/cloud/js/mcp-catalog.generated.js` carry `risk`.
- Related patterns found: `op.Risk == RiskWrite` is already the write signal used elsewhere
  in `registry.go` (e.g. line 330). The cloud responder already throws `MCPError(-32602, ...)`
  for the "write op issued without mode: write" case just above line 528 — reuse that error path.
- Dependencies identified: `internal/mcp/call_test.go`, `internal/mcp/executor/*_test.go`,
  `web/cloud/js/tests/mcp-responder.test.js` assert the current warn-only behavior; they must
  stay green for reads/coercion and gain cases for the new write-block.

## Development Approach
- **Testing approach**: NO unit tests. Extend the existing integration suites only, at the
  real boundaries (the two Go tool entrypoints and the cloud responder).
- Complete each task fully before the next; keep existing tests green throughout.
- Keep the success-path response SHAPE stable (`CallResponse` in call.go:33-39; the cloud
  `{status:'ok', result, api_calls}` object). The block is a distinct ERROR response, not a
  new field on the success response.
- Maintain backward compatibility for read ops and type-coercion warnings.

## Testing Strategy
- **Unit tests**: none.
- **Integration tests**: extend `internal/mcp/call_test.go`, the executor's existing test
  file, and `web/cloud/js/tests/mcp-responder.test.js`. Each guards a real boundary (the
  agent-facing contract of a tool call), so each earns its cases.
- **E2E tests**: none.

## Progress Tracking
- Mark completed items `[x]` immediately.
- Prefix newly discovered tasks and blockers as noted below.
- Update this file if scope shifts.

## Implementation Steps

### Task 1: Registry helper that reports missing required fields
- [x] In `internal/mcp/registry/validate.go`, add an exported helper
      `RequiredMissing(op *Operation, params map[string]json.RawMessage, body json.RawMessage) []string`
      that returns the labels of required-but-absent fields (e.g. `"body.eaten_at"`,
      `"params.id"`), reusing `compiledFor`/`schema.Required` — the same source `checkObject`
      already walks for its missing-required warnings.
- [x] Do NOT change `ValidateInput`'s contract: it stays warn-only and still reports
      missing-required among its warnings (reads rely on this).
- [x] Return `nil` when the op is nil, has no schemas, or nothing is missing.

### Task 2: mcp_call blocks write ops with a missing required field
- [x] In `internal/mcp/call.go`, after resolving `op` and before dispatch, when
      `op.Risk == registry.RiskWrite`, call `registry.RequiredMissing`; if it returns any
      fields, return the `CallResponse` error path (do NOT dispatch) with a message naming the
      op and the fields, e.g. `write op "food.log.create" rejected: required field missing: body.eaten_at`.
- [x] Leave the warn-only `ValidateInput` path unchanged for the non-blocked cases (reads,
      type mismatches, valid writes) so their `warnings` still surface.
- [x] Extend `internal/mcp/call_test.go`: (a) a write op missing a required field returns the
      error and does NOT dispatch; (b) a read op missing a required field still warns + succeeds;
      (c) a valid write still succeeds with no error.

### Task 3: mcp_execute blocks write ops with a missing required field
- [x] In `internal/mcp/executor/service.go` around line 899 (the per-`api.call` proxy
      handler), when the resolved op is `RiskWrite` and `registry.RequiredMissing` is non-empty,
      fail that api.call (return an error to the script — an HTTP 4xx / error envelope the
      runner surfaces as a call failure) instead of appending a warning and forwarding via
      `rs.p.Call`. Use the same message shape as Task 2.
- [x] Keep the warn-only accumulation for reads/coercion and valid writes intact.
- [x] Extend the executor's existing test file: a script issuing a write op with a missing
      required field sees that api.call fail (not a silent success + warning); a read still warns.

### Task 4: Cloud responder blocks write ops with a missing required field
- [x] In `web/cloud/js/mcp-responder.js`, in the `mode: write` branch (near line 528), after
      `validateInput`, when the op is a write (`op.risk === 'write'`), detect missing required
      fields (port Task 1's logic, or reuse the `"... required field missing"` warnings filtered
      to required-missing) and `throw new MCPError(-32602, ...)` naming the op and fields BEFORE
      `dispatch`. Reuse the existing `-32602` write-path error style just above.
- [x] Leave the read/passthrough path warn-only; keep the `{status:'ok', result, api_calls}`
      success shape unchanged for valid writes.
- [x] Extend `web/cloud/js/tests/mcp-responder.test.js`: (a) a `mode:write` op missing a
      required body field throws `MCPError` with the field named and does NOT dispatch; (b) a
      read passthrough still only warns; (c) a valid write still dispatches with the ok shape.

### Task 5: Verify acceptance criteria
- [ ] `go build ./...` and `go build -tags mobile ./...` both clean.
- [ ] `go test ./internal/mcp/...` passes.
- [ ] `pnpm test` passes (at minimum the mcp-responder suite).
- [ ] `golangci-lint run` (or the project's lint target) clean for touched files.
- [ ] Confirm reads and type-coercion remain warn-only; only missing-required-on-write blocks.

## Technical Details
- Write signal: `op.Risk == registry.RiskWrite` (Go) / `op.risk === 'write'` (JS catalog).
- Missing-required detection reuses the schema's `Required` list already compiled by
  `compiledFor`; no new schema parsing path.
- Error message format (both surfaces):
  `write op "<op id>" rejected: required field missing: <label>[, <label>...]`
  where labels are `body.<field>` / `params.<field>`.
- The block is an error RESPONSE, orthogonal to the `warnings` field, which continues to carry
  type-coercion notes on the calls that still proceed.

## Post-Completion
**Out of scope (do NOT build):** the issue's "consider a named `log_food` tool" aside. The
required-field block satisfies the acceptance criteria; a new named MCP tool is a separate
enhancement.

**Manual verification (optional):** drive a cloud-mode `food.log.create` with `eaten_at`
omitted and confirm the agent now sees a clear rejection rather than a phantom-success record.
