# Telemetry

**Telemetry is OFF by default.** Nothing is sent unless you explicitly enable it.

MedTracker can optionally send anonymous, aggregate usage telemetry to the maintainer's central server. This page is the contract: what it collects, what it never collects, how to turn it on, how to turn it off, and how long the data is kept.

If you self-host and don't change anything, no data leaves your instance. Period.

## What this is for

I'm the maintainer. Without any signal, I'm building based on guesses. Telemetry answers things like:

- Which screens do operators actually open?
- Do people log medications via the bot or the web UI?
- What versions are running in the wild?
- Are there API routes returning 5xx that I haven't noticed?

It does **not** tell me anything about you, your health, your data, or your server.

## How to enable

Set two environment variables in your `.env` or Compose config:

```bash
TELEMETRY_ENABLED=true
TELEMETRY_ENDPOINT=https://telemetry.example.com   # the maintainer's central telemetry instance
```

A third variable is set automatically by the installer:

```bash
TELEMETRY_INSTANCE_ID=<random 16-char hex>
```

This ID is a random hex string generated once at install. **It is not used on the maintainer's dashboard** — the current analytics backend (Vince) shows only fleet-wide aggregates, with no per-instance breakdowns. The ID exists for two reasons: (1) if the maintainer ever needs to investigate a specific operational issue, the ID can be matched against a raw event export to isolate that one instance's events; (2) it preserves an upgrade path to a richer per-instance dashboard later without re-IDing every instance in the fleet. It is **not** derived from your hostname, MAC address, public key, install date, or anything else identifying. If you want to rotate it, edit your `.env` and restart.

The endpoint **must** be HTTPS. The server refuses to start if it isn't.

## How to disable (or verify it's off)

Either:

- Don't set `TELEMETRY_ENABLED` at all (the default).
- Set `TELEMETRY_ENABLED=false`.

When disabled:

- No telemetry code runs. The reporter is a no-op struct with zero allocations.
- No frontend tracking JS is downloaded by your browser.
- No outbound network calls are made to any telemetry endpoint.

You can verify with `tcpdump`, `nethogs`, or your firewall: an opted-out instance never touches the telemetry endpoint.

## What is collected

Every event carries:

- `instance` — your random hex ID (see above).
- `schema` — the event schema version (currently `"1"`).

Plus one of these event types:

| Event | When | Extra data |
|-------|------|------------|
| `pageview` | you navigate to a screen in the app | `screen` name (`today`, `bp`, `food`, `meds`, `health`, `workouts`, `weight`, `settings`) |
| `http_request` | every backend HTTP request | `method` (`GET`/`POST`), `route` (URL pattern only, e.g. `/api/bp` — never `/api/bp/42`), `status` (bucket: `2xx`, `4xx`, `5xx`, or `0` for client cancellation) |
| `feature_used` | you do a write in the web UI | `action` (`bp_logged`, `med_confirmed`, `food_photo`, etc. — a closed list of action names, no values) |
| `bot_action` | you do a write via the Telegram bot | `action` (same shape as `feature_used`, but tracked separately so I can see bot-vs-web split) |
| `mcp_call` | a Python script you run via `mcp_execute` calls a backend operation | `operation` (the registry slug, e.g. `bp.create`), `status` (`2xx`/`4xx`/`5xx`) |
| `scheduler_action` | a scheduled reminder fires | `action` (`med_reminder_fired`, `bp_reminder_fired`, etc.) |
| `sse_event` | the live changes stream opens, closes, or drops | `kind` (`connect`, `disconnect`, `rst_stream`) |
| `deployment` | once per `(version, 24h)` per instance — crashloop-safe | `version`, `go_version`, `os` |

That's the entire list. The handler validates against this allowlist; unknown event names and unknown prop keys are rejected at the source, not just stripped silently.

## What is NEVER collected

Enforced by the code, not by promise:

| Category | Examples |
|----------|----------|
| **Personal identity** | Your name, email, Telegram user ID, chat ID |
| **Instance identity** | Your domain name, hostname, public IP, TLS certificate |
| **Health data** | BP values, weight values, medication names, dosages, food names, sleep durations, workout details, diary content — anything you've actually typed into the app |
| **Precise timestamps** | Vince stores hour-of-day aggregates only |
| **Request content** | Request bodies, query parameters, headers, your browser User-Agent, your `Referer` |
| **Dataset size** | Counts of medications, BP readings, etc. — anything that would reveal how much data you have |
| **Error content** | Stack traces, error messages (only the `2xx`/`4xx`/`5xx` bucket is sent) |

## How the data physically travels

```
Your browser ──→ your Go server ──→ Vince (maintainer)
```

The browser never talks to the maintainer's server directly. All events are proxied through your local Go server, which strips identifying context:

- A fixed `User-Agent: medtracker/<version>` is sent (your browser UA never leaves).
- A fixed synthetic domain `telemetry.example.com` is sent (your real domain is never sent).
- The `Referer` header is dropped.
- No `X-Forwarded-For` is sent; the maintainer's server sees only the Go server's outbound IP (your own server's IP). That IP is logged in the maintainer's request-level access log but is **not** surfaced anywhere on the maintainer's analytics dashboard — the dashboard is a single fleet-wide site with no per-IP, per-instance, or per-server breakdowns.

Events are held in a bounded in-memory channel and sent fire-and-forget. If the buffer fills up or the maintainer's server is unreachable, events are silently dropped. There's no retry, no disk queue.

## How long the data is kept

The maintainer commits to **2 years** of retention on the central Vince instance. Older data is pruned. The maintainer's Vince dashboard is password-protected and not exposed publicly.

If I ever change retention or what's collected, that change will land in this file in the same commit as the code change — you can subscribe to repository releases or watch this file.

## Verifying for yourself

The whole telemetry surface is intentionally small and reviewable:

- Reporter code: `internal/telemetry/reporter.go`
- HTTP handler: `internal/server/telemetry_handler.go`
- Event allowlist: same handler — closed map of allowed names and prop keys
- Frontend module: `web/static/js/features/telemetry.js` (only loaded when bootstrap returns `telemetry_enabled: true`)
- Detailed design: [`docs/implicit-opt-in-telemetry-architecture.md`](docs/implicit-opt-in-telemetry-architecture.md)

A few automated tests guard the guarantees in this document, including a regression test that asserts zero outbound HTTP calls happen when telemetry is disabled.

## Questions, concerns, opt-out requests

Open an issue on the GitHub repo. There's no per-event deletion API (there's no per-event identity to key on), but I can purge all data for a specific `instance` ID on request — just send me the ID from your `.env`.

If you don't want any telemetry, don't set `TELEMETRY_ENABLED`. That's the only step.
