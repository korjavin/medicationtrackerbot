# Server-authoritative cloud med-reminder lifecycle (med-eas.74)

## Overview

Make the cloud MED-reminder Confirm/Snooze/re-reminder lifecycle **server-authoritative** over Telegram, so it behaves correctly and autonomously whether or not the PWA is open — reusing the med-eas.70 blind relay-refire primitives, which stay **zero-knowledge** (they copy cleartext push fields; they never read `ct` or vault data). One coherent PR covering bd children .1/.2/.3 (they all edit `telegram.go` + `relay.go` + `reminders.js` and cannot be parallelized).

Three problems fixed:
1. **No repeat**: an unconfirmed dose is not re-reminded in Telegram in practice, because re-reminders are client-pre-computed at horizon build and the user rarely opens the app. Fix: the **relay** owns re-reminders — when it SENDS a med reminder it schedules a server-owned +1h re-fire, hourly, capped ~6h past the slot; a Confirm tap cancels them; a Snooze reschedules. Then remove the client-side re-reminder loop so the two don't double-nag.
2. **Snooze not server-side**: a Snooze tap only seals an inbox event + toast; nothing re-fires until the app opens. Fix: on a med Snooze tap the relay re-fires at now+1h server-side.
3. **Confusing temp hint**: on Confirm/Snooze only a callback toast is shown; the message keeps its live buttons until the client drains and edits it, so the user re-taps confused. Fix: on tap the relay IMMEDIATELY rewrites the message text with server-composed **static** text and drops the buttons. The client's drain-time EditReply still finalizes the real receipt.

## Context (from discovery)

- **`internal/cloudserver/telegram.go`**
  - `handleCallbackQuery` (~1592): the med "s:" path parses `ParseCallbackData` (~1634), seals via `SealAndQueue` (~1658), then answers a toast (Confirm/Snooze/Dropped). `messageID` is 0 when Telegram omits `cq.Message` (old message).
  - `handleWorkoutCallback` (~1688) is the **reference pattern to mirror**: after SealAndQueue it computes `stem := strings.TrimSuffix(cq.Data, ":"+action)`, then on snooze calls `t.store.RescheduleRelayRefire(ctx, ref, now.Add(delay), refireText, stem)` (~1748) and on skip `t.store.CancelRelayRefire(ctx, ref, stem)` (~1753). `refireText = cq.Message.Text` if present else `workoutRefireText` const (~1678).
  - `EditReply` (~1268) + `client.EditMessageText(ctx, *bot.ChatID, messageID, text)` (~1301) is the edit path. `botClient(bot)` opens the client; `BotByAccount`/webhook `ref` IS the account id.
  - `RegisterAPIRoutes` (~311): session-authed routes register plainly, e.g. `mux.Handle("POST /api/telegram/reply-edit", RequireSession(t.store, t.sessionSecret, http.HandlerFunc(t.EditReply)))` (~321). No MCP registry involved.
