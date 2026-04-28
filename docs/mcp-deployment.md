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
      - medtracker_data:/app/data:ro  # Read-only access to data
    environment:
      - MCP_PORT=8081
      - MCP_DATABASE_PATH=/app/data/meds.db
      - MCP_MAX_QUERY_DAYS=90
      - MCP_SERVER_URL=https://mcp.yourdomain.com
      - MCP_ALLOWED_SUBJECT=your-user-uuid-here    # Optional: comma-separated list of allowed `sub` values; empty = any
      - POCKET_ID_URL=https://id.yourdomain.com
      - POCKET_ID_CLIENT_ID=your-client-id         # Comma-separated client IDs accepted in token audience
      - POCKET_ID_CLIENT_SECRET=your-client-secret
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

## Tools

Read tools (`get_*`, `analyze_*`) query the SQLite database directly from the MCP process and return JSON.

Write tools cannot mutate the read-only DB volume; instead they HMAC-sign a JSON payload and POST it to the main bot's HTTP server, which performs the write. Both processes share `MCP_AUDIT_ENDPOINT` / `MCP_AUDIT_SECRET`; the per-tool endpoint is derived from the audit endpoint's host (`/api/mcp-food-log`, `/api/mcp-workout-log`).

### `workout_log`

Single entry point for workout logging. The static tool description is intentionally short — the agent calls `operation: "help"` first to fetch the full protocol document (input/response shape, resolution rules, idempotency semantics).

Operations:
- `help` — return the protocol document (no DB / network call)
- `log` — append or upsert exercises into a workout session (creates an ad-hoc session when no `session_id`/`session_ref` is provided). Resolves fuzzy exercise names against the user's catalog (exact → substring → Levenshtein ≤ 2) and infers omitted sets/reps/weight from the most recent matching log. Returns per-exercise statuses (`logged` / `ambiguous` / `missing_defaults`) so partial successes are observable.
- `get` — recent N sessions with their exercise logs
- `delete_exercise` — remove the log for `(session_id, exercise_name)`

Idempotency: upsert key is `(session_id, resolved_name)` — re-sending refines state instead of duplicating.

## Adding MCP Tools

1. Add tool definition in `internal/mcp/tools.go` (granular) or a dedicated file (composite tools, e.g. `cardiovascular.go`, `fitness.go`)
2. Implement handler function
3. Register the tool in server initialization (`internal/mcp/mcp.go`)
4. For read tools: include context notes via `notes_helper.go` (`fetchContextNotes` / `shouldIncludeNotes`); support `exclude_notes` parameter
5. For write tools: add a bot HTTP endpoint under `internal/server/` that verifies the HMAC header (mirror `/api/mcp-food-log` and `/api/mcp-workout-log`), then add an `internal/mcp/<tool>_writer.go` HMAC client mirroring `food_writer.go` / `workout_writer.go`, and wire it through `cmd/mcptool/main.go` and `internal/mcp/mcp.go`. Keep the static tool description short and route the protocol document through an `operation: "help"` branch so it doesn't consume agent context tokens on every call.
6. Update `.env.mcp.example` if new config is needed
7. **Naming**: `get_*` for granular read tools, `log_*` / `<noun>_log` for write tools, `analyze_*` for composite read tools
