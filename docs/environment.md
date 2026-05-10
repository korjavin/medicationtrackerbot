# Environment Variables

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
