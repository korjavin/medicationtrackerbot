# med-eas.79 — Delete the previous cloud-TG reminder when re-firing a repeat

## Overview
In cloud-mode Telegram, a REPEATED reminder (the med hourly re-reminder chain, and
snooze re-fires for meds/bp/weight/workout) currently sends a brand-new message every
time, so identical nags stack up in the chat. Make each re-fire DELETE the previous
instance in its own chain, so the chat shows exactly ONE live reminder per slot/session
(freshest, at the bottom) until it is confirmed/skipped or the chain is capped.

Server-side, relay-refire path ONLY. Do NOT touch confirm/skip in-place edits
(med-eas.74.1 already edits those messages).

**Zero-knowledge invariant (do NOT weaken):** the relay never reads `ct`/vault. A
Telegram `message_id` and `chat_id` are TG artifacts the relay already holds; the new
`supersedes_message_id` column stores a TG message id, never vault data. Existing
relay/push "stays blind / forwards ct verbatim" tests MUST stay green.

## Context (from discovery)
Files/components involved:
- `internal/tgclient/tgclient.go` — has `SendMessage`, `SendMessageReturningID`,
  `SendMessageWithButtons` (no id), `EditMessageText*`. NO `DeleteMessage`, no
  buttons-returning-id variant.
- `internal/cloudserver/telegram.go` — `SendReminder(ctx, accountID, text, callbackStem) error`
  (returns only error; two send paths: plain `client.SendMessage` and buttoned
  `client.SendMessageWithButtons`). Callback tap handler `handleCallbackQuery` captures
  `messageID := cq.Message.MessageID` and calls `RescheduleRelayRefire` at THREE sites:
  ~line 1737 (med `s:` snooze), ~line 1873 (workout `w:` snooze), ~line 1956 (measure
  `bp:`/`wt:` snooze). `SendReminder` def ~line 2015.
- `internal/cloudserver/relay.go` — `TelegramSender` interface (`SendReminder` only,
  ~line 69), `relayStore` interface (`RescheduleRelayRefire`, ~line 122), `sendTelegram`
  (~line 248: calls `SendReminder`, then `scheduleMedRefire`), `scheduleMedRefire`
  (~line 267: MED `s:` only; calls `store.RescheduleRelayRefire`).
- `internal/cloudstore/push.go` — `ScheduledPush` struct (~line 134),
  `DueScheduledPushes` SELECT/scan (~line 191), `RescheduleRelayRefire` (~line 245),
  `InsertRelayRefire` (~line 233), `ReplaceSchedule` (~line 159), `MarkPushSent`.
- `internal/cloudstore/migrations/` — last is `019_push_origin.sql`. Add `020`.
- Tests: `internal/cloudserver/relay_test.go` (`fakeTGSender` at ~line 288; fake store),
  `internal/cloudserver/telegram_test.go` (`TestSendReminder_*`),
  `internal/cloudstore/repo_test.go` (`TestRescheduleRelayRefire` ~line 766).

Related patterns found:
- `SendMessageReturningID` already exists → mirror it for the buttons path, and let the
  void-returning `SendMessageWithButtons` delegate (discarding id), exactly as
  `SendMessage` delegates to `SendMessageReturningID`.
- `origin` column (migration 019) is the precedent for the additive column + DEFAULT so
  `ReplaceSchedule`/`InsertRelayRefire` need no INSERT change.

Dependencies identified: goose migrations auto-embed via glob (no manual registration).

## Development Approach
- **Testing approach**: Regular (code first, then tests, within each task).
- The relay is account-scoped and never holds a `chat_id`. So the delete is exposed as
  an **account-scoped** `DeleteReminder(ctx, accountID, messageID)` on the
  `TelegramSender` interface (mirrors `SendReminder`, resolves the chat by account
  internally) — the relay only ever passes `p.AccountID` + `p.SupersedesMessageID`,
  both already in its possession. Keeps the zero-knowledge boundary intact.
