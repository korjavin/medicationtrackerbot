# Cloud Trial-Key Proxy for AI/Voice (med-eas.25)

## Overview
- Cloud mode is pure BYO today: a freshly-claimed account cannot use AI food logging or the ElevenLabs Call Agent until it enters its own keys in Settings → Integrations. `aiclient.js` throws `no_api_key`, `elevenlabs-signed-url.js` throws "Set your ElevenLabs API key…".
- This plan adds operator-owned **trial keys** configured as envs on the cloud server (`cmd/cloud`), exposed to clients only through **server-side proxy routes** — the keys NEVER reach the browser (zero-knowledge constraint; a leaked key could be abused/resold).
- Precedence in the client: **vault BYO key (browser-direct, unchanged) → trial proxy route → "set your key" error**. If trial envs are absent, the proxy routes return 503 and behavior degrades gracefully to today's pure BYO.
- Trial usage is rate-limited per account (~10 req/min, configurable) using the existing `internal/cloudserver/rate_limit.go` sliding-window limiter keyed on `account.ID`.

## Context (from discovery)
- **Cloud AI client**: `web/cloud/js/aiclient.js` — `credentials()` reads `openai.{api_key,url,model}` + separate vision triple `openai.{vision_api_key,vision_url,vision_model}` from the vault via `settingsDomain.readIntegrationsUnmasked()`. `noKeyError()` (line ~17) throws `code='no_api_key'` from `parseMealFromDescription` and `parseMealFromImage`. POSTs browser-direct to `${url}/chat/completions`.
- **ElevenLabs cloud client**: `web/cloud/js/elevenlabs-signed-url.js` — `fetchSignedURL(agentId)` throws `'Set your ElevenLabs API key in Settings → Integrations'` when vault `elevenlabs.api_key` empty; otherwise browser-direct GET to `api.elevenlabs.io/.../get_signed_url` with `xi-api-key`. Dispatcher: `web/static/js/features/elevenlabs-call.js` `fetchSignedURL()` (cloud branch provisions agent via `window.CloudElevenLabsAgent.provision()` then calls `window.CloudElevenLabs.fetchSignedURL`).
- **Bot-mode reference for server minting**: `internal/server/elevenlabs_handlers.go` `handleElevenLabsSignedURL` — server-side GET with `xi-api-key`, returns `{signed_url}`. NOT importable from cloudserver (arch boundary: cloudserver must not import `internal/server`, `internal/ai`, `internal/domain`) — reimplement (~40 lines).
- **Cloud routing**: `cmd/cloud/main.go:192-201` builds `apiMux` and calls each API's `RegisterRoutes(apiMux)`; handlers get the account via `cloudserver.AccountFromContext(ctx)` (`router.go:251`). New `TrialProxyAPI` follows this pattern.
- **Rate limiter**: `internal/cloudserver/rate_limit.go` — `newRateLimiter(max, window)` + `Allow(key)`, already used keyed on `account.ID` in `mcp_endpoint.go:162`. Reuse directly.
- **Client-visible operator config precedent**: `injectCloudBoot` in `internal/cloudserver/router.go:94-103` splices CSP-safe `<meta>` tags (existing: `medtracker-food-db-url`); Settings UI reads it in `web/static/js/features/settings/integrations.js` `applyCloudFoodDbPlaceholder()`.
- **Env naming convention to mirror** (`internal/config/config.go:167-180`): `OPENAI_API_KEY/_URL/_MODEL`, `OPENAI_VISION_API_KEY/_URL/_MODEL`, `ELEVENLABS_API_KEY`.

## Development Approach
- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data migration, cross-component flow) and gives a guarantee manual checking can't
  - if no integration test adds a real guarantee, the task has NO test items — that is correct and expected
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: if a task adds an integration test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility: with no `TRIAL_*` envs set, all behavior is byte-identical to today (proxy routes 503, client falls through to the existing "set your key" errors).
- **SECURITY INVARIANT: no trial key, trial URL, or trial model may appear in any HTTP response body, header, injected meta tag, or client-reachable config.** The client learns only booleans ("trial AI available", "trial voice available") and receives proxied upstream responses.

## Testing Strategy
- **Unit tests**: none. Do not add unit tests.
- **Integration tests**: Go httptest-level tests on the new cloudserver routes (they guard a real API contract + the never-leak-the-key invariant), and Vitest cases for the client precedence chain (vault → trial → error) since that is a cross-component flow the existing suites cover for siblings.
- **E2E tests**: none (no existing e2e suite).

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope
- Keep plan in sync with actual work done

