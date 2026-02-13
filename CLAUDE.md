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
- `store/` - Database layer (SQLite repository, migrations)
- `server/` - HTTP handlers for REST API
- `bot/` - Telegram bot logic (commands, callbacks, notifications)
- `scheduler/` - Notification scheduling (medications, workouts, BP/weight reminders)
- `mcp/` - Model Context Protocol server implementation
- `rxnorm/` - Drug interaction checking via NLM API
- `webpush/` - Web push notification support

**Frontend** (`web/static/`):
- Vanilla JavaScript (no framework)
- Telegram WebApp JS SDK for theme integration
- Service worker for PWA functionality

### Database Schema

SQLite with 16 migrations tracking schema evolution:
- `medications`, `intake_log` - Medication management and history
- `blood_pressure_readings` - BP tracking
- `weight_logs` - Weight tracking with trend calculation
- `workout_groups`, `workout_variants`, `workout_exercises` - Hierarchical workout structure
- `workout_sessions`, `workout_exercise_logs` - Workout history
- `workout_rotation_state` - Rotating workout schedules
- `sleep_logs` - Sleep tracking
- `push_subscriptions` - Web push notification subscriptions
- `bp_reminders`, `weight_reminders` - Reminder configuration

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

## Feature Implementation Patterns

### Medication Tracking
- **Smart Sorting**: Scheduled Soon (>14h) → Recently Taken → As-Needed → Archived
- **Schedule Types**: Daily, Weekly, As-Needed with optional Start/End dates
- **Drug Interactions**: Automatic checking via RxNorm API when adding/unarchiving
- **Notifications**: Telegram alerts with scheduled time and dosage, hourly retry if not confirmed

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

See `WORKOUT_TRACKING.md` for detailed workout feature documentation.

### MCP Server
- **Purpose**: Provides read-only access to health data for AI assistants (Claude)
- **Authentication**: OAuth via Pocket-ID
- **Tools**: Query medication intake, BP readings, sleep logs, weight, workout history
- **Configuration**: Separate from main bot, runs on different port

## Environment Variables

```bash
# Required
TELEGRAM_BOT_TOKEN=...        # From BotFather
ALLOWED_USER_ID=123456789     # Your Telegram user ID
TZ=Europe/Berlin              # Critical for correct scheduling

# Optional
DB_PATH=meds.db               # SQLite database path (default: meds.db)
PORT=8080                     # HTTP port (default: 8080)

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
```

## Important Implementation Notes

### Database Migrations
- Migrations are in `internal/store/migrations/` numbered sequentially (001-016)
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

### Testing Patterns
- Store tests use in-memory SQLite (`:memory:`)
- Server tests use httptest for HTTP handlers
- BP reminders tests validate scheduling logic
- Workout tests cover rotation advancement and session state

## Common Tasks

### Adding a New Health Metric
1. Create migration in `internal/store/migrations/`
2. Add table methods to `internal/store/store.go`
3. Create HTTP handlers in `internal/server/`
4. Add bot commands in `internal/bot/`
5. Add frontend UI in `web/static/`
6. Add scheduler logic if reminders needed in `internal/scheduler/`

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
- `ARCHITECTURE.md` - Detailed system architecture and API endpoints
- `WORKOUT_TRACKING.md` - Complete workout feature specification
- `DEPLOY.md` - Deployment instructions
- `.env.mcp.example` - MCP server configuration example