- Complete each task fully (build + relevant tests green) before the next.
- Smallest coherent diff; reuse existing patterns; never add a new HTTP route (internal
  relay logic only). No frontend change expected (server-only).
- Best-effort delete: an un-deletable prior message (user already deleted it, or >48h
  old — Telegram limit) MUST NOT abort the new send or the re-fire chain.

## Testing Strategy
- **Unit/integration tests** (Go) required per task.
- No frontend touched → no vitest expected. If any `*.test.js` references a send
  signature, keep it green (unlikely — server-only change).
- Key new tests (Task 6): re-fire deletes the prior message_id; a best-effort delete
  failure does not abort send/chain; supersedes threads through the chain (send N
  deletes send N-1); cloudstore round-trips `supersedes_message_id`.

## Progress Tracking
- Mark completed items `[x]` immediately.
- Add newly discovered tasks with ➕ prefix; blockers with ⚠️ prefix.

## Implementation Steps

### Task 1: tgclient — DeleteMessage + buttons-returning-id send
- [x] add `func (c *Client) DeleteMessage(ctx context.Context, chatID, messageID int64) error` in `internal/tgclient/tgclient.go`, calling the Telegram `deleteMessage` method with `chat_id` + `message_id` (returns the raw error; best-effort swallowing is the caller's job in Task 2's `DeleteReminder`).
- [x] add `func (c *Client) SendMessageWithButtonsReturningID(ctx context.Context, chatID int64, text string, buttons []InlineKeyboardButton) (int64, error)` mirroring `SendMessageWithButtons`: when `len(buttons)==0` delegate to `SendMessageReturningID`; otherwise call `sendMessage` with the inline keyboard and return `sent.MessageID`.
- [x] refactor existing `SendMessageWithButtons` to delegate to the new ReturningID variant, discarding the id (mirror how `SendMessage` wraps `SendMessageReturningID`) — keep its exact current external behavior.
- [x] write test: `DeleteMessage` posts `deleteMessage` with the right `chat_id`/`message_id` payload shape (extend the existing httptest-server pattern in `tgclient_test.go`).
- [x] write test: `SendMessageWithButtonsReturningID` returns the server's `message_id`, and the no-buttons branch still sends a plain message. Keep existing `TestSendMessageWithButtons*` green.
- [x] run `go test ./internal/tgclient/...` — must pass before Task 2.

### Task 2: telegram.go — SendReminder returns message_id + DeleteReminder
- [x] change `SendReminder` signature to `(ctx context.Context, accountID, text, callbackStem string) (int64, error)`; every early error/`ErrNoLinkedChat` return becomes `return 0, err`.
- [x] plain path: `return client.SendMessageReturningID(ctx, *bot.ChatID, text)`; buttoned path: `return client.SendMessageWithButtonsReturningID(ctx, *bot.ChatID, text, buttons)`.
- [x] add `func (t *TelegramAPI) DeleteReminder(ctx context.Context, accountID string, messageID int64) error`: no-op when `messageID <= 0`; resolve the bot chat by account exactly like `SendReminder` (`BotByAccount` → `botClient`), then call `client.DeleteMessage` **best-effort** — on ANY error `slog.Warn` and return `nil` (a not-found / >48h-old / revoked-token delete must never propagate). No-op / warn on `ErrNoLinkedChat` or nil `ChatID`.
- [x] update `TestSendReminder_*` in `telegram_test.go` for the new two-value return (discard the id where the test only asserts buttons/text).
- [x] write test: `DeleteReminder` swallows a Telegram error (fake bot API returns 400) and returns nil; and is a no-op for `messageID <= 0`.
- [x] run `go test ./internal/cloudserver/... -run 'SendReminder|DeleteReminder'` — must pass before Task 3.

