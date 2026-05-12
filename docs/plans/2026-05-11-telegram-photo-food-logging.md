---
name: telegram-photo-food-logging
description: Add photo-based food logging to the Telegram bot, mirroring the web flow (OpenAI vision parsing, EXIF time prompt when photo is old, 5-second undo).
---

# Telegram Photo Food Logging

## Overview

The web UI already supports food logging from a photo: upload → OpenAI vision parses → items are saved → user can undo within ~5 seconds. The Telegram bot has no photo handler at all. This plan adds the same end-to-end capability to Telegram:

1. Any photo the user sends is treated as a food photo (per user direction).
2. The photo is downloaded, parsed via the existing `FoodAIService.ParseMealPhoto` domain method, and each detected item is saved as a `food_log` row.
3. If the photo's EXIF `DateTimeOriginal` exists and is more than 1 hour older than now, the bot asks "Use the photo's time (HH:MM) or use now?" before saving. Otherwise it saves immediately at `now()` (matching the web behavior).
4. After saving, the bot replies with a summary and an inline "Undo" button. The button stays active for 5 seconds; on click it deletes all newly created `food_log` rows for that batch. After 5 seconds the button is removed by editing the message.

Benefits: parity between web and Telegram surfaces, makes the bot useful on-the-go without typing `/food <description>`, reuses the existing AI + storage layers.

## Context (from discovery)

Files/components involved (with file paths):

- **Web reference flow** (do not modify, mirror semantics):
  - `web/static/js/features/food.js` — JS EXIF parser (`readFoodPhotoExifDateFromBuffer`, `resolveFoodPhotoEatenAt`), client-side undo via `DELETE /api/food/log/{id}`
  - `internal/server/food_handlers.go:155` — `handleCreateFoodLogFromPhoto` server route
- **Domain service (reused as-is)**:
  - `internal/domain/food_ai.go` — `FoodAIService.ParseMealPhoto(ctx, imageBytes, mimeType) ([]FoodLog, error)`
- **Bot wiring (already in place)**:
  - `internal/bot/bot.go:34` — `Bot.api *tgbotapi.BotAPI`
  - `internal/bot/bot.go:44,76,104,198` — `foodAI` injected; nil-guard already exists
  - `internal/bot/bot.go:248` — `handleMessage` dispatch (add `msg.Photo` branch before the `IsCommand()` check)
  - `internal/bot/bot.go:243` — `handleCallback` callback dispatch
- **Reference: Telegram file download** (two modes: local Bot API vs remote HTTPS):
  - `internal/bot/sleep_import.go:18-90` — pattern to follow for `b.api.GetFile(...)` + `file.Link(...)` or local copy
- **Reference: bot callback flow**:
  - `internal/bot/food_commands.go` — `b.foodAI.ParseMealDescription`, `b.food.CreateFoodLog`, `renderFoodSummary`
  - `internal/bot/bp_callbacks.go` — `tgbotapi.NewEditMessageReplyMarkup` + delete-message pattern; callback ack via `b.api.Request(tgbotapi.NewCallback(...))`
- **Storage / domain method for undo**:
  - `internal/domain/food.go` (`food.DeleteFoodLog(ctx, id, userID)`) — already exposed; used by the web `DELETE /api/food/log/{id}` handler at `internal/server/food_handlers.go:325`
- **MCP coverage**: no new HTTP routes are added by this plan, so `internal/server/mcp_coverage_exempt.go` is untouched.

Related patterns:

- Bot stores per-feature state in maps protected by a mutex (e.g., `workoutMessages map[int64]map[int]struct{}`); follow this for `pendingPhoto` and `undoBatch` caches.
- `time.AfterFunc` is used elsewhere for deferred message work; reuse for the 5-second undo-window expiry.
- Tests in `internal/bot/food_commands_test.go` exercise renderer + service-call paths via in-package fakes; pure helpers (EXIF parser, cache TTL, summary renderer) get directly-tested unit coverage. The handler itself gets thinner test coverage focused on routing decisions.

