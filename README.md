# Medication Tracker Bot

Self-hosted Telegram bot plus local-first web app for personal health tracking.

It stores everything in SQLite, can run with or without Telegram, and exposes an optional OAuth-protected MCP sidecar for AI read access to your data.

## What it does today

- Medication tracking with scheduled, weekly, and as-needed doses
- Medication intake history, snoozing, skipping, past logging, and CSV export
- Inventory tracking with restocks and low-stock alerts
- Blood pressure logging, goals, reminders, stats, import, and CSV export
- Weight logging, goals, reminders, trend tracking, and CSV export
- Workout planning with groups, variants, exercises, rotation, and workout reminders
- Workout session logging from Telegram and the web UI, including ad-hoc sessions
- Mi Band and external workout ingestion through `/api/workout/external`
- Food logging, daily targets, saved meals, product database, and Open Food Facts search
- AI-assisted `/food` and `/activity` commands through an OpenAI-compatible API
- Health overview for sleep, heart rate, SpO2, stress, and steps
- Web push notifications and offline-first PWA behavior
- Browser auth through Telegram WebApp validation or OIDC
- Optional MCP server for querying health data and writing food logs via MCP

## Interfaces

### Telegram

The bot remains the fastest way to log data and receive reminders.

Current commands include:

- `/start`
- `/help`
- `/log`
- `/next`
- `/stock`
- `/download`
- `/bp <systolic> <diastolic> [pulse]`
- `/bphistory`
- `/bpstats`
- `/bpgoal <systolic> <diastolic>`
- `/weight <kg>`
- `/weighthistory`
- `/goal <weight> <date>`
- `/workout`
- `/startnext`
- `/workoutstatus`
- `/workouthistory`
- `/intake <carbs> <protein> <fat> <weight> [name]`
- `/food <description>` when AI is configured
- `/activity <description>` when AI is configured

Feature-specific commands are hidden automatically when that feature is disabled in settings.

### Web app

The web app is a local-first PWA served by the Go server.

- Cached shell with background refresh
- Offline create/update flows for key tracking actions
- Web push subscription management
- Per-feature toggles for medications, blood pressure, weight, workouts, food, and health
- Reorderable tabs
- Real-time refresh through `/api/changes` and `/api/changes/stream`

## Architecture

- `cmd/bot/main.go`: main application entrypoint
- `cmd/mcptool/main.go`: standalone MCP HTTP server
- `internal/server`: HTTP handlers, auth, PWA serving, and APIs
- `internal/bot`: Telegram commands, callbacks, and notification flows
- `internal/store`: SQLite persistence and migrations
- `web/static`: web UI, PWA assets, and frontend tests

The main app can run in:

- Web-only mode: omit `TELEGRAM_BOT_TOKEN`
- Bot + web mode: set Telegram credentials

## Runtime requirements

- Go `1.26.1`
- Node.js only if you want to run frontend tests
- SQLite database file on local disk

## Local development

### Run the main app

Minimal environment:

```bash
export SESSION_SECRET="$(openssl rand -base64 32)"
export ALLOWED_USER_ID="<your telegram user id>"
export TZ="Europe/Berlin"
```

Optional but commonly needed:

```bash
export TELEGRAM_BOT_TOKEN="<bot token>"
export DB_PATH="meds.db"
export PORT="8080"
```

Start the app:

```bash
go run ./cmd/bot
```

If `TELEGRAM_BOT_TOKEN` is unset, the app starts in web-only mode.

### Run tests

Backend:

```bash
go test ./...
```

Frontend:

```bash
npm test
```

## Main application configuration

### Required

| Variable | Description |
|---|---|
| `SESSION_SECRET` | Secret used to sign browser sessions |
| `ALLOWED_USER_ID` | Single allowed Telegram user ID; also used as the logical app user ID |

### Core runtime

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token; omit for web-only mode |
| `DB_PATH` | SQLite database path, default `meds.db` |
| `PORT` | HTTP port, default `8080` |
| `TZ` | App timezone used by scheduling logic |
| `AUTH_TRUST_PROXY` | Trust forwarding headers for rate limiting, default `true` |

### OIDC and browser login

