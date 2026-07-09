# Managebot onboards users and mints invites (rate limited)

## Overview

Covers bd `med-39q` (feature) and bd `med-bc9` (its rate limit) in one change — the limit is a
count-and-refuse in the same handler, off the same column, so splitting them would mean two full CI cycles
for five lines.

Today the cloud managebot ignores ordinary Telegram messages: `ManagerWebhook` only binds a newly-created
managed child bot, and every other update is logged and dropped (`internal/cloudserver/telegram.go:253-258`).

After this change, a private message to the managebot gets a reply:

1. explains it helps set up a personal health-tracking bot (meds, vitals, food, weight, BP),
2. offers to mint an invite if the user isn't already connected,
3. on agreement, mints one and replies with the claim link,
4. refuses politely past **3 invites per Telegram user per rolling 24h**,
5. tells an already-connected user to unlock with their passkey instead of minting a second account.

Supersedes PR #486, which implemented (1)-(3) but calls `Provision` with the pre-#497 arity (so it no longer
compiles), has no rate limit, no already-connected check, and no tests. Its keyword lists and message copy are
a reasonable starting point and are reused where sound.

## Context (from discovery)

- `internal/cloudserver/telegram.go:43-51` — `TelegramAPI{store *cloudstore.Repo, sessionSecret, baseDomain,
  apiBaseURL string, manager *tgclient.Client, managerSecret, managerUsername string}`. **No `claimTTL`
  field**, so as it stands `ManagerWebhook` cannot call `Provision`.
- `internal/cloudserver/telegram.go:56-65` — `NewTelegramAPI(store, sessionSecret, managerToken, baseDomain,
  apiBaseURL)`. Wired at `cmd/cloud/main.go:222`; `cfg.claimTTL` is in scope there (`main.go:35,50`, env
  `CLOUD_CLAIM_TTL`) and already handed to `NewInviteAPI` (`main.go:190`) — just not to `NewTelegramAPI`.
- `internal/cloudserver/telegram.go:100-103` — `RegisterWebhookRoutes` registers
  `POST /tg/manager/{secret}` on the **top-level** mux (`main.go:246`), not the subdomain `apiMux`.
- `internal/cloudserver/telegram.go:252-258` — `upd.ManagedBotCreatedInfo()`; on `!ok` it logs
  `"update without managed_bot_created"` and returns 200. **This is the branch to repurpose.**
- `internal/tgclient/tgclient.go:250-255` — `func (c *Client) SendMessage(ctx, chatID int64, text string) error`.
  Already callable as `t.manager.SendMessage(...)`; used at `telegram.go:448`. **The reply helper already exists.**
- `internal/tgclient/tgclient.go:262-266,301-307,316-319,115-121` — `Update{UpdateID, ManagedBot, Message}`,
  `Message{MessageID, Text, Chat, From, ManagedBotCreated}`, `Chat{ID, Type}`, `User{ID, IsBot, ...}`.
  Telegram user id is `upd.Message.From.ID`; private chats have `Chat.Type == "private"`.
- `internal/cloudserver/provision.go:67` — `Provision(ctx, store, ttl, now, createdBy string)`.
  `createdBy == ""` stores SQL NULL (`repo.go:26,55-60`) — the admin-CLI path (`cmd/cloud/admin.go:92`).
- `internal/cloudserver/provision.go:49-58` — `Invite{Account, Token}`, `ClaimURL(baseDomain)` →
  `https://<sub>.<base>/#claim=<token>`.
- `internal/cloudserver/invite.go:12,14,29-40,67-110` — the quota pattern to mirror: `mintMu` serializes
  count-then-insert, `SweepExpiredClaims` runs **before** counting, then `CountAccountsCreatedBy` and a
  refusal, then `Provision`.
- `internal/cloudstore/repo.go:144` — `CountAccountsCreatedBy(ctx, accountID string, since time.Time) (int, error)`.
- `internal/cloudstore/migrations/010_invite_provenance.sql:6-7` — `created_by_account_id TEXT`, **no FK**,
  index on `(created_by_account_id, created_at_unix)`.