## Implementation Steps

### Task 1: Trial config loading in cmd/cloud
- [ ] add a `trialConfig` struct in `cmd/cloud/main.go` (or a small `internal/cloudserver/trial.go` config type) with fields for: OpenAI text triple (`APIKey, URL, Model`), OpenAI vision triple (`VisionAPIKey, VisionURL, VisionModel`), ElevenLabs (`APIKey, AgentID`), and rate limit (`PerMinute int`, default 10)
- [ ] load from envs mirroring existing naming: `TRIAL_OPENAI_API_KEY`, `TRIAL_OPENAI_URL`, `TRIAL_OPENAI_MODEL`, `TRIAL_OPENAI_VISION_API_KEY`, `TRIAL_OPENAI_VISION_URL`, `TRIAL_OPENAI_VISION_MODEL`, `TRIAL_ELEVENLABS_API_KEY`, `TRIAL_ELEVENLABS_AGENT_ID`, `TRIAL_RATE_PER_MIN`
- [ ] defaults: URL → `https://api.openai.com/v1`, model → `gpt-4o-mini`, vision triple falls back to the text triple when unset (same fallback `aiclient.js` uses today)
- [ ] document the new envs in `docs/environment.md` and the trial-key design in `docs/cloud-mode.md`

### Task 2: TrialProxyAPI — OpenAI-compatible chat proxy
- [ ] create `internal/cloudserver/trial_proxy.go` with `TrialProxyAPI` struct (holds trial config + a `*rateLimiter`) and `RegisterRoutes(mux *http.ServeMux)`, wired in `cmd/cloud/main.go` next to the other `RegisterRoutes` calls
- [ ] `POST /api/trial/openai/chat/completions` — requires `AccountFromContext`; 503 JSON `{"error":"trial_not_configured"}` when the relevant trial key is empty; otherwise forwards the request body verbatim to `<trialURL>/chat/completions` with `Authorization: Bearer <trial key>`, forcing the `model` field to the trial model (overwrite whatever the client sent — the client must not choose the operator's model), and streams the upstream status + JSON body back
- [ ] vision vs text selection: accept `?vision=1` query param → use the vision triple; otherwise the text triple
- [ ] enforce a request body size cap (reuse the 8 MiB photo cap as ceiling, e.g. 12 MiB total body) and the 90s upstream timeout matching `aiclient.js`
- [ ] never echo upstream `Authorization` or trial config in responses or logs (log account ID + status only, via `slog`)
- [ ] integration test (`internal/cloudserver/trial_proxy_test.go`, httptest upstream): proxied call carries trial key + forced model upstream; response body/headers contain no trial key; 503 when unconfigured; unauthenticated request (no account) rejected

### Task 3: TrialProxyAPI — ElevenLabs signed-URL mint
- [ ] `GET /api/trial/elevenlabs/signed-url` on the same `TrialProxyAPI`: 503 `{"error":"trial_not_configured"}` when key or agent ID empty; otherwise server-side GET to `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=<TRIAL_AGENT_ID>` with `xi-api-key`, return `{"signed_url": ...}` (mirror `internal/server/elevenlabs_handlers.go` behavior; reimplement, do NOT import `internal/server`)
- [ ] make the upstream base URL a field on `TrialProxyAPI` so tests can point it at httptest
- [ ] integration test: mints from a fake upstream, asserts the `xi-api-key` header is sent upstream and absent from the client response; 503 when unconfigured

### Task 4: Per-account rate limiting on trial routes
- [ ] one `rateLimiter` (`newRateLimiter(cfg.PerMinute, time.Minute)`) shared across all trial routes, keyed `account.ID`
- [ ] on limit: 429 JSON `{"error":"trial_rate_limit","retry_after_seconds":60}` + `Retry-After` header (mirrors the demo-mode 429 shape so existing frontend 429 handling applies)
- [ ] integration test: N allowed then 429 for the same account; different account still allowed

### Task 5: Trial-availability flag to the client
- [ ] extend `injectCloudBoot` in `internal/cloudserver/router.go` to add `<meta name="medtracker-trial-ai" content="1">` and `<meta name="medtracker-trial-voice" content="1">` only when the corresponding trial key is configured (booleans only — never URLs/models/keys)
- [ ] plumb the two booleans through `cloudserver.New(...)` from `cmd/cloud/main.go` alongside the existing `foodDBURL` parameter

### Task 6: Client fallback — aiclient.js
- [ ] in `web/cloud/js/aiclient.js`: when the vault key is empty and the trial meta flag is set, route the same chat-completions request body to `/api/trial/openai/chat/completions` (with `?vision=1` for `parseMealFromImage`) via the app's normal `fetch` with credentials; omit `Authorization` header and `model` (server forces it)
- [ ] only when the vault key is empty AND the trial flag is absent (or the trial route returns 503) → throw the existing `noKeyError()`; surface 429 as a distinct "trial limit reached — try again in a minute or add your own key" error message
- [ ] Vitest (extend the existing food/aiclient suite): vault key present → browser-direct unchanged; no key + trial flag → trial route hit with forced-server model; no key + no flag → `no_api_key` error; trial 429 → limit message

### Task 7: Client fallback — ElevenLabs
- [ ] in `web/static/js/features/elevenlabs-call.js` cloud branch of `fetchSignedURL()`: if the vault elevenlabs key is empty and the trial-voice meta flag is set, skip agent provisioning and GET `/api/trial/elevenlabs/signed-url` (the trial uses the operator's shared agent); vault key present → current provision + browser-direct path unchanged
- [ ] keep the existing "Set your ElevenLabs API key in Settings → Integrations" error for no-key + no-trial; map 429 to a trial-limit message
- [ ] Vitest (extend the existing elevenlabs-call suite): precedence chain vault → trial → error

### Task 8: Settings hint (trial vs BYO)
- [ ] in `web/static/js/features/settings/integrations.js`, cloud-only (mirror `applyCloudFoodDbPlaceholder` pattern): when the trial meta flag is set and the corresponding vault key is empty, show a small hint next to the OpenAI / ElevenLabs key fields — "Trial key active (rate-limited). Add your own key to remove limits."

### Task 9: Verify acceptance criteria
- [ ] verify: no `TRIAL_*` env set → cloud behaves exactly as today (grep responses/meta for absence of trial markers)
- [ ] verify: trial key/URL/model never appear in any response, meta tag, or client bundle (grep + the Task 2/3 tests)
- [ ] run `go test ./...` — must pass
- [ ] run `pnpm test` — must pass
- [ ] run linter — all issues must be fixed

### Task 10: [Final] Update documentation
- [ ] confirm `docs/environment.md`, `docs/cloud-mode.md` cover the trial envs, proxy routes, rate limit, and precedence chain
- [ ] update `docs/api.md` with the two new routes (marked cloud-only)

## Technical Details
- **Routes** (all under the account subdomain, account resolved by `router.go` host routing; handlers 401 when `AccountFromContext` is nil):
  - `POST /api/trial/openai/chat/completions[?vision=1]` — body: OpenAI-compatible chat request (messages, response_format…); `model` is server-forced; response: upstream JSON passed through
  - `GET /api/trial/elevenlabs/signed-url` — response `{"signed_url": "..."}`
- **Error contract**: `503 {"error":"trial_not_configured"}`, `429 {"error":"trial_rate_limit","retry_after_seconds":60}`, upstream errors passed through with upstream status (body sanitized to `{"error":"upstream_error"}` — upstream error bodies could echo request auth context)
- **No streaming**: `aiclient.js` doesn't use SSE streaming today; the proxy rejects `"stream":true` bodies with 400 to keep the surface minimal
- **CSP**: trial calls are same-origin `/api/*`, so no `connect-src` changes needed (unlike browser-direct BYO)

## Post-Completion
*Items requiring manual intervention or external systems — no checkboxes, informational only*

**Manual verification**:
- Deploy with real trial keys on the cloud stack; on a fresh account with an empty vault: AI food text parse, food photo parse, and Call Agent all work; hit the 10/min limit and confirm the 429 UX; add a BYO key and confirm browser-direct takes over
- Confirm the deployed page source contains only the boolean meta flags, never key material

**External system updates**:
- Set `TRIAL_OPENAI_*`, `TRIAL_OPENAI_VISION_*`, `TRIAL_ELEVENLABS_*` envs in the cloud container (gitops stack env / secrets)
- Create the shared operator ElevenLabs agent and set its ID as `TRIAL_ELEVENLABS_AGENT_ID`
