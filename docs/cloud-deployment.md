# Cloud-mode deployment

Self-hosted deployment guide for the `cloud` binary (`cmd/cloud`): a zero-knowledge
cloud service on wildcard subdomains. See [cloud-mode.md](cloud-mode.md) for the
design and [cloud-crypto.md](cloud-crypto.md) for the crypto spec.

Two-layer setup: a static infra layer (Traefik + Portainer) run once with plain
`docker compose`, and the app stack deployed as a Portainer gitops stack —
mirroring this repo's existing bot deployment pattern.

## 1. DNS

Point both `<base>` and `*.<base>` at the server's IP. On Cloudflare, set the
wildcard record to **DNS only (grey cloud)**, not proxied — Cloudflare's proxy
only covers `*.<apex>` wildcards on paid plans, and proxying would terminate
TLS at Cloudflare instead of the origin's wildcard cert.

## 2. Infra layer (once, on the fresh server)

Mint a scoped Cloudflare API token: Zone → DNS → Edit, restricted to the single
zone containing your base domain.

```bash
cp .env.infra.cloud.example .env
# fill in CLOUD_BASE_DOMAIN, ACME_EMAIL, CF_DNS_API_TOKEN
docker compose -f docker-compose.infra.cloud.yml up -d
```

Verify the wildcard cert issues on first request (`docker compose -f
docker-compose.infra.cloud.yml logs traefik`) and that individual subdomains
don't leak into public CT logs (DNS-01 issuance for the wildcard doesn't log
per-subdomain names).

## 3. App stack (Portainer gitops)

Open `https://portainer.<base>`, finish the initial admin setup, then:

1. Create a stack from a Git repository: this repo, `deploy` branch
   (`refs/heads/deploy`), compose path `docker-compose.cloud.yml`.
   > [!IMPORTANT]
   > Ensure the repository reference is explicitly set to `refs/heads/deploy`. In `master`,
   > `docker-compose.cloud.yml` specifies `:latest` without file changes, so Portainer
   > reuses its locally cached `:latest` image instead of pulling updates. The `deploy`
   > branch updates the compose image tag to each commit's SHA (`:<sha>`), ensuring every
   > redeploy pulls and starts the exact target build.
2. Set stack env vars: `CLOUD_BASE_DOMAIN`, `SESSION_SECRET` (≥32 chars,
   Shannon entropy ≥3.5 — same rule as the bot's session secret). Push is
   zero-config: each account gets its own VAPID keypair generated
   server-side at invite provisioning, no `genvapid` step and no
   `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` to set. Optionally set
   `VAPID_SUBJECT` (defaults to `mailto:noreply@<CLOUD_BASE_DOMAIN>`) to
   change the operator contact identifier in the push JWT. Other optional
   tuning: `CLOUD_ACCOUNT_QUOTA_BYTES` (per-account oplog+snapshot storage
   cap, default 50MB, 0 disables), `CLOUD_DRY_QUEUE_WARN_HOURS` (default
   120 — how close the last unsent reminder must be before the hourly sweep
   warns a stale-synced account), and `CLOUD_FOOD_DB_URL` (operator's
   default FastFoodDB instance for food search — **required for food search
   to work on a fresh account**; see the note below), and
   `REQUEST_INVITE_EMAIL` (contact address for the "request an invite" line on
   the base-domain landing page; unset = no contact line).
   See [environment.md](environment.md).
3. Enable the stack's redeploy webhook and append its URL as a new line in
   the `PORTAINER_REDEPLOY_HOOK` GitHub secret (multiline — one URL per line,
   same secret the bot stack already uses).
4. Set the `CLOUD_BASE_DOMAIN` GitHub **repository variable** (Settings →
   Secrets and variables → Actions → Variables) to the same base domain, e.g.
   `cloud.example.com`. Portainer answers a redeploy webhook `204` and then
   fetches asynchronously, so the webhook alone cannot tell CI whether the
   deploy landed — bd med-m391 is five days of green deploys over a stack that
   never moved. With the variable set, `deploy.yml`'s last step polls
   `https://<base>/api/version` until it reports the build id this run stamped
   and fails the job after five minutes if it never does. Leaving it unset
   skips the check (so forks still deploy) — and leaves the blind spot open.

Operators who don't want gitops can instead run
`docker compose -f docker-compose.cloud.yml up -d` directly against the same
external `proxy` network.

### Changing stack env (Runbook)

When editing or adding stack environment variables in Portainer (either via the
web UI or the Portainer API), follow these exact steps to ensure the running image
tag is preserved and does not silently roll back:

1. **Coordinate / announce before triggering**: If operating in a team, post a notice in
   your ops / deployment channel that an env update and stack redeployment is starting.
2. **Record the current build ID**:
   ```bash
   PREV_BUILD=$(curl -fsS https://<base-domain>/api/version | sed -n 's/.*"build_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
   echo "Pre-change build: $PREV_BUILD"
   ```
3. **Verify the Git Reference**:
   The stack MUST track `refs/heads/deploy` (not `master` or empty). The `deploy`
   branch is where CI writes the pinned SHA image tag (`ghcr.io/korjavin/medicationtrackerbot:<sha>`).
   In `master`, the compose file specifies `:latest`; because the compose file on master
   does not change between commits, Portainer reuses its locally cached `:latest` image
   without re-pulling. Pointing to `master` or leaving the reference empty can therefore
   roll back the running container to whatever stale `:latest` image happens to exist on
   the Docker host.
4. **Update stack environment**:
   - **Via Portainer UI**: Navigate to Stacks → `<stack>` → update environment variables
     under the **Environment variables** section. Confirm the repository reference is set
     to `refs/heads/deploy`. Click **Update the stack** (with "Re-pull image" enabled if
     desired).
   - **Via Portainer API**: Use `POST /api/stacks/<id>/git?endpointId=<endpoint-id>`
     providing:
     - The updated `Env` array (all variables, as Portainer replaces the list).
     - `AutoUpdate` configuration (preserving `Webhook: "<uuid>"` and interval settings).
     - `RepositoryReferenceName: "refs/heads/deploy"`.
     - Git authentication fields: carry over `RepositoryAuthentication` and
       `RepositoryUsername` from `GET /api/stacks/<id>` (password may be omitted to
       preserve the stored token/secret).
     Note that `POST /api/stacks/<id>/git` saves the configuration; trigger the actual
     redeploy afterwards by calling the webhook via `POST /api/stacks/webhooks/<token>`.
5. **Verify deployment and build ID**:
   Poll `/api/version` until the service responds:
   ```bash
   CURR_BUILD=$(curl -fsS https://<base-domain>/api/version | sed -n 's/.*"build_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
   echo "Post-change build: $CURR_BUILD"
   ```
   The `build_id` is a `YYYYMMDD-HHMM` timestamp (or `dev` in local environments).
   Compare lexicographically: for an env-only change with no concurrent deployment,
   `$CURR_BUILD` should equal `$PREV_BUILD` (`[ "$CURR_BUILD" = "$PREV_BUILD" ]`).
   If `[[ "$CURR_BUILD" < "$PREV_BUILD" ]]`, the redeploy rolled back to an older
   image — immediately restore `RepositoryReferenceName: "refs/heads/deploy"` and
   re-trigger the redeploy webhook.
6. **Verify relevant endpoints and record the change**:
   Verify `/readyz` and any affected endpoints (e.g. `/privacy`), and record the verified
   `build_id` in your deployment log or team channel.

### Food-DB Configuration

`CLOUD_FOOD_DB_URL` configures the default FastFoodDB instance for users without a BYO vault setting.
Requests to the operator default are now routed through a same-origin proxy on the cloud server (`/api/food/search`, `/api/food/barcode/`),
eliminating the need for CORS configuration on the upstream FastFoodDB instance.

Set it — and if your upstream is keyed, set `CLOUD_FOOD_DB_API_KEY` too. The
proxy forwards it as `X-API-Key`;
without it a keyed instance answers 401 and search stays broken even though
`CLOUD_FOOD_DB_URL` is set. The key is operator-owned and server-side only: it
never appears in a meta tag, a response body or header, or a log line — the
browser learns only that a food DB exists. Per-user BYO keys are unaffected,
since those go browser-direct and never touch this proxy.

Food is enabled by default on fresh accounts, so a new user's first
action on the Food screen is usually a search — and with no food DB configured
there is nothing to search but the products they have already logged.

If left unset, remote search degrades to local-only (products already logged).
That degradation is no longer silent: `fooddb.js`'s `remoteConfigured()` reports
false and the search UI renders an explicit "Food database not available right now." instead of "Found 0 result(s)." (med-1j1). A
user who typed a query is told the database is missing, not that their food
doesn't exist.

### Trial voice agent (`pnpm trial:agent`)

`TRIAL_ELEVENLABS_API_KEY` + `TRIAL_ELEVENLABS_AGENT_ID` let the server mint
signed URLs for one shared ElevenLabs agent that every trial user talks to. That
agent's tools and prompt are **not** provisioned by the server — nothing in
`cmd/cloud` touches the ElevenLabs management API. Push them from the repo:

```bash
TRIAL_ELEVENLABS_API_KEY=... TRIAL_ELEVENLABS_AGENT_ID=agent_... TRIAL_VOICE_LLM_URL=https://<base-domain>/api/voice-llm pnpm trial:agent           # dry run: prints the payload, calls nothing
TRIAL_ELEVENLABS_API_KEY=... TRIAL_ELEVENLABS_AGENT_ID=agent_... TRIAL_VOICE_LLM_URL=https://<base-domain>/api/voice-llm pnpm trial:agent --apply   # rewrites the live shared agent
```

It reads `TOOL_SPECS` and the agent config straight out of
`web/cloud/js/elevenlabs-agent.js` — the same source the BYO path provisions
itself from — creates or updates the trial account's own client tools (matched
by tool name; tool ids are per-ElevenLabs-account), and PATCHes the given agent
id. It never creates an agent, so the id in your env stays valid.

