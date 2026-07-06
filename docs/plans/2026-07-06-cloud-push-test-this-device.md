# Cloud push "Test" fires only on the clicking device (this-device-only)

## Overview

The cloud Settings "Send test push" currently schedules an encrypted push via
`PUT /api/push/schedule`, which the blind relay fans out to **every** subscribed
device of the account — so a test triggered from one device notifies the others
(e.g. Android gets a test clicked on desktop). It also has to do an awkward
"append test entry to the recomputed real schedule" dance to avoid clobbering
the replace-all schedule, and it isn't immediate (waits for the relay's 30s
ticker).

Replace it with a **dedicated immediate single-device test endpoint**: the test
push is sent right away to **only** the current device's subscription. Closes bd
**med-eas.20**.

## Context (from discovery)

- **Relay fan-out** (the current behavior): `internal/cloudserver/relay.go`
  `Tick` reads due `scheduled_pushes` and sends each to **all** enabled subs via
  `WebPushSender.Send(ctx, sub, keys, ct)` (`relay.go:68`). No per-entry
  targeting exists.
- **Single-subscription send already exists**: `WebPushSender.Send(ctx, sub,
  keys, ct)` sends one encrypted `ct` to one subscription. It disables the sub
  on HTTP 404/410 (`relay.go` → `cloudstore/push.go` `Disable`). Reuse this.
- **Subscription storage**: `internal/cloudstore/push.go` — `List(ctx,
  accountID)` returns enabled subs; `UpsertPushSubscription`, `Disable`. No
  `GetByEndpoint` yet (add one, or filter `List`).
- **Account VAPID keys**: however `relay.go` / the existing push handlers load
  the account's `AccountVAPIDKeys` — reuse the same accessor so the new handler
  signs with the account's own keypair (the relay is blind; `ct` is
  client-encrypted).
- **Existing push routes**: `internal/cloudserver/push.go` registers `GET
  /api/push/vapid-public-key`, `POST`/`DELETE /api/push/subscriptions`, `PUT
  /api/push/schedule`, all account-scoped by subdomain + `RequireSession`.
- **Client**: `web/cloud/js/push.js` `getSubscription()` (exported, returns the
  current `PushSubscription`), `web/cloud/js/sync.js` `getOrCreateNK(ctx)`,
  `web/cloud/js/crypto.js` `encryptPushPayload(nk, plaintext)` (AES-GCM, AAD
  `mt/v1/push`) + `toBase64`. The current test path is
  `web/cloud/js/reminders.js` `sendTestPush(ctx)` → `pushSchedule` → `PUT
  /api/push/schedule` (this is what we replace).
- **Settings call site**: `web/static/js/features/settings.js` Test button →
  `sendTestPush(ctx)`. Keep the call site; change the implementation + the
  status message.
- **`cmd/cloud` has no MCP coverage guard** (that guard is `internal/server`
  only), so no coverage-exempt entry is needed for the new cloud route.

## Development Approach

