# Split `internal/store` Into Per-Domain Repositories

> **Status (2026-05-13):** DRAFT. Not yet scheduled. Companion to
> [`docs/2026-05-13-go-code-review.md`](../2026-05-13-go-code-review.md) §2.

## Overview

`internal/store.Store` is a single struct with **167 receiver methods**
spanning 11+ unrelated concerns (medication, intake, BP, weight, food,
workout, diary, vitals, timezone, settings, auth, push). The single
file `internal/store/store.go` alone is 3,336 lines with 125 methods.
This violates the single-responsibility boundary that CLAUDE.md's
"domain service pattern is mandatory" rule is supposed to protect: with
one `Store` type, the package is a permeable membrane — any domain's
methods are reachable from any caller.

The narrowing-interface pattern is already partially in place on the
*consumer* side:

- `internal/server/store_interfaces.go` (227 lines, ~10 per-feature
  interfaces like `MedicationStore`, `BPStore`, …)
- `internal/bot/store_interfaces.go` (95 lines, similar)

Consumers already only see the slice of `Store` they need. What is
missing is splitting the *implementation* to match. This plan does
that.

## Goals

1. **Per-domain repository types** — one struct per feature, methods
   for that feature only.
2. **Consumers continue to depend on narrow interfaces**, not on
   concrete repos — preserves testability and keeps mocks simple.
3. **Cross-domain transactions remain possible** — the medication →
   intake_log paths in particular need atomic writes.
4. **Incremental** — one domain per PR, each PR independently
   reviewable and revertible.
5. **No behaviour change** — pure refactor. No SQL changes, no
   schema changes, no logging changes.

## Non-goals

- Renaming methods to fix inconsistent naming (`Create…` vs `Add…`,
  `Get…` vs `Fetch…`). That's a follow-up.