- **`internal/tgclient/tgclient.go`**: `EditMessageText(ctx, chatID, messageID, text)` (~358) sends `editMessageText` **without** `reply_markup`, so it does NOT drop inline buttons. `SendMessageWithButtons` (~405) shows the `reply_markup:{inline_keyboard:[[...]]}` shape. `IsMessageNotModified` (used by EditReply). Med callback grammar: `CallbackSlotPrefix = "s:"` (~439), `ParseCallbackData` splits `"s:<slotUnix>:<action>"` and REQUIRES an action (~553) — so it cannot parse a bare `"s:<slotUnix>"` stem.
- **`internal/cloudserver/relay.go`**: `Relay` struct has `store relayStore` (~123) and `tg TelegramSender` (~125). `sendTelegram(ctx, p)` (~240) forwards `p.TGText`/`p.TGCallback`. `Deliver` loop already reads `DueScheduledPushes` + `MarkPushSent`.
- **`internal/cloudstore/push.go`**: primitives already exist — `RescheduleRelayRefire(ctx, accountID, fireAt, tgText, tgCallback)` (~245, cancel+insert one `origin='relay_refire'` row keyed by callback), `CancelRelayRefire(ctx, accountID, tgCallback)` (~262). `ReplaceSchedule` deletes only `origin='client'` (~165), so relay_refire rows survive a client re-upload. `PushOriginRelayRefire = "relay_refire"`. Migration 019 already added the `origin` column — **do not add a migration**.
- **`web/domain/reminders.js`**: PURE (architecture.domain-purity — no window/fetch). Lines ~333-339 push the PRIMARY per-slot med reminder with `callback: 's:'+slotUnix` (KEEP). Lines ~341-363 is the client re-reminder loop over PENDING intakes pushing `MAX_REREMINDS_PER_INTAKE` hourly re-reminders (REMOVE). Constants: `REREMIND_INTERVAL_MS`, `REREMIND_GRACE_MS`, `MAX_REREMINDS_PER_INTAKE`, `GENERIC_REREMIND_TEXT`.
- **`web/cloud/js/inbox-apply.js`**: `applyIntakeSlotAction` (~202) drains a TG tap → confirms/snoozes intakes via the domain; `editTelegramReply` (~363) POSTs `/api/telegram/reply-edit`. The impure browser layer (allowed to `fetch`).
- **`web/cloud/js/apishim.js`**: `createApiRouter` routes `/api/...` to the domain in cloud mode — the app intake confirm/snooze path lives here.
- Coverage guard: cloudserver has no MCP-coverage requirement (that's `internal/server`, the bot). `internal/cloudserver/router_test.go` is the only route test — check it for a route-enumeration assertion and satisfy it exactly as `reply-edit` is (likely no change needed).

## Development Approach
- **Testing approach**: Regular (code first, then tests), integration-first per repo policy.
- Complete each task fully (code + tests green) before the next.
- Reuse the workout callback path + med-eas.70 primitives. Smallest coherent diff.
- Zero-knowledge is a hard invariant: relay never reads `ct`; message edits use only server-composed static text (never vault med names); callback_data stays the `"s:<slot>"` stem (≤64B). Existing relay_test.go/push_test.go "forwards ct verbatim / stays blind" assertions MUST stay green.

## Testing Strategy
- **Go unit tests**: extend `internal/cloudserver/*_test.go` (telegram/relay) and rely on existing `internal/cloudstore` primitive tests. Assert: med Confirm edits message + cancels refire; med Snooze reschedules +1h + edits message; `messageID==0` skips edit but still seals/toasts; relay re-fire chains until the ~6h cap then stops; cancel endpoint validates the `"s:"` prefix.
- **Frontend (Vitest, Node 20)**: update `reminders.domain` suite to assert NO client-emitted re-reminders (only the primary slot fire remains); update cloud `inbox-apply`/`apishim` suites for the app-confirm cancel call; keep architecture (domain-purity, cloud-tokens, globals) green.

## Progress Tracking
- Mark completed items `[x]` immediately.
- ➕ newly discovered tasks, ⚠️ blockers.

## Implementation Steps

### Task 1: Immediate server-side message rewrite on med Confirm/Snooze tap (.1)
- [x] In `internal/tgclient/tgclient.go`, add a method that edits text AND clears the inline keyboard in one `editMessageText` call — e.g. `EditMessageTextClearMarkup(ctx, chatID, messageID, text)` sending `reply_markup:{"inline_keyboard":[]}` (mirror the request shape in `SendMessageWithButtons` ~405; return/`IsMessageNotModified` handling like `EditMessageText` ~358). Do NOT change the existing `EditMessageText` (EditReply depends on its current behavior).
- [x] In `internal/cloudserver/telegram.go` `handleCallbackQuery`, in the med path after `SealAndQueue` succeeds, open the bot client (reuse the `answer` helper's `t.botClient(bot)` pattern — `bot` is already in scope) and call the new clear-markup edit with server-composed STATIC text: Confirm → `"✅ Confirmed — waiting for your device to come online to record it."`, Snooze → `"⏰ Snoozed 1h — I'll remind you again."`. Best-effort via `editMedCallbackMessage` helper: a failed edit only logs (like EditReply), never changes the 200 response.
- [x] `messageID == 0` → skip the edit (keep toast-only fallback). Keep the existing `AnswerCallbackQuery` toast as secondary ack and keep `SealAndQueue` (client drain still finalizes the real "✅ Confirmed N medications" receipt).
- [x] ZERO-KNOWLEDGE: edit text is static/templated only — never a medication name or vault value. Added `medConfirmEditText`/`medSnoozeEditText` const strings near `workoutRefireText`.
- [x] Add/extend `internal/cloudserver` tests: Confirm tap edits message with the confirmed text + empty markup; Snooze tap edits with the snoozed text; `messageID==0` performs no edit but still seals + toasts. Add a tgclient test for the new clear-markup method (asserts `inline_keyboard:[]` in the request body).
- [x] Run `go test ./internal/cloudserver/... ./internal/tgclient/...` — must pass before Task 2.

### Task 2: Server-side snooze re-fire for med reminders (.2)
- [x] In the med **Snooze** branch of `handleCallbackQuery`, mirror the workout snooze (~1748): `refireText := medRefireText` (new generic fallback const near `workoutRefireText`), override with `cq.Message.Text` when present; then `t.store.RescheduleRelayRefire(r.Context(), ref, now.Add(time.Hour), refireText, stem)` where `stem == "s:<slotUnix>"`. Log-and-swallow errors (never fail the 200).
- [x] Confirm this survives `ReplaceSchedule` (origin=relay_refire) and is zero-knowledge (copies cleartext push fields only).
- [x] Add a test: med Snooze tap inserts exactly one pending `relay_refire` row for the `"s:<slot>"` stem at ~now+1h; a re-snooze reschedules (cancel+insert, no stacking).
- [x] Run `go test ./internal/cloudserver/...` — must pass before Task 3.

### Task 3: Relay owns re-reminders; cancel on Confirm (TG + app); retire client loop (.3)
- [x] **3a** `internal/cloudserver/relay.go` `sendTelegram`: after a successful med send, `scheduleMedRefire` cuts the `"s:"` prefix (guards a parse error), and if `now.Sub(slot) <= maxMedRefireWindow` (6h const) reschedules the next re-fire at `now+1h` via `rl.store.RescheduleRelayRefire`. Each fired send (primary OR relay_refire) perpetuates the chain until the cap.
- [x] Extended the `relayStore` interface (in relay.go) with `RescheduleRelayRefire`.
- [x] **3b** `telegram.go` med **Confirm** branch: `t.store.CancelRelayRefire(r.Context(), ref, stem)` (mirrors workout Skip) so a TG Confirm stops the nags. Log-and-swallow.
- [x] **3c** New endpoint `POST /api/telegram/cancel-refire` in `RegisterAPIRoutes` (mirrors the reply-edit line). Handler `CancelRefire`: resolves session like `EditReply`, decodes `{callback}` (LimitReader), REJECTS unless `strings.HasPrefix(callback, tgclient.CallbackSlotPrefix)`, calls `t.store.CancelRelayRefire`, returns 204. router_test.go has no route-enumeration guard — no change needed.
- [x] **3d** `web/cloud/js/reminders.js` (IMPURE layer) gained `cancelMedRefire(slotMs)` — a fire-and-forget POST `/api/telegram/cancel-refire {callback:'s:'+slotUnix}` wired into `apishim.js`'s `confirm-schedule` intake route (has `scheduled_at`). No new `window.*` global. (In-app snooze intentionally leaves the chain alive — one extra hourly nag, not worth resolving the snoozed intake's slot; noted with a `ponytail:` comment.)
- [x] **3e** `web/domain/reminders.js`: REMOVED the client re-reminder loop. KEPT the primary slot fire (callback `'s:'+slotUnix`). Removed now-unused constants (`REREMIND_INTERVAL_MS`, `REREMIND_GRACE_MS`, `MAX_REREMINDS_PER_INTAKE`, `GENERIC_REREMIND_TEXT`); `formatHHMM` kept (workout.js still uses it). Module stays pure.
- [x] Tests: relay `TestRelay_MedRefireChain` (schedules next re-fire within cap, stops past 6h); `TestChildWebhook_MedConfirmCancelsRelayRefire`; `TestCancelRefire` (204 valid, 400 non-`"s:"`, 401 unauth). Frontend — `reminders.domain` asserts NO client re-reminders (only primary slot fire); `cloud.shim-contract.meds-history` asserts the app-confirm cancel POST fires (and does NOT for intake_id-only confirm).
- [x] Run `go test ./internal/cloudserver/... ./internal/cloudstore/...` and the affected Vitest suites — all pass.

### Task 4: Verify acceptance criteria + zero-knowledge invariant
- [ ] `go build ./...` AND `go build -tags mobile ./...` both clean.
- [ ] `go test ./internal/cloudserver/... ./internal/cloudstore/... ./internal/tgclient/...` green.
- [ ] Node 20 for Vitest: `export PATH="/tmp/node-v20.18.1-linux-x64/bin:$PATH"` (confirm `node -v` = v20), then `npx vitest run` on reminders.domain + cloud inbox-apply + apishim + push/relay + architecture (domain-purity, cloud-tokens, globals) suites — all green.
- [ ] GREP THE DIFF for zero-knowledge: relay never reads `ct`/vault; message edits use only server-composed static text (no vault med names); existing relay_test.go/push_test.go "forwards ct verbatim / stays blind" assertions unchanged and green; callback_data stays the `"s:<slot>"` stem (≤64B).
- [ ] Confirm no new migration was added; `web/domain/reminders.js` still pure; no new `window.*` global; no bot/mobile parity added.

## Technical Details
- Med callback stem = `"s:<slotUnix>"`; buttons are built by appending `:confirm`/`:snooze`. The relay learns nothing new — the slot instant is already cleartext in `scheduled_pushes`.
- Re-fire cap is derived, not counted: stop scheduling once `now - slotUnix > ~6h`. `RescheduleRelayRefire` is cancel+insert per callback, so the chain never stacks duplicates and a re-snooze/Confirm supersedes cleanly.
- App-confirm cancel closes the one gap the TG-tap path can't: a dose confirmed in the PWA produces no tap, so the client explicitly tells the relay to drop pending `"s:<slot>"` re-fires.

## Post-Completion
**Manual verification** (dogfood, app CLOSED): unconfirmed med reminder re-fires hourly up to ~6h; Snooze tap re-fires ~1h later with the message rewritten + buttons gone; Confirm tap rewrites the message + stops nags; confirming in the app also stops nags; no double-nag from the client.
