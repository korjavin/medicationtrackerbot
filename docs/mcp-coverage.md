# MCP Coverage Policy

Every HTTP route registered on the bot's server must be reachable through the MCP operation registry — or explicitly opted out, with a written reason. A test enforces this on every CI run, so adding a new route without satisfying one of those two paths will fail the build.

The goal is concrete: an agent connected to the MCP server should be able to do anything a human can do in the web UI. If a route exists, the agent must either be able to call it, or there must be a written reason why not.

## How it works

Three pieces wired together:

### 1. `recordingMux` — captures registrations

`internal/server/route_record.go` wraps `*http.ServeMux` and appends every registered pattern (method + path) to a slice on `Server`. Both the outer `mux` and the inner `apiMux` use it; the embedded `*http.ServeMux` keeps the call-site syntax unchanged and other code that holds the mux as `http.Handler` keeps working.

### 2. `mcpCoverageExempt` — the allowlist

`internal/server/mcp_coverage_exempt.go` is a flat list of `routeExemption{Method, Path, Reason}` entries. The `Reason` field is required and non-empty; a test asserts this. Three buckets are intentionally exempt:

1. **Transport / shell** — UI delivery, auth, static files, MCP plumbing itself, web-push subscriptions, bootstrap/init/changes feeds. The agent has no legitimate reason to invoke them, and exposing some of them (like settings feature toggles that gate MCP itself) would be a privilege loop.
2. **Routes already served by an atomic MCP tool** — for example, the `/api/workout/sessions/logs/*` routes are the HTTP shape that the `workout_log` MCP tool calls. Reaching them through `mcp_execute` too would duplicate semantics with no agent-side benefit.
3. **Legacy compat shims** — older paths kept around to avoid breaking pinned clients, superseded by a newer path that IS in the registry.

### 3. The guard test

`internal/server/mcp_coverage_test.go` defines four checks that all run as part of `go test ./internal/server/...`:

- `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` — for every route the recording mux saw, the test asserts that *either* a registered MCP `Operation` matches `(Method, Path)` exactly (with `{name}` placeholders preserved verbatim) *or* an exemption matches. Failure prints a sorted, copy-pasteable list of missing routes plus the resolution: register an op, or add to the allowlist.
- `TestMCPCoverage_ExemptionsHaveReasons` — every exemption carries a non-empty `Reason`. No silent escape hatches.
- `TestMCPCoverage_NoStaleExemptions` — every exemption matches a currently-registered route. Catches drift in the other direction: when a route is renamed or removed, its exemption must disappear too, otherwise a future regression could re-introduce the same path without coverage and the stale entry would silently mask it.
- `TestMCPCoverage_NoDuplicateExemptions` — sanity check.

## What to do when adding a new route

When you add a new `apiMux.HandleFunc("METHOD /path", handler)` (or `mux.HandleFunc(...)` for a top-level route), the guard test will fail until you do one of:

### Option A — register an Operation (default for user-actionable routes)

Add an entry to the appropriate per-topic file in `internal/mcp/registry/`:

```go
{
    ID:     "<topic>.<verb>",
    Topic:  "<topic>",            // workouts | food | health | medications
    Method: "POST",
    Path:   "/api/foo/{id}/bar",  // exactly as registered on the mux
    PathParams: []string{"id"},   // every {placeholder} must be listed
    Risk:   RiskWrite,            // RiskRead for GETs, RiskWrite for state mutations
    BodySchema: json.RawMessage(`{...}`), // JSON Schema for the body (omit for GET / no-body)
    ParamsSchema: json.RawMessage(`{...}`), // JSON Schema for query params (optional)
    Description:     "What it does, when to use it, gotchas (e.g. \"full replacement, read first\").",
    ResponseSummary: "What the response contains in plain English.",
    Example: `result = api.call(
    "<topic>.<verb>",
    path_params={"id": 1},
    body={...},
)
output(result)`,
},
```

Then update the per-topic test (`TestMedicationOperations`, `TestFoodOperations`, etc.) to assert the new id is present and classified correctly.

### Option B — add to the allowlist (for routes that should NOT be MCP-reachable)

If the route really is internal-only (UI shell, auth callback, web-push subscription, MCP plumbing, or a feature toggle that gates MCP itself), add an entry to `mcpCoverageExempt`:

```go
{Method: "POST", Path: "/api/foo/internal", Reason: "internal hook used only by the X subsystem"},
```

The `Reason` is mandatory and is reviewed in code review. If you can't explain in one sentence why the route belongs in the allowlist, register it as an Operation instead.

## Path params and the bridge

Routes with `{name}` placeholders (e.g. `POST /api/medications/{id}`) require both:

1. A `PathParams: []string{"id"}` declaration on the `Operation` (the registry validates the placeholders match);
2. The agent script passing `path_params={"id": 7}` in `api.call(...)`.

The bridge URL-escapes substitution values, so a path-param value of `1/2` is encoded as `1%2F2` and cannot redirect to a different handler than the one declared in the registry. See `internal/mcp/registry/SubstitutePath` and tests in `internal/server/mcp_bridge_test.go`.

## Discoverability for agents

`mcp_help` exposes every registered Operation's `path_params`, schemas, description, and example. The landing response (no-args call) includes a `Capabilities` map summarizing read/write counts per topic, so an agent looking for "can I do X?" can scan the topic list before drilling in. See `internal/mcp/help.go` and the `TestMCPHelp_*` tests.