- DATETIME → INTEGER unix-seconds migrations (separate plan,
  cross-references [docs/architecture.md → Time storage](../architecture.md#time-storage)).
- Identity refactor (`users` / `messenger_accounts` tables) — that's a
  separate, larger plan tracked in
  [`docs/2026-05-13-go-code-review.md`](../2026-05-13-go-code-review.md) §1.
- Eliminating duplication between `bp_reminders.go` and
  `weight_reminders.go` (do it during BP/Weight splits if convenient,
  but it is not a blocker).
- Deleting the anemic `ReminderService`. Different file.

## Current method distribution

Grouped by natural domain (counted from `grep "^func (s \*Store)"`
across `store.go`, `vitals.go`, `miband_workouts.go`, `changes.go`,
`bp_reminders.go`, `weight_reminders.go`):

| Domain      | Method count | Notes                                                                          |
|-------------|--------------|--------------------------------------------------------------------------------|
| medication  | 41           | `medication` + `intake_log` + `restock` + `inventory` — share FK relationships |
| timezone    | 17           | `tz_transition_plans` + `tz_transition_steps` + current TZ                     |
| food        | 15           | `food_log_entries` + `food_products` + targets + stats                         |
| weight      | 15           | `weight_logs` + `weight_reminder_state` + goal + unit pref                     |
| bp          | 13           | `blood_pressure_readings` + `bp_reminder_state` + goal                         |
| workout     | 10           | `workout_sessions` + `exercise_logs` + mi-band                                 |
| settings    | 6            | `getSettingsBool` + per-feature `Get/Set*Enabled` + tab order                  |
| auth        | 6            | `api_tokens` + `used_login_hashes`                                             |
| vitals      | 5            | `sleep_logs` + `day_stats`                                                     |
| push        | 4            | `push_subscriptions`                                                           |
| diary       | 3            | `diary_notes`                                                                  |
| infra       | 2            | `Close`, `DB`                                                                  |
| changes     | 3            | `changes.go` (download tracking)                                               |

Total: 140 domain methods + a few infra/internal helpers.

## Target layout

```
internal/store/
├── db/                   # shared infra
│   ├── db.go             # Open(), Close(), embedded DB type
│   ├── tx.go             # WithTx helper for cross-repo atomicity
│   ├── migrations.go     # goose runner (today in store.go)
│   └── time.go           # unix-seconds helpers (existing convention)
├── medication/           # 41 methods
│   ├── repo.go
│   ├── intake_log.go     # CreateIntake, ConfirmIntake, …
│   ├── restock.go        # AddRestock, IncrementInventory, …
│   ├── types.go          # Medication, IntakeLog, Restock structs
│   └── *_test.go         # moved from store_medication_test.go etc.
├── bp/                   # 13 methods, including reminder state
├── weight/               # 15 methods, including reminder state
├── food/                 # 15 methods
├── workout/              # 10 methods incl mi-band
├── vitals/               # 5 methods (sleep, day_stats)
├── diary/                # 3 methods
├── tz/                   # 17 methods
├── settings/             # 6 methods (incl tab order)
├── auth/                 # 6 methods (api tokens, login hashes)
├── push/                 # 4 methods
└── migrations/           # SQL files (unchanged location)
```

The current `internal/store/store.go` shrinks to nothing or becomes a
thin facade for migration compatibility (see §"Rollout & migration
strategy" below).

## Design decisions

### D1. One package per domain, not one file per domain

Tempting alternative: keep `package store` but split files. Rejected
because it preserves the god-object problem at the Go package level
(everything in `store` can call private helpers in `store`; nothing
enforces the boundary).

### D2. Types co-located with their owner repo

`type Medication struct` lives in `internal/store/medication`. Consumers
that need it import that package. This is one extra import for callers,
which is fine — and it makes ownership obvious.

We considered a shared `internal/store/types` package but rejected it:
it produces a "shapes-only" package that becomes a magnet for cross-domain
fields (e.g. `MedicationWithLastIntake`) and recreates the god-object
problem in passive form.

### D3. Shared DB connection via `db.DB`

```go
// internal/store/db/db.go
package db

type DB struct {
    *sql.DB
}

func Open(path string) (*DB, error) { … }

// Each repo embeds or holds *db.DB:
package medication
type Repo struct { db *db.DB }
func New(db *db.DB) *Repo { return &Repo{db: db} }
```

All repos share one `*sql.DB`, one connection pool, one busy-timeout
config. The composition root (`cmd/bot/main.go`) opens it once and
passes to each `New`.

### D4. Cross-repo transactions via `db.WithTx`

The hardest case: `ConfirmIntakesBySchedule`
(`internal/store/store.go:~1742`) takes a transaction across medication
+ intake operations. After the split these would be the same package
(medication owns intake_log). But other cross-domain transactions
exist (e.g. timezone transitions touch `intake_log` from the `tz` repo).

Pattern:

```go
// internal/store/db/tx.go
package db

type TX interface {
    QueryRow(query string, args ...any) *sql.Row
    Query(query string, args ...any) (*sql.Rows, error)
    Exec(query string, args ...any) (sql.Result, error)
    // … plus Context variants
}

func (d *DB) WithTx(ctx context.Context, fn func(TX) error) error {
    tx, err := d.BeginTx(ctx, nil)
    if err != nil { return err }
    defer tx.Rollback()
    if err := fn(tx); err != nil { return err }
    return tx.Commit()
}
```

Each repo exposes a `Tx()` variant of methods that need to participate
in a caller-owned transaction:

```go
// internal/store/medication/intake_log.go
func (r *Repo) ConfirmIntake(ctx context.Context, id int64, takenAt time.Time) error {
    return r.confirmIntakeTx(ctx, r.db, id, takenAt)
}
func (r *Repo) ConfirmIntakeTx(ctx context.Context, tx db.TX, id int64, takenAt time.Time) error {
    return r.confirmIntakeTx(ctx, tx, id, takenAt)
}
func (r *Repo) confirmIntakeTx(ctx context.Context, q db.TX, id int64, takenAt time.Time) error { … }
```

The shared `q db.TX` parameter satisfies both `*sql.DB` and `*sql.Tx`,
so the same private helper handles both paths. Only methods that
*today* are already used inside a transaction need the `Tx`-suffixed
public variant in the first pass.

### D5. Narrow interfaces stay on the consumer side

`internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`
already define the consumer-facing interfaces. After the split, the
composition root wires concrete repos to those interfaces — and the
interfaces can stay where they are. No changes required to handler
code beyond import-path updates in the composition root.

This is the key reason this refactor is low-risk: handlers don't see
which concrete type they get; the interface contract is unchanged.

### D6. Tests move with their code

`internal/store/store_medication_test.go` → `internal/store/medication/medication_test.go`.
Migration tests (`migration_057_test.go` … `migration_062_test.go`)
stay where they are — they test schema, not domain methods, and the
migrations directory does not move.

`internal/store/intake_log_time_columns_test.go` (the time-invariant
guard) moves to `internal/store/medication/`. The store-wide
`store_time_invariants_test.go` is split per-repo or kept in
`internal/store/db/` if it remains store-wide.

## Tasks

Each task is **one PR**. Order matters for the first three; later
tasks are largely parallelizable.

### Task 1 — Establish `internal/store/db`

- [ ] Create `internal/store/db/` package
- [ ] Move connection open/close, busy-timeout config, migration runner
- [ ] Define `db.TX` interface, `db.DB` wrapper, `WithTx` helper
- [ ] Add unix-seconds helpers (mirror existing convention)
- [ ] Update `cmd/bot/main.go`, `cmd/mcptool/main.go`,
      `cmd/seeddemo/main.go`, `cmd/bpimporter/main.go` to call `db.Open`
- [ ] Keep `store.New` as a thin wrapper that calls `db.Open` and
      returns the existing `*Store` — **no functional change yet**

**Acceptance:** `go test ./...` passes. No consumer code changes.

### Task 2 — Pilot domain: `diary` (3 methods)

Chosen as the pilot because it is the smallest domain with no
cross-repo transactions and exactly one consumer
(`internal/domain/notes.go`).

- [ ] Create `internal/store/diary/` package
- [ ] Move `CreateDiaryNote`, `DeleteDiaryNote`, `ListDiaryNotes` and
      `DiaryNote` type
- [ ] Move `store_diary_test.go` → `internal/store/diary/diary_test.go`
- [ ] In `internal/store/store.go`, add forwarder methods:
      ```go
      func (s *Store) CreateDiaryNote(…) error { return s.diary.Create(…) }
      ```
      so old callers compile unchanged
- [ ] Update `internal/domain/notes.go` to take `diary.Repo` directly
- [ ] Update `cmd/bot/main.go` composition

**Acceptance:** `go test ./...` passes. PR is < 500 lines. Establishes
the pattern for subsequent tasks.

### Task 3 — `push` (4 methods)

Single consumer (`internal/notifier/webpush.go`,
`internal/webpush/webpush.go`). Resolves §10.3 of the review
incidentally — `webpush.Service` will hold a narrow `push.Repo`
instead of `*store.Store`.

- [ ] Move 4 push methods to `internal/store/push/`
- [ ] Forwarders in `Store`
- [ ] Update webpush callers
- [ ] Move push-related tests

### Task 4 — `auth` (6 methods)

API tokens + login hashes. Single consumer
(`internal/server/auth.go`).

### Task 5 — `vitals` (5 methods)

Sleep logs + day stats. Cross-references workout (mi-band imports
day stats); validate that boundary in this PR.

### Task 6 — `settings` (6 methods)

Per-feature `Get/Set*Enabled` + tab order. Widely consumed; touches
many callers but each touch is trivial (one method call). Likely the
largest "import-path-only" PR.

### Task 7 — `bp` (13 methods including reminder state)

- [ ] Move `CreateBloodPressureReading`, `GetBloodPressureReadings`,
      `GetBPDailyWeightedStats`, `ImportBloodPressureReadings`, BP
      goal methods, `Get/SetBloodPressureEnabled`
- [ ] Move all of `bp_reminders.go` into `internal/store/bp/reminders.go`
- [ ] Fix the missing `defer rows.Close()` at
      `internal/store/bp_reminders.go:345-362` and `:429-445` as
      part of the move

### Task 8 — `weight` (15 methods)

Mirror of Task 7 for weight. If the duplication between BP/weight
reminder state code is to be unified (review §11), it lands now via a
shared `internal/store/reminderstate/` package.

### Task 9 — `food` (15 methods)

Largest single-consumer feature: `internal/server/food_handlers.go`,
`internal/server/mcp_food_log.go`, `internal/bot/photo_food.go`,
`internal/domain/food*`.

### Task 10 — `workout` (10 methods including mi-band)

- [ ] Move workout session + exercise log + mi-band methods
- [ ] `miband_workouts.go` → `internal/store/workout/miband.go`

### Task 11 — `tz` (17 methods)

The most cross-cutting domain. Touches `intake_log` via
`MarkStepConsumed`, `GetLatestConsumedStepTimePerMed`, etc. Validate
the `WithTx` pattern here — the timezone-transition engine
(`internal/domain/tzreschedule/engine.go`) is the most demanding
caller in the codebase.

This PR is also the right place to verify that all the cross-repo
transactions still work end-to-end (run the full test suite including
the cross-TZ tests).

### Task 12 — `medication` (41 methods)

The biggest single PR. Includes intake_log, restock, inventory.
Deliberately ordered last so all the other patterns are battle-tested
before we touch the hottest code path.

- [ ] Move medication CRUD + intake log + restock + inventory
- [ ] Move all medication tests
- [ ] At end of this task, `internal/store/store.go` contains only
      forwarders, the `Store` struct that holds the 11 sub-repos, and
      maybe the timezone-now helper

### Task 13 — Remove forwarder layer

- [ ] Update remaining consumers to depend on per-repo types or the
      narrow interfaces directly
- [ ] Delete `*Store` forwarder methods
- [ ] Either delete `store.Store` entirely, or keep it as a
      `Repos` aggregation type:
      ```go
      type Repos struct {
          Medication *medication.Repo
          BP         *bp.Repo
          Weight     *weight.Repo
          // …
      }
      func New(db *db.DB) *Repos { … }
      ```
- [ ] Update CLAUDE.md → "Common Tasks → Adding a new health metric"
      to reflect the new layout

### Task 14 — Acceptance

- [ ] Full `go test ./...` passes
- [ ] Race detector clean: `go test -race ./...`
- [ ] Backend integration test against a copy of production DB
- [ ] CLAUDE.md updated
- [ ] `docs/architecture.md` updated
- [ ] One-paragraph follow-up entry in `docs/plans/completed/`

## Rollout & migration strategy

### Forwarder bridge

For each task between 2 and 12, the existing `*Store` keeps the
moved methods as forwarders:

```go
// internal/store/store.go (during transition)
type Store struct {
    db    *db.DB
    diary *diary.Repo
    push  *push.Repo
    // … added one at a time
}

func (s *Store) CreateDiaryNote(userID int64, body string, t time.Time) (int64, error) {
    return s.diary.Create(userID, body, t)
}
```

This is what makes each task a < 1-day PR with low review burden:
consumers compile unchanged.

In Task 13 the forwarders are removed and consumers are migrated to
the per-repo types in one final sweep.

### Reverting any task is safe

If Task N breaks something, revert only that task's PR — the
forwarder pattern means no caller depends on the new structure until
Task 13.

### Test churn

Test files move alongside the code they test. To minimize git-blame
loss:

```bash
git mv internal/store/store_diary_test.go internal/store/diary/diary_test.go
```

Hash-stable rename; blame survives.

## Risks

- **Hidden cross-domain coupling.** A method we think is "diary-only"
  may turn out to read from `intake_log` or `users`. Mitigation: each
  task's PR includes a grep for cross-package SQL references in
  moved methods. The pilot (diary, Task 2) will surface unknowns
  cheaply.
- **Transaction boundary mistakes.** Splitting types makes it easier
  to forget that two writes need to be atomic. Mitigation: every
  method moved out of an existing transaction context is flagged in
  PR review; `WithTx` test coverage must accompany.
- **Test isolation regressions.** Today the store tests share fixtures
  via package-private helpers. After splitting, helpers either
  duplicate or move to a shared test-helper package. We will allow
  modest duplication in Task 2 and only extract a `internal/store/storetest/`
  package if the duplication exceeds ~3 sites.
- **Caller import churn.** Roughly 50 files import `internal/store`
  directly (per the audit). After Task 13 they'll import 1-3
  per-repo packages each. Manageable but visible in PRs.

## Estimate

| Task                       | Effort   |
|----------------------------|----------|
| 1 — `db` package           | 0.5 day  |
| 2 — diary pilot            | 0.5 day  |
| 3 — push                   | 0.5 day  |
| 4 — auth                   | 0.5 day  |
| 5 — vitals                 | 0.5 day  |
| 6 — settings               | 1 day    |
| 7 — bp                     | 1 day    |
| 8 — weight                 | 1 day    |
| 9 — food                   | 1.5 days |
| 10 — workout               | 1 day    |
| 11 — tz                    | 2 days   |
| 12 — medication            | 2-3 days |
| 13 — remove forwarders     | 1 day    |
| 14 — acceptance + docs     | 0.5 day  |
| **Total**                  | **~13-14 days of focused work** |

Spread over a calendar period of 3-4 weeks at half-time.

## Open questions

1. **`Repos` aggregation type vs individual constructors in `main.go`?**
   `Repos` keeps `main.go` short; individual constructors make
   dependencies explicit at the call site. Recommend `Repos` for
   `cmd/bot/main.go` and `cmd/mcptool/main.go` (production composition
   roots), individual constructors in tests.

2. **Should `nowFunc` move into `db` or stay per-repo?**
   `nowFunc` (`internal/store/store.go:49`) is a package-level
   variable. Each new repo will want one too for testability.
   Recommend: a `Clock` injected via `Repo{clock Clock}` instead of
   package-level vars. Cosmetic but fixes a latent test-order
   dependency.

3. **`changes.go` (download tracking) — own package or part of
   `settings`?** 3 methods, no consumers outside `cmd/bpimporter`.
   Recommend: fold into `settings` to avoid a 3-method package.

4. **Migration tests (`migration_05*_test.go`) — keep at root or move?**
   They test SQL schema, not domain methods. Keep at
   `internal/store/migrations_test.go` (or top of package). Do not
   move.
