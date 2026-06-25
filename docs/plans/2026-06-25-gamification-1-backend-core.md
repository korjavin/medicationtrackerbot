# Gamification — Plan 1 of 3: Backend Core (data + scoring + service)

> **Plan group (3 coarse, mostly-sequential plans).** This is the foundation.
> - **Plan 1 — Backend core** ← *you are here* (no dependencies)
> - **Plan 2 — HTTP API + MCP coverage** (depends on Plan 1)
> - **Plan 3 — Frontend** (depends on Plan 2's API contract)
>
> Design of record: [docs/gamification.md](../gamification.md). Read it first — this
> plan implements its settled decisions (outcome-in-range HealthPoints with an
> integrity floor, five Rings, levels + insight ladder, forgiving streaks,
> default-ON, self-set targets with recommendations, 365-day historical backfill).

## Overview

Build the backend foundation for gamification: the persistent data model, a pure
scoring engine encoding the science, and a domain service that composes the scoring
engine with the existing per-domain repos to compute HealthPoints (HP), Rings,
levels, and streaks — and to backfill the last 365 days on first enable.

**Problem it solves:** there is no points/levels/insight layer today. This plan
adds the engine that turns existing health logs (meds, BP, weight, vitals, food,
diary) into HP, levels, and streak state, stored in new tables, behind a
default-ON feature flag.

**Integration:** follows the mandatory domain-service pattern (Critical Rule #1) —
a new `internal/domain/gamification` service reads existing repos through narrow
store interfaces and is the single code path both HTTP (Plan 2) and any future bot
surface will call. Store, domain, and handlers stay build-tag-free.

### Scope (MVP) and explicit non-goals

**In scope:** HP currency (integrity floor + outcome bonus + consistency bonus),
the five Rings (Adherence, Movement, Vitals, Nourishment, Mind), the pure scoring
engine (trapezoid range-membership, per-domain rules, level curve, streak math),
levels, streaks + freezes, per-user self-set targets with code-default
recommendations, 365-day idempotent backfill, insight-tier gating for tiers L1–L4,
and below-floor / two-sided guardrails (no reward for restriction, no point
penalties ever).

**Deferred to Phase 2 (see Post-Completion):** opt-in challenges/quests; insight
tiers L5+ (cross-domain correlations, "good-day model", forecasts, experiment
mode); explicit recovery-mode / ED-safe-mode UI toggles. MVP scoring is non-punitive
by construction (a missed day earns less, never negative), so these are safe to
defer.

## Context (from discovery)

**Conventions to mirror (verified file references):**

- **Store repo shape:** `internal/store/diary/repo.go:31` — `type Repo struct { db *storedb.DB; now func() time.Time }`, `func New(d *storedb.DB) *Repo`, pointer-receiver methods, types co-located in the package.
- **Repos aggregator:** `internal/store/store.go:71` (struct fields) and `:197` (`NewWithDB` wire-up). Add a `Gamification *gamification.Repo` field + `gamification.New(d)` line.
- **Migrations:** `internal/store/migrations/`, highest is `072_add_weight_goals_history.sql`; next is **073**. Goose `-- +goose Up/Down` + `-- +goose StatementBegin/End`. Change-event triggers per `027_add_change_events.sql:12` insert `INTO change_events(tag) VALUES ('<tag>')` on INS/UPD/DEL.
- **Domain service:** reference `internal/domain/workout/service.go:84` (interface), `:139` (struct), `:148` (`New`), `:22` (narrow `WorkoutStore` interface). Also `internal/domain/medication.go:24`.
- **Feature flags:** `internal/store/settings/repo.go:38` (`GetBool`/`SetBool` column switch) and `:102` (`GetFoodIntakeEnabled`/`SetFoodIntakeEnabled` wrappers). Flag columns are added via `ALTER TABLE settings ADD COLUMN <name>_enabled INTEGER DEFAULT <0|1>`.
- **Time storage (Critical):** dose-like timestamp columns that participate in SQL equality must be `INTEGER` unix-seconds-UTC, enforced by `TestDoseTimeColumnsAreInteger` in `internal/store/store_time_invariants_test.go` (+ the allowlist there and the package comment in `internal/store/store.go`). The ledger's `day_unix` participates in a UNIQUE dedupe, so it must be INTEGER and added to that allowlist.

**Existing per-domain read methods the service will call (by date range):**

- BP: `bp.Repo.ListReadings(ctx, userID, since)` — `internal/store/bp/repo.go:192`
- Weight: `weight.Repo.ListLogs(ctx, userID, since)` — `internal/store/weight/repo.go:98`; `GetGoal(ctx)`
- Food: `food.Repo.ListLogs(ctx, userID, since, until)`, `GetStats(...)`, `GetTargets(ctx)` — `internal/store/food/repo.go:613`
- Vitals: `vitals.Repo.ListDayStats(ctx, userID, since)` (`:227`), `ListSleepLogs`, `ListHeartRateLogs`, `ListSpO2Logs`, `ListStressLogs`
- Diary: `diary.Repo.List(ctx, userID, since, until, limit, beforeID)` — `internal/store/diary/repo.go:75`
- Workout: `workout.Repo.ListHistory(userID, limit)`, `ListExerciseStats(userID)`
- Medication/adherence: `medication.Repo.ListPendingIntakes…` exist, but a **date-range intake-history read** (taken/scheduled/skipped between two instants) may be missing — see Task 9.

**Dependencies identified:** `internal/store/db` (`*storedb.DB`, `WithTx`, time helpers `TimeToUnix`/`UnixToTime`), goose migrations runner, existing per-domain repos (read-only).

## Development Approach

- **Testing approach: Regular** (implement, then unit + integration tests within the
  same task, before moving on). Exception: the pure scoring engine (Task 5) is most
  naturally written test-alongside since the math *is* the spec.
- Complete each task fully (code + tests passing) before the next.
- **Every task includes new/updated tests** as separate checklist items.
- **All tests pass before starting the next task.** Run `go test ./...` (or the
  touched packages) after each change.
- Keep store/domain/handlers **build-tag-free**.
- Update this plan when scope shifts (`➕` new task, `⚠️` blocker).

## Testing Strategy

- **Unit tests:** required per task. Scoring engine (Task 5) gets exhaustive
  table-driven tests (trapezoid edges, both tails, level curve, streak transitions).
  Repo methods get round-trip tests mounting the embedded schema (mirror
  `internal/store/diary` tests). Service methods get tests against fake/narrow store
  mocks (mirror the `workout` service tests).
- **Integration:** backfill test seeds multi-domain rows for ~400 days and asserts
  the 365-day cap, idempotency (re-run = no change), and non-negative HP.
- No e2e here (backend only). Frontend e2e/integration is Plan 3.

## Progress Tracking

- Mark `[x]` immediately when done. `➕` newly discovered tasks, `⚠️` blockers.
- Keep the plan in sync with actual work.

## What Goes Where

- **Implementation Steps** (checkboxes): migrations, repo, scoring engine, service,
  tests — all automatable in this repo.
- **Post-Completion** (no checkboxes): the Phase-2 deferrals and cross-project notes.

## Implementation Steps

### Task 1: Migration 073 — gamification tables + feature flag + triggers
- [x] create `internal/store/migrations/073_add_gamification.sql` with `-- +goose Up/Down` + `StatementBegin/End`
- [x] `gamification_targets(id PK, user_id INTEGER NOT NULL, metric_key TEXT NOT NULL, low_val REAL, high_val REAL, falloff REAL, mode TEXT, updated_at_unix INTEGER NOT NULL, UNIQUE(user_id, metric_key))` — stores only user overrides; code holds recommended defaults
- [x] `gamification_ledger(id PK, user_id INTEGER NOT NULL, day_unix INTEGER NOT NULL, ring TEXT NOT NULL, source_metric TEXT NOT NULL, kind TEXT NOT NULL, hp INTEGER NOT NULL, detail TEXT, created_at_unix INTEGER NOT NULL, UNIQUE(user_id, day_unix, ring, source_metric, kind))` — UNIQUE makes backfill `INSERT OR REPLACE` idempotent
- [x] `gamification_state(user_id INTEGER PRIMARY KEY, lifetime_hp INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 1, current_streak INTEGER NOT NULL DEFAULT 0, longest_streak INTEGER NOT NULL DEFAULT 0, freezes INTEGER NOT NULL DEFAULT 0, insight_tier INTEGER NOT NULL DEFAULT 1, last_scored_day_unix INTEGER, updated_at_unix INTEGER NOT NULL)`
- [x] `ALTER TABLE settings ADD COLUMN gamification_enabled INTEGER DEFAULT 1` (default-ON per design)
- [x] add INS/UPD/DEL triggers on the three new tables → `INSERT INTO change_events(tag) VALUES ('gamification')` (mirror migration 027/072)
- [x] indexes: `idx_gam_ledger_user_day ON gamification_ledger(user_id, day_unix)`, `idx_gam_targets_user ON gamification_targets(user_id)`
- [x] write `-- +goose Down` dropping triggers, indexes, tables (settings column drop made symmetric — modernc SQLite supports `DROP COLUMN`, mirrors migration 022; keeps Up→Down→Up idempotent)
- [x] add `day_unix` to the integer-time allowlist in `internal/store/store_time_invariants_test.go` and the package comment in `internal/store/store.go`
- [x] test: a store test mounts the embedded schema and asserts the three tables + the `gamification_enabled` column exist
- [x] run `go test ./internal/store/...` — must pass before next task

### Task 2: Settings feature flag — `gamification_enabled`
- [x] add `case "gamification_enabled"` to the `GetBool`/`SetBool` column switches in `internal/store/settings/repo.go:38`
- [x] add `GetGamificationEnabled(ctx)` / `SetGamificationEnabled(ctx, bool)` wrappers (mirror `:102`)
- [x] confirm default-ON: a freshly-migrated settings row returns `true`
- [x] write tests for get/set + default value
- [x] run `go test ./internal/store/settings/...` — must pass before next task

### Task 3: Store repo — `internal/store/gamification` scaffold + targets
- [x] create `internal/store/gamification/repo.go`: `type Repo struct { db *storedb.DB; now func() time.Time }`, `func New(d *storedb.DB) *Repo`
- [x] define co-located types: `Target`, `LedgerEntry`, `State`, `RingScore` (JSON-tagged like `diary.DiaryNote`)
- [x] targets methods: `ListTargets(ctx, userID)`, `UpsertTarget(ctx, userID, Target)`, `DeleteTarget(ctx, userID, metricKey)`
- [x] wire `Gamification *gamification.Repo` into `store.Repos` struct (`store.go:71`) and `NewWithDB` (`store.go:197`)
- [x] write round-trip tests for targets CRUD (mount schema, like diary tests)
- [x] run `go test ./internal/store/...` — must pass before next task

### Task 4: Store repo — ledger + state methods
- [x] ledger methods: `UpsertLedger(ctx, userID, []LedgerEntry)` (batched `INSERT OR REPLACE`), `ListLedger(ctx, userID, sinceDayUnix, untilDayUnix)`, `SumHP(ctx, userID)`
- [x] state methods: `GetState(ctx, userID)` (returns zero-value/default when absent), `UpsertState(ctx, userID, State)`
- [x] use `storedb.WithTx` where a state update must accompany a ledger write (`ApplyDayScore` writes ledger + state atomically)
- [x] write round-trip tests: idempotent upsert (re-insert same key → one row, replaced), range list, SumHP
- [x] run `go test ./internal/store/gamification/...` — must pass before next task

### Task 5: Scoring engine (pure, no DB)
- [x] create `internal/domain/gamification/scoring/scoring.go` with a tunable `Config` struct holding all constants (floor amounts, outcome maxima, falloff deltas, level-curve base/exponent, streak/freeze params) + `DefaultConfig()`
- [x] `RangeMembership(x, low, high, delta float64) float64` — trapezoid per gamification.md §4.1 (1.0 in-band, linear falloff over delta, 0 beyond)
- [x] per-domain scorers returning an HP breakdown `[]LedgerEntry`-shaped result: `ScoreAdherence`, `ScoreBP`, `ScoreVitalsAuto` (HR/SpO₂/stress, baseline-relative, moderate weight), `ScoreSleep` (duration band + regularity), `ScoreMovement` (weekly accumulation, WHO ceiling), `ScoreNourishment` (two-sided + protein adequacy, never restriction), `ScoreWeight` (stability or safe-pace, below-floor guard), `ScoreMind` (process-only, mood value never scored)
- [x] level curve: `LevelForLifetimeHP(hp, Config) int`, `HPToReachLevel(level, Config) int` (growing curve, e.g. `base·n^1.5`)
- [x] insight-tier gating: `InsightTierForLevel(level, Config) int` (L1–L4 thresholds)
- [x] streak math: `NextStreak(prev State, dayMetMinimum bool, Config) (streak, freezesLeft int)` — weekly cadence default, freeze auto-apply, never negative
- [x] write exhaustive table-driven tests: trapezoid (in-band, both falloff arms, beyond both tails, degenerate band), each domain scorer (in-range / partial / out-of-range / below-floor), level curve monotonicity, streak transitions incl. freeze consumption
- [x] run `go test ./internal/domain/gamification/scoring/...` — must pass before next task

### Task 6: Domain service — interface, struct, narrow store interfaces
- [x] create `internal/domain/gamification/service.go`: public `GamificationService` interface, unexported `service` struct, `New(...) *service` constructor (mirror `internal/domain/workout/service.go`)
- [x] define narrow read interfaces the service needs: `MedStore`, `BPStore`, `WeightStore`, `VitalsStore`, `FoodStore`, `DiaryStore`, `WorkoutStore` (only the List/Get methods from Context above), plus `GamStore` (the new repo) and `SettingsStore` (flag + targets)
- [x] inject a `scoring.Config` (default, overridable for tests)
- [x] add a `gate` helper that short-circuits when `gamification_enabled` is false
- [x] write a construction/gate test with fake stores
- [x] run `go test ./internal/domain/gamification/...` — must pass before next task

### Task 7: Domain service — daily scoring + persistence
- [x] `ScoreDay(ctx, userID, day time.Time) error`: load that day's rows from each narrow store, resolve effective targets (user override or recommended default from `scoring.Config`), run the scorers, write the resulting `LedgerEntry` rows via `UpsertLedger`, then recompute and `UpsertState` (lifetime HP, level, insight tier) — implemented in `scoreday.go` via `ApplyDayScore` (ledger + state atomic). Streak fields carried over (Task 8 owns them). MVP mapping notes: baselines/regularity left unknown (absolute bands), weight scored as maintenance around trailing average, weekly activity from completed-session durations.
- [x] `GetSummary(ctx, userID)`: rings (today + period), level, lifetime HP, next-level progress, current streak, insight tier — the read model Plan 2 will serve (`summary.go`, `Summary` struct; all 5 rings emitted in canonical order)
- [x] effective-targets resolver: `ListTargets` overrides merged onto `Config` recommendations (`effectiveConfig`/`applyTarget`, band-shaped keys; unknown keys ignored for forward-compat)
- [x] write tests: a seeded day produces expected ring HP and state; gate-off yields empty summary (`scoreday_test.go`: seeded-day HP/state, idempotent re-score, gate-off no-op, summary-after-score, override-merge)
- [x] run `go test ./internal/domain/gamification/...` — must pass before next task

### Task 8: Domain service — streaks, freezes, insight-tier gating
- [ ] fold `NextStreak` into `ScoreDay`/state recompute using a per-user "minimum viable day" rule (weekly cadence default)
- [ ] award/bank freezes per the rules; never produce negative HP or demote level
- [ ] expose `GetInsightTier(ctx, userID)` and ensure tier gates only depth (never raw data) per design §8/§5
- [ ] write tests: streak continues across a frozen miss; longest_streak tracked; tier increases with level
- [ ] run `go test ./internal/domain/gamification/...` — must pass before next task

### Task 9: Adherence read method (only if missing)
- [ ] check `internal/store/medication/repo.go` for a date-range intake-history read (taken/scheduled/skipped between two instants)
- [ ] if absent, add `ListIntakeHistory(ctx, userID, since, until)` returning the rows the adherence scorer needs; if present, wire the existing method into `MedStore`
- [ ] write a round-trip test for the read (success + empty range)
- [ ] run `go test ./internal/store/medication/...` — must pass before next task

### Task 10: Domain service — 365-day historical backfill
- [ ] `Backfill(ctx, userID) error`: iterate the last 365 days (capped), call `ScoreDay` per day, then recompute state once; bounded by data availability
- [ ] idempotent: re-running `Backfill` produces no row changes (relies on ledger UNIQUE + `INSERT OR REPLACE`)
- [ ] trigger backfill on first enable (expose `EnsureBackfilled(ctx, userID)`; the actual enable hook is wired in Plan 2)
- [ ] write integration test: seed ~400 days across domains → assert only 365 scored, HP ≥ 0, second run is a no-op (row counts + state identical)
- [ ] run `go test ./internal/domain/gamification/...` — must pass before next task

### Task 11: Verify acceptance criteria
- [ ] verify Overview MVP scope implemented (HP floor+outcome+consistency, five rings, levels, streaks+freezes, targets w/ recommendations, 365-day backfill, insight tiers L1–L4)
- [ ] verify guardrails: no negative HP anywhere; food/weight never reward restriction (below-floor → floor only); mood value never scored
- [ ] run full `go test ./...`
- [ ] run the linter (project standard) — fix all issues
- [ ] confirm `go build ./...` and `go build -tags mobile ./...` both succeed (no build-tag leakage)

### Task 12: Update documentation
- [ ] add a short "Backend implemented (Plan 1)" status note to `docs/gamification.md` §14 pointing at the new packages/tables
- [ ] note any scoring-constant choices that deviated from the doc defaults

## Technical Details

- **Tables:** `gamification_targets` (overrides only), `gamification_ledger` (append/replace HP awards, the source of truth for recompute), `gamification_state` (cached level/streak/tier for fast reads). `settings.gamification_enabled` default 1.
- **Day key:** `day_unix` = UTC-midnight unix-seconds; INTEGER for dedupe equality (allowlisted in the time-invariant test).
- **Idempotency:** ledger UNIQUE `(user_id, day_unix, ring, source_metric, kind)` + `INSERT OR REPLACE` ⇒ backfill/rescore are safe to re-run.
- **Recommendations vs overrides:** `scoring.Config` holds guideline defaults (BP, sleep 7–9h, steps ~7–8k, WHO activity, calorie/protein targets); `gamification_targets` stores only what the user changes.
- **Non-punitive invariant:** scorers only ever add HP (floor/outcome/consistency); a bad or missing day earns less, never negative — this is what makes recovery/ED-safe toggles safe to defer.

## Post-Completion

*Informational — external or Phase-2 work, no checkboxes.*

**Phase 2 (separate future plans):**
- Opt-in **challenges/quests** (`gamification_challenges` table, accept/complete lifecycle, implementation-intention framing).
- Insight ladder **tiers L5+**: cross-domain correlations, the personal "good-day model", forecasts, experiment mode.
- Explicit **recovery/illness mode** and **ED-safe mode** toggles (scoring already non-punitive + below-floor-guarded; these add user-facing control + number hiding).

**Downstream:** Plan 2 (HTTP/MCP) consumes `GetSummary`, `GetInsightTier`, targets CRUD, and `EnsureBackfilled`. Do not start Plan 2 until `go test ./...` is green here.
