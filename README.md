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
    - **Drug Interactions**:
        - Automatically checks for interactions between your active medications using the [NLM RxNorm API](https://rxnav.nlm.nih.gov/).
        - Normalizes medication names (e.g., "Advil" -> "Ibuprofen") for accurate checking.
        - Warnings are displayed when adding or unarchiving medications.

- **Blood Pressure Tracking**:
    - Log blood pressure readings (systolic, diastolic, pulse).
    - Track 2-3x daily for accurate monitoring.
    - View history, statistics, and trends.
    - Export to CSV for analysis.
    - BP categories based on AHA guidelines.

## Chat Commands

### Medication Commands
- `/start` - Launch the Mini App.
- `/log` - Log a dose for any medication (great for "As Needed" meds).
- `/help` - Show instructions.

### Blood Pressure Commands
- `/bp <systolic> <diastolic> [pulse]` - Log blood pressure reading.
  - Example: `/bp 130 80 72` (130/80 mmHg, 72 bpm pulse)
- `/bphistory` - View blood pressure history.
- `/bpstats` - View blood pressure statistics (averages, trends).
- `/bpexport` - Export blood pressure data to CSV.

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

### Web Interface

Access the web interface at `http://localhost:8080` (or your domain when deployed). The interface includes:

- **Medications** - Manage your medications and schedules.
- **History** - View dose history with filters.
- **Blood Pressure** - Blood pressure tracking dashboard.

### Importing Data

#### Medication History (Apple Health)
To import history from "Health Auto Export" (Apple Health):
1.  Export data to JSON.
2.  Place JSON file in project root.
3.  Run: `go run cmd/importer/main.go -file export.json -user <your_tg_id> -db meds.db`

#### Blood Pressure (CSV)
To import blood pressure data from CSV:
1.  CSV format: `date,time,systolic,diastolic,pulse`
2.  Run: `go run cmd/bpimporter/main.go -file bp_data.csv -db meds.db`

Example CSV format:
```csv
date,time,systolic,diastolic,pulse
2024-01-15,08:30,120,80,72
2024-01-15,20:15,118,78,70
```

### Blood Pressure Categories (AHA Guidelines)

| Category | Systolic (mmHg) | Diastolic (mmHg) |
|----------|-----------------|------------------|
| Normal | < 120 | < 80 |
| Elevated | 120-129 | < 80 |
| High BP Stage 1 | 130-139 | 80-89 |
| High BP Stage 2 | ≥ 140 | ≥ 90 |
| Hypertensive Crisis | > 180 | > 120 |

## Security
- **Telegram Auth**: Validates `WebAppData` signature.
- **Google Auth**: OIDC flow for browser access outside Telegram.
- **Access Control**: Strict allowlist based on `ALLOWED_USER_ID` and `ADMIN_EMAIL`.