Dependencies identified: **no new Go dependencies**. The web's inline JPEG/EXIF parser maps cleanly to ~100 lines of Go using `encoding/binary` and `bytes` — much simpler than pulling in `github.com/rwcarlsen/goexif` for one tag.

## Development Approach

- **Testing approach**: Regular (code first, then tests in the same task) — matches existing bot package convention.
- Complete each task fully before moving to the next.
- Make small, focused changes.
- **Every task MUST include new/updated tests** for code changes in that task:
  - unit tests for new functions/methods
  - unit tests for modified functions/methods
  - tests cover both success and error scenarios
- **All tests must pass before starting the next task** — no exceptions.
- **Update this plan file if scope changes during implementation.**
- Run `go test ./internal/bot/...` after each change; final full-suite via `go test ./...`.
- Maintain backward compatibility (existing `/food` text command must keep working unchanged).

## Testing Strategy

- **Unit tests** (Go): required for every task. Place new tests alongside the file they exercise (e.g., `photo_food_test.go` next to `photo_food.go`).
- **Frontend tests**: not applicable — this plan is bot-only.
- **No new e2e tests**: there is no Telegram e2e harness in the repo; bot tests are unit/integration at the Go level only. Manual smoke test against a real bot is listed in Post-Completion.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with `➕` prefix.
- Document issues/blockers with `⚠️` prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): tasks achievable in this codebase — Go code, tests, doc updates.
- **Post-Completion** (no checkboxes): manual smoke against a real Telegram bot.

## Implementation Steps

### Task 1: EXIF DateTimeOriginal parser (pure helper)

- [x] create `internal/bot/photo_exif.go` with `parseExifDateTimeOriginal(b []byte) (time.Time, bool)`
- [x] port the algorithm from `web/static/js/features/food.js:851-988` (find APP1 segment, read TIFF header for endianness, walk IFD0 → ExifIFD pointer 0x8769 → tag 0x9003 `DateTimeOriginal` ASCII `YYYY:MM:DD HH:MM:SS`, optional tag 0x9011 `OffsetTimeOriginal` for tz)
- [x] guard malformed/short inputs: any unexpected length, bad magic, missing tag → return `time.Time{}, false` (never panic)
- [x] write unit tests in `internal/bot/photo_exif_test.go`:
  - [x] success: handcrafted minimal JPEG-EXIF blob with known DateTimeOriginal + OffsetTimeOriginal
  - [x] success: DateTimeOriginal without OffsetTimeOriginal (assume UTC)
  - [x] no-EXIF JPEG: returns `false`
  - [x] non-JPEG bytes (e.g. PNG header): returns `false`
  - [x] truncated buffer: returns `false`
- [x] run `go test ./internal/bot/...` — must pass before Task 2

### Task 2: Telegram photo download helper

- [x] add `downloadTelegramPhoto(ctx context.Context, fileID string) (imageBytes []byte, mimeType string, err error)` to `internal/bot/photo_food.go`
- [x] reuse local-vs-remote dispatch from `sleep_import.go:54-90` (local `/`-prefixed path → `os.Open` + `io.ReadAll`; remote → `b.httpClient.Get(file.Link(b.api.Token))`)
- [x] enforce a max size of 8 MB (match `maxFoodPhotoBytes` in `internal/server/food_handlers.go:153`); abort with explicit error past the cap
- [x] detect MIME via `http.DetectContentType(imageBytes)`; reject non-`image/*`
- [x] write tests in `internal/bot/photo_food_test.go`:
  - [x] downloader is decomposed into a small interface (`telegramFileFetcher`) so tests can inject a fake that returns canned bytes + `FilePath` — covers local mode + remote mode + oversize + non-image
- [x] run tests — must pass before Task 3

### Task 3: Pending-photo cache (for the EXIF-old time picker)

