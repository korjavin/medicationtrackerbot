# ElevenLabs voice agent: dynamic MCP via SDK client tools

## Overview

Replace the manual ElevenLabs dashboard MCP server configuration with **dynamic client tools** registered at call start. Today the user has to: (1) generate a long-lived `mcp_*` API token via the loopback admin endpoint, (2) configure their ElevenLabs agent's MCP server URL + token in the dashboard, (3) keep that config in sync with the codebase. After this change: the user taps "Call agent", the frontend mints a short-lived (15-min) session token, fetches the existing MCP server URL, and registers `mcp_help` + `mcp_execute` as ElevenLabs SDK client tools before `startSession`. The cloud agent receives the tool definitions as part of the session init payload, calls them like any other tool, and the SDK routes each call back to the MCP server with the session token. No dashboard config, no long-lived token in ElevenLabs' systems, no drift between code and configuration.

Scope is intentionally narrow: only `mcp_help` and `mcp_execute` (the two-tool design that already works for the user). The granular legacy tools (`get_blood_pressure`, `log_workout`, etc.) are not part of this plan — they remain reachable via `mcp_execute` scripts as today. This keeps the client-tool surface stable (two tools, both with stable schemas) so the JS adapter doesn't need to enumerate the registry at runtime.

The end state is a single voice agent code path: the user deletes the ElevenLabs dashboard MCP server config as a manual cleanup step at the end, and all future tool changes flow through code only.

## Context (from discovery)

**Files/components involved:**
- `internal/store/auth/repo.go` — `api_tokens` table CRUD. Schema today: `id, name, token_hash, created_at, last_used_at`. No expiry column. Need to add `expires_at` (nullable) to support short-lived tokens.
- `internal/mcp/admin.go:84,179` — `generateAPIToken()` produces `mcp_<32 hex bytes>` plaintext. Loopback-only admin port creates tokens. The new bot-side endpoint will reuse this generator (or a renamed copy in `internal/server/`) for parity.
- `internal/mcp/oauth.go` — middleware that validates Pocket-ID JWT or hashes-and-looks-up the Bearer token. After the schema change, this middleware must reject tokens whose `expires_at` is in the past.
- `internal/mcp/mcp.go:714-746` — MCP server's two HTTP transports (`/mcp` Streamable HTTP, `/sse` SSE). Both go through `oauth.Middleware`. CORS is currently not configured for browser-origin calls; needs an allow-origin response for `APP_DOMAIN`.
- `internal/mcp/mcp.go:230-260` — definitions of `mcp_help` and `mcp_execute` MCP tools with their descriptions and schemas. The client-tool schemas in the frontend must mirror these.
- `internal/mcp/help.go`, `internal/mcp/execute.go` — actual handler implementations. **Not touched by this plan** — they continue serving the MCP protocol unchanged.
- `internal/server/elevenlabs_handlers.go` — `handleElevenLabsSignedURL` (line 34) and `handleElevenLabsUploadFile` (line 101). New session-token mint endpoint sits alongside these.
- `web/static/js/features/elevenlabs-call.js` — frontend Convai integration. Loads `@elevenlabs/client` ESM SDK, manages conversation state. Currently calls `startSession()` without `clientTools`. The change is additive: pass a `clientTools` object with `mcp_help` + `mcp_execute` callbacks.
- `internal/server/server.go` — route registration. New endpoint needs MCP coverage registration or exempt entry per [docs/mcp-coverage.md](../mcp-coverage.md).

**Related patterns found:**
- `used_login_hashes` table (`internal/store/auth/repo.go:142-145`) already uses `expires_at` with sweep-on-write pattern (`DELETE WHERE expires_at < now()` before insert). We mirror this for the api_tokens cleanup path.
- ElevenLabs signed-URL handler at `internal/server/elevenlabs_handlers.go:34` returns 503 when `ELEVENLABS_API_KEY`/`ELEVENLABS_AGENT_ID` env vars are unset. The new session-token endpoint follows the same "503 when not configured" pattern.
- `MCP_SERVER_URL` env var already points at the public MCP base. Frontend fetches this from the same bootstrap path the rest of the app uses.

**Dependencies identified:**
- No new Go modules. No new npm packages — `@elevenlabs/client` is already loaded.
- Goose migration to add `expires_at INTEGER` (unix seconds, NULL for unlimited) to `api_tokens`.
- CORS: simple response header tweak on MCP server's `/mcp` and `/sse` handlers (and OPTIONS preflight handler). Limited to `APP_DOMAIN` origin and Authorization/Content-Type request headers.

## Development Approach