- `internal/cloudserver/telegram_test.go:184-224` — `newRecordingTG` / `recordingTG.mu.sent` records every
  `sendMessage` payload. `postWebhook` (`:416-424`) posts a raw update with the secret header. This is
  everything the tests need.

**Does not exist and must not be assumed:** any table keyed by Telegram user id (`009_telegram.sql` keys
`tg_bots`/`tg_pending` by account/username); any `update_id` dedupe anywhere.

## Design decisions

- **Key managebot mints as `"tg:<telegram_user_id>"` in `accounts.created_by_account_id`** (owner decision).
  The column is `TEXT` with no foreign key, so this inserts and counts fine. It cannot collide with a real
  account id (prefixed) nor with admin-CLI mints (NULL), so `invite.go`'s 100/30d user quota — which counts
  `CountAccountsCreatedBy(session.AccountID, …)` — is provably unaffected. One column then serves provenance,
  the daily rate limit, and the already-connected check. **No migration, no new table.**
  Leave a `ponytail:` comment naming the ceiling and the upgrade path (promote to a `tg_invite_mints` table
  if a second non-account minter ever needs provenance).
- **Rate limit: 3 per Telegram user per rolling 24h**, mirroring `invite.go` exactly — `mintMu`, then
  `SweepExpiredClaims`, then count, then refuse. Sweeping before counting matters for the same reason it does
  in `invite.go`: a user at the cap never reaches `Provision`, so their own expired unclaimed invites would
  otherwise occupy slots forever. It also means an invite that expired unclaimed frees a slot — deliberate.
- **Already-connected check needs a new repo method, not the counter.** `SweepExpiredClaims` deletes expired
  *unclaimed* accounts, so a plain count cannot distinguish "claimed an account" from "has a pending invite".
  A claimed account has `claim_token_hash IS NULL` and survives the sweep. Add
  `HasClaimedAccountCreatedBy(ctx, createdBy) (bool, error)`.
  On true, reply "you already have an account, unlock it with your passkey" and **never mint**. Without this a
  returning user who says "yes" again silently gets a second, empty account.
- **We cannot re-send a pending invite's link.** The token is hash-only at rest (same as the CLI path), so a
  user with a live unclaimed invite who asks again simply gets a fresh one, bounded by the daily limit. The
  old one expires on its own. Say so in a comment rather than pretending to resend.
- **No `update_id` dedupe.** Telegram retries are at-least-once and nothing tracks seen updates today. The
  already-connected gate plus the 3/day cap bound the blast radius of a replay to at most 3 accounts for a
  never-claiming user. Building an `update_id` table for that is not worth it — note the ceiling in a
  `ponytail:` comment. **Do not add a dedupe table in this change.**
- **Only private chats, only humans.** Ignore `Chat.Type != "private"` and `Message.From.IsBot`, and keep the
  existing 200-OK-and-drop for everything else. A group chat adding the managebot must not trigger onboarding.
- **Always answer 200.** Any reply/mint failure logs via `slog` and still returns 200, matching the handler's
  existing posture — a non-200 makes Telegram retry, which is exactly what we don't want on a mint path.

## Development Approach

- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data migration, cross-component
    flow) and gives a guarantee manual checking can't
  - if no integration test adds a real guarantee, the task has NO test items — that is correct and expected
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: if a task adds an integration test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility

## Testing Strategy

- **Unit tests**: none.
- **Integration tests**: the webhook is a real cross-component boundary (HTTP update in → Telegram reply out +
  DB row minted) and the existing `telegram_test.go` harness (`newRecordingTG`, `postWebhook`) drives it
  end to end. Worth pinning: the reply/mint/refuse/already-connected outcomes.
- **E2E tests**: none.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope
- Keep plan in sync with actual work done

## Implementation Steps

### Task 1: `HasClaimedAccountCreatedBy` store method

- [x] add `func (r *Repo) HasClaimedAccountCreatedBy(ctx context.Context, createdBy string) (bool, error)` to
      `internal/cloudstore/repo.go`, next to `CountAccountsCreatedBy` (`:144`)
