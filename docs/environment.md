# Environment Variables

`cmd/cloud` is the production service. Every variable below is read from the
process environment.

## Cloud service (`cmd/cloud`)

See [docs/cloud-deployment.md](cloud-deployment.md) for the full self-hosted deployment guide.

```bash
# Required
CLOUD_BASE_DOMAIN=app.example.com  # Base domain; subdomains are <sub>.<this>. Use 'localhost' for local dev (no DNS/certs needed).
SESSION_SECRET=...                 # Required, >=32 chars with sufficient entropy (generate: openssl rand -base64 32). NOTE: both child Telegram bot tokens AND mcp_remote pairing keys are sealed at rest with a key derived from this value — rotating SESSION_SECRET orphans both (users must re-link Telegram and re-pair any hosted MCP remote).

# Optional
CLOUD_DB_PATH=cloud.db             # SQLite database path (default: cloud.db)
PORT=8080                          # HTTP port (default: 8080)
CLOUD_CLAIM_TTL=14                 # Invite claim-link validity, in days (default: 14)
CLOUD_ACCOUNT_QUOTA_BYTES=52428800 # Per-account oplog+snapshot storage cap, in bytes (default: 50MB; 0 disables)
CLOUD_DRY_QUEUE_WARN_HOURS=120     # Stale-sync warning: how close (hours) the last unsent reminder must be before the hourly sweep nudges a stale-synced account (default: 120)
CLOUD_LOCAL_ONLY_POC=1             # Explicit local-only passkey POC (med-eas.2.1): "1"/"true" lets register/finish accept mode:"local_only" and advertises local_only_poc:true on GET /api/version so flagged browsers may offer the fallback. Anything else (including unset) disables both halves — the client opt-in alone does nothing and the server rejects the mode with 400. Default: off.
CLOUD_FOOD_DB_API_KEY=...          # Operator key for a KEYED food DB, forwarded upstream as X-API-Key by the /api/food/* proxy. Operator-owned and server-side only — never reaches the browser. Unset = no header sent, for unkeyed instances.
CLOUD_FOOD_DB_URL=https://food.example.com  # REQUIRED for food search to work out of the box. Operator's default FastFoodDB instance. Requests to this URL are routed through a server-side proxy to bypass CORS restrictions. A URL, not a secret. Unset = no remote food DB: search returns only products the user has already logged, and the UI says "Food database not configured" rather than reporting zero results. Users can still set their own in Settings → Integrations.
# Trial provider keys (all optional; unset = pure BYO, trial proxy routes return 503).
# Operator-owned keys served ONLY through server-side proxy routes (/api/trial/*) —
# they never reach the browser. See docs/cloud-mode.md → Trial provider keys.
TRIAL_OPENAI_API_KEY=...           # Master switch: enables POST /api/trial/openai/chat/completions and the client trial-AI flag
TRIAL_OPENAI_URL=https://api.openai.com/v1  # OpenAI-compatible base URL (default shown). Must be an absolute http(s) URL — cmd/cloud refuses to start otherwise
TRIAL_OPENAI_MODEL=gpt-6-luna      # Model forced server-side on every trial chat call (default shown). Models without response_format json_schema (deepseek-chat, most local models) are fine — the proxy reports the rejection and the client retries with a fenced-JSON prompt
TRIAL_OPENAI_VISION_API_KEY=...    # Vision triple; each field falls back to the text triple when unset. Overrides only — without TRIAL_OPENAI_API_KEY trial AI stays off
TRIAL_OPENAI_VISION_URL=...
TRIAL_OPENAI_VISION_MODEL=...
TRIAL_ELEVENLABS_API_KEY=...       # With TRIAL_ELEVENLABS_AGENT_ID, enables GET /api/trial/elevenlabs/signed-url
TRIAL_ELEVENLABS_AGENT_ID=agent_...# Operator's shared ElevenLabs agent minted for trial users. Its tools and prompt are NOT provisioned automatically: run `pnpm trial:agent --apply` (dry run without --apply) after every `TOOLSET_VERSION` bump in web/cloud/js/elevenlabs-agent.js, or trial users keep the old voice tool list while BYO users get the new one. The script only ever PATCHes this id — it never creates an agent, so the value here stays valid. See docs/cloud-deployment.md.
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
FEEDBACK_AGE_RECIPIENT=age1...        # Optional. age X25519 recipient public key served to the browser via a <meta> tag so the client can age-encrypt user feedback client-side before POST /api/feedback. Unset = feedback disabled: no meta tag (client hides the UI) and /api/feedback answers 503.
FEEDBACK_ADMIN_CHAT_ID=123456789      # Optional. Numeric Telegram chat id (your own user id) the manager bot DMs when feedback arrives, so it isn't only visible to whoever remembers to run feedbackpull. Web feedback sends METADATA ONLY (kind + app version + time, no account id, no content) — the server holds client-encrypted ciphertext and stays unable to read it — plus a link to the browser reader page, https://<CLOUD_BASE_DOMAIN>/feedback#t=<token>, whose 30-minute capability token rides the URL FRAGMENT (never sent to the server, never fetched by Telegram's link-preview crawler) and is stored SHA-256-hashed. The page pulls the ciphertext and decrypts it in YOUR browser after you paste the age private key; the key never reaches the server. A token-mint failure degrades to the old "run feedbackpull to read" text rather than dropping the ping. Telegram-origin feedback is still relayed in FULL (copyMessage of the user's own message, media included) because the manager bot already held that plaintext. Requires MANAGER_BOT_TOKEN too; unset/0 = no relay, behavior unchanged. Best-effort: a failed DM (e.g. you never pressed /start on the manager bot) only logs a warning and never affects the feedback submission.
FEEDBACK_AGE_IDENTITY=/path/dev.key   # Dev/ops only, NOT read by the server. Default for the `-identity` flag of the `cmd/feedbackpull` decrypt CLI: the age private key (counterpart to FEEDBACK_AGE_RECIPIENT) the developer uses to drain + decrypt the feedback queue. Keep it off the server host.
```
