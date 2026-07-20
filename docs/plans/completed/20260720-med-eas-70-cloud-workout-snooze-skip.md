# Cloud workout reminders: Snooze 1h/2h + Skip buttons with server-side (blind-relay) snooze re-fire (med-eas.70)

## Overview

Cloud-mode Telegram **workout-session** reminders currently fire once with no
buttons (primary-fire-only, med-eas.59) because the bot's snooze/skip/re-notify
state machine needs server-observed session state that a blind relay cannot see.

This change gives cloud workout reminders parity with the bot's basic controls:
`[Snooze 1h] [Snooze 2h] [Skip]` buttons, PLUS a NEW relay capability — the
server (blind relay) **re-fires** the snooze reminder ~1h/2h later so it arrives
even if the PWA never reopens. Owner decision 2026-07-20: "Scope B — relay
re-fires snooze."

**Zero-knowledge invariant (hard):** the relay MUST NEVER decrypt `ct` or read
vault data. The snooze re-fire only COPIES already-cleartext fields of the tapped
`scheduled_pushes` row (`tg_text` / `tg_callback` / `delivery`) at a new
`fire_at_unix`. `fire_at` is already cleartext in this table, so the relay learns
nothing new. Existing "server forwards ct verbatim / stays blind" tests
(`relay_test.go`, `push_test.go`) MUST stay green.

**Non-goals:** the bot's full +3h re-notify / +6h auto-skip / 90-min stale ladder
(needs continuous server-side session observation the relay lacks). Just the 3
buttons + one relay re-fire per snooze.

## Context (from discovery)

**Callback protocol** (`internal/tgclient/tgclient.go`):
- `CallbackSlotPrefix = "s:"`, actions `CallbackActionConfirm`/`CallbackActionSnooze`.
- `ValidCallbackStem(s)` — accepts `""` (no buttons) or `s:<positive-int64>`, len ≤ 32.
- `ParseCallbackData("s:<slot>:<action>")` → `(slotUnix, action, ok)`.
- `CallbackQuery.Message.Text` (line 547) carries the reminder text on a tap — the
  re-fire source, so no extra storage is needed. `Message` is optional (Telegram
  omits it for old messages).

**Relay send** (`internal/cloudserver/telegram.go`):
- `SendReminder(ctx, accountID, text, callbackStem)` (line ~1666) hardcodes 2
  buttons `Confirm`/`Snooze` when the stem is non-empty. Validates via
  `ValidCallbackStem`; drops buttons on an invalid stem.
- `handleCallbackQuery` (line ~1590) parses `cq.Data`, seals an
  `intakeSlotEvent{Kind:"intake_slot_action", SlotUnix, Action, AtUnix, MessageID}`
  to the account inbox via `SealAndQueue`, answers the tap. Always 200.
- Relay sender path: `relay.go` `sendTelegram` → `SendReminder(p.AccountID, p.TGText, p.TGCallback)`.

**Schedule store** (`internal/cloudstore/push.go`):
- `ReplaceSchedule` (line ~148) DELETEs ALL unsent rows for the account then
  re-inserts the client's batch. A relay-inserted re-fire (unsent) would be wiped
  on the next client sync — the WIPE LANDMINE.
- `ScheduledPush{ID, AccountID, FireAt, CT, SentAt, Delivery, TGText, TGCallback}`.
  `DueScheduledPushes` selects unsent rows with `fire_at_unix <= now`.
- Migrations dir `internal/cloudstore/migrations/` — highest is `018_feedback.sql`.
  NEW migration = `019_*`.

**Horizon build** (`web/domain/reminders.js`, PURE):
- Med entries carry `callback: 's:<slotUnix>'` (lines 338, 356). Workout entries
  (`pushWorkout`, line ~488) carry NO callback today.
- Recurring workout loop (line ~500): iterates `workoutGroups`, resolves the
  variant, emits `pushWorkout(fireMs, text)` per weekday occurrence. `group.id` +
  `dateStr` (`YYYY-MM-DD`) are in scope. `sessionStatusByKey` (`group.id|dateStr`)
  already suppresses the primary fire once a session is non-`pending`.
- Planned ad-hoc loop (line ~530): `group_id === WORKOUT_ADHOC_GROUP_ID (-1)`,
  multiple per day possible → `(groupId,date)` is NOT unique. **Ad-hoc reminders
  stay button-less** (documented ceiling).

**Client push upload** (`web/cloud/js/push.js`): line 379 already maps any
`r.callback` → `entry.tg_callback` at telegram/both delivery. **No push.js change
needed** — attaching `callback` to a workout entry in reminders.js flows through.