- [x] SQL: `SELECT EXISTS(SELECT 1 FROM accounts WHERE created_by_account_id = ? AND claim_token_hash IS NULL)`
      — a NULL claim hash is the claimed state (see `consumeClaimTx`, `repo.go:312-314`)
- [x] guard: an empty `createdBy` must return `false, nil` without querying (admin-CLI mints are NULL and must
      never match)
- [x] the existing index `(created_by_account_id, created_at_unix)` covers the lookup; no new index

### Task 2: Thread `claimTTL` into `TelegramAPI`

- [x] add a `claimTTL time.Duration` field to `TelegramAPI` (`internal/cloudserver/telegram.go:43-51`)
- [x] add a `mintMu sync.Mutex` field with the same rationale comment as `InviteAPI.mintMu`
      (`invite.go:35-39`): it serializes count-then-insert
- [x] extend `NewTelegramAPI` (`telegram.go:56`) with a trailing `claimTTL time.Duration` param
- [x] update the caller `cmd/cloud/main.go:222` to pass `cfg.claimTTL` (already in scope, used at `main.go:190`)
- [x] update any test constructors of `NewTelegramAPI` in `internal/cloudserver/telegram_test.go` to pass
      `14*24*time.Hour`, matching the other test call sites

### Task 3: Managebot replies to ordinary private messages

- [x] in `ManagerWebhook`'s `!ok` branch (`telegram.go:253-258`), before the existing log-and-200, call a new
      `t.handleManagerMessage(r.Context(), upd)` when `upd.Message != nil`
- [x] `handleManagerMessage` returns early (leaving today's log-and-drop) unless
      `upd.Message.Chat.Type == "private"` **and** `upd.Message.From != nil` **and** `!upd.Message.From.IsBot`
- [x] compute `creator := "tg:" + strconv.FormatInt(upd.Message.From.ID, 10)`; add the `ponytail:` comment
      explaining the overloaded column (TEXT, no FK, cannot collide with account ids or NULL admin mints) and
      naming the upgrade path (a `tg_invite_mints` table if a second non-account minter appears)
- [x] if `HasClaimedAccountCreatedBy(creator)` → reply that they already have an account and should unlock it
      with their passkey; **return without minting**
- [x] classify `strings.TrimSpace(strings.ToLower(text))`:
      affirmative (`yes`, `y`, `yeah`, `yep`, `sure`, `ok`, `okay`) → mint path;
      greeting/help (`/start`, `hi`, `hello`, `help`) → explain + offer;
      anything else → a one-line nudge that says how to ask for an invite
- [x] every `SendMessage` error is logged with `slog.Error(..., "error", err)` and swallowed; the handler still
      returns 200 (a non-200 makes Telegram retry the update)
- [x] add a `ponytail:` comment where the mint happens noting there is no `update_id` dedupe, and that the
      already-connected gate + daily cap bound a replay to at most the daily quota

### Task 4: Rate limit — 3 invites per Telegram user per 24h (bd med-bc9)

- [ ] add `const managerInviteDailyQuota = 3` and `const managerInviteQuotaWindow = 24 * time.Hour` next to the
      handler, with the same "hardcoded, env knob only if asked" `ponytail:` note as `invite.go:11-14`
- [ ] the mint path takes `t.mintMu`, then calls `SweepExpiredClaims(ctx, now)` **before** counting — same
      ordering and same reason as `invite.go:82` (a capped user never reaches `Provision`, so their expired
      unclaimed invites would otherwise hold slots forever)
- [ ] `minted := CountAccountsCreatedBy(ctx, creator, now.Add(-managerInviteQuotaWindow))`; if
      `minted >= managerInviteDailyQuota` reply with a polite, plain-language wait message naming the limit
      and that it resets within a day — then return without minting
- [ ] otherwise `Provision(ctx, t.store, t.claimTTL, now, creator)` and reply with `inv.ClaimURL(t.baseDomain)`
      plus one sentence on what to do next
- [ ] on `Provision` error: `slog.Error` and reply with an apologetic try-again-later message; still 200

### Task 5: Integration tests for the manager message path

- [ ] extend `internal/cloudserver/telegram_test.go` (do not add a new file) using the existing
      `newRecordingTG` + `postWebhook` helpers; assert on `recordingTG.mu.sent`
- [ ] case: `/start` in a private chat → a reply is sent mentioning the offer; **no account row is created**
- [ ] case: `"yes"` in a private chat → exactly one account row minted with
      `created_by_account_id == "tg:<uid>"`, and the reply contains the claim URL for that subdomain
- [ ] case: a 4th `"yes"` within the window → no new account row, and the reply is the wait message
      (seed 3 prior mints for that `creator` directly through the store)
- [ ] case: user who already claimed an account (consume the claim so `claim_token_hash IS NULL`) says `"yes"`
      → no new account row, reply tells them to unlock with their passkey
- [ ] case: a non-private chat, and a message from a bot (`From.IsBot`) → no reply sent, no row minted
- [ ] case: a `managed_bot_created` update still binds the child bot exactly as before (guard against the new
      branch swallowing it) — the existing `TestTelegramProvisioningStateMachine` should still pass unchanged

### Task 6: Verify acceptance criteria

- [ ] verify the managebot explains itself, offers onboarding, and mints an invite on agreement (med-39q)
- [ ] verify the 4th invite in 24h is politely refused and nothing is minted (med-bc9)
- [ ] verify an already-connected user is never handed a second account
- [ ] verify `invite.go`'s 100/30d account quota is unaffected by `"tg:"`-prefixed rows (a session account id
      can never equal a `tg:`-prefixed string) — assert it, don't assume it
