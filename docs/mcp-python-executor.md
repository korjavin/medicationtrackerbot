# MCP Python Executor Decision

## Decision

Add a new MCP execution path based on two small tools:

- `mcp_help`: returns a compact catalog of allowed backend API operations and usage guidance for the Python helper package.
- `mcp_execute`: accepts a Python script, runs it in a sandboxed execution environment, and returns the script's structured output.

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
  -> mcp_help(topic?)
  -> mcp_execute(script, mode, limits)
       -> MCP server
            -> execution service
                 -> Python runner container
                      -> medtracker helper package
                           -> local API proxy
                                -> allowlisted backend operation registry
                                     -> main app backend/domain services
```

## Non-Negotiable Constraints

These rules cannot be relaxed without a new decision record:

1. **No user authority in the script.** The script never receives the real user OAuth token, API token, session cookie, or HMAC secret. The runner env contains only the local proxy URL and a per-run one-time token scoped to the current invocation.
2. **Proxy-only API access.** The runner has no outbound network except the local API proxy endpoint. All backend calls go through the operation registry allowlist.
3. **Bounded execution.** Every run has a hard wall-clock timeout and hard resource limits. There is no override mechanism available to the script itself.
4. **Explicit write mode.** Mutating operations require `mode: "write"` from the caller and a non-empty `intent` string. Read-only is the default. The proxy enforces this independently of the script's declared intent.

## Security Boundary

The sandbox is useful only if authority remains outside the script. These rules are non-negotiable for the initial design:

- The script never receives the real user OAuth token, API token, session cookie, or HMAC secret.
- The runner has no outbound network except the local API proxy.
- The runner has a read-only root filesystem and only a small temporary work directory if needed.
- The runner uses a non-root user, dropped Linux capabilities, CPU/memory limits, and a hard wall-clock timeout.
- The runner has bounded stdout, stderr, result size, request body size, response body size, and API call count (see Runtime Limits below).
- No Docker socket is mounted into the MCP or runner container.
- No `pip install` or arbitrary dependency download inside a run.
- Writes require explicit `mode: "write"` and must still pass the proxy allowlist.
- The proxy records every API call with operation ID, read/write risk level, status, duration, and truncated error details.

## Runtime Limits

These defaults apply when the caller does not override them. Server configuration caps caller-provided values.

| Limit | Default | Notes |
|---|---|---|
| Wall-clock timeout | 30 s | Hard kill; not graceful shutdown |
| Memory | 1 GB | RSS limit via cgroup or ulimit |
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

`mcp_help` should support:

- `topic`: optional domain filter such as `workouts`, `food`, `health`, `medications`, or `all`.
- `operation_id`: optional exact operation lookup.
- compact examples showing `from medtracker import api, output`.

`mcp_execute` should support:

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
- The script can pass data between API calls without exposing user authority.
- Backend domain logic remains in the main app.
- The proxy audit trail is clear enough to debug what the agent did.
- The static MCP tool list stays small as backend capability grows.