- **Testing approach**: Regular (code first, then tests). Matches repo convention.
- Complete each task fully before moving to the next.
- Make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task.
- **CRITICAL: all tests must pass before starting next task** — `go test ./...` and `pnpm test` (where applicable).
- **CRITICAL: update this plan file when scope changes during implementation.**
- Run tests after each change.
- Maintain backward compatibility — the long-lived token path (Task 1 schema change is additive; NULL `expires_at` means no expiry) keeps working unchanged. Users with existing dashboard-configured agents see no regression until they choose to delete the dashboard config.

## Testing Strategy

- **Unit tests**: Go `testing` for new auth methods, the session-token endpoint, the CORS middleware, and the expiry check in the OAuth middleware.
- **Integration tests**: HTTP handler tests for the new endpoint and end-to-end CORS preflight + actual request flow against the MCP server (using `httptest`).
- **Frontend tests**: Vitest integration test in the existing elevenlabs feature suite (or `tests/elevenlabs.client-tools.test.js`) covering: (a) client tools are registered with the correct schemas at `startSession`, (b) callback invocations POST to the MCP server with the session token, (c) error paths surface to the UI.
- **MCP coverage guard**: the new mint endpoint must be either registered in the operation registry or added to `mcpCoverageExempt` with a `Reason` per CLAUDE.md.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with `➕` prefix.
- Document issues/blockers with `⚠️` prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): Go schema + endpoint + CORS + frontend client tools + tests + docs.
- **Post-Completion** (no checkboxes): manual verification of a real ElevenLabs call against a deployed instance, then deleting the dashboard MCP server config.

## Implementation Steps

### Task 1: Add `expires_at` to `api_tokens` and teach the auth path to honor it
- [x] add goose migration in `internal/store/migrations/` introducing `expires_at INTEGER` column on `api_tokens` (unix seconds UTC, NULL = unlimited). Per CLAUDE.md, this is a timestamp column that participates in equality comparisons, so it must be `INTEGER` unix-seconds-UTC per the dose-time-columns convention — append to the allowlist in `internal/store/store_time_invariants_test.go` and to the package comment in `internal/store/store.go`.
- [x] add `CreateTokenWithExpiry(ctx, name, tokenHash, expiresAt *time.Time) (int64, error)` to `internal/store/auth/repo.go`. Keep the existing `CreateToken` as a thin wrapper passing `nil` for expiry (back-compat).
- [x] update `GetTokenByHash` in `internal/store/auth/repo.go:114` to filter out expired tokens: add `AND (expires_at IS NULL OR expires_at > ?)` with the current unix timestamp.
- [x] add a periodic-sweep helper `DeleteExpiredTokens(ctx) (int64, error)` for hygiene. Wire into the existing periodic job runner if there is one, or call opportunistically from `CreateTokenWithExpiry` (mirror the `used_login_hashes` pattern at `repo.go:143`).
- [x] write tests for `CreateTokenWithExpiry`: unlimited (nil expiry), future expiry (valid), past expiry (rejected by GetTokenByHash even though row exists).
- [x] write tests for `GetTokenByHash`: with expiry past → not found, with expiry future → found, with expiry NULL → found.
- [x] write a test for `DeleteExpiredTokens`: inserts mixed expired/unexpired/null rows, asserts only expired ones are removed.
- [x] run `go test ./...` — must pass before Task 2.

### Task 2: Add `POST /api/elevenlabs/mcp-session-token` mint endpoint
- [x] add handler `handleElevenLabsMCPSessionToken` in `internal/server/elevenlabs_handlers.go`. Behavior:
  - require an authenticated user session (use the same auth check the other `/api/...` routes use)
  - return 503 if `ELEVENLABS_API_KEY`/`ELEVENLABS_AGENT_ID` are unset (consistent with `handleElevenLabsSignedURL`)
  - generate a plaintext token via the same generator as `internal/mcp/admin.go:179` (extract to a shared helper in `internal/store/auth/` if not already exposed — `auth.GeneratePlaintextToken()` is a reasonable home)
  - hash, persist with `name = "elevenlabs-voice-session"` and `expires_at = now() + 15min`
  - return JSON `{ "token": "<plaintext>", "mcp_server_url": "<MCP_SERVER_URL>", "expires_at": <unix_seconds> }`
- [x] register the route on the bot's `apiMux`. Add an entry to `internal/server/mcp_coverage_exempt.go` with `Reason: "voice session bootstrap; mints short-lived MCP token for SDK client tool callbacks"` — this is exempt because it's transport/auth plumbing, not a domain action.
- [x] no inline `os.Getenv` reads — use the same env-config pattern the existing ElevenLabs handlers use (will be `*Config`-injected once the local-mode-foundation plan's Task 1 lands; for now match the existing handler's pattern).
- [x] write tests in `internal/server/elevenlabs_handlers_test.go` (create if absent):
  - 503 when env unset (table-driven: missing API key, missing agent ID, missing both)
  - 401/403 when unauthenticated
  - 200 with expected JSON shape when authenticated and configured
  - token created in DB has correct name and expires_at within ~16 minutes
  - two successive calls produce different tokens (no caching)
