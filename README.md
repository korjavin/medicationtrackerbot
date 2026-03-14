# Medication Tracker Bot

A private, self-hosted Telegram Mini App for comprehensive health tracking, designed to replace mobile health apps.

## The Philosophy: From Fragmented Data to Personal Health Intelligence

We built this because health data was everywhere—and nowhere. Medications, blood pressure, weight, and sleep required different apps that didn't talk to each other.

**MedTrackerBot** unifies this experience:
1.  **The Hub**: A single source of truth for all your health metrics.
2.  **Second Memory**: Proactive notifications for meds and workouts, so you don't have to carry the mental load.
3.  **Interface Choice**: A rich local-first Web App for data lovers, and a distraction-free Chat Interface for minimalists.
4.  **Simplicity**: Bring your own data (importers included) and keep your favorite tools (like Mi Band).
5.  **True Ownership**: Self-hosted, single-database ownership with optional, vendor-lock-free backups.
6.  **Intelligence**: Built-in AI integration (MCP) to turn your data into plain-English insights.

## Features

- **Food Intake Tracking**:
    - **Open Food Facts Integration**: Scan or search for products to get nutritional data automatically.
    - **Macro Tracking**: Monitor Calories, Proteins, Fats, and Carbs.
    - **Daily Targets**: Set and track nutritional goals.
- **Workout Tracking**:
    - **Hierarchical Structure**: Groups → Variants → Exercises.
    - **Smart Schedules**: Rotating (PPL, PHUL) and non-rotating schedules.
    - **Live Guidance**: Exercise-by-exercise logging via Telegram.
    - **Performance Stats**: Streak tracking and completion analytics.
- **Web App Features**:
    - **Local First (PWA)**: UI renders instantly from cache; fresh data loads in the background. Blood pressure, weight, and medication confirmations can be recorded offline and sync automatically when connectivity returns.
    - **Push Notifications**: Receive medication and workout reminders directly on your device.
    - **Responsive Design**: Optimized for both mobile and desktop browsers.
- **Medication Management**: Add, edit, archive medications with custom dosages and schedules.
- **Dose History**:
    - **Smart Log**: Visually groups medications taken at the same time.
    - **Filters**: Filter history by date range (24h, 3d, 7d) and specific medication.
    - **Import**: Tool to import history from Apple Health (via "Health Auto Export" JSON).
- **Smart Scheduling**:
    - Supports Daily, Weekly, and As-Needed schedules.
    - **Active Periods**: Set Start and End dates for medication courses.
- **Intelligent Sorting**:
    - Meds sorted by: Pending Now, Recently Taken, As-Needed (by usage), Archived.
- **Notifications**:
    - Telegram alerts and **Web Push Notifications**.
    - Reminders repeat every hour if not confirmed.
- **Privacy & Security**:
    - **Authentication**: Telegram Web App validation + Passkeys/OIDC for browser access.
    - **Self-Hosted**: Your data stays on your server (SQLite).
    - **Drug Interactions**: Automatic checks using NLM RxNorm API.

- **Blood Pressure Tracking**:
    - Log readings, track trends, and export to CSV.
    - BP classification based on ISH 2020 guidelines.

- **Weight Tracking**:
    - Log weight with automatic trend calculation (EMA).
    - Weekly reminders and CSV export.

## Chat Commands

### Medication Commands
- `/start` - Launch the Mini App.
- `/log` - Log a dose for any medication (great for "As Needed" meds).
- `/download` - Export medication, blood pressure, and weight history to CSV (select time period).
- `/help` - Show instructions.

### Blood Pressure Commands
- `/bp <systolic> <diastolic> [pulse]` - Log blood pressure reading.
  - Example: `/bp 130 80 72` (130/80 mmHg, 72 bpm pulse)
- `/bphistory` - View blood pressure history.
- `/bpstats` - View blood pressure statistics (averages, trends).
- **Reminder Management**: When you receive a BP reminder, you can snooze it for 2 hours or block reminders for 24 hours via Telegram callback buttons.

### Weight Commands
- `/weight <kg>` - Log weight in kilograms.
  - Example: `/weight 75.5`
- `/weighthistory` - View recent weight history (last 10 entries).
- **Reminder Management**: When you receive a weight reminder, you can snooze it for 2 hours or block reminders for 24 hours via Telegram callback buttons.

## Configuration

