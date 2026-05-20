# CLAUDE.md

Guidance for Claude Code working in this repository. This file is an index — detailed topics live in `docs/`.

## Project Overview

A self-hosted Telegram Mini App for comprehensive health tracking (medications, blood pressure, weight, workouts, sleep, food, diary). A single Go binary serves the Telegram Bot + web server + scheduler; the frontend is vanilla JavaScript.

**Philosophy**: single source of truth for health metrics, with both a rich web interface and a minimalist chat interface. Self-hosted for real data ownership.

## Critical Rules

1. **Domain service pattern is mandatory.** Bot callbacks and HTTP handlers may only call `internal/domain/*` services (plus Telegram / HTTP transport). No direct store calls for business logic — both transports must share the same code path. See [docs/architecture.md](docs/architecture.md#domain-service-pattern).
2. **Never modify existing migrations.** Always add new ones in `internal/store/migrations/`.
3. **No hardcoded colors or inline `.style.` assignments in frontend code.** Use design tokens and CSS classes. All visual values come from `--wg-*` tokens (Wandergeek system). Architecture tests enforce this. See [docs/frontend.md](docs/frontend.md#design-tokens).
4. **New `window.*` globals require an allowlist entry** in `tests/architecture.globals.test.js` with justification.
5. **Use `log/slog` with contextual args** (`slog.Error("msg", "error", err)`), not `log.Printf`.
6. **The bottom nav is the canonical navigation** — one slot per real section (row 1: Today, BP, Food, Meds — row 2: Vitals, Workouts, Weight, Settings). The Vitals slot keeps its internal id `health` for deeplink / localStorage stability; only the label is "Vitals". No "More" aggregator: every section is a first-class destination with its own icon. Disabled features are filtered out of the nav before mount, not bounced after tap. Screens sit directly on the teal stage — no `section-header-mount` banners. `<wg-phone-chrome>` is a design-system primitive available for Phase 3+ screen reskins; it is not yet wrapped around screens at runtime. See [docs/frontend.md](docs/frontend.md#navigation).
7. **Merge PRs with `gh pr merge --merge`** (regular merge commit), never `--squash` or `--rebase`. The project's history uses merge commits to preserve feature-branch context.
8. **Frontend tests are integration-first.** New behavior is added to the owning feature suite (`features.*` or `<feature>.<aspect>.test.js`) through `tests/helpers/frontend-harness.js`. Do not add coverage-driven `*-branches` / `*-edges` / `*-characterization` files, and do not create standalone `pin-defect-N` or `task-N` files — extend the feature's existing `describe` block instead. Pure-unit tests are reserved for layers without an integration entry point (web components, DB, SW, sync, cached-fetch). See [docs/frontend.md → Testing posture](docs/frontend.md#testing-posture).
9. **Frontend write handlers MUST use `DataStore.applyOptimistic`**, never `invalidateTags + loadX()`. Optimistic state repaints the UI before the POST resolves; `commit(serverPayload)` reconciles on success, `rollback()` restores prior cache and invalidates tags on failure. The `invalidateTags + loadX()` pattern is reserved for read-only refreshes (e.g. `invalidateWorkoutCache`) and the rollback path itself. See [docs/frontend.md → Optimistic Write Updates](docs/frontend.md#optimistic-write-updates).

## Build Modes

The codebase compiles in two modes via the `//go:build mobile` build tag:

- **Server build (default)** — `go build ./...` — wires the Telegram bot, MCP server, web-push, OIDC, and ElevenLabs handlers. This is the production deployment.
- **Mobile build** — `go build -tags mobile ./...` — strips bot/MCP/web-push/OIDC at compile time, substitutes `LocalUserResolver` (single user) for the auth resolver, and uses `LocalNotificationSink` (queue + `GET /api/reminders/upcoming`) instead of `WebPushSink`. Targets the Capacitor wrapper. See [docs/local-mode.md](docs/local-mode.md).

Configuration layering: env var → settings table → built-in default. The `internal/config` package owns `LoadFromEnv` + `LoadFromSettings` + `Merge`. User-editable provider keys (OpenAI, Food DB, ElevenLabs) live in the singleton settings row and are reachable via the Settings UI's Integrations section.

Tagged files are limited to wiring seams: `cmd/bot/main_{server,mobile}.go`, `internal/scheduler/sink_{webpush,localnotifications}.go`, `internal/server/auth/resolver_{telegram,local}.go`. Domain services, the store, HTTP handlers, and the frontend are tag-free.

## Development Commands

```bash
# Run the main bot + web server
go run ./cmd/bot

# Run the MCP server
go run ./cmd/mcptool

# Run all tests
go test ./...

# Run a specific package
go test ./internal/store
go test -v ./internal/server -run TestBPHandlers

# Frontend tests (Vitest + jsdom)
pnpm test

# Docker
docker build -t medtracker .
docker-compose up
```

### Data import tools

```bash
go run cmd/importer/main.go   -file export.json -user <telegram_user_id> -db meds.db
go run cmd/bpimporter/main.go -file bp_data.csv -db meds.db
go run cmd/genvapid/main.go                                   # VAPID keys for web push
```

#### Demo data seeder

`cmd/seeddemo` wipes a target user's data and seeds N days (default 90) of synthetic, varied health-tracking data so the app can be demoed: medications with overlapping courses, BP/weight/sleep time series with visible trends, food logs hitting and missing targets, planned + ad-hoc workouts, diary notes, and a mid-period timezone change. Deterministic by default (seedable RNG) so re-running with the same seed produces an identical dataset. Generator code lives in `internal/seeddemo/`.

```bash
go run ./cmd/seeddemo -user <telegram_user_id> -db meds.db -days 90 -wipe -seed 42
```

## Code Layout

- `cmd/` — entry points (`bot`, `mcptool`, `importer`, `bpimporter`, `genvapid`, `seeddemo`)
- `internal/ai` — AI client (OpenAI-compatible)
- `internal/store` — per-domain SQLite repositories (one Go package per feature). `store.Repos` (alias: `store.Store`) is a thin aggregator wired in `cmd/bot/main.go` (and `cmd/mcptool`, `cmd/seeddemo`, `cmd/bpimporter`). Sub-packages:
  - `db/` — shared `*sql.DB` open/close + busy-timeout config, `WithTx` cross-repo transaction helper, goose migrations runner, unix-seconds time helpers.
  - `medication/` — medication CRUD + intake_log + restock + inventory.
  - `bp/`, `weight/`, `food/`, `workout/` (incl. mi-band), `vitals/` (sleep + day stats), `diary/`, `tz/` (timezone history + transition plans/steps), `settings/` (incl. download cursor + change_events), `auth/` (API tokens + login nonce), `push/` — one repo per feature, each with its own tests.
  - `migrations/` — embedded goose SQL files (plus a tiny Go re-export of the embed.FS so subpackage tests can mount the schema).
- `internal/server` — HTTP handlers
- `internal/bot` — Telegram bot — **thin channel layer only**
- `internal/domain` — business logic services (medication, exercise, reminder, food, food_ai)
- `internal/workout` — workout session service (reference service pattern)
- `internal/scheduler` — notification scheduler
- `internal/mcp` — MCP server. Sub-packages: `registry/` (allowlisted operation catalog), `proxy/` (in-process API proxy used by the executor), `executor/` (Python runner orchestration). The bridge endpoint that the proxy talks to lives in `internal/server/mcp_bridge.go`.
- `internal/rxnorm` — drug interaction checks
- `internal/webpush` — web push
- `internal/tzlookup` — geo-to-timezone (tzf, offline)
- `web/static/` — vanilla JS frontend, Dexie.js, Service Worker
- `python/` — `medtracker` helper package, sandboxed runner, and example scripts used by the `mcp_execute` tool. Tests live in `python/tests/` and `python/runner/`.

## Documentation Index

| Topic | File |
|-------|------|
| Architecture, code structure, DB schema, auth, domain services, scheduler, logging, testing | [docs/architecture.md](docs/architecture.md) |
| Local-only (Capacitor mobile) build, `//go:build mobile` boundary, env→settings layering, Phase 2 roadmap | [docs/local-mode.md](docs/local-mode.md) |
| Feature behaviors (Today dashboard, meds, BP, weight, food, workouts, MCP) | [docs/features.md](docs/features.md) |
| API endpoints | [docs/api.md](docs/api.md) |
| Environment variables | [docs/environment.md](docs/environment.md) |
| MCP server deployment (Pocket-ID, Docker, Claude config) | [docs/mcp-deployment.md](docs/mcp-deployment.md) |
| MCP coverage policy (every route covered by registry op or allowlist) | [docs/mcp-coverage.md](docs/mcp-coverage.md) |
| Frontend architecture, load order, globals, design tokens, data flow | [docs/frontend.md](docs/frontend.md) |
| Technical decisions (SSE-first change stream + polling fallback, offline writes, 5xx-as-offline, vanilla JS) | [docs/technical-decisions.md](docs/technical-decisions.md) |
| SSE behind Traefik (labels, timeouts, deploy-time `RST_STREAM`, `initData` access-log caveat) | [docs/sse-traefik.md](docs/sse-traefik.md) |
| Installer | [docs/installer.md](docs/installer.md) |
| Security policies | [docs/security/](docs/security/) |
| Threat model | [threat-model.md](threat-model.md) |

## Common Tasks

### Adding a new health metric

1. Create migration in `internal/store/migrations/`
2. Create a new `internal/store/<feature>/` repo following the `diary` / `push` pattern: a `Repo` struct that holds `*db.DB`, a `New(*db.DB) *Repo` constructor, and per-method receivers (`func (r *Repo) …`). Add types alongside their owner repo (e.g. `type Foo struct` lives in the same package as `Repo`). Wire the new repo into `store.Repos` in `internal/store/store.go`.
3. Create a domain service in `internal/domain/` (see [docs/architecture.md](docs/architecture.md#domain-service-pattern))
4. Add HTTP handlers in `internal/server/`
5. Add bot commands in `internal/bot/` — call the domain service only
6. Add frontend UI in `web/static/`
7. Add scheduler logic in `internal/scheduler/` if reminders are needed

Any new dose-like timestamp column (one that participates in SQL equality — dedupe, lookup by instant, etc.) must be stored as `INTEGER` unix-seconds-UTC, not as `DATETIME` text. Normalize via `t.UTC().Unix()` (or `storedb.TimeToUnix`) at the writer and `time.Unix(n, 0).UTC()` (or `storedb.UnixToTime`) at the reader. See [docs/architecture.md → Time storage](docs/architecture.md#time-storage); the convention is enforced cross-table by `TestDoseTimeColumnsAreInteger` in `internal/store/store_time_invariants_test.go` (current allowlist covers `intake_log.{scheduled,taken,snoozed_until}_at_unix` and `tz_transition_plans.{created,notified,approved}_at_unix`). When adding a new dose-like column, append it to the allowlist in the same test and to the package comment at the top of `internal/store/store.go`.

### Adding an MCP tool

For most new backend capabilities, prefer adding an entry to the operation registry (`internal/mcp/registry/`) so it becomes reachable from `mcp_execute` Python scripts via the proxy → bridge path — no new MCP tool registration required. Only add a top-level MCP tool when a granular tool has a clear standalone use case (e.g., `workout_log`'s natural-language inference). See [docs/mcp-deployment.md](docs/mcp-deployment.md#adding-mcp-tools), [docs/mcp-python-executor.md](docs/mcp-python-executor.md), and [docs/mcp-coverage.md](docs/mcp-coverage.md).

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