- [x] add `internal/bot/photo_pending.go` with `pendingPhotoStore` — `map[string]pendingPhotoEntry` + `sync.Mutex` + TTL sweep
- [x] entry holds: `chatID int64`, `imageBytes []byte`, `mimeType string`, `exifTime time.Time`, `expiresAt time.Time`
- [x] methods: `put(entry) (token string)` (random 16-byte hex token), `take(token) (entry, ok)` (one-shot consume), `gcExpired(now)`
- [x] entries TTL = 10 minutes; if user never answers, photo is dropped
- [x] write tests in `internal/bot/photo_pending_test.go`:
  - [x] put → take returns entry; second take returns `ok=false`
  - [x] expired entry is not returned and is removed by `gcExpired`
  - [x] concurrent put/take race-safe (run with `-race`)
- [x] run tests — must pass before Task 4

### Task 4: Undo-batch cache (for the 5-second undo window)

- [x] add `internal/bot/photo_undo.go` with `undoBatchStore` — `map[string]undoBatchEntry` + `sync.Mutex`
- [x] entry holds: `chatID int64`, `messageID int`, `foodLogIDs []int64`, `expiresAt time.Time`
- [x] methods: `put(entry) (token string)`, `take(token) (entry, ok)`, `peek(token) (entry, ok)` (non-consuming, used by the expiry goroutine to read messageID after the window)
- [x] entries TTL = 10s (5s active window + buffer); never longer than 1 minute
- [x] write tests in `internal/bot/photo_undo_test.go`:
  - [x] put → peek does not consume; take consumes
  - [x] expired entry returns `ok=false` and is removed
  - [x] concurrent access race-safe (`-race`)
- [x] run tests — must pass before Task 5

### Task 5: Save-and-respond helper (parse → save → reply with Undo)

- [x] add `respondWithFoodPhotoSummary(ctx, chatID, eatenAt, imageBytes, mimeType)` in `internal/bot/photo_food.go`
- [x] flow:
  1. send a "⏳ Analyzing photo…" status message (capture `MessageID` for later deletion, mirroring `food_commands.go:104-118`)
  2. call `b.foodAI.ParseMealPhoto(ctx, imageBytes, mimeType)` with a 60s timeout
  3. handle "no items detected" and provider-no-vision errors with explicit user-facing messages
  4. iterate parsed items → `b.food.CreateFoodLog(ctx, &store.FoodLog{UserID: b.allowedUserID, EatenAt: eatenAt, …})`, collect `[]int64` of saved IDs and `[]domain.FoodLog` of saved items
  5. render summary text via `renderFoodSummary(saved, failed)` (reuse the existing renderer in `food_commands.go:178`)
  6. attach an inline `[Undo]` keyboard with callback data `food_photo_undo:<token>`; persist `{chatID, messageID, ids}` to `undoBatchStore`
  7. schedule `time.AfterFunc(5*time.Second, ...)` to **edit-reply-markup** the message and strip the Undo button (preserving text)
- [x] write tests:
  - [x] in-package fake `FoodAIService` returns canned `[]domain.FoodLog`; fake store records create calls
  - [x] success path: 1 item → summary text contains item; undo batch is stored under returned token; expiry timer fires and the edit-markup call is observed (use a clock injection or test the scheduling function directly without sleeping)
  - [x] AI returns 0 items → user gets explicit "no food detected" message; no batch stored
  - [x] partial save failure: 2 parsed, 1 save fails → summary shows `failed=1`; only the successful ID is in the undo batch
- [x] run tests — must pass before Task 6

### Task 6: Top-level photo handler + dispatch from `handleMessage`

- [x] add `handlePhotoMessage(msg *tgbotapi.Message)` in `internal/bot/photo_food.go`
- [x] in `internal/bot/bot.go:248` (`handleMessage`), after the `msg.Document` branch and before the `msg.Location` branch, add:
  - `if len(msg.Photo) > 0 { b.handlePhotoMessage(msg); return }`
