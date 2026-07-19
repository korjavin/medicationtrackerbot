# Fix cloud med-reminder Confirm: record ALL meds + clear the message (med-eas.64)

## Overview

Two bugs in the cloud Telegram medication-reminder Confirm flow (one message groups
N meds due at the same instant, with Confirm/Snooze buttons):

- **Bug 2 (P1, data loss):** tapping Confirm records only *some* of the N meds — the
  rest stay PENDING and their adherence is lost.
- **Bug 1 (cosmetic):** Confirm doesn't edit/clear the message (bot mode removes the
  buttons + shows a confirmation).

Root cause (verified) and fix are precise; see Context. Cloud-first (`internal/cloudserver`
is the cloud relay, not bot-legacy — in scope). Epic med-eas.

**Acceptance:** tapping Confirm on an N-med reminder in cloud (a) confirms **ALL N**
meds shown in that message, and (b) edits the original Telegram message to a
confirmation and removes the Confirm/Snooze buttons. Snooze likewise updates the
message. No PENDING meds silently left behind.

## Context (from discovery)

### Bug 2 — exact-`===` slot match drops drifted meds
`applyIntakeSlotAction` (`web/cloud/js/inbox-apply.js:139-141`) confirms only PENDING
intakes where `Date.parse(i.scheduled_at) === slotMs` (exact equality) for the single
`event.slot_unix`. But the callback slot (from `computeReminderHorizon` at push-time)
and the intake `scheduled_at` (from `materializeDueDoses` at drain-time,
`medintake.js:161`) are **two independent re-derivations** that diverge for a subset
of meds when, between push and drain: a med's schedule time was edited; a tz-plan/DST
step shifts one med's instant; or a dose was clustered by `triggerNext`/`confirmSchedule`
(stored at `clusterEarliestMs`, `medintake.js:415/455`). **Every other slot↔intake
matcher tolerates this with a ±`minDoseInterval` band** — `computeReminderHorizon`'s
`isHandled` (`reminders.js:150`), `materializeDueDoses` dedup (`medintake.js:152`), Go
`HasIntakeNearScheduledTime` (`internal/scheduler/medication.go:264`). This one uses
exact `===`, so any drifted med is silently skipped. **Fix = widen to the band.** (Not
"carry all slots" — there is exactly one slot per message; grouping is by exact
`scheduledAtMs`, `reminders.js:152-166`, and is correct.)

### Bug 1 — message_id available at relay, not plumbed; editReply never called
- The relay HAS the id: `handleCallbackQuery` (`internal/cloudserver/telegram.go:1548`) already reads `cq.Message` (chat check `:1567`); `cq.Message.MessageID` exists. But the sealed `intakeSlotEvent` (`:1522`) omits it (`Kind/SlotUnix/Action/AtUnix` only; marshaled `:1583`).
- `applyIntakeSlotAction` never calls `editReply` and `createInboxApplier` (`inbox-apply.js:558`) doesn't pass it (unlike `applyTGCommand/Photo/Text` at `:534/:541/:547`).
- The edit primitive already drops the keyboard: `editTelegramReply` (`inbox-apply.js:167`) → `POST /api/telegram/reply-edit` → `EditReply` (`telegram.go:1241`) → `EditMessageText(chat, messageID, text)` with **no reply_markup** removes the inline buttons. `EditReply` takes chat from the stored bot row + requires the session's account (safe). `confirmationText({kind:'intake'}, {confirmed:n}, verbosity)` (`inbox-apply.js:202-205`) already yields "✅ Confirmed N medications".

### Bot-mode target semantics (reference)
Bot sends one message for the whole slot, confirms the whole med set (Confirm-ALL =
`ConfirmIntakesBySchedule`, `internal/bot/bot.go:715`), and edits the message to remove
the keyboard via `EditMessageReplyMarkup(chat, cb.Message.MessageID, empty)` (`bot.go:742`).
Bot avoids the drift because it mints the intake rows in the same pass as the reminder
(`medication.go:316`) — cloud re-derives them separately, which is why cloud needs the band.

### Tests
`web/cloud/js/tests/inbox-apply.test.js`: `seed()` (`:49-62`) pre-seeds intakes at the
**exact** `SLOT_ISO` with empty schedules (so `materializeDueDoses` is a no-op) — which
is exactly why the current "confirms every med" test (`:72-95`) passes and masks the
bug. New tests must use a real `schedule` (let materialize create the rows) + a drift case.

## Development Approach