| Variable | Description |
|---|---|
| `OIDC_ISSUER_URL` | OIDC issuer URL |
| `OIDC_CLIENT_ID` | OIDC client ID |
| `OIDC_CLIENT_SECRET` | OIDC client secret |
| `OIDC_REDIRECT_URL` | OIDC callback URL |
| `OIDC_ADMIN_EMAIL` | Optional allowed email |
| `OIDC_ALLOWED_SUBJECT` | Optional allowed OIDC subject |
| `OIDC_SCOPES` | Optional custom scopes; defaults to `openid email profile` |
| `OIDC_USERINFO_URL` | Optional explicit userinfo URL |
| `OIDC_AUTH_URL` | Optional explicit auth URL |
| `OIDC_TOKEN_URL` | Optional explicit token URL |
| `OIDC_BUTTON_LABEL` | Optional login button label override |
| `OIDC_BUTTON_COLOR` | Optional login button color override |
| `OIDC_BUTTON_TEXT_COLOR` | Optional login button text color override |
| `POCKET_ID_CLIENT_ID` | Fallback client ID for web login when `OIDC_CLIENT_ID` is unset |
| `POCKET_ID_CLIENT_SECRET` | Fallback client secret for web login when `OIDC_CLIENT_SECRET` is unset |
| `POCKET_ID_DOMAIN` | Used to swap to the internal Pocket ID URL inside the Docker stack |
| `GOOGLE_CLIENT_ID` | Legacy Google login support |
| `GOOGLE_CLIENT_SECRET` | Legacy Google login support |
| `GOOGLE_REDIRECT_URL` | Legacy Google login support |
| `ADMIN_EMAIL` | Legacy Google allowlist and VAPID admin email fallback |

### Notifications and integrations

| Variable | Description |
|---|---|
| `VAPID_PUBLIC_KEY` | Web push public key |
| `VAPID_PRIVATE_KEY` | Web push private key |
| `VAPID_SUBJECT` | Web push subject |
| `DOMAIN` | Primary app domain, used in notification and setup flows |
| `APP_DOMAIN` | Alternate app domain variable used by setup pages |
| `EXTERNAL_WORKOUT_API_KEY` | Bearer token required by `/api/workout/external` |

### AI features

Any of the variables below enable the OpenAI-compatible client; all three can be used together.

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | API key for AI food and activity parsing |
| `OPENAI_URL` | Base URL, default `https://api.openai.com/v1` |
| `OPENAI_MODEL` | Model name, default `gpt-4o-mini` |

### Tuning

| Variable | Description |
|---|---|
| `FOOD_SEARCH_CACHE_MB` | In-memory cache size for food product search responses, default `40` |
| `CHANGES_STREAM_MAX_CONN` | Max concurrent `/api/changes/stream` connections, default `40` |

## MCP server

The MCP server is a separate process that serves health data over HTTP with OAuth protection.

Start it with:

```bash
go run ./cmd/mcptool
```

### MCP configuration

| Variable | Description |
|---|---|
| `MCP_DATABASE_PATH` | SQLite path for the MCP process; required |
| `POCKET_ID_URL` | OAuth issuer used by the MCP server; required |
| `POCKET_ID_CLIENT_ID` | Pocket ID OIDC client ID; required for OAuth login |
| `POCKET_ID_CLIENT_SECRET` | Pocket ID OIDC client secret |
| `MCP_SERVER_URL` | Public MCP base URL; required |
| `ALLOWED_USER_ID` | Data is queried for this app user ID |
| `MCP_PORT` | HTTP port, default `8081` |
| `MCP_ALLOWED_SUBJECT` | Optional subject allowlist |
| `MCP_MAX_QUERY_DAYS` | Max date-range window, default `90` |
| `POCKET_ID_JWKS_JSON` | Optional JWKS fallback |
| `MCP_AUDIT_ENDPOINT` | Optional audit sink on the main app |
| `MCP_AUDIT_SECRET` | HMAC secret for MCP audit and MCP write-through |

### MCP tools

The server currently exposes tools for:

- Blood pressure
- Weight
- Medication intake history
- Workout history
- Sleep logs
- Food intake
- Daily steps
- Health overview
- Heart rate, SpO2, and stress vitals
- Food logging write-through when audit/write-back is configured

## Data import and export

### Medication history import

Imports Apple Health JSON exported by Health Auto Export:

```bash
go run ./cmd/importer -file export.json -user "<telegram user id>" -db meds.db
```

### Blood pressure import

Imports CSV in `date,time,systolic,diastolic,pulse` format:

```bash
go run ./cmd/bpimporter -file bp_data.csv -db meds.db
```

### Exports

- Telegram `/download` exports medication, blood pressure, and weight history
- Web APIs expose blood pressure and weight CSV export endpoints

## Deployment

For production deployment, use the installer or the published container image.

- Quick guide: [install.md](./install.md)
- Detailed walkthrough: [docs/installer.md](./docs/installer.md)

The installer can provision:

- The main app container
- Traefik
- Pocket ID
- An optional MCP sidecar

## Security model

- Single-user allowlist enforced with `ALLOWED_USER_ID`
- Telegram WebApp and Telegram Login Widget validation
- Optional OIDC browser auth with email and/or subject restriction
- OAuth-protected MCP endpoint
- HMAC validation for MCP write-back and audit callbacks
- Optional external workout ingestion protected by bearer token
- SQLite stays local to your deployment