- [x] handler flow:
  1. feature-flag gate: `b.food.GetFoodIntakeEnabled(ctx)` → if disabled, reply with the existing "⚠️ Food intake tracking is disabled in settings." message and return
  2. nil-guard `b.foodAI` → reply with the existing "AI food logging is not configured" message
  3. choose the largest `PhotoSize` (last element of `msg.Photo`), call `downloadTelegramPhoto`
  4. attempt `parseExifDateTimeOriginal(imageBytes)`
  5. branch:
     - if EXIF parsed and `now - exifTime > 1 hour`: store `{imageBytes, mimeType, exifTime}` in `pendingPhotoStore`, reply with text "📸 Use the photo's time (HH:MM on YYYY-MM-DD) or use now?" and inline keyboard with two buttons: `food_photo_time:exif:<token>` and `food_photo_time:now:<token>` (return; saving happens in the callback handler)
     - else: call `respondWithFoodPhotoSummary(ctx, chatID, time.Now(), imageBytes, mimeType)` directly
- [x] write tests via the same fakes used in Task 5:
  - [x] no-EXIF photo bytes → `respondWithFoodPhotoSummary` is called with `eatenAt ≈ time.Now()`
  - [x] EXIF time within 1h of now → same: direct save path
  - [x] EXIF time >1h old → no save happens; pending store has the entry; reply contains both inline buttons with the same token
  - [x] food intake disabled → returns disabled message; no download attempt
  - [x] `foodAI == nil` → returns config-error message; no download attempt
- [x] run tests — must pass before Task 7

### Task 7: Callback handlers (time picker + undo)

- [ ] in `internal/bot/bot.go`'s `handleCallback`, route data prefixes `food_photo_time:` and `food_photo_undo:` to new handlers in `internal/bot/photo_food.go`
- [ ] `handleFoodPhotoTimeCallback(cb *tgbotapi.CallbackQuery)`:
  - parse callback data `food_photo_time:<exif|now>:<token>`
  - take the entry from `pendingPhotoStore`; if missing/expired, ack the callback and reply "⚠️ This photo prompt expired. Please send the photo again."
  - resolve `eatenAt`: `entry.exifTime` if `exif`, else `time.Now()`
  - edit the prompt message: remove the keyboard and update text to "✅ Using <chosen time>"; ack callback
  - call `respondWithFoodPhotoSummary(ctx, chatID, eatenAt, entry.imageBytes, entry.mimeType)` as a fresh follow-up message
- [ ] `handleFoodPhotoUndoCallback(cb *tgbotapi.CallbackQuery)`:
  - parse `food_photo_undo:<token>`, `take()` from `undoBatchStore`
  - if missing/expired: ack callback with "Undo window expired"
  - for each `foodLogID`: `b.food.DeleteFoodLog(ctx, id, b.allowedUserID)`; collect successes vs. failures
  - edit the original summary message: remove keyboard, append a line "↩️ Undone (N items removed)"; ack callback
- [ ] write tests using the existing fakes:
  - [ ] time picker `exif` branch: pendingPhoto consumed, summary helper called with EXIF time
  - [ ] time picker `now` branch: summary helper called with `~time.Now()`
  - [ ] time picker token unknown/expired: returns expiration message, no save
  - [ ] undo within window: all logs are deleted via the store fake; message edited to "Undone"
  - [ ] undo after expiry (token already gone): user sees "expired" message; no deletes attempted
  - [ ] undo with partial delete failure: edited message reflects partial outcome
- [ ] run tests — must pass before Task 8

### Task 8: Acceptance criteria verification

- [ ] verify the requested behavior:
  - [ ] photo sent → items parsed and saved with `eatenAt = now()` (default branch)
  - [ ] photo with EXIF >1h old → user is asked which time to use before saving
  - [ ] summary message displays parsed items + totals (same renderer as `/food`)
  - [ ] inline `[Undo]` button deletes all newly created rows within 5s
  - [ ] after 5s, the `[Undo]` button is removed from the message
  - [ ] feature respects `GetFoodIntakeEnabled`
  - [ ] feature respects `foodAI == nil` (clean error message, no panic)
- [ ] verify edge cases:
  - [ ] zero items parsed → no rows written, user told nothing was detected
  - [ ] image >8 MB → user told the photo is too large, no AI call
  - [ ] pending-photo token expired before user answers → friendly expiry message
  - [ ] undo token expired (clicked >10s late) → friendly expiry message
  - [ ] AI provider not vision-capable → user told to set vision env vars (reuse the existing message from `food_ai.go:72`)
