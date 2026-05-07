# Simplify Medication Scheduling: UTC Unix Storage + Pre-materialized TZ Steps

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

## Context (from discovery)

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

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document blockers with ⚠️ prefix.
- Update plan if implementation deviates.

## What Goes Where

- **Implementation Steps** (`[ ]`): code, migrations, tests in this repo.
- **Post-Completion**: doc updates, observability, removed-code list,
  follow-up plan stubs (for the lifecycle / auto-approve cleanup we
  deliberately punted on).

## Implementation Steps

### Track A — Canonicalize `scheduled_at` as UTC unix seconds

#### Task A1: Document the convention; no helper package

- [ ] **No new `internal/util/unixsec` package.** `t.Unix()` and
  `time.Unix(n, 0).UTC()` are already the entire implementation; wrapping
  them invents a top-level `internal/util` convention this repo doesn't
  use, for one-line sugar. Conversions live inline at the store boundary.
- [ ] add a single comment block at the top of `internal/store/store.go`
  listing every dose-related column that's INTEGER (unix seconds, UTC)
  and the Go-type expected on the read path. This is the audit anchor —
  future readers grep one place to know which columns are unix-seconds.
- [ ] add a table-driven test in `store_time_invariants_test.go` that,
  for `t` constructed in `Europe/Berlin`, `America/Los_Angeles`, and
  `UTC`, asserts `time.Unix(t.Unix(), 0).UTC().Equal(t)` — the
  invariant the comment block is documenting

#### Task A2: Migration — add `scheduled_at_unix` column to `intake_log`, backfill, dual-write

- [ ] migration `0XX_add_intake_log_scheduled_at_unix.sql` (concrete
  number assigned at PR time; `057` is next-free at time of writing):
  `ALTER TABLE intake_log ADD COLUMN scheduled_at_unix INTEGER;`
  + backfill `UPDATE intake_log SET scheduled_at_unix = strftime('%s', scheduled_at);`
  + index `idx_intake_log_scheduled_at_unix`
- [ ] update `Store.CreateIntake` / `Store.CreateManualIntake` to write
  both `scheduled_at` (legacy) and `scheduled_at_unix` (new) — every
  insert is a dual-write until task A4 drops the legacy column
- [ ] migration goes through `up → down → up` round-trip test
- [ ] run `go test ./internal/store/... ./internal/scheduler/...` — green

#### Task A3: Switch every reader to `scheduled_at_unix`

- [ ] change `Store.GetIntakeBySchedule`, `BatchGetIntakesBySchedule`,
  `GetPendingIntakesBySchedule`, `ConfirmIntakesBySchedule`,
  `GetIntake`, `GetIntakeHistory`, `GetPendingIntakes` to read the unix
  column and `Scan` into `int64`, then convert via `unixsec.FromUnix`
  before returning the struct field
- [ ] **delete the in-memory `time.Equal` filter** in
  `GetPendingIntakesBySchedule` and `ConfirmIntakesBySchedule` — replace
  with a real `WHERE scheduled_at_unix = ?` predicate
- [ ] keep the `time.Time` field in the public `IntakeLog` struct — only
  the wire format changes
- [ ] add cross-TZ regression test that builds an intake whose
  `scheduled_at` was originally produced in `Europe/Berlin`, queries it
  from a server pretending to be in `America/Los_Angeles`, asserts the
  query matches
- [ ] run `go test ./...` — green; the existing 1169cd6 cross-TZ tests
  stay green using the new SQL equality path

#### Task A4: Drop the legacy `scheduled_at` text column from `intake_log`

- [ ] migration `0XX_drop_intake_log_scheduled_at_text.sql`:
  table-rebuild (`CREATE TABLE intake_log_new` with the new shape,
  `INSERT INTO intake_log_new SELECT … FROM intake_log`, drop the old,
  rename); preserve every other column verbatim including indexes,
  triggers, and the foreign-key declarations.
- [ ] **forward-only checkpoint.** The down step recreates the prior
  shape via the same rebuild pattern, but row IDs are renumbered and
  any column added between A2 and this migration is dropped on
  rollback. Document in the migration's down-section that production
  rollback past A4 should restore from a DB backup, not run the down.
- [ ] confirm migration runs against a populated DB on a CI fixture
  carrying ≥ 100 historical rows
- [ ] remove the `scheduled_at` legacy field from the dual-write in
  `CreateIntake` / `CreateManualIntake`
- [ ] full `go test ./...` — green

#### Task A5: Apply the same A2→A3→A4 pattern to the remaining columns

