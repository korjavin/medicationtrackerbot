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

See [mcp-deployment.md](mcp-deployment.md) for full MCP deployment setup.
