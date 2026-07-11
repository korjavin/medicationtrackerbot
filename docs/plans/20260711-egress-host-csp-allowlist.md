# Restore a scoped connect-src on the DEK page via a server-set per-account egress allowlist

## Overview

The cloud-mode account app document (`<account>.<baseDomain>` at `/`) holds the
in-memory DEK and decrypted health records. Its CSP relaxes `connect-src` to
`'self' https: wss:` because the browser-direct BYO-provider calls (AI, food-DB)
go to user-configured origins that are currently unknowable server-side. That
wildcard lets an on-origin XSS POST the DEK + records to **any** `https:` origin —
rated CATASTROPHIC in `docs/cloud-crypto.md`.

**Approach (owner decision):** stop treating the BYO destination as
server-unknowable. The client registers its provider **hostnames** (NOT keys, NOT
health data) server-side after unlock; the server emits a per-account
`connect-src` allowlist scoped to exactly those hosts + the fixed
`api.elevenlabs.io`. Then **no document on the origin ever serves a wildcard
`https:` connect-src**, so an on-origin XSS can only reach the user's own
configured providers, never an arbitrary attacker origin.

**Why this works where the prior sandboxed-iframe attempt failed (bd comment
2026-07-11):** that attempt had to serve a relaxed-`connect-src` document
somewhere on the origin (the sandbox), which is itself a CSP-bypass gadget — an
XSS spawns its own frame instance and pins it to the attacker. Here there is no
relaxed-CSP document anywhere; the allowlist is server-set and identical for every
same-origin document, so spawning a child frame grants no new reach.

**Residual risk (must be documented honestly):** an XSS can call the
egress-registration endpoint to add an attacker host and then force a reload to
pick up the widened CSP. This is strictly harder than today's instant
arbitrary-origin exfil (requires persistence + a navigation) but is NOT a total
close. Also: the operator learns *which* provider hostname each account uses
(the API key and all health data remain client-only/encrypted).

## Context (from discovery + prior run)

- **What the DEK page (`/`) legitimately connects to cross-origin:** the BYO
  AI provider host (`integrations.openai.url`, maybe distinct `vision_url`), the
  BYO food-DB host (`integrations.food.url`), and the fixed ElevenLabs host
  `api.elevenlabs.io` (REST `https:` + voice `wss:`; only its API key is BYO, the
  host is fixed). Same-origin fallbacks — trial AI `/api/trial/...` and
  operator-default food-db `/api/food/...` — are `'self'` and need no allowlist.
- **CSP is path-driven and server-set:** `internal/cloudserver/router.go`
  `setSecurityHeaders(w, accountApp bool)` (`:156-177`), called from `ServeHTTP`
  at `:181`; the account is resolved just after at `:193` (`AccountBySubdomain`).
  `isAppPath` (`:315-317`) = `/`, `/static/`, `/domain/`. App-page branch currently
  emits `connect-src 'self' https: wss:` + `script-src 'self' blob: data:` +
  `worker-src`/`media-src blob:`.