Each subtask is its own three-step sequence (`add column + dual-write
→ cut over readers → drop legacy via table-rebuild`). They are
independent and can ship in parallel PRs after A4 lands. **Track D's
columns are deliberately excluded** — `tz_transition_steps.scheduled_at`
and `consumed_at` would convert and then immediately be dropped by D5,
so the table is left as DATETIME until D5 retires it.

##### A5a: `intake_log.taken_at` → `taken_at_unix INTEGER` (nullable)

- [ ] add column + backfill `UPDATE intake_log SET taken_at_unix =
  strftime('%s', taken_at) WHERE taken_at IS NOT NULL;`
- [ ] dual-write in `MarkIntakeTaken`, `CreateManualIntake`, any
  setter that touches `taken_at`
- [ ] cut over readers in history endpoint, archived-meds query,
  per-id `GetIntake`
- [ ] table-rebuild migration drops the legacy column
- [ ] tests: history endpoint cross-TZ scan + per-id read

##### A5b: `intake_log.snoozed_until` → `snoozed_until_unix INTEGER` (nullable)

- [ ] add column + backfill
- [ ] dual-write in `SnoozeIntake`
- [ ] cut over reader in `GetPendingIntakes` (the `medication_reminder`
  loop currently uses `time.After(*p.SnoozedUntil)` in-memory — keep
  the in-memory comparison but read into `int64` then convert to
  `time.Time` for the existing API)
- [ ] table-rebuild migration drops the legacy column
- [ ] tests: snooze round-trip across TZ change

##### A5c: `tz_transition_plans.created_at` / `notified_at` / `approved_at`

- [ ] one migration covers all three columns on the same table to
  minimize rebuild churn
- [ ] dual-write in `CreateTZTransitionPlan*`, `MarkPlanNotified`,
  `SetTZTransitionPlanApproved`
- [ ] cut over readers in `tz_plan_notifier` (uses `time.Since`),
  observability log lines
- [ ] table-rebuild migration drops the three legacy columns
- [ ] tests: plan-lifecycle test fixture covers each setter

##### A5d: invariant test gains the new columns

- [ ] update `store_time_invariants_test.go` allowlist (Task A6) to
  include every column converted in A5a–A5c

#### Task A6: Document and lock in the invariant

- [ ] update `docs/architecture.md` with a "Time storage" subsection:
  every dose-related time column is INTEGER unix seconds, UTC; the
  comment block at the top of `store.go` is the audit anchor; SQL
  equality is safe
- [ ] add an architecture test in `internal/store/` that uses an
  **allowlist of column names** (not a DATETIME grep). The list is
  exactly the dose-related columns enumerated in A2/A5 (e.g.
  `intake_log.scheduled_at_unix`, `intake_log.taken_at_unix`,
  `intake_log.snoozed_until_unix`, `tz_transition_steps.*_unix` while
  the table still exists, `tz_transition_plans.{created,notified,
  approved}_at_unix`). The test parses the live SQLite schema via
  `PRAGMA table_info(<table>)` and fails when any column on the
  allowlist is not declared `INTEGER`. Non-dose `DATETIME` columns
  (workouts, BP, weight, sleep) are deliberately untouched — the test
  has no opinion about them.
- [ ] update `CLAUDE.md` "Common tasks → Adding a new health metric" to
  point at the unix-seconds rule for dose-like columns

### Track D — Pre-materialized transition steps as `intake_log` rows

#### Task D1: Add `source`, `tz_plan_id`, `tz_step_number` to `intake_log`

- [ ] migration `0XX_add_intake_log_source.sql`:
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
    subsection.
  + index `idx_intake_log_tz_plan_id` for the planner's "delete pending
    rows on plan cancel" query
- [ ] update `IntakeLog` struct + `Scan` calls to expose the new columns
- [ ] no behaviour change yet — `source` is always `'schedule'` in
  practice; this task only opens the slot
- [ ] tests: existing intake suite green; one new test asserts the
  default `source = 'schedule'`; one new test deletes a plan row and
  asserts associated intakes survive with `tz_plan_id = NULL`

#### Task D2: When a plan is approved, materialize steps as PENDING intakes

- [ ] **Domain service per CLAUDE.md rule #1.** Today's
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
  same.
