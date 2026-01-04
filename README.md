# Medication Tracker Bot

A private, self-hosted Telegram Mini App for medication tracking, designed to replace mobile health apps.

## Features

- **Medication Management**: Add, edit, archive medications with custom dosages and schedules.
- **Dose History**:
    - **Smart Log**: Visually groups medications taken at the same time.
    - **Filters**: Filter history by date range (24h, 3d, 7d) and specific medication.
    - **Import**: Tool to import history from Apple Health (via "Health Auto Export" JSON).
- **Smart Scheduling**:
    - Supports Daily, Weekly, and As-Needed schedules.
    - **Active Periods**: Set Start and End dates for medication courses.
- **Intelligent Sorting**:
    - Meds sorted by: Scheduled Soon (>14h), Recently Taken, As-Needed (by usage), Archived.
- **Notifications**:
    - Telegram alerts with Scheduled Time and Dosage (e.g., `(08:20) - Med (10mg)`).
    - Reminders repeat every hour if not confirmed.
    - Respects Start/End dates to avoid false alerts.
- **Privacy & Security**:
    - **Authentication**: Telegram Web App validation + optional Google OIDC for browser access.
    - **Self-Hosted**: Your data stays on your server (SQLite).

## Chat Commands
- `/start` - Launch the Mini App.
- `/log` -  Log a dose for any medication (great for "As Needed" meds).
- `/help` - Show instructions.

## Configuration

The application is configured via Environment Variables:

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Your Telegram Bot Token obtained from BotFather |
| `ALLOWED_USER_ID` | Your Telegram User ID (integer). Only this user can access the bot. |
| `DB_PATH` | Path to SQLite DB (default: `meds.db`) |
| `PORT` | HTTP port (default: `8080`) |
| `TZ` | Timezone (e.g., `Europe/Berlin`). Critical for correct scheduling. |
| `GOOGLE_CLIENT_ID` | (Optional) For Google Login in browser |
| `GOOGLE_CLIENT_SECRET` | (Optional) For Google Login in browser |
| `GOOGLE_REDIRECT_URL` | (Optional) Callback URL (e.g., `https://your-domain.com/auth/google/callback`) |
| `ADMIN_EMAIL` | (Optional) Allow Google Login only for this email |

## Quick Start

### Docker Deployment (Recommended)

```yaml
version: '3'
services:
  medtracker:
    image: ghcr.io/korjavin/medicationtrackerbot:latest
    container_name: medtracker
    restart: unless-stopped
    volumes:
      - medtracker_data:/app/data
    environment:
      - TELEGRAM_BOT_TOKEN=your_token
      - ALLOWED_USER_ID=123456789
      - TZ=Europe/Berlin
      # Optional: Google Auth
      - GOOGLE_CLIENT_ID=...
      - GOOGLE_CLIENT_SECRET=...
      - GOOGLE_REDIRECT_URL=https://med.yourdomain.com/auth/google/callback
      - ADMIN_EMAIL=you@gmail.com
    labels:
      - "traefik.enable=true"
      # ... add your traefik labels here
```

### Local Development
1.  Clone repo.
2.  `go run ./cmd/bot`

### Importing Data
To import history from "Health Auto Export" (Apple Health):
1.  Export data to JSON.
2.  Place JSON file in project root.
3.  Run: `go run cmd/importer/main.go -file export.json -user <your_tg_id> -db meds.db`

## Security
- **Telegram Auth**: Validates `WebAppData` signature.
- **Google Auth**: OIDC flow for browser access outside Telegram.
- **Access Control**: Strict allowlist based on `ALLOWED_USER_ID` and `ADMIN_EMAIL`.
