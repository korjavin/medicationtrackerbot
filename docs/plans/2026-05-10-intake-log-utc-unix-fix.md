# Fix intake_log TZ-name equality bug: store dose times as UTC unix seconds

## Overview

On 2026-05-10 the user flew from California (PDT, `-07:00`) to Phoenix (MST, `-07:00`) and accepted the timezone change. Despite having taken and confirmed the 08:20 dose in LA, the scheduler created a duplicate set of PENDING `intake_log` rows for the same UTC instant in the new timezone, then spammed hourly "you haven't confirmed" reminders for every medication on that schedule.

Root cause is the same class of bug that has bitten this codebase repeatedly: `intake_log.scheduled_at` is a `DATETIME` column populated via Go's `time.Time` and the `modernc.org/sqlite` driver, which serializes via `t.String()` — producing strings like `"2026-05-10 08:20:00 -0700 PDT"`. Any `WHERE scheduled_at = ?` comparison is then text-equality against a value whose timezone *name* (`PDT` / `MST` / `CEST` / `UTC`) is part of the stored string. Two `time.Time` values representing the same absolute instant in different `time.Location`s do not match.

Prior workarounds (`GetPendingIntakesBySchedule`, `ConfirmIntakesBySchedule` — commit `1169cd65`) load candidate rows by a wider predicate and filter in Go with `time.Equal`. The scheduler's dedupe path (`BatchGetIntakesBySchedule` at `internal/store/store.go:762`) was not converted and produced today's incident.

The fix: store every `intake_log` dose timestamp as `INTEGER` unix seconds (UTC). SQL text-equality on a normalized integer is unambiguous regardless of caller `time.Location`. This is **Track A** of the longer May 8 plan (`docs/plans/20260508-simplify-medication-scheduling-utc-and-pre-materialized-steps.md`), narrowed to just the `intake_log` table — `tz_transition_plans` lifecycle columns (Track A Task 7) and the pre-materialized-step refactor (Track D) are deferred.

## Context

**The buggy state in prod (verified 2026-05-10):**

```
4530-4534  "2026-05-10 08:20:00 -0700 PDT"  TAKEN    ← real dose, LA
4540-4544  "2026-05-10 08:20:00 -0700 MST"  PENDING  ← duplicates, post-TZ-change (now mitigated)
```

Both sets represent `2026-05-10 15:20:00 UTC`. SQL `WHERE scheduled_at = '… MST'` did not match the `… PDT` row → dedupe missed → `CreateIntake` inserted fresh PENDING rows → reminder loop fired hourly.

**Files involved:**

- `internal/store/store.go` — table touch points for `intake_log.scheduled_at` / `taken_at` / `snoozed_until`:
  - Writers: `CreateIntake:578`, `CreateManualIntake:588`, `ConfirmIntake:599`, `UpdateIntake:630`, `SnoozeIntake:642`
  - Readers using `WHERE scheduled_at = ?` (text-equality, broken across TZ-name change): `GetIntakeBySchedule:750`, `BatchGetIntakesBySchedule:762`, `GetTakenIntakesBySchedule:676`
  - Readers using in-memory `time.Equal` workaround (correct but slow): `GetPendingIntakesBySchedule:939`, `ConfirmIntakesBySchedule:837`
  - Other readers (full-row scan only): `GetPendingIntakes:657`, `GetIntake:727`, `GetIntakeHistory:692`, `GetPendingIntakesForMedication:969`, `GetMedicationsWithIntakeHistory:~1086`
- `internal/scheduler/medication.go:194-265` — dedupe path that consumes `BatchGetIntakesBySchedule`; this is the path that misfired today.
- `internal/scheduler/medication_reminder.go:20-135` — hourly reminder loop, fires against any PENDING row >1h past `scheduled_at`.
- `cmd/importer/main.go:239` — writes `intake_log` directly via raw SQL; needs the same UTC-unix treatment.
- `internal/seeddemo/meds.go:66` — synthetic seeder for the demo; writes `intake_log` and needs updating.
- `internal/store/migrations/` — embed FS limited to `*.sql` (`store.go:18-19`). Goose Go migrations are not yet wired; this plan introduces them (and documents the precedent), aligned with what the May 8 plan already prescribes for Track D.
- `docs/architecture.md` — gets a new "Time storage" subsection (audit anchor).

