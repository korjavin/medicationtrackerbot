# Long-lived API Tokens for MCP Server

## Overview

Add a simple long-lived API token mechanism to the MCP server so consumers that can't use the Pocket-ID OIDC flow can authenticate with a static bearer token. Tokens are managed via a small admin HTTP API exposed on a loopback-only listener (no auth on the management API itself; protection comes from binding to 127.0.0.1). Tokens never expire — they're valid until deleted. This is an experiment, intentionally minimal.

## Context

- Files involved:
  - Modify: `internal/store/store.go` (add api_tokens CRUD)
  - Modify: `internal/mcp/oauth.go` (bypass JWT validation when Authorization header carries an API token)
  - Modify: `internal/mcp/mcp.go` (start a second HTTP listener for the admin API; add Config fields)
  - Modify: `cmd/mcptool/main.go` (only if logging needs the new config fields surfaced)
  - Modify: `docs/environment.md`, `docs/mcp-deployment.md` (document new env vars + admin API)
  - Create: `internal/store/migrations/055_add_api_tokens.sql`
  - Create: `internal/mcp/admin.go` (admin HTTP handlers — list/create/delete tokens)
  - Create: `internal/mcp/admin_test.go`
  - Create: `internal/mcp/oauth_apitoken_test.go` (or add to oauth_test.go if it exists)
- Related patterns:
  - Migration numbering: next is 055 (current latest is 054_add_diary_notes_tag.sql)
  - Store method pattern: methods on `*Store` using `s.db.ExecContext` / `QueryRowContext`
  - Push-subscriptions table (014) is the closest analogue: id, user_id, secret, created_at, updated_at, indexes
  - Existing OAuth middleware sets `UserSubjectCtxKey` on the request context — API tokens must do the same so downstream handlers don't need to know the difference
- Dependencies: none new; uses `crypto/rand`, `crypto/sha256`, `encoding/hex` from stdlib

## Development Approach

- **Testing approach**: Regular (code first, then tests). Uses table-driven Go tests with httptest for handlers and an in-memory SQLite store for store tests (existing pattern).
- Token format: prefix `mcp_` + 32 random bytes hex-encoded → 68 chars total. Plaintext is returned ONCE at creation; only `sha256(token)` is stored. Lookup is by hash.
- Admin API has no authentication of its own. The listener is bound to `127.0.0.1:MCP_ADMIN_PORT` (default 8082). Reverse proxies cannot reach a loopback-bound socket, so localhost is enforced by the OS, not by request inspection (no X-Forwarded-For pitfalls).
- The MCP `/mcp` endpoint OAuth middleware is extended: if `Authorization: Bearer` value starts with `mcp_`, look it up in `api_tokens`; on hit, treat as authorized (set `UserSubjectCtxKey` to `"api-token:" + token name`) and update `last_used_at`; on miss, fall through to JWT validation.
- Complete each task fully before moving to the next.
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Add api_tokens table migration and Store methods

**Files:**
- Create: `internal/store/migrations/055_add_api_tokens.sql`
- Modify: `internal/store/store.go`
- Create: `internal/store/api_tokens_test.go`

- [x] Write migration 055: `CREATE TABLE api_tokens(id INTEGER PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at DATETIME);` plus `CREATE INDEX idx_api_tokens_token_hash ON api_tokens(token_hash);`. Include goose `-- +goose Up` / `-- +goose Down` sections.
- [x] Add `APIToken` struct (`ID int64`, `Name string`, `CreatedAt time.Time`, `LastUsedAt sql.NullTime`) — no `token_hash` field exposed in reads.
- [x] Add `CreateAPIToken(ctx, name, tokenHash string) (int64, error)` — INSERT, return id.
- [x] Add `ListAPITokens(ctx) ([]APIToken, error)` — SELECT id,name,created_at,last_used_at ORDER BY id.
- [x] Add `DeleteAPIToken(ctx, id int64) error` — DELETE; return error if `RowsAffected == 0` (so admin API can return 404).
- [x] Add `FindAPITokenByHash(ctx, hash string) (*APIToken, error)` — SELECT by token_hash; returns `nil, nil` on no rows.
- [x] Add `TouchAPITokenLastUsed(ctx, id int64) error` — UPDATE `last_used_at = CURRENT_TIMESTAMP`.
- [x] Write `internal/store/api_tokens_test.go` covering create/list/delete/find/touch and uniqueness violation on duplicate hash.
- [x] Run `go test ./internal/store/...`

### Task 2: Extend OAuth middleware to accept API tokens

**Files:**
- Modify: `internal/mcp/oauth.go`
- Create: `internal/mcp/oauth_apitoken_test.go`

