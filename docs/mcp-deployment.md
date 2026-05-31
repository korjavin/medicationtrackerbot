# MCP Server Deployment

The MCP connector runs as a separate process (binary: `mcptool`) but shares the same Docker image and database as the main bot. It exposes an HTTP server that Claude connects to via a secure tunnel (handled by your Traefik setup).

## 1. Pocket-ID Configuration

Before deploying, set up an OIDC client in Pocket-ID.

1. **Log in** to your Pocket-ID instance.
2. **Create a new Client**:
    - **Name**: Claude Health MCP
    - **Redirect URIs**: `https://claude.ai/api/mcp/auth_callback` AND `https://claude.com/api/mcp/auth_callback` (add both to be safe)
    - **Access Type**: Public (or Confidential — the MCP implementation is a confidential client)
    - **Trust Level**: High (recommended)
3. **Note Credentials**: copy the `Client ID` and `Client Secret`.
4. **Get User Subject**: find your unique User Subject UUID (`sub` claim) in your Pocket-ID user profile or by inspecting an ID token. You'll use this to restrict access.

## 2. Docker Compose Configuration

Add a service to your `docker-compose.yml`:

```yaml
  mcp-server:
    image: ghcr.io/korjavin/medicationtrackerbot:latest
    container_name: medtracker-mcp
    restart: unless-stopped
    command: ["./mcptool"]  # Override default command
    volumes:
      - medtracker_data:/app/data  # Must be writable: goose runs migrations on startup, and the admin API writes to api_tokens
    environment:
      - MCP_PORT=8081
      - MCP_DATABASE_PATH=/app/data/meds.db
      - MCP_MAX_QUERY_DAYS=90
      - MCP_SERVER_URL=https://mcp.yourdomain.com
      - MCP_ALLOWED_SUBJECT=your-user-uuid-here    # Optional: comma-separated list of allowed `sub` values; empty = any
      - POCKET_ID_URL=https://id.yourdomain.com
      - POCKET_ID_CLIENT_ID=your-client-id         # Comma-separated client IDs accepted in token audience
      - POCKET_ID_CLIENT_SECRET=your-client-secret
      - MCP_ADMIN_PORT=8082                        # Loopback-only admin API for managing API tokens; set to 0 to disable
      - TZ=${TZ:-Europe/Berlin}
    networks:
      - default
      - traefik_net
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.medtracker-mcp.rule=Host(\`mcp.yourdomain.com\`)"
      - "traefik.http.routers.medtracker-mcp.entrypoints=websecure"
      - "traefik.http.routers.medtracker-mcp.tls.certresolver=myresolver"
      - "traefik.http.services.medtracker-mcp.loadbalancer.server.port=8081"
```

> **IMPORTANT**: `MCP_SERVER_URL` must match the Host rule in Traefik labels.

## 3. Configuring Claude

1. Open **Claude Desktop** or **Claude.ai** (MCP enabled).
2. Go to **Settings** → **MCP**.
3. Add a new MCP Server:
    - **Type**: Streamable HTTP
    - **URL**: `https://mcp.yourdomain.com/mcp`

### Legacy SSE transport (ElevenLabs, older clients)

Clients that still use the 2024-11-05 SSE transport (e.g. ElevenLabs) can connect at `https://mcp.yourdomain.com/sse` instead. Same OAuth/api-token auth as `/mcp`. New integrations should prefer Streamable HTTP at `/mcp`.

### Alternative: local Stdio run

You can also run the binary locally against a local DB copy:

```json
{
  "mcpServers": {
    "health-tracker": {
      "command": "/path/to/mcptool",
      "env": {
        "MCP_DATABASE_PATH": "..."
      }
    }
  }
}
```

## Long-lived API tokens

For consumers that cannot complete the Pocket-ID OIDC flow (scripts, CI jobs, simple automations), the MCP server accepts long-lived bearer tokens prefixed `mcp_`. Tokens never expire; revocation is by deletion.

