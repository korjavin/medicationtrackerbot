# C2 pre-step: Per-Account VAPID Keys + Working Push Delivery in Cloud Mode

## Overview

Part of the C2 stage, and a hard prerequisite for C2b Task 5 (client-computed
reminders uploaded to the blind push relay): today the relay cannot deliver
anything in a real deployment, and would break on iOS if it could.

Three defects, one design upgrade:

1. **Deployment gap.** `docker-compose.cloud.yml` never forwards
   `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` into the
   container, so even an operator following `docs/cloud-deployment.md`
   exactly gets a silently disabled relay (`cmd/cloud/main.go:184` requires
   both keys). There is also no `.env.cloud.example` for the app stack.
2. **iOS subject fragility.** Apple's push service requires an `https://`
   VAPID subject; FCM/Mozilla want `mailto:`. The bot's
   `internal/webpush/webpush.go:310-339` switches per endpoint; the cloud
   relay's `WebPushSender` (`internal/cloudserver/relay.go:65`) uses the
   configured subject verbatim — and the relay disables subscriptions on
   4xx, so a wrong subject permanently kills iPhone subscriptions.
3. **Operator key management.** `genvapid` + pasting keys into Portainer is
   a manual step that can be eliminated entirely.
4. **Design upgrade: per-account VAPID keypairs**, generated server-side at
   invite provisioning. Push services bind each subscription to the
   `applicationServerKey` used at `subscribe()` time and reject pushes
   signed with a different key — so per-account keys make Apple/Google
   themselves reject any relay bug that routes account A's payload to
   account B's endpoint. Third enforcement layer on top of RFC 8291
   per-subscription encryption and NK app-layer encryption; fits the
   project's "don't trust the server" posture.

The VAPID **subject stays service-wide** (it identifies the relay operator
per RFC 8292, never the user — a user email in the VAPID JWT would leak
identity to Google/Apple, against the zero-knowledge design):
`VAPID_SUBJECT` env, defaulting to `mailto:noreply@<CLOUD_BASE_DOMAIN>`,
with the `https://<CLOUD_BASE_DOMAIN>` form substituted for Apple endpoints.

No migration concerns: prod's relay has been disabled since C0c shipped
(compose gap above) and `GET /api/push/vapid-public-key` 404s, so **no push
subscriptions exist anywhere**. Existing claimed accounts just need keys
backfilled; existing subscriptions do not.

## Context (from discovery)

- `cmd/cloud/main.go:37-52,172-191` — reads `VAPID_*` env, builds
  `NewPushAPI(store, sessionSecret, vapidPublicKey)`, enables relay only
  when both keys set.
- `internal/cloudserver/push.go` — `PushAPI` holds a single global
  `vapidPublicKey`; `GET /api/push/vapid-public-key` is unauthenticated and
  returns it (404 when empty). Subscription routes run behind
  `RequireSession`.
- `internal/cloudserver/router.go` — wildcard-host routing already resolves
  the subdomain to an account and stores it in the request context (helper
  around line 175); the push API can read the account from there.
- `internal/cloudserver/relay.go` — `WebPushSender{VAPIDPublicKey,
  VAPIDPrivateKey, VAPIDSubject}` used for every send; `PushSender`
  interface `Send(ctx, sub, ct)`; relay loop iterates due
  `ScheduledPush{AccountID, ...}` rows and the hourly stale-sync sweep, both
  per account. Disables a subscription on 4xx (404/410 and friends).
- `internal/cloudserver/provision.go:61` — `Provision` creates the
  unclaimed account row via `CreateAccount(ctx, id, subdomain,
  claimTokenHash, claimExpiresAt, createdAt)`.
- `internal/cloudstore/repo.go:114` — `CreateAccount`; `Account` struct;
  migrations live in `internal/cloudstore/migrations/` (next: `007_*.sql`).
- `github.com/SherClockHolmes/webpush-go` v1.4.0 provides
  `GenerateVAPIDKeys() (privateKey, publicKey string, err error)` — already
  a dependency.
