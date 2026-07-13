# Restore cloud drug-interaction checks via a blind same-origin RxNav proxy (bd med-yor.14)

## Overview
Drug-interaction and drug-name lookups silently never fire in cloud mode.
`web/cloud/js/rxnorm.js` fetches `https://rxnav.nlm.nih.gov` and
`https://lhncbc.nlm.nih.gov` browser-direct from the DEK-bearing app document,
but that document's `connect-src` (`internal/cloudserver/router.go`
`buildConnectSrc`) is `'self'` + BYO-registered hosts + fixed
`api.elevenlabs.io` only — the RxNav hosts are structurally CSP-blocked and
`fetchJson` swallows the failure, so `checkInteractions` returns `[]` silently
while `privacy.js` still describes a working flow.

Fix per the deliberate design (keyless third-party lookups are proxied
same-origin so the DEK page's `connect-src` stays minimal — **do NOT add rxnav
to connect-src, never emit a wildcard connect-src**):

1. Add a blind same-origin RxNav proxy in `internal/cloudserver` mirroring
   `food_proxy.go` (fixed-string log invariant, no query/name/body logging).
2. Rewire `rxnorm.js` to call the same-origin proxy (relative `/api/rxnav/*`).
3. Register the food-DB bare-`domain` fallback host in `hostsFromIntegrations`
   (the fooddb.js fallback host was CSP-blocked for the same reason).
4. Add a consistency test: every client-side literal fetch host must be
   CSP-reachable or same-origin-proxied.
5. Update the disclosure (privacy.js item + docs/cloud-mode.md leakage table):
   drug lookups are now operator-proxied (blind by log invariant), not
   browser-direct.

## Context (from discovery)
- `internal/cloudserver/food_proxy.go` + `food_proxy_test.go` — the exact
  pattern to mirror (struct, constructor, `RegisterRoutes` with
  `RequireSession`, `proxyRequest` with Content-Type+status+`io.Copy`, and the
  security-invariant test asserting no key/query leaks into body/headers/logs).
- `web/cloud/js/rxnorm.js` — the cloud rxnorm port (only loaded in cloud mode,
  wired via `apishim.js` `createRxnormPort`). `searchRxNorm` = rxcui.json →
  approximateTerm.json → properties.json; `checkInteractions` =
  interaction/list.json. Keep the `AbortController` 10s timeout and
  `[]`-degradation behavior.
- `web/cloud/js/egress-hosts.js` `hostsFromIntegrations` (~L29-33) reads
  `openai.url`, `openai.vision_url`, `food.url` — NOT `food.domain`.
  `fooddb.js` `baseURL()` falls back to bare `food.domain`, prepending
  `https://` when no scheme.
- `cmd/cloud/main.go` ~L220/235 wires `foodProxyAPI` +
  `foodProxyAPI.RegisterRoutes(apiMux)`.
- `internal/cloudserver/router.go` `buildConnectSrc` — MUST NOT change; the
  proxy is same-origin so `connect-src 'self'` already covers it. Landmine
  tests: `router_test.go` `TestRouter_HostVariants` /
  `TestRouter_AppDocumentReflectsEgressHosts`.
- `web/cloud/js/privacy.js` `PRIVACY_ITEMS` — the `docSignal`
  `'Drug-name search + interaction queries'` entry (category `leaves`).
- `web/cloud/js/tests/privacy.drift.test.js` — requires each non-null
  `docSignal` to be 1:1 with a Signal-column row in the
  `## Metadata leakage summary` table of `docs/cloud-mode.md`. Preserve the
  Signal string exactly; only change the other two columns + the privacy item
  category/title/detail.
- `RequireSession(store, sessionSecret, next http.Handler)` in
  `internal/cloudserver/session.go`.
- Existing egress-hosts test file lives under `web/cloud/js/tests/`.

## Development Approach
- **Testing approach**: Regular (code first, then tests) — the tests mirror an
  existing pattern (`food_proxy_test.go`).
- Complete each task fully (including its tests) before the next.
- **Do NOT touch** `web/cloud/js/settings.js`, `aiclient.js`,
  `account-delete.js` (other executors own them). **Do NOT modify existing DB
  migrations.** **Do NOT touch `router.go` / emit any wildcard connect-src.**
- Run tests after each change; all green before advancing.

## Testing Strategy
- **Unit/integration (Go)**: `go test ./internal/cloudserver/...` — new
  `rxnav_proxy_test.go` mirrors `food_proxy_test.go`.
- **Frontend (Vitest)**: `pnpm test` — extend egress-hosts test for
  `food.domain`; new `egress-consistency.test.js`; `privacy.drift.test.js`
  must stay green.

## Progress Tracking
- Mark completed items `[x]` immediately.
- `➕` prefix for newly discovered tasks, `⚠️` for blockers.

## Implementation Steps

