# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A self-hosted Telegram Mini App for comprehensive health tracking (medications, blood pressure, weight, workouts, sleep). The system consists of a monolithic Go application that serves both as a Telegram Bot and Web Server with a vanilla JavaScript frontend.

**Philosophy**: Single source of truth for health metrics with both a rich web interface and minimalist chat interface. Self-hosted for true data ownership.

## Development Commands

### Running the Application

```bash
# Run the main bot + web server
go run ./cmd/bot

# Run the MCP server (for AI integration)
go run ./cmd/mcptool
```

### Database Management

The project uses SQLite with goose migrations located in `internal/store/migrations/`.

Migrations are automatically applied on startup by the store initialization. To manually manage migrations:

```bash
# The store.New() function automatically runs migrations
# See internal/store/store.go for implementation
```

### Testing

```bash
# Run all tests
go test ./...

# Run tests for a specific package
go test ./internal/store
go test ./internal/server
go test ./internal/domain

# Run tests with verbose output
go test -v ./internal/store

# Run a specific test
go test -v ./internal/server -run TestBPHandlers
```

### Data Import Tools

```bash
# Import medication history from Apple Health JSON export
go run cmd/importer/main.go -file export.json -user <telegram_user_id> -db meds.db

# Import blood pressure data from CSV
go run cmd/bpimporter/main.go -file bp_data.csv -db meds.db

# Generate VAPID keys for web push notifications
go run cmd/genvapid/main.go
```

### Docker

```bash
# Build
docker build -t medtracker .

# Run
docker-compose up
```

## Architecture

### System Components

```
User
├── Chat Interface (Telegram) → Bot Logic → SQLite
└── Web Frontend (Mini App) → HTTP Server → SQLite
                                ↓
                            Scheduler (notifications)
```

### Code Structure

**Entry Points** (`cmd/`):
- `bot/` - Main application (bot + web server + scheduler)
- `mcptool/` - MCP server for AI integration (read-only health data access)
- `importer/` - Apple Health medication import
- `bpimporter/` - Blood pressure CSV import
- `genvapid/` - VAPID key generator for web push

**Core Packages** (`internal/`):
- `ai/` - AI client integration (OpenAI-compatible)
- `store/` - Database layer (SQLite repository, migrations)
- `server/` - HTTP handlers for REST API
- `bot/` - Telegram bot logic (commands, callbacks, notifications) — thin channel layer only
- `domain/` - Business logic services: `medication.go`, `exercise.go`, `reminder.go`, `food.go`, `food_ai.go`
- `workout/` - Workout session management service (`service.go`)
- `scheduler/` - Notification scheduling (medications, workouts, BP/weight reminders)
- `mcp/` - Model Context Protocol server implementation
- `rxnorm/` - Drug interaction checking via NLM API
- `webpush/` - Web push notification support
- `tzlookup/` - Geo-to-timezone reverse lookup using `github.com/ringsaturn/tzf`. Exposes `LookupTimezone(lat, lng float64) (string, error)`. Initialized lazily with `sync.Once`; timezone boundary data is embedded in the binary (~5 MB compressed), no external API calls.

**Frontend** (`web/static/`):
- Vanilla JavaScript (no framework), Dexie.js for IndexedDB
- Local First architecture with four layers: Service Worker → IndexedDB → SyncManager → SWR DataStore
- Offline writes supported for BP, weight, and medication confirmations
- Stale-While-Revalidate caching with tag-based invalidation via polling (`/api/changes`)
- Telegram WebApp JS SDK for theme integration

### Database Schema

