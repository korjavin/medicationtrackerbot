# CLAUDE.md

Guidance for Claude Code in this repo. This file is an index — detail lives in `docs/`; [docs/README.md](docs/README.md) maps which docs are normative vs proposal vs history, [docs/architecture.md](docs/architecture.md) is the starting point.

## Project Overview

Self-hosted health-tracking PWA (meds, BP, weight, workouts, sleep, food, diary) built around a **zero-knowledge vault**. `cmd/cloud` is the product: the browser holds the vault keys, plaintext, and all domain logic; the server stores encrypted sync state and operates relays. The few integrations that deliberately leave the vault are enumerated in [docs/cloud-mode.md → Privacy boundary](docs/cloud-mode.md#privacy-boundary--the-vault-promise-and-its-carve-outs).

## Critical Rules

1. **Domain logic lives in one place per runtime.** In the browser: `web/domain/*.js` — pure ES modules with injected ports, no browser globals (enforced by `architecture.domain-purity.test.js`). `web/cloud/js/apishim.js` and `mcp-responder.js` only route into it.
2. **Never modify existing migrations** — add new ones in `internal/cloudstore/migrations/`.
3. **No hardcoded colors or inline `.style.` assignments in frontend code.** All visual values come from `--wg-*` design tokens + CSS classes; architecture tests enforce. See [docs/frontend.md](docs/frontend.md#design-tokens).
4. **New `window.*` globals need an allowlist entry** in `web/static/js/tests/architecture.globals.test.js` with justification.
5. **Use `log/slog` with contextual args**, not `log.Printf`.
6. **The bottom nav is the canonical navigation** — one slot per section (row 1: Today, BP, Food, Meds — row 2: Vitals, Workouts, Weight, Settings). The Vitals slot keeps internal id `health` for deeplink/localStorage stability. No "More" aggregator; disabled features are filtered out before mount. `<wg-phone-chrome>` exists but is not yet wrapped around screens at runtime. See [docs/frontend.md](docs/frontend.md#navigation).
7. **Merge PRs with `gh pr merge --merge`**, never `--squash` or `--rebase`.
8. **Frontend tests are integration-first.** Add behavior to the owning feature suite via `web/static/js/tests/helpers/frontend-harness.js`; no coverage-driven `*-branches`/`*-edges` files, no standalone `pin-defect-N`/`task-N` files. Pure-unit tests only for layers without an integration entry point. See [docs/frontend.md → Testing posture](docs/frontend.md#testing-posture).
9. **Frontend write handlers MUST use `DataStore.applyOptimistic`** (commit/rollback), never `invalidateTags + loadX()` — that pattern is only for read-only refreshes and the rollback path. See [docs/frontend.md → Optimistic Write Updates](docs/frontend.md#optimistic-write-updates).
10. **Device-capability access routes through `web/static/js/native/`** (`window.MediaCapture` / `window.Barcode`), never raw `getUserMedia`/`BarcodeDetector`. Enforced by `web/static/js/tests/architecture.native-abstractions.test.js`, no allowlist; `window.Capacitor`/`isNativePlatform` banned everywhere. New capability: `native/<cap>.js` + `registerImpl` + `web/static/js/tests/native.<cap>.test.js`. See [docs/frontend.md → Device-Capability Abstractions](docs/frontend.md#device-capability-abstractions).
11. **The served app has no Telegram client.** No Telegram CDN host in `web/static/index.html` or `web/static/js` (enforced by `architecture.no-telegram-in-html.test.js`); cloud's Telegram integration lives in `web/cloud/js/telegram.js` (browser onboarding flow) backed by `internal/tgclient` (server-side Bot API client).
12. **Derived writes take the floor**: a read path that lazily materializes a record into a deterministic recordId stamps `clientTs: 0` and writes via `records.putIfAbsent`, never `now()` + `put`. Full rule, caveats, and floored-writer list: [docs/cloud-mode.md → Sync protocol](docs/cloud-mode.md#sync-protocol) guard 3.

## Build

Plain `go build ./...` — no build tags. **`cmd/cloud` is the only shipped binary** (`Dockerfile` builds and runs only `./cloud`); everything else under `cmd/` is dev/operator tooling (see Code Layout).

Cloud configuration is environment variables — see [docs/environment.md](docs/environment.md).

## Development Commands

```bash
go run ./cmd/cloud                    # run the service
go test ./...                         # must stay green tree-wide
pnpm test                             # frontend (Vitest + jsdom)
pnpm privacy:docs                     # regenerate privacy boundary table after editing the manifest
go run ./cmd/genmcpcatalog            # regenerate cloud MCP catalog after registry changes
scripts/ci-local.sh                   # optional: act-friendly CI subset locally (workflow changes / green-here-red-there only)
docker compose -f docker-compose.cloud.yml up
```

Catalog/key tooling: `cmd/genvapid` (VAPID keys for the push relay), `cmd/openfoodfacts` (food-DB CSV import), `cmd/genexercisecatalog` (exercise-catalog regen).

## Code Layout

- `cmd/` — entry points. `cloud` is the product; the rest is dev/operator tooling: `feedbackpull` drains + decrypts the cloud `feedback_queue` (the only place the age private key lives; server stores ciphertext blindly), `genmcpcatalog` renders `web/cloud/js/mcp-catalog.generated.js` from the registry, `genexercisecatalog` regenerates `web/static/data/exercises-catalog.json`, `genvapid` mints VAPID keys, `mcpshim` is the local half of the MCP blind relay, `openfoodfacts` imports the food-DB CSV.
- `internal/store/db` — shared SQLite open/`WithTx`/time helpers used by `internal/cloudstore`.
- `internal/domain/nxk` — Mi Band `.nxk` backup parser, used by `internal/cloudserver` (Telegram-attachment and vitals imports).
- `internal/mcp` — `registry/` (op catalog, source of truth for the cloud catalog) + `catalogjs/` (generator + drift test: `TestCloudCatalog_GeneratedFileIsUpToDate` fails CI when the checked-in catalog is stale).
- `internal/cloudstore` — SQLite repo for `cmd/cloud`; own migrations in `internal/cloudstore/migrations/`; built on `internal/store/db`.
- `internal/cloudserver` — cloud HTTP: wildcard host routing, WebAuthn ceremonies, envelope API, encrypted oplog sync + snapshot compaction, blind push relay, per-account egress hosts. **CSP invariant:** the account app document must never serve wildcard `https:`/`wss:` `connect-src` — per-account allowlist only; enforced by `TestRouter_HostVariants` / `TestRouter_AppDocumentReflectsEgressHosts` in `router_test.go`.
- `web/static/` — vanilla JS frontend, Dexie, Service Worker.
- `web/cloud/` — cloud shell (unlock wizard at `/unlock`, crypto module, sync engine, `apishim.js`, service worker); account subdomains serve the full `web/static` app.
- `web/domain/` — **the domain layer**: pure ES modules, injected ports, zero browser globals (purity-enforced); `apishim.js` routes `/api/*` into it and `mcp-responder.js` dispatches through the same router.

## Documentation Index

| Topic | File |
|-------|------|
| Architecture (components, sync, reminders, identity, MCP) | [docs/architecture.md](docs/architecture.md) |
| Feature behaviors | [docs/features.md](docs/features.md) |
| Gamification — **MVP shipped** (`web/domain/gamification.js`, MCP ops, narrator); Phase-2 material in the doc is design-only | [docs/gamification.md](docs/gamification.md) |
| Workout depth (per-set logging, history snapshots, 1RM/PR analysis, opt-in progression) — **implemented**, all four phases closed | [docs/workout-depth.md](docs/workout-depth.md) |
| Cloud onboarding wizard — **implemented** (epic `med-4pz` closed; `WGFirstRun` mounts in cloud) | [docs/onboarding-wizard.md](docs/onboarding-wizard.md) |
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

Checklists live with the docs that own them — this section only routes to them.

- **New health metric.** No server schema change: a record type plus browser code. Record-id conventions, domain ports, and apishim routing ([docs/architecture.md](docs/architecture.md) §§1–3), reminders if it needs them (§5), export shape plus the `tests/fixtures/vault-v1.json` pin ([docs/vault-format.md](docs/vault-format.md#the-golden-fixture)), registry op for agent reach ([§7](docs/architecture.md#7-mcp)).
- **New MCP tool.** Prefer a registry op ([docs/architecture.md §7](docs/architecture.md#7-mcp)); read ops carry a `ResponseExample` sample (`TestResponseExamplesAreValidJSON` in `registry_test.go` asserts populated ones parse as JSON).
- **New egress path.** Manifest entry plus regen ([docs/architecture.md §8](docs/architecture.md#8-privacy-boundaries-are-generated-not-written)).
- **New HTTP route.** Cloud route plus the `apishim.js` route that answers it ([docs/architecture.md](docs/architecture.md) §1).
- **Local-first read.** `window.cachedFetch` + `<wg-stale-badge>` ([docs/frontend.md](docs/frontend.md#local-first-read-resilience); reference: `food.offline-cached-fetch.test.js`). TODO (med-a9n5.9): drop `<wg-stale-badge>` from this line when that bead retires the badge.

## Issue Tracking

Issue tracking uses **bd** (beads); run `bd prime` for workflow context. Use bd for all task tracking — not TodoWrite or markdown TODO lists.
