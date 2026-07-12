# Environment Variables

## Precedence: env → settings table → built-in default

The provider-credential vars (`OPENAI_*`, `OPENAI_VISION_*`, `FOOD_*`, `ELEVENLABS_*`) are also persisted in the singleton `settings` table and editable via the Settings UI's Integrations section. The `internal/config` package merges in this order:

1. **Environment variable** — wins when set. Server operators continue to manage these via `docker-compose.yml` / systemd unit, no behavioral change.
2. **Settings table** — fallback when the env var is empty. This is the only source on mobile builds (`-tags mobile`), where no env vars are read at runtime.
3. **Built-in default** — last resort (e.g. `https://api.openai.com/v1` for `OPENAI_URL`).

Bootstrap vars (`DB_PATH`, `PORT`, `TZ`, `SESSION_SECRET`) and transport-restricted vars (`TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_ID`, `MCP_*`, `POCKET_ID_*`, `OIDC_*`, `GOOGLE_*`, `VAPID_*`, `EXTERNAL_WORKOUT_API_KEY`, `MCP_AUDIT_SECRET`) are env-only — they have no settings-table counterpart and are not compiled into the mobile build. See [local-mode.md → Config layering](local-mode.md#config-layering-env--settings--default).

## Main bot (`cmd/bot`)

```bash
# Required
TELEGRAM_BOT_TOKEN=...        # From BotFather
ALLOWED_USER_ID=123456789     # Your Telegram user ID
TZ=Europe/Berlin              # Critical for correct scheduling

# Optional
DB_PATH=meds.db               # SQLite database path (default: meds.db)
PORT=8080                     # HTTP port (default: 8080)
EXTERNAL_WORKOUT_API_KEY=...  # Required for external workout endpoint (e.g. Mi Notify)

# Natural Language Food Logging (optional)
OPENAI_API_KEY=...            # For the /food and /activity AI commands
OPENAI_URL=...                # Defaults to https://api.openai.com/v1
OPENAI_MODEL=...              # Defaults to gpt-4o-mini

# Vision (food photo) provider override (optional). Each variable falls back
# to its OPENAI_* counterpart when unset. Use this when the primary provider
# is text-only (e.g. DeepSeek's deepseek-chat returns "unknown variant
# `image_url`") and a separate vision-capable model handles food photos —
# e.g. point these at gemini-2.0-flash or gpt-4o-mini.
OPENAI_VISION_API_KEY=...
OPENAI_VISION_URL=...         # e.g. https://generativelanguage.googleapis.com/v1beta/openai
OPENAI_VISION_MODEL=...       # e.g. gemini-2.0-flash or gpt-4o-mini

# Google OIDC (optional, browser access)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URL=https://your-domain.com/auth/google/callback
ADMIN_EMAIL=you@gmail.com

# Web Push (optional)
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com

# ElevenLabs voice agent (optional) — drives the "Call agent" card on Today.
# Both must be set for the card's call action to succeed; otherwise
# /api/elevenlabs/signed-url returns 503 and the card surfaces
# "Voice agent is not configured on this server.".
ELEVENLABS_API_KEY=...
ELEVENLABS_AGENT_ID=agent_...
```

## Cloud service (`cmd/cloud`)

See [docs/cloud-deployment.md](cloud-deployment.md) for the full self-hosted deployment guide.

```bash
# Required
CLOUD_BASE_DOMAIN=app.example.com  # Base domain; subdomains are <sub>.<this>. Use 'localhost' for local dev (no DNS/certs needed).
SESSION_SECRET=...                 # Same length (>=32) + entropy (Shannon >=3.5) requirement as cmd/bot

# Optional
CLOUD_DB_PATH=cloud.db             # SQLite database path (default: cloud.db)
PORT=8080                          # HTTP port (default: 8080)
CLOUD_CLAIM_TTL=14                 # Invite claim-link validity, in days (default: 14)
CLOUD_ACCOUNT_QUOTA_BYTES=52428800 # Per-account oplog+snapshot storage cap, in bytes (default: 50MB; 0 disables)
CLOUD_DRY_QUEUE_WARN_HOURS=120     # Stale-sync warning: how close (hours) the last unsent reminder must be before the hourly sweep nudges a stale-synced account (default: 120)
CLOUD_FOOD_DB_API_KEY=...          # Operator key for a KEYED food DB, forwarded upstream as X-API-Key by the /api/food/* proxy (mirrors bot mode's FOOD_API_KEY). Operator-owned and server-side only — never reaches the browser. Unset = no header sent, for unkeyed instances.
CLOUD_FOOD_DB_URL=https://food.example.com  # REQUIRED for food search to work out of the box. Operator's default FastFoodDB instance. Requests to this URL are routed through a server-side proxy to bypass CORS restrictions. A URL, not a secret. Unset = no remote food DB: search returns only products the user has already logged, and the UI says "Food database not configured" rather than reporting zero results. Users can still set their own in Settings → Integrations.
# Trial provider keys (all optional; unset = pure BYO, trial proxy routes return 503).
# Operator-owned keys served ONLY through server-side proxy routes (/api/trial/*) —
# they never reach the browser. See docs/cloud-mode.md → Trial provider keys.
TRIAL_OPENAI_API_KEY=...           # Master switch: enables POST /api/trial/openai/chat/completions and the client trial-AI flag
TRIAL_OPENAI_URL=https://api.openai.com/v1  # OpenAI-compatible base URL (default shown). Must be an absolute http(s) URL — cmd/cloud refuses to start otherwise
TRIAL_OPENAI_MODEL=gpt-4o-mini     # Model forced server-side on every trial chat call (default shown). Models without response_format json_schema (deepseek-chat, most local models) are fine — the proxy reports the rejection and the client retries with a fenced-JSON prompt
TRIAL_OPENAI_VISION_API_KEY=...    # Vision triple; each field falls back to the text triple when unset. Overrides only — without TRIAL_OPENAI_API_KEY trial AI stays off
TRIAL_OPENAI_VISION_URL=...
TRIAL_OPENAI_VISION_MODEL=...
TRIAL_ELEVENLABS_API_KEY=...       # With TRIAL_ELEVENLABS_AGENT_ID, enables GET /api/trial/elevenlabs/signed-url
TRIAL_ELEVENLABS_AGENT_ID=agent_...# Operator's shared ElevenLabs agent minted for trial users
TRIAL_RATE_PER_MIN=10              # Per-account sliding-window limit shared across all trial routes (default: 10). Smooths bursts; bounds no spend.
TRIAL_DAILY_PER_ACCOUNT=100        # Per-account DAILY cap on trial AI requests, persisted in cloud.db (default: 100; 0 disables)
TRIAL_DAILY_GLOBAL=500             # Cross-account DAILY cap on trial AI requests, persisted in cloud.db (default: 500; 0 disables)
MANAGER_BOT_TOKEN=...              # Optional. BotFather token for the operator's manager bot with "Bot Management Mode" enabled. Enables one-tap managed-bot provisioning + BYO Telegram linking (C3a). Unset = Telegram fully disabled (wizard step + webhook routes skipped). See docs/cloud-deployment.md. NOTE: child bot tokens are sealed with a key derived from SESSION_SECRET — rotating SESSION_SECRET orphans stored tokens (users must re-link).
CLOUD_TG_API_BASE_URL=...          # Optional. Overrides the Telegram Bot API root (default https://api.telegram.org). Set to http://telegram-bot-api:8081 (+ TELEGRAM_API_ID/HASH) to enable the local Bot API proxy for large-file/Mi Band imports; see docs/cloud-deployment.md.
CLOUD_INTERNAL_WEBHOOK_BASE=...     # Optional. Internal docker-network origin the local Bot API proxy delivers child-bot webhooks to (default http://cloud:8080). Only used when CLOUD_TG_API_BASE_URL is set — the proxy can't reach the public host in --local mode. Override if you changed PORT. See docs/cloud-deployment.md.

# Web Push relay — zero-config: each account gets its own VAPID keypair
# generated server-side at invite provisioning (backfilled for pre-existing
# accounts at startup). No VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY to set.
VAPID_SUBJECT=mailto:you@example.com  # Optional. Operator contact identifier (RFC 8292), never user data. Default: mailto:noreply@<CLOUD_BASE_DOMAIN>. Apple endpoints automatically get https://<CLOUD_BASE_DOMAIN> instead.
REQUEST_INVITE_EMAIL=hello@example.com # Optional. Sets the "request an invite" contact address shown on the base-domain landing page (with a working mailto: link). Unset = no contact line (landing page byte-identical to today). HTML-escaped, so no format validation.
```

## MCP server (`cmd/mcptool`)

```bash
MCP_PORT=3100
MCP_DATABASE_PATH=/app/data/tracker.db
POCKET_ID_URL=https://auth.example.com
MCP_MAX_QUERY_DAYS=90
MCP_AUDIT_ENDPOINT=http://medtracker:8080/api/mcp-audit
MCP_AUDIT_SECRET=secure-shared-secret
MCP_ADMIN_PORT=8082             # Admin API for long-lived API tokens; bound to 127.0.0.1 only. 0 disables. Default 8082.
```

### Python executor (`mcp_execute` / `mcp_help`)

These variables tune the sandboxed Python runner that backs `mcp_execute`. Defaults match the limits documented in [mcp-python-executor.md](mcp-python-executor.md#runtime-limits). The same `MCP_AUDIT_SECRET` is reused as the HMAC secret on the internal bridge endpoint — there is no separate runner secret. The runner scrubs this value out of the child env before spawning user scripts, so a script's own `os.environ` does not contain it; in the MVP in-process deployment that scrub is a usability shield rather than an enforced boundary (the child shares UID/PID/namespace with the parent — see the [MVP gap note](mcp-python-executor.md#known-mvp-gap-in-process-executor-isolation)).

```bash
# Caller-provided limits in mcp_execute are capped by these server-side values.
MCP_EXECUTOR_MAX_TIMEOUT_MS=30000   # Default 30s. Hard wall-clock cap per run.
MCP_EXECUTOR_MAX_API_CALLS=100      # Default 100. Counted by the proxy per run.
MCP_EXECUTOR_MAX_CONCURRENT=4       # Default 4. Runs above this are rejected with sandbox_startup_failure.

# Explicit opt-in for the Python executor. Leave unset and mcp_execute
# short-circuits with "execution service not configured" — useful for
# deployments that want the granular MCP tools without the sandboxed runner.
# Set to the bot's bridge endpoint (e.g. http://medtracker:8080/internal/mcp/bridge)
# to enable. Read docs/mcp-deployment.md "MVP in-process isolation tradeoff"
# before turning this on.
MCP_EXECUTOR_BRIDGE_URL=http://medtracker:8080/internal/mcp/bridge

# Loopback URL the runner subprocess uses for medtracker.api.call. Stays on
# 127.0.0.1; the runner never reaches anything else by design.
MCP_EXECUTOR_PROXY_URL=http://127.0.0.1:8090/call
```

Variables exposed inside the sandbox (set per run by the executor service, never by the operator):

| Variable | Purpose |
|---|---|
| `MEDTRACKER_PROXY_URL` | Loopback URL of the per-run proxy listener. Set by the executor; equals `MCP_EXECUTOR_PROXY_URL`. |
| `MEDTRACKER_RUN_TOKEN` | One-time token scoping the run. Sent in `X-Run-Token` on every proxy call. Rotated each run. |

The runner image must NOT be configured with `OPENAI_API_KEY`, `MCP_AUDIT_SECRET`, `POCKET_ID_*`, or any other authority-bearing secret. The executor scrubs the env before exec; setting these in `docker-compose.yml` for the runner service would defeat that boundary.

See [mcp-deployment.md](mcp-deployment.md) for full MCP deployment setup.