SQLite with 47 goose migrations tracking schema evolution:
- `medications`, `intake_log` - Medication management and history
- `blood_pressure_readings` - BP tracking
- `weight_logs` - Weight tracking with trend calculation
- `workout_groups`, `workout_variants`, `workout_exercises` - Hierarchical workout structure
- `workout_sessions`, `workout_exercise_logs` - Workout history
- `workout_rotation_state` - Rotating workout schedules
- `sleep_logs` - Sleep tracking
- `food_log`, `food_products`, `food_targets` - Food intake and nutrition tracking. Supports creating multi-item "Meals" (templates with aggregated macros and serving size) under the Food tab.
- `push_subscriptions` - Web push notification subscriptions
- `bp_reminders`, `weight_reminders` - Reminder configuration
- `change_events` - Server-side change tracking for frontend cache invalidation
- `diary_notes` - Free-text personal diary notes with timestamps
- `timezone_history` - Per-user timezone history (most recent row is the active timezone). Overrides the `TZ` env var for all schedulers including medications. Medication scheduling uses the stored user timezone when computing dose times; when no timezone is recorded, falls back to `time.Local` (system TZ via `TZ` env var).
- `tz_transition_plans` - Timezone transition plans (status: PENDING_APPROVAL / NOTIFIED / APPROVED / REJECTED / CANCELLED / EXPIRED). Generated automatically when the user's stored timezone changes. Must be approved via Telegram before taking effect. Stores a SHA-256 `plan_hash` for idempotency and full `inputs_json` for reproducibility.
- `tz_transition_steps` - Individual dose steps within a transition plan. Each row has `scheduled_at` and `consumed_at` (NULL until triggered). The medication scheduler uses pending steps instead of normal schedule times when an APPROVED plan exists for a medication; marks each step consumed when the corresponding intake is created.

### Authentication & Security

**Telegram Mini App**:
- Validates `Telegram.WebApp.initData` signature using HMAC-SHA256
- Extracts user_id and validates against `ALLOWED_USER_ID` env var
- initData sent in Authorization header

**Telegram Bot**:
- Checks `update.Message.From.ID` against `ALLOWED_USER_ID`
- Rejects unauthorized updates

**Optional Google OIDC**:
- For browser access outside Telegram
- Configured via `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ADMIN_EMAIL`

## Domain Service Pattern

The bot (`internal/bot/`) is a thin communication channel — it parses Telegram-specific data and sends/deletes messages. All business decisions live in `internal/domain/`:

- `domain/medication.go` — `MedicationService`: confirm/skip/log medication intakes, batch confirm a time slot
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

**Rule**: bot callbacks may only call domain service methods and Telegram API methods. No direct store calls for business decisions.

## Feature Implementation Patterns

### Medication Tracking
- **Smart Sorting**: Scheduled Soon (>14h) → Recently Taken → As-Needed → Archived
- **Archiving & Deleting**: Active medications can be archived. Archived medications can be permanently deleted only if they have no intake history.
- **Schedule Types**: Daily, Weekly, As-Needed with optional Start/End dates
- **Drug Interactions**: Automatic checking via RxNorm API when adding/unarchiving
- **Notifications**: Telegram alerts with scheduled time and dosage, hourly retry if not confirmed
- **Timezone Shift Policy** (`tz_shift_policy`): per-medication field controlling how doses are rescheduled when the user's timezone changes. Values: `flexible` (default — shift immediately in one step), `medium` (shift gradually, max 3h per dose), `strict` (very gradual, max 2h per step). When a timezone change is detected and an active plan is approved, the medication scheduler uses the plan's transition steps instead of normal schedule times until all steps are consumed.

### Blood Pressure Tracking
- **Classification**: ISH 2020 guidelines (configurable for age <65)
- **Target**: <130/80 mmHg
- **Tracking**: 2-3x daily recommended
- **Export**: CSV format

### Weight Tracking
- **Trend**: Exponential moving average for smooth visualization
- **Export**: CSV in Libra format (compatible with Libra app)
- **Reminders**: Weekly if no weight logged

### Workout Tracking
- **Hierarchy**: Groups → Variants → Exercises
- **Rotation**: Automatic A/B/C/D progression (e.g., PPL, PHUL splits)
- **Scheduling**: Configurable days of week, notification advance time (default 15 min)
- **Snooze**: 1-hour or 2-hour options
- **Logging**: Exercise-by-exercise with sets, reps, weight
- **Stats**: Streak tracking, completion rates, session history

### MCP Server
- **Purpose**: Provides read-only access to health data for AI assistants (Claude)
- **Authentication**: OAuth via Pocket-ID
- **Tools**: Query medication intake, BP readings, sleep logs, weight, workout history
- **Configuration**: Separate from main bot, runs on different port

