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
- `store/` — database layer (SQLite repository, migrations)
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
