# Medication Tracker Bot

**Your health, in one place — on your server, on your terms.**

A self-hosted companion that lives in your Telegram chat and in your browser. It tracks your medications, your blood pressure, your weight, your workouts, your meals, your sleep — and hands the whole picture to your AI assistant when you ask for it. No SaaS lock-in. No ads. No one looking over your shoulder.

---

## The problem

Modern health tracking is a mess.

- Your meds are in one app. Your BP in another. Your weight somewhere else.
- Food logging quits on you after a week.
- Workout apps are either too rigid or too generic.
- Reminders start helpful and become noise.
- And your own data — the story of your own body — is locked inside products that do not talk to each other and that you do not actually own.

You are the only person with the full picture of your health. The tools should let you keep it that way.

## The idea

One private system you actually use every day.

- **Log in seconds** from the chat you already have open.
- **Get a real dashboard** when you want context, trends, and charts.
- **Keep your data at home**, in a single SQLite file you can back up, import, export, or hand to an AI model of your choice.
- **Replace the sprawl** with one place that covers the boring-but-important parts of everyday health.

If you lose your internet, the app still works. If you switch AI assistants, your data comes along. If you decide to move servers, you copy one file.

## Why it is different

- **Self-hosted.** Your data stays on your infrastructure. Always.
- **Two interfaces, one source of truth.** A fast Telegram bot for *"did I take it?"* moments. A polished web app for trends, planning, and deeper review.
- **Daily-use focus.** Snooze, skip, re-log, bulk-confirm — not just a static database.
- **Offline-first web app.** Log a BP reading on the subway; it syncs when you are back.
- **AI-ready, on your terms.** An optional MCP endpoint lets Claude (or any MCP-compatible assistant) read your health data with OAuth protection — only when *you* connect it.
- **Open to the world around it.** Apple Health imports, Mi Band / Mi Fitness ingestion, CSV exports, Open Food Facts lookup.

## What you get

**Today dashboard** — a read-only landing view that surfaces your greeting, next medication, latest blood pressure + 7-day trend, weight + 7-day trend, today's calories, next workout, and last night's sleep. Each card deep-links to the relevant tab for action.

**Medications** — scheduled, weekly, and as-needed doses · intake history · snooze, skip, log past · inventory with restocks and low-stock alerts · drug-interaction checks · CSV export.

**Blood pressure** — quick logging · goals · reminders · statistics · imports · CSV export.

**Weight** — logging · goals · EMA trend · weekly reminders · Libra-compatible CSV export.

**Workouts** — groups, variants, exercises, rotation (A/B/C/D splits like PPL or PHUL) · configurable notifications and snoozes · exercise-by-exercise logging from Telegram or the web · ad-hoc sessions · Mi Band and external feed ingestion.

**Food** — manual logging and saved meals · nutrition targets · Open Food Facts search · AI-assisted `/food` command that splits natural-language meals ("chicken breast with rice") into atomic items.

**Activity & body** — `/activity` command · sleep, heart rate, SpO2, stress, and daily steps in a unified Health overview.

**Diary** — free-text notes via `/note` or the web UI, automatically included as context for AI analysis.

**Delivery & fit-and-finish** — web push notifications · offline-first PWA · reorderable tabs · automatic timezone detection with user confirmation · Telegram WebApp auth or OIDC for browser access.

## Two ways to use it

### Telegram

The fastest interface for real life. Answer a reminder, log a reading, ask what's due next — all in the chat you already have open. Feature-specific commands disappear automatically when you turn that feature off. Workout sessions batch prompts so your chat never gets spammed.

### Web app

For when you want the bigger picture. Trends, history, editing, meal planning, workout design, settings. The shell is cached, feeds refresh in the background, and the most time-sensitive writes (BP, weight, medication confirmations) work offline and sync later.

## Your AI, your data

Want your assistant to analyze your blood pressure against your sleep and medications? Want a fitness summary that blends workouts, steps, nutrition, weight, and your own notes?

Run the optional MCP server. It is a separate process, OAuth-protected via Pocket-ID, and exposes tools for every category — plus two composite analysis tools that return cross-domain snapshots in a single call:

- `analyze_cardiovascular` — BP + medications + sleep + HR + SpO2 + diary notes
- `analyze_fitness` — workouts + steps + daily nutrition + weight + diary notes

Your diary notes ride along as context on every read, so the AI understands *why* a week looked the way it did.

Point Claude (or any MCP-compatible client) at your endpoint and you are done. Change models, change vendors, take everything home — whenever you want.

## Get it running

- **[Installation guide →](./docs/installer.md)** — one installer provisions the app, Traefik, Pocket-ID, and the optional MCP sidecar.
- Works from a published container image or your own build.

## Designed with security in mind

- Single-user allowlist via `ALLOWED_USER_ID`
- Telegram WebApp and Login Widget HMAC validation
- Optional OIDC browser auth with email/subject restrictions
- OAuth-protected MCP endpoint
- HMAC validation for MCP write-back and audit callbacks
- Optional bearer-token-protected external workout ingestion
- SQLite stays local to your deployment

---

## For contributors and operators

- **Contributors**: start with [CLAUDE.md](./CLAUDE.md) — it indexes the architecture, feature, API, frontend, and deployment docs under [docs/](./docs/).
- **License**: see [LICENSE](./LICENSE).