#### MCP Server Deployment

The MCP connector runs as a separate process (binary: `mcptool`) but shares the same Docker image and database as your main bot. It exposes an HTTP server that Claude connects to via a secure tunnel (handled by your Traefik setup).

**1. Pocket-ID Configuration**

Before deploying, you need to set up an OIDC client in Pocket-ID.

1.  **Log in** to your Pocket-ID instance.
2.  **Create a new Client**:
    *   **Name**: Claude Health MCP
    *   **Redirect URIs**: `https://claude.ai/api/mcp/auth_callback` AND `https://claude.com/api/mcp/auth_callback` (add both to be safe)
    *   **Access Type**: Public (or Confidential - MCP implementation is confidential client)
    *   **Trust Level**: High (recommended)
3.  **Note Credentials**: Copy the `Client ID` and `Client Secret`.
4.  **Get User Subject**:
    *   You need your unique User Subject UUID (`sub` claim) to restrict access.
    *   You can find this in your Pocket-ID user profile or by inspecting an ID token.

**2. Docker Compose Configuration**

Add a new service to your `docker-compose.yml` file to run the MCP server.

```yaml
  mcp-server:
    image: ghcr.io/korjavin/medicationtrackerbot:latest
    container_name: medtracker-mcp
    restart: unless-stopped
    command: ["./mcptool"]  # Override default command to run MCP server
    volumes:
      - medtracker_data:/app/data:ro  # Read-only access to data
    environment:
      - MCP_PORT=8081
      - MCP_DATABASE_PATH=/app/data/meds.db
      - MCP_MAX_QUERY_DAYS=90
      - MCP_SERVER_URL=https://mcp.yourdomain.com  # Your public MCP URL
      - MCP_ALLOWED_SUBJECT=your-user-uuid-here    # Optional: empty = allow any; one or comma-separated list of allowed `sub` values
      - POCKET_ID_URL=https://id.yourdomain.com
      - POCKET_ID_CLIENT_ID=your-client-id   # One or comma-separated client IDs accepted in token audience
      - POCKET_ID_CLIENT_SECRET=your-client-secret
      - TZ=${TZ:-Europe/Berlin}
    networks:
      - default
      - traefik_net
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.medtracker-mcp.rule=Host(\`mcp.yourdomain.com\`)" # Choose a subdomain
      - "traefik.http.routers.medtracker-mcp.entrypoints=websecure"
      - "traefik.http.routers.medtracker-mcp.tls.certresolver=myresolver"
      - "traefik.http.services.medtracker-mcp.loadbalancer.server.port=8081"
```

> **IMPORTANT:** Make sure `MCP_SERVER_URL` matches the Host rule in Traefik labels.

**3. Configuring Claude**

1.  Open **Claude Desktop** or **Claude.ai** (when MCP is enabled).
2.  Go to **Settings** -> **MCP**.
3.  Add a new MCP Server:
    *   **Type**: SSE / HTTP
    *   **URL**: `https://mcp.yourdomain.com/mcp/sse` (or just `/mcp` depending on SDK - our implementation supports HTTP transport)
    *   **Wait**: Currently Claude.ai MCP supports local stdio primarily. For remote HTTP MCP, you might need a local relay or wait for full remote support.

    *Additional Note*: If you are using Claude Desktop, you might need to run a local `mcp-proxy` or configure it to connect to your remote URL.

    **If using Claude Desktop with Stdio (Alternative Local Run):**
    You can also run the binary locally pointing to a local DB copy:
    ```json
    {
      "mcpServers": {
        "health-tracker": {
          "command": "/path/to/mcptool",
          "env": {
             "MCP_DATABASE_PATH": "..."
          }
        }
      }
    }
    ```

## Environment Variables

