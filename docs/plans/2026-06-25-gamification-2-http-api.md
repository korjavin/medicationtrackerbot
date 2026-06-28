# Gamification — Plan 2 of 3: HTTP API + MCP Coverage

> **Plan group (3 coarse, mostly-sequential plans).**
> - Plan 1 — Backend core *(merged on `master`)*
> - **Plan 2 — HTTP API + MCP coverage** ← *you are here* (depends on Plan 1)
> - Plan 3 — Frontend (depends on this plan's API contract)
>
> Design of record: [docs/gamification.md](../gamification.md). Backend service from
> Plan 1: `internal/domain/gamification` (`GetSummary`, `GetInsightTier`, targets
> CRUD, `EnsureBackfilled`).

> **⚠️ Testing note (intentional deviation):** by direction, **this plan does not
> require writing unit/handler tests.** Verification is build + lint + the
> *existing* MCP coverage guard + manual smoke (see Verification). This overrides the
> default ralphex "every task must include tests" mandate. Plan 3 likewise strips
> authored tests; only Plan 1 keeps the normal testing posture.

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

**Explicitly out of scope for this plan:** new unit/handler/registry/bootstrap unit
tests. Do not author them here.

## Context (from discovery)

**Conventions to mirror (verified file references):**

- **Route registration:** `internal/server/server.go:800` — `apiMux.HandleFunc("GET /api/...", s.handleX)`, path params via `r.PathValue("name")`.
- **Handler → service:** handlers construct/hold the domain service (e.g. `domain.NewWorkoutService(r.Workout, r.TZ)`); add a `gamification` service built from the Plan 1 repo + the per-domain repos it needs.
- **MCP coverage guard:** `internal/server/mcp_coverage_test.go:21` — `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` (a *pre-existing* repo invariant; CI runs it regardless of this plan).
- **MCP operations:** `internal/mcp/registry/operations_health.go:25` — `Operation{ ID, Topic, Method, Path, Risk, ParamsSchema, BodySchema, Description, ResponseSummary, ResponseExample, Example }`. Read ops should populate `ResponseExample`.
- **Coverage exemptions:** `internal/server/mcp_coverage_exempt.go:32` — `{Method, Path, Reason}`. Feature-toggle + settings routes are exempt with a "privilege loop" reason (`:74`).
- **Existing feature-toggle routes (already exempt):** `GET /api/settings/features`, `POST /api/settings/features/{feature}` (`mcp_coverage_exempt.go:74`-ish). The gamification flag toggles through `{feature}` = `gamification` — confirm the generic handler reads/writes `gamification_enabled` (added in Plan 1).
- **Bootstrap:** `/api/bootstrap` builder seeds per-section caches; add a `gamification` block (Task 6). Bootstrap route is already coverage-exempt (transport/shell).

## Development Approach

- **No unit tests in this plan** (per direction). Each task is complete when it
  **builds, lints clean, keeps the existing MCP coverage guard green, and passes a
  manual smoke check** of the affected endpoint(s).
- Handlers stay thin and **build-tag-free**; all business logic lives in the Plan 1
  service.
- The MCP coverage guard is the gate for every new route — never add a route
  without either a registry op or an exemption **in the same task** (otherwise the
  guard, and CI, go red).
- Update this plan when scope shifts (`➕` new task, `⚠️` blocker).

## Verification (in place of unit tests)

This plan relies on the following instead of authored unit tests:

- **Build:** `go build ./...` and `go build -tags mobile ./...` succeed.
- **Lint:** `golangci-lint` clean on touched files.
- **Existing MCP coverage guard:** `go test ./internal/server/ -run TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` stays green — this is the repo's pre-existing route-coverage invariant, not a new unit test.
- **No regressions:** the existing suite (`go test ./...`) still passes — we are not adding tests, only not breaking the ones already there.
- **Manual smoke:** `curl` (or Bruno) each endpoint against a seeded user, with the
  feature flag on and off, confirming the documented shapes (see Post-Completion).

## Progress Tracking

- `[x]` on completion, `➕` new tasks, `⚠️` blockers. Keep in sync.

## What Goes Where

- **Implementation Steps** (checkboxes): handlers, registry ops, exemptions,
  bootstrap, doc updates — all in-repo. **No test-authoring checkboxes.**
- **Post-Completion**: manual `curl`/Bruno smoke checks and Phase-2 endpoints.

## Implementation Steps

### Task 1: Wire the gamification service into the server
- [x] construct the `GamificationService` in the server wiring (where other domain services are built), passing the Plan 1 `r.Gamification` repo + the per-domain repos it reads + settings repo
- [x] hold it on the server struct (mirror existing service fields)
- [x] confirm `go build ./...` and `go build -tags mobile ./...` succeed with the service wired — before next task

### Task 2: Read endpoints — summary, journey, rings
- [x] `GET /api/gamification/summary` → `service.GetSummary` (rings + level + HP + next-level progress + streak + insight tier)
- [x] `GET /api/gamification/journey` → fuller payload: level/HP history, streak detail, unlocked insight tiers L1–L4, per-ring breakdown — new `service.GetJourney` (`journey.go`) embeds `Summary` + `hp_history` + `unlocked_tiers` + `level_curve`; per-ring breakdown is the embedded `period_rings`
- [x] `GET /api/gamification/rings` → slim Today-widget payload (`{enabled, level, today_hp, rings:[{ring,hp}]}`, a projection of `Summary`). Note: served per-ring **today HP** only — no fabricated `dailyMaxHp`/label/status, since the service doesn't define a per-ring daily cap (floors are per-count). Reconcile the frozen contract to this shape in Task 7.
- [x] register all three on `apiMux` (`server.go`), gate behind `gamification_enabled` — handlers call only the service, which returns the `{enabled:false}` shape when off (no 500, no flag branching in the handler)
- [x] `go build ./...` clean (+ `-tags mobile`) + lint clean. Live curl smoke (flag on/off, 401) deferred to Task 7's manual pass — needs a running authenticated server + seeded DB; the flag-off `{enabled:false}` path is guaranteed by the service's already-tested `GetSummary` gate, 401 by the apiMux auth middleware.

### Task 3: Targets endpoints — read + set
- [x] `GET /api/gamification/targets` → effective targets = recommendations merged with user overrides (each field flagged `isRecommended` vs `isCustom` so the UI can show "recommended: …"). Served as `{enabled, targets:[{metric_key, low, high, falloff, recommended_low, recommended_high, recommended_falloff, is_custom, is_recommended}]}` (natural service shape; snake_case) via new `service.EffectiveTargets` (`TargetsView`/`EffectiveTarget` in `targets.go`) which reuses the same `applyTarget` merge scoring uses. Task 7 reconciles the recorded contract to this shape.
- [x] `PUT /api/gamification/targets` → validate + persist overrides via the service; reject out-of-bounds/incoherent bands with 400. Handler decodes `{targets:[gamstore.Target]}`, calls `service.UpsertTarget` per item (maps `ErrUnknownTargetMetric`/`ErrInvalidTarget` → 400), returns the refreshed `EffectiveTargets` view. Safety bound: tightened the shared `validateTargetBand` to also reject negative Low/High (none of the 6 band metrics can be negative) alongside the existing Low>High / negative-Falloff guards.
- [x] register on `apiMux`; gate behind the flag — both routes registered in `server.go`; the service gates internally (gate-off → `{enabled:false}`), so handlers stay thin with no flag branching
- [x] `go build ./...` clean (+ `-tags mobile`) + lint clean (`golangci-lint` 0 issues, gofmt clean). Live curl smoke (read defaults, set + read back, below-floor → 400) deferred to Task 7's manual pass — needs a running authenticated server + seeded DB. The 400-on-invalid path is covered by the existing `TestUpsertTarget_ValidatesMetricAndBand`, gate-off by `TestTargetsCRUD_GateOff_NoOp`; per Plan 2's no-new-tests directive, no tests authored here.

### Task 4: First-enable backfill hook
- [x] on enabling gamification (via the generic feature-toggle handler when `{feature}=gamification` flips false→true), call `service.EnsureBackfilled(ctx, userID)` so the user lands on a populated Journey. Added the `gamification` case to `handleSetFeatureEnabled` (`settings_handlers.go`) — the toggle previously 400'd on `{feature}=gamification`. Run **inline** (not async) so the toggle's 200 means the Journey is ready; backfill failure is logged best-effort rather than failing a toggle that already persisted. Added `SetGamificationEnabled` to the server's `SettingsStore` interface.
- [x] make the hook idempotent (safe if already backfilled — relies on Plan 1 idempotency): `EnsureBackfilled` short-circuits once `BackfilledAt` is latched and no-ops when the flag is off (`TestEnsureBackfilled_SkipsWhenBackfilled`/`_GateOff`), so calling it on every enable is safe. The flag is persisted *before* the call so the internal gate sees enabled.
- [x] `go build ./...` clean (+ `-tags mobile`) — verified. Live manual smoke (toggle on → populated summary; toggle again → no duplicate) deferred to Task 7's manual pass — needs a running authenticated server + seeded DB; idempotency is guaranteed by the already-tested Plan 1 `EnsureBackfilled` guard. The route stays MCP-covered via the existing `POST /api/settings/features/{feature}` exemption (no new route).

### Task 5: MCP registry operations + coverage
- [x] create `internal/mcp/registry/operations_gamification.go` with a `gamification` topic — `GamificationOperations()` wired into `DefaultOperations()` (registry.go); added a per-topic `Suggestion` so the `gamification` topic surfaces a non-empty next-step in `mcp_help` (required by `TestMCPHelp_FullCatalogIncludesCapabilities`)
- [x] register **read** ops with `ResponseExample`: `gamification.summary` (`GET /api/gamification/summary`), `gamification.journey` (`GET /api/gamification/journey`), `gamification.rings` (`GET /api/gamification/rings`), `gamification.targets.read` (`GET /api/gamification/targets`) — each carries a `ResponseExample` matching the actual snake_case service shape
- [x] register the **write** op: `gamification.targets.set` (`PUT /api/gamification/targets`, `RiskWrite`, with `BodySchema`) — body `{targets:[{metric_key, low_val?, high_val?, falloff?, mode?}]}`, metric_key enum = the 6 band metrics
- [x] confirm the gamification enable toggle is covered by the existing `POST /api/settings/features/{feature}` exemption — add no new toggle route — verified at `mcp_coverage_exempt.go:77`; deliberately NOT registered as an op (privilege loop)
- [x] run the **existing** coverage guard `go test ./internal/server/ -run TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` — must be green before next task (CI gate, not a new unit test) — green; full `go test ./...` + both builds (`./...` and `-tags mobile`) also pass

### Task 6: Bootstrap payload — gamification summary
- [ ] add a `gamification` block to the `/api/bootstrap` builder (the slim summary/rings shape), omitted or empty when the flag is off
- [ ] keep the cache key aligned with what Plan 3 will read (`gamification_rings` / a `gamification` summary key) so the bootstrap-warmed cache is reused
- [ ] `go build ./...` clean + manual smoke: `GET /api/bootstrap` includes the block when enabled, omits/empties it when disabled — before next task

### Task 7: Verify acceptance criteria
- [ ] manual smoke: all endpoints return the documented shapes and gate correctly when disabled (full curl pass, flag on and off)
- [ ] `go build ./...` and `go build -tags mobile ./...` succeed
- [ ] run the linter — fix all issues
- [ ] existing MCP coverage guard green (`go test ./internal/server/ -run TestMCPCoverage`)
- [ ] no regressions: `go test ./...` still passes (existing tests only — author no new ones)
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

**Manual smoke (the primary verification for this plan — no checkboxes):**
- `curl` each endpoint with a seeded user; toggle the flag off and confirm the
  `{enabled:false}` shapes; toggle on and confirm backfill populated the summary;
  confirm `PUT /api/gamification/targets` rejects below-floor values with 400.
- Confirm `GET /api/bootstrap` carries the gamification block only when enabled.

**Phase 2 endpoints (separate plans):**
- Challenges: `GET/POST /api/gamification/challenges`, accept/complete.
- Deeper insight (L5+): correlation/good-day-model/forecast read endpoints.

**Downstream:** Plan 3 builds the Today rings widget, Journey screen, and Settings
targets editor against the frozen contract above.
