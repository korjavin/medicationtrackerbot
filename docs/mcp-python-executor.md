# MCP Python Executor Decision

## Decision

Add a new MCP execution path based on three small tools:

- `mcp_help`: discovers allowed backend API operations and returns usage guidance. The full catalog is **terse** (id, topic, method, risk, one-line description) and carries a stable `usage_protocol`; drilling in by `topic`, `operation_id`, or `operation_ids` (batch) returns full param/body schemas + a runnable example + a `response_example`; a `query` keyword search returns terse matches, or auto-expands to full detail when ≤3 operations match. See *MCP Tool Behavior* below.
- `mcp_call`: runs **one** registry operation directly in Go — no Python subprocess — for the common single-read/single-write case. It reuses the exact same policy enforcement scripts get (mode/risk blocking, topic clamps, feature gates, path substitution, the bridge, audit fan-out). See *Single-operation tool (`mcp_call`)* below.
- `mcp_execute`: accepts a Python script, runs it in a sandboxed execution environment, and returns the script's structured output. Reserved for **multi-step** work (loops, joining several operations, computed values).

The intended flow is **discover → run**: `mcp_help` to find operations, then `mcp_call` for a one-shot read/write or `mcp_execute` for a composite script.

Python is the orchestration language, but it is not the authority boundary. Scripts must not receive the real user token, session cookie, backend URL, or unrestricted network access. Scripts call the app through a narrow helper:

```python
from medtracker import api, output

groups = api.call("workouts.groups.list")
output({"group_count": len(groups)})
```

The `medtracker.api.call()` helper talks only to a local API proxy. The proxy maps stable operation IDs to an allowlisted set of backend API operations, forwards those calls with internal server authentication, and records audit metadata.

## Why This Direction

The current MCP surface has granular tools plus a small number of composite analysis tools. Composite tools reduce round trips for known workflows, but they do not scale:

- Maintenance cost grows because composite tools duplicate backend/domain aggregation logic.
- Tool cardinality grows as new analysis directions appear.
- New domains such as workout plan editing would require many specialized MCP tools.
- Agents still need multiple calls for complex workflows that pass IDs and intermediate results between backend operations.

The new path keeps the MCP tool list small while allowing one agent call to perform a multi-step workflow. It also deliberately creates room to learn and harden sandboxed execution, API proxying, and reduced-capability side containers.

## Alternatives Considered

### More composite tools

Rejected as the primary strategy. Useful for high-value stable workflows, but this becomes a parallel API surface with duplicated logic and unbounded cardinality.

### Declarative workflow DSL

Safer and easier to validate, but not selected for this line of work. The goal includes gaining live experience with sandboxed Python execution. A DSL may still be useful later for simple deterministic flows or as an internal representation.

### Raw Python with a bearer token

Rejected. It would be easy to implement, but it leaks authority into the script environment. A compromised or prompt-injected script could exfiltrate data or mutate unintended state.

### MCP tools directly querying SQLite for everything

Rejected for the new execution path. Existing read tools can continue to query SQLite, but the execute path should reuse backend API/domain behavior, especially for writes, validation, audit fan-out, and user-facing semantics.

## Architecture

```text
MCP client
  -> mcp_help(topic? | operation_id? | query?)      # discover (terse catalog / full drill-in / search)
  -> mcp_call(operation_id, params, mode, intent)   # one-shot single op (Go, no subprocess)
       -> MCP server
            -> execution service (Call: fresh proxy, MaxAPICalls=1)
                 -> local API proxy
                      -> allowlisted backend operation registry
                           -> bridge -> main app backend/domain services
  -> mcp_execute(script, mode, limits)              # multi-step composite
       -> MCP server
            -> execution service (Execute)
                 -> Python runner container
                      -> medtracker helper package
                           -> local API proxy
                                -> allowlisted backend operation registry
                                     -> main app backend/domain services
```

`mcp_call` and `mcp_execute` share one execution service, one proxy, one operation registry, one bridge, and one audit fan-out. The only difference is that `mcp_call` builds a fresh proxy with `MaxAPICalls: 1` and runs the single operation in Go, while `mcp_execute` hands the proxy to a sandboxed Python interpreter that may issue many calls. Outcome classification (proxy denial, transport error, policy denial, backend 4xx/5xx, ok) goes through the same shared `classifyProxyResult` helper, so the two paths cannot diverge on status semantics.

## Non-Negotiable Constraints

These rules cannot be relaxed without a new decision record. They describe the long-term posture; see *Known MVP gap* below for the in-process executor caveats that apply today.