```bash
# Required
TELEGRAM_BOT_TOKEN=...        # From BotFather
ALLOWED_USER_ID=123456789     # Your Telegram user ID
TZ=Europe/Berlin              # Critical for correct scheduling

# Optional
DB_PATH=meds.db               # SQLite database path (default: meds.db)
PORT=8080                     # HTTP port (default: 8080)
EXTERNAL_WORKOUT_API_KEY=...  # Required for external workout endpoint (e.g. Mi Notify)

# Natural Language Food Logging (optional)
OPENAI_API_KEY=...            # Optional, for the /food AI command
OPENAI_URL=...                # Optional, defaults to https://api.openai.com/v1
OPENAI_MODEL=...              # Optional, defaults to gpt-4o-mini

# Google Auth (optional, for browser access)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URL=https://your-domain.com/auth/google/callback
ADMIN_EMAIL=you@gmail.com

# Web Push (optional)
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com

# MCP Server (for mcptool)
MCP_PORT=3100
MCP_DATABASE_PATH=/app/data/tracker.db
MCP_POCKETID_URL=https://auth.example.com
MCP_MAX_QUERY_DAYS=90
MCP_AUDIT_ENDPOINT=http://medtracker:8080/api/mcp-audit
MCP_AUDIT_SECRET=secure-shared-secret
```

## Important Implementation Notes

### Database Migrations
- Migrations are in `internal/store/migrations/` numbered sequentially (001-027)
- Use goose for migration management
- Migrations auto-run on store initialization
- Never modify existing migrations; create new ones

### Telegram Bot Callbacks
- Callback data format is crucial for routing
- Medication callbacks: `confirm_<id>`, `skip_<id>`, `snooze_<id>_<duration>`
- Workout callbacks: `workout_start_<session_id>`, `workout_exercise_done_<session_id>_<exercise_id>`
- See `internal/bot/handlers.go` and `internal/bot/workout_callbacks.go`

### Scheduler Behavior
- Runs every minute (configurable ticker)
- Medication notifications: 15 min before due time (configurable)
- Workout notifications: configurable per group (default 15 min advance)
- Snooze logic: checks `snooze_until` timestamp
- Rotation advancement: happens on workout completion or skip

### Web Frontend Integration
- Frontend uses `window.Telegram.WebApp.initData` for auth
- Theme adapts to Telegram theme params via CSS variables
- Service worker (`sw.js`) for PWA and offline support
- Cache busting via timestamp replacement in Dockerfile
- Local First: `offlineAwareApiCall()` in `sync.js` is the main entry point for all API calls
- SWR caching: `loadSWR()` in `data-store.js` returns cached data immediately, refreshes in background
- Change detection: polls `/api/changes?since=` every 30s (SSE disabled due to HTTP/2 proxy issues)
- IndexedDB (`db.js`): write-ahead queue for offline writes + generic `api_cache` for SWR
- Treat HTTP 502/503/504 as "offline" — `navigator.onLine` stays true behind reverse proxies
- **Tab Reordering:** Drag-and-drop functionality in `tabs-dnd.js` allows custom tab layouts, persisted via `tab_order` in the bootstrap payload and cached in `settings_bundle`.

#### Data Flow Diagrams

```text
User Action (e.g., log BP reading)
       │
       ▼
offlineAwareApiCall()          ← Layer 3 (sync.js)
       │
       ├── Online? ──→ POST /api/bp ──→ Server ──→ SQLite
       │                    │
       │                    └── Success → invalidate SWR cache (Layer 4)
       │
       └── Offline? ──→ BPStore.save() ──→ IndexedDB (Layer 2)
                              │
                              └── Register SW background sync
                                        │
                                        ▼ (when online again)
                              SyncManager.syncAll()
                                        │
                                        ▼
                              POST /api/bp (for each pending item)
                                        │
                                        └── Success → delete from IndexedDB
```

```text
Page Load (e.g., BP tab)
       │
       ▼
loadSWR({ cacheKey, fetchFn })     ← Layer 4 (data-store.js)
       │
       ├── Return cached data immediately → render UI
       │
       └── Fetch fresh data in background
              │
              ├── Success → update cache, call onFresh → re-render UI
              └── Failure → keep showing cached data (no error shown)
```

#### Frontend Module Structure

The frontend uses a multi-file vanilla JS architecture. Each script is loaded in dependency order via `<script>` tags. There is no bundler — cross-file communication happens via `window.*` globals (see Global Namespace Policy below).

