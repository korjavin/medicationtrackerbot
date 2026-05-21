# seeddemo: vitals time-series + cron-like top-up mode

## Overview

The demo deployment (`DEMO_MODE=1`) is seeded once by `cmd/seeddemo` with 90 days of synthetic health data, then ages — after a few weeks the "latest" sleep, BP, and food logs become visibly old, breaking the "always-fresh demo" experience. Two related gaps:

1. **Missing vitals time-series.** Although the schema supports continuous HR / SpO2 / stress samples (`vitals_heart`, `vitals_spo2`, `vitals_stress` from migration 024), the seeder never populates them. The Vitals tab in the demo therefore renders only sleep + day-stat aggregates and looks sparse compared to a real Mi Band sync.
2. **No incremental top-up.** The seeder always wipes the user and rebuilds 90 days ending at "now". To keep a deployed demo fresh, an operator must rerun the full wipe-and-seed nightly. There is no way to *append* a day of synthetic data from the last logged timestamp forward.

This plan extends `cmd/seeddemo` and `internal/seeddemo/` to:

- Generate realistic HR / SpO2 / stress time-series alongside the existing dataset (every ~15 min during waking hours, sparser at night, correlated with workouts / sleep).
- Add a `-topup` flag that, instead of wiping, finds the last logged timestamp per data stream and generates new synthetic data forward to `time.Now()`. Idempotent: running it twice in a row should produce no net change.
- Wire the top-up to run automatically as a background goroutine inside the bot whenever `DEMO_MODE=1`, so the demo deployment self-refreshes without any external cron.

Out of scope (intentional, per planning conversation):
- Daily aggregates (`day_stats` steps/calories/distance) — not requested.
- Mi Band per-workout HR/SpO2 backfill — not requested.
- Sliding medication active-date windows during top-up — keep windows fixed; only append intake logs for courses still active at "now".

## Context (from discovery)

**Files involved**:
- `cmd/seeddemo/main.go` — CLI entry; will gain `-topup`, `-now` (override "now" for tests), maybe `-poll-interval`.
- `internal/seeddemo/seeddemo.go` — orchestrator; will split `Seed()` into `Seed()` (full wipe+rebuild) and `TopUp()` (incremental).
- `internal/seeddemo/vitals.go` — currently generates sleep, BP, weight. Will gain HR/SpO2/stress time-series generation and incremental variants.
- `internal/seeddemo/clock.go` — deterministic time walker. Will gain a `windowFrom(lastTs, now)` helper for top-up windows.
- `internal/seeddemo/meds.go`, `food.go`, `workouts.go`, `misc.go` — each needs an incremental variant that takes a `(from, to)` window.
- `internal/seeddemo/wipe.go` — unchanged; only used by full-seed path.
- New `internal/seeddemo/topup.go` — incremental orchestration + "find last timestamp" helpers per stream.
- `internal/store/vitals/repo.go` — already has `ImportHeart`/`ImportSpO2`/`ImportStress` methods (verify; if missing, add minimal `Create*` methods). Will add a `LatestSample(ctx, userID, table)` helper (or three) returning the max `date_time` so top-up knows where to resume.
- `cmd/bot/main.go` (server build) — when `DEMO_MODE=1`, start a `demotopup.Runner` goroutine that ticks every `DEMO_TOPUP_INTERVAL` (default 1h) and calls `seeddemo.TopUp`.
- `internal/server/demomode.go` (or wherever demo wiring lives — to be confirmed at task 1) — read `DEMO_TOPUP_INTERVAL` env var, expose to main.
- `docs/demo-mode.md` — document the new top-up loop and env vars.
- `CLAUDE.md` (the `seeddemo` section) — mention `-topup` and the automatic background loop.