### Task 1: Add the same-origin RxNav proxy (Go)
- [x] Read `internal/cloudserver/food_proxy.go` in full first.
- [x] Create `internal/cloudserver/rxnav_proxy.go`: `RxNavProxyAPI` struct
      `{baseURL, interactionURL string; store sessionStore; sessionSecret string; client *http.Client}` with `client` timeout `10 * time.Second`.
- [x] Add package constants `defaultRxNavBaseURL = "https://rxnav.nlm.nih.gov"`
      and `defaultRxNavInteractionURL = "https://lhncbc.nlm.nih.gov/RxNav/APIs"`.
- [x] `NewRxNavProxyAPI(store, sessionSecret, baseURL, interactionURL string)`:
      default empty args to the constants, `strings.TrimRight(..., "/")` both.
- [x] `RegisterRoutes(mux)`: four `RequireSession`-wrapped GET routes —
      `GET /api/rxnav/rxcui`, `GET /api/rxnav/approximate`,
      `GET /api/rxnav/properties`, `GET /api/rxnav/interactions`.
- [x] Handlers: `Rxcui` (`?name=` → `/REST/rxcui.json?name=<QueryEscape>`),
      `Approximate` (`?term=` → `/REST/approximateTerm.json?term=<QueryEscape>&maxEntries=1`),
      `Properties` (`?rxcui=` → `/REST/rxcui/<PathEscape>/properties.json`),
      `Interactions` (`?rxcuis=` comma-separated → split on `,`, reject any
      non-all-digit part with 400, rejoin with `+` →
      `/api/interaction/list.json?rxcuis=<joined>`). Each 400s on a missing
      required param.
- [x] Shared `proxyRequest(upstreamURL, w, r)` mirroring `food_proxy.go`:
      `NewRequestWithContext` GET, `client.Do`, copy `Content-Type` + status +
      body via `io.Copy`. No API key. Every `slog` line is a FIXED string only
      (`"rxnavproxy: upstream request failed"`, `"error", err`) — NEVER log the
      query/name/rxcui/body.
- [x] Write tests in this task (see Task 2) — combined here.
- [x] `go build ./...` and `go test ./internal/cloudserver/...` — must pass.

### Task 2: RxNav proxy tests (Go)
- [x] Create `internal/cloudserver/rxnav_proxy_test.go` copying the
      `food_proxy_test.go` pattern: `newRxNavTestHandlerAPI` helper
      (`setupStore` / `setupInvite` / `New(...)` / `registerAndGetSession`),
      passing a mock `httptest` upstream URL as BOTH `baseURL` and
      `interactionURL`.
- [x] Mock upstream serves the four RxNav JSON shapes
      (`/REST/rxcui.json`, `/REST/approximateTerm.json`,
      `/REST/rxcui/<id>/properties.json`, `/api/interaction/list.json`).
- [x] Assert each of the four routes proxies correctly (200 + expected JSON).
- [x] Assert an unauthenticated request 401s ("Requires session").
- [x] Assert `Interactions` rejects a non-numeric `rxcuis` part with 400 and
      forwards digit parts joined by `+` (capture the upstream `rxcuis` query).
- [x] `go test ./internal/cloudserver/...` — must pass before next task.

### Task 3: Wire the proxy + rewire the browser port
- [x] `cmd/cloud/main.go`: alongside `foodProxyAPI` add
      `rxnavProxyAPI := cloudserver.NewRxNavProxyAPI(store, cfg.sessionSecret, "", "")`
      and `rxnavProxyAPI.RegisterRoutes(apiMux)` (empty strings → real public
      defaults).
- [x] `web/cloud/js/rxnorm.js`: replace the `BASE_URL`/`INTERACTION_URL`
      literals. `searchRxNorm` → `GET /api/rxnav/rxcui?name=`,
      `GET /api/rxnav/approximate?term=`,
      `GET /api/rxnav/properties?rxcui=<rxcui>` (switch properties from the
      path form to the `?rxcui=` query to match the proxy route).
      `checkInteractions` → `GET /api/rxnav/interactions?rxcuis=<rxcuis.join(',')>`.
- [x] Keep the `AbortController` 10s timeout and `[]`-degradation on
      non-OK/error.
- [x] Rewrite the top-of-file comment: no longer browser-direct; now routes
      through the operator's blind same-origin proxy (`connect-src 'self'`
      covers it); name the tradeoff (operator sees the query in transit, blind
      by the fixed-string log invariant).
- [x] `go build ./...` — must pass. (Existing rxnorm-touching frontend tests,
      if any, run under `pnpm test` in the Verify task.)

### Task 4: Register the food.domain fallback host
- [x] `web/cloud/js/egress-hosts.js`: in `hostsFromIntegrations`, add
      `integrations.food && integrations.food.domain` to the sources. Because
      `food.domain` may be a bare host (no scheme) that `new URL()` rejects,
      normalize a bare host to `https://<domain>` (mirror `fooddb.js`
      `baseURL()`) before parsing so it actually registers; keep dropping truly
      unparseable/unallowlistable hosts via the existing `canAllowlist` guard.
