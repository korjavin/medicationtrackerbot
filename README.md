# Medication Tracker

**Private health tracking that doesn't ask you to give up sync, reminders, chat, or AI to get it.**

Most privacy-first apps make you pay for privacy in convenience: no cross-device sync, notifications that don't really work, no assistant, a clunky shell. This one is built the other way around. Your health data is end-to-end encrypted and the keys live on *your* devices — and *because* of that, everything still works: real-time sync, reminders that actually fire, an optional Telegram chat, an installable PWA, and your own AI pointed at your own data.

You track medications, blood pressure, weight, workouts, meals, sleep, and notes in one place. The server running it can't read any of it.

---

## How it works: your devices hold the keys, the server holds a sealed blob

There are two kinds of place your data can live, and this app is careful about which is which.

- **Your devices** hold the keys and the plaintext. Encryption and decryption happen in your browser. A passkey — Face ID / fingerprint — unwraps a random data key that never leaves the device.
- **The server** holds only a sealed, encrypted blob. It's a *blind* sync-and-backup hub: it stores ciphertext, relays it between your devices, and rings your reminders on schedule — without ever holding the key to open any of it. A full breach, a subpoena, or a curious operator yields ciphertext and timing metadata, not your health.

This is what makes the convenience possible. Because your own devices can decrypt, you don't lose anything to the encryption:

- **Sync just works.** An encrypted oplog replicates every change across your devices. Add a reading on your phone, it's on your laptop.
- **It works offline.** Log a BP reading on the subway; it syncs when you're back.
- **Nothing is trapped.** Export the whole vault whenever you want and take it home.

## Reminders and Telegram — preserved, not sacrificed

The hard part of "the server can't read your data" is usually the stuff that *needs* to reach you: notifications and chat. Here's how each survives the encryption boundary intact.

- **Reminders via a blind push relay.** The server delivers your medication and workout reminders on schedule — but the reminder *content* is encrypted client-side before it's ever uploaded. The relay knows *when* to ring the alarm, not *what it's for*. It rings; your device decrypts and shows the real text.
- **Install it like an app.** The PWA installs to your home screen on iOS and Android, works offline, and receives web push — no app store, no separate build.
- **Optional Telegram chat.** Bring your own bot token and answer a reminder, log a reading, or ask what's due next in the chat you already have open. Inbound messages land in a sealed mailbox. It's off by default, and — unlike the vault — Telegram text crosses the relay in plaintext by design, so it's a clearly labeled opt-in, not the default path.

> Your vault and synced health records are end-to-end encrypted. Optional integrations you choose to turn on — Telegram, AI, food lookup — reach outside the vault and have separately disclosed boundaries in Settings.

## What you get

**Today dashboard** — a read-only landing view: greeting, next medication, latest blood pressure + 7-day trend, weight + 7-day trend, today's calories, next workout, last night's sleep. Each card deep-links into the section for action.

**Medications** — scheduled, weekly, and as-needed doses · intake history · snooze, skip, log past · inventory with restocks and low-stock alerts · drug-interaction checks · CSV export.

**Blood pressure** — quick logging · goals · reminders · statistics · imports · CSV export.

**Weight** — logging · goals · EMA trend · weekly reminders · Libra-compatible CSV export.

**Workouts** — groups, variants, exercises, rotation (A/B/C/D splits like PPL or PHUL) · configurable notifications and snoozes · exercise-by-exercise logging from Telegram or the web · ad-hoc sessions · Mi Band and external feed ingestion.

**Food** — manual logging and saved meals · nutrition targets · Open Food Facts search · AI-assisted `/food` that splits natural-language meals ("chicken breast with rice") into atomic items.

**Activity & body** — sleep, heart rate, SpO2, stress, and daily steps in a unified Vitals overview.

**Diary** — free-text notes via `/note` or the web UI, automatically included as context for AI analysis.

**Delivery & fit-and-finish** — web push · offline-first PWA · deep-link navigation · automatic timezone detection with confirmation.

## Current run modes

### Cloud (default) — zero-knowledge vault, passkey, PWA

A self-hosted **encrypted cloud** serves one installable PWA per user (their own subdomain). This is the production baseline and the place new product work lands. All health logic runs in the browser; every record is end-to-end encrypted.