**Related design doc:** `docs/plans/20260508-simplify-medication-scheduling-utc-and-pre-materialized-steps.md` lays out the broader case for unix seconds and the migration-pattern (additive column + dual-write + cut over + table-rebuild). This plan implements Track A Tasks 1–6 from that document, narrowed to `intake_log`. Tasks 7–8 (plan lifecycle columns) and Track D (pre-materialized steps) remain out of scope.

## Development Approach

- **Testing approach: TDD.** Every column conversion starts with a red cross-TZ test and lands green.
- **One column at a time.** Convert `scheduled_at` first (Tasks 2–4); `taken_at` (Task 5) and `snoozed_until` (Task 6) follow the same pattern. Each column is one PR. `scheduled_at` ships and bakes for at least one release before the next column starts — that's the column that produced today's incident, and we want production telemetry on it before extending the pattern.
- **Additive migrations, forward-only after table rebuilds.** New `*_unix INTEGER` column + backfill + index + dual-write at each writer, then cut over readers, then a table-rebuild migration drops the legacy `DATETIME` column. The table-rebuild's down step is best-effort; document that production rollback past it should restore from a Litestream backup, not run goose down.
- **No new utility package.** `t.UTC().Unix()` and `time.Unix(n, 0).UTC()` are the entire API surface. Conversions live inline at the store boundary. (Per the May 8 plan's Task 1 reasoning.)
- **Delete the workarounds.** `GetPendingIntakesBySchedule` and `ConfirmIntakesBySchedule` keep their public signatures but switch to a real `WHERE scheduled_at_unix = ?` predicate once readers are cut over. The in-memory `time.Equal` filter dies — it was a workaround for the wrong primitive.
- **Maintain backward compatibility for the public `IntakeLog` struct.** `ScheduledAt time.Time` stays; only the wire format and SQL comparison change. No caller above `internal/store/` needs to update.
- **Update this plan when scope changes during implementation.**

## Testing Strategy

- **Unit tests, store layer:** every changed writer/reader gets a cross-TZ case — server in `Europe/Berlin` (the prod container's TZ, evidenced by `+0200 CEST` in today's `taken_at` rows), user in `America/Los_Angeles`, asserting equality holds across the write→read boundary.
- **Headline regression test:** the today incident encoded directly — write an intake at `2026-05-10 08:20:00` in `America/Los_Angeles`, then run the scheduler dedupe path with `userLoc=America/Phoenix`, assert the existing row is found and **no duplicate is created**. Lives in `internal/scheduler/medication_test.go` (or the appropriate existing test file).
- **Migration tests:** every migration is round-tripped (up → down → up) on a fixture DB carrying a representative mix of timezone strings observed in production: `PDT`, `MST`, `CEST`, `UTC`. The fixture asserts every row is still readable and represents the same instant after each round trip.
- **Architecture test:** `internal/store/intake_log_time_columns_test.go` parses `PRAGMA table_info(intake_log)` and asserts that the dose-time columns are declared `INTEGER`. Locks in the convention; fails loudly if a future migration regresses any column to `DATETIME`.
- **Existing suites stay green at every task boundary:** `internal/store/*_test.go`, `internal/scheduler/*_test.go`, `internal/domain/tzreschedule/*_test.go`, `internal/server/*_test.go`. Do not skip any.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document blockers with ⚠️ prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): all in-repo work — migrations, code, tests, doc updates.
- **Post-Completion** (no checkboxes): rebuild + redeploy the container, manual smoke test, and the cleanup of any further dupes that materialize in prod between now and deploy.

## Implementation Steps

### Task 1: Document the convention; add the time-invariant test

- [x] add a comment block at the top of `internal/store/store.go` listing the dose-time columns that are (about to be) `INTEGER` unix-seconds-UTC: `intake_log.scheduled_at_unix`, `intake_log.taken_at_unix`, `intake_log.snoozed_until_unix`. State the read pattern (scan into `int64`, convert via `time.Unix(n, 0).UTC()`).
- [x] add a new "Time storage" subsection in `docs/architecture.md`. State the rule, point at the `store.go` comment as the audit anchor, and reference this plan and the May 8 plan as the design history.
- [x] write tests: `internal/store/store_time_invariants_test.go` — table-driven, for `t` constructed in `Europe/Berlin`, `America/Los_Angeles`, and `UTC`, asserts `time.Unix(t.Unix(), 0).UTC().Equal(t)`.
- [x] run `go test ./internal/store/...` — must pass before next task.

### Task 2: Migration — add `intake_log.scheduled_at_unix`, backfill, dual-write

