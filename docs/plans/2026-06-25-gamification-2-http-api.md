# Gamification — Plan 2 of 3: HTTP API + MCP Coverage

> **Plan group (3 coarse, mostly-sequential plans).**
> - Plan 1 — Backend core *(must be merged/green first)*
> - **Plan 2 — HTTP API + MCP coverage** ← *you are here* (depends on Plan 1)
> - Plan 3 — Frontend (depends on this plan's API contract)
>
> Design of record: [docs/gamification.md](../gamification.md). Backend service from
> Plan 1: `internal/domain/gamification` (`GetSummary`, `GetInsightTier`, targets
> CRUD, `EnsureBackfilled`).

## Overview

Expose the Plan 1 gamification service over HTTP, and satisfy the project's MCP
coverage guard (every route is either a registered MCP operation or an explicit
coverage-exempt entry). Also fold a gamification summary into `/api/bootstrap` so
the frontend (Plan 3) warm-loads the Today rings widget and Journey screen offline.

**Problem it solves:** Plan 1 computes HP/levels/streaks/targets but nothing serves
them. This plan adds the read + write endpoints and their MCP registry operations.

**Integration:** handlers call **only** the `GamificationService` (Critical Rule
#1 — no direct store calls for business logic). Routes register on `apiMux` with Go
1.22 method syntax. The MCP coverage guard
(`TestMCPCoverage_AllRoutesEitherRegisteredOrExempt`) must stay green.

### Scope and non-goals

**In scope:** read endpoints (summary, journey, slim rings for Today), targets
read/set, the first-enable backfill hook, MCP registry operations + coverage
exemptions, and the bootstrap payload addition.

**Out of scope (Phase 2):** challenge endpoints, deeper-insight (L5+) endpoints.
The gamification **enable toggle** rides the existing generic feature-toggle route
(see Task 5) — no new toggle endpoint.

## Context (from discovery)

**Conventions to mirror (verified file references):**

- **Route registration:** `internal/server/server.go:800` — `apiMux.HandleFunc("GET /api/...", s.handleX)`, path params via `r.PathValue("name")`.
- **Handler → service:** handlers construct/hold the domain service (e.g. `domain.NewWorkoutService(r.Workout, r.TZ)`); add a `gamification` service built from the Plan 1 repo + the per-domain repos it needs.
- **MCP coverage guard:** `internal/server/mcp_coverage_test.go:21` — `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt`.
- **MCP operations:** `internal/mcp/registry/operations_health.go:25` — `Operation{ ID, Topic, Method, Path, Risk, ParamsSchema, BodySchema, Description, ResponseSummary, ResponseExample, Example }`. Read ops should populate `ResponseExample`.
- **Coverage exemptions:** `internal/server/mcp_coverage_exempt.go:32` — `{Method, Path, Reason}`. Feature-toggle + settings routes are exempt with a "privilege loop" reason (`:74`).
- **Existing feature-toggle routes (already exempt):** `GET /api/settings/features`, `POST /api/settings/features/{feature}` (`mcp_coverage_exempt.go:74`-ish). The gamification flag toggles through `{feature}` = `gamification` — confirm the generic handler reads/writes `gamification_enabled` (Plan 1 Task 2 added the column + wrappers).
- **Bootstrap:** `/api/bootstrap` builder seeds per-section caches; add a `gamification` block (Task 6). Bootstrap route is already coverage-exempt (transport/shell).

## Development Approach

- **Testing approach: Regular** (handler + test in the same task).
- Each task fully green before the next; run `go test ./internal/server/... ./internal/mcp/...` after changes.
- Handlers stay thin and **build-tag-free**; all logic is in the Plan 1 service.
- The MCP coverage guard test is the gate for every new route — never add a route
  without either a registry op or an exemption in the same task.

## Testing Strategy

- **Unit/handler tests:** table-driven per endpoint (success, gate-off → empty/forbidden, bad input → 400, unauth → 401) mirroring existing `internal/server` handler tests (e.g. `TestBPHandlers`).
- **Guard test:** `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` must pass after each route addition (treat as part of the task's test step).
- **Registry tests:** validate the new operations parse and their schemas are well-formed (mirror existing registry tests).
- **Bootstrap test:** asserts the `gamification` block is present (and omitted/empty when the flag is off).

## Progress Tracking

- `[x]` on completion, `➕` new tasks, `⚠️` blockers. Keep in sync.

## What Goes Where

- **Implementation Steps** (checkboxes): handlers, registry ops, exemptions,
  bootstrap, tests — all in-repo.
- **Post-Completion**: manual `curl`/Bruno smoke checks and Phase-2 endpoints.

## Implementation Steps

### Task 1: Wire the gamification service into the server
- [ ] construct the `GamificationService` in the server wiring (where other domain services are built), passing the Plan 1 `r.Gamification` repo + the per-domain repos it reads + settings repo
- [ ] hold it on the server struct (mirror existing service fields)
- [ ] write a smoke test that the server constructs with the service present
- [ ] run `go test ./internal/server/...` — must pass before next task

### Task 2: Read endpoints — summary, journey, rings
- [ ] `GET /api/gamification/summary` → `service.GetSummary` (rings + level + HP + next-level progress + streak + insight tier)
- [ ] `GET /api/gamification/journey` → fuller payload: level/HP history, streak detail, unlocked insight tiers L1–L4, per-ring breakdown
- [ ] `GET /api/gamification/rings` → slim Today-widget payload (per-ring current vs daily max + level badge)
- [ ] register all three on `apiMux` (`server.go`), gate behind `gamification_enabled` (return an explicit empty/`disabled` shape, not 500, when off)
- [ ] write handler tests: success shape, gate-off, unauth
- [ ] run `go test ./internal/server/...` — must pass before next task

### Task 3: Targets endpoints — read + set
- [ ] `GET /api/gamification/targets` → effective targets = recommendations merged with user overrides (each field flagged `isRecommended` vs `isCustom` so the UI can show "recommended: …")
- [ ] `PUT /api/gamification/targets` (or `POST`) → validate + persist overrides via the service; reject values outside sane safety bounds (e.g. weight goal below BMI floor) with 400
- [ ] register on `apiMux`; gate behind the flag
- [ ] write handler tests: read defaults (no overrides), set + read back, validation rejection (below-floor)
- [ ] run `go test ./internal/server/...` — must pass before next task

### Task 4: First-enable backfill hook
- [ ] on enabling gamification (via the generic feature-toggle handler when `{feature}=gamification` flips false→true), call `service.EnsureBackfilled(ctx, userID)` so the user lands on a populated Journey (run async/non-blocking if the toggle handler must stay fast; otherwise inline)
- [ ] make the hook idempotent (safe if already backfilled — relies on Plan 1 idempotency)
- [ ] write a test: toggling the flag on triggers backfill exactly once; toggling again is a no-op
- [ ] run `go test ./internal/server/...` — must pass before next task

### Task 5: MCP registry operations + coverage
- [ ] create `internal/mcp/registry/operations_gamification.go` with a `gamification` topic
- [ ] register **read** ops with `ResponseExample`: `gamification.summary` (`GET /api/gamification/summary`), `gamification.journey` (`GET /api/gamification/journey`), `gamification.rings` (`GET /api/gamification/rings`), `gamification.targets.read` (`GET /api/gamification/targets`)
- [ ] register the **write** op: `gamification.targets.set` (`PUT /api/gamification/targets`, `RiskWrite`, with `BodySchema`)
- [ ] confirm the gamification enable toggle is covered by the existing `POST /api/settings/features/{feature}` exemption — add no new toggle route
- [ ] run `go test ./internal/mcp/...` — registry parses and schemas validate
- [ ] run `go test ./internal/server/ -run TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` — must pass before next task

### Task 6: Bootstrap payload — gamification summary
- [ ] add a `gamification` block to the `/api/bootstrap` builder (the slim summary/rings shape), omitted or empty when the flag is off
- [ ] keep the cache key aligned with what Plan 3 will read (`gamification_rings` / a `gamification` summary key) so the bootstrap-warmed cache is reused
- [ ] write a bootstrap test: block present when enabled, absent/empty when disabled
- [ ] run `go test ./internal/server/...` — must pass before next task

### Task 7: Verify acceptance criteria
- [ ] verify all endpoints return the documented shapes and gate correctly when disabled
- [ ] run full `go test ./...`
- [ ] run `go test ./internal/server/ -run TestMCPCoverage` — guard green
- [ ] run the linter — fix all issues
- [ ] confirm `go build ./...` and `go build -tags mobile ./...` succeed
- [ ] freeze the API contract (paths + JSON shapes) for Plan 3 — record it in Technical Details below

### Task 8: Update documentation
- [ ] add the new routes to `docs/api.md`
- [ ] note the endpoints + bootstrap block in `docs/gamification.md` §14

## Technical Details

**API contract (freeze for Plan 3):**

- `GET /api/gamification/summary` → `{ enabled, level, lifetimeHp, nextLevelHp, hpIntoLevel, streak: {current, longest, freezes}, insightTier, rings: [{id, label, currentHp, dailyMaxHp, status}] }`
- `GET /api/gamification/rings` → slim: `{ enabled, level, rings: [{id, label, currentHp, dailyMaxHp}] }`
- `GET /api/gamification/journey` → summary + `{ hpHistory: [{dayUnix, hp}], ringBreakdown: [...], unlockedTiers: [1..4], levelCurve: [...] }`
- `GET /api/gamification/targets` → `{ targets: [{metricKey, low, high, value, mode, isRecommended, isCustom, recommendedLabel}] }`
- `PUT /api/gamification/targets` body `{ targets: [{metricKey, low?, high?, value?, mode?}] }` → updated targets; 400 on safety-bound violation
- Enable: `POST /api/settings/features/gamification` (existing generic toggle) → triggers first-enable backfill

All gamification routes return a `{ enabled: false }`-shaped empty body (HTTP 200) when the flag is off, so the frontend renders a disabled state rather than handling an error.

## Post-Completion

**Manual smoke (no checkboxes):**
- `curl` each endpoint with a seeded user; toggle the flag off and confirm empty shapes; toggle on and confirm backfill populated the summary.

**Phase 2 endpoints (separate plans):**
- Challenges: `GET/POST /api/gamification/challenges`, accept/complete.
- Deeper insight (L5+): correlation/good-day-model/forecast read endpoints.

**Downstream:** Plan 3 builds the Today rings widget, Journey screen, and Settings
targets editor against the frozen contract above.
