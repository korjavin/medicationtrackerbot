# Split `internal/store` Into Per-Domain Repositories

## Overview

`internal/store.Store` is a single struct with **167 receiver methods** spanning 11+ unrelated concerns (medication, intake, BP, weight, food, workout, diary, vitals, timezone, settings, auth, push). The single file `internal/store/store.go` alone is 3,336 lines with 125 of those methods. This violates the boundary that CLAUDE.md's "domain service pattern is mandatory" rule is supposed to protect: with one `Store` type, the package is a permeable membrane — any domain's methods are reachable from any caller, and the file becomes a merge-conflict magnet.

This plan splits the implementation into per-domain repository packages, one feature per package, behind the **narrow consumer interfaces that already exist** in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`. Each task lands as a small reviewable PR via a forwarder-bridge migration: old callers keep compiling at every intermediate state.

**Problem it solves:**
- Adding a method to one domain forces touching the same 3,336-line file used by every other domain
- The CLAUDE.md domain-service rule has no enforcement at the data layer — the boundary is consumer-side only
- Test files (~56K lines under `internal/store/`) all bring up the full schema for every concern, slowing the feedback loop
- New contributors cannot map "where do BP methods live" without grepping by prefix

**Key benefit:** after this refactoring, each domain has its own package with its own tests; the god object is gone; cross-domain coupling has to be explicit at the import line.

**Out of scope** (explicitly):
- Renaming methods to fix inconsistent naming (`Create…` vs `Add…`, `Get…` vs `Fetch…`). Follow-up.
- DATETIME → INTEGER unix-seconds migrations for the remaining columns. See `docs/2026-05-13-go-code-review.md` §3.
- Identity refactor (`users` / `messenger_accounts` tables). See `docs/2026-05-13-go-code-review.md` §1.
- Deleting the anemic `internal/domain/reminder.go` pass-through. Different file.
- Eliminating duplication between `bp_reminders.go` and `weight_reminders.go` (allowed during BP/Weight tasks if convenient, but not a blocker).
- Schema changes of any kind. Pure refactor.

## Context (from discovery)

**Files involved:**

- `internal/store/store.go` — 3,336 lines, 125 `*Store` methods
- `internal/store/changes.go` — 70 lines, 3 methods (download tracking)
- `internal/store/vitals.go` — 269 lines, 4 methods (sleep, day stats)
- `internal/store/miband_workouts.go` — 504 lines, 10 methods
- `internal/store/bp_reminders.go` — 473 lines, 14 methods (incl. missing `defer rows.Close()` at lines 345-362 and 429-445)
- `internal/store/weight_reminders.go` — 268 lines, 11 methods
- `internal/store/migrations/` — embedded SQL (untouched by this plan)

**Method distribution by natural domain** (from `grep "^func (s \*Store)"`):

| Domain      | Method count | Notes                                                                          |
|-------------|--------------|--------------------------------------------------------------------------------|
| medication  | 41           | `medication` + `intake_log` + `restock` + `inventory` (share FK relationships) |
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
| changes     | 3            | download tracking                                                              |
| infra       | 2            | `Close`, `DB`                                                                  |

**Related patterns found:**

- `internal/server/store_interfaces.go` (227 lines, ~10 per-feature interfaces — `MedicationStore`, `BPStore`, `FoodStore`, etc.) — consumer-side narrowing **already in place**. After the split, handlers do not change: the interface contract is unchanged; only the concrete type wired in `cmd/bot/main.go` changes.
- `internal/bot/store_interfaces.go` (95 lines) — same pattern on the bot side.
- `internal/workout/service.go` — reference for "package-per-feature" structure (a domain service today; the same shape applies to repos).
- `internal/store/intake_log_time_columns_test.go` — architecture test pattern that locks in invariants per-domain. We can carry this forward into per-domain test files.
- Existing transactional methods (`ConfirmIntakesBySchedule` at `store.go:~1742`, plus four others at `:426, 1261, 1668`) use `defer func() { _ = tx.Rollback() }()`. Pattern survives the split; transactional helpers move to `internal/store/db/`.

**Dependencies identified:**

- 50+ non-test files import `internal/store` today (production callers across `cmd/`, `internal/server/`, `internal/bot/`, `internal/domain/`, `internal/scheduler/`, `internal/mcp/`, `internal/notifier/`, `internal/webpush/`, `internal/workout/`, `internal/seeddemo/`). Each will end up importing 1-3 per-domain packages instead.
- No database schema changes. No migration changes.
- No frontend changes.
- `goose` migration runner stays where it is (today inlined in `store.go` near the embedded FS at `:18-19`); it moves to `internal/store/db/migrations.go` in Task 1 unchanged.

## Development Approach

- **Testing approach**: Regular (move code, move tests, add transactional helpers as needed). No TDD required for moves; new shared helpers (`WithTx`) get tests first.
- **Forwarder-bridge incremental**. After each task, the existing `*Store` keeps the moved methods as one-line forwarders so consumers compile unchanged. Forwarders are deleted in the final task only.
- **One domain per PR.** Each task below is a single PR. Order matters only for Tasks 1-3 (infrastructure + pilot establish the pattern); Tasks 4-11 are largely parallelizable; Tasks 12-14 close out.
- **Pure refactor — no behaviour change.** No SQL changes, no method-signature changes, no logging changes. The diff should be dominated by `git mv` and import-path updates.
- **Pilot first, hottest path last.** Pilot is `diary` (3 methods, one consumer). The hottest path (`medication`, 41 methods, intake-log + restock) is deliberately last so the pattern is battle-tested by then.
- **CRITICAL: every task MUST include the tests that move with the code.** Tests are renamed and re-pathed alongside their source. Hash-stable `git mv` to preserve blame.
- **CRITICAL: `go test ./...` and `go test -race ./...` must pass at every task boundary.** No exceptions.
- **CRITICAL: update this plan file when scope changes during implementation.**
- Maintain backward compatibility — existing `*Store` callers compile unchanged until Task 13.

## Testing Strategy

- **Existing test suites stay green at every task boundary.** `go test ./...` and `go test -race ./...` after every task. The race detector is the most important guard because the forwarder bridge can mask threading regressions otherwise caught by data races during full-build CI.
- **Tests move with their code.** `internal/store/store_diary_test.go` → `internal/store/diary/diary_test.go` via `git mv` to preserve blame.
- **Architecture tests follow.** `internal/store/intake_log_time_columns_test.go` (the time-invariant guard) moves to `internal/store/medication/` during Task 12. `internal/store/store_time_invariants_test.go` stays at root in `internal/store/db/` because it asserts a store-wide invariant.
- **New shared helpers get tests first.** Task 1's `db.WithTx` lands with a round-trip commit/rollback test before any domain uses it.
- **Cross-repo transaction acceptance.** Task 11 (timezone) is the most demanding caller — it touches `intake_log` from outside the `medication` package via the `WithTx` pattern. Its existing cross-TZ tests (`internal/scheduler/medication_tz_test.go`, `internal/store/store_tz_transition_test.go`) are the regression backstop.
- **No new integration tests required.** Migration tests under `internal/store/migration_05*_test.go` stay put; they test schema, not domain methods.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document blockers with ⚠️ prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): code moves, forwarder additions, test moves, doc updates.
- **Post-Completion** (no checkboxes): final manual smoke test against a production-shaped DB; CLAUDE.md and `docs/architecture.md` doc sweep; follow-up plan stub for the method-renaming pass.

## Target Layout

```
internal/store/
├── db/                   # shared infra
│   ├── db.go             # Open(), Close(), embedded *sql.DB
│   ├── tx.go             # WithTx helper for cross-repo atomicity
│   ├── migrations.go     # goose runner (today in store.go)
│   └── time.go           # unix-seconds helpers (existing convention)
├── medication/           # 41 methods: medication + intake_log + restock + inventory
├── bp/                   # 13 methods incl. reminder state
├── weight/               # 15 methods incl. reminder state
├── food/                 # 15 methods
├── workout/              # 10 methods incl. mi-band
├── vitals/               # 5 methods (sleep, day_stats)
├── diary/                # 3 methods
├── tz/                   # 17 methods
├── settings/             # 6 methods (folds in changes.go's 3 download-tracking methods)
├── auth/                 # 6 methods (api tokens, login hashes)
├── push/                 # 4 methods
└── migrations/           # SQL files (unchanged location)
```

The current `internal/store/store.go` shrinks to either a thin `Repos` aggregation (decision in Task 13) or disappears.

## Design Decisions

### D1. One package per domain, not one file per domain

Tempting alternative: keep `package store` but split files. Rejected because it preserves the god-object problem at the Go package level — everything in `store` can call private helpers in `store`; nothing enforces the boundary. We want compiler-enforced separation.

### D2. Types co-located with their owner repo

`type Medication struct` lives in `internal/store/medication`. Consumers that need it import that package. One extra import for callers; ownership becomes obvious.

We considered a shared `internal/store/types` package and rejected it: it produces a "shapes-only" package that becomes a magnet for cross-domain composite fields (e.g. `MedicationWithLastIntake`) and recreates the god-object problem in passive form.

### D3. Shared DB connection via `db.DB`

```go
// internal/store/db/db.go
package db

