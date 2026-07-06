# Cloud C3a — Telegram managed-bot creation + onboarding setup

Fourth cloud plan. **Depends on `2026-07-03-cloud-c0a-foundation-passkey-signup.md` only** (accounts, sessions, cloudstore, wizard, admin CLI) — parallel-safe with C0b/C0c. Out of scope here, deferred to **C3b** (after C0c): reminder delivery over Telegram (needs the scheduled-queue delivery flags) and the sealed inbound mailbox for Confirm/Snooze (needs vault records + sync). This plan ends with a user owning a linked personal bot that provably works (welcome message + test notification button).

Normative context: [docs/cloud-mode.md](../cloud-mode.md) "Telegram (optional, BYO bot token)" section — Managed Bots provisioning (Bot API 9.6, April 2026) + BYO fallback + the channel-credential consent posture.

## Overview

Optional Telegram setup during onboarding, one tap: the cloud's **manager bot** (one-time operator setup via BotFather's "Bot Management Mode") lets a user create their own personal bot from a pre-filled dialog via a `https://t.me/newbot/{manager}/{suggested}?name=…` deep link. The cloud receives the `managed_bot` update, fetches the child bot's token (`getManagedBotToken`), stores it encrypted, wires a webhook, and links the user's chat on `/start`. Manual BYO token entry remains the fallback (same downstream code path — a token is a token). Explicitly skippable, gated by a consent screen that names the one server-visible secret and what the operator could do with it.

**Risk framing**: the Managed Bots API is ~3 months old with undocumented limits and revocation semantics. The plan is structured so the BYO path works end-to-end regardless — managed provisioning is an enhancement layered on top, and its real-Telegram validation is a Post-Completion gate before inviting users to rely on it.

## Context (from discovery)

