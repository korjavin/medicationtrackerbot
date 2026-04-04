# Medication Tracker Bot

Self-hosted Telegram bot plus local-first web app for personal health tracking.

It stores everything in SQLite, can run with or without Telegram, and exposes an optional OAuth-protected MCP sidecar for AI read access to your data.

## Why it exists

Most health tracking breaks down in the same way:

- Medications live in one app
- Blood pressure and weight live in another
- Food is annoying to log consistently
- Workouts are either too manual or too generic
- Reminders are noisy until you ignore them
- Your own data is trapped in products that do not work together

Medication Tracker Bot is meant to replace that sprawl with one private system you actually keep using.

It gives you a single place to track the boring but important parts of everyday health, without forcing you into someone else's cloud, subscription, or workflow.

## Why this is different

- It is self-hosted, so your health data stays on your infrastructure
- It works both as a Telegram bot and as a local-first web app
- It is built for daily use, not just occasional dashboards
- It handles reminders, snoozes, skips, and follow-through instead of just storing numbers
- It is open to imports, external device feeds, and AI workflows instead of locking data away

## What you get

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

Telegram is the fastest interface for real life: logging something quickly, responding to a reminder, or checking what is due next.

It supports quick commands for medications, blood pressure, weight, workouts, food, exports, and other everyday actions. Feature-specific commands are hidden automatically when that feature is disabled in settings.

### Web app

The web app is for when you want more context: trends, history, editing, planning workouts, food logs, and settings.

- Cached shell with background refresh
- Offline create/update flows for key tracking actions
- Web push subscription management
- Per-feature toggles for medications, blood pressure, weight, workouts, food, and health
- Reorderable tabs
- Real-time refresh through `/api/changes` and `/api/changes/stream`

## MCP server

If you want your AI assistant to query your health data directly, run the MCP server as a separate process. It is optional and OAuth-protected.

This means you can analyze your data with commercial models, local models, or any MCP-compatible client you prefer. The point is freedom: your data stays yours, and your AI layer is not tied to a single vendor.

It currently exposes tools for:

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

There are multiple ways to bring existing data in, including Apple Health exports, blood pressure imports, and Mi Band software integrations such as Mi Fitness or Mi Notify backups for sleep, vitals, day stats, and outdoor workouts.

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
