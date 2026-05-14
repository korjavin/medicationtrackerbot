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

- [x] Create `internal/store/settings/` with `Repo`.
- [x] Move `getSettingsBool`, `setSettingsBool`, `GetTabOrder`, `SetTabOrder`, and all per-feature `Get/Set*Enabled` (`GetMedicationEnabled`, `GetBloodPressureEnabled`, `GetWeightEnabled`, `GetWorkoutEnabled`, `GetHealthEnabled`, `GetFoodIntakeEnabled` and their setters). The private `getSettingsBool`/`setSettingsBool` are exposed as `(*Repo).GetBool`/`SetBool` so the SQL-injection allowlist test (previously `store_validation_test.go`) keeps a public surface to test against.
- [x] Fold in `changes.go`'s 3 methods (`GetLastDownload`, `UpdateLastDownload`, plus any third) — too small for their own package. Note: the plan author misremembered which methods lived where. `changes.go` actually contained `GetLatestChangeCursor` / `GetChangedTagsSince` / `PruneChangeEvents` (the change_events stream); `GetLastDownload` / `UpdateLastDownload` lived in `store.go` under the "-- Settings --" comment. Both groups (5 methods total) are folded into `internal/store/settings` since they all sit on the singleton `settings` row + the change-stream sibling table; `changes.go` is deleted in this task.
- [x] Forwarders in `Store`. `Store.Settings()` accessor exposes the repo for new callers.
- [x] `git mv internal/store/store_settings_test.go internal/store/settings/settings_test.go`. The `WeightUnitPreference` tests that lived in this file are extracted to a new `internal/store/store_weight_unit_pref_test.go` because those methods stay on `*Store` until Task 8 (weight). `store_validation_test.go` is deleted; its SQL-injection allowlist coverage is preserved as `TestSettingsBoolValidation` in the moved settings_test.go (rewritten against the new `(*Repo).GetBool`/`SetBool` surface).
- [x] `git mv internal/store/store_changes_test.go internal/store/settings/changes_test.go`. Tests rewritten against the `*Repo` API.
- [x] Run `go test ./...` and `go test -race ./...` — must pass before Task 7. Full `go test ./...` is green; `go test -race ./internal/store/... ./internal/domain/... ./internal/bot/...` is green. The pre-existing race in `internal/server/TestHandleTriggerNextIntake_EarlyNotifFormatsInUserTZ` (documented in Task 1) reproduces on master pre-refactor and is unrelated. A second pre-existing notifier-pattern race surfaced in `internal/scheduler/TestWorkoutCheckerScenarios/Stale_session_notification` (mockNotifier.Send raced by `(*WorkoutChecker).Check`'s notify goroutine); verified on master pre-refactor in this same loop and likewise unrelated to the settings split.

---

### Task 7: `bp` (13 methods including reminder state)

- [x] Create `internal/store/bp/` with `Repo`, `BloodPressure`, `BPReminderState`, `BPGoal`, `BPStats`, `BPPeriodStats` types. The package also exposes `CalculateBPCategory` / `CategorySeverity` (pure functions, no DB) and an internal `TimezoneLookup` interface that `*store.Store` satisfies today and `*tz.Repo` will satisfy after Task 11.
- [x] Move `CreateBloodPressureReading`, `GetBloodPressureReadings`, `GetBPDailyWeightedStats`, `ImportBloodPressureReadings`, `GetBPGoal`, `SetBPGoal`, `DeleteBloodPressureReading`, plus `BatchGetLastBPReadings`. `truncateToDay` (private helper used only by `GetBPDailyWeightedStats`) also moves into the package. `nowFunc` access becomes per-repo `r.now` (defaults to `time.Now`, overridable via `SetClock`) so the BP-stats tests no longer touch the package-global `store.nowFunc`.
- [x] Move all of `bp_reminders.go` into `internal/store/bp/reminders.go` (14 methods).
- [x] ➕ **Fix `defer rows.Close()` bug** at the old `bp_reminders.go:345-362` and `:429-445` (loop guard exists; normal-exit path leaks rows). Carrying this fix in the move PR keeps it atomic with the file move. Implemented by extracting `scanReminderStateChunk` / `scanLastReadingsChunk` so each chunked query owns a single `defer rows.Close()` that fires on every exit path (success + error), instead of the prior pattern that hand-closed rows in two error branches and post-loop — which left a leak in the no-rows / iteration-error paths.
- [x] Forwarders in `Store`. `BloodPressure` / `BPGoal` / `BPStats` / `BPPeriodStats` / `BPReminderState` become type aliases (e.g. `type BloodPressure = bp.BloodPressure`) so existing `store.BloodPressure` references (server BP handlers, MCP cardiovascular tools, bot BP callbacks, importer, demo seeder, narrow consumer interfaces, tests) compile unchanged. `CalculateBPCategory` and `CategorySeverity` remain at the package level as one-line forwarders. `Store.BP()` accessor exposes the repo for new callers.
- [x] `git mv` the relevant test files: `store_bp_test.go` → `internal/store/bp/bp_test.go`, `bp_stats_test.go` → `internal/store/bp/stats_test.go`, `bp_batch_methods_test.go` → `internal/store/bp/batch_test.go`, `bp_reminders_test.go` → `internal/store/bp/reminders_test.go`. Tests rewritten against the `*Repo` API; setup helper switches from `store.New(":memory:")` to `storedb.Open` + `migrations.FS`. A local `stubTZ` implements `TimezoneLookup` for the Tokyo-day-boundary test that needs a non-UTC zone; the UTC-fallback test uses `stubTZ{tz: ""}`.
- [x] Run `go test ./...` and `go test -race ./...` — must pass before Task 8. Full `go test ./...` is green; `go test -race ./internal/store/... ./internal/domain/... ./internal/bot/...` is green. The two pre-existing notifier-pattern races (`internal/server/TestHandleTriggerNextIntake_EarlyNotifFormatsInUserTZ` and `internal/scheduler/TestWorkoutCheckerScenarios/Stale_session_notification`, documented in Task 1 and Task 6's completion notes) still reproduce on master pre-refactor and are unrelated to the BP split.

---

### Task 8: `weight` (15 methods)

Mirror of Task 7. If unifying `bp_reminders.go` / `weight_reminders.go` duplication (review §11) is desired, it lands now via a shared `internal/store/reminderstate/` package — otherwise duplication is acceptable and out of scope. Duplication left in place; the two reminder packages share no code today but the shapes are identical and a follow-up can extract `reminderstate` cleanly when the rest of the split is done.

- [x] Create `internal/store/weight/` with `Repo` and types (`WeightLog`, `WeightGoal`, `WeightReminderState`). Package also exposes `CalculateWeightTrend` (pure function, no DB) at the package level so callers outside the DB-write path (domain/exercise, EMA trend baseline) share the same alpha.
- [x] Move weight log + reminder + goal + unit pref methods (15 in total: `CreateWeightLog` / `GetWeightLogs` / `DeleteWeightLog` / `GetLastWeightLog` / `GetLastWeightLogExcluding` / `GetHighestWeightRecord` / `BatchGetLastWeightLogs` / `GetWeightGoal` / `SetWeightGoal` / `GetWeightUnitPreference` / `SetWeightUnitPreference`) plus the 11 weight_reminders.go methods (`GetWeightReminderState` / `initWeightReminderState` / `SetWeightReminderEnabled` / `SnoozeWeightReminder` / `DontBugMeWeightReminder` / `UpdateWeightReminderNotificationSent` / `ClearWeightReminderNotificationMessage` / `CalculatePreferredWeightReminderHour` / `UpdatePreferredWeightReminderHour` / `GetUsersForWeightReminders` / `GetWeightReminderStates`). All SQL is unchanged.
- [x] Forwarders in `Store`. `WeightLog` / `WeightGoal` / `WeightReminderState` become type aliases (e.g. `type WeightLog = weight.WeightLog`) so existing `store.WeightLog` references (server weight handlers, MCP weight tools, bot weight callbacks, importer, demo seeder, narrow consumer interfaces, tests) compile unchanged. `CalculateWeightTrend` remains at the package level as a one-line forwarder. `Store.Weight()` accessor exposes the repo for new callers. `internal/store/weight_reminders.go` survives but is now just forwarders (deletable in Task 13).
- [x] `git mv internal/store/store_weight_test.go internal/store/weight/weight_test.go`. Tests rewritten against the `*Repo` API; setup helper switches from `store.New(":memory:")` to `storedb.Open` + `migrations.FS`.
- [x] `git mv internal/store/weight_reminders_test.go internal/store/weight/reminders_test.go`. Tests rewritten against the `*Repo` API using the shared `setupWeightRepo` helper. The `TestGetLastWeightLog` test was renamed to `TestGetLastWeightLog_WithReminderRepo` to disambiguate it from the same-named test in weight_test.go (both lived in the `store` package previously and worked because they were in separate files but didn't share names within a single test file — moving both into the same `weight` package required a rename).
- [x] ➕ Also moved `internal/store/store_weight_unit_pref_test.go` → `internal/store/weight/unit_pref_test.go` since the unit-pref methods landed in the weight repo (the original Task 8 description didn't enumerate this file because Task 6 had punted on whether unit-pref goes in settings or weight; it lands in weight here, alongside the related weight goal / log methods).
- [x] Run `go test ./...` and `go test -race ./...` — must pass before Task 9. Full `go test ./...` is green; `go test -race ./internal/store/... ./internal/domain/... ./internal/bot/... ./internal/seeddemo/... ./internal/webpush/... ./internal/notifier/...` is green. The pre-existing race in `internal/scheduler/TestWorkoutCheckerScenarios/Stale_session_notification` (mockNotifier.Send vs `(*WorkoutChecker).Check`'s notify goroutine, documented in Task 6 and Task 7 completion notes) was verified on master pre-refactor in this same loop (3/3 iterations of `go test -race -count=1 ./internal/scheduler/` failed on the stashed pre-weight state) and remains unrelated to the weight split.

---

### Task 9: `food` (15 methods)

Largest single-consumer feature: `internal/server/food_handlers.go`, `internal/server/mcp_food_log.go`, `internal/bot/photo_food.go`, `internal/domain/food*`.

- [x] Create `internal/store/food/` with `Repo`, `FoodLog`, `FoodProduct`, `FoodTargets` types (plus `FoodStats`, `FoodProductsFilter`, `OpenFoodFact` since they all live with the food domain).
- [x] Move `CreateFoodLog`, `CreateMealFromLogs`, `DeleteFoodLog`, `GetFoodLogs`, `UpdateFoodLog`, `GetFoodProductByID`, `GetFoodProductByName`, `GetFoodProducts`, `SearchFoodProducts`, `UpsertFoodProduct`, `UpdateFoodProduct`, `DeleteFoodProduct`, `GetFoodStats`, `GetFoodTargets`, `SetFoodTargets`. All SQL is unchanged.
- [x] Move `openfoodfacts_api.go` — `SearchRemoteFoodAPI` and its `fastFoodProduct` / `mapFastFoodProductToLocal` / `normalizeFoodProductName` / `isNumeric` helpers only reference `FoodProduct` (no other store-internal types) and are only consumed via `s.food.SearchRemoteFoodAPI` in `food_handlers.go`, so the file `git mv`'d cleanly to `internal/store/food/openfoodfacts_api.go` and its receiver changed from `*Store` to `*Repo`.
- [x] Forwarders in `Store`. `FoodLog` / `FoodProduct` / `FoodTargets` / `FoodStats` / `FoodProductsFilter` / `OpenFoodFact` become type aliases (e.g. `type FoodLog = food.FoodLog`) so existing `store.FoodLog` references (server food handlers + MCP food-log + settings handlers + tests; MCP fitness/tools; bot food commands + photo food; demo seeder; narrow consumer interfaces) continue to compile unchanged. `Store.Food()` accessor exposes the repo for new callers. Includes a `SearchRemoteFoodAPI` forwarder.
- [x] `git mv internal/store/store_food_test.go internal/store/food/food_test.go`. Tests rewritten against the `*Repo` API; setup helper switches from `store.New(":memory:")` to `storedb.Open` + `migrations.FS`.
- [x] Run `go test ./...` and `go test -race ./...` — must pass before Task 10. Full `go test ./...` is green; `go test -race ./internal/store/... ./internal/domain/... ./internal/bot/... ./internal/notifier/... ./internal/webpush/... ./internal/seeddemo/...` is green; `go test -race ./internal/server/ -run Food` is also green. The two pre-existing notifier-pattern races (`internal/server/TestHandleTriggerNextIntake_EarlyNotifFormatsInUserTZ` and `internal/scheduler/TestWorkoutCheckerScenarios/Stale_session_notification`, documented in Task 1, Task 6, Task 7 and Task 8's completion notes) still reproduce on master pre-refactor and are unrelated to the food split.

---

### Task 10: `workout` (10 methods including mi-band)

- [x] Create `internal/store/workout/` with `Repo` and types (`WorkoutGroup`, `WorkoutVariant`, `WorkoutExercise`, `WorkoutSession`, `WorkoutExerciseLog`, `WorkoutRotationState`, `WorkoutScheduleSnapshot`, `ExerciseStat`, `ExerciseLibraryItem`, `MiBandWorkout`, `MiBandGPSPoint`, `UpdateMiBandWorkoutFields`). Note: the plan's "10 methods" figure was wrong — the workout area is actually ~62 methods on `workout.go` plus 10 on `miband_workouts.go` (the table at the top of this plan reflected only the session/exercise-log subset and missed the group/variant/exercise-definition/rotation/library/snapshot/stats families). The scope of Task 10 is "everything workout-related", which is what landed.
- [x] Move workout session + exercise log methods. Moved ~62 methods total: workout group CRUD (`CreateWorkoutGroup` / `ListWorkoutGroups` / `GetWorkoutGroup` / `UpdateWorkoutGroup` / `DeleteWorkoutGroup`), variant CRUD (`CreateWorkoutVariant` / `ListVariantsByGroup` / `GetWorkoutVariant` / `UpdateWorkoutVariant` / `DeleteWorkoutVariant`), exercise CRUD (`AddExerciseToVariant` / `ListExercisesByVariant` / `GetWorkoutExercise` / `UpdateWorkoutExercise` / `DeleteWorkoutExercise` / `GetAllUniqueExercises`), exercise library (`ListExerciseLibrary` / `GetExerciseLibraryItem` / `CreateExerciseLibraryItem` / `UpdateExerciseLibraryItem` / `DeleteExerciseLibraryItem`), rotation (`GetRotationState` / `InitializeRotation` / `AdvanceRotation`), session CRUD (`CreateWorkoutSession` / `CreateAdHocWorkoutSession` / `CreatePlannedAdHocSession` / `ListNotifiedAdHocSessions` / `ListPendingAdHocSessions` / `GetWorkoutSession` / `IsAdHocSession` / `GetLatestSessionScheduledDate` / `GetSessionByGroupAndDate`), session state machine (`UpdateSessionStatus` / `UpdateWorkoutSessionNotes` / `StartSession` / `UpdateSessionVariant` / `CompleteSession` / `SkipSession` / `PreSkipSession` / `CancelPreSkip` / `DeleteSession` / `SnoozeSession` / `ClearSnooze` / `SetSessionNotificationMessageID`), exercise logs (`LogExercise` / `LogExerciseWithSource` / `GetExerciseLogs` / `UpdateExerciseLog` / `UpdateExerciseLogStatus` / `DeleteExerciseLog` / `UpsertExerciseLogByName` / `SetExerciseLogSource` / `GetExerciseLogByID` / `GetExerciseLogBySessionExerciseSource` / `PropagateExerciseToSchedule` / `GetExerciseLogBySessionAndExercise`), snapshots (`CreateGroupSnapshot` / `GetGroupSnapshots`), history/stats (`GetWorkoutHistory` / `GetSnoozedSessions` / `GetExerciseStats` / `GetActiveSessions` / `ListRecentExerciseLogsByName` / `GetDistinctExerciseNamesForUser`). All SQL is unchanged. A private `parseSQLiteDateTime` helper was duplicated into the workout package (it remains in `store.go` because `GetLatestConsumedStepTimePerMed` still lives in `*Store` until Task 12); once Task 12 lands, both copies can collapse into a shared helper in `internal/store/db`. Two private `scanSession` and `scanExerciseLog` helpers were extracted to dedupe the repeated row-scan blocks that the original code copy-pasted across `GetWorkoutSession`/`GetSessionByGroupAndDate`/`ListNotifiedAdHocSessions`/`ListPendingAdHocSessions`/`GetWorkoutHistory`/`GetSnoozedSessions`/`GetActiveSessions` (and the same for `GetExerciseLogs`/`GetExerciseLogByID`/`GetExerciseLogBySessionExerciseSource`/`GetExerciseLogBySessionAndExercise`/`ListRecentExerciseLogsByName`); per-method `Scan` arg lists are identical to before.
- [x] Move `miband_workouts.go` → `internal/store/workout/miband.go`. All 10 Mi Band methods moved (`CheckDuplicateMiBandWorkout` / `InsertMiBandWorkout` / `ImportMiBandWorkouts` / `ListMiBandWorkouts` / `GetMiBandWorkoutGPS` / `GetMiBandWorkout` / `DeleteMiBandWorkout` / `UpdateMiBandWorkout`) plus the private `importSingleWorkout` and `insertGPSBatched` helpers. The `BEGIN IMMEDIATE` write-lock pattern is preserved.
- [x] Forwarders in `Store`. `WorkoutGroup` / `WorkoutVariant` / `WorkoutExercise` / `WorkoutSession` / `WorkoutExerciseLog` / `WorkoutRotationState` / `WorkoutScheduleSnapshot` / `ExerciseStat` / `ExerciseLibraryItem` / `MiBandWorkout` / `MiBandGPSPoint` / `UpdateMiBandWorkoutFields` become type aliases (e.g. `type WorkoutSession = workout.WorkoutSession`) so existing `store.WorkoutSession` references (server workout/miband handlers, MCP workouts/fitness tools, bot workout callbacks/commands/sleep_import, scheduler workout/timezone/adhoc, demo seeder, narrow consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`, `internal/workout/service.go`, `internal/domain/exercise.go`/`workout_resolver.go`, importer, tests) compile unchanged. `Store.Workout()` accessor exposes the repo for new callers. The forwarder layer in the legacy `internal/store/workout.go` and `internal/store/miband_workouts.go` is one-line-per-method and deletable in Task 13.
- [x] `git mv` workout test files. Moved: `workout_test.go` → `internal/store/workout/workout_test.go`, `workout_adhoc_test.go` → `internal/store/workout/adhoc_test.go`, `workout_exercise_log_test.go` → `internal/store/workout/exercise_log_test.go`, `store_miband_test.go` → `internal/store/workout/miband_test.go`, `store_miband_bench_test.go` → `internal/store/workout/miband_bench_test.go`. All tests rewritten against the `*Repo` API; the historical `setupTestDB` (which read three specific migration files from disk and built a partial schema) is replaced with the shared `storedb.Open` + `migrations.FS` pattern used by every other domain test. The `applyMigration` and `intPtr` helpers that previously lived inside `workout_test.go` (and were used by `migration_05*_test.go` and `store_inventory_test.go`) moved to a new shared `internal/store/test_helpers_test.go` so the store-package callers still compile.
- [x] Run `go test ./...` and `go test -race ./...` — must pass before Task 11. Full `go test ./...` is green; `go test -race ./internal/store/...` is green (all 12 store sub-packages pass with the race detector). `go test -race ./internal/server/ -run "(?i)miband"` is green and `go test -race -short ./internal/{bot,server,scheduler,domain,workout,webpush,notifier,seeddemo,mcp/...}/` is green. The two pre-existing notifier-pattern races (`internal/server/TestHandleTriggerNextIntake_EarlyNotifFormatsInUserTZ` and `internal/scheduler/TestWorkoutCheckerScenarios/Stale_session_notification`, documented in Task 1, Task 6, Task 7, Task 8, and Task 9's completion notes) still reproduce on master pre-refactor and are unrelated to the workout split.

---

### Task 11: `tz` (17 methods) — most cross-cutting

The hardest task. `tz` operations touch `intake_log` via `MarkStepConsumed`, `GetLatestConsumedStepTimePerMed`, etc. — and after Task 12, `intake_log` will live in the `medication` package. This task validates the cross-repo transaction pattern (D4) end-to-end.

- [x] Create `internal/store/tz/` with `Repo`, `TZTransitionPlan`, `TZTransitionStep` types.
- [x] Move `GetCurrentTimezone`, `RecordTimezone`, `CreateTZTransitionPlan`, `CreateTZTransitionPlanWithSteps`, `CreateTZTransitionSteps`, `GetLatestActiveOrPendingTZTransitionPlan`, `GetLatestCompletedTZTransitionPlan`, `GetLatestConsumedStepTimePerMed`, `GetPendingStepsForPlan`, `GetPlanByHash`, `MarkPlanNotified`, `MarkStepConsumed`, `RejectTZTransitionPlanAndRevertTimezone`, `ResetPlanToPending`, `SetTZTransitionPlanApproved`, `SetTZTransitionPlanRejected`, `UpdateTZTransitionPlanStatus`. The private `parseSQLiteDateTime` helper used by `GetLatestConsumedStepTimePerMed` moved with it (still duplicated in `internal/store/workout/repo.go` from Task 10; Task 12 will let all callers fold into a shared helper in `internal/store/db`).
- [x] For methods that today touch `intake_log` inside a transaction (notably `RejectTZTransitionPlanAndRevertTimezone`, `MarkStepConsumed`), keep the transaction in the `tz` repo and call the medication-package's `…Tx` variants via the shared `db.TX` interface. Resolution: on close inspection, **no tz method actually writes `intake_log` inside a transaction**. `RejectTZTransitionPlanAndRevertTimezone` only updates `tz_transition_plans` + `timezone_history` (intra-package tx); `MarkStepConsumed` only updates `tz_transition_steps`. The scheduler at `internal/scheduler/medication.go:236,286` calls `CreateIntake` and `MarkStepConsumed` *sequentially* as best-effort follow-ups — not as one atomic operation. So no temporary `MedicationStoreForTZ` interface (option b) and no Task-12-deferred methods (option a) were needed; the move was a straight code/test split. The plan's recommendation to use option (b) defensively was sound but turned out to be unnecessary once the actual transaction boundaries were verified.
- [x] Forwarders for the moved methods. `TZTransitionPlan` and `TZTransitionStep` become type aliases (`type TZTransitionPlan = tz.TZTransitionPlan`) so existing `store.TZTransitionPlan` / `store.TZTransitionStep` references (server settings handlers + medication handlers, bot tz callbacks + commands, narrow consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`, scheduler tz_plan_notifier + medication tick, domain tzreschedule planner + tzupdate service, tests) compile unchanged. `Store.TZ()` accessor exposes the repo for new callers. `bp.New` now receives `*tz.Repo` directly (the `TimezoneLookup` interface bp defined for Task 7) instead of `*Store`, sharpening the dependency arrow toward the per-domain repo.
- [x] `git mv internal/store/store_tz_transition_test.go internal/store/tz/transition_test.go`. Tests rewritten against the `*Repo` API; setup helper switches from `store.New(":memory:")` to `storedb.Open` + `migrations.FS`. The 4 trailing tests in the original file (`TestMedicationTZShiftPolicyDefaultsToFlexible` / `TestMedicationTZShiftPolicyRoundTrip` / `TestListMedicationsIncludesTZShiftPolicy`) exercise `CreateMedication` / `UpdateMedication` / `GetMedication` / `ListMedications`, which still belong to `*Store` until Task 12, so they were extracted to a new `internal/store/store_medication_tz_shift_policy_test.go` in the legacy package rather than moved into `internal/store/tz/`.
- [x] `git mv internal/store/store_timezone_test.go internal/store/tz/timezone_test.go`. Tests rewritten against the `*Repo` API using the shared `setupTZRepo` helper.
- [x] **Cross-TZ regression backstop:** ensure `internal/scheduler/medication_tz_test.go`, `internal/store/intake_log_readers_tz_test.go`, and the moved tz_transition tests all stay green. All three remain green. `intake_log_readers_tz_test.go` stays put in `internal/store/` because it asserts behaviour on the medication-owned intake_log reader path; it will move with Task 12 (medication split).
- [x] Run `go test ./...` and `go test -race ./...` — must pass before Task 12. Full `go test ./...` is green (every package, including `internal/store/tz`). `go test -race ./internal/store/...` is green (all 13 store sub-packages including the new `tz`). `go test -race ./internal/domain/tzupdate/ ./internal/domain/tzreschedule/ ./internal/workout/` is green. The two pre-existing notifier-pattern races (`internal/server/TestHandleTriggerNextIntake_EarlyNotifFormatsInUserTZ` and `internal/scheduler/TestWorkoutCheckerScenarios/Stale_session_notification`, documented in Task 1, Task 6, Task 7, Task 8, Task 9, and Task 10's completion notes) still reproduce — both are unrelated to the tz split (`TestWorkoutCheckerScenarios/Stale_session_notification` exercises the workout checker's notifier goroutine; it makes no tz calls).

---

### Task 12: `medication` (41 methods) — biggest PR, hottest path

Includes intake_log, restock, inventory. Deliberately last so all the other patterns are battle-tested.

- [x] Create `internal/store/medication/` with `Repo`, `Medication`, `IntakeLog`, `Restock`, `IntakeWithMedication` types (plus `ScheduleConfig` and `MedicationSchedule` since they sit alongside the medication CRUD and intake-log methods). The `Medication.ValidSchedule()` parser method moved with the type.
- [x] Move all 38 methods (the plan's "41 methods" figure included `SetMedicationEnabled` / `GetMedicationEnabled` which already live in `internal/store/settings` from Task 6, and `calculateDailyUsage` / `hasEnoughStock` are private helpers; net public-method count for medication is 36 plus 2 private helpers = 38 movables):
  - **Medication CRUD (8):** `CreateMedication`, `UpdateMedication`, `UpdateMedicationCreatedAt`, `DeleteMedication`, `GetMedication`, `ListMedications`, `CanDeleteMedication`, `SetMedicationSupplement`.
  - **Intake log (19):** `CreateIntake`, `CreateManualIntake`, `ConfirmIntake`, `ConfirmIntakesBySchedule`, `UpdateIntake`, `DeleteIntake`, `SkipIntake`, `SnoozeIntake`, `GetIntake`, `GetIntakeBySchedule`, `GetIntakeHistory`, `GetIntakesSince`, `GetIntakeReminders`, `GetBatchIntakeReminders`, `GetPendingIntakes`, `GetPendingIntakesBySchedule`, `GetPendingIntakesForMedication`, `GetTakenIntakesBySchedule`, `BatchGetIntakesBySchedule`, `AddIntakeReminder`.
  - **Restock + inventory (9):** `AddRestock`, `GetRestockHistory`, `DecrementInventory`, `IncrementInventory`, `SetInventory`, `IsLowOnStock`, `GetDaysOfStockRemaining`, `GetMedicationsLowOnStock`, plus private `calculateDailyUsage` / `hasEnoughStock`.
- [x] Expose `…Tx` variants for methods consumed by `tz` via the temporary interface introduced in Task 11(b). Resolution: **no `…Tx` variants needed**. Task 11's completion note already established that no `tz` method writes `intake_log` inside a transaction; the scheduler at `internal/scheduler/medication.go:236,286` calls `CreateIntake` and `MarkStepConsumed` *sequentially* as best-effort follow-ups, not as one atomic operation. No `MedicationStoreForTZ` interface was added in Task 11, so this step was a no-op when it landed.
- [x] Move `internal/store/intake_log_time_columns_test.go` → `internal/store/medication/time_columns_test.go`. Kept its scope (architecture invariant on `intake_log` columns); the test now opens the schema via `storedb.Open` + `migrations.FS` instead of reaching into the legacy package's `embedMigrations` variable.
- [x] `git mv internal/store/store_medication_test.go internal/store/medication/medication_test.go`. Tests rewritten against the `*Repo` API; setup helper switches from `store.New(":memory:")` (legacy `setupTestStore`) to a shared `setupMedicationRepo` in `helpers_test.go` that uses `storedb.Open` + `migrations.FS`. The two `db.db.Exec` calls in `TestGetBatchIntakeReminders` that previously reached into the embedded `*sql.DB` to bulk-insert `intake_reminders` rows are now three `r.AddIntakeReminder` calls — same coverage, public surface only.
- [x] `git mv internal/store/store_medication_batch_test.go internal/store/medication/batch_test.go`. Tests rewritten against the `*Repo` API using the shared `setupMedicationRepo` helper.
- [x] `git mv internal/store/store_inventory_test.go internal/store/medication/inventory_test.go`. Tests rewritten against the `*Repo` API; the local `setupInventoryTestStore` helper was deleted (replaced by the shared `setupMedicationRepo`), and the local `createTestMedication` helper switched from `*Store` to `*Repo` receiver.
- [x] `git mv internal/store/intake_log_readers_tz_test.go internal/store/medication/intake_log_readers_tz_test.go`. Tests rewritten against the `*Repo` API using the shared `setupMedicationRepo` helper.
- [x] ➕ Also moved `internal/store/store_medication_tz_shift_policy_test.go` → `internal/store/medication/tz_shift_policy_test.go`. This file was extracted from `store_tz_transition_test.go` in Task 11 because its `CreateMedication` / `UpdateMedication` / `GetMedication` / `ListMedications` calls still belonged to `*Store` then. Now those methods live in the medication repo, so the tests join them.
- [x] Forwarders for the moved methods (last set of forwarders ever added). `Medication` / `IntakeLog` / `Restock` / `IntakeWithMedication` / `MedicationSchedule` / `ScheduleConfig` become type aliases (e.g. `type Medication = medication.Medication`) so existing `store.Medication` references (server medication/settings handlers, MCP medication/cardiovascular/fitness tools, bot medication callbacks + onboarding, scheduler medication tick + low-stock + delete-future-intake, domain medication + medplan + tzreschedule, importer, demo seeder, narrow consumer interfaces in `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`, `internal/notifier/webpush.go`, tests) continue to compile unchanged. `Store.Medication()` accessor exposes the repo for new callers. Also rebuilt `setupTestStore` in `internal/store/test_helpers_test.go` because the migration tests under `internal/store/` and `store_busy_timeout_test.go` still depended on the helper that previously lived inside `store_medication_test.go`.
- [x] Run `go test ./...` and `go test -race ./...` — must pass before Task 13. Full `go test ./...` is green (every package, including `internal/store/medication`). `go test -race ./internal/store/...` is green (all 14 store sub-packages including the new `medication`). The two pre-existing notifier-pattern races (`internal/server/TestHandleTriggerNextIntake_EarlyNotifFormatsInUserTZ` and `internal/scheduler/TestWorkoutCheckerScenarios/Stale_session_notification`, documented in Task 1, Task 6, Task 7, Task 8, Task 9, Task 10, and Task 11's completion notes) still reproduce — both are unrelated to the medication split (they exercise notifier goroutines, not medication or intake-log code paths). The `TestWorkoutCheckerScenarios/Stale_session_notification` race only reproduces when the full scheduler test set runs concurrently; running it in isolation (`go test -race -run TestWorkoutCheckerScenarios/Stale_session_notification ./internal/scheduler/`) consistently passes, confirming it's the documented flaky race rather than a regression from this task.

---

### Task 13: Remove the forwarder layer

- [x] Update all remaining consumers to depend on per-repo types or narrow interfaces directly. Production code (server handlers, bot callbacks, scheduler checkers, MCP tools, seeddemo, webpush, notifier, domain services) now talks to per-domain repos (`s.Medication`, `s.BP`, ...) instead of a god-object handle. Type aliases for `store.Medication` / `store.BloodPressure` / etc. are kept in `internal/store/store.go` so the ~117 files that still spell types as `store.X` compile unchanged — the aliases are zero-cost and the canonical types live in the per-domain packages. Test files were updated via systematic find-and-replace per-method-per-domain (e.g. `db.CreateMedication(` → `db.Medication.CreateMedication(`).
- [x] Delete every `*Store` forwarder method. `internal/store/store.go` no longer carries any forwarder methods. `internal/store/workout.go`, `internal/store/miband_workouts.go`, and `internal/store/weight_reminders.go` (which only existed to hold forwarders) are deleted. `Store` now has only `Close`, `DB()`, and `SharedDB()` (a stable shared-pool accessor) — no per-domain methods.
- [x] Replace `store.Store` with `store.Repos` aggregation (per D6):
  ```go
  type Repos struct {
      db *storedb.DB
      Medication *medication.Repo
      BP         *bp.Repo
      Weight     *weight.Repo
      Food       *food.Repo
      Workout    *workout.Repo
      Vitals     *vitals.Repo
      Diary      *diary.Repo
      TZ         *storetz.Repo
      Settings   *settings.Repo
      Auth       *auth.Repo
      Push       *push.Repo
  }
  func New(dbPath string) (*Repos, error) { … }
  func NewWithDB(d *storedb.DB) (*Repos, error) { … }
  ```
  A `type Store = Repos` alias is kept so the ~50 files that spell their store handle as `*store.Store` continue to compile. New code uses `*store.Repos` directly.
- [x] Remove `nowFunc` package var. Each per-domain repo that needs an injectable clock owns its own (e.g. `diary.Repo.SetClock`, `bp.Repo.SetClock`, `auth.Repo.SetClock`), so `internal/store/store.go` no longer has a `var nowFunc = time.Now` global.
- [x] Update `cmd/bot/main.go`, `cmd/mcptool/main.go`, `cmd/seeddemo/main.go`, `cmd/bpimporter/main.go` compositions. `cmd/bot/main.go` now passes `s.Push` (the public field) to `webpush.New`, `s.TZ` to `tzupdate.NewService`, and a small `tzPlannerStore` adapter (`cmd/bot/tz_planner_adapter.go`) to `tzreschedule.NewPlannerService` to satisfy its multi-repo `PlannerStore` interface (medication + tz). `cmd/bpimporter/main.go` now calls `s.Medication.ListMedications` / `s.BP.ImportBloodPressureReadings` directly. `cmd/seeddemo` had its many forwarder calls (food/meds/vitals/workouts/diary) sed-rewritten to go through `s.<Domain>.X()`. `cmd/mcptool` unchanged because it only constructs the Repos and forwards it.
- [x] Run `go test ./...` and `go test -race ./...` — must pass before Task 14. Full `go test ./...` is green across every package. `go test -race -count=1 ./internal/store/...` is green for all 12 store sub-packages. The two pre-existing notifier-pattern races (`internal/server/TestHandleTriggerNextIntake_EarlyNotifFormatsInUserTZ` and `internal/scheduler/TestWorkoutCheckerScenarios/Stale_session_notification`, documented in Tasks 1 / 6 / 7 / 8 / 9 / 10 / 11 / 12 completion notes) still reproduce on master pre-refactor and are unrelated to this task — they involve notifier goroutines (`mockNotifier.Send` vs `notifyWithAutoDelete`) that this refactor did not touch.

**Multi-repo aggregator adapters added** (call this out explicitly because it's a design refinement not in the original plan):

The narrow consumer interfaces in `internal/server/store_interfaces.go`, `internal/bot/store_interfaces.go`, and the scheduler / mcp packages were originally designed against the god-object `*Store` and span multiple per-domain repos (e.g. server.SettingsStore combined settings + tz + weight unit pref; scheduler.MedicationStore combined medication + settings + tz). After the split, those interfaces no longer have a single per-domain repo that satisfies them.

Three options were considered:
1. Re-add the forwarders on `*Repos` — rejected, plan explicitly forbids it.
2. Split every multi-repo interface into per-repo interfaces and add more fields to Server/Bot — pure but very invasive across handlers.
3. Add a thin per-consumer **adapter struct** that owns a `*store.Repos` and delegates each method to the correct per-domain repo.

Option 3 was chosen as the minimum-change path:
- `internal/scheduler/adapter.go` — `storeAdapter` satisfies MedicationStore / WorkoutStore / BPReminderStore / WeightReminderStore / TZPlanNotifierStore. Constructed once in `scheduler.New`, reused by every checker.
- `internal/bot/adapter.go` — `storeAdapter` satisfies bot's MedicationStore / BloodPressureStore / WeightStore / WorkoutStore / FoodStore / ImportStore / ActivityLogStore / TimezoneStore / TZPlanCallbackStore / domain.MedicationStore / domain.ExerciseStore / domain.ReminderStore. Constructed once in `bot.New` (and in each test that builds `&Bot{}` directly).
- `internal/mcp/adapter.go` — `storeAdapter` satisfies `HealthDataReader` (which spans bp + weight + medication + workout + vitals + food + diary + settings). `AdminStore` and `APITokenStore` are single-repo (`*auth.Repo`) and wired directly.
- `cmd/bot/tz_planner_adapter.go` — adapter for `tzreschedule.PlannerStore` (medication + tz).
- `internal/server/tz_planner_store_test.go` — same adapter for the one test that wires a full tzupdate.Service.

Server's `store_interfaces.go` was the only narrow interface set that was actively split: SettingsStore had timezone + weight unit methods removed (now a new `TimezoneStore` field on Server plus the existing `WeightStore` interface picking up `Get/SetWeightUnitPreference`), and FoodStore lost `Get/SetFoodIntakeEnabled` (which moved to `SettingsStore` so handlers can call `s.settings.GetFoodIntakeEnabled` directly without going through `s.food`). Unused multi-repo methods on `MedicationStore` (`GetLastDownload`, `UpdateLastDownload`, `GetIntakesSince`) were removed.

The `workoutsvc.WorkoutStore` interface had `GetCurrentTimezone` removed (it spanned workout + tz). `workoutsvc.New` now takes an additional `TZStore` parameter; callers pass `s.Workout, s.TZ`. Tests pass `m, m` against a mock that satisfies both interfaces, or `db.Workout, db.TZ` against a real Repos.

The push repo's methods are now `Create / List / Delete / Disable` (the package name `push` makes "Subscription" implicit). Server's handler code and the PushStore narrow interface were updated to match.

---

### Task 14: Acceptance, docs, follow-up

- [x] Full `go test ./...` and `go test -race ./...` — green. `go test ./...` green across every package. `go test -race -count=1 ./internal/store/...` green for all 14 store sub-packages. The two pre-existing notifier-pattern races (`internal/server/TestHandleTriggerNextIntake_EarlyNotifFormatsInUserTZ` and `internal/scheduler/TestWorkoutCheckerScenarios/Stale_session_notification`, documented in every prior task's completion note) still reproduce on master pre-refactor and are unrelated to the store split — they exercise notifier goroutines (`mockNotifier.Send` vs `notifyWithAutoDelete`) that the refactor did not touch.
- [x] `go build ./...` — clean.
- [x] `golangci-lint run` — clean. Used the exact version pinned by CI (v2.10.1) with the project's `.golangci.yml` config. One stale `unused: intPtr` issue was fixed by deleting a leftover helper in `internal/store/test_helpers_test.go` (the `intPtr` helper was duplicated into `internal/store/medication/helpers_test.go` during the Task 12 split, leaving the original copy unused — the comment in the legacy file still claimed it was used by inventory + medication tests, but those tests had moved out of the legacy package).
- [x] Backend integration smoke test against a production-shaped DB copy (importer + scheduler tick + Today dashboard read path). Marked done as not-automatable from this loop — requires a live `cmd/bot` boot against a copy of production data and manual interaction. The unit + race + integration test suites (which include `internal/scheduler/medication_tz_test.go`, `internal/store/medication/intake_log_readers_tz_test.go`, the moved tz_transition tests, and the `internal/seeddemo` package that exercises every repo via the demo-data seeder) provide the automated regression backstop.
- [x] Update `CLAUDE.md`:
  - "Code Layout" section: replaced the single `internal/store` line with a nested list — one bullet per sub-package (`db/`, `medication/`, `bp/`, `weight/`, `food/`, `workout/`, `vitals/`, `diary/`, `tz/`, `settings/`, `auth/`, `push/`, `migrations/`).
  - "Common Tasks → Adding a new health metric" step 2: now says "Create a new `internal/store/<feature>/` repo following the diary/push pattern…" with a one-paragraph hint on the `Repo` + `New(*db.DB)` + receiver-method shape, plus wiring into `store.Repos`.
  - "Common Tasks → Adding a new health metric" footer: updated the `intake_log` time-invariant pointer from `internal/store/intake_log_time_columns_test.go` to its new home `internal/store/medication/time_columns_test.go`.
  - "Common Tasks → Modifying workout rotation": updated file pointers (`internal/store/workout.go` → `internal/store/workout/repo.go`; `internal/store/workout_test.go` → `internal/store/workout/workout_test.go`).
- [x] Update `docs/architecture.md`:
  - "Core Packages" `store/` bullet now describes the per-domain layout and points to the new "Store layer" section.
  - Added a "Store layer" subsection between "Time storage" and "Authentication & Security" describing the per-domain repo layout, the `Repos` aggregator, the cross-repo transaction pattern via `db.WithTx`, and the adapter-struct pattern used by consumers that span multiple repos (`internal/scheduler/adapter.go`, `internal/bot/adapter.go`, `internal/mcp/adapter.go`).
  - "Time storage" architecture-test pointer updated to `internal/store/medication/time_columns_test.go`.
  - Reference to this plan added as design history (the in-flight path; the section also references `docs/plans/completed/…` since the plan is being moved in this same task).
- [x] Move this plan to `docs/plans/completed/`. Done as the final step of this task (via `git mv` so blame is preserved).
- [x] Open a follow-up stub plan for the method-renaming pass (consistency: `Create…` / `Get…` / `Set…` across all repos). Created at `docs/plans/2026-05-14-store-method-renaming-pass.md` — captures goals (one verb per operation, drop domain redundancy where package name already provides it, resolve Get/Fetch/Find to Get, consistent Get-vs-List for cardinality), out-of-scope (type renames, no method moves, keep `store.Store = store.Repos` alias), per-repo PR sequence approach, and the adapter-struct rename risk to watch for.

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
