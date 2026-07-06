# Cloud voice PoC — ElevenLabs agent + dynamic MCP client-tools (browser-direct)

## Overview

Viability pillar #2 (bd med-rgc): get the ElevenLabs voice agent working in
**cloud mode**, feeding it **dynamic MCP tools** so the agent can answer
questions about the user's own health data. Even partial/buggy counts — the
question was feasibility, and the spike settled it: **yes, straight
browser-direct port.**

Two pieces:
1. **Entry-bug fix + browser-direct signed URL.** Today "Call Agent" in cloud
   fails with `Not found: GET /api/elevenlabs/signed-url` (bot mode mints the
   signed URL server-side to hide the operator key; cloud has no such route).
   In cloud we mint it **directly from the browser** with the user's own
   ElevenLabs key read from the vault — the BYO / C2c pattern.
2. **Dynamic MCP client-tools.** Register `mcp_help` + `mcp_call` as ElevenLabs
   SDK `clientTools` at `startSession`; their callbacks dispatch **straight into
   the in-tab MCP dispatcher** (the same catalog the remote connector uses) — no
   relay hop, no crypto, since the tab is both the voice client and the MCP
   responder host.

## Context (from spike, 2026-07-06 — all confirmed)

- **CORS = YES.** `GET https://api.elevenlabs.io/v1/convai/conversation/get_signed_url`
  returns `access-control-allow-origin: *` + `access-control-allow-headers: *`
  (verified via preflight). The browser can call it directly with the
  `xi-api-key` header. CSP already allows it: `connect-src … https://api.elevenlabs.io
  wss://api.elevenlabs.io` (`internal/server/server.go:724`; cloud router's
  account-app CSP is `connect-src 'self' https:`, `internal/cloudserver/router.go`).
- **SDK supports clientTools.** `@elevenlabs/client`
  `Conversation.startSession({ signedUrl, clientTools: { name: async (params) => …
  } })` — named async callbacks the agent invokes by name. The tool
  names/params must match the agent's ElevenLabs-dashboard config, and each tool
  must be marked **blocking** there so the agent awaits the return value.
- **Entry bug** — `web/static/js/features/elevenlabs-call.js` `fetchSignedURL()`
  (34-52): `apiCall('/api/elevenlabs/signed-url')` at :39 and a raw
  `fetch('/api/elevenlabs/signed-url')` at :43 (the :43 raw fetch bypasses the
  shim entirely). Return value is the ElevenLabs **WebSocket signed URL**,
  consumed in `startCall()` at :269/:277 (`Conversation.startSession({ signedUrl })`).
- **Vault key seam** — the `elevenlabs` integrations record already exists:
  `web/domain/settings.js:31` `DEFAULT_INTEGRATIONS.elevenlabs = { api_key,
  agent_id }`, `:38` `elevenlabs: new Set(['api_key'])`. Read browser-direct via
  `settingsDomain.readIntegrationsUnmasked()` (`web/domain/settings.js:250`) —
  the exact pattern in `web/cloud/js/aiclient.js:105` and `fooddb.js:77`. No
  migration.
- **In-tab MCP dispatcher** — `web/cloud/js/mcp-responder.js`: `CATALOG` (:19,
  6 ops: bp.list/create, weight.list/create, notes.list/create) +
  `createDispatcher({ bp, weight, notes })` (:147) returning `{ handle(method,
  params) }` (:160) answering `mcp_help` and `mcp_call({op,params})`. It is a
  plain in-process function — the relay WebSocket (`onFrame`, seal/open) is only
  for the *off-device* Claude connector. A `clientTools` callback can call
  `dispatcher.handle('mcp_call', {op, params})` directly in-tab.
- **Wiring seam** — `web/cloud/js/apishim.js` builds the bp/weight/notes domains
  and publishes cloud modules on `window` (`CloudFoodAI` :104, `CloudFoodSearch`
  :105); it's where a `CloudElevenLabs` client + a `CloudMCPDispatcher` get
  published from the same domain instances.
- **Guard pattern** — cloud features branch on `window.__MEDTRACKER_CLOUD__`
  (e.g. `web/static/js/features/food/log.js:683`) to swap the bot-mode server
  call for a browser-direct module.
- The old `docs/plans/2026-05-18-elevenlabs-dynamic-mcp-client-tools.md` is
  **bot-mode-only + unimplemented** (unmerged branch); it round-trips every tool
  call to a server-hosted MCP over HTTP — the opposite of this browser-direct
  cloud model. This plan supersedes it for cloud.

## Development Approach

- **Cloud-only, additive.** Bot mode's server signed-URL + agent-rate-limit is
  untouched; no `clientTools` in bot mode. Guard everything on
  `window.__MEDTRACKER_CLOUD__`.
- **BYO key, browser-direct — never proxy the key through the cloud server**
  (same rule as C2c food-DB/AI). The unmasked ElevenLabs key is read
  module-to-module from the vault and used only in the direct
  `api.elevenlabs.io` call; it never crosses `/api`.
- **Reuse the existing dispatcher and domain instances** — do not fork the MCP
  catalog or the crypto/relay. The voice path is the dispatcher minus the relay.
- No new frontend globals beyond the devices/cloud pattern; if a new `window.*`
  is added, allowlist it (`tests/architecture.globals.test.js`, CLAUDE.md rule 4).

## Testing Strategy

- Integration (Vitest, via `tests/helpers/frontend-harness.js`): (a) cloud-mode
  `fetchSignedURL` routes to the browser-direct client — mock `fetch` to
  `api.elevenlabs.io`, assert `xi-api-key` header + `agent_id` query from the
  vault record, returns `signed_url`; missing key/agent_id → clear error; (b) the
  registered `clientTools.mcp_call({op:'bp.list'})` dispatches into the real
  `createDispatcher` over an in-memory records port and returns wire-shaped JSON;
  `mcp_help` returns the catalog; (c) bot mode is unchanged (no `CloudElevenLabs`,
  still hits `apiCall`/`fetch`).
