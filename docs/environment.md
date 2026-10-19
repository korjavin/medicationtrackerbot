# Environment Variables

`cmd/cloud` is the production service. Every variable below is read from the
process environment.

Operator-side bounds the owner configures at the provider (for example a
duration cap on the ElevenLabs agent) get a docs note next to the variable, or
nothing — not a startup `WARN` log or runtime banner.

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
TRIAL_AI_PROVIDER=openai           # Chat backend for the trial proxy: openai (default, the TRIAL_OPENAI_* triples) or anthropic (native Messages adapter, internal/cloudserver/trial_anthropic.go — client unchanged). Any other value: cmd/cloud refuses to start. The master switch follows the ACTIVE provider's key. Both blocks may stay set; rollback = flip this + redeploy
TRIAL_ANTHROPIC_API_KEY=...        # Anthropic key used when TRIAL_AI_PROVIDER=anthropic. Recommended: its own Console workspace with a spend limit
TRIAL_ANTHROPIC_MODEL=claude-haiku-5-5  # Model forced on anthropic-provider trial calls (default shown)
TRIAL_ANTHROPIC_VISION_MODEL=...   # ?vision=1 model on the anthropic provider; falls back to TRIAL_ANTHROPIC_MODEL
TRIAL_ELEVENLABS_API_KEY=...       # With TRIAL_ELEVENLABS_AGENT_ID, enables GET /api/trial/elevenlabs/signed-url
TRIAL_ELEVENLABS_AGENT_ID=agent_...# Operator's shared ElevenLabs agent minted for trial users. Its tools and prompt are NOT provisioned automatically: run `pnpm trial:agent --apply` (dry run without --apply) after every `TOOLSET_VERSION` bump in web/cloud/js/elevenlabs-agent.js, or trial users keep the old voice tool list while BYO users get the new one. The script only ever PATCHes this id — it never creates an agent, so the value here stays valid. See docs/cloud-deployment.md.
TRIAL_VOICE_LLM_URL=https://<base-domain>/api/voice-llm    # Base URL the shared trial ElevenLabs agent uses as its custom LLM (`<url>/chat/completions` = `/api/voice-llm/chat/completions` on the base domain, the voice relay in internal/cloudserver/voice_llm_relay.go). Read by `pnpm trial:agent --apply` (scripts/provision-trial-agent.mjs) only — not by cmd/cloud. BYO agents point at the account subdomain automatically
TRIAL_VOICE_MAX_CALL_SECONDS=120   # ElevenLabs-side per-call cap (conversation.max_duration_seconds) on the shared trial agent (default: 120; positive integer); keep it <= TRIAL_ANON_VOICE_CALL_MAX_SECONDS — it is what bounds an anonymous session to what the start paid for. Also caps account trial calls. The script also sets turn.silence_end_call_timeout=30. Read by `pnpm trial:agent` only — not by cmd/cloud; BYO agents stay uncapped. Re-run `pnpm trial:agent --apply` after changing it
TRIAL_RATE_PER_MIN=10              # Per-account sliding-window limit shared across all trial routes (default: 10). Smooths bursts; bounds no spend. Streaming (`stream:true`, voice) turns use a separate fixed 60/min per-account limiter; the daily budgets count both.
TRIAL_DAILY_PER_ACCOUNT=100        # Per-account DAILY cap on trial AI requests, persisted in cloud.db (default: 100; 0 disables)
TRIAL_DAILY_GLOBAL=500             # Cross-account DAILY cap on trial AI requests, persisted in cloud.db (default: 500; 0 disables). Also covers anonymous iOS installs (one shared budget)
# Anonymous trial for iOS (and, below, Android) local mode (bd med-o7zq.15; docs/cloud-mode.md → Anonymous trial). Base-domain
# POST /api/attest/{challenge,enroll,trial/openai/chat/completions}. Live only when all four Apple vars below
# are set AND trial AI is configured. None of the four set (or trial AI off) → those routes return 503
# trial_not_configured. A partial set of the four is an error: cmd/cloud refuses to start (the error names
# the vars, never values).
APP_ATTEST_APP_ID=TEAMID.bundle.id # App ID "<TEAMID>.<bundle id>" whose SHA256 is the attestation rpIdHash
APP_ATTEST_ENV=production          # production (default; TestFlight + App Store builds) or development (Xcode-run builds only). Also picks the DeviceCheck host
DEVICECHECK_KEY_ID=...             # DeviceCheck key id (Apple Developer → Keys)
DEVICECHECK_TEAM_ID=...            # Apple team id that owns the key
DEVICECHECK_PRIVATE_KEY_FILE=/app/data/secrets/devicecheck.p8  # PATH to the .p8 (PKCS#8 EC). A file, never the PEM inline; never committed (*.p8 is gitignored). See docs/cloud-deployment.md
# Android twin (bd med-nt9p.32.8.3): the same /api/attest/* routes enroll Android installs via Google Play
# Integrity. Independent of the Apple vars: either platform, both, or neither. Both PLAY_INTEGRITY_PACKAGE_NAME
# and PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE or neither; a partial set, or an unreadable/unparseable file, refuses
# to start (naming the var). Unset → Android enrolls answer 503 trial_not_configured; iOS is unaffected.
PLAY_INTEGRITY_PACKAGE_NAME=...    # Android applicationId the integrity token must name (requestPackageName and appIntegrity.packageName). A wrong value makes Google answer 400 to every decode — logged as a distinct warning
PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE=/app/data/secrets/play-integrity.json  # PATH to the Google service-account JSON key of the Cloud project linked in Play Console (docs/android.md → Play Integrity setup). A file, never inline; never committed (data/secrets/ is gitignored). See docs/cloud-deployment.md
PLAY_INTEGRITY_ACCEPT_APP_VERDICTS=PLAY_RECOGNIZED  # Comma list of accepted appRecognitionVerdict values (default: PLAY_RECOGNIZED; allowed: PLAY_RECOGNIZED, UNRECOGNIZED_VERSION). Add UNRECOGNIZED_VERSION ONLY for a deliberate sideload test window (it admits builds Play did not distribute) and remove it after; each such grant is visible as env=UNRECOGNIZED_VERSION on its attest_installs row
TRIAL_ANON_LIFETIME_REQUESTS=200   # Lifetime trial requests per device trial bucket — one device's trial, shared by its reinstalls via the Keychain trial pass (default: 200; must be positive). Refunded when the upstream call fails
TRIAL_ANON_DAILY=50                # Per-bucket DAILY cap, in trial_usage like accounts (default: 50; 0 disables)
TRIAL_ANON_FOOD_DAILY=1000         # Per-bucket DAILY cap on anonymous food lookups (GET /api/attest/food/*), separate from the AI budget (default: 1000; 0 disables). Food routes also need CLOUD_FOOD_DB_URL
TRIAL_ANON_VOICE_LIFETIME_SECONDS=600       # Anonymous voice (POST /api/attest/voice/start): lifetime call seconds per bucket. DEFAULT OFF — unset or 0 = anonymous voice answers 503 voice_not_configured; recommended (owner-approved 2026-10-18): 600 lifetime, 300 daily, 7200 global daily, 120 per call, with TRIAL_VOICE_MAX_CALL_SECONDS=120. Each start is charged its whole grant (no refund for early hang-ups). Voice also needs TRIAL_ELEVENLABS_* AND trial AI (the relay answers the turns with it); otherwise 503 voice_not_configured. Voice turns never spend TRIAL_ANON_* request quotas or TRIAL_DAILY_GLOBAL
TRIAL_ANON_VOICE_DAILY_SECONDS=300          # Per-bucket call seconds per UTC day (default: 300; 0 disables)
TRIAL_ANON_VOICE_GLOBAL_DAILY_SECONDS=7200  # All installs' call seconds per UTC day (default: 7200; 0 disables)
TRIAL_ANON_VOICE_CALL_MAX_SECONDS=120       # One call's grant ceiling (default: 120; at least 30, the grant floor). Keep TRIAL_VOICE_MAX_CALL_SECONDS <= this
MANAGER_BOT_TOKEN=...              # Optional. BotFather token for the operator's manager bot with "Bot Management Mode" enabled. Enables one-tap managed-bot provisioning + BYO Telegram linking (C3a). Unset = Telegram fully disabled (wizard step + webhook routes skipped). See docs/cloud-deployment.md. NOTE: child bot tokens are sealed with a key derived from SESSION_SECRET — rotating SESSION_SECRET orphans stored tokens (users must re-link).
CLOUD_TG_API_BASE_URL=...          # Optional. Overrides the Telegram Bot API root (default https://api.telegram.org). Set to http://telegram-bot-api:8081 (+ TELEGRAM_API_ID/HASH) to enable the local Bot API proxy for large-file/Mi Band imports; see docs/cloud-deployment.md.
CLOUD_INTERNAL_WEBHOOK_BASE=...     # Optional. Internal docker-network origin the local Bot API proxy delivers child-bot webhooks to (default http://cloud:8080). Only used when CLOUD_TG_API_BASE_URL is set — the proxy can't reach the public host in --local mode. Override if you changed PORT. See docs/cloud-deployment.md.