**Script load order in `index.html`** (loading order matters for dependency resolution):
1. `core/utils.js` — no deps; provides `safeAlert`, format helpers
2. `components/mt-elements.js` — no deps; registers `<mt-modal>` and `<mt-setting-toggle>`
3. `components/empty-state.js`, `stat-card.js`, `action-row.js` — UI primitives
4. `core/modal-manager.js` — no deps; provides `window.ModalManager`
5. `core/api.js` — depends on `safeAlert` (utils.js); reads `window.userInitData` lazily; provides `apiCallDirect`, `apiCall`
6. `core/app-kernel.js` — no deps; provides `window.AppKernel` module registry
7. `core/store.js` — no deps; provides `window.AppStore` pub/sub state
8. `core/modal-controller.js` — no deps; provides `withSubmit` double-submit guard
9. `db.js` — must load before sync.js; sets up Dexie/IndexedDB stores (`window.MedTrackerDB`)
10. `sync.js` — depends on `db.js`; provides `offlineAwareApiCall` and `SyncManager`
11. `data-store.js` — depends on `window.MedTrackerDB` (db.js) for cache storage; uses `window.apiCallDirect` (core/api.js) lazily at change-poll time
12. `app.js` — depends on `DataStore`, `ModalManager`, `apiCall`; defines domain UI and `checkAuth`
13. `features/food.js`, `features/bp.js`, `features/weight.js` — domain feature modules extracted from app.js
14. `features/auth-flow.js` — provides auth-cache helpers called by `checkAuth()` in app.js
15. `features/modal-history.js` — sets up MutationObserver before DOMContentLoaded
16. `features/deeplink-router.js` — registers `window.handleDeepLinks`
17. `workout.js`, `push.js`, `app-shell.js` — feature extensions
18. `features/bootstrap.js` — **must be last**; runs `checkAuth()` to start the app, then calls `maybeUpdateTimezone()` which detects the browser timezone via `Intl.DateTimeFormat`, compares against the stored value from the `settings_bundle` cache, and prompts the user to confirm a change. Best-effort — errors are swallowed so they never block app startup.

#### Global Namespace Policy

All explicit `window.*` assignments are tracked in `tests/architecture.globals.test.js`. Adding a new global requires updating the allowlist with a justification. Current approved globals:

| Global | Source | Consumed by |
|--------|--------|-------------|
| `window.AppKernel` | `core/app-kernel.js` | module registry |
| `window.AppStore` | `core/store.js` | app.js, feature modules |
| `window.ModalManager` | `core/modal-manager.js` | app.js |
| `window.apiCallDirect` | `core/api.js` | data-store.js (change polling) |
| `window.userInitData` | `app.js` | feature files (bp.js, weight.js) |
| `window.onDataStoreUnauthorized` | `app.js` | data-store.js callback |
| `window.onTelegramAuth` | `app.js` | Telegram OIDC script |
| `window.requestTabRefresh` | `app.js` | data-store.js change detection |
| `window.reloadCurrentTab` | `app.js` | data-store.js + sync.js |
| `window.handleDeepLinks` | `features/deeplink-router.js` | features/bootstrap.js |
| `window.DataStore` | `data-store.js` | app.js, feature files |
| `window.MedTrackerDB` | `db.js` | sync.js, data-store.js |
| `window.SyncManager` | `sync.js` | features/bootstrap.js |
| `window.offlineAwareApiCall` | `sync.js` | core/api.js |
| `window.SyncDebug` | `sync.js` | dev diagnostics |
| `window.MedTrackerPush` | `push.js` | app.js |
| `window.initServiceWorker` | `app-shell.js` | index.html inline |
| `window.showUpdateToast` | `app-shell.js` | service worker message |

### Logging Pattern
- We use the standard library structured logger (`log/slog`).
- Configure the default logger in entry points: `slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))`
- Use contextual arguments `slog.Error("msg", "error", err)` instead of formatting `log.Printf("msg: %v", err)`.
- Replaced `log.Fatal` with `slog.Error` + `os.Exit(1)` for cleaner deferred cleanup (where applicable).