1. **No user authority is *handed* to the script.** The runner env passed to the script contains only the local proxy URL and a per-run one-time token scoped to the current invocation. The real user OAuth token, API token, session cookie, and HMAC secret are never injected into the script's environment or globals.
2. **Proxy-only API access is the only documented contract.** The helper exposes only `medtracker.api.call`, which routes through the local API proxy and the operation registry allowlist. The runner image is built without external network configuration.
3. **Bounded execution.** Every run has a hard wall-clock timeout and hard resource limits. There is no override mechanism available to the script itself.
4. **Explicit write mode.** Mutating operations require `mode: "write"` from the caller and a non-empty `intent` string. Read-only is the default. The proxy enforces this independently of the script's declared intent.

## Security Boundary

The sandbox is useful only if authority remains outside the script. The properties below describe the **target** posture (full container isolation via the dedicated `mcp-runner` side container) and are also the operational shield in the MVP. The MVP gap section that follows lists where these are usability shields, not enforced boundaries, until the side-container deployment lands.

- The script does not receive the real user OAuth token, API token, session cookie, or HMAC secret as an input.
- The runner image is built without outbound network configuration except the local API proxy.
- The runner has a read-only root filesystem and only a small temporary work directory if needed.
- The runner uses a non-root user, dropped Linux capabilities, CPU/memory limits, and a hard wall-clock timeout.
- The runner has bounded stdout, stderr, result size, request body size, response body size, and API call count (see Runtime Limits below).
- No Docker socket is mounted into the MCP or runner container.
- No `pip install` or arbitrary dependency download inside a run.
- Writes require explicit `mode: "write"` and must still pass the proxy allowlist.
- The proxy records every API call with operation ID, read/write risk level, status, duration, and truncated error details.

### Known MVP gap: in-process executor isolation

