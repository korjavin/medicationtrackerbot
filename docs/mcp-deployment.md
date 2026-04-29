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

## Python Executor Service

The `mcp_execute` and `mcp_help` tools require a separate Python runner service. The runner is a long-lived side container that accepts script-run requests from the MCP server, executes them in per-run isolated subprocesses, and returns structured output.

**Where it lives**: `docker/runner/` (Dockerfile) and `internal/mcp/executor/` (Go execution service). See `docs/mcp-python-executor.md` for the full architecture decision record.

**Docker Compose sketch** (placeholder until Task 14 documents final values):

```yaml
  mcp-runner:
    image: ghcr.io/korjavin/medicationtrackerbot-runner:latest
    container_name: medtracker-mcp-runner
    restart: unless-stopped
    networks:
      - mcp_internal   # isolated network: can reach mcp-server bridge only
    environment:
      - RUNNER_BRIDGE_URL=http://mcp-server:8081/internal/mcp/bridge
      - RUNNER_HMAC_SECRET=${MCP_INTERNAL_HMAC_SECRET}
      - RUNNER_MAX_CONCURRENT=4
      - RUNNER_TIMEOUT_MS=30000
      - RUNNER_MAX_MEMORY_MB=1024
      - RUNNER_MAX_RESULT_MB=100
      - RUNNER_MAX_API_CALLS=100
```

**Environment variables** (names are tentative until Task 14):

| Variable | Default | Description |
|---|---|---|
| `RUNNER_BRIDGE_URL` | (required) | URL of the internal HMAC-protected bridge endpoint on the main app |
| `RUNNER_HMAC_SECRET` | (required) | Shared HMAC secret between runner and main-app bridge; same as `MCP_INTERNAL_HMAC_SECRET` |
| `RUNNER_MAX_CONCURRENT` | `4` | Maximum simultaneous script runs |
| `RUNNER_TIMEOUT_MS` | `30000` | Default wall-clock timeout per run |
| `RUNNER_MAX_MEMORY_MB` | `1024` | RSS limit per run subprocess |
| `RUNNER_MAX_RESULT_MB` | `100` | Maximum serialized `output(...)` size |
| `RUNNER_MAX_API_CALLS` | `100` | Maximum proxied API calls per run |

The runner container must NOT mount the Docker socket. Its network must be isolated to the internal bridge — it should not be reachable from the public internet. All outbound requests from scripts go through `RUNNER_BRIDGE_URL` only.

## Adding MCP Tools

1. Add tool definition in `internal/mcp/tools.go` (granular) or a dedicated file (composite tools, e.g. `cardiovascular.go`, `fitness.go`)
2. Implement handler function
3. Register the tool in server initialization (`internal/mcp/mcp.go`)
4. For read tools: include context notes via `notes_helper.go` (`fetchContextNotes` / `shouldIncludeNotes`); support `exclude_notes` parameter
5. For write tools: add a bot HTTP endpoint under `internal/server/` that verifies the HMAC header (mirror `/api/mcp-food-log` and `/api/mcp-workout-log`), then add an `internal/mcp/<tool>_writer.go` HMAC client mirroring `food_writer.go` / `workout_writer.go`, and wire it through `cmd/mcptool/main.go` and `internal/mcp/mcp.go`. Keep the static tool description short and route the protocol document through an `operation: "help"` branch so it doesn't consume agent context tokens on every call.
6. Update `.env.mcp.example` if new config is needed
7. **Naming**: `get_*` for granular read tools, `log_*` / `<noun>_log` for write tools, `analyze_*` for composite read tools
