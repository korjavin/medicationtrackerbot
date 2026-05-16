# Simplify Medication Scheduling: UTC Unix Storage + Pre-materialized TZ Steps

> **Status (2026-05-10):** Track A Tasks 1–6 (and the `intake_log`-scoped portions of Task 8) were narrowed and shipped under `docs/plans/2026-05-10-intake-log-utc-unix-fix.md` after a 2026-05-10 production incident forced the work early. The remaining scope of this plan is:
> - **Task 7** — convert `tz_transition_plans.created_at` / `notified_at` / `approved_at` to unix seconds.
> - **Task 8** — extend `internal/store/intake_log_time_columns_test.go`'s allowlist (and any equivalent in `store_time_invariants_test.go`) to cover the columns added by Task 7.
> - **Track D** (Tasks 9–13) — pre-materialize transition steps as `intake_log` rows; drop `tz_transition_steps`.
> - **Tasks 14–16** — final doc sweep, follow-up stub, acceptance verification.
>
> Tasks 1–6 below are kept verbatim for design history; do not re-run them — the corresponding columns already exist on `intake_log` and are enforced by `intake_log_time_columns_test.go`.

## Overview

The medication scheduler has produced a steady drip of bugs over the last
month — the last six fixes (1169cd6, b952747, ec97a1f, 0bb7485, 26e4502,
b1b4ced) and the unifying refactor 1deb364 are all variants of two structural
cracks:

1. **Time isn't normalized at the storage boundary.** `intake_log.scheduled_at`
   round-trips through SQLite as `2026-05-06 06:30:00 +0200 CEST`-style
   strings (modernc.org/sqlite serializes `time.Time` via `t.String()` with
   the embedded zone name). `WHERE scheduled_at = ?` therefore mismatches
   the same instant once the server and the user are in different zones.
   1169cd6 #1 patched the symptom by switching `Confirm ALL` to in-memory
   `time.Equal` filtering — that's a workaround for a wrong primitive, and
   the next caller will hit it again.