- **Testing approach:** Regular. JS domain fix + a small Go relay field + tests. **Run vitest with Node 20** (`/tmp/node-v20.18.1-linux-x64/bin` on PATH; `node node_modules/vitest/vitest.mjs run <file>`; Node 18 default can't run it — do NOT skip the frontend suite).
- Data-correctness first: the band-match must confirm ALL PENDING intakes near the slot; regression-test the drift case that currently fails.
- Each task ends with passing tests before the next.

## Progress Tracking
- Mark `[x]` immediately. `➕` new, `⚠️` blocker.

## Implementation Steps

### Task 1: Widen the Confirm/Snooze slot-match to the ±minDoseInterval band (bug 2 — data loss)
- [x] In `web/cloud/js/inbox-apply.js` `applyIntakeSlotAction` (`:129-159`): replace the exact `Date.parse(i.scheduled_at) === slotMs` filter with a **band match** — for each PENDING intake, resolve its medication (via `medication_id`), compute `band = minDoseIntervalMs(med.schedule, med.tz_shift_policy)` (import `minDoseIntervalMs` from `web/domain/medschedule.js`, the same helper `reminders.js:17` uses), and include the intake when `Math.abs(Date.parse(i.scheduled_at) - slotMs) <= band`. Confirm (or snooze) every matched PENDING intake. Keep materialize-first, the backdating (`atMs`), and the already-applied guard.
- [x] Load the meds once (`records.list`/the medications domain) to map `medication_id → {schedule, tz_shift_policy}` for the band; fall back to a sane default band if a med is missing. (`DEFAULT_SLOT_BAND_MS` = 2h fallback for a deleted/missing med.)
- [x] Extend `web/cloud/js/tests/inbox-apply.test.js`: (a) seed meds with a **real schedule** (e.g. `{"type":"daily","times":["21:30"]}`), let `materializeDueDoses` create the intakes, then Confirm → assert **all N** are confirmed; (b) a **drift regression**: one med's stored intake `scheduled_at` offset within its `minDoseInterval` of the callback slot → still confirmed. Both FAIL on exact-`===`, pass on band.
- [x] Run `inbox-apply.test.js` (Node 20) — must pass before Task 2. (59 tests pass.)

### Task 2: Plumb message_id + edit the reminder message on Confirm/Snooze (bug 1)
- [x] Go (`internal/cloudserver/telegram.go`): add `MessageID int64 \`json:"message_id"\`` to `intakeSlotEvent` (`:1522`) and populate it from `cq.Message.MessageID` in `handleCallbackQuery` (`:1583`) — `cq.Message` is optional (0 when Telegram omits it for old messages).
- [x] JS (`web/cloud/js/inbox-apply.js`): pass `editReply` into `applyIntakeSlotAction` at `createInboxApplier` (`:558`); after the confirm/snooze loop, when `event.message_id` is present, call `editReply(event.message_id, text)` — for `confirm`: `confirmationText({kind:'intake'}, {confirmed: n}, verbosity)` ("✅ Confirmed N medications"); for `snooze`: a short "⏰ Snoozed" receipt (respect `verbosity`). `n` = count actually confirmed; get `verbosity` via `createRemindersDomain(...).getDeliveryPref()`. The `if (!messageId) return` guard (`:168`) makes a missing id a safe no-op. (editMessageText with no reply_markup removes the buttons.)
- [x] Go test: the `intake_slot_action` event carries `message_id` from the callback query. JS test: extend the confirm event with `message_id`, inject an `editReply` spy (mirror the `applyTGCommand` tests ~`:485/:495`), assert it's called with `(message_id, /Confirmed 2 medications/)`; snooze edits to the snoozed receipt.
- [x] Run `inbox-apply.test.js` (Node 20) + `go test ./internal/cloudserver/...` — must pass before Task 3. (63 JS tests + cloudserver suite pass.)

### Task 3: Verify + full suite
- [x] Verify (skipped - manual behavioral test, not automatable here; covered by test suite: band-match drift regression + editReply spy assertions in `inbox-apply.test.js`, Go message_id plumbing test in cloudserver).
- [x] Run `go build ./...` + `go build -tags mobile ./...` + `go test ./internal/cloudserver/...`, and the full frontend suite (`node node_modules/vitest/vitest.mjs run`, **Node 20**) incl. domain-purity + globals — all pass. (Server + mobile builds OK; cloudserver OK; frontend 3789/3789 relevant tests pass — 3 flaky failures in unrelated suites, backup-crypto/workout-sessions/modals.header-actions, all green when run in isolation; changed files inbox-apply.js + telegram.go fully green.)

## Technical Details

- **Band, per med:** `minDoseIntervalMs(med.schedule, med.tz_shift_policy)` — the same value the horizon/materialize dedup use, so confirm-matching becomes consistent with reminder-generation. This is the whole data-correctness fix.
- **Single slot per message is correct** — do NOT change `computeReminderHorizon` grouping or `push.js`; the bug is purely on the confirm-match + message-edit side.
- **message_id may be absent** (Telegram omits `cq.Message` for old messages) → the edit is a safe no-op; the confirm still records (data fix is independent of the edit).

## Post-Completion

**Manual verification** (cloud account + Telegram): schedule 3–4 meds at the same time,
edit one med's time slightly after the reminder is pushed, tap Confirm, and verify ALL
meds show as taken in the web app AND the Telegram message loses its buttons and shows
"✅ Confirmed N medications".