- [ ] run full test suite: `go test ./...`
- [ ] run linter: `golangci-lint run` — all issues fixed before completion
- [ ] verify no new `window.*` globals (frontend untouched) and no new HTTP routes (so MCP coverage is unaffected)

### Task 9: Documentation

- [ ] update `docs/features.md` — add a "Telegram photo food logging" subsection under the food feature describing the flow and the 5s undo window
- [ ] update `CLAUDE.md` "Common Tasks" only if a new pattern emerges that future work should follow (e.g., the `pendingPhotoStore` / `undoBatchStore` pattern for deferred callback flows). Otherwise leave CLAUDE.md alone.
- [ ] do **not** add a README — this is feature work, not a new subsystem.

## Technical Details

### Data flow

```
Telegram photo
  → handleMessage (msg.Photo != nil)
    → handlePhotoMessage
      → feature flags + foodAI nil-guard
      → downloadTelegramPhoto (largest PhotoSize)
      → parseExifDateTimeOriginal
        ├── EXIF >1h old → pendingPhotoStore.put → "use photo time / use now?" keyboard
        │     └── time-picker callback → respondWithFoodPhotoSummary
        └── else → respondWithFoodPhotoSummary (eatenAt = now())
            → foodAI.ParseMealPhoto
            → food.CreateFoodLog per item
            → reply with renderFoodSummary + [Undo] button
            → undoBatchStore.put + time.AfterFunc(5s) to strip the button
              └── undo callback → food.DeleteFoodLog per id → edit "Undone"
```

### New files

- `internal/bot/photo_food.go` — handler, time-picker callback, undo callback, summary helper
- `internal/bot/photo_exif.go` — `parseExifDateTimeOriginal`
- `internal/bot/photo_pending.go` — `pendingPhotoStore`
- `internal/bot/photo_undo.go` — `undoBatchStore`
- `internal/bot/photo_food_test.go`, `photo_exif_test.go`, `photo_pending_test.go`, `photo_undo_test.go`

### Modified files

- `internal/bot/bot.go` — add `msg.Photo` branch in `handleMessage`; add callback prefixes in `handleCallback`; add `pendingPhotos` and `undoBatches` fields to `Bot` and initialize them in `New(...)`
- `docs/features.md` — feature documentation

### Callback data formats

- `food_photo_time:exif:<token>` — use the photo's EXIF time
- `food_photo_time:now:<token>` — use `time.Now()`
- `food_photo_undo:<token>` — undo the last batch

Tokens are crypto-random 16-byte hex strings. Telegram callback data is capped at 64 bytes — our longest payload is `food_photo_undo:` (16) + 32 hex chars = 48 bytes, well within the limit.

### Concurrency

- Both caches (`pendingPhotoStore`, `undoBatchStore`) are `sync.Mutex`-protected maps. They're attached to the `Bot` struct and shared across all incoming updates.
- The 5-second undo timer is a `time.AfterFunc`; the closure captures `chatID`, `messageID`, and `token` and edits the message via `b.api.Request(...)`. The undo handler `take()`s the token, so a race between the timer and a click is resolved by whichever consumes the token first.

## Post-Completion

*Items requiring manual intervention — no checkboxes, informational only.*

**Manual smoke test** (recommended before merging):

- Send a photo of a meal to the bot from a phone — confirm summary appears and "Undo" works within 5s.
- Confirm "Undo" disappears after 5s.
- Send a photo from the gallery that has DateTimeOriginal >1h ago (some clients preserve EXIF when sent as photo; if yours strips it, send as `Document` is *not* in scope — this branch will rarely trigger, that's expected).
- Toggle "Food intake" off in settings; send a photo — confirm the disabled message.

**Deployment**: no new env vars, no new migrations. The feature is automatically active wherever `foodAI` (with a vision-capable model) is already configured. If only a text-only AI provider is configured, the user will get the existing provider-no-vision error message.