- [ ] add `Store.ApproveAndMaterialize(planID, allowedUserID int64, approvedAtUnix int64) (bool, error)`:
  internal helper used by the service that opens a single `*sql.Tx`
  and calls private `setTZTransitionPlanApprovedTx(tx, …)` and
  `materializePlanStepsAsIntakesTx(tx, planID, allowedUserID)`
  against that tx, then `Commit()`. The runtime helper takes
  `allowedUserID` explicitly — same single-user-derivation problem
  as the backfill (see D2's "one-shot backfill" task), but at runtime
  the service has the value in scope from the bot/server wiring at
  `cmd/bot/main.go:218`. Plumb it through `LifecycleService.Approve`
  (constructed once with the operator's user_id) so the approve
  callers don't need to think about it.
  Approve→crash→restart cannot leave a plan APPROVED with no
  materialized intakes, because both writes share one tx.
- [ ] add a partial unique index
  `(tz_plan_id, tz_step_number) WHERE tz_plan_id IS NOT NULL` so
  re-running materialize is idempotent (e.g. via `INSERT OR IGNORE`)
- [ ] add a corresponding "on plan cancel, delete unconsumed
  pre-materialized rows" path: `DELETE FROM intake_log WHERE
  tz_plan_id=? AND status='PENDING' AND source='tz_step'` — wire it
  into the plan cancel flow in `tzreschedule/planner.go`
- [ ] **one-shot backfill via a goose Go migration.** When this
  migration ships, plans already in `APPROVED` (with steps not yet
  fired) must have their steps materialized too — otherwise an
  APPROVED plan whose first step is two days out silently loses its
  scheduling because the scheduler now reads `intake_log` instead of
  `tz_transition_steps`.

  Three constraints push this to a Go migration rather than pure SQL:
  (a) `intake_log.user_id` is `INTEGER NOT NULL` and must reference the
  operator's Telegram ID; the project is single-user gated by
  `ALLOWED_USER_ID` at `cmd/bot/main.go:66`, but SQL migrations have no
  access to env vars; (b) `medications` has no `user_id` column
  (`001_init.sql:1-9`), so we can't join through it to derive one;
  (c) `tz_transition_steps.scheduled_at` and `consumed_at` are still
  `DATETIME` at this point — A5 deliberately skipped the table since
  D5 will drop it — so the backfill must use `strftime('%s', …)` to
  bridge the two formats.

  Goose supports Go migrations alongside SQL (the project has been
  SQL-only by convention; this introduces the first Go migration —
  document the precedent in `docs/architecture.md`). Shape:

  ```go
  // 0XX_backfill_pre_materialized_tz_steps.go
  func upBackfillPreMaterializedTZSteps(ctx context.Context, tx *sql.Tx) error {
      // Operator's user_id from any existing intake row. Single-user
      // project; if intake_log is empty there is no historical user
      // to attribute backfilled rows to, and there can also be no
      // APPROVED plan that fired against a vanished user — bail.
      var userID int64
      err := tx.QueryRowContext(ctx, `SELECT user_id FROM intake_log LIMIT 1`).Scan(&userID)
      if errors.Is(err, sql.ErrNoRows) {
          return nil
      }
      if err != nil {
          return err
      }

      // Defensive: count steps whose medication has been deleted
      // (FK is declared but unenforced — PRAGMA foreign_keys=OFF
      // per internal/store/miband_workouts.go:419). Surface the
      // count so an operator can investigate; the inner JOIN below
      // will silently drop these rows.
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
- [ ] verify the backfill on a CI fixture seeded with: one
  `APPROVED` plan with two steps, the first consumed and the second
  unconsumed; one `COMPLETED` plan with all steps consumed; one
  `PENDING_APPROVAL` plan; one orphan step whose medication was
  deleted. Assert exactly one row was inserted into `intake_log` (the
  unconsumed step from the APPROVED plan), the orphan-skipped count
  is 1, and re-running the migration is a no-op.
- [ ] tests: approve + materialize, reject leaves no rows, cancel
  cleans up PENDING `tz_step` rows; idempotent re-approve produces no
  duplicates; **one explicit test that simulates the backfill on a
  fixture DB seeded with an APPROVED plan + one consumed and one
  unconsumed step, asserts only the unconsumed step is materialized,
  asserts a second backfill run is a no-op**; cross-TZ end-to-end
  that mirrors the westbound-flexible scenario from
  `medication_tz_test.go`
- [ ] **MCP coverage**: `medications.tz_plan.approve` and
  `medications.tz_plan.reject` registry entries (added in commit
  ebad46a) are unaffected — the handler signatures and HTTP paths
  don't change. Re-run
  `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` after the
  refactor to confirm green.

#### Task D3: Teach the scheduler to consume `intake_log` rows directly

- [ ] in `MedicationChecker.Check`, when iterating doses, **also**
  surface `source='tz_step'` PENDING rows due-now and treat them as
  fire-targets — the existing notification grouping code already
  accepts a heterogeneous list of meds, no notifier changes needed
- [ ] when a `source='tz_step'` row fires, leave `source='tz_step'`
  set on the row but flip `status` to PENDING-with-reminder (it's
  already PENDING; this is a no-op modulo `intake_reminders` rows)
- [ ] **stop calling** `GetPendingStepsForPlan`,
  `GetLatestConsumedStepTimePerMed`, and `MarkStepConsumed` from the
  scheduler — they're now redundant
- [ ] **stop calling** `GetLatestCompletedTZTransitionPlan` (the
  fallback added in 1169cd6 #3) — the overlap guard it fed no longer
  exists
- [ ] add the natural dedup: when `medplan` proposes a normal-schedule
  slot, skip it if a PENDING or TAKEN `intake_log` row already exists
  for the same medication within ±`minInterval` of the proposed time —
  one SQL query, executed in the scheduler before insertion
- [ ] **asymmetric vs symmetric verification.** Today's overlap guard
  (`internal/domain/medplan/medplan.go:143-149`) is asymmetric: it
  suppresses normal targets that are at-or-before the consumed step
  *or* within `minInterval` after it (`!target.After(stepAt)` ||
  `target.Sub(stepAt) <= minIntv`). The new symmetric ±`minInterval`
  predicate against any existing intake row is cleaner but is **not**
  a literal refactor of the old logic. Argument that the difference
  is empty in practice:
  - In **fire mode** (`window == 0`) `medplan` only emits targets at
    or before `now`. Consumed steps are by definition in the past, so
    `stepAt ≤ now` and any `target ≤ stepAt` is also `≤ now`; the new
    `[stepAt - minInterval, stepAt + minInterval]` band still catches
    these via the lower bound.
  - In **forecast mode** (`window > 0`) `medplan` only emits targets
    in `(now, now + window]`. A target in that future window cannot
    fall before a stepAt that's in the past, so the lower-bound clause
    of the old guard (`!target.After(stepAt)`) had nothing to bite —
    only the upper-bound (`target - stepAt ≤ minInterval`) did real
    work, and the new predicate matches that exactly.
  - **Verification gate**: write a one-shot side-by-side property
    test (`internal/scheduler/dedup_equivalence_test.go`) that, for a
    table-driven generator of (`stepAt`, `target`, `minInterval`)
    triples spanning the relevant ranges, asserts the old guard
    output equals the new dedup-predicate output across every
    generated input. The test is the gate for deleting the old
    overlap guard — green means the symmetric predicate observably
    matches the asymmetric one. Mark this test with a `// REMOVE
    AFTER D3 LANDS` comment; it is removable in the same PR that
    deletes `medplan.Inputs.ConsumedStepTimeByMed`. Also run every
    scenario in `medication_tz_test.go` (especially
    `TestMedicationCheckerTZAware/*` and the post-westbound cases
    from ec97a1f / 0bb7485 / 1169cd6 #3) against the new predicate
    end-to-end.
- [ ] tests: every scenario from `medication_tz_test.go`,
  `notifier_test.go`, `medplan_test.go` stays green; **delete** the
  `consumedStepTimeByMed` plumbing in `medplan.Inputs` and the overlap
  guard in `medplan.PlanDoses` (the dedup query in the scheduler now
  owns this) — but only after the verification step above passes

#### Task D4: Teach the forecast endpoint to consume `intake_log` rows

- [ ] `internal/server/medication_handlers.go` — the next-intake forecast
  reads from `medplan.PlanDoses(Window=12h)` today; have it union the
  result with PENDING `intake_log` rows (any source) whose
  `scheduled_at_unix` lies in the same 12h window
- [ ] de-dup by `(medication_id, scheduled_at_unix)` so a normal target
  with an already-materialized intake row appears once
- [ ] tests: the existing 6 `TestHandleTriggerNextIntake_*` cases stay
  green; one new case exercises an explicitly pre-materialized
  `tz_step` row showing up in the cluster window

#### Task D5: Drop the `tz_transition_steps` table

- [ ] migration `0XX_drop_tz_transition_steps.sql` — full `DROP TABLE
  tz_transition_steps` (no rebuild needed since the entire table
  goes); the table was only read by the scheduler and the planner,
  both of which now use `intake_log`. **Forward-only checkpoint**:
  the down-step `CREATE TABLE … LIKE the old shape` recreates the
  schema but cannot recover the row data — pre-D5 plans relied on
  this table for their step lifecycle, but post-D5 those plans live
  entirely as `intake_log` rows. Document in the migration's
  down-section that production rollback past D5 should restore from
  a DB backup.
- [ ] delete `Store.GetPendingStepsForPlan`, `MarkStepConsumed`,
  `GetLatestConsumedStepTimePerMed`, `CreateTZTransitionSteps`,
  `CreateTZTransitionPlanWithSteps`'s step-bulk-insert (it now stores
  `intake_log` rows directly via `MaterializePlanStepsAsIntakes`)
- [ ] keep `tz_transition_plans.steps_json` — it's still the audit blob
  used by `tz_plan_notifier.formatTZPlanMessage` to render the
  approval message
- [ ] full `go test ./...` — green

### Documentation + cleanup

#### Task X1: Update `docs/architecture.md` and `CLAUDE.md`

- [ ] new subsection in `docs/architecture.md` describing the
  pre-materialization model: "transition plans write `intake_log` rows
  on approve; the scheduler has one input table"
- [ ] remove every reference to `tz_transition_steps` from the docs
  index — replace with a one-liner explaining the migration that
  collapsed it into `intake_log`

#### Task X2: Note follow-up work

- [ ] write `docs/plans/2026-XX-XX-collapse-tz-plan-lifecycle.md`
  (recommendations C + E from the analysis) but leave the body as a
  stub — actual work is out of scope for this plan

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
//   tz_transition_steps.scheduled_at_unix       (until Task D5 drops table)
//   tz_transition_steps.consumed_at_unix        (until Task D5 drops table)
//
// The architecture test in store_time_invariants_test.go enforces INTEGER
// type on this list via PRAGMA table_info.
```

### Why dual-write before cut-over

The intermediate state in tasks A2 → A3 → A4 (legacy `scheduled_at` and
new `scheduled_at_unix` co-exist, both populated on insert) lets us:

- run the new SQL equality predicate against historical rows without a
  one-shot data migration that's hard to reverse;
- bisect any production regression to "did the read switch to the unix
  column?" rather than a dropped-column-needs-restore situation;
- ship A2+A3 in one PR and A4 in a follow-up after a release.

### Pre-materialized step row shape

```sql
INSERT OR IGNORE INTO intake_log
  (medication_id, user_id, scheduled_at_unix, status, source, tz_plan_id, tz_step_number)
VALUES
  (?, ?, ?, 'PENDING', 'tz_step', ?, ?);
```

`user_id` is the operator's Telegram ID (single-user project gated by
`ALLOWED_USER_ID`); the runtime helper takes it as a parameter and the
backfill migration reads it from the first existing `intake_log` row
(see D2 backfill task for the rationale).

`INSERT OR IGNORE` against the partial unique index
`(tz_plan_id, tz_step_number) WHERE tz_plan_id IS NOT NULL` makes
materialize idempotent — the approve path can retry, and the one-shot
backfill on deploy can run alongside any newly-approved plan without
producing duplicates.

### Atomic approve + materialize

```go
func (s *Store) ApproveAndMaterialize(planID int64, approvedAtUnix int64) error {
    tx, err := s.db.Begin()
    if err != nil { return err }
    defer tx.Rollback() // no-op after Commit

    if err := setTZTransitionPlanApproved(tx, planID, approvedAtUnix); err != nil {
        return err
    }
    if err := materializePlanStepsAsIntakes(tx, planID); err != nil {
        return err
    }
    return tx.Commit()
}
```

Both the HTTP `tz_plan_approve` handler and `tz_plan_notifier`'s
auto-approve path call this single helper. There is no code path that
flips `status='APPROVED'` without immediately materializing — a crash
between the two is impossible because they share one tx.

### Dedup predicate (Task D3)

> Before inserting a `source='schedule'` row at instant T for med M,
> assert there is no `intake_log` row for M with `status IN ('PENDING','TAKEN')`
> and `|scheduled_at_unix - T| <= minInterval(M)`.

`minInterval(M)` comes from `tzreschedule.MinDoseInterval(nominalHours,
policy)` — same formula `medplan.PlanDoses` uses today, just relocated
to the SQL pre-insert check. This is the single replacement for the
"consumed step overlap guard" from `medplan.Inputs.ConsumedStepTimeByMed`.
See Task D3 for the asymmetric-vs-symmetric verification argument that
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
  drop migration in Task D5.

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