**Related patterns found**:
- Existing seed code goes directly through `store.Store` methods (not domain services) so it can backdate timestamps. Top-up will follow the same pattern.
- `internal/seeddemo/clock.go` already encapsulates the time walker; reuse its structure for the incremental window.
- The bot's main package already wires scheduler goroutines on startup (e.g., `internal/scheduler/`); the demo top-up loop will follow the same shape — `go runner.Run(ctx)` after store init, cancelled by the same root context.
- Idempotency for time-series streams is free: `vitals_heart` / `vitals_spo2` / `vitals_stress` all have PK `(user_id, date_time)` so INSERT OR IGNORE will silently dedupe.
- Idempotency for `sleep_logs` is free: `UNIQUE(user_id, start_time)`. For BP and weight we'll use `last_ts + 1s` as the start of the top-up window so we never produce same-second collisions.

**Dependencies identified**:
- No new external libs.
- No schema migrations required — all vitals tables exist (verified migrations 013, 024, 026).
- Existing `internal/seeddemo` PCG RNG seeding pattern can be reused; top-up will derive its per-tick seed from `(user_seed XOR day_unix)` so a re-run of the same tick produces identical samples (idempotent on retry).

## Development Approach

- **Testing approach**: Regular (code first, then tests). The generator code is self-contained Go that's easy to test after the fact; TDD would slow down the data-shape iteration.
- Complete each task fully before moving to the next.
- Make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task.
- **CRITICAL: all tests must pass before starting next task** — run `go test ./internal/seeddemo/... ./cmd/seeddemo/... ./internal/store/vitals/...` plus the wider `go test ./...` at the verification task.
- **CRITICAL: update this plan file when scope changes during implementation**.
- Maintain backward compatibility: existing `seeddemo -wipe -days 90 -seed 42` invocation must continue to produce a dataset shape-compatible with what the demo expects today (just additionally including new vitals streams).

## Testing Strategy

- **Unit tests**: required for every task. Place alongside generators in `internal/seeddemo/*_test.go`. Where helpful, add table-driven cases over (input window, seed) to assert deterministic output sizes and value ranges.
- **Determinism tests**: same seed + same window → byte-identical row counts and value tuples. This guards against accidental clock-based nondeterminism slipping into generators.
- **Top-up idempotency tests**: run `TopUp` twice with the same `now`, assert second call inserts zero rows for streams where it would create same-second collisions, and ≤1 row for streams whose interval falls exactly on `now`.
- **Integration smoke test**: a test that opens a temp SQLite, seeds 7 days, advances "now" by 1 hour, top-ups, and asserts new rows appear in `vitals_heart`/`vitals_spo2`/`vitals_stress`/`bp_readings`/`food_logs` with timestamps strictly greater than the prior max.
- **E2E**: project has no Playwright/Cypress for this layer; the frontend side is verified by inspection (Vitals tab renders the new samples). No new e2e harness needed.

## Progress Tracking
- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): code, tests, docs inside this repo.
- **Post-Completion** (no checkboxes): manual deploy verification, operator-side runbook updates.

## Implementation Steps

### Task 1: Survey existing vitals store API and add `LatestSample` helpers

- [x] read `internal/store/vitals/repo.go` and list current methods for `vitals_heart`/`vitals_spo2`/`vitals_stress` (create / import / latest). If `Latest…At` style methods are missing, add `LatestHeartSample(ctx, userID) (time.Time, bool, error)`, `LatestSpO2Sample(...)`, `LatestStressSample(...)`, each returning the max `date_time` and a `found` bool.
- [x] also add `LatestSleepEnd(ctx, userID)` to `vitals.Repo` if not present — top-up needs the last `end_time` to know whether to generate a new sleep block tonight.
- [x] verify the parallel BP / weight / food / workout / diary repos already expose "latest by user" — if not, add minimal helpers (one query each). Weight already had `GetLastLog`; added `bp.LatestReading`, `food.LatestLog`, `workout.LatestSessionForUser`, `diary.LatestNote`, and `medication.LatestScheduledIntake` (per-med, since intake_log is keyed on medication_id).
- [x] write unit tests for each new `Latest…` method using the in-memory SQLite test harness used elsewhere in `internal/store/*_test.go`: empty table returns `found=false`; one row returns that row's timestamp; multiple rows return the max.
- [x] run `go test ./internal/store/...` — must pass before task 2.

