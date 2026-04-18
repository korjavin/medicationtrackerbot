# CLAUDE.md

Guidance for Claude Code working in this repository. This file is an index — detailed topics live in `docs/`.

## Project Overview

A self-hosted Telegram Mini App for comprehensive health tracking (medications, blood pressure, weight, workouts, sleep, food, diary). A single Go binary serves the Telegram Bot + web server + scheduler; the frontend is vanilla JavaScript.

**Philosophy**: single source of truth for health metrics, with both a rich web interface and a minimalist chat interface. Self-hosted for real data ownership.

## Critical Rules

1. **Domain service pattern is mandatory.** Bot callbacks and HTTP handlers may only call `internal/domain/*` services (plus Telegram / HTTP transport). No direct store calls for business logic — both transports must share the same code path. See [docs/architecture.md](docs/architecture.md#domain-service-pattern).
2. **Never modify existing migrations.** Always add new ones in `internal/store/migrations/`.
3. **No hardcoded colors or inline `.style.` assignments in frontend code.** Use design tokens and CSS classes. Architecture tests enforce this. See [docs/frontend.md](docs/frontend.md#design-token-system).
4. **New `window.*` globals require an allowlist entry** in `tests/architecture.globals.test.js` with justification.
5. **Use `log/slog` with contextual args** (`slog.Error("msg", "error", err)`), not `log.Printf`.

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

## Code Layout

- `cmd/` — entry points (`bot`, `mcptool`, `importer`, `bpimporter`, `genvapid`)
- `internal/ai` — AI client (OpenAI-compatible)
- `internal/store` — SQLite repository + goose migrations
- `internal/server` — HTTP handlers
- `internal/bot` — Telegram bot — **thin channel layer only**
- `internal/domain` — business logic services (medication, exercise, reminder, food, food_ai)
- `internal/workout` — workout session service (reference service pattern)
- `internal/scheduler` — notification scheduler
- `internal/mcp` — MCP server
- `internal/rxnorm` — drug interaction checks
- `internal/webpush` — web push
- `internal/tzlookup` — geo-to-timezone (tzf, offline)
- `web/static/` — vanilla JS frontend, Dexie.js, Service Worker

## Documentation Index

| Topic | File |
|-------|------|
| Architecture, code structure, DB schema, auth, domain services, scheduler, logging, testing | [docs/architecture.md](docs/architecture.md) |
| Feature behaviors (meds, BP, weight, food, workouts, MCP) | [docs/features.md](docs/features.md) |
| API endpoints | [docs/api.md](docs/api.md) |
| Environment variables | [docs/environment.md](docs/environment.md) |
| MCP server deployment (Pocket-ID, Docker, Claude config) | [docs/mcp-deployment.md](docs/mcp-deployment.md) |
| Frontend architecture, load order, globals, design tokens, data flow | [docs/frontend.md](docs/frontend.md) |
| Technical decisions (polling, offline writes, 5xx-as-offline, vanilla JS) | [docs/technical-decisions.md](docs/technical-decisions.md) |
| Installer | [docs/installer.md](docs/installer.md) |
| Security policies | [docs/security/](docs/security/) |
| Threat model | [threat-model.md](threat-model.md) |

## Common Tasks

### Adding a new health metric

1. Create migration in `internal/store/migrations/`
2. Add table methods to `internal/store/store.go`
3. Create a domain service in `internal/domain/` (see [docs/architecture.md](docs/architecture.md#domain-service-pattern))
4. Add HTTP handlers in `internal/server/`
5. Add bot commands in `internal/bot/` — call the domain service only
6. Add frontend UI in `web/static/`
7. Add scheduler logic in `internal/scheduler/` if reminders are needed

### Adding an MCP tool

See [docs/mcp-deployment.md](docs/mcp-deployment.md#adding-mcp-tools).

### Modifying workout rotation

- Core logic: `internal/store/workout.go` (`AdvanceRotation`)
- Scheduler integration: `internal/scheduler/workout.go`
- Bot callbacks: `internal/bot/workout_callbacks.go`
- Tests: `internal/store/workout_test.go`