- [x] run `go test ./...` — must pass before Task 3.

### Task 3: Add CORS to MCP server for `APP_DOMAIN` origin
- [ ] in `internal/mcp/mcp.go` (or a new `internal/mcp/cors.go`), add a small CORS middleware that wraps the `/mcp` and `/sse` handlers. Allowed origin = `APP_DOMAIN` env var (or `MCP_CORS_ORIGIN` override if you want it independent; keep it minimal and reuse `APP_DOMAIN`). Allowed methods: `GET, POST, OPTIONS`. Allowed headers: `Authorization, Content-Type, Mcp-Session-Id` (and any other headers the MCP protocol uses — check Streamable HTTP spec). Max-age 600. Credentials: false (token in Authorization header, not cookies).
- [ ] handle OPTIONS preflight in the new middleware — short-circuit with 204 + headers, do not pass to OAuth middleware.
- [ ] wire the CORS middleware in front of `oauth.Middleware` for both `/mcp` and `/sse` routes.
- [ ] update `docs/environment.md` to note `APP_DOMAIN` is now also read by the MCP server for CORS.
- [ ] write tests for the CORS middleware:
  - OPTIONS preflight with allowed origin → 204 + correct headers
  - OPTIONS preflight with disallowed origin → 403 or no allow headers
  - actual POST with allowed origin → headers present on response
  - empty `APP_DOMAIN` → CORS disabled (no allow headers, preflight passes through to handler 404 or method-not-allowed)
- [ ] write an integration test that hits `/mcp` with a real Bearer token (using `httptest`) and confirms both CORS headers and OAuth validation are in effect on the same response.
- [ ] run `go test ./...` — must pass before Task 4.

### Task 4: Frontend — register `mcp_help` + `mcp_execute` client tools at call start
- [ ] in `web/static/js/features/elevenlabs-call.js`, before the existing `startSession` call, fetch the new session token: `await apiCall('/api/elevenlabs/mcp-session-token', { method: 'POST' })`. Store `{token, mcp_server_url}` in the conversation context.
- [ ] define a `buildClientTools({token, mcpServerUrl})` helper (same file, or `web/static/js/features/elevenlabs-mcp-tools.js` if it crowds the file). Returns an object shaped for the SDK:
  ```js
  {
    mcp_help: {
      description: '...',  // copy from internal/mcp/mcp.go:234 (one source of truth — paste, don't re-author)
      parameters: {        // mirror schema from MCP server (topic? operation_id?)
        type: 'object',
        properties: {
          topic: { type: 'string', description: '...' },
          operation_id: { type: 'string', description: '...' }
        }
      },
      handler: async (args) => { /* POST to mcpServerUrl/mcp with JSON-RPC tools/call body */ }
    },
    mcp_execute: { /* same shape with code/mode/intent/topic_allowlist */ }
  }
  ```
- [ ] in each handler, build the JSON-RPC tools/call body: `{ jsonrpc: '2.0', id: <counter>, method: 'tools/call', params: { name: 'mcp_help', arguments: args } }`. POST to `${mcpServerUrl}/mcp` with `Authorization: Bearer <token>` and `Content-Type: application/json`. Parse the JSON-RPC response and return the `result` field (or throw on `error`). The ElevenLabs SDK expects a JSON-serializable return.
- [ ] pass `clientTools: buildClientTools({...})` into the `startSession` options. Verify by reading the `@elevenlabs/client` ESM build (the SDK already loaded) — option name is `clientTools` on the conversation init.
- [ ] handle token-expired errors during a long call: if a client-tool POST returns 401, refresh the session token via the mint endpoint and retry once. If still failing, surface a toast and end the call gracefully.
- [ ] write tests in `web/static/js/tests/elevenlabs.client-tools.test.js`:
  - mock the SDK's `Conversation.startSession`; assert it receives a `clientTools` object with `mcp_help` and `mcp_execute` keys
  - mock fetch; invoke each handler manually with sample args; assert the POST body shape and Authorization header
  - simulate a 401 response → assert one retry happens with a freshly-fetched token
  - simulate a JSON-RPC error response → assert the handler rejects
  - assert no inline `.style.` and no hardcoded colors are added to the UI (architecture test already enforces this, but if any UI is added in this task, it must comply)
- [ ] run `pnpm test` — must pass before Task 5.

