# Demo mode (public, auth-less, AI-rate-limited)

A runtime flag (`DEMO_MODE=1`) that turns the same server binary into a public, browseable demo. The intent is to let visitors poke around with seeded data without an account, while keeping AI-cost endpoints behind tight per-IP rate limits.

Status: shipped. Default off — production deployments see zero behavior change.

## What it does

When `DEMO_MODE=1` and the binary starts:

1. The Telegram bot is skipped (already covered by the existing "web-only mode" — just don't set `TELEGRAM_BOT_TOKEN`).
2. `/api/*` is fully public. Every request resolves to a single fixed demo user (the seeddemo target) via `auth.DemoUserResolver`. No Telegram `initData`, no OIDC, no session cookies.
3. The MCP server (separate `cmd/mcptool` binary) skips the Pocket-ID OAuth middleware so any client can connect to `/mcp` and `/sse`. The `/.well-known/oauth-protected-resource` route is not mounted.
4. Five AI / cost-sensitive routes get per-IP rate limiters with restrictive defaults. A 429 from these routes returns a structured JSON body (`{"error":"demo_rate_limit","limit":"…","retry_after_seconds":…}` + `Retry-After` header) so the frontend can show a clear demo-restriction popup instead of a generic "Too Many Requests".
5. `/api/bootstrap` carries a `demo` object so the frontend can mount a dismissible banner and format accurate restriction messages.

Demo mode is a runtime flag, not a build tag — single binary supports both production and demo deployments. The mobile build (`//go:build mobile`) is untouched and unaware of demo mode.

## Environment variables

| Var | Default | Meaning |
|-----|---------|---------|
| `DEMO_MODE` | `0` | Master switch. Set to `1` to enable. |
| `DEMO_AGENT_CALLS_PER_DAY` | `1` | Per-IP daily limit on `GET /api/elevenlabs/signed-url` — gates how many voice-agent conversations a visitor can start per day. `POST /api/elevenlabs/upload-file` is NOT counted so a single authorized conversation can attach multiple photos without each upload burning a slot. |
| `DEMO_FOOD_LOGS_PER_HOUR` | `1` | Per-IP limit for `POST /api/food/log` (manual entry, no AI). |
| `DEMO_FOOD_PHOTOS_PER_HOUR` | `1` | Per-IP limit for `POST /api/food/log/from-photo` (vision). |
| `DEMO_FOOD_DESCRIPTIONS_PER_HOUR` | `1` | Per-IP limit for `POST /api/food/log/from-description` (text completion). |
| `AUTH_TRUST_PROXY` | `0` | **Must be `1` for the demo deployment.** The rate limiters key on `clientIP`, which only honors `X-Forwarded-For` when this is set. Without it, every visitor behind Traefik shares one IP and the limits become global. |
| `ALLOWED_USER_ID` | — | The user ID the demo resolver returns. Must match the user you targeted with `cmd/seeddemo`. |

All `DEMO_*` overrides accept integers; malformed values fall back to the default (see `internal/config/config_test.go`).

## Mutual exclusivity

Demo mode is intended to run alone. The startup is permissive — nothing crashes if `TELEGRAM_BOT_TOKEN` or `OIDC_*` are also set — but the combination is not supported:

- If `TELEGRAM_BOT_TOKEN` is set alongside `DEMO_MODE=1`, the bot still starts and sends notifications to the configured chat. Don't do this for a public demo.
- If `OIDC_*` env vars are set, they are ignored by the server build's resolver (the demo branch in `newDefaultResolver` short-circuits before OIDC), but the configuration ambiguity is confusing. Strip them from the demo container.
- The MCP binary requires `POCKET_ID_URL` and `MCP_SERVER_URL` *unless* `DEMO_MODE=1`, in which case both checks are skipped.

A startup `slog.Warn` fires when `DEMO_MODE=1` (server: "DEMO_MODE is enabled — auth is disabled and AI endpoints are rate-limited per IP"; MCP: "[MCP] DEMO_MODE: OAuth disabled, /mcp and /sse accept all callers") so the demo state is obvious in the logs.

## Seeding the demo database

`cmd/seeddemo` wipes a target user's data and seeds a deterministic 90-day dataset (medications, BP/weight/sleep series, food logs, workouts, diary notes, a mid-period timezone change). The same `-seed` produces an identical dataset on every run, so re-seeding nightly resets the demo to a known state.

```bash
go run ./cmd/seeddemo -user 1 -db /data/demo.db -days 90 -wipe -seed 42
```

The user ID must match `ALLOWED_USER_ID` in the demo container's env. Generator code lives in `internal/seeddemo/`.

## Rate-limit response shape

The four (effectively five — ElevenLabs is two routes sharing one bucket) demo-rate-limited routes return 429 with:

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 3600

{"error":"demo_rate_limit","limit":"food_log","retry_after_seconds":3600}
```

The `limit` field is one of `agent_calls`, `food_log`, `food_log_from_photo`, `food_log_from_description`. The frontend's `apiCall` helper (`web/static/js/core/api.js`) detects this body shape and surfaces a dedicated popup via `window.DemoBanner.showDemoLimitAlert(...)` instead of the generic offline-style error.

Non-demo 429s (e.g. the auth limiter) keep the existing plain-text body — the demo branch is keyed on the `error: "demo_rate_limit"` discriminator.

## Bootstrap payload

When `DEMO_MODE=1`, `/api/bootstrap` adds:

```json
{
  "demo": {
    "enabled": true,
    "limits": {
      "agent_calls_per_day": 1,
      "food_logs_per_hour": 1,
      "food_photos_per_hour": 1,
      "food_descriptions_per_hour": 1
    }
  }
}
```

When demo is off, the `demo` key is omitted entirely. The frontend feature-detects on `bootstrap.demo?.enabled` — older clients that don't know about the key see no banner and no behavior change.

## Frontend banner behavior

The banner mounts from `bootstrap.demo` via `window.DemoBanner.mount(...)`. Copy: *"Demo version — data is shared across visitors and may reset. AI features are rate-limited."*

Dismiss persists `demoBannerDismissed=<hash>` in `localStorage`, where the hash is a deterministic JSON of the configured limits. A returning visitor sees the banner again only if the operator changes the limits — useful when tightening or loosening defaults so users notice the new ceiling.

## Trust-proxy requirement

The per-IP rate limiters key on `clientIP(r, trustProxy)`. The Traefik-fronted demo deployment must set `AUTH_TRUST_PROXY=1` so `X-Forwarded-For` is honored. Without it, every visitor presents the same upstream IP (the Traefik container) and the limits become global — the first visitor of the hour drains everyone's budget. This is the single most common deployment mistake; check it first if the demo "shares" rate-limit hits across IPs.

## Build seam

No new build tags. The demo wiring lives in:

- `internal/config/config.go` — `DemoMode bool` + `Demo DemoConfig` sub-struct.
- `internal/server/auth/resolver_demo.go` — `DemoUserResolver` (tag-free; only the server build wires it).
- `internal/server/auth_resolver_server.go` — `newDefaultResolver` branches on `s.demoMode`.
- `internal/server/server.go` — `demoMode` + `demoCfg` fields, `SetDemoMode` / `SetDemoConfig` setters, conditional rate-limiter construction in `Routes()`, `demoRateLimitMiddleware` helper.
- `internal/mcp/mcp.go` — `Config.DemoMode`, conditional `OAuthHandler` construction, `buildPublicMux` skips OAuth when `s.oauth == nil`.
- `cmd/bot/main_server.go` — `srv.SetDemoMode(cfg.DemoMode)` + `srv.SetDemoConfig(...)` + startup warn.
- `cmd/mcptool/main.go` — no code change; `LoadConfigFromEnv` reads `DEMO_MODE` and the rest threads through.
- `web/static/js/core/demo-banner.js` + `web/static/js/core/api.js` (429 branch) + `web/static/index.html` (banner div + script tag) + `web/static/css/styles.css` (`.wg-demo-banner`).

The MCP coverage guard (`internal/server/mcp_coverage_exempt.go`) is unaffected — rate-limited routes are already in the registry; wrapping them in middleware doesn't change registration.

## Operator runbook

Bring up a fresh demo container with:

```env
DB_PATH=/data/demo.db
DEMO_MODE=1
ALLOWED_USER_ID=1
AUTH_TRUST_PROXY=1
OPENAI_API_KEY=…
OPENAI_URL=…
ELEVENLABS_API_KEY=…
ELEVENLABS_AGENT_ID=…
# No TELEGRAM_BOT_TOKEN, no OIDC_*, no POCKET_ID_*
```

Before serving traffic:

```bash
go run ./cmd/seeddemo -user 1 -db /data/demo.db -days 90 -wipe -seed 42
```

Optionally schedule a cron / Portainer task to re-seed nightly so the demo resets to a known state.

## Smoke test (manual)

After deployment, in a private/incognito window:

- Open the demo URL → no auth challenge, app loads with seeded data.
- Demo banner appears, dismiss it, reload — stays dismissed.
- Hit `/api/elevenlabs/signed-url` twice in a row → second call returns 429 with the demo-restriction popup.
- Hit `/api/food/log/from-photo` twice in a row → same outcome.
- Connect Claude (or another MCP client) to `/mcp` with no auth → tools list works.
- From a different IP (or via a VPN), confirm rate limits are per-IP, not global.

## Follow-ups (not in scope)

- If the demo grows to multiple replicas, the in-memory rate limiter becomes per-process — visitors could re-roll the dice by hitting different replicas. Solve with a distributed counter (Redis) when that bites.
- The deployment glue (docker-compose, Portainer webhook, nightly re-seed cron) is out of scope for the code change. See `docs/plans/2026-05-21-demo-mode.md` Post-Completion section for the deployment checklist.