### Testing Patterns
- Store tests use in-memory SQLite (`:memory:`)
- Server tests use httptest for HTTP handlers
- Domain service tests use mock store structs (implement the narrow `FooStore` interface inline) with table-driven cases — no Telegram API dependency required

#### JSON Golden-File Pattern

To make tests data-driven, declarative, and easy to extend without writing new Go code, we use a JSON golden-file testing pattern for certain packages, particularly `internal/scheduler` and `internal/bot` callbacks.

**How it works**
Tests use a reusable harness from the `internal/testharness` package.
Scenarios are defined in `.json` files inside a `testdata/` directory next to the test files.
The harness reads the JSON scenarios, injects the input data into the system, executes the functionality, and does a deep comparison against the expected outcome defined in the JSON.

**Scenario Structure**
A typical scenario JSON looks like this:
```json
[
  {
    "name": "Scenario Name",
    "description": "What this scenario verifies",
    "input": {
      "time_now": "2023-10-27T09:00:00Z",
      ...
    },
    "expected": {
      "notifications": 1,
      ...
    }
  }
]
```
The exact schema of `input` and `expected` depends on the specific component being tested. The Go test file uses `json.Unmarshal` to parse these fields into domain-specific structs.

**Adding a New Test Case**
To add a new test case for a covered component:
1. Open the relevant `.json` file in the `testdata/` directory (e.g. `internal/scheduler/testdata/bp_reminder_scenarios.json`).
2. Add a new JSON object to the array following the established schema.
3. Run `go test ./...` to verify it passes.
You do not need to write any new Go code!

**Adopting for New Components**
If you want to use this pattern for a new component:
1. Create a `testdata/scenarios.json` file.
2. In your `_test.go` file, import `github.com/korjavin/medicationtrackerbot/internal/testharness`.
3. Use `testharness.RunScenarios` to iterate through the file.
4. Unmarshal `s.Input` and `s.Expected` into your own structs.
5. Setup the environment based on the input.
6. Call the function under test.
7. Build the actual result and compare it using `testharness.CompareJSON(t, expected, actual)`.

## API Endpoints

