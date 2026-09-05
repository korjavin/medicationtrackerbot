# CLAUDE.md

Guidance for Claude Code in this repo. This file is an index — detail lives in `docs/`; [docs/README.md](docs/README.md) maps which docs are normative vs proposal vs history, [docs/architecture.md](docs/architecture.md) is the starting point.

## Project Overview

Self-hosted health-tracking PWA (meds, BP, weight, workouts, sleep, food, diary) built around a **zero-knowledge vault**. `cmd/cloud` is the product: the browser holds the vault keys, plaintext, and all domain logic; the server stores encrypted sync state and operates relays. The few integrations that deliberately leave the vault are enumerated in [docs/cloud-mode.md → Privacy boundary](docs/cloud-mode.md#privacy-boundary--the-vault-promise-and-its-carve-outs).

## Critical Rules

1. **Domain logic lives in one place per runtime.** In the browser: `web/domain/*.js` — pure ES modules with injected ports, no browser globals (enforced by `architecture.domain-purity.test.js`). `web/cloud/js/apishim.js` and `mcp-responder.js` only route into it. (Go side: `internal/domain/*` service pattern, [docs/archive/architecture-bot-mode.md](docs/archive/architecture-bot-mode.md#domain-service-pattern).)
2. **Never modify existing migrations** — add new ones in `internal/store/migrations/`.
3. **No hardcoded colors or inline `.style.` assignments in frontend code.** All visual values come from `--wg-*` design tokens + CSS classes; architecture tests enforce. See [docs/frontend.md](docs/frontend.md#design-tokens).
4. **New `window.*` globals need an allowlist entry** in `tests/architecture.globals.test.js` with justification.
5. **Use `log/slog` with contextual args**, not `log.Printf`.
6. **The bottom nav is the canonical navigation** — one slot per section (row 1: Today, BP, Food, Meds — row 2: Vitals, Workouts, Weight, Settings). The Vitals slot keeps internal id `health` for deeplink/localStorage stability. No "More" aggregator; disabled features are filtered out before mount; no `section-header-mount` banners. `<wg-phone-chrome>` exists but is not yet wrapped around screens at runtime. See [docs/frontend.md](docs/frontend.md#navigation).
7. **Merge PRs with `gh pr merge --merge`**, never `--squash` or `--rebase`.
8. **Frontend tests are integration-first.** Add behavior to the owning feature suite via `tests/helpers/frontend-harness.js`; no coverage-driven `*-branches`/`*-edges` files, no standalone `pin-defect-N`/`task-N` files. Pure-unit tests only for layers without an integration entry point. See [docs/frontend.md → Testing posture](docs/frontend.md#testing-posture).
9. **Frontend write handlers MUST use `DataStore.applyOptimistic`** (commit/rollback), never `invalidateTags + loadX()` — that pattern is only for read-only refreshes and the rollback path. See [docs/frontend.md → Optimistic Write Updates](docs/frontend.md#optimistic-write-updates).
10. **Device-capability access routes through `web/static/js/native/`** (`window.MediaCapture` / `window.Barcode`), never raw `getUserMedia`/`BarcodeDetector`. Enforced by `tests/architecture.native-abstractions.test.js`, no allowlist; `window.Capacitor`/`isNativePlatform` banned everywhere. New capability: `native/<cap>.js` + `registerImpl` + `tests/native.<cap>.test.js`. See [docs/frontend.md → Device-Capability Abstractions](docs/frontend.md#device-capability-abstractions).
11. **The app document must not surface Telegram** — no `<script src="https://telegram.org/...">` in `web/static/index.html` (SDK is runtime-injected by `messenger-adapter.js`, skipped in cloud mode) and no Telegram login screen in cloud (`checkAuth()` short-circuits on `window.__MEDTRACKER_CLOUD__`). Enforced by `architecture.no-telegram-in-html.test.js`.
12. **A read path that lazily materializes a record into a deterministic recordId must stamp it `clientTs: 0` and write it via `records.putIfAbsent`**, never `now()` + `put` — otherwise a device with a stale mirror re-derives that recordId in its initial state and LWW erases the real one (a confirmed dose reverting to Pending, bd med-d4w; a completed workout deleted, bd med-9a87), and even a floored row gets promoted over whatever raw row already sits in the slot (bd med-qhpu). Ask: *could a device that hasn't synced recently create this same recordId?* If yes, it is derived state, takes the floor, and never overwrites the slot. `putIfAbsent` treats a **tombstone as occupied**, so no delete path may rely on re-materialization to undo itself (`workout.js`'s `nextVariant` replaces the slot instead of deleting it). `medintake.js`'s dose sweep is the one materializer still on plain `put`. Read/timer-side read-modify-writes on singleton records are a related open hazard (bd med-y4ue). See [docs/cloud-mode.md → Sync protocol](docs/cloud-mode.md#sync-protocol) guard 3 + the incident write-up.

## Build

Plain `go build ./...` — no build tags. **`cmd/cloud` is the only shipped binary** (`Dockerfile` builds and runs only `./cloud`). Everything else under `cmd/` is dev/operator tooling, plus `cmd/bot` and `cmd/installer` which are **not built, shipped, or deployed** — their source must keep compiling and passing `go test ./...` so it cannot rot, and no doc may present them as deployment targets. The Capacitor Android shell was removed (branch `mobile` preserves it). `DEMO_MODE` is not a cloud flag — nothing in `cmd/cloud` reads it ([docs/archive/demo-mode.md](docs/archive/demo-mode.md)).

Config layering: env var → settings table → built-in default (`internal/config`: `LoadFromEnv` + `LoadFromSettings` + `Merge`). User-editable provider keys (OpenAI, Food DB, ElevenLabs) live in the settings row, editable via Settings → Integrations.

## Development Commands

```bash
go run ./cmd/cloud                    # run the service
go test ./...                         # must stay green tree-wide, cmd/bot included
pnpm test                             # frontend (Vitest + jsdom)
pnpm privacy:docs                     # regenerate privacy boundary table after editing the manifest
go run ./cmd/genmcpcatalog            # regenerate cloud MCP catalog after registry changes
scripts/ci-local.sh                   # optional: act-friendly CI subset locally (workflow changes / green-here-red-there only)
docker compose -f docker-compose.cloud.yml up
```

Data import tools: `cmd/importer` (JSON export), `cmd/bpimporter` (CSV), `cmd/genvapid` (web-push keys). `cmd/seeddemo` seeds N days of deterministic synthetic demo data (`-wipe -seed 42 -days 90`) or incrementally tops up (`-topup`, idempotent within a calendar day); generator in `internal/seeddemo/`, top-up loop in `internal/demotopup` — non-obvious cadence/idempotency invariants are commented there and in [docs/archive/demo-mode.md](docs/archive/demo-mode.md#automatic-top-up).

## Code Layout

- `cmd/` — entry points; `feedbackpull` is the only place the age private key lives (drains + decrypts the cloud `feedback_queue`; server stores ciphertext blindly).
- `internal/store` — per-domain SQLite repos (one package per feature) + `db/` (shared open/`WithTx`/goose runner/time helpers) + `migrations/`. Aggregator `store.Repos` wired in `cmd/bot`, `cmd/mcptool`, `cmd/seeddemo`, `cmd/bpimporter`.
- `internal/server`, `internal/bot` (thin channel layer), `internal/domain` (services; `workout/` is the reference pattern), `internal/scheduler` — the legacy bot-mode path; not deployed, must keep building.
- `internal/mcp` — MCP server: `registry/` (op catalog), `proxy/`, `executor/`; bridge endpoint in `internal/server/mcp_bridge.go`.
- `internal/ai`, `internal/rxnorm`, `internal/webpush`, `internal/tzlookup` — clients/helpers.
- `internal/cloudstore` — SQLite repo for `cmd/cloud`; own migrations; imports only `internal/store/db`, **never `internal/store`** (goose-registry landmine — [docs/cloud-mode.md](docs/cloud-mode.md)).
- `internal/cloudserver` — cloud HTTP: wildcard host routing, WebAuthn ceremonies, envelope API, encrypted oplog sync + snapshot compaction, blind push relay, per-account egress hosts. **CSP invariant:** the account app document must never serve wildcard `https:`/`wss:` `connect-src` — per-account allowlist only; enforced by `TestRouter_HostVariants` / `TestRouter_AppDocumentReflectsEgressHosts` in `router_test.go`.
- `web/static/` — vanilla JS frontend, Dexie, Service Worker.
- `web/cloud/` — cloud shell (unlock wizard at `/unlock`, crypto module, sync engine, `apishim.js`, service worker); account subdomains serve the full `web/static` app.
- `web/domain/` — **the domain layer**: pure ES modules, injected ports, zero browser globals (purity-enforced); `apishim.js` routes `/api/*` into it and `mcp-responder.js` dispatches through the same router.
- `python/` — `medtracker` helper package + sandboxed runner for `mcp_execute`.

## Documentation Index

| Topic | File |
|-------|------|
| Architecture (components, sync, reminders, identity, MCP) | [docs/architecture.md](docs/architecture.md) |
| Feature behaviors | [docs/features.md](docs/features.md) |
| Gamification — **proposal, not implemented** | [docs/gamification.md](docs/gamification.md) |
| Workout depth — **proposal (epic med-qj4), Phase 1 in progress** | [docs/workout-depth.md](docs/workout-depth.md) |
| Cloud onboarding wizard — **proposal, not implemented** | [docs/onboarding-wizard.md](docs/onboarding-wizard.md) |
| Cloud mode per-subsystem + **generated privacy boundary table** (source `web/cloud/js/privacy-manifest.js`, regen `pnpm privacy:docs`, never hand-edit) | [docs/cloud-mode.md](docs/cloud-mode.md) |
| Vault export/import format — **v1 implemented** | [docs/vault-format.md](docs/vault-format.md) |
| Cloud crypto (passkey/PRF envelopes over DEK) — **implemented in `web/cloud/js/crypto.js`** | [docs/cloud-crypto.md](docs/cloud-crypto.md) |
| Cloud key rotation — **proposal, not implemented** | [docs/cloud-key-rotation.md](docs/cloud-key-rotation.md) |
| Cloud deployment (Traefik + Portainer, wildcard cert, gitops) | [docs/cloud-deployment.md](docs/cloud-deployment.md) |
| Cloud operations security (retention, backup, deletion, subprocessors, incidents) | [docs/cloud-operations-security.md](docs/cloud-operations-security.md) |
| Environment variables | [docs/environment.md](docs/environment.md) |
| MCP agent-usage evals | [docs/mcp-evals.md](docs/mcp-evals.md) |
| Frontend architecture, load order, tokens, data flow | [docs/frontend.md](docs/frontend.md) |
| Technical decisions (offline writes, 5xx-as-offline, vanilla JS) | [docs/technical-decisions.md](docs/technical-decisions.md) |
| Threat model / release integrity / other policies | [docs/security/](docs/security/) |
| Archived bot-mode runbooks (API routes, MCP deployment/coverage/executor, SSE, demo mode) | [docs/archive/](docs/archive/) |

## Common Tasks

### Adding a new health metric

No server-side schema change — the server stores opaque records; a new metric is a record type plus browser code.

1. Pick a record-id convention: deterministic id (`intake-<medId>-<slotUnix>`) when two devices can materialize the same logical row (LWW convergence), fixed id for singletons, random otherwise.
2. Write `web/domain/<feature>.js` — pure, injected ports only (`createXDomain({ records, now, timeZone })`).
3. Route `/api/<feature>*` in `web/cloud/js/apishim.js`; keep the wire shape the UI expects (the vault export stores the same shape).
4. Add the UI in `web/static/`, talking only to `/api/*`.
5. Reminders: extend the horizon computation in `web/domain/reminders.js`; the server cannot compute schedules.
6. Export/import: add to `web/domain/vault.js` **and the golden fixture**, or the round-trip test won't cover it and restore silently drops it.
7. MCP: register the op in `internal/mcp/registry/`, run `go run ./cmd/genmcpcatalog`; the responder dispatches through the same router as step 3.

Any new dose-like timestamp column (participates in SQL equality) must be `INTEGER` unix-seconds-UTC, not `DATETIME` text — normalize via `storedb.TimeToUnix`/`UnixToTime`. Enforced by `TestDoseTimeColumnsAreInteger` (`internal/store/store_time_invariants_test.go`); new columns go in that allowlist and the `internal/store/store.go` package comment.

### Adding an MCP tool

Prefer a registry op (`internal/mcp/registry/`) over a new top-level tool — it becomes reachable via `mcp_help`/`mcp_call`/`mcp_execute` with no new registration. Populate `ResponseExample` for read ops (copied from the handler's real JSON — a test asserts the shape). `mcp_execute` has **no cloud path**; a registry op is the only surface that reaches cloud. Then:

- Regenerate `web/cloud/js/mcp-catalog.generated.js` (`go run ./cmd/genmcpcatalog`) or add a reasoned `catalogjs.Excluded` entry — `internal/mcp/catalogjs/drift_test.go` fails CI otherwise.
- The op must be routable in cloud via `apishim.js`'s `createApiRouter` — **never** a bespoke branch in `mcp-responder.js`. Missing routes fail CI in `web/cloud/js/tests/mcp-responder.test.js`. Behavior the domain layer lacks goes in `web/domain/*.js`.

Details: [docs/architecture.md §7](docs/architecture.md#7-mcp); archived runbooks in [docs/archive/](docs/archive/).

### Adding an egress path

`web/cloud/js/privacy-manifest.js` is the single source of truth for what leaves the vault; the docs table and Settings copy are generated from it. `architecture.privacy-claims.test.js` scans real call sites and third-party host literals and fails CI on anything unclaimed. Add the manifest entry (with `file:line` evidence and `userCopy`), run `pnpm privacy:docs`, commit the regenerated table. Don't flatten activation classes (food DB and RxNav have no toggle; RxNav has no BYO).

### Adding a new HTTP route

A cloud route = `internal/cloudserver` route **plus** the `apishim.js` route that answers it in the browser (the server only moves ciphertext). Agent-reachable → add a registry op and regenerate the catalog. On the legacy Go server, `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` still enforces registry-or-exempt (`internal/server/mcp_coverage_exempt.go`, with `Reason`) — read [docs/archive/mcp-coverage.md](docs/archive/mcp-coverage.md) before silencing it.

### Adding a local-first read

Route reads through `window.cachedFetch(key, url, {...})` and mount `<wg-stale-badge>` via `WGStaleBadge.mountFromKey`; catch `window.OfflineNoCacheError` with an explicit empty state. Tests: warm-cache offline render + no-cache empty state (reference: `food.offline-cached-fetch.test.js`). See [docs/frontend.md → Local-First Read Resilience](docs/frontend.md#local-first-read-resilience).

## Issue Tracking

Issue tracking uses **bd** (beads); run `bd prime` for workflow context. Use bd for all task tracking — not TodoWrite or markdown TODO lists.