### Task 3: migration 020 + cloudstore supersedes plumbing
- [x] add `internal/cloudstore/migrations/020_push_supersedes.sql`: Up `ALTER TABLE scheduled_pushes ADD COLUMN supersedes_message_id INTEGER NOT NULL DEFAULT 0;`, Down `ALTER TABLE scheduled_pushes DROP COLUMN supersedes_message_id;` (goose Up/Down StatementBegin/End blocks, with a comment noting it holds the TG message_id the send should delete — a TG artifact, not vault data). NEVER edit an existing migration.
- [x] add `SupersedesMessageID int64` to the `ScheduledPush` struct in `push.go`.
- [x] `DueScheduledPushes`: add `supersedes_message_id` to the SELECT column list and `rows.Scan` into `p.SupersedesMessageID` (append to the existing scan args).
- [x] `RescheduleRelayRefire`: add a `supersedesMessageID int64` param; include `supersedes_message_id` in the INSERT column list + value. The DELETE-then-INSERT transaction and zero-knowledge (empty `ct`) stay unchanged. Leave `ReplaceSchedule` and `InsertRelayRefire` INSERTs untouched (DEFAULT 0 covers their rows).
- [x] write test: extend `TestRescheduleRelayRefire` (or a sibling) to pass a non-zero `supersedesMessageID` and assert `DueScheduledPushes` surfaces it on the new row; assert a client `ReplaceSchedule` row reports `SupersedesMessageID == 0`.
- [x] run `go test ./internal/cloudstore/...` — must pass before Task 4.

### Task 4: relay.go — capture id, delete prior, chain supersedes
- [x] update `TelegramSender` interface: `SendReminder(...) (int64, error)` and add `DeleteReminder(ctx context.Context, accountID string, messageID int64) error`.
- [x] update `relayStore` interface: `RescheduleRelayRefire(ctx, accountID, fireAt, tgText, tgCallback string, supersedesMessageID int64) error`.
- [x] `sendTelegram`: `newID, err := rl.tg.SendReminder(...)`; on error log + return (unchanged swallow semantics). After a successful send, if `p.SupersedesMessageID != 0` call `rl.tg.DeleteReminder(ctx, p.AccountID, p.SupersedesMessageID)` and only log its error (never abort). Then `rl.scheduleMedRefire(ctx, p, newID)`.
- [x] `scheduleMedRefire`: add `supersedesMessageID int64` param and pass it through to `store.RescheduleRelayRefire(...)`. (Chain semantics: the next re-fire's supersedes = this send's `newID`, so re-fire N deletes send N-1; the first re-fire supersedes the original reminder.)
- [x] write/extend tests for the interface-signature change (fakes updated in Task 6). Compile-check with `go build ./...`. (Fakes/tests deferred to Task 6 per plan; the three telegram.go RescheduleRelayRefire call sites temporarily pass `0`, replaced with the tapped messageID in Task 5.)
- [x] run `go build ./...` — must pass before Task 5.

### Task 5: snooze re-fire — thread the tapped message_id
- [x] in `handleCallbackQuery` (telegram.go), pass the already-captured `messageID` (the tapped `cq.Message.MessageID`) as `supersedesMessageID` to all THREE `RescheduleRelayRefire` calls: med `s:` (~1737), workout `w:` (~1873), measure `bp:`/`wt:` (~1956). So when the snooze re-fire fires, it deletes the prior (snoozed-receipt) message — one live message per chain.
- [x] write/extend a test asserting the snooze tap schedules a relay-refire whose `SupersedesMessageID` equals the tapped message id (at least the med path; workout/measure share the seam).
- [x] run `go test ./internal/cloudserver/...` — must pass before Task 6.