- [x] Add `APITokenStore` interface to `oauth.go`: `FindAPITokenByHash` + `TouchAPITokenLastUsed` (so tests can inject a fake; `*store.Store` will satisfy it).
- [x] Plumb the store into `OAuthHandler`: extend `NewOAuthHandler` to accept it; update `mcp.NewServer` accordingly.
- [x] In Middleware, after parsing the Bearer value: if it starts with `"mcp_"`, compute sha256 hex, call `FindAPITokenByHash`. On hit: `TouchAPITokenLastUsed` (best-effort, log on error), set `UserSubjectCtxKey = "api-token:" + token.Name`, log `slog.Info("[MCP/OAuth] API token authorized", "token_name", token.Name)`, call next. On miss: send 401.
- [x] If the value does NOT start with `"mcp_"`, fall through to existing JWT validation path unchanged.
- [x] Add constant for the token prefix (`"mcp_"`) at top of `oauth.go`.
- [x] Write `oauth_apitoken_test.go` with table-driven cases: valid token → 200, unknown token (`mcp_` prefix but no DB row) → 401, malformed token → 401, JWT path still works (with stub validator if needed — or just verify `mcp_` prefix is preferred over JWT branch).
- [x] Run `go test ./internal/mcp/...`

### Task 3: Admin HTTP API on a loopback-only listener

**Files:**
- Modify: `internal/mcp/mcp.go` (add `AdminPort` to `Config` and `LoadConfigFromEnv`; spawn a second `http.Server` in `Run`)
- Create: `internal/mcp/admin.go`
- Create: `internal/mcp/admin_test.go`

- [ ] Add `Config.AdminPort` (int) and load `MCP_ADMIN_PORT` in `LoadConfigFromEnv` (default 8082; 0 means disabled).
- [ ] Add `AdminStore` interface in `admin.go`: `CreateAPIToken`, `ListAPITokens`, `DeleteAPIToken` (mirrors what handlers need).
- [ ] Implement `AdminHandler` with three routes:
  - `POST /admin/tokens` — body `{"name":"..."}`; generate plaintext token (prefix + `crypto/rand` 32 bytes hex); insert sha256 hash; respond `{"id":N,"name":"...","token":"mcp_..."}` (plaintext returned ONCE).
  - `GET  /admin/tokens` — return `[{"id","name","created_at","last_used_at"}, ...]`.
  - `DELETE /admin/tokens/{id}` — return 204 on success, 404 on missing id.
- [ ] All responses `application/json`; use `http.StatusBadRequest` for empty/missing name; reject names > 100 chars; validate id is integer.
- [ ] In `Server.Run`, if `cfg.AdminPort > 0` start a second `http.Server` bound to `fmt.Sprintf("127.0.0.1:%d", cfg.AdminPort)` with the AdminHandler mux. Goroutine + same graceful-shutdown signal handling as the main server.
- [ ] Log `slog.Info("[MCP/Admin] Admin API listening", "addr", "127.0.0.1:...")` on startup.
- [ ] Write `admin_test.go` covering create (verifies token starts with `mcp_`, length, hash stored matches), list (after creating two), delete (success + 404), bad input (empty name, name too long, non-integer id).
- [ ] Run `go test ./internal/mcp/...`

### Task 4: End-to-end verification and docs

**Files:**
- Modify: `docs/environment.md` (add `MCP_ADMIN_PORT`)
- Modify: `docs/mcp-deployment.md` (new "Long-lived API tokens" subsection)
- Modify: `README.md` only if it lists MCP env vars

- [ ] Add `MCP_ADMIN_PORT` to `docs/environment.md` with default 8082, note loopback-only binding.
- [ ] In `docs/mcp-deployment.md`, add a subsection showing curl examples: POST to create, GET to list, DELETE to revoke; warn that the response contains the plaintext token only once; warn this endpoint MUST NOT be exposed beyond localhost (do not proxy it).
- [ ] Build the binary: `go build ./cmd/mcptool` — confirm it compiles.
- [ ] Run `go test ./...` — full suite must pass.
- [ ] Run `go vet ./...` and `gofmt -l .` (no output expected).

### Task 5: Move plan to completed

- [ ] Move `docs/plans/2026-04-28-mcp-api-tokens.md` to `docs/plans/completed/`

## Post-completion (manual)

- Verify in a deployed environment that `curl http://127.0.0.1:8082/admin/tokens` works from the host but is unreachable through the public reverse proxy.
- Confirm the consumer that triggered this work can authenticate to `/mcp` using `Authorization: Bearer mcp_<token>`.
