# CLAUDE.md

Guidance for Claude Code working in this repository. This file is an index — detailed topics live in `docs/`.

## Project Overview

A self-hosted health-tracking PWA for medications, blood pressure, weight, workouts, sleep, food, and diary, built around a **zero-knowledge vault**. `cmd/cloud` is the product: the browser holds the vault keys, the plaintext, and all domain logic; the server stores encrypted sync state and operates relays. A handful of optional integrations deliberately reach outside the vault and are enumerated with code evidence in [docs/cloud-mode.md → Privacy boundary](docs/cloud-mode.md#privacy-boundary--the-vault-promise-and-its-carve-outs).

**Philosophy**: single source of truth for health metrics, with the encrypted PWA as the primary interface and optional chat/AI integrations that do not become the trust anchor. Self-hosted for real data ownership.

**New here?** [docs/README.md](docs/README.md) is the documentation map — which docs are normative, which are proposals, and which are history. [docs/architecture.md](docs/architecture.md) is the starting point.

## Critical Rules

1. **Domain logic lives in one place per runtime.** In the browser that is `web/domain/*.js` — pure ES modules behind injected ports, no browser globals, enforced by `architecture.domain-purity.test.js`. `web/cloud/js/apishim.js` and `mcp-responder.js` route into it; neither may hold domain logic of its own. (The Go `internal/domain/*` service pattern that governs `internal/server` + `internal/bot` is unchanged and documented in [docs/archive/architecture-bot-mode.md](docs/archive/architecture-bot-mode.md#domain-service-pattern).)
2. **Never modify existing migrations.** Always add new ones in `internal/store/migrations/`.
3. **No hardcoded colors or inline `.style.` assignments in frontend code.** Use design tokens and CSS classes. All visual values come from `--wg-*` tokens (Wandergeek system). Architecture tests enforce this. See [docs/frontend.md](docs/frontend.md#design-tokens).
4. **New `window.*` globals require an allowlist entry** in `tests/architecture.globals.test.js` with justification.
5. **Use `log/slog` with contextual args** (`slog.Error("msg", "error", err)`), not `log.Printf`.
6. **The bottom nav is the canonical navigation** — one slot per real section (row 1: Today, BP, Food, Meds — row 2: Vitals, Workouts, Weight, Settings). The Vitals slot keeps its internal id `health` for deeplink / localStorage stability; only the label is "Vitals". No "More" aggregator: every section is a first-class destination with its own icon. Disabled features are filtered out of the nav before mount, not bounced after tap. Screens sit directly on the teal stage — no `section-header-mount` banners. `<wg-phone-chrome>` is a design-system primitive available for Phase 3+ screen reskins; it is not yet wrapped around screens at runtime. See [docs/frontend.md](docs/frontend.md#navigation).
7. **Merge PRs with `gh pr merge --merge`** (regular merge commit), never `--squash` or `--rebase`. The project's history uses merge commits to preserve feature-branch context.
8. **Frontend tests are integration-first.** New behavior is added to the owning feature suite (`features.*` or `<feature>.<aspect>.test.js`) through `tests/helpers/frontend-harness.js`. Do not add coverage-driven `*-branches` / `*-edges` / `*-characterization` files, and do not create standalone `pin-defect-N` or `task-N` files — extend the feature's existing `describe` block instead. Pure-unit tests are reserved for layers without an integration entry point (web components, DB, SW, sync, cached-fetch). See [docs/frontend.md → Testing posture](docs/frontend.md#testing-posture).
9. **Frontend write handlers MUST use `DataStore.applyOptimistic`**, never `invalidateTags + loadX()`. Optimistic state repaints the UI before the POST resolves; `commit(serverPayload)` reconciles on success, `rollback()` restores prior cache and invalidates tags on failure. The `invalidateTags + loadX()` pattern is reserved for read-only refreshes (e.g. `invalidateWorkoutCache`) and the rollback path itself. See [docs/frontend.md → Optimistic Write Updates](docs/frontend.md#optimistic-write-updates).
10. **Device-capability access routes through `web/static/js/native/`.** Feature code calls `window.MediaCapture` / `window.Barcode` rather than `getUserMedia`, `BarcodeDetector`, or `<input type=file capture=…>` directly. `tests/architecture.native-abstractions.test.js` enforces this: `navigator.mediaDevices` / `getUserMedia` / `BarcodeDetector` are banned outside `native/` with no allowlist, and `window.Capacitor` / `isNativePlatform` are banned everywhere (the Capacitor shell was removed). New device capabilities add a `web/<cap>.js`, register via the foundation's `registerImpl`, and ship a `tests/native.<cap>.test.js`. See [docs/frontend.md → Device-Capability Abstractions](docs/frontend.md#device-capability-abstractions).
11. **The app document must not surface Telegram — neither remote script nor login UI.** `web/static/index.html` MUST NOT contain a `<script src="https://telegram.org/...">` tag, or every cloud page load would phone Telegram's CDN (and the cloud origin's `default-src 'self'` CSP would block it anyway). The Telegram Web App SDK is injected at runtime by `web/static/js/core/messenger-adapter.js` (via `loadTelegramSdk()`), skipped in cloud mode and when `window.Telegram?.WebApp` is already present. `checkAuth()` short-circuits on `window.__MEDTRACKER_CLOUD__` and goes straight to `/api/bootstrap` + `applyBootstrapPayload`, so the Telegram login screen never renders there. Enforced by `architecture.no-telegram-in-html.test.js`.

## Build

Plain `go build ./...` — no build tags anywhere.

**`cmd/cloud` is the service.** It serves per-account subdomains, encrypted sync, and the blind push relay. All product work targets it; see [docs/cloud-mode.md](docs/cloud-mode.md).

Other `cmd/` directories are developer and operator tooling (`mcpshim`, `genmcpcatalog`, `genvapid`, `feedbackpull`, `seeddemo`, importers) plus `cmd/bot`, which is **not deployed and not operated** — the stack runs `./cloud` (`docker-compose.cloud.yml:14`). Its source stays in the tree and must keep compiling and passing tests under `go build ./...` / `go test ./...` so it cannot silently rot, but it is not a deployment target and no doc should present it as one. (`Dockerfile` still compiles a `bot` binary into the image; narrowing that is a separate change and does not make `cmd/bot` a product surface.) The Capacitor Android shell and its `//go:build mobile` variant were removed (branch `mobile` preserves the last working state).

There is also a runtime **demo mode** (`DEMO_MODE=1`) that disables web + MCP auth, resolves every request to a fixed seeded user, and applies restrictive per-IP rate limits to AI / cost-sensitive endpoints. It's a runtime flag, not a build tag — the same binary serves both production and demo deployments. See [docs/demo-mode.md](docs/demo-mode.md).

Configuration layering: env var → settings table → built-in default. The `internal/config` package owns `LoadFromEnv` + `LoadFromSettings` + `Merge`. User-editable provider keys (OpenAI, Food DB, ElevenLabs) live in the singleton settings row and are reachable via the Settings UI's Integrations section.

## Development Commands

```bash
# Run the service
go run ./cmd/cloud

# Run all tests (this must stay green for the whole tree, cmd/bot included)
go test ./...

# Run a specific package
go test ./internal/store
go test -v ./internal/cloudserver -run TestRouter

# Frontend tests (Vitest + jsdom)
pnpm test

# Regenerate the privacy boundary table after editing the manifest
pnpm privacy:docs

# Docker
docker compose -f docker-compose.cloud.yml up
```

### Data import tools

```bash
go run cmd/importer/main.go   -file export.json -user <telegram_user_id> -db meds.db
go run cmd/bpimporter/main.go -file bp_data.csv -db meds.db
go run cmd/genvapid/main.go                                   # VAPID keys for web push
```

#### Demo data seeder

`cmd/seeddemo` wipes a target user's data and seeds N days (default 90) of synthetic, varied health-tracking data so the app can be demoed: medications with overlapping courses, BP/weight/sleep time series with visible trends, continuous HR/SpO2/stress samples (Mi Band-style), daily step/calorie/distance aggregates correlated with workout days, food logs hitting and missing targets, planned + ad-hoc workouts, diary notes, and a mid-period timezone change. Deterministic by default (seedable RNG) so re-running with the same seed produces an identical dataset. Generator code lives in `internal/seeddemo/`.

The same binary also supports `-topup`, an incremental mode that appends new rows since each stream's last logged timestamp without wiping. Top-up is idempotent within a calendar day (re-running with the same `-now` is a no-op) and is what the demo bot's background top-up loop (`internal/demotopup`, started automatically when `DEMO_MODE=1`, configurable via `DEMO_TOPUP_INTERVAL`) calls on a ticker to keep the deployed dataset fresh. See [docs/demo-mode.md](docs/demo-mode.md#automatic-top-up).

Non-obvious patterns in the top-up path:
- **Per-tick RNG seed** is derived as `pcg(uint64(opts.Seed) XOR uint64(opts.Now.Unix()/86400))` so two ticks on the same calendar day produce the same candidate samples — idempotency holds on retry without consulting the DB.
- **Time-series cadence is anchored to 00:00 UTC** (15 min for HR/SpO2, 30 min for stress) so consecutive top-ups land on the same grid regardless of when each tick fires; UNIQUE PK `(user_id, date_time)` then makes `INSERT OR IGNORE` a free dedupe. The same cadence constants are reused server-side to downsample dense Mi Band `.nxk` imports in `internal/cloudserver/vitals_import.go` (`hrCadence`/`spo2Cadence`/`stressCadence`), so cloud-imported and seeded vitals land on the same grid.
- **`demotopup.Run` fires its first tick immediately on startup** (not after one interval) so a fresh deploy isn't stale until the first hour elapses.
- **Daily streams snap forward to "day after latest sample"** (`dailyTopUpFrom`), which means weight — on a weekly cadence — can add one row per tick. This is deliberate "near no-op within one sample interval" tolerance, not a bug.
- **`-topup` and explicit `-wipe` together is an error**, but the default `wipe=true` is force-cleared when `-topup` is passed alone — checked via `fs.Visit` so only operator-set `-wipe` trips the mutex guard.

```bash
# Full seed (wipes target user first):
go run ./cmd/seeddemo -user <telegram_user_id> -db meds.db -days 90 -wipe -seed 42

# Incremental top-up (no wipe; appends rows from each stream's last sample to now):
go run ./cmd/seeddemo -user <telegram_user_id> -db meds.db -topup -seed 42
```

## Code Layout

- `cmd/` — entry points (`bot`, `cloud`, `mcptool`, `mcpshim`, `importer`, `bpimporter`, `genvapid`, `seeddemo`, `feedbackpull`). `feedbackpull` is the dev/ops CLI that drains the cloud `feedback_queue`, age-decrypts each item with the developer's private key, prints text + metadata, and saves attachments — the only place the age private key lives (server stores ciphertext blindly). Imports `filippo.io/age` (not linked into the server binary).
- `internal/ai` — AI client (OpenAI-compatible)
- `internal/store` — per-domain SQLite repositories (one Go package per feature). `store.Repos` (alias: `store.Store`) is a thin aggregator wired in `cmd/bot/main.go` (and `cmd/mcptool`, `cmd/seeddemo`, `cmd/bpimporter`). Sub-packages:
  - `db/` — shared `*sql.DB` open/close + busy-timeout config, `WithTx` cross-repo transaction helper, goose migrations runner, unix-seconds time helpers.
  - `medication/` — medication CRUD + intake_log + restock + inventory.
  - `bp/`, `weight/`, `food/`, `workout/` (incl. mi-band), `vitals/` (sleep + day stats), `diary/`, `tz/` (timezone history + transition plans/steps), `settings/` (incl. download cursor + change_events), `auth/` (API tokens + login nonce), `push/` — one repo per feature, each with its own tests.
  - `migrations/` — embedded goose SQL files (plus a tiny Go re-export of the embed.FS so subpackage tests can mount the schema).
- `internal/server` — HTTP handlers
- `internal/bot` — Telegram bot — **thin channel layer only**
- `internal/domain` — business logic services (medication, exercise, reminder, food, food_ai)
  - `workout/` — workout session service (reference service pattern): session lifecycle (start/snooze/skip/complete/ad-hoc) plus the next-workout engine, stats, session listing/details, rotation, and exercise-log read/write models extracted from the HTTP handlers
- `internal/scheduler` — notification scheduler
- `internal/mcp` — MCP server. Sub-packages: `registry/` (allowlisted operation catalog), `proxy/` (in-process API proxy used by the executor), `executor/` (Python runner orchestration). The bridge endpoint that the proxy talks to lives in `internal/server/mcp_bridge.go`.
- `internal/rxnorm` — drug interaction checks
- `internal/webpush` — web push
- `internal/tzlookup` — geo-to-timezone (tzf, offline)
- `web/static/` — vanilla JS frontend, Dexie.js, Service Worker
- `python/` — `medtracker` helper package, sandboxed runner, and example scripts used by the `mcp_execute` tool. Tests live in `python/tests/` and `python/runner/`.
- `internal/cloudstore` — SQLite repo for `cmd/cloud` (accounts, credentials, envelopes, recovery verifier). Own migrations; imports only `internal/store/db`, never `internal/store` (goose-registry landmine — see [docs/cloud-mode.md](docs/cloud-mode.md))
- `internal/cloudserver` — HTTP handlers for `cmd/cloud`: wildcard host routing, WebAuthn registration/login ceremonies, envelope API, admin invite provisioning, encrypted oplog sync + snapshot compaction, push subscriptions + blind scheduled-push relay (sender goroutine + stale-sync warning sweep), per-account egress-host registration (`PUT /api/egress-hosts`). **CSP invariant:** the account app document (`/`) must never serve a wildcard `https:`/`wss:` `connect-src` — it emits a per-account allowlist (`'self'` + stored provider hosts + fixed `api.elevenlabs.io`). Enforced by `TestRouter_HostVariants` / `TestRouter_AppDocumentReflectsEgressHosts` in `router_test.go`. See [docs/cloud-crypto.md](docs/cloud-crypto.md).
- `web/cloud/` — embedded static shell (signup/unlock wizard, client-side crypto module, sync engine + local IndexedDB mirror, toy encrypted-notes UI, NK-aware service worker + push scheduler, `apishim.js` + `cloud-boot.js`) served by `cmd/cloud`; account subdomains now also serve the full `web/static` app, with the shell moved to `/unlock`
- `web/domain/` — **the domain layer**: pure ES modules taking injected ports (`records`, `now`, `timeZone`, …) with zero browser globals — `bp`, `weight`, `medications`, `intake`, `medschedule`, `reminders`, `tzplan`, `food`, `foodai`, `workout`, `vitals`, `notes`, `settings`, `tgcommand`, `vault`. `web/cloud/js/apishim.js` routes `/api/*` into them with no translation layer, and `mcp-responder.js` dispatches through that same router. Purity is enforced by `architecture.domain-purity.test.js`: nothing here may touch `window`, `document`, `fetch`, or IndexedDB. That rule is what keeps the layer embeddable outside a browser at all.

## Documentation Index

| Topic | File |
|-------|------|
| Architecture: components, data flows, sync, reminders, identity, MCP, and the generated-privacy-boundary rule | [docs/architecture.md](docs/architecture.md) |
| Demo mode (`DEMO_MODE=1`): public auth-less deployment, per-IP AI rate limits, seeded demo DB, MCP without OAuth | [docs/demo-mode.md](docs/demo-mode.md) |
| Feature behaviors (Today dashboard, meds, BP, weight, food, workouts, MCP) | [docs/features.md](docs/features.md) |
| Gamification design (HealthPoints, science-based, outcome-in-range scoring, insight ladder) — **design proposal, not yet implemented** | [docs/gamification.md](docs/gamification.md) |
| Workout depth (per-set logging → est-1RM/PR/graphs → opt-in progression; strength-logger parity; no social/watch/DSL) — **design proposal (epic med-qj4), Phase 1 in progress** | [docs/workout-depth.md](docs/workout-depth.md) |
| Cloud onboarding wizard (revives the existing `WGFirstRun` overlay in cloud mode via a vault-backed `first_run_complete`; step sequence, skip/resume, claim→app seam) — **design proposal, not yet implemented** | [docs/onboarding-wizard.md](docs/onboarding-wizard.md) |
| Cloud mode, per-subsystem: accounts/onboarding, key hierarchy, encrypted sync, blind push relay, Telegram sealed inbox, MCP tiers, BYO + trial provider keys, voice, export/import — **and the generated privacy boundary table** (canonical enumeration of what leaves the vault; source `web/cloud/js/privacy-manifest.js`, regenerate with `pnpm privacy:docs`, never hand-edit) | [docs/cloud-mode.md](docs/cloud-mode.md) |
| Canonical full-vault export/import format (one-user-all-domains JSON, wire-shape field names, skip list, round-trip normalizations, age encryption) — **v1 implemented (C2e)** | [docs/vault-format.md](docs/vault-format.md) |
| Cloud-mode crypto (passkey-only key management: WebAuthn PRF envelopes over a random DEK, device enrollment ceremonies, recovery code, formats) — **suite v1 implemented in `web/cloud/js/crypto.js`** | [docs/cloud-crypto.md](docs/cloud-crypto.md) |
| Cloud key rotation (compromised-device eviction: account key epoch, single-transaction DEK/NK rotation + fresh snapshot, surviving-device re-derivation, honest "cannot un-leak the past" UI copy) — **design proposal, not yet implemented** | [docs/cloud-key-rotation.md](docs/cloud-key-rotation.md) |
| Cloud deployment (self-hosted `cmd/cloud`: Traefik + Portainer infra layer, DNS-01 wildcard cert, gitops app stack, admin invite) | [docs/cloud-deployment.md](docs/cloud-deployment.md) |
| Cloud operations security, retention, backup, deletion propagation, per-feature subprocessor table, incident response (operator policy: what remains after deletion, for how long, where data was sent) | [docs/cloud-operations-security.md](docs/cloud-operations-security.md) |
| API endpoints | [docs/api.md](docs/api.md) |
| Environment variables | [docs/environment.md](docs/environment.md) |
| MCP server deployment (Pocket-ID, Docker, Claude config) | [docs/mcp-deployment.md](docs/mcp-deployment.md) |
| MCP coverage policy (every route covered by registry op or allowlist) | [docs/mcp-coverage.md](docs/mcp-coverage.md) |
| MCP agent-usage evals (does a real LLM drive mcp_help/mcp_call/mcp_execute to finish tasks) | [docs/mcp-evals.md](docs/mcp-evals.md) |
| Frontend architecture, load order, globals, design tokens, data flow | [docs/frontend.md](docs/frontend.md) |
| Technical decisions (SSE-first change stream + polling fallback, offline writes, 5xx-as-offline, vanilla JS) | [docs/technical-decisions.md](docs/technical-decisions.md) |
| SSE behind Traefik (labels, timeouts, deploy-time `RST_STREAM`, `initData` access-log caveat) | [docs/sse-traefik.md](docs/sse-traefik.md) |
| Installer | [docs/installer.md](docs/installer.md) |
| **Documentation map** — which docs are normative vs proposal vs historical, and the rules for changing them | [docs/README.md](docs/README.md) |
| **Threat model** (cloud): assets, trust boundaries, attacker model, what leaks by design, ranked residual risks | [docs/security/threat-model.md](docs/security/threat-model.md) |
| Release integrity — the operator serves the code that holds the DEK; what narrows that, and how to verify a deployment | [docs/security/release-integrity.md](docs/security/release-integrity.md) |
| Other security policies | [docs/security/](docs/security/) |

## Common Tasks

### Adding a new health metric

There is **no server-side schema change** — the server stores opaque records, so
a new metric is a new record type plus the browser code that understands it.

1. **Pick a record type and id convention.** A random recordId is fine unless
   two devices can independently materialize the same logical row — then use a
   deterministic id (`intake-<medId>-<slotUnix>`, `session-<groupId>-<date>`) so
   LWW converges instead of duplicating. Singletons get a fixed recordId.
2. **Write `web/domain/<feature>.js`** — `createXDomain({ records, now, timeZone })`,
   pure, injected ports only. `architecture.domain-purity.test.js` fails on any
   browser global.
3. **Route `/api/<feature>*` in `web/cloud/js/apishim.js`** to that domain. Keep
   the wire shape the UI already expects; the same shape is what the vault
   export stores.
4. **Add the UI in `web/static/`**, talking only to `/api/*`.
5. **Reminders?** Extend the horizon computation in `web/domain/reminders.js`
   and let the shim re-upload the replace-all schedule. The server cannot
   compute a schedule.
6. **Export/import**: add it to `web/domain/vault.js` and the golden fixture, or
   the round-trip test will not cover it and a restore will silently drop it.
7. **MCP**: register the operation in `internal/mcp/registry/`, run
   `go run ./cmd/genmcpcatalog`, and make sure the router in step 3 serves it —
   the responder dispatches through that same router, never its own branch.

The Go store/handler/scheduler path (`internal/store/`, `internal/server/`,
`internal/bot/`, `internal/scheduler/`) is not on the deployed path; its
conventions are in [docs/archive/architecture-bot-mode.md](docs/archive/architecture-bot-mode.md).
If you do change Go code there, it must keep building and passing tests.

Any new dose-like timestamp column (one that participates in SQL equality — dedupe, lookup by instant, etc.) must be stored as `INTEGER` unix-seconds-UTC, not as `DATETIME` text. Normalize via `t.UTC().Unix()` (or `storedb.TimeToUnix`) at the writer and `time.Unix(n, 0).UTC()` (or `storedb.UnixToTime`) at the reader. See [docs/archive/architecture-bot-mode.md → Time storage](docs/archive/architecture-bot-mode.md#time-storage); the convention is enforced cross-table by `TestDoseTimeColumnsAreInteger` in `internal/store/store_time_invariants_test.go` (current allowlist covers `intake_log.{scheduled,taken,snoozed_until}_at_unix` and `tz_transition_plans.{created,notified,approved}_at_unix`). When adding a new dose-like column, append it to the allowlist in the same test and to the package comment at the top of `internal/store/store.go`.

### Adding an MCP tool

For most new backend capabilities, prefer adding an entry to the operation registry (`internal/mcp/registry/`) so it becomes reachable from the discover-then-run surface — `mcp_help` (discover), `mcp_call` (one-shot single read/write, no script), and `mcp_execute` (multi-step Python scripts) — via the proxy → bridge path, with no new MCP tool registration required. When adding a read/list/get/overview op, also populate its `ResponseExample` (a small realistic JSON sample) so the discovery surface can show agents the output shape; `mcp_help` carries a stable `usage_protocol`, supports batch `operation_ids` (full entries) and `query` (compact matches, never auto-expanded to full schemas — see the comment in `internal/mcp/help.go`), and is mirrored by the preloadable `mcp://catalog` resource. Unknown-op denials return did-you-mean suggestions, and `mcp_call`/`mcp_execute` attach warn-only schema validation warnings (`registry.ValidateInput`) without blocking the call. Only add a top-level MCP tool when a granular tool has a clear standalone use case (e.g., `workout_log`'s natural-language inference). See [docs/mcp-deployment.md](docs/mcp-deployment.md#adding-mcp-tools), [docs/mcp-python-executor.md](docs/mcp-python-executor.md), and [docs/mcp-coverage.md](docs/mcp-coverage.md).

Adding a registry operation also means updating the **cloud** MCP catalog: `web/cloud/js/mcp-catalog.generated.js` is generated from `registry.DefaultOperations()` by `cmd/genmcpcatalog`. Run `go run ./cmd/genmcpcatalog` and commit the result, or add a reasoned entry to `catalogjs.Excluded` (same shape as `internal/server/mcp_coverage_exempt.go`). `internal/mcp/catalogjs/drift_test.go` fails CI otherwise — the regenerate-or-exempt sibling of the HTTP-route coverage guard.

A catalogued op must also be **routable in cloud mode**, and its route belongs in the shared router — `web/cloud/js/apishim.js`'s `createApiRouter` — never in `web/cloud/js/mcp-responder.js`. The responder dispatches every op by the catalog's own `method` + `path` through that router, so MCP and the cloud UI share one code path; a bespoke branch in the responder would be a second copy of domain logic. When the route needs behavior the domain layer lacks, add it to `web/domain/*.js` (purity-guarded by `architecture.domain-purity.test.js`). The coverage sweep in `web/cloud/js/tests/mcp-responder.test.js` fails CI naming any catalogued op the router cannot serve, and a companion test asserts each op's `ResponseExample` shape — so an example must be copied from the handler's real JSON, not hand-written from memory. See [docs/cloud-mode.md](docs/cloud-mode.md).

### Adding an egress path (a proxy, an upstream host, or server-side plaintext)

`web/cloud/js/privacy-manifest.js` is the single source of truth for what leaves the vault. `docs/cloud-mode.md`'s privacy boundary table is **generated** from it (`pnpm privacy:docs`) and Settings → *What can the operator see?* is derived from it. `web/cloud/js/tests/architecture.privacy-claims.test.js` scans the real call sites — outbound HTTP / `proxyUpstream` / `webpush.Send` / `tgclient.` / `SealAndQueue` / `nxk.` in `internal/cloudserver/*.go`, plus every literal third-party host in the Go and `web/cloud/js` sources — and fails CI on anything no manifest entry claims. So: add the entry (every field, real `file:line` evidence, user-facing `userCopy`), run `pnpm privacy:docs`, commit the regenerated table. Do not flatten the activation classes — the operator-default food DB and RxNav have no toggle, and RxNav has no BYO alternative.

### Adding a new HTTP route

Every backend route registered on the server MUST be either reachable via the MCP operation registry OR explicitly listed in `internal/server/mcp_coverage_exempt.go` with a `Reason`. The guard test `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` enforces this — adding a new `apiMux.HandleFunc(...)` line and shipping without one of these will fail CI. For routes that are user-actionable, register an `Operation` (with description + schemas + path_params if applicable) in `internal/mcp/registry/operations_<topic>.go`. For routes that are UI shell, auth, bootstrap/sync, web-push subscription, settings/feature toggles, or internal MCP plumbing, add an entry to `mcpCoverageExempt`. See [docs/mcp-coverage.md](docs/mcp-coverage.md) for the full policy.

### Modifying workout rotation

- Core logic: `internal/store/workout/repo.go` (`AdvanceRotation`)
- Scheduler integration: `internal/scheduler/workout.go`
- Bot callbacks: `internal/bot/workout_callbacks.go`
- Tests: `internal/store/workout/workout_test.go`

### Adding a local-first read to a feature module

When a screen needs to render cached data offline (or behind a 5xx proxy), route the read through `window.cachedFetch` and surface freshness via `<wg-stale-badge>` instead of writing a new ad-hoc cache fallback. See [docs/frontend.md → Local-First Read Resilience](docs/frontend.md#local-first-read-resilience).

1. Replace the direct `apiCall(url)` with `await window.cachedFetch(key, url, { tags, freshAfterMs, staleAfterMs, transform })` — returns `{ data, fetchedAt, isFromCache, isStale }`. Pick a `key` that matches the bootstrap apply path in `app.js` if one exists, so the bootstrap-warmed cache is reused.
2. Catch `window.OfflineNoCacheError` and render an explicit empty state (e.g., "No cached data — connect to load"). Never let it bubble to the console.
3. Mount the freshness chip into the section header: `await window.WGStaleBadge.mountFromKey({ slot, key })`. For sections that don't go through `cachedFetch` (BP/Weight/Meds/Workouts/Vitals still use `offlineAwareApiCall`), `mountFromKey` reads the bootstrap-warmed timestamp directly.
4. Tests (Vitest): one case for warm-cache offline render (asserts data + `Offline · …` chip), one for `OfflineNoCacheError` empty state. Reference: `web/static/js/tests/food.offline-cached-fetch.test.js`, `sections.stale-badge.test.js`.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
