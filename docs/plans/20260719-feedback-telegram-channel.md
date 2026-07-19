# Cloud feedback channel — Telegram manager-bot channel (bd med-dni.5)

## Overview

Final slice of the cloud feedback channel (epic med-dni). Lets a user send feedback
through the **Telegram manager bot** (the master bot that provisions per-account child
bots) as an alternative to the in-app UI. Per the user's decision: an inline **"📮 Send
feedback to developer"** button on the manager bot's reply → tap → "send your message,
voice, or screenshot now" → the user's next message is **server-side age-encrypted to
`FEEDBACK_AGE_RECIPIENT`** and stored via `AppendFeedback` into the same blind
`feedback_queue`. Nothing plaintext at rest (decided: TG plaintext *in transit* is the
user's own choice, but the queue row is always ciphertext).

**Attribution (the real constraint):** `feedback_queue.account_id` is NOT NULL FK to
`accounts(id)`, and there is **no tg-user→account FK** in the schema — only the
overloaded `created_by_account_id = "tg:<uid>"` provenance string, and only *claimed*
accounts are real. So: the feedback button is offered **only to senders who have a
claimed account** (their feedback attributes to it); an unlinked sender doesn't see the
button (and if a stale tap arrives, gets "finish setting up your account first"). This
respects the FK with no schema change. Truly-anonymous TG feedback (a reserved system
account) is a possible later extension, noted below — out of scope here.

**Server-side age encrypt.** This is the first place the cloud **server** encrypts to the
recipient (the client path in med-dni.3 did it in the browser). `filippo.io/age v1.3.1`
is already in go.mod (from med-dni.4) and `cfg.feedbackAgeRecipient` is already threaded
into cloudserver — we thread it one more hop into `TelegramAPI`. The server only has the
recipient **public** key; it encrypts blindly and cannot decrypt (same posture as the
blind queue).

## Context (from discovery)

- **ManagerWebhook** (`internal/cloudserver/telegram.go:451`) parses one `tgclient.Update`;
  tries `ManagedBotCreatedInfo()` then `handleManagerMessage(ctx, upd.Message)`
  (`:474-475`). **No `upd.CallbackQuery` branch today** (that's ChildWebhook only,
  `:787`) — add one.
- **handleManagerMessage** (`:641`): guards non-private/bot/nil-From (`:642`); classifies
  `msg.Text` → affirmatives→`mintInvite`, greetings(`/start`,`hi`,`hello`,`help`)→offer,
  else silent (`:668-673`). Reply via `t.reply(ctx, chatID, text)` (`:727`).
- **Inline keyboard** (`internal/tgclient/tgclient.go`): `SendMessageWithButtons(ctx,
  chatID, text, []InlineKeyboardButton)` (`:405`); `InlineKeyboardButton{Text,
  CallbackData}` (`:397`); example `SendReminder` (`telegram.go:1663-1666`).
- **Callback handling to mirror** (child side): `cq := upd.CallbackQuery`
  (`telegram.go:787`), `CallbackQuery{ID, Data, From, Message}` (`tgclient.go:492`, Message
  may be nil); `AnswerCallbackQuery(ctx, cq.ID, text)` (`tgclient.go:419`) — call on every
  tap; `EditMessageText` (`tgclient.go:358`) optional. Use our own callback_data constant
  (e.g. `"fb"`).
- **No conversation state anywhere** in cloudserver (`TelegramAPI` `telegram.go:173` holds
  no maps). Add minimal state: an in-memory `map[int64]time.Time` (chatID→expiry) guarded
  by a mutex on `TelegramAPI`, ~5min TTL. <!-- ponytail: in-memory capture flag, lost on
  restart / not shared across replicas; a one-column table if cloud ever runs multi-replica -->
- **Account lookup gap**: no direct resolver. Add a store method returning the claimed
  account id for a creator, mirroring `HasClaimedAccountCreatedBy` (`repo.go:182`) but
  `SELECT id ... WHERE created_by_account_id=? AND claim_token_hash IS NULL`. Creator
  string is built as `"tg:"+strconv.FormatInt(msg.From.ID,10)` (`telegram.go:651`).
- **AppendFeedback** (`internal/cloudstore/feedback.go:46`):
  `AppendFeedback(ctx, accountID, clientID, kind, appVersion string, ciphertext []byte, now)`
  — idempotent, per-account cap.
- **Download TG media** — mirror `GetPhoto` (`telegram.go:1300`): `client.GetFile(ctx,
  fileID)` (`tgclient.go:157`) → size-gate → `client.DownloadFile(ctx, file.FilePath)`
  (`tgclient.go:168`) → `io.ReadAll`. Use **`t.managerClient()`** (`telegram.go:236`), not
  a child token — the media was sent to the manager bot.
- **`Message` lacks `Voice` and `Caption`** (`tgclient.go:545`) — must add `Voice *Voice`
  + `Caption string` fields (+ a `Voice` type: `FileID, MimeType, Duration, FileSize`).
  `Photo []PhotoSize` + `LargestPhoto()` (`:577`) already exist; `Document` (`:558`) too.
- **age encrypt (Go)**: `recip, _ := age.ParseX25519Recipient("age1...")`; `w, _ :=
  age.Encrypt(&buf, recip)`; `w.Write(json)`; **`w.Close()`** (flushes footer);
  `buf.Bytes()`. Decrypt counterpart to interop with: `cmd/feedbackpull/main.go:49`.
- **Plaintext doc shape (contract, from med-dni.3/.4)**: `{ "v":1, "created_at":"<iso>",
  "text":"...", "attachments":[ { "type":"image"|"audio", "mime":"...", "data_b64":"..." } ] }`
  (`cmd/feedbackpull/main.go:30-42,96`).
- **Tests** (`internal/cloudserver/telegram_test.go`): `managerFixture(t)` (`:612`) →
  `(repo, recordingTG, handler, secret)`; `tgMessage(t,h,secret,text)` (`:623`) posts a
  manager update; assert on `tg.mu.sent` (`:655`); copy `TestManagerOnboarding` (`:651`).
  Callback-tap JSON style: `tgclient_test.go:440-450` (POST to `/tg/manager/<secret>`).

## Development Approach

- **Testing approach**: Regular. Each task ends with passing Go tests.
- `go test ./internal/tgclient/... ./internal/cloudstore/... ./internal/cloudserver/...`
  then `go build ./...` + `go build -tags mobile ./...`. (cloudserver is server-only; the
  age import lands in the cloud server binary now — intended, it's the encrypt path.)
- Feature is fully gated on `feedbackAgeRecipient != ""` (unset → no button, disabled),
  matching med-dni.1's server 503 / no-meta disabled state.

## Progress Tracking
- Mark `[x]` immediately. `➕` new, `⚠️` blocker.

## Implementation Steps

### Task 1: tgclient — decode Voice + Caption
- [x] `internal/tgclient/tgclient.go`: add `Caption string \`json:"caption"\`` and
      `Voice *Voice \`json:"voice"\`` to `Message` (`:545`); add
      `type Voice struct { FileID string \`json:"file_id"\`; MimeType string
      \`json:"mime_type"\`; Duration int \`json:"duration"\`; FileSize int64
      \`json:"file_size"\` }`.
- [x] Test (`internal/tgclient/tgclient_test.go`): unmarshalling an update JSON with a
      `voice` object and a photo `caption` populates the new fields; absence leaves them
      zero/nil.
- [x] Run `go test ./internal/tgclient/...` — must pass before Task 2.

### Task 2: store — claimed-account lookup for a TG creator
- [x] `internal/cloudstore` (near `HasClaimedAccountCreatedBy`, `repo.go:182`): add
      `ClaimedAccountIDForCreator(ctx, creator string) (string, error)` →
      `SELECT id FROM accounts WHERE created_by_account_id=? AND claim_token_hash IS NULL
      ORDER BY ... LIMIT 1`; return `("", nil)` (or a sentinel) when none — caller treats
      empty as "unlinked".
- [x] Test (`internal/cloudstore/..._test.go`): a claimed account created by `"tg:42"`
      resolves to its id; an unclaimed (pending `claim_token_hash`) one does not; unknown
      creator → empty; picks a claimed one when both exist.
- [x] Run `go test ./internal/cloudstore/...` — must pass before Task 3.

### Task 3: server-side age encrypt helper + thread recipient into TelegramAPI
- [x] Add `encryptFeedbackDoc(recipient string, doc []byte) ([]byte, error)` (in
      `telegram.go` or a small `feedback_telegram.go`): `age.ParseX25519Recipient` →
      `age.Encrypt(&buf, recip)` → write → **Close** → bytes. Error if recipient empty.
- [x] Thread `feedbackAgeRecipient` into `TelegramAPI`: add a field + set it in
      `NewTelegramAPI` (`telegram.go:209`) (or a setter mirroring
      `router.SetFeedbackRecipient`); pass `cfg.feedbackAgeRecipient` at the
      `NewTelegramAPI(...)` call site in `cmd/cloud/main.go`.
- [x] Add the in-memory capture-state map + mutex to `TelegramAPI` (`telegram.go:173`):
      `feedbackWaiting map[int64]time.Time` + `feedbackMu sync.Mutex`; helpers
      `setFeedbackWaiting(chatID)`, `takeFeedbackWaiting(chatID) bool` (returns true +
      clears iff present and unexpired).
- [x] Test: `encryptFeedbackDoc` output decrypts with a matching age identity (round-trip
      via `age.Decrypt`) back to the input JSON; empty recipient errors. Capture-state
      helpers: set→take returns true once then false; expired entry returns false.
- [x] Run `go test ./internal/cloudserver/...` — must pass before Task 4.

### Task 4: manager webhook — feedback button, callback branch, capture + encrypt + store
- [ ] `ManagerWebhook` (`telegram.go:451`): add an `upd.CallbackQuery != nil` branch →
      `handleManagerCallback(ctx, cq)`. On our `"fb"` callback: `AnswerCallbackQuery(...)`,
      `setFeedbackWaiting(chatID)`, and reply/prompt "Send your message, voice, or
      screenshot now (or /cancel)". Ignore unknown callback data.
- [ ] Offer the button: when `feedbackAgeRecipient != ""` **and**
      `ClaimedAccountIDForCreator(creator) != ""`, attach a `"📮 Send feedback to
      developer"` (`callback_data:"fb"`) button to the manager bot's greeting/help reply
      (use `SendMessageWithButtons`). Keep existing affirmative/greeting/silent logic;
      just add the button to the reply path for linked senders. (med-eas.62 will later
      enrich this reply's text — this task only adds the button + capture.)
- [ ] Capture path in `handleManagerMessage` (before the greeting switch): if
      `takeFeedbackWaiting(chatID)` is true → this message is feedback:
      1. Resolve `accountID = ClaimedAccountIDForCreator(creator)`; if empty, reply
         "Finish setting up your account first, then you can send feedback." and stop.
      2. `/cancel` (or empty) → reply "Cancelled." and stop.
      3. Build the plaintext doc: `text = msg.Text` or `msg.Caption`; if `msg.Voice` →
         download via managerClient (GetFile/DownloadFile, size-gate) →
         attachment `{type:"audio", mime: voice.MimeType|"audio/ogg", data_b64}`; if
         `msg.Photo` → `LargestPhoto()` download → `{type:"image", mime:"image/jpeg",
         data_b64}`. (At most one media per TG message; text/caption always allowed.)
      4. `ciphertext, _ := encryptFeedbackDoc(t.feedbackRecipient, json)`;
         `AppendFeedback(ctx, accountID, uuid, "telegram", "", ciphertext, now)`.
      5. Reply "✅ Thanks — sent to the developer." On `ErrFeedbackQueueFull` → a friendly
         "you've sent a lot recently, try later" message.
- [ ] Tests (copy `TestManagerOnboarding` + child-callback JSON): (a) a greeting from a
      **linked** sender → reply carries the `"fb"` button; from an **unlinked** sender →
      no button. (b) POST an `"fb"` callback → `setFeedbackWaiting` + prompt sent. (c) next
      text message from that chat → `AppendFeedback` called once with a non-empty
      ciphertext scoped to the sender's account + a "thanks" reply; the stored blob
      decrypts (with a test identity) to a v1 doc containing the text. (d) a photo/voice
      message → the attachment bytes ride in the decrypted doc (mock the file
      download). (e) capture with no claimed account → rejection reply, no AppendFeedback.
      (f) feature disabled (`feedbackRecipient==""`) → no button ever.
- [ ] Run `go test ./internal/cloudserver/...` — must pass before Task 5.

### Task 5: wire, verify, docs
- [ ] Confirm `cmd/cloud/main.go` passes `cfg.feedbackAgeRecipient` into
      `NewTelegramAPI(...)`.
- [ ] `go build ./...` + `go build -tags mobile ./...`; `go vet` + `gofmt` on changed
      files.
- [ ] `go test ./internal/tgclient/... ./internal/cloudstore/... ./internal/cloudserver/...`
      all green.
- [ ] Docs: note the Telegram feedback channel in `docs/cloud-mode.md` (and the
      `feedback_queue` blurb from med-dni.1/.4), including the claimed-account attribution
      limitation and the disabled-when-`FEEDBACK_AGE_RECIPIENT`-unset behavior.

### Task 6: Verify acceptance criteria
- [ ] A linked user messaging the manager bot sees a "Send feedback" button; tapping it
      then sending text/voice/photo stores one age-encrypted row in `feedback_queue`
      attributed to their account; the dev CLI (med-dni.4) decrypts it.
- [ ] The queue row is ciphertext (server encrypts to the recipient pubkey; cannot
      decrypt); no plaintext at rest.
- [ ] Unlinked senders can't queue (no button; stale tap → guided to finish setup).
- [ ] Feature is absent when `FEEDBACK_AGE_RECIPIENT` is unset. Server + mobile builds
      pass; the three packages' tests pass.

## Technical Details

- **Same queue, same format**: TG feedback uses the identical v1 plaintext doc and the
  same `AppendFeedback`/`feedback_queue`, so med-dni.4's CLI drains web and TG feedback
  uniformly (`kind:"telegram"` distinguishes the source).
- **Server encrypts, still blind**: the manager bot holds only the recipient public key
  (`FEEDBACK_AGE_RECIPIENT`); it encrypts and stores, never decrypts. The plaintext exists
  only transiently in the handler (unavoidable for a server-received TG message — the
  user accepted this trade-off) and is never persisted.
- **Attribution limit**: only claimed-account senders (the manager bot's real audience)
  can send. Truly-anonymous TG feedback would need a reserved system `accounts` row seeded
  by a new migration to satisfy the FK — deliberately deferred (YAGNI unless asked).
- **Capture state is in-memory + TTL**: fine for the tap→next-message flow on a
  single-replica deploy; a restart just drops a pending prompt (the user re-taps). Noted
  ponytail ceiling.

## Post-Completion

**Manual verification** (cloud deploy, `FEEDBACK_AGE_RECIPIENT` set, a claimed account
created via the manager bot): DM the manager bot, tap "Send feedback", send a voice memo +
a screenshot with a caption, confirm the "thanks" reply, then
`go run ./cmd/feedbackpull -db <cloud.db> -identity dev.key -out ./inbox -delete` and
confirm the text + voice + image land decrypted.

**Epic med-dni complete** after this: server queue (.1) + capture UI (.2) + encrypt &
reliable submit (.3) + dev decrypt CLI (.4) + Telegram channel (.5).