- Apple/mailto subject switch reference: `internal/webpush/webpush.go:310-339`
  (bot mode — do not modify; cloud gets its own ~10-line copy since the bot
  version is entangled with bot config).
- Frontend `web/cloud/js/push.js:82-85` already fetches
  `/api/push/vapid-public-key` per origin (account subdomain) before
  subscribing — **no frontend changes needed**.
- Existing test files to extend: `internal/cloudserver/push_test.go`,
  `relay_test.go`, `provision_test.go`.

## Development Approach

- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data migration, cross-component flow) and gives a guarantee manual checking can't
  - if no integration test adds a real guarantee, the task has NO test items — that is correct and expected
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: if a task adds an integration test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility (bot-mode `internal/webpush` untouched)

## Testing Strategy

- **Unit tests**: none.
- **Integration tests**: extend the existing `cloudserver` handler/relay
  suites only where they guard real contracts: per-account key on the
  public-key endpoint, per-account keys reaching the sender, Apple subject
  switch, NULL-key backfill.
- **E2E tests**: none (no existing e2e suite covers push; real-device
  verification goes in Post-Completion).

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope

## Implementation Steps

### Task 1: Schema + store — per-account VAPID keypair

- [x] add `internal/cloudstore/migrations/007_account_vapid.sql`: `ALTER TABLE accounts ADD COLUMN vapid_public_key TEXT` + same for `vapid_private_key` (nullable — existing rows backfilled in Task 2)
- [x] add both fields to the `Account` struct and `scanAccount` in `internal/cloudstore/repo.go`
- [x] extend `CreateAccount` to accept and store the keypair
- [x] add `Repo.SetAccountVAPIDKeys(ctx, accountID, pub, priv string) error` (used only by backfill; refuses to overwrite non-NULL keys — rotation would orphan subscriptions)

### Task 2: Key generation at provisioning + startup backfill

- [x] `internal/cloudserver/provision.go`: `Provision` calls `webpush.GenerateVAPIDKeys()` and passes the pair to `CreateAccount` — every new invite carries keys from birth
- [x] add `internal/cloudstore` backfill query listing account IDs `WHERE vapid_public_key IS NULL`, and a small `cloudserver.BackfillVAPIDKeys(ctx, store)` loop generating + `SetAccountVAPIDKeys` for each
- [x] call the backfill once at `cmd/cloud` startup (before the relay starts), log count backfilled
- [x] extend `provision_test.go`: provisioned account has a non-empty distinct keypair; backfill fills NULL-key accounts and leaves populated ones untouched

### Task 3: Public-key endpoint goes per-account

- [x] `internal/cloudserver/push.go`: drop the `vapidPublicKey` field from `PushAPI` / `NewPushAPI`; `GetVapidPublicKey` reads the account from the router's request context and returns that account's `vapid_public_key` (404 only if the context has no account — base-domain request)
- [x] extend `push_test.go`: two accounts get different keys from `GET /api/push/vapid-public-key` on their respective subdomains

### Task 4: Relay sends with per-account keys + Apple subject switch

- [x] change `PushSender.Send` to accept the account keypair (e.g. `Send(ctx, sub, keys AccountVAPIDKeys, ct)`); update the fake sender in tests
- [x] `WebPushSender` keeps only `Subject` + `BaseDomain`; per send, pick subject: endpoint host contains `push.apple.com` → `https://<BaseDomain>`, else the configured `mailto:` subject (~10-line copy of the `internal/webpush` switch, cloud-local)
- [x] relay loop (`processDue` + stale-sync sweep): fetch the account's keypair (extend `relayStore` with an account-keys lookup or join keys into `DueScheduledPushes`/`List` — pick whichever is the smaller diff); skip + `slog.Warn` if keys are NULL (cannot happen post-backfill, but never send unsigned)
- [x] extend `relay_test.go`: captured sends carry each account's own keypair; Apple-endpoint subscription gets the `https://` subject, FCM-shaped endpoint gets `mailto:`