The application is configured via Environment Variables:

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Your Telegram Bot Token obtained from BotFather |
| `ALLOWED_USER_ID` | Your Telegram User ID (integer). Only this user can access the bot. |
| `DB_PATH` | Path to SQLite DB (default: `meds.db`) |
| `PORT` | HTTP port (default: `8080`) |
| `TZ` | Timezone (e.g., `Europe/Berlin`). Critical for correct scheduling. |
| `SESSION_SECRET` | Secret used to sign web auth sessions |
| `AUTH_TRUST_PROXY` | (Optional) Trust `X-Forwarded-For` / `X-Real-IP` headers for rate limiting (default: `true`) |
| `EXTERNAL_WORKOUT_API_KEY` | (Optional) Required to use the `/api/workout/external` webhook (e.g. from Mi Notify) |
| `GOOGLE_CLIENT_ID` | (Optional, legacy) For Google Login in browser |
| `GOOGLE_CLIENT_SECRET` | (Optional, legacy) For Google Login in browser |
| `GOOGLE_REDIRECT_URL` | (Optional, legacy) Callback URL (e.g., `https://your-domain.com/auth/google/callback`) |
| `ADMIN_EMAIL` | (Optional, legacy) Allow Google Login only for this email |
| `OIDC_ISSUER_URL` | (Optional) OIDC issuer URL (e.g., `https://id.yourdomain.com`) |
| `OIDC_CLIENT_ID` | (Optional) OIDC client ID |
| `OIDC_CLIENT_SECRET` | (Optional) OIDC client secret |
| `OIDC_REDIRECT_URL` | (Optional) Callback URL (e.g., `https://your-domain.com/auth/oidc/callback`) |
| `OIDC_ADMIN_EMAIL` | (Optional) Allow OIDC login only for this email |
| `OIDC_ALLOWED_SUBJECT` | (Optional) Allow OIDC login only for this subject (`sub`) |
| `OIDC_BUTTON_LABEL` | (Optional) Override OIDC login button label |
| `OIDC_BUTTON_COLOR` | (Optional) Override OIDC login button background color |
| `OIDC_BUTTON_TEXT_COLOR` | (Optional) Override OIDC login button text color |
| `OIDC_SCOPES` | (Optional) Comma/space-separated scopes (default: `openid email profile`) |
| `OIDC_USERINFO_URL` | (Optional) Override userinfo URL if discovery is not available |
| `OIDC_AUTH_URL` | (Optional) Override authorization endpoint |
| `OIDC_TOKEN_URL` | (Optional) Override token endpoint |

## Quick Start

### Easy Installer (Recommended)

The easiest way to get started is with our **Automatic Installer**. It automates the complex parts (Docker, SSL certificates, Nginx/Traefik configuration), asking you simple questions to customize your setup.

#### Prerequisites

1. **A Linux Server (VPS)**
   You need a server running **Ubuntu**, **Debian**, **Fedora**, or **CentOS**.
   - **Recommended**: Ubuntu 22.04 LTS or 24.04 LTS.
   - **Hardware**: Only 1 CPU and 1GB RAM needed (very lightweight).
   - **Public IP**: You need a public IPv4 address.
   - **Firewall**: Ports `80` (HTTP) and `443` (HTTPS) must be open.
   - *Note on sharing:* We strongly advise using a dedicated server (VPS) for privacy and security of your medical data.

2. **A Domain Name**
   You need a domain name to access your tracker securely (HTTPS). Any domain you own works perfectly.
   Log in to your domain registrar and create **A Records** pointing to your server's IP address (e.g., one for the main app `meds`, optionally one for `id` if using Pocket-ID, and `mcp` if using Claude MCP).