### Task 5: Verify acceptance criteria
- [ ] verify `go test ./...` passes (covers Tasks 1–3).
- [ ] verify `pnpm test` passes (covers Task 4).
- [ ] verify the MCP coverage guard test passes (`TestMCPCoverage_AllRoutesEitherRegisteredOrExempt`) — new endpoint exempt entry is correct.
- [ ] verify the dose-time-columns invariant test passes — new `api_tokens.expires_at_unix` column (or `expires_at` if we keep the existing naming style of the table) appears in the allowlist.
- [ ] verify `golangci-lint run ./...` is clean.
- [ ] verify no inline styles or hardcoded colors in `web/static/js/features/elevenlabs-call.js` or any new frontend file (`tests/architecture.globals.test.js` and the design-token enforcement covers this).
- [ ] verify CORS preflight + actual POST flow end-to-end via the integration test from Task 3.
- [ ] verify the long-lived token path still works (regression check) — existing tokens with `expires_at IS NULL` validate normally.

### Task 6: [Final] Update documentation
- [ ] update `docs/environment.md` with a note that `APP_DOMAIN` is now also consumed by the MCP server for CORS allowance.
- [ ] update `docs/mcp-deployment.md` with a "Voice agent integration" subsection explaining the dynamic client-tools model, the new `/api/elevenlabs/mcp-session-token` endpoint, and the deprecation of the dashboard MCP server config.
- [ ] add a brief note in `docs/local-mode.md` under the ElevenLabs preservation discussion: confirm the dynamic client-tools approach is now implemented for server mode, and that it carries over to mobile-mode unchanged once the Capacitor wrapper is in place.
- [ ] update `docs/technical-decisions.md` with the choice of dynamic client tools over the dashboard MCP server config (no shared API token with ElevenLabs, code-as-source-of-truth, per-session scoping).
- [ ] no test changes.

*Note: ralphex automatically moves completed plans to `docs/plans/completed/`*

## Technical Details

**Token lifecycle:**
- User taps "Call agent" → frontend POSTs to `/api/elevenlabs/mcp-session-token` → bot mints `mcp_<random>` token, hashes it, inserts row with `name='elevenlabs-voice-session'`, `expires_at = now+15min`.
- Plaintext token returned once; never persisted. Lives in JS memory of the WebView/browser tab for the duration of the call.
- On call end (or after 15 min), token expires automatically. No explicit revoke step needed — the OAuth middleware's `expires_at` filter handles it. Background sweep removes the row eventually.
- If the user keeps a long call going past 15 min, the 401 retry path in the frontend refreshes the token and continues. Trade-off: brief tool-call latency hit on the boundary every ~15 min for marathon calls. Acceptable.

**JSON-RPC payload shape** (ElevenLabs client tool callback → MCP server):
```json
POST {MCP_SERVER_URL}/mcp
Authorization: Bearer mcp_<session_token>
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "mcp_help",
    "arguments": { "topic": "workouts" }
  }
}
```

Response is the standard MCP `CallToolResult` envelope; the frontend handler returns `result.content[0].text` (or the structured payload, depending on what the existing `mcp_help` returns) to the SDK.

**Auth precedence in the OAuth middleware** (post-Task 1):
1. If Bearer token present → hash → lookup in `api_tokens` → reject if expired → accept with subject `api-token:<name>`
2. Else if JWT present → validate via JWKS → accept with subject from `sub` claim
3. Else 401

The expiry check is the only behavioral change. Long-lived tokens (NULL `expires_at`) are unaffected.

**Why `clientTools` and not `conversationConfig.tools`:** ElevenLabs' SDK distinguishes between *static* tools (defined per-agent in the dashboard, including server-side webhooks and MCP server config) and *dynamic* tools passed at session start via `clientTools`. The latter execute in the SDK callback exclusively — they never round-trip through ElevenLabs' webhook system. This is what we want: the tool execution stays on the user's device/server, ElevenLabs cloud only sees tool names + schemas + call results.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only.*

**Manual verification:**
- Deploy the change to your real server. Open the app, tap "Call agent", and verify a voice conversation works end-to-end with the agent using `mcp_help` and `mcp_execute`. Try a read flow ("how was my BP this week?") and a write flow ("log my blood pressure as 120 over 80").
- Check the bot logs during the call to confirm `mcp_help` and `mcp_execute` tool calls arrive at the MCP server with valid short-lived tokens.
- Trigger a long call (>15 min if patient) to verify the token refresh path works without dropping the conversation.

**External system updates:**
- After confirming the new path works, log into your ElevenLabs agent dashboard and **delete the MCP server configuration** from the agent. The agent should now have no statically-configured MCP server. Make another call to verify the dynamic client tools still work (this proves the dashboard config was redundant).
- Optionally, revoke the long-lived `mcp_*` token that you previously gave to ElevenLabs via the admin port. With the dashboard config removed, that token is no longer needed.
- Update any team documentation or runbooks that previously described the dashboard-config setup steps.