### Task 5: Wiring + deployment config

- [ ] `cmd/cloud/main.go`: delete `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` env reads; relay is always enabled; `VAPID_SUBJECT` optional with default `mailto:noreply@<CLOUD_BASE_DOMAIN>`
- [ ] `docker-compose.cloud.yml`: add optional `VAPID_SUBJECT=${VAPID_SUBJECT:-}` to the environment block (keys no longer exist as config)
- [ ] create `.env.cloud.example`: `CLOUD_BASE_DOMAIN`, `SESSION_SECRET`, commented-out optional `VAPID_SUBJECT`, `CLOUD_CLAIM_TTL`, `CLOUD_ACCOUNT_QUOTA_BYTES`, `CLOUD_DRY_QUEUE_WARN_HOURS`, `CLOUD_DB_PATH`, `PORT` — with one-line comments each

### Task 6: Verify acceptance criteria

- [ ] verify all requirements from Overview are implemented (per-account keys end-to-end: provision → public-key endpoint → relay send; subject switch; zero required VAPID env)
- [ ] verify edge cases: base-domain request to the key endpoint, NULL-key account skipped by relay, backfill idempotent on restart
- [ ] run `go test ./...` — must pass
- [ ] run the project linter — all issues fixed

### Task 7: [Final] Update documentation

- [ ] `docs/cloud-deployment.md`: remove the `genvapid` / VAPID-keys operator step; document push as zero-config with optional `VAPID_SUBJECT`
- [ ] `docs/environment.md`: cloud-mode section — remove `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, add `VAPID_SUBJECT` default (bot-mode rows untouched)
- [ ] `docs/cloud-mode.md`: short note under the push-relay section — per-account VAPID keys, why (push-service-enforced misrouting rejection), subject policy (operator identity, never user data), rotation unsupported by design
- [ ] `docs/plans/2026-07-05-cloud-c2b-medications-tz-reminders.md`: add a one-line prerequisite note pointing at this plan before Task 5

## Technical Details

- **Key format**: `webpush-go`'s base64url strings, stored as TEXT — same
  representation the browser's `applicationServerKey` and the sender expect;
  no re-encoding anywhere.
- **Why generation at Provision, not claim**: the account row is born at
  invite creation; keys-at-birth means one code path and the claim ceremony
  stays untouched. Backfill covers pre-existing rows once.
- **Why no key rotation**: push services bind subscriptions to the
  subscribe-time key; rotating orphans every subscription for that account.
  `SetAccountVAPIDKeys` refusing overwrites encodes this.
- **Subject semantics** (RFC 8292): contact for the *application-server
  operator*. Never derived from account or user data — zero-knowledge
  posture. Default `mailto:noreply@<CLOUD_BASE_DOMAIN>` works for FCM/
  Mozilla; Apple endpoints get `https://<CLOUD_BASE_DOMAIN>`.
- **Private keys in the cloud DB**: same trust level as the session secret;
  they sign pushes, they cannot decrypt anything (RFC 8291 keys live in the
  browser, NK payload keys in the vault).
- **Bot mode unchanged**: `internal/webpush`, `cmd/genvapid`, and bot env
  docs stay as-is; this plan is cloud-only.

## Post-Completion

**Manual verification**:
- Deploy to the cloud stack, provision a fresh invite, claim on a real
  iPhone (PWA installed to home screen, iOS 16.4+) and an Android browser;
  enable notifications on both; verify `GET /api/push/vapid-public-key`
  returns the account key and a test scheduled push arrives on both
  platforms with the app closed.
- Confirm startup log shows the backfill count for pre-existing accounts on
  first deploy, and zero on the next restart.

**External system updates**:
- Portainer stack: no new required env vars; optionally set `VAPID_SUBJECT`.
  If the operator previously set `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` per
  the old docs, remove them — they are now ignored.
- C2b execution: its Task 5 (reminders) assumes this plan is deployed.