type DB struct {
    *sql.DB
}

func Open(path string) (*DB, error) { … }

// Each repo holds *db.DB:
package medication
type Repo struct { db *db.DB }
func New(db *db.DB) *Repo { return &Repo{db: db} }
```

All repos share one `*sql.DB`, one connection pool, one busy-timeout config. The composition root (`cmd/bot/main.go`) opens it once and passes to each `New`.

### D4. Cross-repo transactions via `db.WithTx`

Some methods today take a transaction across what will become package boundaries — e.g. timezone-transition step consumption touches `intake_log` from a non-medication call site. After the split, the `medication` repo owns `intake_log`, so the `tz` repo cannot reach into it directly. Solution: a shared `db.TX` interface and `WithTx` helper:

```go
// internal/store/db/tx.go
package db

type TX interface {
    QueryRow(query string, args ...any) *sql.Row
    QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
    Query(query string, args ...any) (*sql.Rows, error)
    QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
    Exec(query string, args ...any) (sql.Result, error)
    ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func (d *DB) WithTx(ctx context.Context, fn func(TX) error) error {
    tx, err := d.BeginTx(ctx, nil)
    if err != nil { return err }
    defer tx.Rollback()
    if err := fn(tx); err != nil { return err }
    return tx.Commit()
}
```

Each repo exposes a `…Tx` variant of methods that need to participate in a caller-owned transaction. The shared `q db.TX` parameter satisfies both `*sql.DB` and `*sql.Tx`, so one private helper handles both paths. Only methods *today* used inside a transaction need the `Tx`-suffixed public variant in the first pass.

### D5. Narrow consumer interfaces stay put

`internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go` already define the consumer-facing interfaces. After the split, the composition root wires concrete per-domain repos to those interfaces — and the interfaces stay where they are. **No handler code changes** beyond `cmd/bot/main.go` wiring updates in Task 13.

This is the key reason this refactor is low-risk.

### D6. `Repos` aggregation in main, individual constructors in tests

`cmd/bot/main.go`, `cmd/mcptool/main.go`, `cmd/seeddemo/main.go`, `cmd/bpimporter/main.go` get a `Repos` struct:

```go
type Repos struct {
    Medication *medication.Repo
    BP         *bp.Repo
    // …
}
func New(d *db.DB) *Repos { … }
```

Tests construct only the repo they need.

### D7. `nowFunc` migration

`internal/store/store.go:49` defines a package-level `var nowFunc = time.Now`. Each new repo needs its own clock seam for testability. Recommend a `Clock` field on each `Repo` rather than package-level vars — fixes a latent test-order dependency. Optional in Task 1; mandatory by Task 13.

## Implementation Steps

---

### Task 1: Establish `internal/store/db` package

- [x] Create `internal/store/db/` package with `db.go` (connection open/close, busy-timeout config), `tx.go` (`TX` interface + `WithTx`), `migrations.go` (goose runner moved from `store.go`), `time.go` (unix-seconds helpers).
- [x] Add round-trip test for `WithTx`: commit path, rollback-on-error path, panic-in-fn path. Lives in `internal/store/db/tx_test.go`.
- [x] Update `cmd/bot/main.go`, `cmd/mcptool/main.go`, `cmd/seeddemo/main.go`, `cmd/bpimporter/main.go` to call `db.Open` and pass `*db.DB` into the existing `store.New` (which becomes a thin wrapper at this stage — no functional change). Implemented as: cmd files call `storedb.Open(path)` and then `store.NewWithDB(d)`; legacy `store.New(dbPath)` keeps working as a single-call entry point used by tests (~80 sites).
- [x] Run `go test ./...` and `go test -race ./...` — must pass before Task 2. Pre-existing race in `internal/server/TestHandleTriggerNextIntake_EarlyNotifFormatsInUserTZ` (between `mockNotifier.Send` and a server goroutine) reproduces on master pre-refactor and is unrelated to Task 1; non-race full suite is green and `go test -race ./internal/store/...` is green.

---

### Task 2: Pilot domain — `diary` (3 methods)

Chosen as the pilot because it is the smallest domain, has no cross-repo transactions, and has exactly one consumer (`internal/domain/notes.go`).

- [x] Create `internal/store/diary/` package with `repo.go` containing `Repo`, `New(*db.DB) *Repo`, and `DiaryNote` type.
- [x] Move `CreateDiaryNote`, `DeleteDiaryNote`, `ListDiaryNotes` from `store.go` to `internal/store/diary/repo.go`. Method receivers change from `s *Store` to `r *Repo`; SQL is unchanged. Public method names on the repo are `Create` / `List` / `Delete` (the "Diary" prefix is implied by the package name).
- [x] `git mv internal/store/store_diary_test.go internal/store/diary/diary_test.go` (preserves blame). Update package declaration and imports. Setup helper switches from `store.New(":memory:")` to `storedb.Open` + `migrations.FS` (new tiny `internal/store/migrations/` Go package added so subpackage tests can re-embed the schema without a cyclic import back into `internal/store`).
- [x] In `internal/store/store.go`, add forwarder methods so old callers compile unchanged:
  ```go
  func (s *Store) CreateDiaryNote(ctx context.Context, userID int64, content string, tag *string) (*DiaryNote, error) {
      return s.diary.Create(ctx, userID, content, tag)
  }
  ```
- [x] Add `diary *diary.Repo` field to `Store` struct; initialize in `store.New`. `DiaryNote` becomes a type alias (`type DiaryNote = diary.DiaryNote`) so existing `store.DiaryNote` references compile unchanged. `Store.Diary()` accessor exposes the repo so composition code (server.go, bot.go) can pass it through.
- [x] Update `internal/domain/notes.go` to take a narrow `diary.Repo`-compatible interface directly (`Create` / `List` / `Delete` methods returning `*diary.DiaryNote`). Wiring updated in `internal/server/server.go` and `internal/bot/bot.go` to call `domain.NewNotesService(s.Diary())`; `cmd/bot/main.go` did not require changes (already wires through `store.NewWithDB`).
- [x] Run `go test ./...` and `go test -race ./...` — must pass before Task 3. Full `go test ./...` is green; `go test -race ./internal/store/... ./internal/domain/... ./internal/bot/...` is green. The pre-existing race in `internal/server/TestHandleTriggerNextIntake_EarlyNotifFormatsInUserTZ` (documented in Task 1's completion note) is still the only race-detector failure; reproduces on master pre-refactor and is unrelated to the diary split.

---

### Task 3: `push` (4 methods)

Single consumer (`internal/notifier/webpush.go`, `internal/webpush/webpush.go`). Resolves §10.3 of the code review incidentally — `webpush.Service` will hold a narrow `push.Repo` instead of the concrete `*store.Store`.

- [x] Create `internal/store/push/` with `Repo`, `New(*db.DB) *Repo`, `PushSubscription` type. Public method names on the repo are `Create` / `List` / `Delete` / `Disable` (the "PushSubscription" suffix is implied by the package name).
- [x] Move `CreatePushSubscription`, `GetPushSubscriptions`, `DeletePushSubscription`, `DisablePushSubscription`.
- [x] Forwarders in `Store` (deletable in Task 13). `PushSubscription` becomes a type alias (`type PushSubscription = push.PushSubscription`) so existing `store.PushSubscription` references compile unchanged. `Store.Push()` accessor exposes the repo so `cmd/bot/main.go` can pass it through.
- [x] Update `internal/webpush/webpush.go:25-43` — replace `store *store.Store` with a narrow `push.Repo`-compatible interface (`SubscriptionStore` with `List` / `Disable`). `cmd/bot/main.go:145` now passes `s.Push()` instead of `s`.
- [x] Move push-related tests. Tests for push subscriptions lived inside `store_settings_test.go` (not a standalone file), so canonical tests now live at `internal/store/push/push_test.go` (rewritten against the `*Repo` API + an extra "re-create on disabled endpoint re-enables it" case to lock in the upsert behaviour); the duplicated `TestPushSubscriptions` and `TestPushSubscriptionDifferentUsers` were removed from `store_settings_test.go`.
- [x] Run `go test ./...` and `go test -race ./...` — must pass before Task 4. Full `go test ./...` is green; `go test -race ./internal/store/... ./internal/webpush/ ./internal/notifier/` is green. Pre-existing race in `internal/server/TestHandleTriggerNextIntake_EarlyNotifFormatsInUserTZ` (documented in Task 1) is unchanged and unrelated to this split.

---

### Task 4: `auth` (6 methods)

API tokens + login hashes. Single consumer (`internal/server/auth.go`).

- [x] Create `internal/store/auth/` with `Repo`, `APIToken` type.
- [x] Move `CreateAPIToken`, `DeleteAPIToken`, `FindAPITokenByHash`, `ListAPITokens`, `TouchAPITokenLastUsed`, `TryUseLoginHash`.
- [x] Forwarders in `Store`. `APIToken` becomes a type alias (`type APIToken = auth.APIToken`) so existing `store.APIToken` references (MCP admin/oauth handlers + tests) compile unchanged. `Store.Auth()` accessor exposes the repo for new callers.
- [x] `git mv internal/store/api_tokens_test.go internal/store/auth/api_tokens_test.go`. Tests rewritten against the `*Repo` API; setup helper switches from `store.New(":memory:")` to `storedb.Open` + `migrations.FS`.
- [x] `git mv internal/store/store_nonce_test.go internal/store/auth/nonce_test.go`. Tests rewritten against the `*Repo` API using the shared `setupAuthRepo` helper.
- [x] Run `go test ./...` and `go test -race ./...` — must pass before Task 5. Full `go test ./...` is green; `go test -race ./internal/store/... ./internal/mcp/... ./internal/bot/...` is green. Pre-existing race in `internal/server/TestHandleTriggerNextIntake_EarlyNotifFormatsInUserTZ` (documented in Task 1) is unchanged and unrelated to this split.

---

### Task 5: `vitals` (5 methods)

Sleep logs + day stats. Cross-references `workout` (mi-band imports day stats) — validate the boundary in this PR.

- [x] Create `internal/store/vitals/` with `Repo`, `SleepLog`, `DayStat` types (plus `VitalsHeartLog` / `VitalsSpO2Log` / `VitalsStressLog` since `vitals.go` content moved here too).
- [x] Move `GetSleepLogs`, `ImportSleepLogs`, `GetDayStats`, `ImportDayStats` (and `vitals.go` content — `ImportVitals` / `GetVitalsHeart` / `GetVitalsSpO2` / `GetVitalsStress`).
- [x] Forwarders in `Store`. `SleepLog` / `DayStat` / `VitalsHeartLog` / `VitalsSpO2Log` / `VitalsStressLog` become type aliases (e.g. `type SleepLog = vitals.SleepLog`) so existing `store.SleepLog` references (server health handlers, MCP cardiovascular/fitness/vitals tools, bot sleep importer, narrow consumer interfaces, tests) compile unchanged. `Store.Vitals()` accessor exposes the repo for new callers.
- [x] `git mv internal/store/store_sleep_vitals_test.go internal/store/vitals/vitals_test.go`. Tests rewritten against the `*Repo` API; setup helper switches from `store.New(":memory:")` to `storedb.Open` + `migrations.FS`.
- [x] Audit mi-band paths (`internal/store/miband_workouts.go`) for any sleep / day-stats coupling — none found. `miband_workouts.go` (10 methods on `MiBandWorkout` / `MiBandGPSPoint`) reads and writes only the workout tables and never references `sleep_logs`, `day_stats`, or `vitals_*` — confirmed by `grep -i "sleep\|day_stat\|SleepLog\|DayStat\|vitals_"` returning no matches. The boundary between Task 5 (vitals) and Task 10 (workout) is clean; mi-band stays with workout.
- [x] Run `go test ./...` and `go test -race ./...` — must pass before Task 6. Full `go test ./...` is green; `go test -race ./internal/store/... ./internal/mcp/... ./internal/bot/... ./internal/notifier/... ./internal/webpush/... ./internal/seeddemo/...` is green. The pre-existing race in `internal/server/TestHandleTriggerNextIntake_EarlyNotifFormatsInUserTZ` (documented in Task 1's completion note — between `mockNotifier.Send` and a `notifyWithAutoDelete` goroutine) reproduces on master pre-refactor and is unrelated to the vitals split.

---

### Task 6: `settings` (6 + 3 methods; folds in `changes.go`)

Widely consumed but each touch is trivial — likely the largest "import-path-only" PR.

- [ ] Create `internal/store/settings/` with `Repo`.
- [ ] Move `getSettingsBool`, `setSettingsBool`, `GetTabOrder`, `SetTabOrder`, and all per-feature `Get/Set*Enabled` (`GetMedicationEnabled`, `GetBloodPressureEnabled`, `GetWeightEnabled`, `GetWorkoutEnabled`, `GetHealthEnabled`, `GetFoodIntakeEnabled` and their setters).
- [ ] Fold in `changes.go`'s 3 methods (`GetLastDownload`, `UpdateLastDownload`, plus any third) — too small for their own package.
- [ ] Forwarders in `Store`.
- [ ] `git mv internal/store/store_settings_test.go internal/store/settings/settings_test.go`.
- [ ] `git mv internal/store/store_changes_test.go internal/store/settings/changes_test.go`.
- [ ] Run `go test ./...` and `go test -race ./...` — must pass before Task 7.

---

### Task 7: `bp` (13 methods including reminder state)

- [ ] Create `internal/store/bp/` with `Repo`, `BloodPressureReading`, `BPReminderState`, `BPGoal` types.
- [ ] Move `CreateBloodPressureReading`, `GetBloodPressureReadings`, `GetBPDailyWeightedStats`, `ImportBloodPressureReadings`, `GetBPGoal`, `SetBPGoal`, `DeleteBloodPressureReading`, plus `BatchGetLastBPReadings`.
- [ ] Move all of `bp_reminders.go` into `internal/store/bp/reminders.go` (14 methods).
- [ ] ➕ **Fix `defer rows.Close()` bug** at the old `bp_reminders.go:345-362` and `:429-445` (loop guard exists; normal-exit path leaks rows). Carrying this fix in the move PR keeps it atomic with the file move.
- [ ] Forwarders in `Store`.
- [ ] `git mv` the relevant test files: `store_bp_test.go`, `bp_stats_test.go`, `bp_batch_methods_test.go`, `bp_reminders_test.go` → `internal/store/bp/`.
- [ ] Run `go test ./...` and `go test -race ./...` — must pass before Task 8.

---

### Task 8: `weight` (15 methods)

Mirror of Task 7. If unifying `bp_reminders.go` / `weight_reminders.go` duplication (review §11) is desired, it lands now via a shared `internal/store/reminderstate/` package — otherwise duplication is acceptable and out of scope.

- [ ] Create `internal/store/weight/` with `Repo` and types.
- [ ] Move weight log + reminder + goal + unit pref methods.
- [ ] Forwarders.
- [ ] `git mv internal/store/store_weight_test.go internal/store/weight/weight_test.go`.
- [ ] `git mv internal/store/weight_reminders_test.go internal/store/weight/reminders_test.go`.
- [ ] Run `go test ./...` and `go test -race ./...` — must pass before Task 9.

---

### Task 9: `food` (15 methods)

Largest single-consumer feature: `internal/server/food_handlers.go`, `internal/server/mcp_food_log.go`, `internal/bot/photo_food.go`, `internal/domain/food*`.

- [ ] Create `internal/store/food/` with `Repo`, `FoodLog`, `FoodProduct`, `FoodTargets` types.
- [ ] Move `CreateFoodLog`, `CreateMealFromLogs`, `DeleteFoodLog`, `GetFoodLogs`, `UpdateFoodLog`, `GetFoodProductByID`, `GetFoodProductByName`, `GetFoodProducts`, `SearchFoodProducts`, `UpsertFoodProduct`, `UpdateFoodProduct`, `DeleteFoodProduct`, `GetFoodStats`, `GetFoodTargets`, `SetFoodTargets`.
- [ ] Move `openfoodfacts_api.go` if it stays purely a food helper (verify imports first).
- [ ] Forwarders.
- [ ] `git mv internal/store/store_food_test.go internal/store/food/food_test.go`.
- [ ] Run `go test ./...` and `go test -race ./...` — must pass before Task 10.

---

### Task 10: `workout` (10 methods including mi-band)

- [ ] Create `internal/store/workout/` with `Repo`, `WorkoutSession`, `ExerciseLog`, `MibandWorkout` types.
- [ ] Move workout session + exercise log methods.
- [ ] Move `miband_workouts.go` → `internal/store/workout/miband.go`.
- [ ] Forwarders.
- [ ] `git mv` workout test files (`store_miband_test.go`, `store_miband_bench_test.go`).
- [ ] Run `go test ./...` and `go test -race ./...` — must pass before Task 11.

---

### Task 11: `tz` (17 methods) — most cross-cutting

The hardest task. `tz` operations touch `intake_log` via `MarkStepConsumed`, `GetLatestConsumedStepTimePerMed`, etc. — and after Task 12, `intake_log` will live in the `medication` package. This task validates the cross-repo transaction pattern (D4) end-to-end.

- [ ] Create `internal/store/tz/` with `Repo`, `TZTransitionPlan`, `TZTransitionStep` types.
- [ ] Move `GetCurrentTimezone`, `RecordTimezone`, `CreateTZTransitionPlan`, `CreateTZTransitionPlanWithSteps`, `CreateTZTransitionSteps`, `GetLatestActiveOrPendingTZTransitionPlan`, `GetLatestCompletedTZTransitionPlan`, `GetLatestConsumedStepTimePerMed`, `GetPendingStepsForPlan`, `GetPlanByHash`, `MarkPlanNotified`, `MarkStepConsumed`, `RejectTZTransitionPlanAndRevertTimezone`, `ResetPlanToPending`, `SetTZTransitionPlanApproved`, `SetTZTransitionPlanRejected`, `UpdateTZTransitionPlanStatus`.
- [ ] For methods that today touch `intake_log` inside a transaction (notably `RejectTZTransitionPlanAndRevertTimezone`, `MarkStepConsumed`), keep the transaction in the `tz` repo and call the medication-package's `…Tx` variants via the shared `db.TX` interface. **Until Task 12 lands, those medication-side `…Tx` variants don't exist yet** — solve this by either:
  - (a) deferring those specific methods to Task 12 (move the easy ones now, the cross-repo ones with `medication`), or
  - (b) introducing a temporary `MedicationStoreForTZ` interface in `internal/store/tz/` that the existing `Store` satisfies, and which gets satisfied by the `medication.Repo` after Task 12.

  Recommend (b): keeps Task 11 fully parallel-mergeable with Task 12.
- [ ] Forwarders for the moved methods.
- [ ] `git mv internal/store/store_tz_transition_test.go internal/store/tz/transition_test.go`.
- [ ] `git mv internal/store/store_timezone_test.go internal/store/tz/timezone_test.go`.
- [ ] **Cross-TZ regression backstop:** ensure `internal/scheduler/medication_tz_test.go`, `internal/store/intake_log_readers_tz_test.go`, and `internal/store/store_tz_transition_test.go` all stay green.
- [ ] Run `go test ./...` and `go test -race ./...` — must pass before Task 12.

---

### Task 12: `medication` (41 methods) — biggest PR, hottest path

Includes intake_log, restock, inventory. Deliberately last so all the other patterns are battle-tested.

- [ ] Create `internal/store/medication/` with `Repo`, `Medication`, `IntakeLog`, `Restock`, `IntakeWithMedication` types.
- [ ] Move all 41 methods:
  - **Medication CRUD:** `CreateMedication`, `UpdateMedication`, `UpdateMedicationCreatedAt`, `DeleteMedication`, `GetMedication`, `ListMedications`, `CanDeleteMedication`, `SetMedicationEnabled`, `SetMedicationSupplement`, `GetMedicationEnabled`.
  - **Intake log:** `CreateIntake`, `CreateManualIntake`, `ConfirmIntake`, `ConfirmIntakesBySchedule`, `UpdateIntake`, `DeleteIntake`, `SkipIntake`, `SnoozeIntake`, `GetIntake`, `GetIntakeBySchedule`, `GetIntakeHistory`, `GetIntakesSince`, `GetIntakeReminders`, `GetBatchIntakeReminders`, `GetPendingIntakes`, `GetPendingIntakesBySchedule`, `GetPendingIntakesForMedication`, `GetTakenIntakesBySchedule`, `BatchGetIntakesBySchedule`, `AddIntakeReminder`.
  - **Restock + inventory:** `AddRestock`, `GetRestockHistory`, `DecrementInventory`, `IncrementInventory`, `SetInventory`, `IsLowOnStock`, `GetDaysOfStockRemaining`, `GetMedicationsLowOnStock`, `calculateDailyUsage`, `hasEnoughStock`.
- [ ] Expose `…Tx` variants for methods consumed by `tz` via the temporary interface introduced in Task 11(b). At minimum: `MarkStepConsumedTx` analogues for whatever `tz` calls into `intake_log`.
- [ ] Move `internal/store/intake_log_time_columns_test.go` → `internal/store/medication/`. Keep its scope (architecture invariant on `intake_log` columns).
- [ ] `git mv internal/store/store_medication_test.go internal/store/medication/medication_test.go`.
- [ ] `git mv internal/store/store_medication_batch_test.go internal/store/medication/batch_test.go`.
- [ ] `git mv internal/store/store_inventory_test.go internal/store/medication/inventory_test.go`.
- [ ] `git mv internal/store/intake_log_readers_tz_test.go internal/store/medication/intake_log_readers_tz_test.go`.
- [ ] Forwarders for the moved methods (last set of forwarders ever added).
- [ ] Run `go test ./...` and `go test -race ./...` — must pass before Task 13.

---

### Task 13: Remove the forwarder layer

- [ ] Update all remaining consumers to depend on per-repo types or narrow interfaces directly. Touch sites: ~50 production files, but each touch is a one-line import + one-line type swap.
- [ ] Delete every `*Store` forwarder method.
- [ ] Replace `store.Store` with `store.Repos` aggregation (per D6):
  ```go
  type Repos struct {
      Medication *medication.Repo
      BP         *bp.Repo
      // …
  }
  func New(d *db.DB) *Repos { … }
  ```
- [ ] Remove `nowFunc` package var; verify per-repo `Clock` fields are wired (or accept that follow-up).
- [ ] Update `cmd/bot/main.go`, `cmd/mcptool/main.go`, `cmd/seeddemo/main.go`, `cmd/bpimporter/main.go` compositions.
- [ ] Run `go test ./...` and `go test -race ./...` — must pass before Task 14.

---

### Task 14: Acceptance, docs, follow-up

- [ ] Full `go test ./...` and `go test -race ./...` — green.
- [ ] `go build ./...` — clean.
- [ ] `golangci-lint run` — no new issues vs. pre-refactor baseline.
- [ ] Backend integration smoke test against a production-shaped DB copy (importer + scheduler tick + Today dashboard read path).
- [ ] Update `CLAUDE.md`:
  - "Code Layout" section: replace `internal/store` line with one entry per sub-package.
  - "Common Tasks → Adding a new health metric" step 2: change "Add table methods to `internal/store/store.go`" to "Create a new `internal/store/<feature>/` repo following the diary/push pattern".
- [ ] Update `docs/architecture.md`:
  - Add a "Store layer" subsection describing the per-domain repo layout and `db.WithTx` cross-repo transaction pattern.
  - Reference this plan as design history.
- [ ] Move this plan to `docs/plans/completed/`.
- [ ] Open a follow-up stub plan for the method-renaming pass (consistency: `Create…` / `Get…` / `Set…` across all repos).

---

## Risks

- **Hidden cross-domain coupling.** A method we believe is "diary-only" may read from `intake_log` or `users`. Mitigation: each task's PR includes a grep for cross-package SQL references in moved methods; the pilot (diary, Task 2) will surface unknowns cheaply.
- **Transaction-boundary mistakes.** Splitting types makes it easier to forget that two writes need to be atomic. Mitigation: every method moved out of an existing transaction context is flagged in PR review; `WithTx` test coverage must accompany. Task 11 is the canonical stress test.
- **Test isolation regressions.** Today store tests share fixtures via package-private helpers. After splitting, helpers either duplicate or move to a shared `internal/store/storetest/` package. Allow modest duplication in Task 2; extract `storetest` only if duplication exceeds ~3 sites.
- **Caller import churn.** Roughly 50 production files import `internal/store` today; after Task 13 each imports 1-3 per-repo packages. Manageable but visible in the Task 13 diff.

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

Spread over a calendar period of 3-4 weeks at half-time. Tasks 4-11 are largely parallelizable across reviewers if more than one engineer is on it.

## Post-Completion

**Manual verification:**
- Start `cmd/bot` against a copy of production DB; verify medication confirmations, BP entries, food log writes, workout completions, timezone reschedule, low-stock notifications all behave identically.
- Run `cmd/bpimporter` and `cmd/seeddemo` against a fresh DB; verify they exercise the new repo composition correctly.
- Tail `slog` output during a scheduler tick; confirm no new log lines (this is a pure refactor — output must be identical).

**Future opportunities** (out of scope for this plan, captured for the follow-up):
- Method-renaming sweep for consistency (`Create…` vs `Add…`, `Get…` vs `Fetch…`).
- Replace per-repo `Clock` fields with a shared `clock.Clock` interface across the codebase.
- Once repos are stable, extract a `Querier` interface tighter than `db.TX` for read-only repos that can run on a replica.
- Reconsider whether `internal/store/auth` belongs alongside other repos or moves up to `internal/auth/` once the identity refactor (review §1) is scheduled.