**Workout domain** (`web/domain/workout.js`, PURE):
- `sessionRecordId(groupId, date)` = `session-<groupId>-<date>` (deterministic
  slot for schedule-materialized sessions, LWW-converging across devices).
- `snoozeSession(id, minutes)` (line 1232) / `skipSession(id)` (line 1244) resolve
  by NUMERIC id via `findSession` → `findByNumericId`. A recurring reminder fires
  BEFORE the session is materialized, so the drain must FIND-OR-CREATE the
  deterministic `session-<groupId>-<date>` record, not look up a numeric id.
  A materialized `notified`+`snoozed_until` (or `skipped`) session with that
  recordId also correctly suppresses future primary fires via `sessionStatusByKey`.
- `createWorkoutDomain({records, now, timeZone})` — `records.list/put/del`, pure.

**Client drain** (`web/cloud/js/inbox-apply.js`): `createInboxApplier` dispatches
sealed events by `event.kind`; `intake_slot_action` handled at ~line 717
(`applyIntakeSlotAction`). Edits the Telegram reply to a receipt via messageId.

**Tests to keep green:** `TestRelay_ForwardsCallbackStemForButtons`,
`TestPutSchedule_RejectsMalformedCallbackStem`, `TestRelay_DeliveryChannelRouting`,
and all `relay_test.go`/`push_test.go` blind/ct-verbatim assertions.

## Development Approach

- **Testing approach**: Regular (code first, then tests). Repo policy: frontend
  tests are INTEGRATION-FIRST via existing cloud suites — NO `*-branches` /
  `*-edges` / `pin-defect-N` files. Go tests are table-driven in the owning package.
- Cloud-primary: **do NOT add bot-mode Go parity** (`internal/bot`, `internal/scheduler`,
  mobile). Reading `internal/scheduler/workout.go` for behavior parity is fine.
- Complete each task fully (code + tests green) before the next.
- No new `window.*` globals. No hardcoded colors / inline `.style.` (no UI here anyway).
- Domain purity: `reminders.js` + `workout.js` stay pure (no `window`/`document`/`fetch`/IndexedDB).

## Testing Strategy

- **Go unit tests**: `internal/tgclient` (workout stem parse/validate), `internal/cloudstore`
  (`push_test.go`: origin-aware ReplaceSchedule + relay-refire insert/cancel),
  `internal/cloudserver` (`telegram_test.go`/`relay_test.go`: buttons-by-kind,
  snooze→refire-row, skip→cancel-refire). Keep zero-knowledge assertions untouched.
- **Frontend (Vitest, Node 20 REQUIRED)**: extend the existing cloud reminders +
  inbox-apply suites — workout callback emission; drain snooze/skip find-or-create.
- **Architecture suites**: `architecture.domain-purity.test.js`, `architecture.globals.test.js` green.

## Progress Tracking
- Mark completed `[x]` immediately. New tasks `➕`, blockers `⚠️`.

## Implementation Steps