- No unit tests. Add integration tests only where they guard a real boundary
  (the new endpoint's targeting + the client wiring).
- Keep the relay **blind**: the request carries the endpoint (routing metadata
  the server already stores in plaintext) + the client-encrypted `ct`. The
  server never sees plaintext.
- Reuse `WebPushSender.Send` and the account-VAPID-keys accessor — no new send
  or crypto machinery.
- Do not change real reminder delivery (still all-devices via the schedule).
  This only changes the **test** affordance.

## Testing Strategy

- Go integration test in `internal/cloudserver` for the new endpoint: with two
  subscriptions on an account, `POST /api/push/test {endpoint, ct}` sends to
  ONLY the named endpoint; unknown/foreign endpoint → 404/forbidden; the `ct` is
  forwarded verbatim (blind).
- Frontend integration test: `sendTestPush` posts to `/api/push/test` with the
  current device's endpoint + encrypted `ct`, and no longer `PUT`s the schedule.
  Update the existing `settings.cloud-notifications.test.js` "non-clobber
  guarantee" case (it asserts the old schedule behavior).

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix

## Implementation Steps

### Task 1: Server — immediate single-device test-send endpoint

- [x] Add a subscription lookup by endpoint in `internal/cloudstore/push.go`
      (e.g. `GetByEndpoint(ctx, accountID, endpoint)` returning the enabled sub
      or nil), or filter `List` in the handler — whichever is cleaner.
- [x] Add `POST /api/push/test` in `internal/cloudserver/push.go` (session-authed,
      account-scoped by subdomain): request `{ "endpoint": string, "ct": []byte }`
      (`ct` base64, same shape/size caps as a schedule entry, 1–4096 bytes).
      Resolve the subscription for (account, endpoint); if none/disabled → 404.
      Load the account VAPID keys and call `WebPushSender.Send(ctx, sub, keys,
      ct)` immediately. On 404/410 disable the sub (mirror the relay) and return
      an error the client can show ("this device's subscription expired —
      re-enable"). Success → 204.
- [x] Register the route in the push routes block. Validate `endpoint`
      belongs to the resolved account (never send to another account's sub).

### Task 2: Client — direct single-device test send

- [x] Add a `sendTestPush(ctx)` implementation (replace the schedule-based one in
      `web/cloud/js/reminders.js`, or add a `sendTestPush` in `push.js` and
      re-point reminders' export): get the current subscription via
      `getSubscription()`; if none, throw a clear "enable push first" error;
      get `nk` via `getOrCreateNK(ctx)`; `encryptPushPayload(nk, JSON.stringify({
      title: 'Med Tracker', body: 'Test notification' }))`; `POST
      /api/push/test { endpoint: sub.endpoint, ct: toBase64(ct) }`.
- [x] Remove the now-unused schedule-append/non-clobber logic from the test
      path (the real reminder recompute path keeps `computeReminderEntries` +
      `pushSchedule` unchanged).

### Task 3: Settings wiring + copy

- [ ] `web/static/js/features/settings.js` Test button: keep calling
      `sendTestPush(ctx)`; update the success status to "Test sent to this
      device." (immediate, not "scheduled — arrive shortly").

### Task 4: Tests

- [ ] Go: `internal/cloudserver` test — two subs on one account; `POST
      /api/push/test` to endpoint A sends only to A (assert via a stub/fake
      `WebPushSender` capturing the endpoint it sent to); unknown endpoint → 404;
      `ct` forwarded verbatim.
- [ ] Frontend: update `settings.cloud-notifications.test.js` — `sendTestPush`
      posts `/api/push/test` with the current endpoint + a `ct`, and does NOT
      `PUT /api/push/schedule`. Replace the old "non-clobber guarantee" case
      (that behavior no longer applies to the test path).

### Task 5: Verify

- [ ] `go build ./... && go build -tags mobile ./...` green.
- [ ] `go test ./internal/cloudserver/... -race` green.
- [ ] `pnpm test` green.
- [ ] Reason through: the test reaches only the clicking device; real reminders
      still fan out to all devices; the server stays blind (only endpoint +
      ciphertext cross the wire).

### Task 6: [Final] Update documentation

- [ ] `docs/cloud-mode.md` push section: note the test push is an immediate,
      this-device-only send (`POST /api/push/test`), distinct from scheduled
      reminders which deliver to all devices; add it to the leakage table if
      relevant (endpoint + ciphertext size/timing → cloud; content → nobody).

## Technical Details

- Request: `POST /api/push/test` `{ endpoint, ct }` where `ct =
  base64(encryptPushPayload(nk, {title, body}))` — identical crypto to a
  scheduled entry, so the SW's existing `push` handler + `readNK` decrypt path
  renders it unchanged.
- The endpoint is routing metadata the server already stores plaintext for every
  subscription; sending it here leaks nothing new. Content stays E2E-encrypted.

## Post-Completion

**Manual verification** (real devices):
- Subscribe on two devices (e.g. Android + desktop). Click "Test" on device A →
  only A gets the notification; B does not. Then confirm a real scheduled
  reminder still reaches both.