### Task 2: Add vitals time-series generators to `internal/seeddemo/`

- [x] create `internal/seeddemo/vitals_timeseries.go` exporting `generateHeartSamples(ctx, s, clock, userID, rng, from, to)`, `generateSpO2Samples(...)`, `generateStressSamples(...)`.
- [x] design HR generator: baseline drift 55–75 bpm, +20–40 bpm bursts during seeded workout windows, dip during sleep windows (correlate by reading from existing seeded sleep / workout sets passed in via a small `Context` struct). Sample interval 15 min waking, 30 min sleep.
- [x] design SpO2 generator: 95–99 baseline with rare 92–94 dips at altitude/sleep (purely cosmetic variation); 15 min interval.
- [x] design stress generator: 0–100 score, low (20–40) at sleep, mid (30–55) baseline, spikes (60–80) at meal/workout boundaries; 30 min interval.
- [x] call generators from existing `generateVitals` (full-seed path) so a full seed now also populates the three time-series tables.
- [x] write tests in `vitals_timeseries_test.go`: determinism (same seed → identical samples), value-range assertions (no NaN, no out-of-spec), sample density matches expected (samples-per-day within tolerance), correlation smoke (sleep windows have lower median HR than waking windows).
- [x] run `go test ./internal/seeddemo/...` — must pass before task 3.

### Task 3: Refactor `seeddemo.Seed` to expose per-stream window functions

- [x] in `internal/seeddemo/seeddemo.go`, extract each per-stream generator's "window of interest" into a function signature `generateXxx(ctx, s, clock, userID, rng, from, to time.Time) (count int, err error)`. Each per-stream generator (`generateBP`, `generateWeight`, `generateSleep`, `generateMeds`, `generateFood`, `generateWorkouts`, `generateScheduledSessions`, `generateAdHocSessions`, `generateMisc`, `generateDiary`, `generateTimezoneHistory`, and the orchestrator `generateVitals`) now takes `from, to time.Time`. Internally each computes `windowDays = daysInWindow(startOfDayUTC(from), to)` and `startOff = windowStartOffsetFromClock(clk, windowStart)` so iteration covers only the in-window days while catalog-scale trend math still uses `opts.Days`. Helpers `daysInWindow` and `windowStartOffsetFromClock` live in `internal/seeddemo/clock.go`.
- [x] keep existing public `Seed(ctx, opts) (Summary, error)` signature unchanged. (`Run(ctx, s, opts) (*Summary, error)` — the actual public entrypoint — is untouched.)
- [x] no test changes expected — existing seed tests should still pass byte-for-byte (same seed, same window, same output). `TestRunSeedsAllDomains`, `TestRunIsDeterministic`, `TestRunWipesPreExistingData`, plus the full vitals-timeseries suite all pass with identical row counts.
- [x] run `go test ./internal/seeddemo/... ./cmd/seeddemo/...` — must pass before task 4. (cmd/seeddemo has no tests yet — Task 5 adds them.)

### Task 4: Implement `TopUp` orchestration in `internal/seeddemo/topup.go`