### Task 1: Extend the callback protocol for workout actions (tgclient)
- [x] in `internal/tgclient/tgclient.go` add `CallbackWorkoutPrefix = "w:"` and actions `CallbackActionSnooze1h = "snooze1h"`, `CallbackActionSnooze2h = "snooze2h"`, `CallbackActionSkip = "skip"` (keep `confirm`/`snooze` for meds).
- [x] extend `ValidCallbackStem` to also accept a workout stem `w:<groupId>:<YYYYMMDD>` — `groupId` a positive int64, date exactly 8 digits; keep `s:` behavior and the len cap comfortably ≥ the workout stem (raise the 32 cap only as much as needed; `w:<int>:<8>:<action>` stays well under Telegram's 64-byte callback_data limit).
- [x] add `ParseWorkoutCallback(data) (groupID int64, date string, action string, ok bool)` returning `date` as `YYYY-MM-DD` (re-insert dashes) and `ok` only for `snooze1h`/`snooze2h`/`skip`; leave `ParseCallbackData` (the `s:` med parser) unchanged.
- [x] add a small helper `IsWorkoutCallback(data) bool` (prefix check) so the handler can route namespaces without double-parsing.
- [x] write table-driven tests in `internal/tgclient/tgclient_test.go`: valid/invalid workout stems, round-trip parse (`w:6:20260720:snooze1h` → group 6, date `2026-07-20`, `snooze1h`), rejects bad action / non-numeric group / wrong date length / >64-byte data, and med `s:` stems still parse.
- [x] `go build ./...` and `go test ./internal/tgclient/...` — must pass before Task 2.

### Task 2: origin marker column + origin-aware ReplaceSchedule + relay-refile store methods (cloudstore)
- [x] add migration `internal/cloudstore/migrations/019_push_origin.sql`: `ALTER TABLE scheduled_pushes ADD COLUMN origin TEXT NOT NULL DEFAULT 'client';` (goose up/down; down drops the column). NEVER edit an existing migration.
- [x] add exported consts `PushOriginClient = "client"`, `PushOriginRelayRefire = "relay_refire"` in `push.go`.
- [x] change `ReplaceSchedule`'s DELETE to `... AND sent_at_unix IS NULL AND origin = 'client'` so relay re-fires survive a client re-upload; client inserts stay origin `client` (default covers it — no `ScheduledPushInput` change).
- [x] add `InsertRelayRefire(ctx, accountID string, fireAt time.Time, tgText, tgCallback string) error` — INSERT one row with `delivery = DeliveryTelegram`, empty `ct` (`[]byte{}`), `origin = 'relay_refire'`. It copies already-cleartext fields only; it must NEVER read/produce `ct`.
- [x] add `CancelRelayRefire(ctx, accountID, tgCallback string) (int64, error)` — `DELETE FROM scheduled_pushes WHERE account_id=? AND origin='relay_refire' AND tg_callback=? AND sent_at_unix IS NULL`; return rows affected.
- [x] write tests in `internal/cloudstore/push_test.go`: (a) `ReplaceSchedule` preserves an unsent `relay_refire` row while wiping `client` rows; (b) `InsertRelayRefire` then `DueScheduledPushes` returns it with the copied text/callback + telegram delivery + empty ct; (c) `CancelRelayRefire` deletes only matching unsent refires (not sent ones, not other callbacks). Keep existing blind/ct assertions green. (tests added to `repo_test.go`, the package's scheduled-push test home — there is no `push_test.go`)
- [x] `go build ./...`, `go build -tags mobile ./...`, `go test ./internal/cloudstore/...` — must pass before Task 3.

### Task 3: buttons-by-kind + relay re-fire / cancel on tap (cloudserver telegram.go)
- [x] in `SendReminder`, build the button set by stem namespace: `s:` → `Confirm`/`Snooze` (unchanged); `w:` → `Snooze 1h`(`:snooze1h`) / `Snooze 2h`(`:snooze2h`) / `Skip`(`:skip`). Keep the `ValidCallbackStem` guard (drops buttons on an invalid stem).
- [x] in `handleCallbackQuery`, branch on `tgclient.IsWorkoutCallback(cq.Data)`: keep the med path as-is; for workout, `ParseWorkoutCallback` → `groupID, date, action` (routed to a new `handleWorkoutCallback` helper).
- [x] add a sealed event `workoutSessionEvent{Kind:"workout_session_action", GroupID int64, Date string, Action string, AtUnix int64, MessageID int64}` (const `inboxEventKindWorkoutSession = "workout_session_action"`); `SealAndQueue` it for every workout tap (session-state reconciliation), same `ErrNoInboxKey` drop rule as meds.
- [x] on `snooze1h`/`snooze2h`: compute `fireAt = now + 1h/2h`; call `store.InsertRelayRefire(accountID, fireAt, refireText, cq.Data-stem)` where `refireText = cq.Message.Text` (fallback to a short generic `"Workout reminder"` when `cq.Message` is nil) and the re-fire's `tg_callback` is the SAME workout stem `w:<groupID>:<YYYYMMDD>` (so the user can snooze again). Answer `callbackAckSnooze`.
- [x] on `skip`: call `store.CancelRelayRefire(accountID, stem)` to drop any pending re-fire for this session; answer a skip ack (added `callbackAckSkipped = "⏭️ Skipped — it will apply when you next open the app."`).
- [x] store methods called directly on the concrete `*cloudstore.Repo` (`TelegramAPI.store`) — no interface seam needed.
- [x] write tests in `internal/cloudserver/telegram_test.go`: workout reminder renders 3 buttons with correct callback_data; a `snooze1h` tap seals a `workout_session_action` event AND inserts a `relay_refire` row at ~now+1h copying the message text + same callback; `snooze2h` fires ~2h out; a `skip` tap seals the event AND cancels pending refires; `cq.Message==nil` uses the generic text; no-inbox-key drops AND schedules no refire; blind/ct-verbatim assertions stay green.
- [x] `go build ./...`, `go build -tags mobile ./...`, `go test ./internal/cloudserver/...` — pass.

> Recovery note: Task 1's commit (63a5bd94) only checked its boxes — the tgclient
> workout code + tests were never actually written. Added the missing
> `CallbackWorkoutPrefix`/actions, `ValidCallbackStem` workout branch,
> `IsWorkoutCallback`, `ParseWorkoutCallback`, and the Task 1 table-driven tests
> in this iteration since Task 3 could not compile or pass without them.

### Task 4: emit the workout callback stem (reminders.js) + drain apply (inbox-apply.js + workout.js)
- [x] in `web/domain/reminders.js`, give the RECURRING workout loop a callback: pass `callback = 'w:' + group.id + ':' + dateStr.replaceAll('-', '')` into `pushWorkout`, and set `entry.callback` on the emitted entry (leave ad-hoc `pushWorkout` calls without a callback). Keep `pushWorkout`'s existing `fireMs<=now` guard.
- [x] in `web/domain/workout.js` add pure methods `snoozeScheduledSession({groupId, date, minutes, atMs})` and `skipScheduledSession({groupId, date})`: resolve the record by `recordId === sessionRecordId(groupId, date)`; if absent, create a minimal deterministic session (recordId, `group_id`, `scheduled_date=date`, `status:'notified'`); then set `snoozed_until = new Date(atMs + minutes*60000).toISOString()` + `snooze_count++` (snooze) or `status:'skipped'` (skip, then `tryAdvanceRotation`). Return through `createWorkoutDomain`'s public object.
- [x] in `web/cloud/js/inbox-apply.js` add a `workout_session_action` branch to the drain: map `snooze1h→60`, `snooze2h→120`, `skip`; call the workout-domain method with `atMs = event.at_unix*1000` (server tap time, like meds); edit the Telegram reply to a receipt via `event.message_id` (reuse the med path's edit helper).
- [x] write/extend tests (Vitest, Node 20): in the existing cloud reminders suite — a recurring workout entry carries `callback: 'w:<id>:<YYYYMMDD>'` and ad-hoc entries do not; in the existing inbox-apply suite — draining a `workout_session_action` snooze1h sets the `session-<groupId>-<date>` record's `snoozed_until`/`snooze_count` (creating it if absent), and a skip marks it `skipped`.
- [x] run `architecture.domain-purity.test.js` + `architecture.globals.test.js` — green (no window/fetch/globals introduced).
- [x] run the touched frontend suites (Node 20) — must pass before Task 5.

### Task 5: Verify acceptance criteria
- [x] grep the full diff for the zero-knowledge invariant: no new `ct` read/decrypt on the relay/refire path; re-fire copies cleartext fields only. (InsertRelayRefire writes empty ct `[]byte{}`; refireText = cleartext cq.Message.Text)
- [x] confirm callback_data for every emitted workout button is ≤ 64 bytes and `ValidCallbackStem` accepts the emitted stem. (max = 39 bytes with int64-max groupId; typical 21 bytes)
- [x] confirm no existing migration was edited; `019_push_origin.sql` is the only new one; migration numbers are contiguous. (001–019 contiguous, only 019 added)
- [x] `go build ./...` AND `go build -tags mobile ./...` — both green.
- [x] `go test ./internal/tgclient/... ./internal/cloudserver/... ./internal/cloudstore/...` — green (incl. untouched blind/ct-verbatim tests).
- [x] Node 20 vitest on the cloud reminder / inbox-apply / push / relay-related suites + architecture (domain-purity, globals) — green. (144 tests passed)

## Technical Details

**Callback wire format:** `w:<groupId>:<YYYYMMDD>:<action>`, e.g. `w:6:20260720:snooze1h`
(~21 bytes). Stem (button-attached) = `w:<groupId>:<YYYYMMDD>`. Med format `s:<slot>:<action>` unchanged.

**Dedup — ReplaceSchedule-wipe vs relay-refile:** the `origin` column splits ownership.
`ReplaceSchedule` deletes only `origin='client'` unsent rows, so a `relay_refire` row
survives client re-uploads. There is NO double-reminder because `reminders.js` is
primary-fire-only for workouts — the client never emits a competing workout re-reminder,
so the relay re-fire is the SOLE re-reminder. Once it fires, `sent_at_unix` is stamped and
it is never re-selected.

**Skip re-fire cancellation:** a Telegram `skip` tap calls `CancelRelayRefire(accountID, stem)`,
deleting pending refires for exactly that session's callback. **Known ceiling** (ponytail):
a skip/complete performed IN-APP (not via Telegram) does not cancel an already-scheduled
relay refire, so a stale re-fire may still arrive once — matching the bot's accepted
staleness and the med path's fire-and-reconcile model. Not in scope to close.

**Ad-hoc scope:** only recurring group reminders get buttons; planned ad-hoc reminders
(`group_id===-1`, non-unique `(groupId,date)`) stay primary-fire-only. Documented limitation.

## Post-Completion

**Manual verification:**
- On a real cloud deployment with a linked Telegram bot: a recurring workout reminder shows `[Snooze 1h][Snooze 2h][Skip]`; tapping Snooze 1h with the PWA closed re-delivers ~1h later; the tap also sets `snoozed_until` on next app open; Skip stops the re-fire and marks the session skipped on next open.