### Task 6: fakes + behavior tests + zero-knowledge guard
- [x] update `fakeTGSender` in `relay_test.go`: `SendReminder` returns `(int64, error)` with an incrementing/settable id; add `DeleteReminder` recording deleted message ids and an optional `deleteErr` to force a failure. Update the fake `relayStore.RescheduleRelayRefire` signature (capture `supersedesMessageID`). (fakeTGSender already updated; relay tests use the real store, not a fake relayStore.)
- [x] test: a re-fire DELETES the prior send's message id — drive two relay ticks over a med `s:` chain (`fakeTGSender` returns id N, N+1…); assert `DeleteReminder` was called with the prior send's id (send N deletes send N-1; first re-fire supersedes the original). (`TestRelay_RefireDeletesPriorMessage`)
- [x] test: best-effort delete failure (`fakeTGSender.deleteErr` set) does NOT abort the send or the chain — the next re-fire is still scheduled and the next send still happens. (`TestRelay_RefireDeleteFailureDoesNotAbortChain`)
- [x] test: cloudstore/relay round-trip — `supersedes_message_id` threads from `scheduleMedRefire`/snooze into the re-fire row and back out via `DueScheduledPushes`. (relay side asserted in `TestRelay_RefireDeletesPriorMessage`; store side in `TestRescheduleRelayRefire`; snooze side in `telegram_test.go`.)
- [x] confirm the existing zero-knowledge relay/push tests (relay never decrypts, forwards `ct` verbatim, refire copies only cleartext fields) remain UNCHANGED and green. (unchanged; full package green.)
- [x] run `go test ./internal/cloudserver/... ./internal/cloudstore/... ./internal/tgclient/...` — must pass before Task 7.

### Task 7: Verify acceptance criteria
- [ ] `go build ./...` AND `go build -tags mobile ./...` both green.
- [ ] `go test ./internal/cloudserver/... ./internal/cloudstore/... ./internal/tgclient/...` green.
- [ ] grep the diff for the zero-knowledge invariant: relay reads no `ct`/vault; `DeleteReminder` uses only `accountID` + `messageID`; `supersedes_message_id` carries only a TG id. No new `window.*` global; no new HTTP route.
- [ ] confirm migration numbering is contiguous (020 follows 019) and no existing migration was edited.
- [ ] re-read the bead ACCEPTANCE list and confirm each bullet is satisfied (med hourly chain leaves one live message; snooze re-fire deletes the prior snoozed message; meds `s:` + workout `w:` + bp/wt covered; delete best-effort; ZK green).

## Technical Details
- New column: `scheduled_pushes.supersedes_message_id INTEGER NOT NULL DEFAULT 0` — the
  prior Telegram `message_id` this send should delete (0 = nothing to delete).
- `TelegramSender.SendReminder` now returns `(int64, error)` = the sent message id.
- `TelegramSender.DeleteReminder(accountID, messageID)` — account-scoped, best-effort,
  resolves chat internally so the relay never touches `chat_id`.
- Chain: original reminder (client row, supersedes=0) → send captures id₀ →
  `scheduleMedRefire(p, id₀)` writes re-fire row with supersedes=id₀ → that re-fire
  send deletes id₀, captures id₁, schedules supersedes=id₁ → … capped at
  `maxMedRefireWindow`.
- Snooze: the tap edits the message to a "Snoozed" receipt (unchanged, med-eas.74.1) and
  schedules a re-fire with supersedes = the tapped message id, so the re-fire deletes
  that snoozed-receipt message.

## Post-Completion
*Items requiring manual intervention or external systems — no checkboxes, informational only*

**Manual verification** (staging cloud deployment with a linked bot):
- Leave a med unconfirmed → confirm each hourly re-reminder deletes the previous one
  (at most one live med reminder per slot until confirmed / 6h cap).
- Tap Snooze on a med/workout/bp/weight reminder → confirm the re-fire deletes the prior
  snoozed message when it arrives.
- Delete a reminder manually, or let one age past 48h, then trigger a re-fire → confirm
  the failed delete does NOT block the new reminder (best-effort).

**Deferred / honest flags:**
- Telegram's 48h bot-delete limit means a very old prior message can't be deleted; this
  is accepted (best-effort) — the new reminder still sends.
- The snooze-receipt message is deleted by the *next* re-fire, not at snooze time (by
  design: one live message per chain, freshest at the bottom).
