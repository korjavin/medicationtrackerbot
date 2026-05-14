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
- `tz_transition_plans` — timezone transition plans (status: PENDING_APPROVAL / NOTIFIED / APPROVED / REJECTED / CANCELLED / EXPIRED). Generated when the stored timezone changes. Must be approved via Telegram before taking effect. Stores a SHA-256 `plan_hash` for idempotency and full `inputs_json` for reproducibility.
- `tz_transition_steps` — individual dose steps within a transition plan. Each row has `scheduled_at` and `consumed_at` (NULL until triggered). The scheduler uses pending steps instead of normal schedule times while an APPROVED plan exists.

### Migrations

- Located in `internal/store/migrations/`, numbered sequentially
- Use goose for migration management
- Migrations auto-run on store initialization
- Never modify existing migrations; create new ones

### Time storage

**Rule:** dose-time columns on `intake_log` are stored as `INTEGER` unix-seconds-UTC, not as SQLite `DATETIME` text. Specifically: `intake_log.scheduled_at_unix`, `intake_log.taken_at_unix`, `intake_log.snoozed_until_unix`. The architecture test `internal/store/medication/time_columns_test.go` parses `PRAGMA table_info(intake_log)` and fails CI if any of these columns regresses to a text-typed column, or if a legacy `scheduled_at` / `taken_at` / `snoozed_until` text column reappears.

**Why:** `modernc.org/sqlite` serializes `time.Time` via `t.String()`, which embeds the timezone *name* (e.g. `"2026-05-10 08:20:00 -0700 PDT"`). SQL text-equality (`WHERE scheduled_at = ?`) on such strings depends on the caller's `time.Location` and breaks whenever the user (or the scheduler) compares the same UTC instant across a TZ-name change — even when the *offset* is unchanged (PDT→MST). On 2026-05-10 this produced a duplicate set of pending intakes after a California→Phoenix flight and an hourly reminder storm. Storing unix seconds normalizes the value at the write boundary; SQL equality on `INTEGER` is then unambiguous regardless of caller `time.Location`.

**Write path:** every writer normalizes via `t.UTC().Unix()`. `.UTC()` also strips Go's monotonic-clock residue, which has previously leaked through `t.String()` into other tables.

**Read path:** `Scan(&n int64)` then `time.Unix(n, 0).UTC()`. Nullable columns scan into `sql.NullInt64` and populate `*time.Time` pointer fields only when valid.

**Design history:** see `docs/plans/2026-05-10-intake-log-utc-unix-fix.md` (this implementation) and `docs/plans/20260508-simplify-medication-scheduling-utc-and-pre-materialized-steps.md` (Track A of the broader scheduler-simplification proposal).

## Store layer

`internal/store` is split into one Go package per domain. The single 3.3k-line god-object `Store` was replaced with per-feature repositories during the 2026-05 store-split refactor (see `docs/plans/completed/2026-05-13-split-store-package.md`).

### Layout

```
internal/store/
├── db/            shared infra: Open(), *sql.DB wrapper, busy-timeout config,
│                  WithTx cross-repo transaction helper, goose migrations runner,
│                  unix-seconds time helpers.
├── medication/    medication CRUD + intake_log + restock + inventory (38 methods).
├── bp/            blood-pressure readings + reminder state + goal + stats.
├── weight/        weight logs + reminder state + goal + unit preference.
├── food/          food logs + products + targets + Open Food Facts client.
├── workout/       workout groups/variants/exercises/sessions/logs + mi-band.
├── vitals/        sleep_logs + day_stats + heart/spo2/stress vitals.
├── diary/         diary_notes.
├── tz/            timezone_history + tz_transition_plans + tz_transition_steps.
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

When a write needs to atomically touch tables owned by two different packages, callers use the shared `db.WithTx` helper plus the `db.TX` interface (satisfied by both `*sql.DB` and `*sql.Tx`). Each repo can expose `…Tx` variants of methods that participate in caller-owned transactions; in practice this is rare — the canonical case (timezone-plan rejection touching `intake_log`) turned out to be sequential best-effort calls rather than a single atomic operation, so no `…Tx` variants exist today. The `db.WithTx` pattern is reserved for future cross-repo writes that genuinely need atomicity.

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

## Telegram Bot Callbacks

Callback data format is crucial for routing:

- Medication: `confirm_<id>`, `skip_<id>`, `snooze_<id>_<duration>`, `cancel_intake:<id1>,<id2>,...`
- Workout: `workout_start_<session_id>`, `workout_exercise_done_<session_id>_<exercise_id>`

See `internal/bot/handlers.go` and `internal/bot/workout_callbacks.go`.

## Logging

- Use `log/slog`. Configure default in entry points: `slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))`
- Prefer contextual args: `slog.Error("msg", "error", err)` over `log.Printf("msg: %v", err)`
- Use `slog.Error` + `os.Exit(1)` instead of `log.Fatal` for cleaner deferred cleanup

## Testing Patterns

- Store tests use in-memory SQLite (`:memory:`)
- Server tests use `httptest` for HTTP handlers
- Domain service tests use mock store structs (implement the narrow `FooStore` interface inline) with table-driven cases

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
