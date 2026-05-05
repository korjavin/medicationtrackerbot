# Demo data seeder (cmd/seeddemo)

## Overview

A standalone CLI binary that wipes a target user's data and seeds 90 days (configurable) of synthetic, varied health-tracking data so the app can be demoed: medications with overlapping start/end courses, BP/weight/sleep time series with visible trends, food logs with target hits and misses, planned + custom workouts with varied completion, diary notes, and a mid-period timezone change.

The generator is deterministic by default (seedable RNG) so re-running produces a reproducible demo. Within one run the data has high variability (multiple meds, taken/skipped/missed intakes, weight downtrend then plateau, BP elevated/normal mix, hit/miss meal targets, mix of planned + ad-hoc workouts). Between runs variability is intentionally low — that matches the request.

Pattern matches existing CLI tools: `store.New(dbPath)` → call store/domain methods → exit. No HTTP surface, no bot command, no env-gated admin endpoint. Run before the demo: `go run ./cmd/seeddemo -user <id> -db meds.db -days 90 -wipe`.

## Context

- Files involved (read):
  - `cmd/importer/main.go`, `cmd/bpimporter/main.go` — CLI conventions (flags, store init, exit codes)
  - `internal/store/store.go` — `New()`, table inserts (medications, intake_log, weight, sleep, food, diary)
  - `internal/store/workout.go` — `CreateWorkoutGroup`, `CreateWorkoutVariant`, `CreateWorkoutExercise`, `LogExerciseWithSource`
  - `internal/store/migrations/` — schema reference (food_targets, timezone_history, weight_unit_preference)
  - `internal/domain/medication.go`, `internal/domain/exercise.go` — domain methods (used where backdating not required)
- Related patterns:
  - Direct store calls for backdated rows (importers do this); domain services for present-time confirmations only.
  - Goose runs migrations on `store.New()` — no manual DB setup needed.
  - `slog` for logging (CLAUDE.md rule 5).
- Dependencies: no new external libs. Use `math/rand/v2` with a fixed seed for determinism.

## Development Approach

- Testing approach: regular (code first, tests after). No unit tests for randomness. One integration test that runs the seeder against an in-memory SQLite and asserts each domain table has rows in the expected ranges.
- Complete each task fully before moving to the next.
- Use store methods directly when timestamps must be backdated. Use domain services only where they accept explicit timestamps.
- Generator code lives in a new package `internal/seeddemo/` so `main.go` stays thin (≤80 lines). Each domain (meds, vitals, food, workouts, misc) gets its own file in that package.
- CRITICAL: all tests must pass before starting next task.

## Implementation Steps

### Task 1: Scaffold cmd/seeddemo + internal/seeddemo package

**Files:**
- Create: `cmd/seeddemo/main.go`
- Create: `internal/seeddemo/seeddemo.go` (entry: `func Run(ctx, store, opts Options) error`)
- Create: `internal/seeddemo/clock.go` (date-walking helpers, anchor = now)
- Create: `internal/seeddemo/wipe.go` (delete-by-user_id across all scoped tables)

- [x] Define CLI flags: `-user int64` (required), `-db string` (default "meds.db"), `-days int` (default 90), `-wipe bool` (default true), `-seed int64` (default 42)
- [x] Open DB via `store.New(dbPath)`; refuse to run if `user == 0`
- [x] Implement `WipeUser(ctx, store, userID)` deleting from: intake_log, blood_pressure_readings, weight_logs, sleep_logs, food_log, food_products, diary_notes, workout_exercise_logs (via session join), workout_sessions, workout_rotation_state (via group join), workout_exercises (via variant join), workout_variants (via group join), workout_groups, weight_reminder_state, bp_reminder_state, push_subscriptions, timezone_history. Plus reset the `settings` row's food targets to zero.
- [x] Implement `Run` skeleton that calls future generator stages in order
- [x] Wire `main.go`: parse flags → open store → call `seeddemo.Run` → log summary counts

### Task 2: Medications generator

**Files:**
- Create: `internal/seeddemo/meds.go`

- [x] Define a fixed catalogue of 4 medications inside the package: e.g. Lisinopril 10mg daily 08:00 (active for full 90d); Metformin 500mg twice/day 08:00+20:00 (active for full 90d); Vitamin D3 supplement 1000IU daily 09:00 (started day -45, ongoing); Amoxicillin 500mg twice/day for 7 days (started day -60, ended day -53)
- [x] For each med, call `store.CreateMedication(...)` with the correct schedule JSON, start_date, end_date (or NULL), tz_shift_policy
- [x] For each scheduled time within each med's active window, insert intake_log rows by `CreateIntake(medID, userID, scheduledAt)` where scheduledAt is in the past, then update status: ~80% TAKEN (with taken_at = scheduled_at ± 0–25min), ~10% SKIPPED, ~5% MISSED, leave the most recent two days as PENDING. Use deterministic RNG.
- [x] For one supplement (Vitamin D3), use the supplement marker (`is_supplement=true` or schedule type) to demonstrate that UI path.

### Task 3: Vitals generators (BP, weight, sleep)

**Files:**
- Create: `internal/seeddemo/vitals.go`