### Health Data

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/bootstrap` | All initial data in one request |
| GET | `/api/medications` | List medications |
| POST | `/api/medications` | Create medication |
| PATCH | `/api/medications/:id` | Update medication |
| POST | `/api/medications/confirm-schedule` | Confirm dose intake |
| GET | `/api/medications/intake-history` | Dose history |
| GET | `/api/medications/next-intake` | Next scheduled dose |
| GET | `/api/bp` | BP readings |
| POST | `/api/bp` | Log BP reading |
| GET | `/api/bp/stats` | BP statistics |
| GET | `/api/bp/goal` | BP goal |
| POST | `/api/bp/goal` | Set BP goal |
| GET | `/api/weight` | Weight logs |
| POST | `/api/weight` | Log weight |
| GET | `/api/weight/goal` | Weight goal |
| POST | `/api/weight/goal` | Set weight goal |
| GET | `/api/food/log` | Food log entries |
| POST | `/api/food/log` | Log food |
| GET | `/api/food/search` | Search Open Food Facts |
| GET | `/api/food/targets` | Nutrition targets |
| POST | `/api/food/targets` | Set nutrition targets |
| GET | `/api/sleep` | Sleep logs |
| POST | `/api/sleep` | Log sleep |
| GET | `/api/notes` | List diary notes |
| POST | `/api/notes` | Create diary note |
| DELETE | `/api/notes/{id}` | Delete diary note |

### Workouts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/workout/groups` | List workout groups |
| POST | `/api/workout/groups/create` | Create group |
| PUT | `/api/workout/groups/update` | Update group |
| GET | `/api/workout/variants` | List variants |
| POST | `/api/workout/variants/create` | Create variant |
| GET | `/api/workout/exercises` | List exercises |
| POST | `/api/workout/exercises/create` | Create exercise |
| PUT | `/api/workout/exercises/update` | Update exercise |
| DELETE | `/api/workout/exercises/delete` | Delete exercise |
| GET | `/api/workout/sessions` | Session history |
| GET | `/api/workout/sessions/details` | Session details with logs |
| GET | `/api/workout/stats` | 30-day statistics |
| GET | `/api/workout/rotation/state` | Current rotation position |
| POST | `/api/workout/rotation/initialize` | Initialize rotation |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/changes` | Change events since cursor (for cache invalidation) |
| GET | `/api/settings` | User settings (returns `{"timezone": "..."}`) |
| POST | `/api/settings` | Update settings (accepts optional `timezone` IANA name; returns 400 for invalid values) |
| POST | `/api/push/subscribe` | Register push subscription |
| POST | `/api/push/unsubscribe` | Remove push subscription |
| GET | `/auth/oidc/login` | OIDC login redirect |
| GET | `/auth/oidc/callback` | OIDC callback |
| GET | `/auth/google/login` | Google login redirect |
| GET | `/auth/google/callback` | Google callback |

## Technical Decisions

### Why polling instead of SSE for change detection

SSE (Server-Sent Events) over HTTP/2 behind reverse proxies like Traefik and nginx is unreliable. When the server closes the stream, it sends an HTTP/2 `RST_STREAM` frame that browsers surface as `ERR_HTTP2_PROTOCOL_ERROR`. This causes spurious reconnection loops and error noise. Polling every 30 seconds with a cursor-based `GET /api/changes?since=` is lightweight (empty responses are ~50 bytes) and works reliably through any proxy stack.

### Why only three endpoints support offline writes

Adding offline write support requires: IndexedDB schema, optimistic UI rendering, conflict resolution on sync, and error handling for rejected writes. We limit this to the three most time-sensitive health actions (BP readings, weight logs, medication confirmations) where missing a data point is worse than the implementation complexity. Other writes (editing medications, creating workouts) are infrequent and can wait for connectivity.

### Why 5xx responses are treated as "offline"

When the app runs behind Traefik (or any reverse proxy), `navigator.onLine` stays `true` even when the backend Go process is down — the browser has a TCP connection to Traefik, just not to the app. HTTP 502/503/504 from the proxy are functionally identical to being offline, so the SW and sync layer treat them the same way: serve cached responses for reads, queue writes locally.

### Why IndexedDB is a write-ahead queue, not a full replica

After successful sync, records are deleted from IndexedDB rather than kept as "synced" copies. This keeps the local store small and avoids the complexity of bidirectional sync and conflict resolution. The SW cache and `api_cache` in IndexedDB already provide read-only offline access to previously fetched data.

### Why vanilla JS instead of a framework

The app is single-user, self-hosted, and runs primarily inside Telegram's WebView. A framework would add bundle size and build complexity for little benefit. The four-layer local-first architecture (SW → IndexedDB → SyncManager → SWR DataStore) is straightforward to implement with vanilla JS and Dexie.js.

## Common Tasks

### Adding a New Health Metric
1. Create migration in `internal/store/migrations/`
2. Add table methods to `internal/store/store.go`
3. Create a domain service in `internal/domain/` following the Domain Service Pattern (see above)
4. Create HTTP handlers in `internal/server/`
5. Add bot commands in `internal/bot/` — use the domain service; no direct store calls for business logic
6. Add frontend UI in `web/static/`
7. Add scheduler logic if reminders needed in `internal/scheduler/`

### Adding MCP Tools
1. Add tool definition in `internal/mcp/tools.go`
2. Implement handler function
3. Register tool in server initialization
4. Update `.env.mcp.example` if config needed

### Modifying Workout Rotation Logic
- Core logic in `internal/store/workout.go` (AdvanceRotation method)
- Scheduler integration in `internal/scheduler/workout.go`
- Bot callbacks in `internal/bot/workout_callbacks.go`
- Test coverage in `internal/store/workout_test.go`

## Documentation References

- `README.md` - User-facing features and setup
- `.env.mcp.example` - MCP server configuration example

### Notes
- Workout stats API (`/api/workout/stats`) no longer returns streak or total volume metrics. Instead, it returns `active_weeks` (count of weeks with at least one completed session) and `total_sessions` (sum of completed and skipped).