- [x] add `TopUpOptions { UserID int64, Now time.Time, Seed int64, Days int }` and `TopUp(ctx, s, opts) (*Summary, error)`. (Renamed from the plan's draft `TopUpOpts` for symmetry with the existing `Options` struct; DBPath is left to the CLI layer in Task 5 since the orchestrator receives an already-opened `*store.Store`.)
- [x] for each stream (BP, weight, sleep, food, workouts, diary, HR, SpO2, stress), call the corresponding `store.Latest…` to find `lastTs`; if `!found`, fall back to `now.AddDate(0,0,-1)` (one day of backfill is enough — full seeding is a separate command). Daily streams use `dailyTopUpFrom` which snaps to the day AFTER the latest sample's calendar day; time-series streams use `timeseriesTopUpFrom` which offsets by 1s past the boundary-aligned lastTs so `alignUpToInterval` lands on the next cadence mark.
- [x] derive a per-tick RNG seed `pcg(uint64(opts.Seed) XOR uint64(opts.Now.Unix()/86400))` so re-running the same tick produces identical samples (idempotent on retry).
- [x] for meds: do **not** touch the medication catalog. Iterate existing medication rows for the user; for each one whose active date range covers `lastIntake..now`, append intake_log rows forward (re-using the existing intake-generator logic). Decision recorded in planning: keep windows fixed. `topUpMedIntakes` walks `s.Medication.List(true)`, parses each med's schedule, advances from `LatestScheduledIntake + 1d` to `now ∩ end_date`, and applies the same `pickIntakeOutcome` distribution past the 2-day pending cutoff.
- [x] also handle workouts catalog reuse: `topUpWorkouts` reads the existing `workout_groups` / `workout_variants` / `workout_exercises` catalog and feeds it back into `generateScheduledSessions` / `generateAdHocSessions` so top-up never duplicates the catalog (loadDemoWorkoutCatalog matches groups by name against `demoStrengthGroup`/`demoCardioGroup`).
- [x] write tests covering: (a) empty DB top-up generates a 1-day backfill (`TestTopUpEmptyDBProducesBackfill`), (b) seeded DB top-up generates rows strictly after the prior max (`TestTopUpAfterSeedAdvancesStreams`, `TestTopUpStrictlyAfterLastTs`), (c) running top-up twice in a row is a no-op for streams (`TestTopUpIsIdempotentOnSameDay`, `TestTopUpIsIdempotentForDailyStreams`), (d) HR/SpO2/stress UNIQUE PK + millisecond/second offset prevents duplicates (`TestTopUpMillisecondSeedAvoidsCollision`), plus `TestTopUpMedIntakesAppendsButDoesNotDuplicateCatalog`, `TestDailyTopUpFromSnapsToDayAfter`, `TestTopUpRequiresUserID`.
- [x] run `go test ./internal/seeddemo/...` — passes in ~2s.

### Task 5: Wire `-topup` flag into `cmd/seeddemo/main.go`

- [x] add `-topup` boolean flag (mutually exclusive with `-wipe`; if both set, error out with a clear message). The check uses `fs.Visit` to detect operator-explicit `-wipe` so the default `wipe=true` doesn't accidentally trip the guard when only `-topup` is passed; in that case `-wipe` is force-cleared so the uniform downstream code path doesn't drop the data we're appending to.
- [x] add `-now` flag (RFC3339 string, default empty → `time.Now()`) for deterministic testing.
- [x] when `-topup` set, skip `WipeUser` and call `seeddemo.TopUp` instead of `seeddemo.Seed`. (`main` now dispatches to `seeddemo.TopUp` vs `seeddemo.Run` based on the `-topup` flag; `seeddemo.Run` already gates wipe behind `opts.Wipe` so the same Options.Wipe=false also works.)
- [x] update help text and the existing `cmd/seeddemo`-related comment block in `CLAUDE.md`. Both the package doc comment and CLAUDE.md's `cmd/seeddemo` block now show full-seed + top-up invocations.
- [x] write a `cmd/seeddemo` integration test (or `internal/seeddemo/topup_cli_test.go`) that runs the binary against a tempdb with `-topup`, asserts non-zero rows added, then runs it again and asserts ≤1 net new row per stream. Implemented as `cmd/seeddemo/main_test.go` driving the extracted `run([]string, io.Writer) int` directly (no subprocess), with cases for missing `-user`, mutually-exclusive `-topup`+`-wipe`, invalid `-now`, and the empty-DB add-then-idempotent flow.
- [x] run `go test ./cmd/seeddemo/... ./internal/seeddemo/...` — passes in ~3s.

### Task 6: Add demo-mode background top-up loop in the bot

- [x] confirm how `DEMO_MODE=1` is read in `cmd/bot/main.go` (server build). It is read in `internal/config/config.go` via `parseBoolEnv("DEMO_MODE", false)` into `cfg.DemoMode`, and the server-build composition root `cmd/bot/main_server.go` consults `cfg.DemoMode` (it also fails-fast if `ALLOWED_USER_ID` is unset alongside `DEMO_MODE=1`).
- [x] add `DEMO_TOPUP_INTERVAL` env var (default `1h`, parsed with `time.ParseDuration`) and `DEMO_USER_ID` (reused `ALLOWED_USER_ID` per docs/demo-mode.md). Added `DemoConfig.TopUpInterval` (with `parsePositiveDurationEnv` helper that rejects ≤0 durations and malformed strings, falling back to 1h with a slog.Warn). Also added optional `DEMO_TOPUP_SEED → DemoConfig.TopUpSeed` (default 0) so operators can override the deterministic per-tick seed without rebuilding.
- [x] in `cmd/bot/main_server.go`, after store init and before HTTP listener starts: when `cfg.DemoMode` is true, launch `go demotopup.Run(ctx, demotopup.Config{...})` using the signal-tied `ctx` so SIGINT/SIGTERM cancels the loop alongside HTTP shutdown.
- [x] new package `internal/demotopup/` (`runner.go`) with `Run(ctx, Config)`: ticker calls `seeddemo.TopUp` every interval. First tick fires immediately on startup. Errors are swallowed with `slog.Error`; success logs `demotopup: tick completed` with `added_rows` (sum of every per-stream count on the Summary) and `duration`. The Config indirects the topup call through a `TopUpFunc` and the wall clock through a `func() time.Time` so tests don't have to stand up a real SQLite database.
- [x] write tests for `demotopup.Run` in `internal/demotopup/runner_test.go`: bail-out arms (zero user id, zero/negative interval, nil store), first-tick-fires-immediately, ticks-at-interval, context-cancel-exits-the-loop, errors-are-swallowed-and-loop-keeps-ticking. All five tests use a stub `TopUpFunc` and a sentinel `&store.Store{}` pointer (the stub never dereferences it).
- [x] run `go test ./internal/demotopup/... ./cmd/bot/...` — passes. Also re-ran `go test ./internal/config/...` and `go test ./...` — full suite green; `go vet ./...` clean.

### Task 7: Documentation

- [x] update `docs/demo-mode.md`: new section "Automatic top-up" explaining the in-process goroutine, `DEMO_TOPUP_INTERVAL`, and that a manual `seeddemo -topup` run is still supported for ops. Also added `DEMO_TOPUP_INTERVAL` + `DEMO_TOPUP_SEED` rows to the env-var table, a `internal/demotopup/runner.go` line to the build seam, a top-up smoke-test bullet, and rewrote the operator runbook's "schedule a nightly re-seed cron" line to note that the in-process loop now handles freshness.
- [x] update `CLAUDE.md` `cmd/seeddemo` example block to show the new flag. The block already showed `-topup`; expanded to mention continuous HR/SpO2/stress samples in the seeded data list and to point at the new `internal/demotopup` package + the docs/demo-mode.md anchor.
- [x] no test changes for doc-only tasks.

### Task 8: Verify acceptance criteria

- [ ] verify HR / SpO2 / stress time-series populated after a full seed (smoke run, then SQL count).
- [ ] verify `seeddemo -topup` against an aged DB advances last timestamps in every stream.
- [ ] verify running `seeddemo -topup` twice is a no-op (or near-no-op within one sample interval) — idempotency.
- [ ] verify the demo bot, with `DEMO_MODE=1` and `DEMO_TOPUP_INTERVAL=1m`, ticks and adds rows in the background.
- [ ] run full test suite `go test ./...` — must pass.
- [ ] run `pnpm test` to confirm no frontend regressions from the new data shape.
- [ ] run linter (`go vet ./...` and the project's `golangci-lint` config if present) — all issues must be fixed.

### Task 9: [Final] Update project knowledge

- [ ] if a non-obvious pattern emerged (e.g., a clever per-tick seed derivation, a non-obvious "first tick on startup" decision), add a brief note under the seeddemo section of `CLAUDE.md`.

## Technical Details

**Top-up window discovery (per stream)**:

| Stream | "last timestamp" query | Window | Idempotency |
|---|---|---|---|
| `vitals_heart` | `SELECT MAX(date_time) FROM vitals_heart WHERE user_id=?` | `(lastTs, now]` | PK collision → INSERT OR IGNORE |
| `vitals_spo2` | same | `(lastTs, now]` | PK collision → INSERT OR IGNORE |
| `vitals_stress` | same | `(lastTs, now]` | PK collision → INSERT OR IGNORE |
| `sleep_logs` | `MAX(end_time)` | next overnight block after lastTs (only emit if `now > lastEnd + 12h`) | UNIQUE(user_id, start_time) |
| `bp_readings` | `MAX(taken_at_unix)` | next morning/evening slot after lastTs | sample at `lastTs + Δ` with Δ ≥ 1s |
| `weight_logs` | `MAX(taken_at_unix)` | next weekly slot | weekly cadence inherently dedupes |
| `food_logs` | `MAX(taken_at_unix)` | next meal slot after lastTs | per-second timestamp uniqueness |
| `workouts` | `MAX(start_at_unix)` | next planned slot per program | start_at + 1s headroom |
| `diary` | `MAX(created_at)` | one new entry per 5–10 days probabilistic | created_at uniqueness |
| `intake_log` | per-medication `MAX(scheduled_at_unix)` | scheduled doses between lastTs and now for still-active courses | UNIQUE(med_id, scheduled_at_unix) |

**Per-tick RNG seed**: `pcg(seedFromOpts XOR (now.Unix()/86400))` — same calendar day → same samples even if the tick fires twice. This makes idempotency robust without requiring the DB to be the single source of truth on retry.

**Sample density**: For HR/SpO2/stress, generate at fixed cadence (15 / 15 / 30 min) anchored to `00:00 UTC` so two consecutive top-ups produce a deterministic sample set regardless of when each tick happens.

**Goroutine lifecycle**: `demotopup.Run` uses `time.NewTicker(interval)` and selects on `ctx.Done()`. First tick fires immediately. Errors logged but do not crash the bot — top-up failure must never take down the demo.

**Mutual exclusion in CLI**: `-topup` and `-wipe` together → exit 2 with "use either -wipe (full re-seed) or -topup (incremental), not both".

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only.*

**Manual verification on the demo deployment**:
- After deploying the new image, SSH to the demo host (or use Portainer logs) and confirm the line `demo top-up tick added_rows=N duration=…` appears at the configured interval.
- Open the demo Vitals tab and confirm the HR / SpO2 / stress charts now render with continuous samples up to "today".
- Wait one tick interval, refresh, confirm timestamps advanced.

**Optional ops changes** (not required, the in-process loop is enough):
- The previously-suggested external Portainer cron for nightly full re-seed can be removed — top-up keeps data fresh continuously. If the operator still wants a periodic full reset (e.g., to keep DB size bounded), they can schedule `seeddemo -wipe` weekly via Portainer task.
- Document `DEMO_TOPUP_INTERVAL` in the demo deployment runbook so operators know how to tune it (e.g., to 5m for a "live" feeling demo or to 24h for a quieter one).

**External system updates**: none — same binary, same image, same compose stack. Only the bot's runtime behavior changes when `DEMO_MODE=1`.