Tokens are managed via a tiny admin HTTP API that listens on a loopback-only socket (`127.0.0.1:MCP_ADMIN_PORT`, default `8082`). The listener has no authentication of its own — protection comes from the OS-level binding. Do NOT proxy this port through Traefik or any reverse proxy. Set `MCP_ADMIN_PORT=0` to disable the admin API entirely.

> **Important — `MCP_ALLOWED_SUBJECT` does not gate API tokens.** The allowlist applies only to JWT-authenticated requests. Any active API token authorizes a request regardless of `MCP_ALLOWED_SUBJECT`; the equivalent gate for API tokens is "the row exists in `api_tokens`" (so revoke = delete). If you need a per-token allowlist, manage it by which tokens you create.

The plaintext token is returned ONCE at creation. Only `sha256(token)` is stored. If you lose the plaintext, delete the row and create a new token.

Because the admin listener is bound inside the container's network namespace, `127.0.0.1:8082` on the host is NOT the same socket. The application image ships without `curl`, and Docker's published-port forwarding targets the container's external interface (not its loopback), so neither `docker exec medtracker-mcp curl ...` nor a `127.0.0.1:8082:8082` host port mapping will reach the admin server.

The reliable way to talk to the admin API is to run a short-lived helper container that shares the MCP container's network namespace — its `127.0.0.1` then IS the MCP container's loopback:

```bash
# Create a token (plaintext returned ONCE — store it immediately)
docker run --rm --network container:medtracker-mcp curlimages/curl:latest \
  -s -X POST http://127.0.0.1:8082/admin/tokens \
  -H 'Content-Type: application/json' \
  -d '{"name":"home-automation"}'
# → {"id":1,"name":"home-automation","token":"mcp_<64 hex chars>"}

# List tokens (no plaintext)
docker run --rm --network container:medtracker-mcp curlimages/curl:latest \
  -s http://127.0.0.1:8082/admin/tokens

# Revoke a token
docker run --rm --network container:medtracker-mcp curlimages/curl:latest \
  -s -X DELETE http://127.0.0.1:8082/admin/tokens/1
```

For non-Docker deployments (running `mcptool` directly on a host), the admin API is reachable as `http://127.0.0.1:8082/admin/tokens` from the same host with any local HTTP client.

Use the token to call the MCP endpoint:

```bash
curl -H "Authorization: Bearer mcp_<token>" https://mcp.yourdomain.com/mcp
```

When a request arrives with an `Authorization: Bearer mcp_...` header the OAuth middleware looks the token up by hash; on hit it sets the request subject to `api-token:<name>` and updates `last_used_at`. Bearer values without the `mcp_` prefix fall through to the standard JWT validation path.

## Tools

Read tools (`get_*`, `analyze_*`) query the SQLite database directly from the MCP process and return JSON.

Write tools route mutations through the main bot's HTTP server rather than writing the SQLite database directly: the MCP process HMAC-signs a JSON payload and POSTs it to the bot, which performs the write through its domain services (so audit fan-out, validation, and attribution stay centralized). Both processes share `MCP_AUDIT_ENDPOINT` / `MCP_AUDIT_SECRET`; the per-tool endpoint is derived from the audit endpoint's host (`/api/mcp-food-log`, `/api/mcp-workout-log`).

**Weight unit contract**: all MCP responses involving weight are emitted in kilograms with explicit `_kg`-suffixed field names (`weight_kg`, `current_kg`, `trend_kg`, `change_kg`). The user's web/bot weight unit preference (`weight_unit_preference`, kg or lb) lives only on the user-facing surface and never leaks into MCP — `get_weight` and `analyze_fitness` always return kg even after the user switches their UI preference to lb. This keeps the agent contract unambiguous; agents can convert at the presentation layer if needed.

### `workout_log`

Single entry point for workout logging. The static tool description is intentionally short — the agent calls `operation: "help"` first to fetch the full protocol document (input/response shape, resolution rules, idempotency semantics).

