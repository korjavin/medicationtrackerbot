# Architecture

## System Components

```
User
├── Chat Interface (Telegram) → Bot Logic → SQLite
└── Web Frontend (Mini App) → HTTP Server → SQLite
                                ↓
                            Scheduler (notifications)
```

## Code Structure

**Entry Points** (`cmd/`):
- `bot/` — main application (bot + web server + scheduler)
- `mcptool/` — MCP server for AI integration (read-only health data access)
- `importer/` — Apple Health medication import
- `bpimporter/` — Blood pressure CSV import
- `genvapid/` — VAPID key generator for web push

**Core Packages** (`internal/`):
- `ai/` — AI client integration (OpenAI-compatible)
- `store/` — database layer. Per-domain repositories under sub-packages (`medication/`, `bp/`, `weight/`, `food/`, `workout/`, `vitals/`, `diary/`, `tz/`, `settings/`, `auth/`, `push/`), with shared infra in `store/db/` (connection, migrations runner, `WithTx`). `store.Repos` is the aggregator. See [Store layer](#store-layer).
- `server/` — HTTP handlers for REST API
- `bot/` — Telegram bot logic (commands, callbacks, notifications) — thin channel layer only
- `domain/` — business logic services: `medication.go`, `exercise.go`, `reminder.go`, `food.go`, `food_ai.go`
- `workout/` — workout session management service (`service.go`)
- `scheduler/` — notification scheduling (medications, workouts, BP/weight reminders)
- `mcp/` — Model Context Protocol server implementation
- `rxnorm/` — drug interaction checking via NLM API
- `webpush/` — web push notification support
- `tzlookup/` — geo-to-timezone reverse lookup via `github.com/ringsaturn/tzf`. `LookupTimezone(lat, lng)` initialized lazily with `sync.Once`; timezone boundary data embedded in binary (~5 MB), no external API calls.

## Database Schema

SQLite with 47+ goose migrations tracking schema evolution:

- `medications`, `intake_log` — medication management and history
- `blood_pressure_readings` — BP tracking
- `weight_logs` — weight tracking with trend calculation
- `workout_groups`, `workout_variants`, `workout_exercises` — hierarchical workout structure
- `workout_sessions`, `workout_exercise_logs` — workout history
- `workout_rotation_state` — rotating workout schedules
- `sleep_logs` — sleep tracking
- `food_log`, `food_products`, `food_targets` — food intake and nutrition tracking. Supports multi-item "Meals" (templates with aggregated macros and serving size).
- `push_subscriptions` — web push subscriptions
- `bp_reminders`, `weight_reminders` — reminder configuration
- `change_events` — server-side change tracking for frontend cache invalidation
- `diary_notes` — free-text personal diary notes with timestamps
- `timezone_history` — per-user timezone history (most recent row is the active timezone). Overrides `TZ` env var for all schedulers including medications. When no timezone is recorded, falls back to `time.Local`.
- `tz_transition_plans` — timezone transition plans (status: PENDING_APPROVAL / NOTIFIED / APPROVED / REJECTED / CANCELLED / EXPIRED). Generated when the stored timezone changes. Must be approved via Telegram before taking effect. Stores a SHA-256 `plan_hash` for idempotency, full `inputs_json` for reproducibility, and `steps_json` (the planner's serialized `[]tzreschedule.TransitionStep`) which is both the approve-banner audit blob and the input to step materialization. See [Pre-materialized TZ transition steps](#pre-materialized-tz-transition-steps).
- (Historical: a sibling `tz_transition_steps` table held one row per dose step. Migration 069 dropped it after Track D of `docs/plans/20260508-simplify-medication-scheduling-utc-and-pre-materialized-steps.md` collapsed the parallel state machine into `intake_log` rows with `source='tz_step'`.)

### Migrations

- Located in `internal/store/migrations/`, numbered sequentially
- Use goose for migration management
- Migrations auto-run on store initialization
- Never modify existing migrations; create new ones

#### Go migrations

Goose supports `.go` migrations alongside `.sql`. The project was SQL-only until **migration 068** (`068_backfill_pre_materialized_tz_steps.go`, Track D Task 10), which needed to read `ALLOWED_USER_ID` from the environment at migration time — something SQL migrations cannot do — to attribute pre-materialized `intake_log` rows to the operator's Telegram ID.

Pattern for future Go migrations:

1. Place the file in `internal/store/migrations/0NN_<name>.go` with `package migrations`. Goose extracts the version from the filename's numeric prefix.
2. Register from `init()` via `goose.AddMigrationContext(upXxx, downXxx)`. Goose merges the registered Go migrations with the SQL migrations from the embedded FS by version number.
3. Make the migration **safe on empty schemas** — short-circuit the env-var check (or any other side input) when there's nothing to migrate. Otherwise per-domain test fixtures that don't set the env var will fail.
4. The `Up` body receives `(context.Context, *sql.Tx)`; the surrounding tx is committed by goose on a nil return.
5. Production picks up the registered Go migration because `internal/store/store.go` carries a blank import of `internal/store/migrations` for side effects (the SQL migrations are still embedded directly via `//go:embed migrations/*.sql`; the blank import is solely to ensure the Go-migration `init()` runs).

### Time storage

**Rule:** dose-related time columns are stored as `INTEGER` unix-seconds-UTC, not as SQLite `DATETIME` text. The full audit-anchor allowlist (also documented in the package comment at the top of `internal/store/store.go`):

- `intake_log.scheduled_at_unix` (NOT NULL)
- `intake_log.taken_at_unix` (nullable)
- `intake_log.snoozed_until_unix` (nullable)
- `tz_transition_plans.created_at_unix` (NOT NULL, defaulted to `strftime('%s','now')`)
- `tz_transition_plans.notified_at_unix` (nullable)
- `tz_transition_plans.approved_at_unix` (nullable)

The architecture test `TestDoseTimeColumnsAreInteger` in `internal/store/store_time_invariants_test.go` parses `PRAGMA table_info(<table>)` for each table above and fails CI if any allowlisted column regresses to a text-typed column, or if a legacy `scheduled_at` / `taken_at` / `snoozed_until` / `created_at` / `notified_at` / `approved_at` text column reappears. A per-table check for `intake_log` also lives in `internal/store/medication/time_columns_test.go` (kept for the dose-time invariant the medication package owns). Non-dose `DATETIME` columns (workouts, BP, weight, sleep) are deliberately untouched — the test has no opinion about them.

**Why:** `modernc.org/sqlite` serializes `time.Time` via `t.String()`, which embeds the timezone *name* (e.g. `"2026-05-10 08:20:00 -0700 PDT"`). SQL text-equality (`WHERE scheduled_at = ?`) on such strings depends on the caller's `time.Location` and breaks whenever the user (or the scheduler) compares the same UTC instant across a TZ-name change — even when the *offset* is unchanged (PDT→MST). On 2026-05-10 this produced a duplicate set of pending intakes after a California→Phoenix flight and an hourly reminder storm. Storing unix seconds normalizes the value at the write boundary; SQL equality on `INTEGER` is then unambiguous regardless of caller `time.Location`.

**Write path:** every writer normalizes via `t.UTC().Unix()` (or `storedb.TimeToUnix`). `.UTC()` also strips Go's monotonic-clock residue, which has previously leaked through `t.String()` into other tables.

**Read path:** `Scan(&n int64)` then `time.Unix(n, 0).UTC()` (or `storedb.UnixToTime`). Nullable columns scan into `sql.NullInt64` and use `storedb.NullableUnixToTimePtr` to populate `*time.Time` pointer fields only when valid.

**Design history:** see `docs/plans/2026-05-10-intake-log-utc-unix-fix.md` (the `intake_log` rollout shipped after a production incident) and `docs/plans/20260508-simplify-medication-scheduling-utc-and-pre-materialized-steps.md` (Track A — extended the convention to `tz_transition_plans` lifecycle timestamps in Task 7).

## Store layer

`internal/store` is split into one Go package per domain. The single 3.3k-line god-object `Store` was replaced with per-feature repositories during the 2026-05 store-split refactor (see `docs/plans/completed/2026-05-13-split-store-package.md`).

### Layout

```
internal/store/
├── db/            shared infra: Open(), *sql.DB wrapper, busy-timeout config,
│                  WithTx cross-repo transaction helper, goose migrations runner,
│                  unix-seconds time helpers.
├── medication/    medication CRUD + intake_log + restock + inventory.
├── bp/            blood-pressure readings + reminder state + goal + stats.
├── weight/        weight logs + reminder state + goal + unit preference.
├── food/          food logs + products + targets + Open Food Facts client.
├── workout/       workout groups/variants/exercises/sessions/logs + mi-band.
├── vitals/        sleep_logs + day_stats + heart/spo2/stress vitals.
├── diary/         diary_notes.
├── tz/            timezone_history + tz_transition_plans (steps live as
│                  intake_log rows with source='tz_step' since Track D,
│                  migration 069).
├── settings/      per-feature toggles + tab order + change_events stream
│                  + download cursor.
├── auth/          api_tokens + used_login_hashes.
├── push/          push_subscriptions.
└── migrations/    embedded goose SQL files + tiny Go re-export so subpackage
                   tests can mount the schema.
```

Each per-domain package owns:
- A `Repo` struct that holds `*db.DB` and is constructed with `New(*db.DB) *Repo`.
- The domain types it returns (e.g. `medication.Medication`, `bp.BloodPressure`). Types live with their owner repo — there is no shared `types` package.
- Its own tests using `storedb.Open` + `migrations.FS`.

`store.Repos` (with a `type Store = Repos` alias for compatibility) is a thin aggregator wired in `cmd/bot/main.go`, `cmd/mcptool/main.go`, `cmd/seeddemo/main.go`, and `cmd/bpimporter/main.go`:

```go
type Repos struct {
    Medication *medication.Repo
    BP         *bp.Repo
    Weight     *weight.Repo
    // … one field per domain
}
```

Consumers (server handlers, bot callbacks, scheduler checkers, MCP tools, domain services) depend on narrow per-feature interfaces — see `internal/server/store_interfaces.go` and `internal/bot/store_interfaces.go`. Where a consumer interface combines methods from multiple repos (e.g. scheduler's `MedicationStore` spans medication + settings + tz), a small adapter struct in the consumer package owns a `*store.Repos` and routes each method to the correct sub-repo (`internal/scheduler/adapter.go`, `internal/bot/adapter.go`, `internal/mcp/adapter.go`).

### Cross-repo transactions

When a write needs to atomically touch tables owned by two different packages, callers use the shared `db.WithTx` helper plus the `db.TX` interface (satisfied by both `*sql.DB` and `*sql.Tx`). Each repo can expose `…Tx` variants of methods that participate in caller-owned transactions.

The first production user of this pattern is **`store.Repos.ApproveAndMaterialize`** (Track D Task 10): flipping a `tz_transition_plans` row to APPROVED and pre-materializing its remaining steps as PENDING `intake_log` rows must happen under one transaction so a crash between the two writes cannot leave the plan APPROVED with no rows to fire. The composition is:

- `tz.SetTZTransitionPlanApprovedTx(tx, planID, approvedAt)` — guarded UPDATE on `tz_transition_plans`.
- `medication.MaterializePlanStepsAsIntakesTx(tx, planID, allowedUserID)` — parses the plan's `steps_json` blob and `INSERT OR IGNORE`s one PENDING `source='tz_step'` row per step into `intake_log`, deduped via the partial unique index `idx_intake_log_tz_plan_step_unique` (migration 067). The `tz_transition_steps` sibling table is gone (migration 069); `steps_json` is the single input.

Both are called inside one `db.WithTx` opened by `Repos.ApproveAndMaterialize`. Every transport that approves a plan (HTTP `/api/tz-plan/{id}/approve`, the bot's `tz_plan_approve` callback, the scheduler's auto-approve safety net) routes through `tzreschedule.LifecycleService.Approve`, which wraps this single helper. That keeps CLAUDE.md rule #1 satisfied — no transport calls the bare `SetTZTransitionPlanApproved` primitive that misses the materialize step.

### Adding a new feature

See "Common Tasks → Adding a new health metric" in [CLAUDE.md](../CLAUDE.md). The short version: new migrations go in `internal/store/migrations/`; create a new `internal/store/<feature>/` package with a `Repo` + types + tests; wire it into `store.Repos`. Use the existing `diary/` and `push/` packages as the minimal reference shape.

## Authentication & Security

**Telegram Mini App**:
- Validates `Telegram.WebApp.initData` signature using HMAC-SHA256
- Extracts user_id and validates against `ALLOWED_USER_ID`
- initData sent in `Authorization` header

**Telegram Bot**:
- Checks `update.Message.From.ID` against `ALLOWED_USER_ID`
- Rejects unauthorized updates

**Telegram Login Widget**:
- Redirect mode (`data-auth-url`): widget redirects to `/auth/telegram/callback` with signed query params
- Server validates HMAC-SHA256 hash (SHA256(bot_token) as key), checks user, sets session cookie, redirects to `/`
- CSP includes `frame-src https://oauth.telegram.org`; no `unsafe-eval` required
- Frontend dynamically injects the widget script when `BOT_USERNAME` is available

**Optional Google OIDC**:
- For browser access outside Telegram
- Configured via `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ADMIN_EMAIL`

## Domain Service Pattern

The bot (`internal/bot/`) is a thin communication channel — it parses Telegram-specific data and sends/deletes messages. All business decisions live in `internal/domain/`:

- `domain/medication.go` — `MedicationService`: confirm/skip/cancel/log medication intakes, batch confirm a time slot. `LogMedicationNow(userID, medID)` delegates to `LogMedicationAt(userID, medID, takenAt)`; both Telegram `/log` and the web `POST /api/medications/log-past` handler (`handleLogPastIntake`) go through the service so manual-intake creation has a single code path.
- `domain/exercise.go` — `ExerciseService`: idempotent exercise log upsert, session completion check
- `domain/reminder.go` — `ReminderService`: snooze/block BP and weight reminders
- `domain/food.go` — food intake argument parsing and macro calculation

Each service follows the pattern from `internal/workout/service.go`:

```go
type FooStore interface { /* minimal store methods needed */ }
type FooService interface { /* domain operations */ }
type fooService struct { store FooStore }
func NewFooService(s FooStore) FooService { return &fooService{store: s} }
```

Bot struct fields: `medSvc domain.MedicationService`, `exerciseSvc domain.ExerciseService`, `reminderSvc domain.ReminderService`, `workoutSvc workoutsvc.WorkoutService`.

**Rule**: bot callbacks and web HTTP handlers may only call domain service methods (and Telegram / HTTP transport calls). No direct store calls for business decisions — keep both transports on the same code path so behavior cannot diverge.

## Scheduler Behavior

- Runs every minute (configurable ticker)
- Medication notifications: 15 min before due time (configurable)
- Workout notifications: configurable per group (default 15 min advance)
- Snooze logic: checks `snooze_until` timestamp
- Rotation advancement: happens on workout completion or skip

### Pre-materialized TZ transition steps

Track D of `docs/plans/20260508-simplify-medication-scheduling-utc-and-pre-materialized-steps.md`
collapsed the parallel `tz_transition_steps` table into `intake_log` rows.
When a `tz_transition_plan` is approved, the same transaction that flips
its `status` to APPROVED also pre-materializes every step from the plan's
`steps_json` blob as a PENDING `intake_log` row with `source='tz_step'`,
`tz_plan_id=plan.ID`, and `tz_step_number=step.StepNumber`. The plan-state
flip and the step inserts are atomic via `Repos.ApproveAndMaterialize` —
a crash between them cannot leave an APPROVED plan without rows to fire.

The scheduler then has **one input table**. On each tick `MedicationChecker.Check`:

1. Reads pre-materialized `source='tz_step'` rows due-now via
   `GetDueTZStepIntakes(asOf)` and merges them into the same per-target
   notification grouping the normal schedule populates — the pre-existing
   row's id is wired through to `intake_reminders` rather than creating a
   second intake.
2. Reads pending normal-schedule slots via the existing
   `BatchGetIntakesBySchedule` path, but before inserting a new
   `source='schedule'` row at instant T for med M asserts
   `HasIntakeNearScheduledTime(medID, T, minInterval)` is false. That
   symmetric `BETWEEN T-window AND T+window` predicate replaces the
   asymmetric "consumed step overlap guard" the legacy two-table
   implementation needed in `medplan.PlanDoses` and absorbs the
   second-level anchor drift between tz-plan steps (anchored on real
   `taken_at` timestamps) and the matching normal-schedule slot.
3. Marks the plan COMPLETED when `CountFuturePendingTZStepIntakesForPlan(planID, asOf) == 0`.

The forecast endpoint follows the same union shape:
`handleTriggerNextIntake` and `computeNextIntakeData` both union the
medplan-emitted targets with PENDING `intake_log` rows in the same 12h
window (`GetPendingIntakesInWindow`) and dedupe by
`(medication_id, scheduled_at_unix)` so a pre-materialized `tz_step` row
surfaces in the Today UI's next-intake preview even before the scheduler
tick that would fire it.

On plan cancel, `tzreschedule.CancelActivePlan` deletes the still-PENDING
`source='tz_step'` rows for the cancelled plan via
`medication.Repo.DeletePendingPreMaterializedIntakesForPlan` so the
scheduler doesn't keep firing them. Implementation:
`internal/scheduler/medication.go`, `internal/store/medication/repo.go`
(`MaterializePlanStepsAsIntakesTx`, `GetDueTZStepIntakes`,
`HasIntakeNearScheduledTime`, `CountFuturePendingTZStepIntakesForPlan`,
`DeletePendingPreMaterializedIntakesForPlan`), and
`internal/store/store.go` (`ApproveAndMaterialize`). Regression coverage
in `internal/scheduler/medication_tz_test.go`,
`internal/scheduler/dedup_equivalence_test.go`,
`internal/server/trigger_next_intake_test.go`, and
`internal/store/approve_and_materialize_test.go`.

### Cross-client change broadcast (SSE + polling fallback)

Writes that mutate one client's view of the DB need to surface on every other
connected client (other tabs, other devices, MCP-driven writes). The
mechanism is a process-wide `ChangeBroker`
(`internal/server/changes_broker.go`) plus an SSE handler at
`GET /api/changes/stream`:

1. `notifyOnWriteMiddleware` wraps the API mux. On every 2xx non-GET
   response it reads the latest `change_events` cursor from
   `store.Settings.GetLatestChangeCursor` and calls
   `changesBroker.Notify(cursor)` — single tap point, no per-handler
   instrumentation. Bridge writes (the MCP executor's
   `/internal/mcp/bridge` path) are inside the wrapped mux, so MCP-driven
   mutations fan out the same way as direct API writes.
2. `handleChangesStream` (`internal/server/changes_handlers.go`)
   `Subscribe(ctx)`s to the broker and `select`s on the subscription
   channel, a 15s keepalive ticker, the 10-min
   `changeStreamMaxSessionAge` recycle, and `r.Context().Done()`. On each
   broker wake it queries `ListChangedTagsSince(lastCursor)` and emits a
   single `data: …\n\n` frame. Capacity is bounded by a 40-slot
   process-wide semaphore and a per-channel buffer of 1 — missed wakes
   are harmless because each handler reconciles via the cursor.
3. `Server.Shutdown` calls `changesBroker.CloseAll()` before the HTTP
   listener closes. Subscribed handlers see their channels close and
   return cleanly, so the only `RST_STREAM` a client observes is one per
   deploy. EventSource auto-reconnects on the next backoff tick.

The legacy `GET /api/changes?since=<cursor>` polling endpoint is
unchanged and remains the fallback when the browser lacks
`EventSource` or the stream sees 3 consecutive `onerror` events within
30s (proxy / captive-portal failures). See
[technical-decisions.md → Why SSE is primary](technical-decisions.md)
for the rationale and [sse-traefik.md](sse-traefik.md) for the required
reverse-proxy configuration. Client-side wiring lives in
`web/static/js/data-store.js` (`startChangeStream`,
`startChangePolling`) and is documented in
[frontend.md → Change Detection](frontend.md#change-detection).

### TZ suggestion cross-client dismissal

TZ suggestion dismissal is persisted in the singleton `settings` table's
`dismissed_tz_suggestion` column (migration `063_add_dismissed_tz_suggestion.sql`);
the web bootstrap consults the settings bundle before prompting, so dismissing
in one browser silences other clients until the detected TZ changes or the
user explicitly updates settings. The decision flow lives in
`internal/domain/tzsuggestion/service.go` (`ShouldPrompt`, `RecordDismissal`)
and is exposed via `POST /api/tz-suggestion/dismiss`. `RecordTimezone` clears
the dismissed flag in the same write so the next genuine TZ change prompts
normally. A successful web-initiated TZ change also fires a Telegram
confirmation through the existing notifier; decline does not.

## Telegram Bot Callbacks

Callback data format is crucial for routing:

- Medication: `confirm_<id>`, `skip_<id>`, `snooze_<id>_<duration>`, `cancel_intake:<id1>,<id2>,...`
- Workout: `workout_start_<session_id>`, `workout_exercise_done_<session_id>_<exercise_id>`

See `internal/bot/handlers.go` and `internal/bot/workout_callbacks.go`.

The bot's slash-command menu is registered via `setMyCommands` on startup and re-synced when feature flags change (poll-based, ~5 s lag). The canonical command list lives in `internal/bot/commands.go` (`commandSpecs`) and drives both `/help` output and the Telegram autocomplete menu.

## Logging

- Use `log/slog`. Configure default in entry points: `slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))`
- Prefer contextual args: `slog.Error("msg", "error", err)` over `log.Printf("msg: %v", err)`
- Use `slog.Error` + `os.Exit(1)` instead of `log.Fatal` for cleaner deferred cleanup

## Testing Patterns

- Store tests use in-memory SQLite (`:memory:`)
- Server tests use `httptest` for HTTP handlers
- Domain services are tested end-to-end via handler tests against the real store (`internal/server/*_test.go` for HTTP, `internal/bot/*_test.go` for bot callbacks). Both transports share the same domain code path, so handler-level coverage validates the contract — package-level mock-spy tests under `internal/domain/` are intentionally not maintained.

### JSON Golden-File Pattern

For `internal/scheduler` and `internal/bot` callback tests, scenarios are JSON files in `testdata/` consumed by the `internal/testharness` package.

Scenario shape:

```json
[
  {
    "name": "Scenario Name",
    "description": "What this scenario verifies",
    "input": { "time_now": "2023-10-27T09:00:00Z", "...": "..." },
    "expected": { "notifications": 1, "...": "..." }
  }
]
```

**Adding a case**: append a JSON object to the existing file and run `go test ./...`. No Go code changes needed.

**Adopting for a new component**:
1. Create `testdata/scenarios.json`
2. Import `github.com/korjavin/medicationtrackerbot/internal/testharness`
3. Use `testharness.RunScenarios` to iterate
4. Unmarshal `s.Input` / `s.Expected` into your structs
5. Set up env from input, call the function under test, compare with `testharness.CompareJSON(t, expected, actual)`