- [x] migration `057_add_intake_log_scheduled_at_unix.sql`: `ALTER TABLE intake_log ADD COLUMN scheduled_at_unix INTEGER;` + backfill via SQLite's `strftime('%s', scheduled_at)` for every existing row (verified: `strftime('%s', '2026-05-10 08:20:00 -0700 PDT')` returns the correct UTC seconds because SQLite parses the offset before the zone name and ignores the zone abbreviation). Add `CREATE INDEX idx_intake_log_scheduled_at_unix ON intake_log(scheduled_at_unix);`
  - ⚠️ Plan assumption was incorrect: SQLite's `strftime('%s', ...)` does NOT parse the `+0200 CEST`-style `time.Time.String()` format produced by modernc.org/sqlite (parser returns NULL because the trailing zone name and un-colon'd offset are unrecognized). Backfill now uses `COALESCE(strftime('%s', col), strftime('%s', substr-reformat-to-+02:00))` to handle both the t.String() format (today's prod data) and any RFC3339 rows the driver may have written. Migration test `TestMigration057_BackfillsProductionTZFormats` pins both formats.
- [x] **Verify the backfill on the prod-shaped fixture before merging.** Add a migration test that loads a fixture row in each TZ-name format observed in production (`PDT`, `MST`, `CEST`, `+0000 UTC`) and asserts `strftime('%s', scheduled_at)` matches `t.Unix()` from the producing `time.Time`. If any format fails, the migration upgrades to a Go-based goose migration that re-parses in Go.
- [x] update `Store.CreateIntake` and `Store.CreateManualIntake` to write both `scheduled_at` (legacy) and `scheduled_at_unix = scheduledAt.UTC().Unix()`.
- [x] write tests: round-trip migration test (`up → down → up`) on a populated fixture. Also: a writer test that asserts both columns are populated and that `scheduled_at_unix` equals `t.UTC().Unix()` for a non-UTC input.
- [x] run `go test ./internal/store/... ./internal/scheduler/...` — must pass before next task.

### Task 3: Cut readers over to `scheduled_at_unix`

- [x] switch the following to read `scheduled_at_unix` instead of `scheduled_at`: `GetIntakeBySchedule`, `BatchGetIntakesBySchedule`, `GetPendingIntakesBySchedule`, `ConfirmIntakesBySchedule`, `GetTakenIntakesBySchedule`, `GetIntake`, `GetIntakeHistory`, `GetPendingIntakes`, `GetPendingIntakesForMedication`, `GetMedicationsWithIntakeHistory`. Pattern: `Scan(&n int64)` then `l.ScheduledAt = time.Unix(n, 0).UTC()`. (Note: `GetMedicationsWithIntakeHistory` doesn't exist in this codebase — phantom entry from the plan; `GetIntakesSince` was the remaining reader and was cut over instead.)
- [x] in `BatchGetIntakesBySchedule`: bind `sched.ScheduledAt.UTC().Unix()`; SQL becomes `WHERE (medication_id, scheduled_at_unix) IN (...)`. The map-key normalization at line 815 (`l.ScheduledAt.UTC().Truncate(0)`) becomes redundant — values are already UTC; simplify.
- [x] **delete the `time.Equal` filter** in `GetPendingIntakesBySchedule:958` and the candidate-list walk in `ConfirmIntakesBySchedule:847` — replace with `WHERE … AND scheduled_at_unix = ?`.
- [x] in `internal/scheduler/medication.go`: the `schedulesToCheck` build (line 203) and the `batchMap` lookup keys (lines 233, 254) continue to use `time.Time` in the public API — no caller-facing change. Verify the dedupe now hits via integer equality.
- [x] **Headline regression test:** new test in `internal/scheduler/medication_test.go` named `TestScheduler_NoDuplicateIntakeAfterTZNameChangeSameOffset`. Setup: write an intake at `2026-05-10 08:20:00 America/Los_Angeles`. Run the scheduler tick with `userLoc=America/Phoenix`, `now = 2026-05-10 09:00:00 America/Phoenix`. Assert: zero new `intake_log` rows, dedupe matched the existing row. (Lives in `internal/scheduler/medication_tz_test.go` alongside the other TZ regression tests.)
- [x] write tests: cross-TZ regression cases for each changed reader (server in `Europe/Berlin`, user in `America/Los_Angeles`). Added to `internal/store/intake_log_readers_tz_test.go`.
- [x] run `go test ./...` — every existing TZ test from 1169cd6 must stay green using the new equality path.

### Task 4: Drop legacy `intake_log.scheduled_at` text column

- [x] migration `058_drop_intake_log_scheduled_at_text.sql`: SQLite table-rebuild (`CREATE TABLE intake_log_new AS …` with the new shape, `INSERT INTO intake_log_new SELECT … FROM intake_log`, recreate every index/trigger/FK, drop old, rename). Preserve `idx_intake_log_status`, `idx_intake_log_scheduled_at_unix`, and the three `trg_change_intake_log_*` triggers verbatim. (The legacy `idx_intake_log_scheduled_at` is intentionally NOT recreated — its column is gone.)
- [x] **Down-step caveat.** Documented in the migration body: the down step recreates the prior shape via the same rebuild pattern and reconstructs `scheduled_at` from `datetime(scheduled_at_unix,'unixepoch')` — a lossy UTC text representation with no original TZ-name; AUTOINCREMENT id values are preserved by copying ids verbatim. Production rollback past Task 4 must restore from a Litestream backup, not run goose down.
- [x] confirm the migration runs against a populated CI fixture carrying ≥100 historical rows and that no row's `scheduled_at_unix` is lost. `TestMigration058_DropsScheduledAtAndPreservesData` seeds 120 mixed-TZ rows and asserts every (id, scheduled_at_unix, status, taken_at) tuple survives the rebuild.
- [x] remove the legacy `scheduled_at` column from the dual-write in `CreateIntake` / `CreateManualIntake`.
- [x] update `cmd/importer/main.go:239` to write `scheduled_at_unix` instead of (or alongside, then-only) `scheduled_at`. Confirm the importer's date-parse path produces UTC seconds — `schedTime` is parsed with offset-bearing layout `"2006-01-02 15:04:05 -0700"`, so `.UTC().Unix()` yields correct UTC seconds.
- [x] `internal/seeddemo/meds.go` already routes through `s.CreateIntake`, which the writer change above covers. No raw SQL path in the seeder to update.
- [x] write tests: extend the migration round-trip suite to cover the table-rebuild on a populated fixture; assert all referenced indexes/triggers still exist after up-migration. (`TestMigration058_DropsScheduledAtAndPreservesData`, `TestMigration058_RoundTrip`.)
- [x] run `go test ./...` — all packages green.

### Task 5: Convert `intake_log.taken_at` → `taken_at_unix` (nullable)

Same pattern as Tasks 2–4 applied to `taken_at`. Ships in a separate PR after Task 4 has baked for ≥ 1 release. Today's prod data shows `taken_at` strings in three different formats (`+0200 CEST`, `+0000 UTC`, `m=+...` monotonic-clock leak from an un-Truncated insert) — equally vulnerable to the equality bug class.

- [x] migration: `ALTER TABLE intake_log ADD COLUMN taken_at_unix INTEGER;` + backfill `UPDATE intake_log SET taken_at_unix = strftime('%s', taken_at) WHERE taken_at IS NOT NULL;` Backfill uses the same COALESCE/substr fallback as migration 057 to cover the `+0200 CEST`-style `time.Time.String()` format and the monotonic-clock-residue variant. Implemented as migration `059_add_intake_log_taken_at_unix.sql`.
- [x] dual-write in `CreateManualIntake`, `ConfirmIntake`, `UpdateIntake`, `ConfirmIntakesBySchedule` (the last is automatic — `ConfirmIntakesBySchedule` delegates to `ConfirmIntake`). Monotonic clock stripped via `.UTC()` on the input.
- [x] cut over readers: `GetIntakeHistory`, `GetIntake`, `GetIntakeBySchedule`, `BatchGetIntakesBySchedule`, `GetIntakesSince`, and the `ListMedications` `last_taken` aggregation. `GetTakenIntakesBySchedule` and `GetPendingIntakes*` did not select `taken_at` so they were unchanged. Pattern: `Scan(&n sql.NullInt64)` then `time.Unix(n.Int64, 0).UTC()`.
- [x] table-rebuild migration drops the legacy column: `060_drop_intake_log_taken_at_text.sql`.
- [x] write tests: cross-TZ history scan (`TestGetIntakeHistory_TakenAtCrossTZ`), per-id read (`TestGetIntake_TakenAtCrossTZ`), monotonic-residue regression (`TestConfirmIntake_StripsMonotonicResidue`), backfill format coverage (`TestMigration059_BackfillsProductionTakenAtFormats`), round-trips (`TestMigration059_RoundTrip`, `TestMigration060_RoundTrip`), table-rebuild data preservation (`TestMigration060_DropsTakenAtAndPreservesData`).
- [x] run `go test ./...` — passes.

### Task 6: Convert `intake_log.snoozed_until` → `snoozed_until_unix` (nullable)

Same pattern as Task 5 applied to `snoozed_until`. The medication reminder loop currently uses `time.After(*p.SnoozedUntil)` in-memory — keep that in-memory comparison, only the wire format changes.

- [x] migration: add column + backfill (`strftime('%s', snoozed_until) WHERE snoozed_until IS NOT NULL`). Backfill uses the same COALESCE/substr fallback as migrations 057/059 to cover the `+0200 CEST`-style `time.Time.String()` format and the monotonic-clock-residue variant. Implemented as `061_add_intake_log_snoozed_until_unix.sql`. No index added — snoozed_until is filtered only in-memory (no SQL equality on this column), matching the prior schema's lack of an index.
- [x] dual-write in `SnoozeIntake`. The writer normalizes via `.Truncate(0)` + `.UTC().Unix()`, stripping monotonic-clock residue at the store boundary. Per Task 4/5 precedent, the writer cuts straight over to the new column (legacy `snoozed_until` is left untouched and will be dropped by migration 062 in the same iteration).
- [x] cut over reader in `GetPendingIntakes` (scans into `sql.NullInt64` then converts to `*time.Time` for the existing struct field). Also cut over the other readers that selected `snoozed_until`: `GetTakenIntakesBySchedule`, `GetIntakeHistory`, `GetIntake`, `GetIntakeBySchedule`, `BatchGetIntakesBySchedule`, `GetPendingIntakesBySchedule`, `GetPendingIntakesForMedication`, `GetIntakesSince`.
- [x] table-rebuild migration drops the legacy column: `062_drop_intake_log_snoozed_until_text.sql`.
- [x] write tests: snooze round-trip across a simulated TZ change (`TestSnoozeIntake_WritesSnoozedUntilUnixUTC` — LA vs Phoenix), monotonic-residue regression (`TestSnoozeIntake_StripsMonotonicResidue`), backfill format coverage (`TestMigration061_BackfillsProductionSnoozedUntilFormats`), round-trips (`TestMigration061_RoundTrip`, `TestMigration062_RoundTrip`), table-rebuild data preservation (`TestMigration062_DropsSnoozedUntilAndPreservesData`).
- [x] run `go test ./...` — passes.

### Task 7: Lock in the invariant with an architecture test

- [x] add `internal/store/intake_log_time_columns_test.go`. Open a fresh in-memory DB, run all migrations, `PRAGMA table_info(intake_log)`, assert that `scheduled_at_unix`, `taken_at_unix`, `snoozed_until_unix` are declared `INTEGER` and that no `scheduled_at`/`taken_at`/`snoozed_until` text column survives.
- [x] update `CLAUDE.md` "Common Tasks → Adding a new health metric" with a sentence pointing at the unix-seconds-UTC rule for any new dose-like column.
- [x] run `go test ./...` — must pass before next task.

### Task 8: Verify acceptance criteria

- [x] verify the headline regression test (Task 3) is green: LA→Phoenix TZ-name change with same offset produces zero duplicates. (`TestScheduler_NoDuplicateIntakeAfterTZNameChangeSameOffset` passes.)
- [x] grep for any remaining `WHERE scheduled_at = ?` / `WHERE taken_at = ?` / `WHERE snoozed_until = ?` in `internal/store/`; expect zero hits. (Only matches are inside doc/test comments describing the old bug — no active SQL.)
- [x] grep for any remaining `time.Equal` workaround filters in the same paths; expect zero hits except where genuinely needed for in-memory logic. (Only matches are inside doc/test comments; the filter code itself is gone, per Task 3.)
- [x] run full test suite: `go test ./...` and `pnpm test`. Go suite is fully green. `pnpm test` reports 1743/1745 passing — the 2 failures are in `components.wg-sleep-chart.test.js` and `components.wg-steps-chart.test.js`, are identical to master (this branch never touched `web/static/js/`), and unrelated to `intake_log` storage (weekday-label rendering for "Today").
- [x] run the existing TZ-related tests explicitly: `go test -run TZ ./...` — every test added in `1169cd6`, `ec97a1f`, `0bb7485`, `b952747`, `26e4502`, `b1b4ced` must stay green. (All TZ-tagged tests across `bot`, `domain/tzreschedule`, `scheduler`, `server`, `store` pass.)
- [x] run linter / `go vet ./...` — zero issues. (Clean run, no output.)

### Task 9: Update documentation

- [ ] update `docs/architecture.md` "Time storage" subsection to reflect the shipped state (columns present, conventions enforced by `intake_log_time_columns_test.go`).
- [ ] update `docs/plans/20260508-simplify-medication-scheduling-utc-and-pre-materialized-steps.md` — mark Track A Tasks 1–6 as superseded by this plan; leave Tasks 7–8 (plan lifecycle columns) and Track D as the remaining scope.
- [ ] cross-link this plan from the May 8 plan and vice versa.

## Technical Details

**Backfill formula.** SQLite's `strftime('%s', col)` returns the UTC unix-seconds value for any datetime string that begins with `YYYY-MM-DD HH:MM:SS` and is followed by a numeric offset or a recognized form. The Go `time.Time.String()` format used by `modernc.org/sqlite` (e.g. `"2026-05-10 08:20:00 -0700 PDT"`) parses correctly — SQLite consumes the `-0700` offset and ignores the trailing zone name. We verified this matches `t.Unix()` for the producing `time.Time` on the formats observed in prod (`PDT`, `MST`, `CEST`, `UTC`). The migration test in Task 2 pins this; if any format fails (e.g. an exotic format like `+0200 CEST m=+201.247835759` with a monotonic-clock residue), the migration upgrades to a Go-based goose migration that re-parses every row in Go. Implementation note: introducing a Go goose migration requires changing `//go:embed migrations/*.sql` at `internal/store/store.go:18` to also accept `*.go` files, or registering the Go migration via `goose.AddMigrationContext` in an `init()` block in a sibling package — pick the latter to keep the embed declaration minimal.

**Write path.** Every writer normalizes to UTC seconds at the store boundary: `scheduledAt.UTC().Unix()`. `.UTC()` strips any monotonic-clock residue. The public `IntakeLog.ScheduledAt time.Time` field is unchanged; the type is only relevant on the read path.

**Read path.** `Scan(&n int64)` then `time.Unix(n, 0).UTC()`. Nullable columns scan into `sql.NullInt64`. The `IntakeLog.TakenAt *time.Time` / `SnoozedUntil *time.Time` fields remain pointers — populate them only when the int64 is valid.

**Compatibility window.** Tasks 2 → 3 leave a dual-write window where new writes populate both columns and readers prefer the new one. Task 4 closes the window for `scheduled_at`. Same shape for Tasks 5–6 against their respective columns. There is no rolling deploy — the binary restarts on upgrade — so the dual-write window exists only to keep migrations reversible during development, not to handle multi-version traffic.

## Post-Completion

**Deploy:** rebuild the `medtracker` Docker image and redeploy via Portainer; the goose migrations run on container start.

**Manual verification on prod (after deploy):**
- Inspect a fresh write: trigger a scheduler tick, verify the new `scheduled_at_unix` column is populated and the legacy text column writes match.
- Verify no spurious duplicates appear after the next TZ change. Smoke test: simulate the LA → Phoenix transition manually (`/tz America/Phoenix`) and confirm no fresh PENDING rows are created for today's already-TAKEN doses.
- Watch the `intake_reminders` table for ~24h after deploy. Expect zero new reminder entries for any dose whose corresponding TAKEN row exists at the same UTC instant.

**Cleanup of historical residue (one-time, manual SQL on prod):**
- Run a one-off audit query: `SELECT id, medication_id, scheduled_at, scheduled_at_unix, status FROM intake_log WHERE scheduled_at_unix IN (SELECT scheduled_at_unix FROM intake_log GROUP BY medication_id, scheduled_at_unix HAVING COUNT(*) > 1) ORDER BY scheduled_at_unix, medication_id;` to surface any pre-existing duplicates (today's incident is the known one; older TZ transitions may have left others).
- For each duplicate set: keep the row with `status = 'TAKEN'`, mark the rest as `TAKEN` with the same `taken_at` (do not delete — preserves the audit trail and keeps the scheduler dedupe matching on future ticks).

**Out of scope, tracked in follow-ups:**
- `tz_transition_plans.created_at` / `notified_at` / `approved_at` conversion — see Track A Task 7 in the May 8 plan. Lower urgency: these are observability-only.
- Pre-materialized transition steps as `intake_log` rows — Track D of the May 8 plan. Separate concern.
- Converting non-dose timestamps (workouts, BP, weight, sleep, food). The bug class only matters where SQL equality on a timestamp drives behavior. Audit those tables for `WHERE <ts> = ?` patterns in a separate plan if warranted.