- Bot API 9.6 additions (verified against the [official changelog](https://core.telegram.org/bots/api-changelog) and [features docs](https://core.telegram.org/bots/features)): `getManagedBotToken`, `replaceManagedBotToken`, `managed_bot` update (`ManagedBotUpdated`), `t.me/newbot/{manager}/{suggested}` deep links, `can_manage_bots` on User. No Go library support assumed — call the Bot API over raw HTTP (it's a small, stable JSON surface).
- Binding subtlety: the creation dialog's username is "pre-filled but **editable**" — a user who edits it breaks suggested-username matching. v1 treats the random-suffix username as the pairing key and the wizard copy says "keep the suggested name"; whether `ManagedBotUpdated` carries the originating link is an empirical question (⚠️ record the answer in Post-Completion validation). Edited-username fallback = retry or BYO.
- C0a artifacts reused: `internal/cloudstore` (new migration follows its pattern), session middleware, stateless-wizard derived steps, `accounts`-table ack-flag pattern (`loss_ack_unix` → same shape for `tg_skipped_unix`).
- Token-at-rest encryption: derive a key from `SESSION_SECRET` via HKDF (`info="mt/tg-token/v1"`), AES-GCM. Zero new secrets to operate; accepted trade-off: rotating `SESSION_SECRET` orphans stored bot tokens (users re-link — document it).
- Webhooks over polling: N child bots each need updates; per-bot `getUpdates` goroutines don't scale and fight restarts. Telegram calls `https://<CLOUD_BASE_DOMAIN>/tg/<bot_ref>/<secret>` (base host — server-to-server, coexists with the static landing page) with the `X-Telegram-Bot-Api-Secret-Token` header double-check.
- The MCP coverage guard does not apply to `cmd/cloud`'s mux (separate binary).

## Development Approach

- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data migration, cross-component flow) and gives a guarantee manual checking can't
  - if no integration test adds a real guarantee, the task has NO test items — that is correct and expected
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: if a task adds an integration test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility (C0a flows unchanged; Telegram features fully disabled when `MANAGER_BOT_TOKEN` is unset — the wizard step simply doesn't render)

## Testing Strategy

- **Unit tests**: none. Do not add unit tests.
- **Integration tests**: the real boundary is the Telegram Bot API contract + our webhook/binding state machine. All tests run against an httptest fake of `api.telegram.org` (the client's base URL is injectable): provisioning → `managed_bot` update → token fetch → webhook set → `/start` link → linked status; BYO validation; webhook auth rejection; token encrypted at rest.
- **E2E tests**: none (real-Telegram validation is Post-Completion — it needs the operator's account).

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope

## What Goes Where

- **Implementation Steps**: migration, TG API client, provisioning/binding endpoints + webhooks, consent + wizard step, tests
- **Post-Completion**: manager-bot BotFather setup, real-Telegram managed-bots validation (limits, edited-username behavior, revocation semantics)

## Implementation Steps

### Task 1: cloudstore — Telegram bots migration + repo methods

- [x] migration `009_telegram.sql` (latest is `008_mcp_remote.sql`; take `009`, or the next contiguous number if another branch landed one first): `tg_bots(account_id TEXT PK, bot_id INTEGER NOT NULL, bot_username TEXT NOT NULL, token_ct BLOB NOT NULL, token_nonce BLOB NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('managed','byo')), chat_id INTEGER, webhook_secret TEXT NOT NULL, created_at_unix INTEGER NOT NULL, linked_at_unix INTEGER)`, `tg_pending(suggested_username TEXT PK, account_id TEXT NOT NULL, created_at_unix INTEGER NOT NULL, expires_at_unix INTEGER NOT NULL)`; add `tg_skipped_unix INTEGER` to `accounts`
- [x] repo methods: `CreatePending`, `ConsumePendingByUsername`, `UpsertBot`, `BotByAccount`, `BotByWebhookRef`, `LinkChat`, `DeleteBot`, `SetTGSkipped` — context-first, unix-seconds convention (in `internal/cloudstore/tg.go`; `Account.TGSkippedAt` wired into the account scan so Task 3's status endpoint can read the skip flag)
- [x] token seal/open helpers (HKDF from `SESSION_SECRET`, `info="mt/tg-token/v1"`, AES-GCM) in `internal/cloudserver` (`tg_token.go`)
- [x] integration test: migration + bot row roundtrip with token seal/open (guards the at-rest encryption actually decrypts after a store/load cycle) (`internal/cloudserver/tg_token_test.go`: seal→store→load→open, ciphertext-has-no-plaintext, wrong-secret rejection, pending single-use + expiry)

### Task 2: minimal Telegram Bot API client

- [x] `internal/cloudserver/tgapi` (or `internal/tgclient`): raw-HTTP client with injectable base URL; methods: `GetMe`, `GetManagedBotToken`, `SetWebhook` (with `secret_token`), `DeleteWebhook`, `SendMessage`; typed structs for `Update` covering `managed_bot` and `message` (`/start` payloads); honest error mapping (Telegram's `{ok:false, description}` envelope) — implemented in `internal/tgclient/tgclient.go`
- [x] manager-bot bootstrap at `cmd/cloud` startup when `MANAGER_BOT_TOKEN` is set: `GetMe` (resolves manager username — no extra env), `SetWebhook` to `/tg/manager/<secret>`; absent token → log "telegram disabled", skip all wiring — `TelegramAPI.Bootstrap` in `internal/cloudserver/telegram.go`, wired in `cmd/cloud/main.go`; webhook secret HKDF-derived from `SESSION_SECRET` (`CLOUD_TG_API_BASE_URL` overrides the API root for tests)
- [x] integration test: client against the httptest fake — success, API-error envelope, and secret-token header presence on SetWebhook (guards the contract our webhooks depend on) — `internal/tgclient/tgclient_test.go`

### Task 3: managed provisioning + manager webhook

- [x] `POST /api/telegram/provision` (session auth): generate `suggested_username` = `mt_<8 base32>_bot` (the random suffix IS the pairing key), insert `tg_pending` (TTL 1h), return `{deep_link, suggested_username}` where deep_link = `https://t.me/newbot/<manager>/<suggested>?name=Med Tracker` (`TelegramAPI.Provision` in `internal/cloudserver/telegram.go`; `RegisterAPIRoutes` wires it on the subdomain apiMux)
- [x] `POST /tg/manager/<secret>` webhook: on `managed_bot` update — match `ConsumePendingByUsername`; matched → `GetManagedBotToken`, seal + `UpsertBot(kind=managed)`, `SetWebhook` for the child at `/tg/bot/<account-scoped ref>/<per-bot secret>`; unmatched (edited username) → log + drop (⚠️ v1 ceiling, wizard copy mitigates; revisit after Post-Completion empirics) (`ManagerWebhook`; secret checked in both the path component and `X-Telegram-Bot-Api-Secret-Token` header, constant-time; `RegisterWebhookRoutes` wires it on the base-host mux in `cmd/cloud/main.go`)
- [x] `GET /api/telegram/status` (session auth): `{state: none|skipped|pending|bot_created|linked, bot_username?}` — drives the client's polling UI and the stateless wizard step (`Status`; adds `enabled:true` for Task 5; new `HasPendingByAccount` store method for the `pending` state)
- [x] integration test: provision → fake `managed_bot` update → status walks `pending → bot_created`; edited-username update leaves status `pending` — guards the binding state machine (`TestTelegramProvisioningStateMachine` in `internal/cloudserver/telegram_test.go`, also asserts token sealed at rest + wrong-secret 403)

### Task 4: chat linking + child webhook + BYO fallback

- [x] `POST /tg/bot/<ref>/<secret>` child webhook: on `/start` message — link `chat_id` (`LinkChat`), send the welcome message (the end-to-end proof: "Your Med Tracker bot is connected"); reject wrong secret with 403; ignore non-`/start` content in C3a (no command surface until C3b) (`ChildWebhook` in `internal/cloudserver/telegram.go`; loads bot by ref, constant-time secret check, welcome-send failure is non-fatal)
- [x] `POST /api/telegram/byo` (session auth): `{token}` → `GetMe` validation → seal + `UpsertBot(kind=byo)` + `SetWebhook`; linking then follows the same `/start` path (client shows `t.me/<bot_username>` link) (`BYO`; getMe rejection → 400, not 500)
- [x] `DELETE /api/telegram` (session auth): `DeleteWebhook`, remove row; note in response copy that a *managed* bot itself remains owned by the user (delete via BotFather if desired) (`Delete`; best-effort DeleteWebhook, then DeleteBot)
- [x] `POST /api/telegram/test` (session auth, linked only): sends a test notification through the bot — gives the wizard/settings a verifiable "it works" button (`Test`; 409 when unlinked)
- [x] integration test: `/start` links chat + emits welcome; wrong webhook secret 403s; BYO with invalid token rejected via fake `getMe`; DELETE cascades — guards the linking contract end-to-end (`TestTelegramLinkingAndBYO` in `internal/cloudserver/telegram_test.go`; recording fake asserts welcome + test messages sent)

### Task 5: client — consent screen + wizard step 5

- [x] consent screen (`web/cloud/js/telegram.js`): plain-language channel-credential warning per docs/cloud-mode.md (server-visible secret; message content at chosen verbosity visible to the relay; skippable) — Accept → provision flow; Skip → `POST /api/telegram/skip` (`tg_skipped_unix`) so the stateless wizard never re-nags (added the missing `Skip` handler + route to `internal/cloudserver/telegram.go`; `SetTGSkipped` store method already existed from Task 1)
- [x] managed flow UI: deep-link button ("keep the suggested bot name" copy), status polling (`pending → bot_created → linked`), then "open your bot and tap Start" using the returned `bot_username`, then test-notification button on `linked` (`mountTelegram` self-drives off `GET /api/telegram/status`; 2.5s poll, cleared on terminal/linked state)
- [x] BYO form behind an "advanced" disclosure: token input → validate → same linking UI (`<details>` disclosure → `POST /api/telegram/byo` → `renderOpenBot`; 400 surfaced as "token rejected by Telegram")
- [x] wizard step 5 derived-state rule: render when server config has Telegram enabled AND `status ∈ {none}`; settings screen hosts the same module for later linking/unlinking (signup.js `renderTelegramStep` after Emergency Kit; module self-gates to `onDone()` when disabled/already-resolved; devices.js hosts the same module in settings mode via `#telegram-mount`)
- [x] hide everything when the server reports Telegram disabled (no `MANAGER_BOT_TOKEN` and no BYO configured — status endpoint carries `enabled: bool`) (disabled → routes unregistered → status non-2xx → `getStatus` returns `{enabled:false}`; wizard falls through to done, settings mount clears itself)

### Task 6: Verify acceptance criteria

- [x] full walkthrough against the fake Telegram API in tests: consent → provision → managed_bot → token stored sealed → /start → linked → test message (`TestTelegramProvisioningStateMachine` + `TestTelegramLinkingAndBYO`, both pass)
- [x] verify Telegram-disabled mode: no wizard step, no webhook routes… routes may exist but 404/403 cleanly; no startup errors (`cmd/cloud/main.go`: `MANAGER_BOT_TOKEN` unset → logs "telegram disabled", `tgAPI` nil, neither `RegisterAPIRoutes` nor `RegisterWebhookRoutes` called; status carries `enabled:false`)
- [x] verify no plaintext bot tokens in DB rows, logs, or API responses (grep + test assertion) (`telegram_test.go:106` asserts `TokenCT` has no plaintext; Status returns only `enabled/state/bot_username`; `slog` calls log errors/bot_id/ref/account, never the token)
- [x] `go test ./...`, `pnpm test`, both build modes, linter — all pass/fixed (`go test ./...` green; server + `-tags mobile` builds OK; `go vet` + `golangci-lint` 0 issues; Telegram frontend test passes. ⚠️ `pnpm test` has 2 pre-existing failures in `cloud.shim-contract.food-ai.test.js` — C2c code untouched by this branch, not a C3a regression)

### Task 7: [Final] Update documentation

- [x] docs/cloud-mode.md: Telegram section status (C3a implemented — provisioning/linking; delivery + mailbox = C3b), record any spike findings (added a "Status: C3a implemented" note at the top of the Telegram section; real-Telegram empirics still open/Post-Completion)
- [x] docs/cloud-deployment.md: manager-bot BotFather setup runbook (create bot, enable "Bot Management Mode" in the BotFather MiniApp, set `MANAGER_BOT_TOKEN`); docs/environment.md: `MANAGER_BOT_TOKEN` (new "Telegram manager bot" subsection + env-var entries for `MANAGER_BOT_TOKEN` and `CLOUD_TG_API_BASE_URL`)
- [x] note the `SESSION_SECRET`-rotation-orphans-tokens trade-off where operators will see it (deployment doc) (called out in the runbook's "Token-at-rest trade-off" paragraph and in environment.md's `MANAGER_BOT_TOKEN` note)

## Technical Details

- **Endpoints**: `POST /api/telegram/{provision,byo,skip,test}`, `GET /api/telegram/status`, `DELETE /api/telegram` (subdomain host, session auth); `POST /tg/manager/<secret>`, `POST /tg/bot/<ref>/<secret>` (base host, Telegram server-to-server, secret-path + `X-Telegram-Bot-Api-Secret-Token` double check).
- **Binding key** = the random suffix in `suggested_username` (`mt_x7k2q9_bot`). Deliberate v1 ceiling: an edited username breaks the fast-path and the UI guides retry/BYO — `ponytail:` revisit only if Post-Completion shows `ManagedBotUpdated` carries the originating link (then bind on that instead).
- **Zero-knowledge posture unchanged**: this plan stores one channel credential (sealed) + chat id — both declared in the consent screen and in docs/cloud-mode.md's metadata table. No message content exists yet beyond the static welcome/test strings (server constants).
- **C3b preview (not this plan)**: delivery flags on the C0c scheduled queue (`webpush|telegram|both`, client-composed text at chosen verbosity), sealed inbound mailbox (X25519/P-256 per docs/cloud-crypto.md) for Confirm/Snooze callbacks.

## Post-Completion

**Operator setup**:
- Create the manager bot via BotFather; enable "Bot Management Mode" in BotFather's MiniApp; set `MANAGER_BOT_TOKEN` in the deployment

**Real-Telegram validation (gate before inviting users to rely on managed provisioning)**:
- Full managed flow on a real phone: deep link → pre-filled dialog → child bot created → token fetched → /start → welcome + test notification
- Record the empirics the docs flag as unknown: does `ManagedBotUpdated` reference the originating deep link (edited-username binding)? per-manager child-bot limits? what happens when the user revokes/deletes the managed bot via BotFather (token invalidation behavior → our error handling)?
- BYO fallback walkthrough with a hand-made BotFather bot