The shared agent answers through the voice LLM relay, so `TRIAL_VOICE_LLM_URL`
(`https://<base-domain>/api/voice-llm`; ElevenLabs POSTs `<url>/chat/completions`)
must be set when you run it — `--apply` refuses without it. The variable is read
only by this script, not by the server. After deploying the relay, set it and
re-run `pnpm trial:agent --apply` once.

`TRIAL_VOICE_MAX_CALL_SECONDS` (default 120, script-only like the URL) sets
the shared agent's ElevenLabs-side per-call cap (`max_duration_seconds`) — the
only duration lever on account trial calls, and the hard backstop under the
anonymous voice budget (keep it ≤ `TRIAL_ANON_VOICE_CALL_MAX_SECONDS`). The
script also sets `turn.silence_end_call_timeout` to 30 s so abandoned sessions
end on their own. BYO agents get neither. After deploying med-o7zq.22, run
`pnpm trial:agent --apply` once so the live agent carries them.

**Re-run it after every `TOOLSET_VERSION` bump.** This does not happen
automatically on deploy. BYO users reprovision themselves on their next voice
call; trial users keep whatever the shared agent was last given, which is how
the voice surface silently drifted apart before (#817).

### Anonymous trial for iOS local mode (optional, App Attest + DeviceCheck)

Off unless all of `APP_ATTEST_APP_ID`, `DEVICECHECK_KEY_ID`, `DEVICECHECK_TEAM_ID`
and `DEVICECHECK_PRIVATE_KEY_FILE` are set (and trial AI is configured). With
none of them set the routes answer 503 and the app offers "add your own key";
a partial set refuses to start. Protocol and
threat model: [cloud-mode.md → Anonymous trial](cloud-mode.md#anonymous-trial-ios-local-mode--app-attest--devicecheck).

1. Apple side (once): enable App Attest on the App ID, create a DeviceCheck key
   (Developer → Keys), note its Key ID and the Team ID, download the `.p8`.
2. Put the `.p8` **in the `cloud_data` volume**, not in env and not in git
   (`*.p8` is gitignored): the gitops stack has no host bind for secrets, and
   prod is operated through the Portainer API, which can upload into a running
   container: `PUT /api/endpoints/<id>/docker/containers/medtracker-cloud/archive?path=/app/data/secrets`
   with a tar holding `devicecheck.p8` (create `secrets/` first the same way).
   The entrypoint runs as uid 1000 and owns `/app/data`; make the file
   `0600` for uid 1000. Litestream replicates only `cloud.db`, so the key is
   not shipped to the backup bucket — keep the original in the secret store.
3. Set in the stack env: `APP_ATTEST_APP_ID=<TEAMID>.<bundle id>`,
   `DEVICECHECK_KEY_ID`, `DEVICECHECK_TEAM_ID`,
   `DEVICECHECK_PRIVATE_KEY_FILE=/app/data/secrets/devicecheck.p8`; optionally
   `TRIAL_ANON_LIFETIME_REQUESTS` (200), `TRIAL_ANON_DAILY` (50) and
   `TRIAL_ANON_FOOD_DAILY` (1000; the food routes also need `CLOUD_FOOD_DB_URL`), and
   the anonymous voice budgets in seconds — voice stays OFF until
   `TRIAL_ANON_VOICE_LIFETIME_SECONDS` is set (recommended, owner-approved: 600) — then
   `TRIAL_ANON_VOICE_DAILY_SECONDS` (300), `TRIAL_ANON_VOICE_GLOBAL_DAILY_SECONDS` (7200),
   `TRIAL_ANON_VOICE_CALL_MAX_SECONDS` (120, ≥ the agent's `TRIAL_VOICE_MAX_CALL_SECONDS`; voice also needs `TRIAL_ELEVENLABS_*` and
   trial AI, else 503 `voice_not_configured`). Redeploy.
   An unreadable or malformed key refuses to start, naming the variable only.
4. Verify: `curl -X POST https://<CLOUD_BASE_DOMAIN>/api/attest/challenge`
   returns `{"challenge":…}` (503 `trial_not_configured` = still off).

Rotating the key: upload the new `.p8`, change `DEVICECHECK_KEY_ID`, redeploy.
Existing installs keep working (DeviceCheck is only called at enrollment).

### Anonymous trial for Android local mode (optional, Play Integrity)

The Android twin of the above, on the same routes and quotas; independent of
the Apple vars. Off unless both `PLAY_INTEGRITY_PACKAGE_NAME` and
`PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE` are set; unset, Android enrolls answer
503 `trial_not_configured` and iOS is unaffected. A partial set, or an
unreadable or malformed key file, refuses to start, naming the variable only.

1. Google side (once): [android.md → Play Integrity setup](android.md#play-integrity-setup-owner)
   — the Play Integrity API enabled on the Cloud project linked in Play
   Console, and a service account's JSON key.
2. Put the JSON **in the `cloud_data` volume**, exactly like the `.p8` above:
   the same Portainer archive `PUT` into `/app/data/secrets`, a tar holding
   `play-integrity.json`, `0600` for uid 1000. Never in env, never in git
   (`data/secrets/` is gitignored); keep the original in the secret store.
3. Set in the stack env: `PLAY_INTEGRITY_PACKAGE_NAME=<applicationId>`,
   `PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE=/app/data/secrets/play-integrity.json`;
   leave `PLAY_INTEGRITY_ACCEPT_APP_VERDICTS` unset (`PLAY_RECOGNIZED` only)
   unless running a deliberate sideload test window
   (`PLAY_RECOGNIZED,UNRECOGNIZED_VERSION`, removed after). Redeploy.
4. Verify: the startup log has no `anonymous trial disabled kind=android`
   line. A log line `Google refused to decode the integrity token (HTTP 400)`
   on every Android enroll means the package name does not match the app; a
   `play integrity unavailable … status 403` means the service account needs
   **Service Usage Consumer** on the project.

Rotating the key: upload the new JSON over the old file, redeploy. Existing
Android installs keep working (Google is only called at enrollment).

Device recall (optional, the DeviceCheck-bits twin): once Google approves the
beta, turn on Device recall in Play Console (Protected with Play → Play
Integrity API → Manage → Change responses), then set
`PLAY_INTEGRITY_DEVICE_RECALL=1` and redeploy — never the other way round
(on without the Console switch, pass-less Android enrolls answer 503;
see [cloud-mode.md](cloud-mode.md#android--play-integrity)).

### Android Digital Asset Links (optional)

Set `ANDROID_PACKAGE` + `ANDROID_CERT_SHA256S` (see docs/environment.md) to
serve `/.well-known/assetlinks.json` on every host. Google caches Digital Asset
Links, so passkey/app-link verification can lag after the first deploy or a
fingerprint change; check the file with
`curl https://<sub>.<CLOUD_BASE_DOMAIN>/.well-known/assetlinks.json`.

### Telegram manager bot (optional, C3a)

One-time operator setup enables one-tap managed-bot provisioning for users
(BYO token entry works too, but the managed path needs this). Skip it and
Telegram is fully disabled — the onboarding wizard step and `/tg/*` webhook
routes simply don't register.

1. In BotFather, create a bot: `/newbot` → pick a name and username. This is
   the **manager** bot, not a user-facing one.
2. Open BotFather's MiniApp (`/mybots` → your bot → *Bot Settings*) and enable
   **Bot Management Mode**. This is what lets the manager bot receive
   `managed_bot` updates and fetch child-bot tokens (`getManagedBotToken`).
3. Set `MANAGER_BOT_TOKEN=<the token>` as a stack env var and redeploy. The
   compose service already forwards it into the container via
   `MANAGER_BOT_TOKEN=${MANAGER_BOT_TOKEN:-}` — a Portainer stack variable alone
   is not enough unless the compose `environment:` block references it. On
   startup the server calls `getMe` to resolve the manager username (no extra
   env) and registers the manager webhook at `https://<CLOUD_BASE_DOMAIN>/tg/manager/<secret>`.
   Log line `telegram disabled` means the token is unset (or not forwarded by
   compose); its absence is not an error.
4. Optional: set `FEEDBACK_ADMIN_CHAT_ID=<your numeric Telegram user id>` to have
   the manager bot DM you when feedback arrives, instead of only finding out by
   running `cmd/feedbackpull`. Press `/start` on the manager bot once first, or
   Telegram 403s the DM (harmless — it degrades to a log warning). Web feedback
   pings **metadata only** (kind + app version + time); the server still cannot
   read it. Telegram-origin feedback is relayed in full. Unset = no relay.
5. Invite requests (bd med-ta2n.14): the manager bot no longer mints on "yes" —
   it pings `FEEDBACK_ADMIN_CHAT_ID` with **Approve / Decline**, and only an
   Approve mints (cap 3 live invites per Telegram user) and DMs the link. The
   in-app "Request an invite" form (`POST /api/invite-requests` on the base
   host) uses the same buttons and, on Approve, emails the claim link — set the
   `SMTP_*` variables ([environment.md](environment.md)) for it. Telegram
   requests need only the manager bot and the admin chat; the email form also
   needs SMTP. The startup log line `invite requests email=<bool>
   telegram=<bool>` says which are on. A partial SMTP set logs an error naming
   the missing variables and keeps the email form off — the server still
   starts. With no admin chat, the bot answers "Invites are closed right now."

**Token-at-rest trade-off (read before setting `SESSION_SECRET`):** each child
bot token is sealed with AES-GCM under a key derived from `SESSION_SECRET`
(HKDF, `info="mt/tg-token/v1"`). Zero new secrets to operate — but **rotating
`SESSION_SECRET` orphans every stored bot token**: the old tokens can no longer
be decrypted, so linked users must re-link (re-run the wizard step or re-enter a
BYO token). Rotating `SESSION_SECRET` also invalidates sessions, so treat it as
a disruptive operation. The managed bots themselves stay owned by the users in
Telegram regardless.

`CLOUD_TG_API_BASE_URL` overrides the Bot API root (default
`https://api.telegram.org`) — for tests or a self-hosted API proxy. Enabling
the proxy is what unlocks large-file imports; see below.

### Large-file / Mi Band imports (local Bot API proxy)

Telegram's public Bot API (`api.telegram.org`) refuses `getFile` for any file
larger than **20 MB**, so a user sending a Mi Band `.nxk` backup over their
cloud child bot gets `❌ That file is larger than Telegram's 20 MB bot limit`.
Most Mi Band backups exceed 20 MB. The fix is a
self-hosted **local Bot API server** (`--local` mode, ~2 GB limit) that hands
back downloaded files on a shared volume the app reads directly.

`docker-compose.cloud.yml` ships this as an **opt-in** `telegram-bot-api`
service that stays inactive (clean exit) unless you provide credentials. To
enable it:

1. Get a Telegram **API ID + API hash** from <https://my.telegram.org> (app
   credentials — distinct from a bot token).
2. Set these stack variables (compose forwards them):

   ```
   TELEGRAM_API_ID=<id>
   TELEGRAM_API_HASH=<hash>
   CLOUD_TG_API_BASE_URL=http://telegram-bot-api:8081
   ```

3. Redeploy. The `telegram-bot-api` service starts, and the cloud app resolves
   large files via the proxy over the shared `telegram_bot_api_data` volume.

Leave all three unset to keep the default behavior — the app talks to
`api.telegram.org` and small files still import fine.

#### One-time migration for bots linked BEFORE the proxy

Telegram `file_id`s are only valid on the exact Bot API server that issued
them. A bot linked while the proxy was **off** registered its webhook on
`api.telegram.org`, so Telegram keeps delivering its updates through the cloud
with cloud-issued `file_id`s. After you enable the proxy, the app resolves
`getFile` against the **local** server, which rejects those cloud `file_id`s —
the user sees `❌ This bot needs a one-time migration…` and the logs show
`invalid file_id`.

Moving a bot from the cloud to the local server requires releasing it from
Telegram's datacenter first (per the telegram-bot-api docs): `logOut` on
`api.telegram.org`, then re-`setWebhook` through the proxy. Run this once, after
enabling the proxy on a deployment that already has linked bots:

```bash
docker exec -it medtracker-cloud ./cloud admin migrate-bots-to-proxy
```

It iterates every not-yet-migrated bot, does the `logOut` → `setWebhook`-via-proxy
dance, and stamps each as migrated (idempotent — a re-run is a no-op, and it
never re-`logOut`s an already-migrated bot). **Note:** `logOut` locks a bot out
of the cloud API for ~10 minutes, so this is an explicit operator command, never
an automatic per-startup action. Bots linked **while the proxy is enabled** are
born on the proxy and need no migration.

**Internal webhook delivery.** In `--local` mode the proxy container delivers
webhook callbacks itself, and it cannot resolve the deployment's public host
(that name hairpins to loopback inside the container). So proxy-delivered child
bots register their webhook at an **internal** docker-network origin instead of
the public URL: `CLOUD_INTERNAL_WEBHOOK_BASE` (default `http://cloud:8080` — the
`cloud` service + `PORT`; override if you changed `PORT`). This is applied
automatically whenever `CLOUD_TG_API_BASE_URL` is set, in both `migrate-bots-to-proxy`
and new-bot provisioning; with the proxy off, webhooks keep the public URL and
nothing changes. The manager bot itself always stays on `api.telegram.org` (the
local server doesn't implement the managed-bot token method).

> **Recovery after upgrading to the scoped-proxy build (bd med-eas.46):** an
> earlier proxy build pointed child webhooks at the unreachable public URL, so
> `/start` and messages went silently undelivered. After redeploying, re-run
> `migrate-bots-to-proxy` **once** so every already-migrated child bot has its
> webhook rewritten to the internal URL. Check delivery health per bot from
> Settings → Telegram (surfaces `getWebhookInfo.last_error`); the
> `telegram-bot-api` service now logs delivery attempts at `--verbosity=2`.

## 4. Mint the first invite

```bash
docker exec -it medtracker-cloud ./cloud admin invite
```

Prints the claim URL (and a terminal QR) for the operator to hand to the
first user. See [cloud-mode.md](cloud-mode.md) for the claim → passkey →
Emergency Kit flow this link starts.

## 5. Admin commands

`docker exec -it medtracker-cloud ./cloud admin <subcommand>` — every
subcommand opens its own DB handle, so these are safe to run at any time
against a live container:

- `invite` — pre-provision an account and print its claim URL + QR (above)
- `list` — one line per account: subdomain, claimed?, created, device count,
  op count, last sync activity
- `inspect <subdomain>` — full read-only debug view of one account: devices,
  envelopes, sync state, push queue. Answers "did the phone's write reach the
  server?", "does device 2 have an envelope?", "did snapshot compaction run?",
  "is the push queue draining?" without sqlite3 spelunking. Never prints
  secrets — claim tokens, nonces, MACs, and ciphertext bytes are omitted;
  only sizes, counts, and timestamps. Credential ids and envelope refs share
  the same 8-char prefix so device↔envelope pairings are eyeball-able.
- `invite-graph [--format=tree|dot|json]` — reconstruct and display the
  invitation forest from `accounts.created_by_account_id` provenance: roots are
  admin-CLI-minted accounts, invitees nest recursively under whoever minted
  their invite. Each account shows claimed vs pending (outstanding invite) and
  created date. Default `tree` is an ASCII forest; `dot` emits a Graphviz
  digraph (render with `./cloud admin invite-graph --format=dot | dot -Tsvg >
  invites.svg`); `json` emits `{nodes, edges}`. Accounts whose inviter was
  deleted appear under an "orphaned" section. Operator metadata only — no vault
  content, no secrets.
- `reset-claim <subdomain>` — issue a fresh claim token for an unclaimed
  account
- `revoke <subdomain>` — delete an unclaimed account (withdraw an unused
  invite)
- `delete <subdomain>` — delete an account and all its data (asks for
  confirmation)
- `migrate-bots-to-proxy` — one-time move of pre-proxy linked bots onto the
  local Bot API proxy (`logOut` on cloud → re-`setWebhook` via proxy) so their
  `file_id`s resolve. Idempotent; needs `CLOUD_TG_API_BASE_URL` + `SESSION_SECRET`.
  See [Large-file / Mi Band imports](#large-file--mi-band-imports-local-bot-api-proxy).

Sample `inspect` output (trimmed to one credential per section for brevity —
a real account can have more devices, a bigger record-type histogram, etc.):

```
$ ./cloud admin inspect amber-falcon-8k3q9x
account: amber-falcon-8k3q9x
  created: 2026-06-05T11:56:34Z
  claimed: true

devices:
  ref       transports       synced  sign_count  created               last_unlock
  cGhvbmUt  internal,hybrid  true    43          2026-06-05T11:56:34Z  2026-07-05T11:56:34Z
  bGFwdG9w  internal         false   7           2026-06-15T11:56:34Z  never

envelopes:
  ref       v  size
  bGFwdG9w  1  412B
  cGhvbmUt  1  412B

sync:
  ops: 140
  seq range: 501..640
  last append: 2026-07-05T05:56:34Z (device cGhvbmUt)
  record types:
    bp: 93
    weight: 47
  snapshot: seq 500, 47.1KiB, written 2026-07-05T05:56:34Z

push:
  subscriptions: 1 active, 0 disabled
  pending scheduled: 1
  next fire: 2026-07-05T12:41:34Z
```

An empty/unclaimed account renders every section explicitly (`devices: none`,
`envelopes: none`, `sync: ops: 0`, `snapshot: none`, `push: no
subscriptions`) rather than omitting them — a silently vanished section would
hide exactly the bugs this tool exists to surface.

## 6. Backups and restore

`cloud.db` is the whole system. It holds every account row, every device
envelope, every recovery verifier, and all vault ciphertext. Because cloud
mode is zero-knowledge, **the server ciphertext *is* the vault** — a user's
Emergency Kit recovery code decrypts `envelope_rec`, and `envelope_rec` lives
in this database (`internal/cloudserver/recovery.go`). Losing the volume does
not merely lose the data: it simultaneously invalidates every recovery code
that would have let anyone back in. There is no second copy anywhere else.

So the `litestream` service in `docker-compose.cloud.yml` is not optional for
a real deployment. It continuously replicates `cloud.db` to an S3-compatible
bucket (Cloudflare R2). Set `R2_BUCKET`, `R2_ENDPOINT`,
`LITESTREAM_ACCESS_KEY_ID` and `LITESTREAM_SECRET_ACCESS_KEY` in the stack env.

**Missing credentials fail the container, on purpose.** If `R2_BUCKET`,
`LITESTREAM_ACCESS_KEY_ID` or `LITESTREAM_SECRET_ACCESS_KEY` is unset, the
entrypoint prints which ones are missing and exits **1**, so the service sits
visibly restarting instead of quietly exited. It used to exit `0` — and on
this deployment it did exactly that, on every stack start, for weeks: nobody
noticed, and the cloud DB had no off-host copy at all (bd med-lhee). An
unbacked-up deployment must not look like a healthy one.

To run deliberately without replication (local dev, a throwaway stack), set
`LITESTREAM_DISABLED=1`. That prints a one-line notice and exits `0`, and
`restart: on-failure` leaves it exited. This is an acknowledgement, not a
default — never set it on the production stack.

`LITESTREAM_SYNC_INTERVAL` (default `1h`) is your worst-case data-loss window.

> **Retention/deletion policy — the shipped defaults are out of policy.**
> Backups must expire every object within **30 days**
> ([cloud-operations-security.md §3](cloud-operations-security.md#3-backups--required-deployment-decision)),
> and account deletion propagates to them by that expiry only (no proactive
> purge). But this file's defaults are `LITESTREAM_RETENTION_ENABLED=false`
> (nothing expires) and `LITESTREAM_RETENTION=1680h` (70 days) once enabled.
> When you turn litestream on, **also** bound the retention — preferably with
> an object-store lifecycle rule on the litestream prefix, which holds even if
> the replicator misbehaves.

Litestream requires WAL journaling. `cloud.db` is opened through
`internal/store/db`, which sets `PRAGMA journal_mode=WAL` unconditionally, so
this holds by construction — verify with
`docker exec medtracker-cloud sqlite3 /app/data/cloud.db 'PRAGMA journal_mode;'`
if you ever change how the DB is opened.

### Verify replication is live

"The container is running" is necessary, not sufficient — and "exited (0)"
reads as success at a glance, which is precisely how this went unnoticed for
weeks. Check both the process and the bytes:

```bash
# 1. Process: expect "Up". "Restarting" means it is shouting about missing
#    creds (read the log). "Exited (0)" now only happens with
#    LITESTREAM_DISABLED=1 — on prod that is itself the bug.
docker compose -f docker-compose.cloud.yml ps litestream
docker logs --tail 20 medtracker-cloud-litestream

# 2. Bytes: list what actually reached the bucket. The running container
#    already holds the generated config at /tmp/litestream.yml.
docker exec medtracker-cloud-litestream \
  litestream ltx -config /tmp/litestream.yml -level all /app/data/cloud.db
```

Step 2 must print rows (files, sizes, transaction ids). **Empty output means
configured-but-never-replicated** — credentials accepted, nothing stored — with
one caveat: nothing is uploaded until the first sync, so empty output is
expected for up to `LITESTREAM_SYNC_INTERVAL` (default `1h`) after a fresh
start or a restart. Empty an hour later is the real alarm.

> **Version gotcha.** The image is tagged `0.3.13` but ships **litestream
> v0.5.9** (`docker run --rm ghcr.io/korjavin/litestream:0.3.13 version`).
> Litestream 0.3-era commands you'll find in older notes — `litestream
> snapshots`, `litestream generations` — **do not exist** in this binary. The
> v0.5 equivalents are `ltx` (above), `databases`, and `status`; that is also
> why the compose config uses the v0.5 `levels:` / `l0-retention:` keys.

### Restore drill (non-destructive)

Run this periodically — it is the only thing that turns "backups are
configured" into "backups work". It touches neither the live container nor the
`cloud_data` volume: the replica is restored into a scratch directory on the
host and opened there.

These commands read `R2_*` / `LITESTREAM_*` from *your shell*, but on this
deployment they live in the Portainer stack env — **export them in the shell
first** or every step fails confusingly.

```bash
# Self-contained: the drill writes its own config, so it does not depend on the
# runbook below (whose step 1 stops the app — do NOT run that for a drill).
mkdir -p /var/tmp/ls-drill && rm -rf /var/tmp/ls-drill/*
cat > /var/tmp/ls-drill/restore.yml <<EOF
dbs:
  - path: /app/data/cloud.db
    replica:
      type: s3
      bucket: ${R2_BUCKET}
      path: ${LITESTREAM_PATH:-medtracker-cloud}
      endpoint: ${R2_ENDPOINT}
EOF

# The scratch dir is mounted at /app/data — NOT the cloud_data volume. The app
# image's entrypoint drops to uid 1000 and chowns only /app/data, so restoring
# anywhere else leaves a root-owned file the next step cannot open.
docker run --rm \
  -e LITESTREAM_ACCESS_KEY_ID -e LITESTREAM_SECRET_ACCESS_KEY \
  -v /var/tmp/ls-drill:/app/data \
  ghcr.io/korjavin/litestream:0.3.13 \
  restore -config /app/data/restore.yml -o /app/data/drill.db /app/data/cloud.db

# Integrity: the app image has no sqlite3, so open the file with the app's own
# admin CLI — it migrates and lists accounts. Accounts printed = schema and
# rows survived the round trip.
docker run --rm -v /var/tmp/ls-drill:/app/data \
  -e CLOUD_BASE_DOMAIN -e SESSION_SECRET \
  -e CLOUD_DB_PATH=/app/data/drill.db \
  ghcr.io/korjavin/medicationtrackerbot:latest ./cloud admin list

# If the host has sqlite3, also:
sqlite3 /var/tmp/ls-drill/drill.db 'PRAGMA integrity_check;'   # -> ok

rm -rf /var/tmp/ls-drill
```

A drill that prints the expected account count and `ok` is a pass. A drill that
prints nothing, or fewer accounts than `docker exec medtracker-cloud ./cloud
admin list` shows, is an incident — go to the runbook below.

### Bucket security

The bucket holds ciphertext only, so it never needs to be trusted with
plaintext. But it *does* hold everything an attacker needs to mount an
**offline** brute-force against every account at once — no rate limit, no
server in the way. Use a **private** bucket with **its own** credentials,
scoped to this prefix and nothing else, and do not reuse the bot stack's
keys. If both stacks share a bucket, keep `LITESTREAM_PATH` distinct
(`medtracker-cloud` vs the bot's `medtracker`).

### Restore runbook

*A backup nobody has restored is a rumour.* This procedure was performed
end-to-end on 2026-07-10 against a real `cloud.db` (see "Verified" below).

```bash
# 1. Stop the app so nothing writes while you restore.
docker compose -f docker-compose.cloud.yml stop cloud litestream

# 2. Point litestream at the bucket. R2 needs a custom endpoint, which the
#    bare s3:// URL form cannot express — so restore with a config file, the
#    same dialect the compose service generates.
cat > /tmp/restore.yml <<EOF
dbs:
  - path: /app/data/cloud.db
    replica:
      type: s3
      bucket: ${R2_BUCKET}
      path: ${LITESTREAM_PATH:-medtracker-cloud}
      endpoint: ${R2_ENDPOINT}
EOF

# 3. Restore into a SCRATCH path — never straight over the live file.
docker run --rm \
  -e LITESTREAM_ACCESS_KEY_ID -e LITESTREAM_SECRET_ACCESS_KEY \
  -v cloud_data:/app/data -v /tmp/restore.yml:/tmp/restore.yml:ro \
  ghcr.io/korjavin/litestream:0.3.13 \
  restore -config /tmp/restore.yml -o /app/data/cloud.restored.db /app/data/cloud.db

# 4. Verify BEFORE you trust it. The app image has no sqlite3, so read the
#    restored file with the app's own admin CLI: it opens the DB, runs
#    migrations, and lists accounts. If this prints your accounts, the
#    schema and rows survived.
docker run --rm -v cloud_data:/app/data \
  -e CLOUD_BASE_DOMAIN -e SESSION_SECRET \
  -e CLOUD_DB_PATH=/app/data/cloud.restored.db \
  ghcr.io/korjavin/medicationtrackerbot:latest ./cloud admin list

# 5. Swap it in, keeping the corpse for forensics.
docker run --rm -v cloud_data:/app/data \
  ghcr.io/korjavin/medicationtrackerbot:latest sh -c \
  'mv /app/data/cloud.db /app/data/cloud.db.bad 2>/dev/null; \
   mv /app/data/cloud.restored.db /app/data/cloud.db; \
   rm -f /app/data/cloud.db-wal /app/data/cloud.db-shm'

# 6. Boot and confirm the server reads it.
docker compose -f docker-compose.cloud.yml up -d cloud litestream
docker exec medtracker-cloud ./cloud admin list      # accounts are back
curl -fsS https://$CLOUD_BASE_DOMAIN/healthz         # -> 200
```

If you have `sqlite3` to hand, also run `PRAGMA integrity_check;` (expect
`ok`) and spot-check `select count(*) from envelopes where credential_ref =
'envelope_rec';` against the number of accounts.

Then finish in a browser: open an account subdomain, unlock with a passkey,
and confirm the vault decrypts and data renders. **Only the browser step
proves the ciphertext is usable**, because the server cannot decrypt anything
— steps 3–6 only prove the bytes came back.

Step 5 deletes any stale `-wal` / `-shm` sidecars. A restored `.db` paired
with the *old* WAL is a corrupted database, and SQLite will not always say so.

### Verified

Rehearsed on 2026-07-10 with litestream v0.3.13 against a file replica (the
S3 replica differs only in transport). **Note the drift:** the image tagged
`0.3.13` now ships v0.5.9 (see the version gotcha above), so this rehearsal
predates the binary currently deployed — the restore *commands* below were
re-checked against v0.5.9 on 2026-09-05, but the end-to-end round trip has not
been repeated since. That is what the [restore drill](#restore-drill-non-destructive)
is for.

1. Created a real `cloud.db` via `cloud admin invite`, confirmed
   `PRAGMA journal_mode` → `wal`, and seeded a known `envelope_rec` ciphertext.
2. Started `litestream replicate`, then wrote a *second* account while
   replication was live — so the test covers WAL shipping, not just the
   initial snapshot.
3. Deleted `cloud.db`, `-wal` and `-shm` (simulating volume loss) and ran
   `litestream restore`.
4. Result: both accounts present, `envelope_rec` ciphertext byte-identical,
   `PRAGMA integrity_check` → `ok`, `cloud admin list` listed both accounts,
   and `cmd/cloud` booted against the restored file with `/healthz` → 200.

## 7. Operating it (health, disk, 3am)

**No metrics stack, deliberately.** Five friends do not need Prometheus. The
structured `slog` lines already carry what you need, and this section says which
to grep. Do not fill this gap with yaml.

### Prod access: the Portainer API, not SSH

Production operations (logs, admin commands, one-off containers such as a
restore drill) go through Portainer's docker API proxy: container `exec`,
`logs`, and `create`/`start`/`DELETE` for one-off containers. SSH to the host is
a last resort. The Portainer URL and API key live in kv `secrets/portainer`.

Minting an invite on prod = `exec` `./cloud admin invite` in the cloud app
container; the output is the claim URL plus a terminal QR
([`cmd/cloud/admin.go`](../cmd/cloud/admin.go), §4 above).

### Health endpoints

| Endpoint | Means | Use it for |
|---|---|---|
| `GET /healthz` | The process is running. Always `200 ok`. | The container liveness probe. Restarting fixes a wedged process; it will not fix a full disk, so this must not fail on one. |
| `GET /readyz` | This instance can actually **serve**: it just read the database. `{"status":"ready","build":"<id>"}`, or `503 {"status":"unready"}`. | Your uptime check, and the first thing to curl when something is wrong. |

`/readyz` performs a real read of a real table rather than a `Ping` — a ping
succeeds against a handle whose file has been deleted or whose schema never
migrated. It reports the same build id as `GET /api/version`, so you can tell
which build answered. It deliberately does **not** report the account count: it
is unauthenticated, and how many friends are on the box is nobody else's
business.

```bash
curl -fsS https://$CLOUD_BASE_DOMAIN/readyz     # -> {"status":"ready","build":"..."}
```

### The disk filled up

This is the failure that hurts, because SQLite writes stop while reads keep
working, so the app looks half-alive.

```bash
df -h                                             # confirm it
docker exec medtracker-cloud ls -la /app/data     # cloud.db + -wal + -shm
docker system df                                  # usually images/logs, not the vault
docker image prune -a && docker builder prune     # reclaim first, investigate after
```

`cloud.db-wal` growing without bound means litestream is **not** checkpointing —
run the [verify check](#verify-replication-is-live) (§6). `Restarting` means the
credentials are missing and it is saying so; `Exited (0)` means someone set
`LITESTREAM_DISABLED=1`. Either way there is no off-host backup right now.

A single runaway account cannot do this: `CLOUD_ACCOUNT_QUOTA_BYTES` is on by
default (50MB per account) and the server answers an over-quota write with 413,
which the client surfaces as "Vault is full", not as a sync failure.

### What to grep at 3am

Every line is `slog` JSON-ish key=value. Nothing below prints secrets — the
redaction invariants in `trial.go` / `trial_proxy.go` are enforced by tests,
and push-subscription endpoints (a per-device bearer capability) are logged as
a short non-reversible `endpoint_fp=fp_…` fingerprint, never the raw URL
(`log_redact.go`, guarded by `TestNoRawPushEndpointInLogs`). So a push line
correlates across retries without any log holding a pushable endpoint.

```bash
docker logs medtracker-cloud --since 1h 2>&1 | grep 'level=ERROR'
```

| Symptom | Grep for | What it means |
|---|---|---|
| "my reminders stopped" | `push relay: send failed` | The push service rejected a send. A 410/404 disables that subscription automatically (`push relay: disable subscription`); the client re-subscribes on the next app open. |
| Reminders stopped for one account | `push relay: account has no VAPID keys` | Its VAPID keypair is missing. The boot backfill logs `VAPID key backfill complete` — if that ran, the DB write failed. |
| "the app says my vault is full" | `sync: account storage quota exceeded` | That account hit `CLOUD_ACCOUNT_QUOTA_BYTES`. Raise it, or have them export and prune. The line carries the `accountID`. |
| Sync fails for one account only | `sync: append ops` | A DB-level failure on their append. Anything else and the client would say "Offline". |
| AI/voice suddenly 503s | `upstream_error` | Operator trial keys exhausted or the provider is down. BYO keys are unaffected. |
| Telegram reminders silent | `push relay: telegram send` | Revoked bot token, or the user never tapped `/start`. |
| Nothing works, `/healthz` still 200 | `readyz: database unreadable` | The database is gone or corrupt. Go to §6's restore runbook. |

The account id is in most lines; `docker exec medtracker-cloud ./cloud admin
inspect <subdomain>` turns a subdomain into everything known about that account
(devices, envelopes, sync cursor, push subscriptions) without touching the vault.

### Proxy access logs and `/mcp/*` capability paths

The app's own `slog` output redacts secrets (above). Your **reverse-proxy
access log** does not, and two URL shapes carry sensitive material in the
request line that most proxies record verbatim:

- **Hosted MCP capability tokens** travel *in the URL path* (`/mcp/<token>/…`).
  A raw access log becomes a file full of live MCP bearer tokens.
- **RxNav drug-name lookups** travel *in the query string* (`/api/rxnav/*?…`).
  The app itself never logs them (fixed-string log invariant + `urlErrCause`
  sanitization in `rxnav_proxy.go` / `proxy_upstream.go`), but a proxy that logs
  request URIs turns its access log into a queryable record of which medications
  each account looked up.

Traefik's access log is **off by default**, and the app stack does not turn it
on — so out of the box there is no proxy log to leak. Only enable it if you
have a reason to, and if you do, drop or hash the capability segment before it
lands on disk:

- **Prefer not logging paths or queries at all.** Traefik's access log supports
  field filtering — set `RequestPath` to `drop` (or `redact`) in the access-log
  `fields` config so both the `/mcp/<token>` path segment *and* the
  `/api/rxnav/*` query string never reach the log. Keep `RequestHost`/status/
  duration if you need ops signal.
- **If you must keep paths**, put the capability behind a header or terminate
  it at the app, not in the URL — a path token or a query drug name is
  unavoidably logged by any intermediary that logs URIs (CDN, load balancer,
  WAF), not just Traefik.
- **Same rule for any intermediary**: Cloudflare (the wildcard is DNS-only /
  grey-cloud here, §1, so it does not see paths), a WAF, or an L7 load
  balancer must not retain `/mcp/*` paths or `/api/rxnav/*` query strings in a
  queryable log.

Retention and erasure of whatever proxy/app logs you *do* keep — how long,
where backed up, what a deletion request removes from them — is operator policy,
documented in
[cloud-operations-security.md](cloud-operations-security.md) (cloud
retention/backup/deletion policy), not here. This section only covers keeping
the capability and drug-name query out of the log in the first place.

## 8. Connect Claude (PoC)

MCP tier 1 (see [cloud-mode.md → MCP](cloud-mode.md#mcp)) lets Claude Desktop
or Claude Code query your vault through a local shim + blind relay — no
content ever reaches the server.

1. In the unlocked PWA, go to Settings → "Connect Claude" and mint a pairing
   code (one-time, shown once — copy it now).
2. On the machine running Claude, build the shim from the repo:
   ```bash
   go build -o mcpshim ./cmd/mcpshim
   ```
3. Add it to Claude Code's or Claude Desktop's MCP server config:
   ```json
   {
     "mcpServers": {
       "medtracker": {
         "command": "/path/to/mcpshim",
         "env": { "MEDTRACKER_MCP_CODE": "mtmcp1...." }
       }
     }
   }
   ```
4. Ask Claude something like "what BP readings do I have?" — it discovers
   ops via `mcp_help`, then calls `mcp_call` for `bp.list`/`bp.create`/etc.,
   answered live by the unlocked browser tab. Close the tab and the shim
   returns a clear "open your app and unlock it" error instead of hanging.

Settings → "Disconnect" revokes the pairing and drops the stored key.

## Serving (C1)

Account subdomains now serve the full `web/static` app (BP + weight ported to
the in-browser `web/domain/` layer, see [cloud-mode.md](cloud-mode.md)), not
just the signup/unlock shell. Routing: `/` → the app's `index.html`; the
unlock/claim/recovery wizard moved to explicit paths — `/unlock`, `/claim`,
`/recover` — still rewriting to the embedded `web/cloud` shell's
`signup.html`; `/api/*` unchanged.

## Local dev loop

`CLOUD_BASE_DOMAIN=localhost` works without any DNS or infra: `*.localhost`
subdomains are secure contexts and resolve without configuration, giving a
full local loop including passkeys on desktop.

### Local CI via act (optional)

`scripts/ci-local.sh` runs the act-friendly subset of GitHub Actions locally
with [nektos/act](https://github.com/nektos/act) — `deploy.yml`'s `test` job,
`golangci-lint.yml`, and `frontend-tests.yml` — stopping at the first failure
and naming it. `.actrc` pins the runner image
(`catthehacker/ubuntu:act-latest`) and `linux/amd64`, which Apple Silicon needs,
and points `--env-file`/`--secret-file` at `/dev/null` — otherwise act defaults
to loading the root `.env` from §2 above and would hand `CF_DNS_API_TOKEN` to
every workflow step and third-party action. None of the three needs a secret.

It is **not** a required step and deliberately has no git hook. For code checks
it is redundant with `go build ./... && TZ=UTC go test ./...`, `pnpm test` and
`golangci-lint run`, minus a multi-GB image and emulation overhead. Reach for it
in the three cases where those commands cannot help:

- you changed something under `.github/workflows/` and want the wiring checked
  before pushing,
- CI is red but everything passes locally,
- you added a new action or step and want a sanity run.

Two things the script works around, worth knowing when you read its output:

- **`node` disappears mid-job.** Once an action writes to `GITHUB_PATH`
  (`pnpm/action-setup` and `setup-go` both do), act rebuilds `PATH` from its own
  default and drops the image's node in `/opt/acttoolcache`, so the *next* JS
  action dies with `exec: "node": executable file not found in $PATH`. The
  script seeds `--env PATH=` from the image's own `PATH` to keep it.
- **The vitest shards can go red under emulation.** amd64-on-ARM is slow enough
  to blow the suite's 10s hook timeouts, which is a local artifact, not a real
  failure. That leg therefore runs last; treat a `Hook timed out` there as noise
  and let CI be the frontend gate.

The rest of the workflows are not worth running locally: the docker
build/push jobs need DinD plus registry secrets, and the scanning/audit
workflows (`trivy`, `secrets-scanning-native`, `go-dependency-check`,
`go-licenses-audit`) all lean on `github-script`, `upload-sarif`, or the GitHub
API and partial-fail off GitHub.

## API endpoints (`internal/cloudserver`)

All routes are host-routed off the account's subdomain except where noted.
Full ceremony details: [cloud-crypto.md](cloud-crypto.md).

| Route | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | Liveness. Always `200 ok` — see §7 |
| `GET /readyz` | none | Readiness: reads the database. `{"status":"ready","build":"<id>"}` or `503` — see §7 |
| `POST /api/webauthn/register/begin`, `POST /api/webauthn/register/finish` | claim token, enrollment token, or session | Register a passkey — first device (C0a), transfer/recovery target, or an additional local passkey |
| `POST /api/webauthn/login/begin`, `POST /api/webauthn/login/finish` | none | Cold-unlock assertion; issues a session token bound to `credential_id` |
| `GET /api/envelopes`, `GET /api/envelopes/{credential_ref}`, `PUT /api/envelopes/{credential_ref}` | session | Fetch/upload wrapped-DEK envelopes. `credential_ref` is a credential id; `GET` also accepts `"recovery"`, but `PUT` of `"recovery"` is rejected (409) — write the recovery envelope via `PUT /api/recovery-material` |
| `PUT /api/recovery-material` | session | Atomically upload the recovery envelope + its verifier hash in one write (signup, and forced rotation after redemption) — the only write path for recovery material |
| `POST /api/loss-ack` | session | Record the "I understand data is unrecoverable" onboarding acknowledgment |
| `POST /api/account/reauth` | session | Begin the fresh-passkey assertion that gates account deletion — challenge cookie scoped to `/api/account` |
| `DELETE /api/account` | session **+ fresh passkey** | Self-service account deletion. Requires the assertion from `/api/account/reauth` in the body, so a stolen session cookie alone cannot delete a vault. Removes every account-keyed row in one transaction and tears down the Telegram webhook + MCP pairings. 204, session cookie cleared |
| `POST /api/transfer` | session | Old device: create a transfer slot (`{ct}`) → `{slot_id, expires_at}`; the enrollment token is minted at claim time, not here |
| `POST /api/transfer/{slot_id}/claim` | none | New device: single-fetch claim → `{ct, enrollment_token}`; 410 once fetched or expired |
| `GET /api/transfer/{slot_id}` | session | Old device: poll `{status: pending\|claimed}` so the QR screen can report success. Scoped to the owning account — unknown, expired and other-account slots all 404 alike, so a slot id is never a status oracle for whoever holds the QR |
| `DELETE /api/transfer/{slot_id}` | session | Old device: invalidate the slot immediately. Cancel means cancelled — the code stops being claimable at once, not when its 10-minute window runs out. 204 even if it was already gone |
| `POST /api/recover` | none | Redeem a recovery-code verifier (rate-limited 5/hour/account) → recovery envelope + enrollment token |
| `GET /api/devices` | session | List credentials joined with their envelopes, for the device-list/audit UI |
| `DELETE /api/devices/{credential_id}` | session | Revoke a device: deletes credential + envelope in one tx; rejects removing the last verified credential unless usable recovery material (recovery envelope + verifier) exists |
| `POST /api/sync/ops`, `GET /api/sync/ops?since=<seq>` | session | Append a batch of encrypted oplog entries (server assigns contiguous `seq`) / page through ops since a cursor. Per-op and per-batch size caps + per-account quota (413 on breach) |
| `POST /api/sync/snapshot`, `GET /api/sync/snapshot` | session | Upload a compacting snapshot (deletes oplog rows `seq <= snapshot_seq`) / fetch the latest snapshot (204 when none) — new-device bootstrap is snapshot + ops-since |
| `POST /api/push/subscriptions`, `DELETE /api/push/subscriptions` | session | Register/remove a Web Push subscription for the relay |
| `GET /api/push/vapid-public-key` | none | Public VAPID key for the browser's `PushManager.subscribe` call |
| `PUT /api/push/schedule` | session | Replace-all: clears this account's unsent future entries, inserts a batch of `{fire_at_unix, ct}` (app-layer-encrypted payloads the sender goroutine fires blindly) |
