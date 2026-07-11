# Medication Tracker

**Your health, in one place — end-to-end encrypted, on your terms.**

A private health companion that runs as an installable browser app (PWA) backed by a **zero-knowledge cloud**: the server stores only ciphertext, unlock is a passkey, and the operator is *cryptographically unable* to read your data. It tracks your medications, your blood pressure, your weight, your workouts, your meals, your sleep — and hands the whole picture to your AI assistant when you ask for it. No SaaS lock-in. No ads. No one looking over your shoulder — not even the person running the server.

Prefer a chat-native experience or full server control? A self-hosted **server mode** with a Telegram bot and web app is still here — see [Two ways to run it](#two-ways-to-run-it).

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

One private system you actually use every day — with no one else able to read it.

- **Install in seconds** from one URL. Create a passkey (Face ID / fingerprint), save your Emergency Kit, add to home screen. Done.
- **Encrypt on your device.** Every record is encrypted client-side before it leaves your browser. The server sees ciphertext and timing metadata — nothing else.
- **Get a real dashboard** when you want context, trends, and charts.
- **Sync across devices** through an encrypted oplog, with reminders delivered by a *blind* push relay that rings the alarm without knowing what it's for.
- **Bring your own everything** — your own AI keys, your own data, and (optionally) your own Telegram bot. Take it all home whenever you want.

If you lose your internet, the app still works. If you switch AI assistants, your data comes along.

## Why it is different

- **Zero-knowledge by design.** A full server breach, subpoena, or malicious operator yields ciphertext, not your health. Unlock is passkey-only (WebAuthn PRF over a random key) — there's no passphrase to steal and no server-side secret to crack.
- **Self-hosted, either way.** Run the encrypted cloud for yourself and others, or the classic single-user server. Your data stays on infrastructure *you* control.
- **Daily-use focus.** Snooze, skip, re-log, bulk-confirm — not just a static database.
- **Offline-first.** Log a BP reading on the subway; it syncs when you are back.
- **AI-ready, on your terms.** Point your own assistant at your data — in the cloud PWA via your own provider keys, or via an optional OAuth-protected MCP endpoint in server mode. Only when *you* connect it.
- **Open to the world around it.** Apple Health imports, Mi Band / Mi Fitness ingestion, CSV exports, Open Food Facts lookup.

## What you get

**Today dashboard** — a read-only landing view that surfaces your greeting, next medication, latest blood pressure + 7-day trend, weight + 7-day trend, today's calories, next workout, and last night's sleep. Each card deep-links to the relevant section for action.

**Medications** — scheduled, weekly, and as-needed doses · intake history · snooze, skip, log past · inventory with restocks and low-stock alerts · drug-interaction checks · CSV export.

**Blood pressure** — quick logging · goals · reminders · statistics · imports · CSV export.

**Weight** — logging · goals · EMA trend · weekly reminders · Libra-compatible CSV export.

**Workouts** — groups, variants, exercises, rotation (A/B/C/D splits like PPL or PHUL) · configurable notifications and snoozes · exercise-by-exercise logging from Telegram or the web · ad-hoc sessions · Mi Band and external feed ingestion.

**Food** — manual logging and saved meals · nutrition targets · Open Food Facts search · AI-assisted `/food` command that splits natural-language meals ("chicken breast with rice") into atomic items.

**Activity & body** — `/activity` command · sleep, heart rate, SpO2, stress, and daily steps in a unified Health overview.

**Diary** — free-text notes via `/note` or the web UI, automatically included as context for AI analysis.

**Delivery & fit-and-finish** — web push notifications · offline-first PWA · Today dashboard as home with deep-link navigation · automatic timezone detection with user confirmation · Telegram WebApp auth or OIDC for browser access.

## Two ways to run it

### Cloud (recommended) — zero-knowledge, passkey, PWA

The default. A self-hosted **encrypted cloud** serves one static PWA per user (their own subdomain); all health logic runs in the browser and every record is end-to-end encrypted. Highlights:

- **Passkey-only unlock** — WebAuthn PRF unwraps a random data key; no passwords anywhere.
- **Operator sees only ciphertext** — health data, provider keys, and reminder *content* are all encrypted; the server learns only metadata (account exists, blob sizes, when reminders fire — not what they say).
- **Encrypted sync + blind push relay** — an encrypted oplog syncs your devices; a blind relay delivers web-push reminders it can't read.
- **Emergency Kit** — a high-entropy recovery code re-enrolls a new device if you lose all your others.
- **Bring your own keys** — OpenAI-compatible AI, vision, ElevenLabs, and food-DB keys live inside your vault and are called directly from your browser.
- **Optional Telegram** — bring your own bot token for chat reminders; inbound messages land in a sealed mailbox. Off by default.

Registration is invite-only (the operator mints accounts). See [docs/cloud-mode.md](./docs/cloud-mode.md) and [docs/cloud-crypto.md](./docs/cloud-crypto.md).

### Server (legacy) — single-user, Telegram-native, MCP

The original mode: a single Go binary running the Telegram bot, web app, scheduler, and an optional OAuth-protected MCP endpoint against a local SQLite file you own outright.

- **Telegram** — the fastest interface for real life. Answer a reminder, log a reading, ask what's due next — in the chat you already have open. Feature-specific commands disappear when you turn a feature off, and workout sessions batch prompts so your chat never gets spammed.
- **Web app** — trends, history, editing, meal planning, workout design, settings. The shell is cached, feeds refresh in the background, and time-sensitive writes (BP, weight, medication confirmations) work offline and sync later.

See the [installation guide](./docs/installer.md).

## Your AI, your data

Want your assistant to analyze your blood pressure against your sleep and medications? Want a fitness summary that blends workouts, steps, nutrition, weight, and your own notes?

In **cloud mode**, your AI runs in your browser against your own provider keys (stored inside the encrypted vault) — the operator never sees the prompt or the data.

In **server mode**, run the optional MCP server. It is a separate process, OAuth-protected via Pocket-ID, and exposes:

- `mcp_help` and `mcp_execute` — the recommended entry point. The assistant discovers backend operations with `mcp_help` and runs sandboxed Python scripts against them with `mcp_execute`, so multi-step analyses ("look up my last workout, then summarize the week") are one call instead of many.
- Granular read tools per category (`get_blood_pressure`, `get_weight`, `get_medication_intake`, …) and the `workout_log` write tool for clients that don't run scripts.
- Two composite analysis tools that return cross-domain snapshots in a single call:
  - `analyze_cardiovascular` — BP + medications + sleep + HR + SpO2 + diary notes
  - `analyze_fitness` — workouts + steps + daily nutrition + weight + diary notes

Your diary notes ride along as context on every read, so the AI understands *why* a week looked the way it did.

Point Claude (or any MCP-compatible client) at your endpoint and you are done. Change models, change vendors, take everything home — whenever you want.

## Get it running

- **Cloud (encrypted PWA):** **[Cloud deployment →](./docs/cloud-deployment.md)** — stand up the zero-knowledge cloud (Traefik + wildcard cert + `cmd/cloud`), then mint an invite. Users just open a URL and create a passkey.
- **Server (Telegram + web + MCP):** **[Installation guide →](./docs/installer.md)** — one installer provisions the app, Traefik, Pocket-ID, and the optional MCP sidecar.
- Works from a published container image or your own build.

## Designed with security in mind

**Cloud mode — zero-knowledge:**
- End-to-end encryption: records are encrypted client-side; the server stores only ciphertext + timing metadata
- Passkey-only unlock (WebAuthn PRF over a random 256-bit data key) — no passwords, no server-side crackable secret
- Per-user subdomains, wildcard cert (names never hit Certificate Transparency logs)
- Blind push relay (delivers encrypted reminders it cannot read) and encrypted oplog sync
- Emergency Kit recovery code; invite-only registration
- *Honest caveat:* web-delivered crypto can't defend against a hostile origin serving poisoned JS — mitigated by pinned service-worker bundles and, for the strongest guarantees, the Capacitor store build against the same cloud. See [docs/cloud-mode.md](./docs/cloud-mode.md#trust-model--what-the-server-can-and-cannot-see).

**Server mode:**
- Single-user allowlist via `ALLOWED_USER_ID`
- Telegram WebApp and Login Widget HMAC validation
- Optional OIDC browser auth with email/subject restrictions
- OAuth-protected MCP endpoint; HMAC validation for MCP write-back and audit callbacks
- Optional bearer-token-protected external workout ingestion
- SQLite stays local to your deployment

---

## For contributors and operators

- **Contributors**: start with [CLAUDE.md](./CLAUDE.md) — it indexes the architecture, feature, API, frontend, and deployment docs under [docs/](./docs/).
- **License**: see [LICENSE](./LICENSE).