- [x] Update the `hostsFromIntegrations` doc comment to mention `food.domain`.
- [x] Extend the existing egress-hosts test (under `web/cloud/js/tests/`) with
      a `food.domain` bare-host case (registers as its hostname) and confirm
      existing cases still pass.
- [x] `pnpm test` (egress-hosts suite) — must pass before next task.

### Task 5: Consistency test + disclosure updates
- [x] Create `web/cloud/js/tests/egress-consistency.test.js`: scan every
      non-test `web/cloud/js/**/*.js`, strip `//` and `/* */` comments, regex
      `https?://<host>` string LITERALS from the remaining code, collect the
      host set, assert each host is in a curated `ALLOWED` map `{host: reason}`
      — CSP-reachable (`api.elevenlabs.io` fixed; `api.openai.com` BYO default,
      fallback registration tracked in med-yor.4) or a navigation link not a
      fetch (`t.me`). Assert `rxnav.nlm.nih.gov` / `lhncbc.nlm.nih.gov` are
      absent (proxied → relative paths). Assert `rxnorm.js` references
      `/api/rxnav/` (proves it is proxied). Contract comment: any new literal
      external fetch host fails CI until proxied or added to `ALLOWED` with
      justification.
- [x] `web/cloud/js/privacy.js`: rewrite the `PRIVACY_ITEMS` entry whose
      `docSignal` is `'Drug-name search + interaction queries'` — move
      `category` from `leaves` to `visible`; keep the `docSignal` string
      EXACTLY unchanged; rewrite `title`/`detail` to describe the same-origin
      blind proxy (operator sees the query in transit, blind by the log
      invariant; nothing persisted beyond `rxcui`/`normalized_name`).
- [x] `docs/cloud-mode.md`: in the `## Metadata leakage summary` table, for the
      row whose Signal is `Drug-name search + interaction queries` keep the
      Signal cell identical but update "Who learns it" (cloud operator via blind
      same-origin proxy + RxNav) and "Mitigation" (proxied to keep connect-src
      minimal; blind by log invariant; nothing persisted beyond
      rxcui/normalized_name). Update the "RxNorm direct-from-browser" bullet
      (~L661) to say it is now same-origin-proxied, not browser-direct.
- [x] `pnpm test` — `privacy.drift.test.js`, `egress-consistency.test.js`, and
      the full frontend suite must pass. (310 files / 3551 tests green with
      Node 20.18.1 from /tmp — worktree's system node 18 is too old for
      vitest 3.)

### Task 6: Verify acceptance criteria
- [x] `go build ./...` — clean (server build; also spot-check
      `go build -tags mobile ./...` is unaffected — no files touched there).
- [x] `go test ./internal/cloudserver/...` — green (RxNav proxy + router
      landmine tests `TestRouter_HostVariants` /
      `TestRouter_AppDocumentReflectsEgressHosts`).
- [x] `pnpm test` — green (310 files / 3551 tests; egress-hosts,
      egress-consistency, privacy.drift all pass).
- [x] Confirm no wildcard `connect-src` was introduced and `router.go` is
      untouched (empty diff vs master).
- [x] Confirm `settings.js`, `aiclient.js`, `account-delete.js` and existing
      migrations are untouched (empty diff vs master).

## Technical Details
- Proxy routes (session-gated, same-origin, no API key):
  - `GET /api/rxnav/rxcui?name=` → `<base>/REST/rxcui.json?name=…`
  - `GET /api/rxnav/approximate?term=` → `<base>/REST/approximateTerm.json?term=…&maxEntries=1`
  - `GET /api/rxnav/properties?rxcui=` → `<base>/REST/rxcui/<id>/properties.json`
  - `GET /api/rxnav/interactions?rxcuis=a,b` → `<interaction>/api/interaction/list.json?rxcuis=a+b`
- Interactions param validation: digits only per part (trust boundary — the
  value is interpolated into the upstream URL); reject otherwise with 400.
- Log invariant: only fixed strings + `err` reach `slog`; the drug name /
  rxcui / interaction list never appear in a log line, response header, or body
  beyond the upstream JSON passthrough.

## Post-Completion
**Manual verification** (informational, not a task checkbox):
- On a real account subdomain, adding a medication resolves an rxcui and (if
  NLM's interaction endpoint is live) surfaces an interaction warning; the
  browser makes only same-origin `/api/rxnav/*` requests (no CSP violation in
  devtools). Note: NLM decommissioned the public interaction-list endpoint
  (403s); `checkInteractions` still degrades to `[]` — the structural CSP block
  on rxcui/name resolution is what this fix restores.

**Follow-up** (out of scope):
- med-yor.4 will replace the hand-maintained docSignal/leakage-table convention
  with a single structured privacy/egress manifest; the `api.openai.com`
  default-fallback registration gap is tracked there.
