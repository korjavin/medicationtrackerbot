# Cloud C4 PoC — Tier 2 remote MCP endpoint (hosted shim) + connect UX

## Overview

The C4 PoC (PR #426) shipped Tier 1: a local stdio shim for Claude Code/Desktop. The user wants Tier 2 from the cloud-mode MCP design: an **internet-accessible streamable-HTTP MCP endpoint on the cloud server** that hosted clients (claude.ai web custom connectors, ChatGPT connectors) can use directly — the server proxies MCP traffic to the user's unlocked browser tab over the existing blind relay.

**This is the design doc's "hosted-relay convenience mode": an explicit, per-account, consented zero-knowledge downgrade for MCP traffic.** The server terminates the client's plain MCP connection, so it sees requests and responses (health data in results) in transit — never stored. Vault data at rest stays E2EE. Enable is off by default behind honest warning text; the consent act is literal — the client hands the server the pairing key, which the server keeps (persisted, for set-and-forget) until Disconnect.

**Architecture in one line: the server runs the shim itself.** `internal/mcpshim.Client` already does dial/seal/correlate against the relay (`client.go:31,43,52`); the browser responder and relay stay byte-identical. New code is only: a consent endpoint that receives a pairing code, a hosted shim client per enabled account, a streamable-HTTP MCP handler, and UI.

Also folds in the Connect-Claude discoverability gap (supersedes `2026-07-06-cloud-c4-poc-connect-claude-ux.md`, deleted in this commit): a Settings entry point, real on-screen instructions, and a user-facing doc — with the **remote connector as the primary path** and the local shim kept as the Claude Code alternative.

## Context (from discovery)

- `internal/mcpshim`: `NewClient(code)` / `NewClientFromPairingWithOptions(pc, dialOpts)` / `Call(ctx, method, params) (json.RawMessage, error)` — directly reusable server-side. Pairing code carries `{RelayURL, PairingID, Key}` (`pairingcode.go:24`); the hosted client can dial its own relay via the public URL from the code (simplest; loopback optimization not worth it for a PoC).
- Streamable HTTP pattern in-repo: `mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {...})` at `internal/mcp/mcp.go:942` (go-sdk already in go.mod).
- Tool surface to mirror: `cmd/mcpshim/main.go` — `mcp_help` + `mcp_call {op, params}`, with the `toolDescriptionSuffix` explaining the E2E/device-online architecture; responder wire contract is `web/cloud/js/mcp-responder.js`'s dispatcher.
- Pairing lifecycle client-side: `web/cloud/js/mcp-pairing.js` mints the pairing + key and stores the `mcppairing` singleton vault record; any unlocked tab auto-starts the responder (`cloud-boot.js:117-122`). UI entry: `/devices` page, `web/cloud/js/devices.js` (`Connect Claude` button `:56`, status `:75`, one-time code screen `renderClaudeCode:95`).
- Relay: `internal/cloudserver/mcp_relay.go` — in-memory pairing table, single pairing per account (PoC ceiling). Consequence: **remote and local-shim modes are mutually exclusive per account** in this PoC (the hosted shim occupies the account's one pairing). Acceptable; note in UI.
- Settings seam for the entry-point row: cloud-only-row gate at `web/static/js/features/settings.js:94-99` (`.wg-settings-cloud-devices` pattern).
- Host routing: account subdomains already route `/api/*` + shell pages in `internal/cloudserver`; the MCP endpoint mounts on the account host.
- claude.ai custom connectors accept a bare remote MCP URL (no OAuth required); ChatGPT connectors likewise support no-auth MCP in developer mode. PoC auth = **capability URL** with a short human-typeable token (user decision 2026-07-06: the URL gets typed across devices into claude.ai/ChatGPT, so typeability wins; the entropy loss is compensated by a per-account failed-attempt throttle — see Development Approach). OAuth 2.1 + DCR is full-C4 scope.

## Development Approach

- **CRITICAL: relay, responder, crypto, and `cmd/mcpshim` are untouched.** Tier 1 keeps working; Tier 2 is additive.
- **CRITICAL: consent is explicit and honest.** Enabling remote mode shows exactly what changes ("the server can read what Claude asks and what it answers while relaying — nothing is stored"). Off by default; one click to revoke; revoke kills the hosted client and invalidates the URL immediately.
- **CRITICAL: the token is short, so the throttle IS the security.** Token = 6 lowercase Crockford-base32 chars rendered `xxx-xxx` (~30 bits; hyphen stripped on check). Brute-forceable only if attempts are unlimited, so a **per-account failed-token throttle is mandatory, not optional**: cap failed attempts (e.g. 100/min per account, then 429 with backoff). Only failures count — valid-token traffic is never affected by it. At that cap, the expected 2^29 guesses take decades; combined with the ≥48-bit subdomain, internet-wide scanning stays hopeless. Constant-time compare, shown once with the URL, never logged (mind Traefik access logs — the token travels in the path; docs task notes the access-log caveat like docs/sse-traefik.md does for initData). Re-enable rotates it.
- **CRITICAL: set-up-once-and-forget (user decision 2026-07-06).** Remote enablement is **persisted** in cloudstore — the token survives deploys/restarts/crashes and changes ONLY on explicit Disconnect/re-enable. On startup the server restores each enablement: re-registers the pairing with the relay (its table is in-memory) and restarts the hosted shim client; unlocked tabs reconnect on their own (PR #432 reconnect logic). Honest consequence, stated in the consent text and leakage table: the pairing key now sits **at rest** in the server DB, not just in memory — a modest increment over Tier 2's in-transit visibility, but it must be said plainly.
- Per-token rate limiting on successful-auth MCP calls too (reuse the demo-mode per-IP limiter pattern, keyed by token) — hosted clients can retry-storm.
- No new frontend globals beyond what the devices page already owns; secrets rendered `textContent`-only (existing rule in `devices.js` — the page holds the DEK).

## Testing Strategy

- **Integration (Go, httptest)**: consent endpoint requires session; enable → MCP initialize + `mcp_call` round-trips through a fake in-process responder (reuse the existing relay integration-test harness from the C4 PoC); wrong/revoked token → 404 without body distinguishing existence; no-device-online → the clear offline error passes through to the MCP client; disable → connection refused and hosted client torn down.
- **Integration (Vitest)**: devices page — mode picker renders, consent warning must be acknowledged before enable, URL + instructions render with the real token, disconnect resets state; Settings row cloud-only.
- **E2E**: manual rig walkthrough (Post-Completion) — the PoC's real acceptance.

## Progress Tracking

- `[ ]` not started · `[x]` done · ➕ added during implementation · ⚠️ deviation, explain inline

## Implementation Steps

### Task 1: Consent + persistent hosted-shim registry in cloudserver

- [x] cloudstore migration (take the **next contiguous number at merge time** — parallel-branch numbering hazard, see goose lesson): `mcp_remote(account_id PK, token, pairing_id, pairing_key, created_at)`; repo methods `UpsertMCPRemote` / `GetMCPRemote` / `DeleteMCPRemote` / `ListMCPRemote`. ⚠️ deviation: added a `relay_url` column (not in the original list) — `mcpshim.PairingCode` needs `{RelayURL, PairingID, Key}` to redial on restore, and storing it verbatim avoids inventing an `AccountByID`-plus-baseDomain reconstruction just to get the same value back.
- [x] `internal/cloudserver/mcp_remote.go`: runtime registry `accountID → {token, *mcpshim.Client}` hydrated from the table on startup — for each row, re-register the pairing with the relay (in-memory table, via new `MCPRelayAPI.RestorePairing`) and start the hosted shim client. Restore failures log and skip, never block boot. ⚠️ deviation: dropped the `cancel` field from the registry entry — `mcpshim.Client.Close()` (new, additive) fully tears down the one connection a Client owns, so a separate cancellation hook has no current use.
- [x] `POST /api/mcp/remote` (RequireSession): body `{pairing_code}`; parses via `mcpshim.ParsePairingCode`, mints the 6-char human token (`xxx-xxx`, Crockford base32 lowercase, no ambiguous chars), persists the row, starts the hosted shim client (dial the relay URL from the code), returns `{token}`. Re-enable replaces the row and rotates the token — **the ONLY events that change the token are this and DELETE**; deploys/restarts never do.
- [x] `DELETE /api/mcp/remote` (RequireSession): tears down the client, deletes the row, invalidates the token.
- [x] `GET /api/mcp/remote` (RequireSession): `{enabled: bool}` for UI state (never returns the token again).
- [x] Test: enable/disable/status lifecycle, session required, re-enable rotates token, and **restart-restore** — rebuild the registry from the store and assert the same token still authenticates. See `internal/cloudserver/mcp_remote_test.go`.

### Task 2: Streamable-HTTP MCP endpoint

- [x] Mount `/{mcp}/{token}` on the account host: `mcp.NewStreamableHTTPHandler` (pattern: `internal/mcp/mcp.go:942`) resolving the account from `Host` + token from the path (hyphen-insensitive); constant-time token check; unknown → 404; **per-account failed-token throttle** (see Development Approach) enforced before the compare result is revealed. ⚠️ deviation: mounted via a new `Handler.SetMCPHandler` setter (called once from `cmd/cloud/main.go`) rather than a `New()` constructor param — `router.New()` already has dozens of call sites across the test suite, and `*MCPRemoteAPI` (which owns the endpoint) is itself built from the store *after* `New()` returns in `main.go`'s existing wiring order; a two-step wire (build router, then attach the MCP handler) avoids a constructor-time cycle and every existing test signature. ⚠️ deviation: disabled the SDK's `DisableLocalhostProtection` DNS-rebinding guard on this endpoint — it only recognizes an exact `"localhost"` Host as loopback-safe, so it 403s cloud mode's own documented `CLOUD_BASE_DOMAIN=localhost` local-dev setup (every account subdomain is `"<sub>.localhost"`, never exactly `"localhost"`); the token check is this endpoint's real auth boundary, making the guard both redundant and a false positive here. ⚠️ deviation: added a small `dialOpts *websocket.DialOptions` test seam on `*MCPRemoteAPI` (same package, set directly by tests, mirrors `mcpshim.NewClientFromPairingWithOptions`'s existing test hook) — needed so tests can force the hosted shim client's dial through an httptest server's real listener while its pairing code still carries the account's virtual host, the same override `mcp_shim_integration_test.go`'s `shimRelayHarness` already relies on for Tier 1.
- [x] MCP server exposes `mcp_help` + `mcp_call` mirroring `cmd/mcpshim/main.go` (same input shapes, same responder wire contract), with the description suffix reworded for the hosted context: end-to-end encrypted server↔device via the relay, *this endpoint* sees traffic in transit by user consent, clear offline error when no tab is unlocked. See `internal/cloudserver/mcp_endpoint.go`.
- [x] Per-token rate limit; requests against a live hosted client `Call()`; shim errors (incl. offline-device) map to MCP tool errors, not 5xx. Mirrors `cmd/mcpshim/main.go`'s `(nil, nil, err)` return, which the SDK turns into an `isError` tool result rather than an HTTP failure.
- [x] Test: full initialize + tools/list + tools/call over httptest against a fake responder; bad token; failed-attempt throttle kicks in without affecting valid-token traffic; offline error text. See `internal/cloudserver/mcp_endpoint_test.go`.

### Task 3: Devices-page UI — two connector modes, remote primary

- [x] Rework the Connect Claude area in `web/cloud/js/devices.js` into a mode picker:
  - **Remote connector (claude.ai, ChatGPT) — primary.** Enable → consent dialog with the honest downgrade text → mints a pairing (`mcp-pairing.js`, unchanged), POSTs the pairing code to `/api/mcp/remote`, shows once: the connector URL `https://<subdomain>.app.<domain>/mcp/<token>` + copy button + numbered instructions (claude.ai: Settings → Connectors → Add custom connector → paste URL; ChatGPT: Settings → Connectors → Add MCP). Caveats block: keep an unlocked tab open; the URL is stable until you Disconnect (survives server updates); the server holds the connector key and sees MCP traffic in transit. ⚠️ deviation: new `web/cloud/js/mcp-remote.js` module holds `connectRemote`/`disconnectRemote`/`getRemoteStatus` (thin fetch wrappers around `/api/mcp/remote` that reuse `mcp-pairing.js`'s `connectClaude`/`disconnectClaude` for the underlying pairing) rather than inlining fetch calls into `devices.js` — mirrors the existing `mcp-pairing.js` split and keeps `devices.js` to rendering/wiring.
  - **Local shim (Claude Code) — alternative.** The existing pairing-code flow (`renderClaudeCode`), plus the `claude mcp add medtracker -e MEDTRACKER_MCP_CODE=<code> -- /path/to/mcpshim` one-liner with the real code (unchanged from Tier 1).
  - Modes are mutually exclusive (single pairing per account — say so inline); switching disconnects the other — connecting local while remote is enabled calls `disconnectRemote` first.
- [x] Status line covers both modes (`Claude connector: not connected` / `local shim (Claude Code) linked` / `remote (claude.ai / ChatGPT) linked`); Disconnect calls `DELETE /api/mcp/remote` (remote mode) or the existing pairing DELETE (local mode) and clears the `mcppairing` record either way.
- [x] Test: consent gate, URL render, mode exclusivity, disconnect. See `web/cloud/js/tests/devices.test.js` and `web/cloud/js/tests/mcp-remote.test.js`.

### Task 4: Settings entry point

- [x] Cloud-only "Claude connector" row on the Settings screen next to the Devices row (gate pattern `settings.js:94-99`), linking to `/devices`. Subtitle: "Use your data from claude.ai or ChatGPT — with consent".
- [x] Test: row visible only when `window.__MEDTRACKER_CLOUD__`.

### Task 5: [Final] Docs

- [ ] `docs/cloud-mode.md` MCP section: mark Tier 2 PoC implemented; "Connecting claude.ai / ChatGPT" how-to (enable, consent meaning, URL, caveats, revoke); add the leakage-summary row (opt-in only: MCP requests/responses visible to server in transit; pairing key stored at rest server-side while enabled); token-in-path access-log caveat (cf. docs/sse-traefik.md).
- [ ] `docs/features.md`: Claude-connector entry covering both modes.
- [ ] Delete `docs/plans/2026-07-06-cloud-c4-poc-connect-claude-ux.md` (superseded by this plan) — done in this plan's commit.

### Task: Verify acceptance criteria

- [ ] `go test ./...` + `pnpm test` green; `go list -deps ./internal/cloudserver` still free of `internal/store` (goose-registry landmine).
- [ ] Manual rig: enable remote mode → add the URL as a claude.ai custom connector → "what BP readings do I have?" returns vault data; add a reading and see it in the PWA; close the tab → clean offline error in claude.ai; Disconnect → connector fails; ChatGPT connector if plan/tier allows.

## Post-Completion

Feeds the C4 exit review together with Tier 1: latency through the double hop (client → cloud → relay → tab), tab-lifecycle pain, consent-UX clarity. Full-C4 items deliberately out of scope: OAuth 2.1 + dynamic client registration (replaces the capability URL), persistent **local-shim** pairings across restarts (remote enablement IS persisted in this plan), multi-pairing (remote + local simultaneously), generated catalog, packaged shim binary, QR pairing.