- [x] BP: insert ~70 readings spread across 90 days (skip ~20 days). Generate systolic/diastolic with three regimes — first 30d slightly elevated (135±8 / 88±5), middle 30d normal (122±6 / 78±4), last 30d normal-to-low (118±5 / 75±4). Pulse 65–82. Use `CreateBloodPressureReading`. Vary `site`/`position`/`tag` across rows.
- [x] Weight: ~14 entries (~weekly), starting at 84.0kg, descending trend to 79.5kg over 90d with realistic noise. Use `CreateWeightLog`; include `weight_trend` field on a few entries; set `weight_unit_preference` to "kg" via `SetWeightUnitPreference`.
- [x] Sleep: nightly entry for ~75 of 90 nights. Duration 6.0–8.5h with weekday/weekend variance. `sleep_quality` in 1–5 with mean ~3.5 (stored in `notes` as `quality:N` since the schema has no dedicated column). Set `timezone_offset` based on the user's TZ at that time. Use `ImportSleepLogs` (batch).

### Task 4: Food generator

**Files:**
- Create: `internal/seeddemo/food.go`

- [x] Set food targets: 2200 cal / 250g carbs / 110g protein / 75g fat via `SetFoodTargets`.
- [x] Seed ~10 food products in `food_products` covering all three sources: 5 manual (oats, chicken breast, rice, broccoli, olive oil), 3 with `source="off"` (with fake barcode + brand), 2 with `source="ai"`. Set per-100g macros realistically.
- [x] For each of the last 90 days, generate 3–4 food_log entries (breakfast, lunch, dinner, sometimes snack). Daily totals oscillate: ~30% over target (110–130%), ~50% on target (90–110%), ~20% under (70–90%). Use the seeded products to compute macros via `domain.CalculateMacros`.
- [x] On ~5 randomly chosen days, create an aggregated meal via `CreateMealFromLogs` (is_meal=true) so the meal-template UI has data.

### Task 5: Workouts generator

**Files:**
- Create: `internal/seeddemo/workouts.go`

- [x] Create one rotating group "Strength" with 3 variants (A: Push, B: Pull, C: Legs), days_of_week [Mon,Wed,Fri], scheduled_time "18:00". Each variant has 4–5 exercises with target_sets/reps/weight. Use `CreateWorkoutGroup`/`CreateWorkoutVariant`/`CreateWorkoutExercise`.
- [x] Create one static group "Cardio" with single variant, days_of_week [Tue,Sat], scheduled_time "07:00", 2 exercises (treadmill, rowing).
- [x] Walk the 90-day window; on each scheduled day, create a workout session (status varies: 70% completed, 15% skipped, 10% in_progress→completed, 5% pending in last 2 days). For completed sessions, insert exercise logs via `LogExerciseWithSource(... "schedule")` matching the variant's exercises with reasonable progression (weights creep up on later weeks). Update `workout_rotation_state` accordingly via `AdvanceRotation`.
- [x] Create 5 ad-hoc/custom sessions scattered in the window with `group_id=-1, variant_id=-1`, status=completed; log 2–3 exercises per session with `source="library"` (e.g., "Plank 3x60s", "Deadlift 5x5 80kg").

### Task 6: Diary + timezone history

**Files:**
- Create: `internal/seeddemo/misc.go`

- [ ] Insert 12 diary notes spread across 90d, varied tags (energy, mood, symptom, blank). Backdate `created_at`.
- [ ] Record 3 timezone history entries via direct insert (or `RecordTimezone` if it accepts a timestamp; otherwise raw INSERT to backdate): "America/New_York" at day -90, "Europe/Berlin" at day -45, "America/New_York" at day -10. Verify the change-log triggers fire.
- [ ] Log a final summary at end of `Run`: counts per domain (meds, intakes, BP, weight, sleep, food logs, workout sessions, exercise logs, diary, TZ entries).

### Task 7: Integration test

**Files:**
- Create: `internal/seeddemo/seeddemo_test.go`

- [ ] One test `TestRunSeedsAllDomains` that opens an in-memory SQLite via `store.New(":memory:")`, calls `seeddemo.Run` with userID=12345, days=90, seed=42.
- [ ] Assert minimum row counts per table (e.g. ≥4 medications, ≥200 intake_log rows, ≥50 BP readings, ≥10 weight logs, ≥60 sleep logs, ≥250 food_log rows, ≥6 food_products, ≥30 workout_sessions, ≥80 workout_exercise_logs, ≥10 diary_notes, ≥3 timezone_history rows).
- [ ] Assert determinism: running twice with same seed yields identical row counts and same first/last BP systolic value.
- [ ] Assert wipe: pre-populate one BP row, run with `Wipe=true`, confirm pre-existing row is gone.
- [ ] run project test suite — must pass before next task

### Task 8: Verify acceptance criteria

- [ ] `go build ./cmd/seeddemo` succeeds
- [ ] `go test ./...` passes (full suite)
- [ ] `go vet ./...` clean

### Task 9: Update documentation

- [ ] Add a "Demo data seeder" subsection under "Data import tools" in CLAUDE.md (one paragraph + the run command)
- [ ] If a `docs/development.md` or equivalent exists, document the seeder there too; otherwise no extra doc file
- [ ] Move this plan to `docs/plans/completed/`