2. **Transition steps are a parallel state machine bolted onto medication
   scheduling.** `tz_transition_steps` lives in its own table; the scheduler
   has to load it every tick, decide whether the active plan is
   `APPROVED` / `COMPLETED` / falls-back-to-most-recent-COMPLETED, fetch
   `consumed_step_time_per_med` for an "overlap guard" that suppresses normal
   slots overlapping with consumed steps, and `MarkStepConsumed` when a
   normal intake materializes for a step's clock time. The overlap guard has
   been wrong three times in a month (ec97a1f, 0bb7485, 1169cd6 #3).

This plan does two structural changes — labelled **A** and **D** in the
preceding analysis — that together delete the entire "two tables,
two-source-of-truth, equality-by-string-zone" complex.

**A. Canonicalize `scheduled_at` (and every paired dose timestamp) as
INTEGER unix seconds.** SQL equality becomes safe; the cross-TZ filter
workarounds disappear; the same primitive works for every caller.

**D. Treat transition steps as pre-materialized PENDING `intake_log` rows.**
When a plan is approved, write the steps straight into `intake_log` with
`source = 'tz_step'`. The scheduler then has one input table — pending
intakes — and the dedup against normal slots is automatic. The "consumed
step overlap guard" stops existing.

We do **not** touch the plan-state lifecycle (`PENDING_APPROVAL` /
`NOTIFIED` / `APPROVED` / …) in this plan — that's recommendations C / E
from the analysis and lives in a follow-up plan.

## Context

Adopted from `docs/plans/2026-05-06-simplify-medication-scheduling-utc-and-pre-materialized-steps.md`.

### What stores dose times today

`intake_log.scheduled_at` (DATETIME) is the canonical "this dose is due at
instant T" column. It's:

- written by `Store.CreateIntake` (auto) and `Store.CreateManualIntake`
  (manual);
- read by `GetPendingIntakes`, `BatchGetIntakesBySchedule`, the per-id
  `GetIntake`, `GetIntakeBySchedule`, the history endpoint, and by every
  callback that wants "the intake whose schedule equals this Unix
  timestamp from a Telegram button" (`confirm_schedule:<unix>`);
- **compared via `WHERE scheduled_at = ?`** in 4 spots — every one of them
  is fragile across TZs;
- compared in-memory via `time.Equal` in 2 spots — the workaround added in
  1169cd6 (`GetPendingIntakesBySchedule`, `ConfirmIntakesBySchedule`).

Other related timestamps:

| Column | Table | Purpose | Comparison style today |
|---|---|---|---|
| `intake_log.taken_at` | `intake_log` | when the user confirmed | mostly read-only / displayed |
| `intake_log.snoozed_until` | `intake_log` | next reminder cutoff | `time.After(*p.SnoozedUntil)` (in-memory) |
| `tz_transition_steps.scheduled_at` | `tz_transition_steps` | step due-at | `WHERE scheduled_at <= ?` for forecast |
| `tz_transition_steps.consumed_at` | same | when scheduler materialised the step | nullable, unused for equality |
| `tz_transition_plans.created_at` / `notified_at` / `approved_at` | `tz_transition_plans` | lifecycle observability | `time.Since(...)` only |

Migrations 001 and 047 declare these as `DATETIME`. There's no IANA-zone
information stored anywhere alongside them — every `time.Time` is
intended to mean "instant T", but the SQLite wire format leaks the
producer's zone name and breaks equality.

### How transition steps interact with the scheduler today

`MedicationChecker.Check` (`internal/scheduler/medication.go`, ~340 LoC of
orchestration) does, every minute:

1. Load user TZ. If active plan is `PENDING_APPROVAL` / `NOTIFIED`, override
   to `OldTZ`.
2. Load active plan + (separately) most-recent `COMPLETED` plan, because
   `GetLatestActiveOrPendingTZTransitionPlan` deliberately excludes
   `COMPLETED` and the overlap-guard data must outlive the tick that
   completes a plan.
3. If active plan is `APPROVED` and steps remain, call them
   `pendingSteps`. If 0 remain, mark `COMPLETED`.
4. Call `GetLatestConsumedStepTimePerMed(planID)` — produces a
   `map[medID]time.Time` of "latest consumed step per med".
5. Call `medplan.PlanDoses` with all of the above.
6. For each plan-step target that fires, `MarkStepConsumed(stepID, now)`.
7. For each normal-schedule target, the overlap guard inside `medplan`
   skips it if it falls at-or-before `consumedStepTimeByMed[medID]` or
   within `minInterval` after.

Every numbered point above was the source of one of the recent bugs.

## Development Approach

- **Two tracks, can ship independently.** Track A (UTC unix seconds) is
  pure storage refactor; Track D (pre-materialized steps) is data-model.
  We do A first because it makes D simpler — once `scheduled_at` is an
  int64 the dedup join in step (D2) is a clean equality.
- **Single-binary, self-hosted deploy.** This project is one Go binary
  the operator restarts on upgrade — no rolling deploy, no two
  versions running at once. Dual-write windows therefore exist purely
  to keep migrations reversible during development, not to support
  mixed-version production traffic.
- **No big-bang migration, but forward-only after table-rebuilds.**
  Each migration is additive (new column, new index, new table) and
  rolls back via its down-step — except for A4 and D5, which use the
  SQLite `CREATE TABLE … new` + copy + drop + rename pattern to remove
  columns. Their down-steps are best-effort (recreate the prior shape,
  copy back; original row order and any post-A4 inserts are
  preserved, but production rollback past these points should rely on
  a DB backup, not the goose down). Tasks A4 and D5 explicitly call
  this out.
- **Migration numbers are placeholders.** Concrete numbers are
  assigned at PR time in the order tasks merge. The plan keeps
  `0XX_*` placeholders throughout and pins `057` only as the
  next-free number at the time of writing — A5's expansion will
  consume several more before D-track ships.
- **Goose Go migrations are introduced by this plan.** The project
  has been goose-SQL-only by convention (verified: every file in
  `internal/store/migrations/` is `*.sql`, and `goose.SetBaseFS` /
  `goose.Up` at `internal/store/store.go:222-226` runs against the
  embedded SQL FS). Goose itself supports Go migrations alongside
  SQL — the D2 backfill is the first use, and exists because the SQL
  form needs the operator's `user_id` from env, which SQL migrations
  can't read. Document the precedent in `docs/architecture.md` so
  future Go migrations follow the same pattern.
- **TDD.** Every gap I've identified has a regression test that exists or
  needs to exist. Each task starts with a red test and ends green. The
  cross-TZ tests added in 1169cd6 and the overlap-guard tests added in
  ec97a1f / 0bb7485 are the canaries — they must stay green after the
  workaround code is deleted.
- **Behavioural compatibility is the bar.** The user-visible behaviour of
  scheduling, confirming, and TZ transitions does not change. The plan
  simplifies the *implementation*; new features (auto-approve, undo
  affordance, etc. — recommendations C and E) are deliberately out of
  scope.
- **PR boundaries.** Track A merges first and bakes for at least one
  release before Track D starts, so we can spot any TZ-equality
  regression in production before pulling out the workarounds. Within
  Track D, **D1 + D2 + D3 + D4 ship as a single PR** — D2 writes
  pre-materialized rows but only D3 + D4 teach the scheduler and the
  forecast endpoint to read them; shipping D2 alone would leave the
  Today UI's next-intake preview stale until each step's tick fires.
  D5 (drop the legacy `tz_transition_steps` table) ships in a
  follow-up PR after D1–D4 has baked.
- Complete each task fully before moving to the next.
- Update this plan when scope changes during implementation.

## Testing Strategy

- **Unit tests, store layer:** every changed store method gets a
  cross-timezone case (server in `Europe/Berlin`, user in
  `America/Los_Angeles`) that asserts equality holds.
- **Unit tests, scheduler:** the existing `scheduler_test.go`,
  `medication_tz_test.go`, `notifier_test.go`, `medplan_test.go` and
  `engine_test.go` suites must stay green at every task boundary. New
  tests for Track D pin the "pre-materialized step deduplicates the
  normal-schedule slot" invariant.
- **Migration tests:** every migration is round-tripped (up → down → up)
  in a SQLite-backed test using a fixture intake row in a non-UTC server
  TZ. The fixture asserts the row is still readable after up-migration
  and that `scheduled_at` represents the same instant.
- **Integration test:** the end-to-end "BP / weight / meds in
  Europe/Berlin server, user in PDT, take a step at 22:30 PDT, no
  duplicate at 21:30 next tick" scenario from 1169cd6 #3 is the headline
  acceptance test — already exists, kept green throughout.
- **Manual smoke (optional, before tagging release of Track A):** spin up
  with `TZ=Europe/Berlin` and a user TZ of `America/Los_Angeles`, confirm
  via Telegram the `Confirm ALL` button reports a non-zero confirm count.
- Run project tests after each Task before proceeding.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document blockers with ⚠️ prefix.
- Update plan if implementation deviates.

## Implementation Steps

**Track A — Canonicalize `scheduled_at` as UTC unix seconds.** Tasks 1 through 8 cover the storage refactor: introduce INTEGER unix-seconds columns, dual-write, cut over readers, drop legacy DATETIME columns. Track A merges first and bakes for at least one release before Track D starts.

### Task 1: Document the convention; no helper package — SUPERSEDED by 2026-05-10 plan

- [x] **No new `internal/util/unixsec` package.** (satisfied by 2026-05-10 plan — no `internal/util/unixsec` exists; conversions live inline at the store boundary as designed)
- [x] add a single comment block at the top of `internal/store/store.go` (satisfied by 2026-05-10 plan — package comment at `internal/store/store.go:1-27` lists every dose-related INTEGER unix-seconds column and references `TestDoseTimeColumnsAreInteger` as the audit anchor)
- [x] write tests: table-driven `time.Unix(t.Unix(), 0).UTC().Equal(t)` invariant (satisfied by 2026-05-10 plan — `TestTimeUnixUTCRoundTrip` in `internal/store/store_time_invariants_test.go` covers UTC, Europe/Berlin (CEST + CET), America/Los_Angeles (PDT + PST), America/Phoenix)
- [x] run project tests (satisfied by 2026-05-10 plan — Task 7/8 already required and verified `go test ./...` green; nothing to re-run for an already-shipped task)

### Task 2: Migration — add `scheduled_at_unix` column to `intake_log`, backfill, dual-write — SUPERSEDED by 2026-05-10 plan

- [x] migration `0XX_add_intake_log_scheduled_at_unix.sql` (satisfied by
  2026-05-10 plan — `057_add_intake_log_scheduled_at_unix.sql` adds the
  INTEGER column, backfills via a production-format-aware `strftime` that
  handles both RFC3339 and `t.String()` variants observed in prod, and
  creates `idx_intake_log_scheduled_at_unix`)
- [x] update `Store.CreateIntake` / `Store.CreateManualIntake` to write
  both `scheduled_at` (legacy) and `scheduled_at_unix` (new) (satisfied
  by 2026-05-10 plan — dual-write step was collapsed because Tasks 2–4
  shipped as one PR; writers in
  `internal/store/medication/repo.go:441,452` now stamp `scheduled_at_unix`
  directly and migration 058 dropped the legacy DATETIME column)
- [x] write tests: migration goes through `up → down → up` round-trip
  test (satisfied by 2026-05-10 plan —
  `internal/store/migration_057_test.go` pins both production storage
  formats across PDT/MST/CEST/UTC and exercises up → down → up)
- [x] run project tests (satisfied by 2026-05-10 plan — `go test ./...`
  was required green at every task boundary of that plan; nothing to
  re-run for an already-shipped task)

### Task 3: Switch every reader to `scheduled_at_unix` — SUPERSEDED by 2026-05-10 plan

- [x] change `Store.GetIntakeBySchedule`, `BatchGetIntakesBySchedule`,
  `GetPendingIntakesBySchedule`, `ConfirmIntakesBySchedule`,
  `GetIntake`, `GetIntakeHistory`, `GetPendingIntakes` to read the unix
  column and `Scan` into `int64`, then convert via `time.Unix(n, 0).UTC()`
  before returning the struct field (satisfied by 2026-05-10 plan — every
  named reader in `internal/store/medication/repo.go` now selects
  `scheduled_at_unix` (and where relevant `taken_at_unix`,
  `snoozed_until_unix`) and converts via `storedb.UnixToTime` /
  `NullableUnixToTimePtr` before populating `IntakeLog`)
- [x] **delete the in-memory `time.Equal` filter** in
  `GetPendingIntakesBySchedule` and `ConfirmIntakesBySchedule` — replace
  with a real `WHERE scheduled_at_unix = ?` predicate (satisfied by
  2026-05-10 plan — `time.Equal` no longer appears in
  `internal/store/medication/repo.go`; `GetPendingIntakesBySchedule` now
  uses `WHERE … AND scheduled_at_unix = ?` and `ConfirmIntakesBySchedule`
  delegates to it)
- [x] keep the `time.Time` field in the public `IntakeLog` struct — only
  the wire format changes (satisfied by 2026-05-10 plan — `IntakeLog`
  still exposes `ScheduledAt time.Time` /
  `TakenAt *time.Time` / `SnoozedUntil *time.Time`; only the SQL column
  shape changed)
- [x] write tests: add cross-TZ regression test that builds an intake whose
  `scheduled_at` was originally produced in `Europe/Berlin`, queries it
  from a server pretending to be in `America/Los_Angeles`, asserts the
  query matches. (satisfied by 2026-05-10 plan —
  `internal/store/medication/intake_log_readers_tz_test.go` covers every
  reader with the Berlin↔LA scenario)
- [x] run project tests - must pass before next task (`go test ./...`); the existing 1169cd6 cross-TZ tests stay green using the new SQL equality path. (satisfied by 2026-05-10 plan — `go test ./...` was required green at every task boundary of that plan; nothing to re-run for an already-shipped task)

### Task 4: Drop the legacy `scheduled_at` text column from `intake_log` — SUPERSEDED by 2026-05-10 plan

- [x] migration `0XX_drop_intake_log_scheduled_at_text.sql`:
  table-rebuild (satisfied by 2026-05-10 plan —
  `058_drop_intake_log_scheduled_at_text.sql` rebuilds `intake_log` via
  the standard SQLite `CREATE … new` + `INSERT … SELECT` + `DROP` +
  `RENAME` pattern, preserving every other column, the
  `idx_intake_log_status` and `idx_intake_log_scheduled_at_unix`
  indexes, and the three `trg_change_intake_log_*` triggers from
  migration 027 verbatim; row `id` values are preserved so the
  `intake_reminders.intake_id` FK still matches.)
- [x] **forward-only checkpoint.** (satisfied by 2026-05-10 plan —
  migration 058's down-step header documents that the down rebuild
  reconstructs `scheduled_at` lossily as `datetime(unix,'unixepoch')`
  UTC text with no original timezone name, and that production
  rollback past this migration must restore from a Litestream backup
  rather than run goose down.)
- [x] confirm migration runs against a populated DB on a CI fixture
  carrying ≥ 100 historical rows (satisfied by 2026-05-10 plan —
  `internal/store/migration_058_test.go` exercises the rebuild on a
  populated fixture and the existing migration round-trip harness
  already covers up → down → up for migration 058 against the live
  schema.)
- [x] remove the `scheduled_at` legacy field from the dual-write in
  `CreateIntake` / `CreateManualIntake` (satisfied by 2026-05-10 plan —
  `internal/store/medication/repo.go` no longer references the legacy
  text column in any SQL statement; the only remaining occurrence is
  the `ScheduledAt time.Time` JSON tag on the `IntakeLog` struct, which
  is the public wire-format field and is unaffected by the storage
  change.)
- [x] write tests: extend the migration round-trip suite to cover the
  table-rebuild on a populated fixture. (satisfied by 2026-05-10 plan —
  migration 058 round-trip and rebuild tests live in
  `internal/store/migration_058_test.go`; the cross-TZ reader regression
  in `internal/store/medication/intake_log_readers_tz_test.go` exercises
  the end state.)
- [x] run project tests (satisfied by 2026-05-10 plan — `go test ./...`
  was required green at every task boundary of that plan; nothing to
  re-run for an already-shipped task).

### Task 5: Convert `intake_log.taken_at` → `taken_at_unix` — SUPERSEDED by 2026-05-10 plan

Apply the same Task 2 → Task 3 → Task 4 pattern (add column + dual-write → cut over readers → drop legacy via table-rebuild) to `taken_at`. Independent of Tasks 6 and 7 — can ship in a parallel PR after Task 4 lands. **Track D's columns are deliberately excluded** — `tz_transition_steps.scheduled_at` and `consumed_at` would convert and then immediately be dropped by Task 13, so the table is left as DATETIME until Task 13 retires it.

- [x] add column + backfill `UPDATE intake_log SET taken_at_unix =
  strftime('%s', taken_at) WHERE taken_at IS NOT NULL;` (`taken_at_unix INTEGER` is nullable) (satisfied by 2026-05-10 plan — `059_add_intake_log_taken_at_unix.sql` adds the nullable INTEGER column and backfills with the same prod-format-aware strftime used for `scheduled_at_unix`)
- [x] dual-write in `MarkIntakeTaken`, `CreateManualIntake`, any
  setter that touches `taken_at` (satisfied by 2026-05-10 plan — writers in `internal/store/medication/repo.go` stamp `taken_at_unix` directly via `storedb.TimeToUnix`; migration 060 dropped the legacy DATETIME column so dual-write collapsed to single-write)
- [x] cut over readers in history endpoint, archived-meds query,
  per-id `GetIntake` (satisfied by 2026-05-10 plan — every `IntakeLog` reader selects `taken_at_unix` and converts via `storedb.NullableUnixToTimePtr` before populating the struct)
- [x] table-rebuild migration drops the legacy column (satisfied by 2026-05-10 plan — `060_drop_intake_log_taken_at_text.sql` rebuilds `intake_log` via the standard SQLite CREATE-new + INSERT-SELECT + DROP + RENAME pattern, preserving indexes and triggers)
- [x] write tests: history endpoint cross-TZ scan + per-id read. (satisfied by 2026-05-10 plan — `internal/store/medication/intake_log_readers_tz_test.go` covers the Berlin↔LA scenario for every reader, including `GetIntakeHistory` and per-id `GetIntake`; migration round-trip in `internal/store/migration_060_test.go`)
- [x] run project tests - must pass before next task. (satisfied by 2026-05-10 plan — `go test ./...` was required green at every task boundary of that plan; nothing to re-run for an already-shipped task)

### Task 6: Convert `intake_log.snoozed_until` → `snoozed_until_unix` — SUPERSEDED by 2026-05-10 plan

Same pattern as Task 5, applied to `snoozed_until` (nullable INTEGER).

- [x] add column + backfill (satisfied by 2026-05-10 plan — `061_add_intake_log_snoozed_until_unix.sql` adds the nullable INTEGER column and backfills via the prod-format-aware strftime used for `scheduled_at_unix` / `taken_at_unix`)
- [x] dual-write in `SnoozeIntake` (satisfied by 2026-05-10 plan — `SnoozeIntake` in `internal/store/medication/repo.go` writes `snoozed_until_unix` directly via `storedb.TimeToUnix`; migration 062 dropped the legacy DATETIME column so dual-write collapsed to single-write)
- [x] cut over reader in `GetPendingIntakes` (satisfied by 2026-05-10 plan — readers in `internal/store/medication/repo.go` select `snoozed_until_unix` and convert via `storedb.NullableUnixToTimePtr` before populating `IntakeLog.SnoozedUntil`; the `medication_reminder` loop still uses in-memory `time.After(*p.SnoozedUntil)` against the `time.Time` field)
- [x] table-rebuild migration drops the legacy column (satisfied by 2026-05-10 plan — `062_drop_intake_log_snoozed_until_text.sql` rebuilds `intake_log` via the standard SQLite CREATE-new + INSERT-SELECT + DROP + RENAME pattern, preserving indexes and triggers)
- [x] write tests: snooze round-trip across TZ change. (satisfied by 2026-05-10 plan — covered by `internal/store/medication/intake_log_readers_tz_test.go` Berlin↔LA scenarios and migration round-trip in `internal/store/migration_061_test.go` / `migration_062_test.go`)
- [x] run project tests - must pass before next task. (satisfied by 2026-05-10 plan — `go test ./...` was required green at every task boundary of that plan; nothing to re-run for an already-shipped task)

### Task 7: Convert `tz_transition_plans.created_at` / `notified_at` / `approved_at`

Same pattern as Task 5, applied to all three plan-lifecycle timestamp columns at once.

- [x] one migration covers all three columns on the same table to
  minimize rebuild churn (migration 064 adds + backfills; migration 065
  rebuilds the table to drop the three legacy DATETIME columns)
- [x] dual-write in `CreateTZTransitionPlan*`, `MarkPlanNotified`,
  `SetTZTransitionPlanApproved` (writers now stamp the `*_unix` columns
  directly; `created_at_unix` is stamped by the column default
  `strftime('%s','now')` to mirror the legacy `CURRENT_TIMESTAMP` shape)
- [x] cut over readers in `tz_plan_notifier` (uses `time.Since`),
  observability log lines (readers now scan `*_unix` INTEGER and convert
  via `storedb.UnixToTime`/`NullableUnixToTimePtr`; `time.Since` and
  slog calls still take the public `time.Time` fields which now arrive
  in UTC — log keys unchanged)
- [x] table-rebuild migration drops the three legacy columns (migration 065)
- [x] write tests: plan-lifecycle test fixture covers each setter
  (`TestTZTransitionPlan_LifecycleTimestamps_UnixUTC` in
  `internal/store/tz/transition_test.go` plus migration round-trip and
  prod-format backfill tests in
  `internal/store/migration_064_test.go` and `migration_065_test.go`).
- [x] run project tests - must pass before next task (`go test ./...` green).

### Task 8: Document and lock in the invariant

- [x] update `docs/architecture.md` with a "Time storage" subsection:
  every dose-related time column is INTEGER unix seconds, UTC; the
  comment block at the top of `store.go` is the audit anchor; SQL
  equality is safe (subsection expanded to cover the
  `tz_transition_plans.{created,notified,approved}_at_unix` columns
  added by Task 7 and now references the cross-table architecture test)
- [x] add an architecture test in `internal/store/` that uses an
  **allowlist of column names** (not a DATETIME grep)
  (`TestDoseTimeColumnsAreInteger` in
  `internal/store/store_time_invariants_test.go` — runs
  `PRAGMA table_info` per table, asserts the allowlist is INTEGER and
  rejects the legacy DATETIME column names. Non-dose DATETIME columns
  are deliberately untouched. `tz_transition_steps.*_unix` is
  intentionally absent from the allowlist — Track A skipped that table
  per the plan's "Track D's columns are deliberately excluded" note,
  and Task 13 will drop the table.)
- [x] update `store_time_invariants_test.go` allowlist to include every
  column converted in Tasks 5–7 (cross-table allowlist added — covers
  `intake_log.{scheduled,taken,snoozed_until}_at_unix` and
  `tz_transition_plans.{created,notified,approved}_at_unix`).
- [x] update `CLAUDE.md` "Common tasks → Adding a new health metric" to
  point at the unix-seconds rule for dose-like columns (now points at
  the cross-table allowlist test and the package comment in
  `store.go`).
- [x] write tests: covered by the architecture test above
  (`TestDoseTimeColumnsAreInteger` parametrized over both tables).
- [x] run project tests - must pass before next task (`go test ./...` green).

**Track D — Pre-materialized transition steps as `intake_log` rows.** Tasks 9 through 13 collapse `tz_transition_steps` into `intake_log` rows with `source='tz_step'`. Track D starts only after Track A has shipped and baked. Tasks 9–12 ship as a single PR; Task 13 ships in a follow-up after that PR has baked.

### Task 9: Add `source`, `tz_plan_id`, `tz_step_number` to `intake_log`

- [x] migration `0XX_add_intake_log_source.sql`:
  `ALTER TABLE intake_log ADD COLUMN source TEXT NOT NULL DEFAULT 'schedule';`
  + `ADD COLUMN tz_plan_id INTEGER;`
  + `ADD COLUMN tz_step_number INTEGER;`
  + foreign key `tz_plan_id REFERENCES tz_transition_plans(id) ON DELETE SET NULL`
    — **but FK enforcement is OFF in this project**.
    `internal/store/miband_workouts.go:419` documents that
    `PRAGMA foreign_keys=ON` is not set on the modernc.org/sqlite
    connection (and miband cleanup cascades manually for the same
    reason). The `ON DELETE SET NULL` clause is therefore documentation
    of intent, not enforcement: with FKs off, deleting a plan row
    leaves dangling `tz_plan_id` values. There is **no plan GC code
    today**, so this isn't an active risk; the lifecycle follow-up plan
    is where any future plan-deletion path will live, and that plan is
    responsible for either (a) turning FKs on globally — its own
    decision because it would activate dormant constraints across the
    schema, or (b) doing an explicit `UPDATE intake_log SET tz_plan_id
    = NULL WHERE tz_plan_id = ?` in the deletion code path.
    Document the current state in `docs/architecture.md` "Time storage"
    subsection. (migration `066_add_intake_log_source.sql` adds all
    three columns and the index; the FK clause is declared on the
    column for documentation and verified by the schema test that
    enables `PRAGMA foreign_keys=ON` locally and observes `SET NULL`
    behavior)
  + index `idx_intake_log_tz_plan_id` for the planner's "delete pending
    rows on plan cancel" query
- [x] update `IntakeLog` struct + `Scan` calls to expose the new columns
  (`Source string`, `TZPlanID *int64`, `TZStepNumber *int64` added to
  `medication.IntakeLog` in `internal/store/medication/repo.go`; every
  reader — `GetPendingIntakes`, `GetTakenIntakesBySchedule`,
  `GetIntakeHistory`, `GetIntake`, `GetIntakeBySchedule`,
  `BatchGetIntakesBySchedule`, `GetPendingIntakesBySchedule`,
  `GetPendingIntakesForMedication`, `GetIntakesSince` — selects the
  three new columns and populates the struct fields)
- [x] no behaviour change yet — `source` is always `'schedule'` in
  practice; this task only opens the slot (writers stayed at the
  pre-Task-9 SQL; the migration's `DEFAULT 'schedule'` populates the
  column at insert time and pre-existing rows backfill via the same
  default)
- [x] write tests: existing intake suite green; one new test asserts the
  default `source = 'schedule'`; one new test deletes a plan row and
  asserts associated intakes survive with `tz_plan_id = NULL`
  (`TestIntakeLog_DefaultSourceIsSchedule` + `TestIntakeLog_TZPlanIDSetNullOnPlanDelete`
  in `internal/store/medication/intake_log_source_test.go`;
  `TestMigration066_AddsSourceAndTZPlanColumns` +
  `TestMigration066_RoundTrip` in `internal/store/migration_066_test.go`
  pin the migration shape).
- [x] run project tests - must pass before next task. (`go test ./...` green)

### Task 10: When a plan is approved, materialize steps as PENDING intakes

- [x] **Domain service per CLAUDE.md rule #1.** Today's
  `handleTZPlanApprove` (`internal/server/settings_handlers.go:645`)
  calls `s.tzPlanStore.SetTZTransitionPlanApproved(...)` directly —
  this already violates the "transports may only call domain
  services" rule. Add `internal/domain/tzreschedule/lifecycle.go` (or
  extend the existing `tzreschedule` package) with a
  `LifecycleService` interface and one method:
  `Approve(ctx, planID int64, approvedAt time.Time) (approved bool, err error)`.
  The service is responsible for opening the `*sql.Tx`, flipping the
  plan to `APPROVED`, calling `MaterializePlanStepsAsIntakes(tx,
  planID)`, and committing. Both the HTTP handler
  (`handleTZPlanApprove`) and the auto-approve path in
  `internal/scheduler/tz_plan_notifier.go` switch to calling the
  service; the Telegram bot's approve callback (if any) does the
  same. (`internal/domain/tzreschedule/lifecycle.go` added with
  `LifecycleService.Approve`; HTTP handler in
  `internal/server/settings_handlers.go:737`, scheduler auto-approve
  in `internal/scheduler/tz_plan_notifier.go`, and bot callback in
  `internal/bot/tz_plan_callbacks.go` all route through it. The
  scheduler constructs its own LifecycleService at scheduler.New;
  cmd/bot/main.go constructs the shared instance and wires it into
  the HTTP server and bot via SetTZLifecycle.)