3. **Telegram Bot Token**
   - Open [@BotFather](https://t.me/BotFather) and send `/newbot` to get your token.
   - Send `/mybots`, select your bot, tap **Bot Settings**, then **Domain**, and enter your app's domain (e.g., `meds.example.com`).

4. **Your Telegram User ID**
   - Open [@userinfobot](https://t.me/userinfobot) and copy your numeric ID. This ensures the bot only responds to you.

#### Installation

SSH into your server and run this single command to start the interactive wizard:

```bash
wget -qO- https://github.com/korjavin/medicationtrackerbot/releases/download/v0.1.7/medtracker-installer_linux_amd64.tar.gz | tar xvz && ./medtracker-installer
```

#### The Interactive Walkthrough
The installer will ask you a series of questions. We generally recommend accepting the default values (just press Enter).
- **Install Directory**: Default (`/opt/medtracker`).
- **Primary Domain**: Enter your domain (e.g., `meds.example.com`).
- **HTTPS & Traefik**: Choose **Yes** to handle SSL certificates automatically.
- **Timezone**: Enter your timezone (e.g., `America/New_York`) for accurate reminders.
- **Telegram Configuration**: Paste your Bot Token and User ID.
- **Browser Login (Optional)**: Choose **Yes** to set up Pocket-ID for web login.
- **Litestream Backups (Optional)**: Enable for real-time streaming backups to Cloudflare R2.

#### Post-Installation Steps

1. **Configure DNS**: Ensure A Records point to your server IP for your primary domain and Pocket-ID domain (if installed).
2. **Configure Telegram Bot Domain**: Ensure your bot domain is set in BotFather as instructed in Prerequisites.
3. **Log In**: Open your domain in your browser or launch the bot in Telegram.
4. **Configure Pocket-ID (If Installed)**:
   - Open `https://id.yourdomain.com/setup` and create your Admin account with a Passkey.
   - To log in from a new browser, generate a one-time code on your server: `cd /opt/medtracker && docker compose exec pocket-id ./pocket-id one-time-access-token --email admin@example.com`
   - Open the generated URL to log in and register your Passkey.
   - To enable web login, create an OIDC Client in Pocket-ID (Redirect URI: `https://meds.yourdomain.com/auth/oidc/callback`), copy the Client ID and Secret, update `/opt/medtracker/.env`, and restart with `docker compose up -d`.

#### Troubleshooting

- **"Client version 1.24 is too old"**: Update your Docker version using the installer's printed instructions.
- **"Permission Denied"**: Make sure you run the installer as `root`.
- **"502 Bad Gateway"**: Wait 30-60 seconds for containers to start. Check logs with `cd /opt/medtracker && docker compose logs -f`.

### Web Interface

Access the web interface at your domain (or `http://localhost:8080` locally). The interface is a **Progressive Web App (PWA)** that supports offline access and push notifications.

- **Medications** - Manage medications and intake history.
- **Food Intake** - Log meals via Open Food Facts search.
- **Workouts** - Plan and track exercise progress.
- **Blood Pressure & Weight** - Dashboards with trends and statistics.

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

### Backups & Recovery (Litestream)

The bot includes [Litestream](https://litestream.io/) for real-time SQLite replication to Cloudflare R2 (or any S3-compatible storage).

#### Restore Database from Backup
To restore your database from the cloud using environment variables from your `.env` or current session:

```bash
docker run --rm \
  -e LITESTREAM_ACCESS_KEY_ID=$LITESTREAM_ACCESS_KEY_ID \
  -e LITESTREAM_SECRET_ACCESS_KEY=$LITESTREAM_SECRET_ACCESS_KEY \
  -e R2_ENDPOINT=$R2_ENDPOINT \
  -e R2_BUCKET=$R2_BUCKET \
  -v $(pwd):/app/data \
  --entrypoint /bin/sh \
  litestream/litestream:latest \
  -c 'cat <<EOF > /tmp/litestream.yml
dbs:
  - path: /app/data/meds.db
    replicas:
      - type: s3
        bucket: $R2_BUCKET
        path: medtracker
        endpoint: $R2_ENDPOINT
EOF
litestream restore -config /tmp/litestream.yml -o /app/data/meds.db /app/data/meds.db'
```

### Blood Pressure Classification (ISH 2020 Guidelines)

The app uses **ISH 2020 (International Society of Hypertension)** guidelines for blood pressure classification, configured for users under 65 years.

| Category | Systolic (mmHg) | | Diastolic (mmHg) |
|----------|-----------------|---|------------------|
| Normal | < 130 | and | < 85 |
| High-normal | 130-139 | and/or | 85-89 |
| Grade 1 Hypertension | 140-159 | and/or | 90-99 |
| Grade 2 Hypertension | ≥ 160 | and/or | ≥ 100 |

**Treatment Target (< 65 years):** < 130/80 mmHg if tolerated

## Security
- **Telegram Auth**: Validates `WebAppData` signature.
- **Google Auth**: OIDC flow for browser access outside Telegram.
- **Access Control**: Strict allowlist based on `ALLOWED_USER_ID` and `ADMIN_EMAIL`.