# Web Push relay — zero-config: each account gets its own VAPID keypair
# generated server-side at invite provisioning (backfilled for pre-existing
# accounts at startup). No VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY to set.
VAPID_SUBJECT=mailto:you@example.com  # Optional. Operator contact identifier (RFC 8292), never user data. Default: mailto:noreply@<CLOUD_BASE_DOMAIN>. Apple endpoints automatically get https://<CLOUD_BASE_DOMAIN> instead.
REQUEST_INVITE_EMAIL=hello@example.com # Optional. Sets the "request an invite" contact address shown on the base-domain landing page (with a working mailto: link). Unset = no contact line (landing page byte-identical to today). HTML-escaped, so no format validation.
IOS_TEAM_ID=ABCDE12345            # Optional, pairs with IOS_BUNDLE_ID. Apple Team ID of the iOS app. Both set = GET /.well-known/apple-app-site-association is served (application/json, webcredentials apps ["<TEAM>.<bundle>"]) on the base domain and every subdomain, so passkeys work in the iOS shell (Associated Domains). Either unset = route not served (404).
IOS_BUNDLE_ID=com.example.app      # Optional, see IOS_TEAM_ID.
ANDROID_PACKAGE=com.example.app    # Optional, pairs with ANDROID_CERT_SHA256S. Android app package name. Both set = GET /.well-known/assetlinks.json is served (application/json, one statement: relations get_login_creds + handle_all_urls, target android_app package + fingerprints) on the base domain and every subdomain, so passkeys and app links work in the Android shell (Digital Asset Links). Either unset = route not served (404).
ANDROID_CERT_SHA256S=AA:BB:...     # Optional, see ANDROID_PACKAGE. Comma-separated colon-hex SHA-256 signing-cert fingerprints (Play App Signing key + the CI upload/debug key). Uppercased, blanks dropped. Each valid fingerprint is also accepted as the WebAuthn origin `android:apk-key-hash:<base64url(SHA-256), unpadded>` on every ceremony (register, login, re-auth) for the Android shell, exact match, RP ID unchanged; invalid entries are skipped with a warning. Unset = https origin only. Keep the real values in the deploy env, never in the repo.
PLAY_INTEGRITY_PACKAGE_NAME=com.example.app # Planned — med-nt9p.32.8.3, not read by the server yet. Android package name Play Integrity verdicts must match. See docs/android.md → Play Integrity setup (owner).
PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE=/app/data/secrets/play-integrity.json # Planned — med-nt9p.32.8.3, not read by the server yet. Path to the Google service-account JSON used to decode integrity tokens. Keep the real file in the deploy volume, never in the repo.
ANDROID_PLAY_CLOUD_PROJECT_NUMBER=123456789012 # Planned — med-nt9p.32.8.3, not read by the server yet. GitHub Actions variable (CI build input for the Android app), not a server env var: the Google Cloud project number linked to Play Integrity.
FEEDBACK_AGE_RECIPIENT=age1...        # Optional. age X25519 recipient public key served to the browser via a <meta> tag so the client can age-encrypt user feedback client-side before POST /api/feedback. Unset = feedback disabled: no meta tag (client hides the UI) and /api/feedback answers 503.
FEEDBACK_ADMIN_CHAT_ID=123456789      # Optional. Numeric Telegram chat id (your own user id) the manager bot DMs when feedback arrives, so it isn't only visible to whoever remembers to run feedbackpull. Web feedback sends METADATA ONLY (kind + app version + time, no account id, no content) — the server holds client-encrypted ciphertext and stays unable to read it — plus a link to the browser reader page, https://<CLOUD_BASE_DOMAIN>/feedback#t=<token>, whose 30-minute capability token rides the URL FRAGMENT (never sent to the server, never fetched by Telegram's link-preview crawler) and is stored SHA-256-hashed. The page pulls the ciphertext and decrypts it in YOUR browser after you paste the age private key; the key never reaches the server. A token-mint failure degrades to the old "run feedbackpull to read" text rather than dropping the ping. Telegram-origin feedback is still relayed in FULL (copyMessage of the user's own message, media included) because the manager bot already held that plaintext. Requires MANAGER_BOT_TOKEN too; unset/0 = no relay, behavior unchanged. Best-effort: a failed DM (e.g. you never pressed /start on the manager bot) only logs a warning and never affects the feedback submission.
FEEDBACK_AGE_IDENTITY=/path/dev.key   # Dev/ops only, NOT read by the server. Default for the `-identity` flag of the `cmd/feedbackpull` decrypt CLI: the age private key (counterpart to FEEDBACK_AGE_RECIPIENT) the developer uses to drain + decrypt the feedback queue. Keep it off the server host.
```