- The live voice conversation is **manual acceptance** (Post-Completion) — needs
  a real ElevenLabs agent + mic + the user's dashboard tool config.

## Progress Tracking

- `[ ]` not started · `[x]` done · ➕ added · ⚠️ deviation (explain inline)

## Implementation Steps

### Task 1: Browser-direct ElevenLabs signed URL + cloud entry-bug fix

- [ ] New `web/cloud/js/elevenlabs-signed-url.js`:
      `createElevenLabsClient({ settingsDomain })` exposing `async
      fetchSignedURL()` — reads `const { elevenlabs } = await
      settingsDomain.readIntegrationsUnmasked()`; throws a clear user-facing
      error if `elevenlabs.api_key` or `agent_id` is empty ("Set your ElevenLabs
      key and agent id in Settings → Integrations"); else `GET
      https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=<id>`
      with header `xi-api-key: <api_key>`, returns `data.signed_url`. Mirror
      `web/cloud/js/aiclient.js`.
- [ ] Publish it from `web/cloud/js/apishim.js` (e.g. `window.CloudElevenLabs =
      createElevenLabsClient({ settingsDomain: settings })`, alongside
      `CloudFoodAI` at :104).
- [ ] Guard at the TOP of `fetchSignedURL()` in
      `web/static/js/features/elevenlabs-call.js` (before the `:35` apiCall
      resolution): `if (window.__MEDTRACKER_CLOUD__) return
      window.CloudElevenLabs.fetchSignedURL();` — one branch covers both the :39
      apiCall and the :43 raw-fetch tails. Leave `startCall()`/`startSession`
      untouched; it just receives a browser-minted `signedUrl`.
- [ ] Integration test (a) above.

### Task 2: In-tab MCP dispatcher exposed for client-tools

- [ ] Publish a dispatcher from `web/cloud/js/apishim.js` built from the same
      domain instances it already constructs: `window.CloudMCPDispatcher =
      createDispatcher({ bp, weight, notes })` (import `createDispatcher` from
      `mcp-responder.js`). If a responder is already created in `cloud-boot.js`,
      reuse its `.dispatcher` instead of building a second one — pick the single
      cleanest seam and note it.
- [ ] Integration test (b): `CloudMCPDispatcher.handle('mcp_call', { op:
      'bp.list', params: {} })` returns wire-shaped JSON over an in-memory
      records port; `handle('mcp_help', {})` returns `{ catalog, usage_protocol }`.

### Task 3: Register dynamic MCP client-tools at startSession (cloud only)

- [ ] In `web/static/js/features/elevenlabs-call.js` `startCall()`, when
      `window.__MEDTRACKER_CLOUD__`, pass `clientTools` to
      `Conversation.startSession({ signedUrl, clientTools })`:
      - `mcp_help: async () => JSON.stringify(await
        window.CloudMCPDispatcher.handle('mcp_help', {}))`
      - `mcp_call: async ({ op, params }) => JSON.stringify(await
        window.CloudMCPDispatcher.handle('mcp_call', { op, params: params || {} }))`
      Return JSON strings the agent can read; surface dispatcher errors as a
      short string rather than throwing into the SDK.
- [ ] Bot mode passes no `clientTools` (unchanged). Test (c): cloud registers
      the two tools and a simulated `mcp_call('bp.list')` round-trips into the
      catalog; bot mode registers none.

### Task 4: [Final] Docs + verify

- [ ] `docs/cloud-mode.md`: a "Voice (ElevenLabs)" subsection — cloud mints the
      signed URL browser-direct with the vault key (BYO; key never crosses
      `/api`), and dynamic MCP tools (`mcp_help`+`mcp_call`) dispatch in-tab into
      the local catalog (no relay). State the manual prerequisite: the user's
      ElevenLabs **agent dashboard** must declare `mcp_help` + `mcp_call` client
      tools (blocking) with an `{op, params}` parameter shape, and the vault
      `elevenlabs.{api_key, agent_id}` must be set in Settings → Integrations.
      Add the leakage note (BYO ElevenLabs key used browser-direct; MCP
      dispatch stays in-tab, nothing to the cloud server).
- [ ] `go build ./...` + `pnpm test` green; if a new `window.*` global was
      added, it's in the globals allowlist.

## Post-Completion (manual — the real PoC acceptance)

- In the user's ElevenLabs agent dashboard: add two client tools, `mcp_help`
  (no params) and `mcp_call` (params: `op` string, `params` object), both marked
  **blocking**; give the agent a system prompt that says to call `mcp_help`
  first to discover ops, then `mcp_call` to fetch data.
- In cloud Settings → Integrations: set the ElevenLabs `api_key` + `agent_id`.
- **Acceptance:** open the app on an unlocked device, Call Agent → a live
  conversation starts (browser-minted signed URL, no 404). Ask "what's my last
  blood pressure reading?" → the agent calls `mcp_help` then `mcp_call`
  `bp.list` → answers with vault data. Partial/buggy still validates the pillar.

## Out of scope (this PoC)

- Extending the catalog beyond the 6 existing ops (bp/weight/notes) — enough for
  the acceptance question; more ops are a follow-up.
- Server-initiated / off-device voice (that's the med-65c relay path).
- Auto-provisioning the ElevenLabs dashboard tool config (manual for the PoC).
- Bot-mode dynamic client-tools (the old 2026-05-18 plan's scope).