- **Passkey-only unlock** — WebAuthn PRF unwraps a random 256-bit data key. No passwords, no server-side secret to crack.
- **Server sees only ciphertext + timing metadata** — health data, provider keys, and reminder content are all encrypted.
- **Encrypted sync + blind push relay** — an encrypted oplog syncs your devices; a blind relay delivers reminders it can't read.
- **Emergency Kit** — a high-entropy recovery code re-enrolls a new device if you lose all your others.
- **Bring your own keys** — AI, vision, voice, and food-DB keys live inside your vault and are called from your browser.
- **Optional Telegram** — bring your own bot token; inbound messages land in a sealed mailbox. Off by default.

Registration is invite-only. See [docs/cloud-mode.md](./docs/cloud-mode.md) and [docs/cloud-crypto.md](./docs/cloud-crypto.md).

### Legacy server mode — Telegram-native, MCP

The original mode: a single Go binary running the Telegram bot, web app, scheduler, and an optional OAuth-protected MCP endpoint against a local SQLite file you own outright. It remains documented for existing installs, but it is no longer the product default and should not be used as the baseline for new feature work.

- **Telegram** — the fastest interface for real life. Answer a reminder, log a reading, ask what's due next — in the chat you already have open.
- **Web app** — trends, history, editing, meal planning, workout design, settings. The shell is cached, feeds refresh in the background, and time-sensitive writes work offline and sync later.

See the [legacy server installation guide](./docs/installer.md).

## Your AI, your data

Want your assistant to analyze your blood pressure against your sleep and medications? A fitness summary blending workouts, steps, nutrition, weight, and your own notes?

In **cloud mode**, your AI runs in your browser against your own provider keys (stored inside the encrypted vault) — the operator never sees the prompt or the data. A shared trial key is available as a clearly disclosed opt-in if you'd rather not bring your own.

In **server mode**, run the optional MCP server — a separate, OAuth-protected process (Pocket-ID):

- `mcp_help` + `mcp_execute` — the recommended entry point. Discover backend operations, then run sandboxed Python against them, so multi-step analyses are one call.
- Granular read tools per category (`get_blood_pressure`, `get_weight`, …) and the `workout_log` write tool.
- Composite analyses: `analyze_cardiovascular` (BP + meds + sleep + HR + SpO2 + notes) and `analyze_fitness` (workouts + steps + nutrition + weight + notes).

Your diary notes ride along as context so the AI understands *why* a week looked the way it did. Point Claude (or any MCP client) at your endpoint — change models, change vendors, take everything home, whenever you want.

## Get it running

- **Cloud (encrypted PWA):** **[Cloud deployment →](./docs/cloud-deployment.md)** — the default deployment path. Stand up the zero-knowledge cloud (Traefik + wildcard cert + `cmd/cloud`), then mint an invite. Users open a URL and create a passkey.
- **Legacy server (Telegram + web + MCP):** **[Installation guide →](./docs/installer.md)** — maintained for existing single-user installs, not the default strategy.
- Works from a published container image or your own build.

## Security posture

- **Cloud mode is the production baseline:** zero-knowledge end-to-end encryption, passkey-only unlock (WebAuthn PRF over a random 256-bit key), blind push relay, encrypted oplog sync, Emergency Kit recovery, invite-only registration.
- **Legacy server mode** keeps everything on infrastructure you own: single-user allowlist, Telegram/OIDC auth, OAuth-protected MCP, local SQLite. It is kept working for existing operators but is no longer the default.

Full trust model, boundaries, and honest caveats: [docs/cloud-mode.md](./docs/cloud-mode.md#trust-model--what-the-server-can-and-cannot-see), [docs/cloud-crypto.md](./docs/cloud-crypto.md), and the [privacy audit](./docs/2026-07-12-gpt-5.6-sol-cloud-privacy-audit.md).

---

## For contributors and operators

- **Contributors**: start with [CLAUDE.md](./CLAUDE.md) — it indexes the architecture, feature, API, frontend, and deployment docs under [docs/](./docs/).
- **License**: see [LICENSE](./LICENSE).