Operations:
- `help` — return the protocol document (no DB / network call)
- `log` — append or upsert exercises into a workout session (creates an ad-hoc session when no `session_id`/`session_ref` is provided). Resolves fuzzy exercise names against the user's catalog (exact → substring → Levenshtein ≤ 2) and infers omitted sets/reps/weight from the most recent matching log. Returns per-exercise statuses (`logged` / `ambiguous` / `missing_defaults`) so partial successes are observable.
- `get` — recent N sessions with their exercise logs
- `delete_exercise` — remove the log for `(session_id, exercise_name)`

Idempotency: upsert key is `(session_id, resolved_name)` — re-sending refines state instead of duplicating.

### `mcp_call` input repair (lenient normalization)

Before a one-shot `mcp_call` leaves the MCP layer, `registry.NormalizeCallInput`
(wired in `internal/mcp/call.go`) repairs two structural mistakes that weaker
tool-calling models make routinely. It never blocks — every repair is reported
back in the response `warnings` array so the behavior is observable, and the
schema-validation warnings are computed against the *repaired* shape:

- **Misplaced body fields.** For a write operation with a body schema, any
  `params` entry whose key is a declared body property is moved into `body`
  (without clobbering a value already there). Models frequently put a write's
  fields in `params` instead of `body`; the bridge forwards `params` as the URL
  query string, so the handler would otherwise see an empty body and return
  `400 Invalid JSON`.
- **Relative-date tokens.** A timestamp/date field (detected from its schema:
  name ends in `_at` / is `date`/`from`/`to`, or its description names an
  RFC3339/ISO8601/`YYYY-MM-DD` format) whose value is `now` / `today` /
  `yesterday` / `tomorrow` is resolved against the server clock — RFC3339 (UTC)
  for a full-timestamp field, `YYYY-MM-DD` for a date-only field. This mirrors
  the `current_time` hint stamped on every `mcp_help` response, so a tool-only
  agent with no clock can pass `"today"` instead of inventing a (frequently
  wrong) literal date.

The repair only affects the `mcp_call` path (where params are still typed JSON);
`mcp_execute` scripts build the body explicitly in Python. The strong-model
trajectory is unchanged (it already places fields in `body` and sends concrete
dates), so normalization is a no-op for well-formed calls.

## Python Executor Service

The `mcp_execute` and `mcp_help` tools require a sandboxed Python runner. The runner is invoked from the MCP server as a per-run subprocess (see `internal/mcp/executor/service.go`); the runner image is built from `docker/runner/Dockerfile` and ships with the `medtracker` Python helper baked in. There is no `pip install` at runtime.

**Architecture**:

- `internal/mcp/registry/` — operation allowlist (read/write classification, JSON Schema).
- `internal/server/mcp_bridge.go` — HMAC-protected bridge endpoint at `/internal/mcp/bridge` on the main app. Executes the operation as the configured `ALLOWED_USER_ID`; identity is never spoofable from the request.
- `internal/mcp/proxy/proxy.go` — in-process Go proxy used by the executor. Validates the operation ID, applies per-run topic/mode/call-count limits, signs the bridge call.
- `internal/mcp/executor/service.go` — long-lived service that spawns the runner subprocess, hosts a loopback `/call` listener for the script, and tracks per-run state.
- `python/runner/runner.py` — sandbox entrypoint. Reads run config on stdin, scrubs the env, runs the script with bounded stdout/stderr, returns a result envelope on stdout.
- `python/medtracker/` — narrow helper exposing only `api.call(...)` and `output(...)`. It is the only network surface scripts get.

See `docs/mcp-python-executor.md` for the full architecture decision record.

### Configuration

The MCP server-side caps for `mcp_execute` are configured in `docker-compose.yml` on the `mcp-server` service:

```yaml
- MCP_EXECUTOR_MAX_TIMEOUT_MS=30000        # Hard wall-clock cap per run
- MCP_EXECUTOR_MAX_API_CALLS=100           # Counted by the proxy per run
- MCP_EXECUTOR_MAX_CONCURRENT=4            # Runs above this are rejected with sandbox_startup_failure
- MCP_EXECUTOR_PROXY_URL=http://127.0.0.1:8090/call   # Loopback URL the runner uses
```

The HMAC secret on the bridge endpoint is the existing `MCP_AUDIT_SECRET` — the executor reuses it instead of introducing a parallel secret. See [environment.md](environment.md#python-executor-mcp_execute--mcp_help) for the full table including the per-run env vars (`MEDTRACKER_PROXY_URL`, `MEDTRACKER_RUN_TOKEN`) that the executor sets inside the sandbox.

### Local development

The executor runs in-process inside `cmd/mcptool` for the MVP, so local dev does not require Docker:

```bash
# 1. Run the main bot in one terminal so the bridge endpoint is reachable.
ALLOWED_USER_ID=... DB_PATH=meds.db MCP_AUDIT_SECRET=dev-secret \
  go run ./cmd/bot

# 2. Run the MCP server in a second terminal pointing at the same DB and secret.
ALLOWED_USER_ID=... MCP_DATABASE_PATH=meds.db POCKET_ID_URL=http://localhost \
  MCP_SERVER_URL=http://localhost:8081 MCP_AUDIT_SECRET=dev-secret \
  MCP_AUDIT_ENDPOINT=http://localhost:8080/api/mcp-audit \
  MCP_EXECUTOR_PROXY_URL=http://127.0.0.1:8090/call \
  go run ./cmd/mcptool

# 3. Drive mcp_help / mcp_execute from a Streamable-HTTP-compatible MCP client
#    pointed at http://localhost:8081/mcp.
```

The runner subprocess uses whatever `python3` is on `$PATH`. To test the runner image without spawning real subprocesses, the unit tests under `internal/mcp/executor/` use a fake `Spawner`. Python-side tests live in `python/tests/` and `python/runner/runner_test.py`:

```bash
go test ./internal/mcp/...
pytest python/
```

To exercise the production build of the runner image:

```bash
docker compose --profile build-only build mcp-runner
docker run --rm -i --network none ghcr.io/korjavin/medicationtrackerbot-runner:latest \
  < tests/runner-payload.json
```

### MVP in-process isolation tradeoff

The MVP wires the executor in-process inside `mcp-server` (see `internal/mcp/executor/service.go`); the side container `mcp-runner` ships with `profiles: ["build-only"]` and is not started by `docker compose up`. This MVP path is the path used in production today, and it has a known isolation gap that operators must understand:

- The Python child runs as the **same UID** as `mcp-server`, sharing its filesystem, network namespace, and `/proc/<parent>` view.
- A malicious script can read `/proc/<mcptool-pid>/environ` (same UID) to recover `MCP_AUDIT_SECRET` and other env-injected secrets, then call `/internal/mcp/bridge` directly with a valid HMAC — **bypassing the in-process proxy's read-only/intent/topic/call-count enforcement**.
- It can also read or write any file the `mcp-server` process can reach (e.g. the SQLite database under `/app/data`), bypassing the registry entirely.
- Runner-side env scrub blocks the easy path (the script's own `os.environ` is empty), but is **not a security boundary** when the parent's environment remains readable via `/proc`.

Mitigations available today:

- **Trust the model and the auth boundary.** The MCP entry point is OIDC- or API-token-gated; only authorized callers can reach `mcp_execute`. Treat sandboxed Python as orchestration on behalf of an already-authenticated principal, not as a hostile-script harness.
- **Disable `mcp_execute` if you do not need it.** Leave `MCP_EXECUTOR_BRIDGE_URL` (or `MCP_AUDIT_SECRET`) empty and the executor stays unwired; the tool short-circuits with "execution service not configured".
- **Switch to the side container** for stronger isolation (next section) when the executor moves out of MVP. Until then, the runtime constraints below apply only to that future deployment, not to the MVP in-process path.

### Production hardening (side-container path)

These assumptions are non-negotiable for the future side-container deployment (they are encoded in `docker-compose.yml` for `mcp-runner`, but operators should verify after any compose edits). They do **not** all apply to the in-process MVP — see the previous section.

- **Read-only root filesystem.** `read_only: true` on the runner service. The only writable surface is the `/tmp` tmpfs mount.
- **No Docker socket.** Neither `mcp-server` nor `mcp-runner` mounts `/var/run/docker.sock`. Scripts cannot spawn containers.
- **Capability drop.** `cap_drop: [ALL]` plus `security_opt: [no-new-privileges:true]`.
- **Network isolation.** `mcp-runner` attaches only to `runner_net`, which is `internal: true`. The runner can reach the loopback proxy URL; it cannot reach the public Internet.
- **No authority secrets in the runner env.** The executor scrubs the env before exec — only `MEDTRACKER_PROXY_URL` and a per-run `MEDTRACKER_RUN_TOKEN` reach the script. Do not add `OPENAI_API_KEY`, `MCP_AUDIT_SECRET`, or `POCKET_ID_*` to the runner service. (In the side-container path the secrets are only present in `mcp-server`, not in the runner container, so `/proc` is no longer a leak vector.)
- **Resource caps.** `deploy.resources.limits` pins the runner to 1 GB / 1 CPU; per-run timeouts and call counts are enforced server-side by the executor service before forwarding to the runner.
- **No `pip install` at runtime.** The image bakes in only the `medtracker` helper (stdlib-only). The runtime container has no writable site-packages.

### Why scripts use `medtracker.api.call` instead of raw HTTP

The Python script never holds user authority. The helper enforces this:

- **No bearer token, session cookie, or backend hostname is exposed.** `api.call` reads only `MEDTRACKER_PROXY_URL` (loopback) and `MEDTRACKER_RUN_TOKEN` (a per-run nonce that the proxy validates before forwarding).
- **No generic HTTP client is exported.** `medtracker` deliberately omits `requests`, `httpx`, and any "open URL" primitive. In the side-container deployment the runner network is `internal: true`, so even `urllib.urlopen("https://...")` cannot leave the sandbox. In the MVP in-process path the runner inherits `mcp-server`'s network namespace and *can* reach the public Internet via `urllib`; this is one more reason the MVP relies on the auth boundary rather than treating sandboxed Python as a hostile-script harness (see "MVP in-process isolation tradeoff" above).
- **The proxy is the authority boundary.** It validates the operation ID against the registry, classifies risk (`read`/`write`), enforces `mode == "write"` and a non-empty `intent` for mutations, applies per-run call counters, and HMAC-signs the bridge call. None of that logic lives in the script.
- **Audit trail.** Every proxied call records operation ID, risk, status, and duration in the call trace returned from `mcp_execute`. The executor logs every run via slog (`run_id`, `mode`, `duration_ms`, `api_calls`, `status`, `exit_reason`, and the caller-provided `intent` for writes). When `MCP_AUDIT_ENDPOINT` is configured, write runs are also fanned out into the same audit buffer the granular tools use, so a "🔍 MCP queried: MCP script (write): <intent>" notification reaches the user via the bot's Telegram channel.

A "raw HTTP" path would lose every one of these guarantees and turn the runner into a generic exfiltration surface. Keep scripts on `medtracker.api.call`; if a needed operation is missing, add it to the registry instead of working around the helper.

## Adding MCP Tools

1. Add tool definition in `internal/mcp/tools.go` (granular) or a dedicated file (composite tools, e.g. `cardiovascular.go`, `fitness.go`)
2. Implement handler function
3. Register the tool in server initialization (`internal/mcp/mcp.go`)
4. For read tools: include context notes via `notes_helper.go` (`fetchContextNotes` / `shouldIncludeNotes`); support `exclude_notes` parameter
5. For write tools: add a bot HTTP endpoint under `internal/server/` that verifies the HMAC header (mirror `/api/mcp-food-log` and `/api/mcp-workout-log`), then add an `internal/mcp/<tool>_writer.go` HMAC client mirroring `food_writer.go` / `workout_writer.go`, and wire it through `cmd/mcptool/main.go` and `internal/mcp/mcp.go`. Keep the static tool description short and route the protocol document through an `operation: "help"` branch so it doesn't consume agent context tokens on every call.
6. Update `.env.mcp.example` if new config is needed
7. **Naming**: `get_*` for granular read tools, `log_*` / `<noun>_log` for write tools, `analyze_*` for composite read tools

## Transition Strategy: granular tools vs. `mcp_call` / `mcp_execute`

The `mcp_help` / `mcp_call` / `mcp_execute` trio is the long-term direction: a discover-then-run surface backed by the operation registry, instead of growing the tool list every time a new domain is exposed. `mcp_help` discovers operations (terse catalog, full drill-in by `operation_id`/`operation_ids`, or `query` keyword search), `mcp_call` runs a single read/write directly in Go, and `mcp_execute` runs a sandboxed Python script for multi-step work. While the executor is experimental, the existing granular and composite tools stay in place — all paths are supported and tested.

**Loop ergonomics.** The discover→execute round-trip is deliberately short:

- **Response shapes in help.** Full operation entries carry a `response_example` (a realistic JSON sample of the output), so an agent can write correct chained scripts without guessing an op's response shape.
- **Batch + auto-expand discovery.** `mcp_help` accepts `operation_ids: [...]` to fetch several full schemas in one read, and a `query` matching ≤3 ops auto-expands to full detail (schemas + example + response_example) — collapsing `help(query)` → `help(operation_id)` → execute into `help(query)` → execute.
- **Usage protocol + catalog resource.** No-arg `mcp_help` always includes a stable `usage_protocol` (the 3-tool decision rule), and the server registers an `mcp://catalog` MCP resource (`application/json`) carrying `{usage_protocol, topics, capabilities, compact_operations}` so preloading clients skip the first scan entirely. SSE/older clients that ignore resources still get the protocol via `mcp_help`.
- **Self-correcting errors.** An unknown operation id returns a *did-you-mean* hint (up to 3 closest ids), write/topic/cap denials state the fix verbatim, and a type-mismatched `params`/`body` returns warn-only schema warnings while the call still proceeds. See `docs/mcp-python-executor.md` for the full behavior.

- **Granular read tools (`get_*`) and `workout_log` are kept.** They are stable, cheap, and well covered by clients that can't run scripted workflows. `workout_log`'s name resolution and exercise-default inference is currently richer than what an agent can reasonably reconstruct from raw registry calls; keep it as a first-class tool until that gap closes.
- **Stop adding new composite tools.** Cross-domain analyses that today would have become an `analyze_*` tool should instead be expressed as an `mcp_execute` script that calls registry operations. New composites only land if there is a clear, stable, agent-independent use case that justifies hard-coding the workflow.
- **`analyze_cardiovascular` and `analyze_fitness` stay registered.** No removal is planned in this round. Once the operation registry covers their inputs end to end and we have evidence that scripted equivalents perform as well, they will be downgraded to compatibility shims (still callable, no longer the recommended path) — that decision will be recorded in this section before any behavior change.
- **Recommended path for new MCP clients:** start with `mcp_help` to discover operations (the catalog is terse and carries a `usage_protocol`; pass `query=` to search — ≤3 matches auto-expand to full detail — or `operation_id=`/`operation_ids=[...]`/`topic=` to see schemas + an example + a response example), then run a single read/write with `mcp_call` or compose a multi-step workflow with `mcp_execute`. Preloading clients can read the `mcp://catalog` resource to skip the first scan. Fall back to the granular tools for clients without script execution support, and for the two composite analyses listed above.