- **The app document is `/` (SPA).** All provider fetches run in that document's
  realm, so `/`'s response `connect-src` governs them. `/static/*` and `/domain/*`
  are just asset responses whose own `connect-src` is inert (they don't initiate
  the app's fetches); they can safely be `'self'`.
- **Client seam to register hostnames:** `installApiShim`
  (`web/cloud/js/apishim.js:717-783`), reached from `cloud-boot.js:175` — the one
  post-unlock join point where `settingsDomain.readIntegrationsUnmasked()` is
  callable. Provider config comes from that single call (groups
  `openai{url,vision_url,...}`, `food{url,...}`, `elevenlabs{...}`).
- **Settings change path:** the integrations save in the Settings UI
  (`web/domain/settings.js` patch path + its cloud handler) is where a provider URL
  changes; re-registration + a "reload to apply" hint belong there.
- **Server storage:** `internal/cloudstore` owns the cloud SQLite schema (own
  goose migrations; imports only `internal/store/db`). Account row keyed by
  subdomain via `AccountBySubdomain`.
- **Tests:** `TestRouter_HostVariants`
  (`internal/cloudserver/router_test.go:104-202`) asserts per-path CSP; a med-7e7.1
  invariant asserts `script-src` has no `//`.
- **MCP coverage guard:** every new route must be in the registry or
  `internal/server/mcp_coverage_exempt.go` — but this route is on `cmd/cloud`
  (cloudserver), not the bot server; confirm whether the cloud router has its own
  coverage guard and satisfy it (exempt as auth/settings plumbing if so).
- **No iframe / no postMessage / no sandbox** — the prior attempt's machinery is
  NOT reintroduced. Provider modules keep running in-page unchanged.

## Development Approach
- **Testing approach**: NO unit tests. Real-boundary integration tests only:
  extend `TestRouter_HostVariants` (served CSP per account), and a cloudstore test
  for egress-host persistence. The endpoint gets a cloudserver handler test only if
  it guards a real contract not covered by the router test.
- Complete each task fully before the next; keep the suite green throughout.
- The provider modules and their `window.Cloud*` globals are UNCHANGED — this is a
  CSP + a small client-registration change, not a provider-call refactor.
- **CRITICAL: update this plan file when scope changes during implementation.**

## Testing Strategy
- **Unit tests**: none.
- **Integration tests**: `TestRouter_HostVariants` extended (app-page connect-src
  reflects stored egress hosts, no bare `https:`); cloudstore Set/Get egress hosts.
- **E2E tests**: none new. Live provider round-trips + reload behavior are manual
  (Post-Completion).

## Progress Tracking
- Mark completed items `[x]` immediately.
- New tasks: plus-prefix. Blockers: warning-prefix.
- Keep the plan in sync with actual work.

## Implementation Steps

### Task 1: Per-account egress-host storage in cloudstore
- [x] add a cloudstore goose migration for per-account allowed egress hosts (a hosts list — e.g. `account_egress_hosts(account_id, host)` or a TEXT/JSON column on the account row; follow the existing cloudstore migration + repo pattern)
- [x] add repo methods `SetEgressHosts(ctx, accountID, hosts []string)` and `EgressHosts(ctx, accountID) ([]string, error)`; normalize/dedupe hostnames on write

### Task 2: Authenticated endpoint to register egress hosts
- [x] add `PUT /api/egress-hosts` on the cloud router: authenticated to the calling account, body `{ "hosts": ["api.openai.com", "fooddb.example.com"] }` (`internal/cloudserver/egress.go`, session-gated via `RequireSession`, wired in `cmd/cloud/main.go`)
- [x] validate each host: parseable hostname only (no scheme/path/query), reject non-hostnames, cap the count (<= 8, `maxEgressHosts`) and per-host length (253, `maxEgressHostLen`); persist via `SetEgressHosts`
- [x] satisfy the cloud router's route-coverage guard if one exists — no cloud route-coverage guard exists (grep found none in `internal/cloudserver`/`cmd/cloud`); nothing to satisfy
- +[x] implement the Task 1 storage that the prior "feat" commit never wrote (only edited the plan): migration `015_egress_hosts.sql` (JSON `egress_hosts` column on `accounts`) + `SetEgressHosts`/`EgressHosts` repo methods with normalize/dedupe. Task 2's endpoint depends on these.

### Task 3: Emit the per-account connect-src allowlist for the app document
- [x] in `router.go` `ServeHTTP`, ensure the account (and its egress hosts) is resolved before the CSP is set for the app *document* path(s); reuse the existing `AccountBySubdomain` resolution — the `/` branch now reads `EgressHosts(account.ID)` and overrides the strict default set early. `EgressHosts` added to the `accountStore` interface. An EgressHosts read error degrades to the fixed allowlist (never a wildcard).
- [x] build the app-document `connect-src` as `'self'` + each stored host as `https://<host>` + `https://api.elevenlabs.io wss://api.elevenlabs.io`; drop bare `https:` and bare `wss:` (`buildConnectSrc`)
- [x] keep `script-src 'self' blob: data:` + `worker-src`/`media-src blob:` on the app document (in-page voice SDK worklets); give `/static/*` and `/domain/*` responses `connect-src 'self'` (inert there) — early `setSecurityHeaders(w, false, nil)` is strict for everything, only `/` overrides. Removed now-unused `isAppPath`. Existing `TestRouter_HostVariants` cases updated to the new contract (Task 5 adds egress-host-specific cases).
- [x] update the `setSecurityHeaders` comment: describe the egress-allowlist model and the honest residual (the current "sandboxing deferred" note is obsolete)

### Task 4: Client registers hostnames after unlock and on provider change
- [ ] in `apishim.js` `installApiShim` (post-unlock), read `readIntegrationsUnmasked()`, extract hostnames from `openai.url` / `openai.vision_url` / `food.url` (hostname only — never keys), and `PUT /api/egress-hosts`
- [ ] on the Settings integrations save path, re-register the hosts and surface a "reload to apply new provider" hint (the scoped CSP updates on the next document load)
- [ ] confirm no provider secret (api_key) is ever sent to the endpoint — only hostnames

### Task 5: Extend TestRouter_HostVariants + cloudstore storage test
- [ ] `TestRouter_HostVariants`: add a case with egress hosts stored — assert the app-page `connect-src` contains `'self'`, each `https://<host>`, `https://api.elevenlabs.io`, `wss://api.elevenlabs.io`, and NO bare `https:`/`wss:` token (extend the med-7e7.1 no-`//` directive helper to `connect-src` where applicable); add a case with no hosts (still no bare `https:`)
- [ ] cloudstore test: `SetEgressHosts` then `EgressHosts` round-trips + dedupe/normalization; keep the existing suite green

### Task 6: Verify acceptance criteria
- [ ] `go build ./...` and `go build -tags mobile ./...` clean
- [ ] `go test ./internal/cloudserver/... ./internal/cloudstore/...` green
- [ ] `pnpm test` green
- [ ] grep the served app-document CSP: `connect-src` has no bare `https:`; it lists the stored host(s) + `api.elevenlabs.io`

### Task 7: [Final] Update documentation
- [ ] `docs/cloud-crypto.md` + `docs/cloud-mode.md`: document the per-account egress-allowlist model, that only the provider HOSTNAME is revealed server-side (key + data stay client-only), and the HONEST residual (XSS can register a host then force a reload — narrower than today's instant arbitrary-origin exfil, not a total close)
- [ ] note the new CSP invariant in the CLAUDE.md cloud-mode section if a new guard test was added

## Technical Details

- **Why no bypass gadget exists here:** the allowlist is server-set and identical
  for every same-origin document; there is no path that serves a wildcard-`https:`
  `connect-src`. An XSS spawning a child frame of any same-origin path inherits the
  same scoped allowlist, so it gains no new egress reach — unlike the prior sandbox
  document which was a wildcard-`https:` open proxy.
- **api.elevenlabs.io is always allowed** (fixed operator-known provider host,
  harmless to include unconditionally); only its API key is BYO.
- **Registration carries hostnames only.** The endpoint never receives keys or
  health data; the server persists a short hostname list per account.
- **Ordering:** move the app-document CSP decision to after account resolution in
  `ServeHTTP`; static/asset paths keep `connect-src 'self'` and need no lookup.

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification (needs a live account + configured providers):**
- Configure a BYO OpenAI-compatible provider + BYO food-DB; reload; confirm the `/`
  response `Content-Security-Policy` `connect-src` lists exactly `'self'`, the two
  provider hosts, and `api.elevenlabs.io` (https + wss) — no bare `https:`.
- Confirm AI parse, food search, and an ElevenLabs voice call all still work
  in-page under the scoped CSP.
- Confirm operator-default food-db + trial AI still work when BYO is unset (same
  origin).
- Change a provider URL in Settings, confirm the "reload to apply" hint, reload,
  and confirm the CSP now reflects the new host.

**Security review:**
- Simulated on-origin XSS: confirm a direct `fetch('https://attacker/')` is
  CSP-blocked, and that a spawned same-origin child frame inherits the same scoped
  allowlist (no wildcard-`https:` gadget). Confirm the documented residual
  (register-host + reload) is the only remaining path and is called out in docs.
