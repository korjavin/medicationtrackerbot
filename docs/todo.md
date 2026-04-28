# TODO

Backlog of follow-ups that aren't urgent enough to plan and execute now, but should not be lost.

## MCP admin token bridge (defense-in-depth)

**Problem.** The MCP container currently writes to the SQLite DB directly for two things:
1. `goose` migrations on startup (`store.New` in `cmd/mcptool/main.go`)
2. The loopback admin API that manages `api_tokens` (`internal/mcp/admin.go`)

This is why the data volume must be mounted `rw` (`docker-compose.yml`, `mcp-server` service). If the MCP process is ever compromised, the attacker has full write access to the entire DB — not just `api_tokens`.

**Proposed fix.** Mirror the existing audit-event bridge (`internal/mcp/audit.go`, HMAC-signed POST to the bot at `MCP_AUDIT_ENDPOINT` with `MCP_AUDIT_SECRET`) and have the MCP admin handlers call the main server instead of writing locally. The MCP container then mounts the DB volume `:ro`.

**Sketch.**
- Main server (`internal/server/`): add HMAC-protected endpoints
  - `POST   /api/mcp/admin/tokens`         → `store.CreateAPIToken`
  - `GET    /api/mcp/admin/tokens`         → `store.ListAPITokens`
  - `DELETE /api/mcp/admin/tokens/{id}`    → `store.DeleteAPIToken`
  - Reuse the same `X-Signature` HMAC scheme as `/api/mcp-audit`. Reuse `MCP_AUDIT_SECRET` or introduce a separate `MCP_ADMIN_BRIDGE_SECRET` (separate is cleaner — different blast radius).
- MCP server (`internal/mcp/admin.go`): replace `AdminStore` with an HTTP client that signs and POSTs to the bot. Drop the `store` parameter from `NewAdminHandler`.
- Migrations: move `goose.Up` out of `mcptool` entirely. The bot already runs migrations on startup, so the MCP container just needs to wait for the schema (or fail fast and rely on `restart: unless-stopped`). Add a depends_on / healthcheck if needed.
- Compose: change `medtracker_data:/app/data` back to `:ro` for the `mcp-server` service.
- Docs: update `docs/mcp-deployment.md` (the "Must be writable" note becomes obsolete).

**Tradeoffs.**
- Pros: MCP becomes truly read-only at the filesystem layer; defense-in-depth if the MCP HTTP surface is ever exploited; clearer separation of concerns.
- Cons: more moving parts (extra HMAC endpoints, migration ordering between containers, an extra failure mode where the bot is down and admin token CRUD breaks).

**When this matters.** Mostly hardening — there's no observed exploit. Worth doing if/when the MCP server gains more attack surface (broader tool access, third-party tools, etc.) or if a security review flags the shared-rw volume.