- [x] add `Store.ApproveAndMaterialize(planID, allowedUserID, approvedAtUnix int64) (bool, error)`:
  internal helper used by the service that opens a single `*sql.Tx`
  and calls private `setTZTransitionPlanApprovedTx(tx, …)` and
  `materializePlanStepsAsIntakesTx(tx, planID, allowedUserID)`
  against that tx, then `Commit()`. **Bool semantics**: `(true, nil)`
  when this call performed the approval (plan was PENDING_APPROVAL /
  NOTIFIED at tx start, is now APPROVED with steps materialized);
  `(false, nil)` when the plan was already past pending and this call
  is a benign no-op (e.g. another caller approved first). Any error
  rolls the tx back via the deferred `Rollback` and returns
  `(false, err)`. The runtime helper takes `allowedUserID` explicitly
  — same single-user-derivation problem as the backfill (see "one-shot
  backfill" sub-bullet below), but at runtime the service has the
  value in scope from the bot/server wiring at `cmd/bot/main.go:218`.
  Plumb it through `LifecycleService.Approve` (constructed once with
  the operator's user_id) so the approve callers don't need to think
  about it. Approve→crash→restart cannot leave a plan APPROVED with
  no materialized intakes, because both writes share one tx.
  (`Repos.ApproveAndMaterialize` in `internal/store/store.go`; uses
  `db.WithTx` to open one tx, calls
  `tz.SetTZTransitionPlanApprovedTx` and
  `medication.MaterializePlanStepsAsIntakesTx` within it. Bool
  semantics covered by `TestApproveAndMaterialize_FlipsAndMaterializes`
  and `TestApproveAndMaterialize_RejectedPlanIsNoOp` in
  `internal/store/approve_and_materialize_test.go`.)
- [x] add a partial unique index
  `(tz_plan_id, tz_step_number) WHERE tz_plan_id IS NOT NULL` so
  re-running materialize is idempotent (e.g. via `INSERT OR IGNORE`)
  (migration 067 `idx_intake_log_tz_plan_step_unique`; verified by
  `TestMigration067_AddsPartialUniqueIndex` in
  `internal/store/migration_067_test.go`. Idempotency end-to-end
  pinned by `TestMaterializePlanStepsAsIntakesTx` re-run assertion.)
- [x] add a corresponding "on plan cancel, delete unconsumed
  pre-materialized rows" path: `DELETE FROM intake_log WHERE
  tz_plan_id=? AND status='PENDING' AND source='tz_step'` — wire it
  into the plan cancel flow in `tzreschedule/planner.go`
  (`medication.Repo.DeletePendingPreMaterializedIntakesForPlan`
  added; planner's `CancelActivePlan` calls it after each cancel via
  the new `PlannerStore.DeletePendingPreMaterializedIntakesForPlan`
  method. The implicit cancel-all inside
  `tz.CreateTZTransitionPlanWithSteps` also deletes orphaned tz_step
  rows in the same tx. Tests:
  `TestDeletePendingPreMaterializedIntakesForPlan` and
  `TestCancelActivePlan_DeletesPreMaterializedRows`.)
- [x] **one-shot backfill via a goose Go migration.** When this
  migration ships, plans already in `APPROVED` (with steps not yet
  fired) must have their steps materialized too — otherwise an
  APPROVED plan whose first step is two days out silently loses its
  scheduling because the scheduler now reads `intake_log` instead of
  `tz_transition_steps`.

  Three constraints push this to a Go migration rather than pure SQL:
  (a) `intake_log.user_id` is `INTEGER NOT NULL` and must reference the
  operator's Telegram ID; the project is single-user gated by
  `ALLOWED_USER_ID` at `cmd/bot/main.go:66`, but SQL migrations have no
  access to env vars and the migration can't fall back to
  `SELECT user_id FROM intake_log LIMIT 1` because a fresh deploy may
  have an APPROVED plan with zero fired intake rows yet — the SELECT
  would no-op and silently lose that plan's scheduling; (b)
  `medications` has no `user_id` column (`001_init.sql:1-9`), so we
  can't join through it to derive one either; (c)
  `tz_transition_steps.scheduled_at` and `consumed_at` are still
  `DATETIME` at this point — Track A deliberately skipped the table since
  Task 13 will drop it — so the backfill must use `strftime('%s', …)` to
  bridge the two formats.

  Goose supports Go migrations alongside SQL (the project has been
  SQL-only by convention; this introduces the first Go migration —
  document the precedent in `docs/architecture.md`). Shape:

  ```go
  // 0XX_backfill_pre_materialized_tz_steps.go
  func upBackfillPreMaterializedTZSteps(ctx context.Context, tx *sql.Tx) error {
      // Operator's user_id from env — single-user project gated by
      // ALLOWED_USER_ID at cmd/bot/main.go:66. Reading from env (vs.
      // SELECT user_id FROM intake_log LIMIT 1) is stricter: a fresh
      // deploy can have an APPROVED plan but zero fired intake rows
      // yet, and a SELECT-based fallback would silently no-op and
      // lose that plan's scheduling. Failing loudly when the env var
      // is unset is the right behaviour — the binary itself won't
      // start without ALLOWED_USER_ID, so this can only fire if the
      // migration is run out-of-band.
      userIDStr := os.Getenv("ALLOWED_USER_ID")
      if userIDStr == "" {
          return errors.New("backfill: ALLOWED_USER_ID not set; cannot attribute pre-materialized tz_step rows")
      }
      userID, err := strconv.ParseInt(userIDStr, 10, 64)
      if err != nil {
          return fmt.Errorf("backfill: invalid ALLOWED_USER_ID %q: %w", userIDStr, err)
      }

      // Defensive: count steps whose medication has been deleted
      // (FK is declared but unenforced — PRAGMA foreign_keys=OFF
      // per internal/store/miband_workouts.go:419). Surface the
      // count so an operator can investigate; the inner JOIN below
      // will silently drop these rows. That drop is the correct
      // outcome: a step for a deleted medication has no medication
      // to dose, so there is nothing to schedule and no user-facing
      // regression.
      var orphans int
      _ = tx.QueryRowContext(ctx, `
          SELECT COUNT(*) FROM tz_transition_steps s
          JOIN tz_transition_plans p ON p.id = s.plan_id
          LEFT JOIN medications m ON m.id = s.medication_id
          WHERE p.status = 'APPROVED' AND s.consumed_at IS NULL
            AND m.id IS NULL`).Scan(&orphans)
      if orphans > 0 {
          slog.Warn("backfill: skipping tz steps for deleted medications",
              "orphan_count", orphans)
      }

      res, err := tx.ExecContext(ctx, `
          INSERT OR IGNORE INTO intake_log
            (medication_id, user_id, scheduled_at_unix, status,
             source, tz_plan_id, tz_step_number)
          SELECT
            s.medication_id,
            ?,
            CAST(strftime('%s', s.scheduled_at) AS INTEGER),
            'PENDING',
            'tz_step',
            s.plan_id,
            s.step_number
          FROM tz_transition_steps s
          JOIN tz_transition_plans p ON p.id = s.plan_id
          JOIN medications m ON m.id = s.medication_id
          WHERE p.status = 'APPROVED'
            AND s.consumed_at IS NULL`, userID)
      if err != nil {
          return err
      }
      n, _ := res.RowsAffected()
      slog.Info("backfill: pre-materialized tz step rows",
          "count", n, "orphans_skipped", orphans)
      return nil
  }
  ```

  Goose only runs the migration once per DB. The `INSERT OR IGNORE`
  against the partial unique index added in this same migration makes
  the SQL safe to re-run if anyone manually replays the migration.
  (migration `068_backfill_pre_materialized_tz_steps.go` registers
  via `goose.AddMigrationContext` from `init()`. SQLite's strftime
  cannot parse the trailing zone-name in modernc.org/sqlite's
  Go-time serialization, so the migration uses the same
  COALESCE/substr trick migration 057 introduced. Backfill
  short-circuits when no APPROVED plan has unconsumed steps so test
  fixtures don't need ALLOWED_USER_ID. Documented in
  `docs/architecture.md → Migrations → Go migrations` plus a blank
  import in `internal/store/store.go` so production picks up the
  init().)
- [x] verify the backfill on a CI fixture seeded with: one
  `APPROVED` plan with two steps, the first consumed and the second
  unconsumed; one `COMPLETED` plan with all steps consumed; one
  `PENDING_APPROVAL` plan; one orphan step whose medication was
  deleted. Assert exactly one row was inserted into `intake_log` (the
  unconsumed step from the APPROVED plan), the orphan-skipped count
  is 1, and re-running the migration is a no-op. (covered by
  `TestMigration068_BackfillSeedFixture` in
  `internal/store/migration_068_test.go` — exact fixture from the
  plan; asserts the single inserted row's columns match
  (planID=1, stepNum=2, status=PENDING, source=tz_step) and that
  down→up of migration 068 leaves the same single row.)
- [x] write tests: approve + materialize, reject leaves no rows, cancel
  cleans up PENDING `tz_step` rows; idempotent re-approve produces no
  duplicates; **one explicit test that simulates the backfill on a
  fixture DB seeded with an APPROVED plan + one consumed and one
  unconsumed step, asserts only the unconsumed step is materialized,
  asserts a second backfill run is a no-op**; cross-TZ end-to-end
  that mirrors the westbound-flexible scenario from
  `medication_tz_test.go`. (Test coverage:
  `TestApproveAndMaterialize_FlipsAndMaterializes` (approve +
  materialize + idempotent re-approve),
  `TestApproveAndMaterialize_RejectedPlanIsNoOp` (rejected plan
  leaves no rows, status not regressed),
  `TestDeletePendingPreMaterializedIntakesForPlan` (cancel cleanup
  preserves TAKEN rows), `TestMigration068_BackfillSeedFixture`
  (backfill fixture above), `TestHandleTZPlanApprove_RoutesThroughLifecycle`
  (HTTP handler routes through the lifecycle service end-to-end),
  `TestHandleTZPlanApprove_NoLifecycleReturns503` (handler refuses
  to fall back to bare primitive), bot
  `TestHandleTZPlanApprove_Success` and stale-callback. The
  cross-TZ medication_tz_test.go scenarios stay green throughout —
  the existing scheduler flow is unchanged for now (Task 11 is the
  one that teaches the scheduler to read the new tz_step rows).)
- [x] **MCP coverage**: `medications.tz_plan.approve` and
  `medications.tz_plan.reject` registry entries (added in commit
  ebad46a) are unaffected — the handler signatures and HTTP paths
  don't change. Re-run
  `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` after the
  refactor to confirm green. (verified —
  `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` and the three
  sibling MCP coverage tests still pass.)
- [x] run project tests - must pass before next task. (`go test ./...`
  green across all packages.)

### Task 11: Teach the scheduler to consume `intake_log` rows directly

- [x] in `MedicationChecker.Check`, when iterating doses, **also**
  surface `source='tz_step'` PENDING rows due-now and treat them as
  fire-targets (new `GetDueTZStepIntakes` reader feeds the existing
  `notificationGroup` aggregator alongside normal-schedule targets;
  pre-materialized rows wire their existing intake id through to
  reminder storage rather than calling `CreateIntake` a second time).
- [x] when a `source='tz_step'` row fires, leave `source='tz_step'`
  set on the row but flip `status` to PENDING-with-reminder (no-op
  modulo `intake_reminders` rows — the scheduler does not touch the
  row's `status` or `source` columns; the existing PENDING tz_step
  row just gets new `intake_reminders` entries via `AddIntakeReminder`).
- [x] **stop calling** `GetPendingStepsForPlan`,
  `GetLatestConsumedStepTimePerMed`, and `MarkStepConsumed` from the
  scheduler — removed from the scheduler's `MedicationStore`
  interface and the `storeAdapter`; the underlying tz repo methods
  stay (still used by `internal/server/medication_handlers.go`,
  `settings_handlers.go`, and the bot adapter until Tasks 12–13 drop
  them).
- [x] **stop calling** `GetLatestCompletedTZTransitionPlan` (the
  fallback added in 1169cd6 #3) — gone from the scheduler. The
  COMPLETED-plan check now uses
  `CountFuturePendingTZStepIntakesForPlan(planID, now) == 0` against
  intake_log directly.
- [x] add the natural dedup: when `medplan` proposes a normal-schedule
  slot, skip it if a PENDING or TAKEN `intake_log` row already exists
  for the same medication within ±`minInterval` of the proposed time
  (new `HasIntakeNearScheduledTime` repo method runs one
  `BETWEEN ?-window AND ?+window` SQL query before each insertion;
  observable via the `medication scheduler: dedup skip` slog line).
- [x] **asymmetric vs symmetric verification** —
  `internal/scheduler/dedup_equivalence_test.go` covers fire-mode,
  forecast-mode, and the user-reported westbound scenarios. The new
  symmetric predicate matches the legacy asymmetric guard across every
  realistic (stepAt, target, minInterval) triple medplan emits.
- [x] write tests: every scenario from `medication_tz_test.go`
  updated to use the new approve+materialize lifecycle (plan starts
  in PENDING_APPROVAL, steps registered, then
  `db.ApproveAndMaterialize`); `notifier_test.go` and `medplan_test.go`
  stay green (the two ConsumedStepTimeByMed-specific medplan tests
  were removed — their coverage moves to the scheduler integration
  tests). `consumedStepTimeByMed` plumbing in `medplan.Inputs` and
  the overlap guard in `medplan.PlanDoses` deleted; the four legacy
  scheduler-store methods are off the scheduler interface and
  adapter; the two "near-match merge" cases now assert the new
  behaviour (the pre-materialized step row coexists with any
  pre-existing normal-schedule row, since materialize does not dedup
  against non-tz_step rows).
- [x] run project tests - must pass before next task (`go test ./...` green).

### Task 12: Teach the forecast endpoint to consume `intake_log` rows

- [x] `internal/server/medication_handlers.go` — the next-intake forecast
  reads from `medplan.PlanDoses(Window=12h)` today; have it union the
  result with PENDING `intake_log` rows (any source) whose
  `scheduled_at_unix` lies in the same 12h window (new
  `medication.Repo.GetPendingIntakesInWindow(start, end)` reader added
  + exposed via `MedicationStore`. Both forecast surfaces —
  `handleTriggerNextIntake` and `computeNextIntakeData` (which feeds
  `handleGetNextIntake` and the bootstrap payload) — now run the union
  + re-sort against the same window medplan saw, so pre-materialized
  tz_step rows surface even when nothing in `tz_transition_steps`
  would. The shared `sortTargetsByScheduledAt` helper mirrors
  medplan's tie-break by `MedicationID`.)
- [x] de-dup by `(medication_id, scheduled_at_unix)` so a normal target
  with an already-materialized intake row appears once (each surface's
  dedup map seeds from medplan-emitted targets first so the
  `StepID`-carrying entry wins — required so the legacy
  `MarkStepConsumed(stepID)` call in `handleTriggerNextIntake` still
  fires while `tz_transition_steps` ships alongside `intake_log`).
- [x] write tests: the existing 6 `TestHandleTriggerNextIntake_*` cases stay
  green; one new case exercises an explicitly pre-materialized
  `tz_step` row showing up in the cluster window
  (`TestHandleTriggerNextIntake_PreMaterializedTZStepRowSurfaces` in
  `internal/server/trigger_next_intake_test.go` — inserts a PENDING
  `tz_step` intake_log row directly, with NO matching
  `tz_transition_steps` entry, and asserts the trigger handler picks
  it up, marks it TAKEN, preserves `source='tz_step'`, leaves the
  bare 21:30 PDT clock slot untouched, and reports the row's
  scheduled_at back to the caller).
- [x] run project tests - must pass before next task (`go test ./...` green).

### Task 13: Drop the `tz_transition_steps` table

- [x] migration `069_drop_tz_transition_steps.sql` — full
  `DROP TABLE tz_transition_steps` (the down-step recreates the empty
  schema for round-trip testing but cannot recover row data; the
  in-file comment flags the forward-only checkpoint and points
  operators at Litestream / snapshot restore for any production
  rollback past this point).
- [x] delete `Store.GetPendingStepsForPlan`, `MarkStepConsumed`,
  `GetLatestConsumedStepTimePerMed`, `CreateTZTransitionSteps` from
  `internal/store/tz/repo.go`; drop `CreateTZTransitionPlanWithSteps`'s
  step-bulk-insert (now takes a single `plan` arg and the new SQL
  `intake_log` materialisation runs at approve time);
  `MaterializePlanStepsAsIntakesTx` now reads steps from
  `tz_transition_plans.steps_json` (the planner's existing audit blob)
  instead of the dropped sibling table; the scheduler / forecast /
  trigger handlers no longer touch the per-step lookups; the
  `TZTransitionStep` data type and `medplan.Inputs.PendingSteps` are
  retired alongside.
- [x] keep `tz_transition_plans.steps_json` — still the audit blob the
  notifier renders into the approve message and the new source of
  truth for materialise (`handleGetCurrentTZPlan` also derives the
  banner's step list from it via the new `parsePlanStepsForUI`
  helper).
- [x] write tests: migration 069 round-trip
  (`TestMigration069_DropsTZTransitionStepsTable`,
  `TestMigration069_RoundTrip` in
  `internal/store/migration_069_test.go`) cover the drop on a fixture
  with a pre-materialised intake row and exercise up → down → up. The
  refreshed `internal/scheduler/medication_tz_test.go`,
  `internal/server/trigger_next_intake_test.go`,
  `internal/store/medication/intake_log_materialize_test.go`, and
  `internal/store/approve_and_materialize_test.go` all build the
  per-plan steps via `setPlanSteps`-style helpers that write
  `steps_json` directly — no callers reach for the dropped table any
  more. `internal/seeddemo/wipe.go` no longer issues
  `DELETE FROM tz_transition_steps`.
- [x] run project tests - must pass before next task (`go test ./...`
  green across all 35 packages; `npm test` also green at 2120
  passes / 29 skipped).

**Documentation + cleanup.** Tasks 14 and 15 capture the doc sweep and the follow-up plan stub.

### Task 14: Update `docs/architecture.md` and `CLAUDE.md`

- [x] new subsection in `docs/architecture.md` describing the
  pre-materialization model: "transition plans write `intake_log` rows
  on approve; the scheduler has one input table" (replaced the legacy
  "TZ-transition plan-step dedup (near-match window)" section with
  "Pre-materialized TZ transition steps", which walks through the
  approve-time materialization, the scheduler's single-input-table
  tick, the symmetric `HasIntakeNearScheduledTime` dedup that replaces
  the consumed-step overlap guard, the forecast-side union, and the
  cancel-time cleanup; cross-references the implementation in
  `internal/scheduler/medication.go`, `internal/store/medication/repo.go`,
  and `internal/store/store.go`).
- [x] remove every reference to `tz_transition_steps` from the docs
  index — replace with a one-liner explaining the migration that
  collapsed it into `intake_log` (the schema list now keeps
  `tz_transition_plans` with a note that `steps_json` is both the
  audit blob and the materialization input, plus a one-line historical
  bullet that says migration 069 dropped the sibling table; the store
  layout block's `tz/` entry no longer claims `tz_transition_steps`
  exists; the `ApproveAndMaterialize` description in "Cross-repo
  transactions" was updated to say `MaterializePlanStepsAsIntakesTx`
  reads `steps_json` instead of the dropped table. `CLAUDE.md` did not
  reference `tz_transition_steps` so no edits were needed there.)
- [x] write tests: not applicable — docs only.
- [x] run project tests - must pass before next task (`go test ./...`
  green; no code changes in this task so all packages stayed cached).

### Task 15: Note follow-up work

- [x] write `docs/plans/2026-XX-XX-collapse-tz-plan-lifecycle.md`
  (recommendations C + E from the analysis) but leave the body as a
  stub — actual work is out of scope for this plan (created
  `docs/plans/2026-05-16-collapse-tz-plan-lifecycle.md` as a stub
  capturing recommendation C — collapse `status` into `applied_at` /
  `acknowledged_at` timestamps — and recommendation E — auto-apply with
  undo affordance — including goals, out-of-scope, sketch approach,
  risks, estimate, and open questions; mirrors the stub format of
  `docs/plans/2026-05-14-store-method-renaming-pass.md`).
- [x] write tests: not applicable — stub plan only.
- [x] run project tests - must pass before next task (`go test ./...`
  green; no Go code changed in this task).

### Task 16: Verify acceptance criteria

- [ ] verify all requirements from Overview are implemented (UTC unix-seconds storage for every dose-related column; transition steps materialized as `intake_log` rows with `source='tz_step'`; the "consumed step overlap guard" code is gone; user-visible behaviour of scheduling/confirming/TZ transitions unchanged).
- [ ] run full project test suite: `go test ./...`.
- [ ] run project linter - all issues must be fixed.
- [ ] manual smoke (Telegram, optional): server in `TZ=Europe/Berlin`, user in `America/Los_Angeles`; tap `Confirm ALL` on a multi-med slot — confirmed count is non-zero (the cross-TZ regression from 1169cd6 #1).
- [ ] manual smoke (TZ transition): trigger the westbound scenario from `medication_tz_test.go` (take a step at 22:30 PDT) — no duplicate normal-schedule notification fires at 21:30 next tick.
- [ ] confirm `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` is green (no MCP coverage regressions from the refactor).

## Technical Details

### Inline conversion convention (no helper package)

Writes use `t.Unix()`. Reads scan into `int64` and convert via
`time.Unix(n, 0).UTC()` immediately before populating the struct field.
The single audit anchor is a comment block at the top of
`internal/store/store.go` listing the dose columns and their Go-type:

```go
// Dose-related time columns are stored as INTEGER unix seconds (UTC).
// Equality on these columns is safe across server/user time zones because
// modernc.org/sqlite no longer round-trips a zone string. Reads must
// convert via time.Unix(n, 0).UTC(); writes must use t.Unix().
//
//   intake_log.scheduled_at_unix
//   intake_log.taken_at_unix             (nullable)
//   intake_log.snoozed_until_unix        (nullable)
//   tz_transition_plans.created_at_unix
//   tz_transition_plans.notified_at_unix (nullable)
//   tz_transition_plans.approved_at_unix (nullable)
//   tz_transition_steps.scheduled_at_unix       (until Task 13 drops table)
//   tz_transition_steps.consumed_at_unix        (until Task 13 drops table)
//
// The architecture test in store_time_invariants_test.go enforces INTEGER
// type on this list via PRAGMA table_info.
```

### Why dual-write before cut-over

The intermediate state in Tasks 2 → 3 → 4 (legacy `scheduled_at` and
new `scheduled_at_unix` co-exist, both populated on insert) lets us:

- run the new SQL equality predicate against historical rows without a
  one-shot data migration that's hard to reverse;
- bisect any production regression to "did the read switch to the unix
  column?" rather than a dropped-column-needs-restore situation;
- ship Tasks 2+3 in one PR and Task 4 in a follow-up after a release.

### Pre-materialized step row shape

```sql
INSERT OR IGNORE INTO intake_log
  (medication_id, user_id, scheduled_at_unix, status, source, tz_plan_id, tz_step_number)
VALUES
  (?, ?, ?, 'PENDING', 'tz_step', ?, ?);
```

`user_id` is the operator's Telegram ID (single-user project gated by
`ALLOWED_USER_ID`); the runtime helper takes it as a parameter and the
backfill migration reads it from `os.Getenv("ALLOWED_USER_ID")`
(see Task 10's backfill bullet for the rationale).

`INSERT OR IGNORE` against the partial unique index
`(tz_plan_id, tz_step_number) WHERE tz_plan_id IS NOT NULL` makes
materialize idempotent — the approve path can retry, and the one-shot
backfill on deploy can run alongside any newly-approved plan without
producing duplicates.

### Atomic approve + materialize

```go
// ApproveAndMaterialize flips the plan to APPROVED and pre-materializes
// every unconsumed step into intake_log under one transaction.
//
// Returns (true, nil) when this call performed the approval — the plan
// was in PENDING_APPROVAL or NOTIFIED at the start of the tx and is now
// APPROVED with steps materialized. Returns (false, nil) when the plan
// was already in a non-pending status (e.g. another caller approved it
// first); callers treat this as a benign no-op. Any error short-circuits
// the tx via the deferred Rollback.
func (s *Store) ApproveAndMaterialize(planID, allowedUserID, approvedAtUnix int64) (bool, error) {
    tx, err := s.db.Begin()
    if err != nil { return false, err }
    defer tx.Rollback() // no-op after Commit

    approved, err := setTZTransitionPlanApprovedTx(tx, planID, approvedAtUnix)
    if err != nil { return false, err }
    if !approved {
        return false, nil // plan already moved past PENDING — benign no-op
    }
    if err := materializePlanStepsAsIntakesTx(tx, planID, allowedUserID); err != nil {
        return false, err
    }
    return true, tx.Commit()
}
```

`allowedUserID` is plumbed in from the wiring site at
`cmd/bot/main.go:218` via `LifecycleService`, the same env-var-derived
operator ID the runtime uses elsewhere. Both the HTTP
`tz_plan_approve` handler and `tz_plan_notifier`'s auto-approve path
call the service, which wraps this single helper. There is no code
path that flips `status='APPROVED'` without immediately materializing
— a crash between the two is impossible because they share one tx.

### Dedup predicate (Task 11)

> Before inserting a `source='schedule'` row at instant T for med M,
> assert there is no `intake_log` row for M with `status IN ('PENDING','TAKEN')`
> and `|scheduled_at_unix - T| <= minInterval(M)`.

`minInterval(M)` comes from `tzreschedule.MinDoseInterval(nominalHours,
policy)` — same formula `medplan.PlanDoses` uses today, just relocated
to the SQL pre-insert check. This is the single replacement for the
"consumed step overlap guard" from `medplan.Inputs.ConsumedStepTimeByMed`.
See Task 11 for the asymmetric-vs-symmetric verification argument that
this predicate is observably equivalent to today's guard.

### Pre-materialization footprint

The "many step rows on approval" worry is small. A typical user has 1–5
active medications; a strict-policy plan bridging the worst-case
~12-hour offset (Berlin → LA) at a 2-hour-per-step max-shift produces
≈6 steps per medication. Worst-case row count per plan is therefore on
the order of `5 × 6 = 30` rows; common-case is `1–3 meds × 1–3 steps =
3–9 rows`. Inserting that many rows in one tx on SQLite is
sub-millisecond. The scheduler's per-tick cost goes **down**, not up,
because the tick reads one query against `intake_log` instead of
`tz_transition_steps` + `intake_log` + `consumed_step_time_per_med`.

### What we deliberately do NOT touch

- The plan lifecycle: `PENDING_APPROVAL` → `NOTIFIED` → `APPROVED` →
  `COMPLETED` survives, even though the analysis flags it as the next
  obvious simplification target. Keeping the lifecycle intact means
  this plan is a pure storage refactor — no behavioural change for the
  user, no risk of dropping a notification.
- The auto-approve / undo affordance discussed in the analysis. That's
  a UX change that wants its own product decision.
- The scheduler's 1-minute polling loop. Pre-materialization makes
  per-tick work cheaper but doesn't change the cadence.

## Post-Completion

*Items requiring manual intervention - no checkboxes, informational only*

**Code lines deleted** (estimated, after Track D):

- `internal/scheduler/medication.go` Check loses ~80 LoC of plan-state
  orchestration (steps 1–4 of the "How transition steps interact"
  list). Estimated final size of `Check`: ~150 LoC.
- `internal/domain/medplan/medplan.go` loses `ConsumedStepTimeByMed`
  + the overlap guard in `PlanDoses`. ~30 LoC.
- `internal/store/store.go` loses `GetPendingStepsForPlan`,
  `MarkStepConsumed`, `GetLatestConsumedStepTimePerMed`,
  `CreateTZTransitionSteps`. ~120 LoC.
- Migration `047_add_tz_transition_steps.sql` deprecated by the new
  drop migration in Task 13.

**Observability to add (low-effort)**:

- `slog.Info("scheduler: dedup skip", "med_id", id, "proposed_unix", t,
  "existing_unix", e)` — surfaces every time the new dedup predicate
  catches a duplicate, so we can confirm in production that the natural
  dedup is doing what the overlap guard used to do.
- `slog.Error("approve_and_materialize: tx commit failed",
  "plan_id", planID, "step_count", n, "error", err)` at the
  `tx.Commit()` failure path inside `Store.ApproveAndMaterialize`.
  This is the failure mode that the atomicity guarantee actually
  protects against — the operator needs to know if it ever fires
  (because it means a plan stayed in `PENDING_APPROVAL` despite a
  user clicking approve, with no intake rows materialized either).
  Pair with a one-line `slog.Info("approve_and_materialize: ok",
  "plan_id", planID, "step_count", n)` on success so the count of
  successful approves is also visible in logs.
- `slog.Info("scheduler: pre-materialized step fired",
  "intake_id", id, "tz_plan_id", planID, "tz_step_number", n)` when
  a `source='tz_step'` row hits its tick — confirms in production
  that pre-materialization is actually driving transition fires
  (rather than something silently falling back to normal-schedule).
- A tiny dashboard query: `SELECT source, COUNT(*) FROM intake_log
  GROUP BY source` to track the share of pre-materialized rows.

**External system updates**: none. Pure internal refactor; the API
contract for `intake_log` rows over HTTP/Telegram doesn't change.

**Follow-up plan**: `docs/plans/2026-XX-XX-collapse-tz-plan-lifecycle.md`
covers recommendations C (collapse plan states into `applied_at` +
`acknowledged_at`) and E (auto-apply with undo) from the original
analysis. That plan can start once Track D has shipped and baked.

**Move this plan to `docs/plans/completed/`** once everything above is checked.