- [ ] `go build ./...` and `go build -tags mobile ./...` pass
- [ ] `TZ=UTC go test ./...` passes (the repo has a known non-UTC time-storage landmine; run under UTC)
- [ ] `go vet ./...` passes

### Task 7: [Final] Update documentation

- [ ] `docs/cloud-mode.md`: document the managebot onboarding conversation, the `"tg:<uid>"` provenance
      convention, and the 3-per-user-per-day limit
- [ ] note explicitly that `created_by_account_id` is overloaded and why (no FK, TEXT, prefixed), so the next
      reader does not treat every value as an account id
- [ ] note the absence of `update_id` dedupe and what bounds a replay

## Technical Details

**Reply/mint decision flow** (private chat, human sender):

```
already claimed an account (HasClaimedAccountCreatedBy "tg:<uid>")?
  yes -> "you already have an account, unlock with your passkey"   [no mint]
  no  -> text?
           affirmative  -> mintMu | sweep | count(24h) >= 3 ? wait-message
                                                            : Provision("tg:<uid>") -> claim URL
           /start|hi|hello|help -> explain + offer
           otherwise            -> short nudge
```

**Why `"tg:<uid>"` cannot corrupt the existing user quota** (`invite.go:86`):
`CountAccountsCreatedBy(session.AccountID, …)` matches `created_by_account_id` by exact equality.
`session.AccountID` is an opaque account token and never begins with `tg:`, so managebot rows are invisible to
it, and its rows are invisible to the managebot counter. Admin-CLI mints store NULL and match neither.

**Ordering inside the mint path** (mirrors `invite.go:74-100`):
`mintMu.Lock()` → `SweepExpiredClaims(now)` → `CountAccountsCreatedBy(creator, now-24h)` → refuse or
`Provision(creator)`.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only*

**Manual verification:**

- Message the deployed managebot from a fresh Telegram account: `/start` → explanation; `yes` → claim link;
  claim it; `yes` again → "you already have an account".
- From a second fresh account, say `yes` four times → the fourth is politely refused.
- Confirm a group chat containing the managebot never triggers onboarding.

**External system updates:**

- PR #486 is superseded by this change. Leave a comment pointing at the replacement PR; the owner closes it.
- No migration, no config, no deployment change. `CLOUD_CLAIM_TTL` continues to govern the claim window.