The MVP wires the executor in-process inside `mcp-server` instead of in the dedicated `mcp-runner` side container. In that mode the Python child runs as the same UID as the parent and shares its filesystem, network namespace, and `/proc/<parent>` view. The runner-side env scrub is a usability shield (the script's own `os.environ` is empty), not a boundary: a determined script can read `/proc/<parent>/environ` to recover `MCP_AUDIT_SECRET` and call the bridge directly, or read the SQLite DB straight off disk. The proxy's read-only / topic / call-count enforcement is only effective for scripts that play by the rules.

Memory isolation in the MVP is also limited to the child process's address space via `RLIMIT_AS` (set in `subprocess.Popen.preexec_fn`). The cap kills a single hungry script before it exhausts its own address space, but it is *not* a container-level cap: the parent `mcp-server` shares the host kernel and any per-container memory limit set in `docker-compose.yml` applies to the whole container, not the individual run. The dedicated `mcp-runner` side container closes this gap by adding a cgroup memory limit on the runner itself.

This is acceptable for the MVP because the MCP entry point is already authenticated (OIDC or API token) and the principal calling `mcp_execute` is the same one that holds full app authority through other MCP tools. It is **not** the long-term posture: closing this gap is the motivation for keeping `mcp-runner` build-pinned and ready to switch on. See `docs/mcp-deployment.md` § *MVP in-process isolation tradeoff* for the operator-facing version of this note.

## Runtime Limits

These defaults apply when the caller does not override them. Server configuration caps caller-provided values.

| Limit | Default | Notes |
|---|---|---|
| Wall-clock timeout | 30 s | Hard kill; not graceful shutdown |
| Memory | 1 GB | Address-space cap via `RLIMIT_AS` on the child interpreter (best-effort; production deployment also applies a cgroup memory limit on the runner container) |
| Result size (`output(...)` value) | 100 MB | Serialized JSON bytes |
| Max API calls per run | 100 | Counted by the proxy |
| stdout capture | 1 MB | Excess bytes are truncated and flagged in `warnings` |
| stderr capture | 256 KB | Excess bytes are truncated and flagged in `warnings` |
| Backend response body (per call) | 10 MB | Response bodies larger than this are truncated before returning to the script |
| Request body (per call) | 1 MB | Script-provided body payload; rejected if exceeded |

## Operation Registry

The API proxy is backed by a registry of stable operation IDs. Example entries:

```json
{
  "workouts.groups.list": {
    "method": "GET",
    "path": "/api/workout/groups",
    "risk": "read",
    "topic": "workouts"
  },
  "workouts.exercises.update": {
    "method": "PUT",
    "path": "/api/workout/exercises/update",
    "risk": "write",
    "topic": "workouts"
  }
}
```

The registry is not intended to become a DSL. It is the permission and documentation layer. Python scripts can orchestrate control flow, while the registry decides what backend capabilities are available.

## Helper Package Contract

The runner image provides a small `medtracker` Python package:

```python
from medtracker import api, output

items = api.call("operation.id", params={"id": 123})
created = api.call("operation.id", body={"name": "Example"})
output({"items": items, "created": created})
```

Expected behavior:

- `api.call(operation_id, params=None, body=None)` sends exactly one proxied API call.
- The helper raises a typed exception for transport/proxy errors.
- Application-level errors are returned in a structured form when the backend intentionally returns JSON error details.
- `output(value)` records the final structured result. Only JSON-serializable output is accepted.
- The package exposes no raw token, host, secret, or generic HTTP client.

## MCP Tool Behavior

`mcp_help` supports several discovery axes (precedence: `operation_ids`/`operation_id` > `query` > `topic` > full catalog):

- **Full catalog** (omit all args, or `topic="all"`): returns `compact_operations` — one terse entry per operation (id, topic, method, risk, description), plus `topics`, per-topic `capabilities`, and a stable `usage_protocol`. No schemas or examples, so the menu stays cheap as the registry grows.
- `topic`: domain filter such as `workouts`, `food`, `health`, `medications`. Returns full `operations` (decoded param/body schemas + a runnable example showing `from medtracker import api, output` + a `response_example`).
- `operation_id`: exact operation lookup. Returns the full single entry.
- `operation_ids`: **batch lookup** — an array of operation ids returns the full entry for each found id in one read, so an agent that already knows the 2–3 ops it intends to chain fetches all their schemas without separate drill-ins. Ids not found are listed in `note`. `operation_id` and `operation_ids` are merged.
- `query`: case-insensitive keyword search across operation id, description, topic, and response summary. **Auto-expands**: when ≤3 operations match, returns them as full `operations` (schemas + example + `response_example`) so the agent can go `help(query)` → `mcp_call`/`mcp_execute` with no separate drill-in; >3 matches stay terse in `compact_operations` (drill in with `operation_id`/`operation_ids` for schemas).

**`response_example`** is a small, realistic JSON sample of an operation's output. It is populated for the read/list/get/overview ops that feed chained scripts (write ops are filled incrementally) and is surfaced only on full drill-in (`operations[].response_example`), never in the terse catalog. Showing the output shape up front lets the agent write correct downstream/chained code on the first try instead of guessing an op's response.

**`usage_protocol`** is a stable, self-contained decision rule embedded in the no-arg/full-catalog response: scan/search → drill in → `mcp_call` for one op / `mcp_execute` for multi-step; `output()` exactly once; `params` are the query-string object while `{placeholders}` in a route go in `path_params`; writes need `mode="write"` + a one-sentence intent; timestamps use the user's stored timezone. The same payload (protocol + terse catalog + topics + capabilities) is also exposed as the preloadable `mcp://catalog` MCP resource (see *Catalog resource* below).

Every response carries `note` / `next_step` / `next_tools` steering the agent toward `mcp_call` (one-shot) or `mcp_execute` (composite).

### Catalog resource (`mcp://catalog`)

The MCP server registers a read-only resource at `mcp://catalog` (MIME type `application/json`) so clients that preload resources start already knowing what exists, eliminating the first `mcp_help` scan round-trip. The payload is `{usage_protocol, topics, capabilities, compact_operations}` — the same protocol and terse catalog the no-arg `mcp_help` returns. The redundancy is intentional: the help-embedded `usage_protocol` guarantees reach for tool-only clients (e.g. SSE clients that don't read resources), while the resource is the zero-round-trip bonus for preloading clients. SSE/older clients that ignore resources are unaffected.

`mcp_call` supports:

- `operation_id`: required; the single registry operation to run.
- `params` / `path_params`: optional JSON objects. Scalar values are coerced to the bridge's string form via the same `paramsToStrings` path scripts use, so numbers/bools behave identically.
- `body`: optional raw JSON request body for operations that take one.
- `mode`: `read_only` by default, `write` for mutations.
- `intent`: required for `mode: "write"`; recorded in the audit trail and fanned out to the same audit buffer write scripts use.

`mcp_call` returns `{status, result, error, api_calls, warnings}`. `status` reuses the executor taxonomy: `ok`, `proxy_denied`, `backend_application_error`, `backend_transport_error`, plus `demo_rate_limit`. It can never return `timeout`, `sandbox_startup_failure`, or `script_error` — there is no script or subprocess. `warnings` carries warn-only pre-flight schema feedback (see *Warn-only schema validation* below).

### Warn-only schema validation

Before forwarding a call, `mcp_call` and each `mcp_execute` script call validate the caller's `params`/`body` against the operation's declared JSON Schema and attach field-level **warnings** (e.g. `body.systolic: expected integer, got string`, or `params: missing required field "days"`). Validation is **warn-only — it never blocks**: the call still forwards regardless, so loose or incomplete schemas can't strand a previously-working call. It is also **lenient**: only missing-required fields and wrong types of *declared* fields are reported; unknown/extra fields are ignored (`additionalProperties` is not enforced), and operations without schemas produce no warnings.

Validation runs at the raw-JSON boundary (`handleMCPCall` for `mcp_call`, the executor's loopback `handleCall` for scripts) — *before* params are stringified for the proxy — so typed checks like `{type: integer}` see the real JSON value rather than the proxy's `map[string]string` form. Script-side warnings accumulate per-run and merge into the final `mcp_execute` result's `warnings` alongside the runner-envelope warnings. The shared validator is `registry.ValidateInput(op, params, body)`; compiled schemas are cached per op id (compile-once).

### Self-correcting denial messages

Proxy denials state the fix verbatim so a failure becomes a corrected retry rather than a `mcp_help` detour:

- **Unknown operation** → a *did-you-mean* hint: the message lists up to 3 closest op ids found via `Registry.Search` (falling back to the trailing dot-segment of a typo'd id), e.g. `operation "health.bp.lst" not found. Did you mean: health.bp.list, health.bp.get?`.
- **Write blocked** → "...retry with `mode='write'` and a one-sentence intent."
- **Topic not allowed** → names the allowed topics.
- **Max calls exceeded** → states the cap.

These messages propagate unchanged through `classifyProxyResult` into `CallResponse.Error` / `ExecuteResponse.Error`.

`mcp_execute` supports:

- `script`: Python source code.
- `mode`: `read_only` by default, `write` for mutating workflows.
- `intent`: required for `mode: "write"`; a human-readable audit explanation of what the script is trying to change.
- `timeout_ms`: optional limit capped by server config.
- `max_api_calls`: optional limit capped by server config.
- `topic_allowlist`: optional additional restriction for a single run.

When the caller omits limits, the first version should use these defaults:

- Timeout: 30 seconds.
- Memory limit: 1 GB.
- Result size limit: 100 MB.
- Max API calls: 100.

The MCP server should return structured output:

```json
{
  "status": "ok",
  "result": {},
  "api_calls": [],
  "stdout": "",
  "stderr": "",
  "warnings": []
}
```

Failures should be similarly structured and should distinguish script errors, timeout, sandbox startup failure, proxy denial, backend application error, and backend transport error.

## Migration Strategy

Keep existing granular and composite MCP tools while the executor matures. Stop adding new composite tools unless they encode stable domain-specific behavior that is clearly better than agent-written orchestration.

Registry operations should prefer backend HTTP routes instead of wrapping MCP direct-read SQLite code. The backend API/domain layer should be the default source of behavior so validation, response semantics, user scoping, and future route evolution stay centralized.

Initial target:

- Read-only workout operation catalog.
- `mcp_help(topic="workouts")`.
- `mcp_execute` running a Python script that lists workout groups, variants, and exercises through the proxy.

Then expand to writes and other domains.

The first runner implementation should use a long-lived execution service rather than one-shot runner containers, to avoid per-run container startup latency. Per-run isolation is still required inside that service.

## Success Criteria

- A complex workflow that previously needed many MCP calls can be completed with one `mcp_execute` call.
- A single read or write costs one `mcp_call` — no script authoring, no sandbox spawn, no `output()`-exactly-once footgun — while going through the identical policy + audit path as a script.
- The full `mcp_help` catalog stays terse as the registry grows; full schemas + examples + response examples are one drill-in (or batch `operation_ids`, or ≤3-match `query` auto-expand) away, and `query` finds operations by keyword.
- The discover→execute loop is short: `response_example` + `usage_protocol` + the `mcp://catalog` resource let an agent write a correct chained script first try; did-you-mean errors and warn-only schema warnings turn failures into self-repairing retries instead of `mcp_help` detours.
- The script can pass data between API calls without exposing user authority.
- Backend domain logic remains in the main app.
- The proxy audit trail is clear enough to debug what the agent did.
- The static MCP tool list stays small as backend capability grows.
