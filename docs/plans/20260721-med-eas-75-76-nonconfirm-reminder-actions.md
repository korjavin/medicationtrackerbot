# Non-confirm reminder actions (workout + BP + weight) — med-eas.75 + med-eas.76

## Overview

Generalize the "non-confirm reminder action" pattern — deep-link (URL) button +
server-side Snooze + Skip + message-rewrite-on-tap — and apply it to the three
reminders that are NOT per-dose confirms: **workout** (med-eas.75), **BP** and
**weight** (med-eas.76). Build the mechanism ONCE; do not write three copies.

Reuses machinery already merged on the base branch:
- med-eas.70 primitives `cloudstore.RescheduleRelayRefire` / `CancelRelayRefire`
  (stem-keyed relay re-fire supersede / cancel).
- med-eas.74.1 `editMedCallbackMessage` — the editMessageText-on-tap helper
  (already caller-static-text generic; rename to `editCallbackMessage` and reuse
  for workout + measure, do NOT duplicate).
- The med `s:` and workout `w:` callback dispatch + button-build patterns.

### What each reminder gains
- **Workout** (already has `w:` Snooze 1h/2h + Skip from med-eas.70): add a
  `▶️ Start` deep-link URL button, and rewrite the message on Skip/Snooze tap
  (today it only shows a transient toast, leaving buttons live).
- **BP / weight** (today plain pushes, NO buttons): add `🌐 Open` deep-link URL
  button + `⏰ Snooze 1h` (server re-fire) + `⏭️ Skip` (suppress), with the
  message rewritten on tap.

### Deep-link
`https://<account.Subdomain>.<baseDomain>/?tab=<workouts|bp|weight>` — built
SERVER-SIDE in `internal/cloudserver/telegram.go` (NOT in the pure
`web/domain/reminders.js`). A bare `?tab=<section>` handler is added to
`deeplink-router.js` (workouts/bp/weight are stable bottom-nav ids;
`switchTab` already accepts them).

### Skip semantics (BP/weight)
Mirror the app's existing mute: Snooze → `snoozeBPReminder` / `snoozeWeightReminder`
(sets `snoozed_until = now+1h`); Skip → `dontBugBPReminder` / `dontBugWeightReminder`
(sets `dont_remind_until`, the app's end-of-day mute). Server also
`CancelRelayRefire`s on Skip so the relay horizon agrees with the client horizon.

### Zero-knowledge invariant (do NOT weaken)
Relay never reads ct/vault. Re-fires copy only cleartext push fields (text + stem)
and write ZERO ciphertext. Message edits use server-composed STATIC consts. Deep-link
URLs are the account host + a static section path — no vault data. `callback_data` ≤ 64B.
Existing "relay stays blind" tests (`telegram_test.go` re-fire `len(rf.CT)==0`,
`push_test.go` verbatim-forward) must stay green.

## Context (from discovery)

Base: `feat/med-eas-75-76-nonconfirm-reminder-actions` off `origin/master`
(med-eas.74 PR#675 + med-eas.70 merged).

Files/components involved (with the exact seams):

**`internal/tgclient/tgclient.go`**
- `:412-415` `InlineKeyboardButton{Text, CallbackData}` — add `URL string \`json:"url,omitempty"\``.
- `:454` `CallbackSlotPrefix="s:"`, `:462` `CallbackWorkoutPrefix="w:"`, `:466-472`
  actions (`confirm/snooze/snooze1h/snooze2h/skip`).
- `:481-500` `ValidCallbackStem` (40-byte cap `:488`) — add bp:/wt: acceptance.
- `:531-533` `IsWorkoutCallback`, `:539-564` `ParseWorkoutCallback`,
  `:568-585` `ParseCallbackData` (s:) — mirror for bp/wt.
- `:420-429` `SendMessageWithButtons`, `:360-379` `EditMessageText` /
  `EditMessageTextClearMarkup` — URL button serializes automatically once the field exists.

**`internal/cloudserver/telegram.go`**
- `:1627-1731` `handleCallbackQuery` dispatch: `:1664` `IsWorkoutCallback`→`handleWorkoutCallback`,
  `:1669` med `ParseCallbackData`. Add a measure branch here (before med parse; no cross-parse).
- `:1739-1751` `editMedCallbackMessage(ctx, bot, ref, messageID, text)` — the reuse target;
  rename to `editCallbackMessage`. Static consts `:1768-1771`. ZK comment `:1738`.
- `:1781-1852` `handleWorkoutCallback` — snooze `RescheduleRelayRefire`, skip
  `CancelRelayRefire`; ACK is toast-ONLY (`:1844`,`:1849`) → ADD an `editCallbackMessage`
  rewrite + drop buttons. `workoutSessionEvent` carries `MessageID` (`:1791-1804`).
- `:1610-1614` ack toast consts.
- `:1869-1910` `SendReminder(ctx, accountID, text, callbackStem)`: `:1886` drops buttons if
  `!ValidCallbackStem`; `:1896-1908` button-set switch (workout arm) — add `▶️ Start` URL to
  workout arm + a new measure arm `[🌐 Open URL, ⏰ Snooze 1h, ⏭️ Skip]`.
- `:176/:225` `baseDomain`; account subdomain = `cloudstore.Account.Subdomain`
  (URL form per `provision.go:56-58` `ClaimURL` = `https://<subdomain>.<baseDomain>/...`).
  `SendReminder` has only `accountID` → resolve subdomain via store (add a thin
  `AccountByID`/`SubdomainByAccount` in cloudstore if none exists).

**`web/domain/reminders.js`** (PURE — no URLs here)
- `:66-75` `mutedUntil` = max(snoozed_until, dont_remind_until).
- BP push emit `:359` (kind `bp`), weight push emit `:381` (kind `weight`) — NO `callback`
  today. Add `callback:` stems mirroring med `:330` (`s:${slotUnix}`) and workout
  `:503-504` (`w:${group.id}:${date}`). BP/weight have no group/date → use a slot-unix stem
  `bp:${fireAtUnix}` / `wt:${fireAtUnix}`.
- `:568-591` BP setters `snoozeBPReminder`/`dontBugBPReminder`, `:604-624` weight setters
  `snoozeWeightReminder`/`dontBugWeightReminder` — the drain calls these.

**`web/cloud/js/inbox-apply.js`**
- `:43-48` event-kind consts, `:326-355` `applyWorkoutSessionAction` (the 30-line template),
  `:726-803` `apply` dispatcher (`:779-789` workout arm), `:363-375` `editTelegramReply`.
  Add a measure arm calling the reminders-domain bp/weight setters, `now` pinned to `event.at_unix`.

**`web/static/js/features/deeplink-router.js`**
- `:22-26` path routes, `:47-79` query-param handler (only `action=add` wired today;
  bare `?tab=<section>` NOT handled). `switchTab` (`app.js:716-765`) already accepts
  `bp/weight/workouts/health`. Add a bare `?tab=<allowed>` → `switchTab` branch.

**Zero-knowledge tests** (must stay green):
- `internal/cloudserver/telegram_test.go:1207-1238` (med re-fire no ct),
  `:1446-1500` (workout re-fire no ct).
- `internal/cloudserver/push_test.go:111,:147` (verbatim ct forward).

## Development Approach
- **Testing approach**: Regular (code + tests together, per task).
- Build the shared mechanism once; bp + weight share ONE event kind, ONE callback
  parser (returns `kind`), ONE handler, ONE button arm, ONE drain arm.
- Complete each task fully (code + tests + green) before the next.
- Do NOT weaken zero-knowledge tests. `callback_data` ≤ 64B.
- Cloud-primary; bot + mobile are legacy — NO bot parity needed.
- Never edit an existing migration (none needed here).
- No new `window.*` globals.

## Testing Strategy
- **Go**: `internal/tgclient/*_test.go`, `internal/cloudserver/telegram_test.go`,
  `internal/cloudstore/*_test.go` (if a store method is added).
- **Frontend (Vitest, Node 20)**: `reminders.domain` suite, cloud `inbox-apply` suite,
  and architecture suites (domain-purity, cloud-tokens, globals).
- Both Go build tags must build: `go build ./...` AND `go build -tags mobile ./...`.

## Progress Tracking
- Mark `[x]` immediately when done.
- ➕ for newly discovered tasks, ⚠️ for blockers.

## What Goes Where
- Implementation Steps: code + tests + purity/build checks (automatable).
- Post-Completion: manual Telegram tap-through, cloud redeploy.

## Implementation Steps

### Task 1: tgclient — URL button field + bp/wt callback namespace
- [x] add `URL string \`json:"url,omitempty"\`` to `InlineKeyboardButton` (`tgclient.go:412-415`); a button is EXACTLY one of url / callback_data
- [x] add measure callback prefixes `CallbackBPPrefix="bp:"` and `CallbackWeightPrefix="wt:"` (near `:454/:462`); reuse existing actions `snooze1h`, `skip`
- [x] add `IsMeasureCallback(data)` (HasPrefix bp:/wt:) and `ParseMeasureCallback(data) (kind, slotUnix, action, ok)` mirroring `ParseCallbackData` (`:568-585`); whitelist actions snooze1h/skip; do NOT cross-parse s:/w:
- [x] extend `ValidCallbackStem` (`:481-500`) to accept bp:/wt: stems (respect 40-byte cap) so `SendReminder` does not strip the buttons
- [x] write tests in `internal/tgclient/tgclient_test.go`: URL button JSON marshals `url` (and omits `callback_data`); `ParseMeasureCallback` success + reject (bad action, w:/s: not cross-parsed); `ValidCallbackStem` accepts bp:/wt:, rejects oversize
- [x] run `go test ./internal/tgclient/...` — must pass before Task 2

### Task 2: telegram.go — one measure handler + button sets + workout message-rewrite
- [ ] rename `editMedCallbackMessage` → `editCallbackMessage` (`:1739-1751`) and update its 2 med call sites; it stays static-text generic (ZK)
- [ ] add static edit-text consts: measure snooze `"⏰ Snoozed 1h — I'll remind you again."`, measure/workout skip `"⏭️ Skipped — waiting for your device to record it."`, workout snooze `"⏰ Snoozed — I'll remind you again."`
- [ ] `handleWorkoutCallback` (`:1781-1852`): on Snooze and Skip, after the existing SealAndQueue + RescheduleRelayRefire/CancelRelayRefire, call `editCallbackMessage(...)` to rewrite the message + drop buttons (reuse `EditMessageTextClearMarkup`); keep the toast answer
- [ ] add `handleMeasureCallback(ctx, cq, ...)`: `ParseMeasureCallback` → kind+slot+action; seal a `measureReminderEvent{Kind:'bp'|'weight', Action:'snooze'|'skip', AtUnix, MessageID}` via SealAndQueue (new event, mirror `workoutSessionEvent` `:1791-1820`); Snooze → `RescheduleRelayRefire(now+1h, refireText, stem)`; Skip → `CancelRelayRefire(stem)`; both call `editCallbackMessage`; answer toast
- [ ] dispatch in `handleCallbackQuery` (`:1664`): add `if tgclient.IsMeasureCallback(cq.Data) { t.handleMeasureCallback(...); return }` before the med `ParseCallbackData` branch
- [ ] resolve account subdomain server-side for URL: add a thin cloudstore lookup by accountID if none exists (else reuse existing); build `https://<subdomain>.<baseDomain>/?tab=<section>`
- [ ] `SendReminder` (`:1869-1910`) button switch: workout arm — prepend `{Text:"▶️ Start", URL: startURL}`; add measure arm `else if IsMeasureCallback(stem)` → `[{Text:"🌐 Open", URL: openURL}, {Snooze 1h}, {Skip}]`. Section = workouts/bp/weight derived from stem
- [ ] write tests in `internal/cloudserver/telegram_test.go`: measure Snooze RescheduleRelayRefire carries `len(rf.CT)==0` (relay blind); measure Skip CancelRelayRefire; measure + workout tap rewrites message (EditMessageTextClearMarkup) with the static const; URL button present with correct `?tab=` host
- [ ] write/extend cloudstore test if an AccountByID/subdomain lookup was added
- [ ] run `go test ./internal/cloudserver/... ./internal/cloudstore/...` — must pass before Task 3

### Task 3: reminders.js — emit bp/wt callback stems (PURE, no URLs)
- [ ] BP push (`web/domain/reminders.js:359`): add `callback: \`bp:${fireAtUnix}\``
- [ ] weight push (`:381`): add `callback: \`wt:${fireAtUnix}\``
- [ ] confirm no URL/host logic added here (purity preserved)
- [ ] extend the reminders.domain test suite: bp/weight entries now carry the expected callback stem; workout/med unchanged
- [ ] run the `reminders.domain` vitest suite (Node 20) — must pass before Task 4

### Task 4: deeplink-router.js — bare ?tab=<section> switch
- [ ] add a branch so `?tab=workouts|bp|weight` (no `action`) calls `switchTab(tab)` (`web/static/js/features/deeplink-router.js:47-79`), whitelisting allowed section ids; keep existing `action=add` behavior
- [ ] clean the URL via replaceState after switching (match existing pattern)
- [ ] write/extend the deeplink-router test: bare `?tab=workouts` switches section; unknown tab ignored
- [ ] run the relevant vitest suite (Node 20) — must pass before Task 5

### Task 5: inbox-apply.js — drain measureReminderEvent
- [ ] add event-kind const `MEASURE_REMINDER_ACTION` (`web/cloud/js/inbox-apply.js:43-48`)
- [ ] add `applyMeasureReminderAction(event, {reminders, editReply})`: build reminders domain with `now: () => event.at_unix*1000`; Snooze → `snoozeBPReminder`/`snoozeWeightReminder` by kind; Skip → `dontBugBPReminder`/`dontBugWeightReminder`; then `editReply(message_id, staticText)`
- [ ] wire it into the `apply` dispatcher (`:726-803`) alongside the workout arm; unknown kinds still ignored
- [ ] write tests in the cloud inbox-apply suite: bp snooze sets snoozed_until, weight skip sets dont_remind_until, idempotent on redelivery (pinned now), editReply called
- [ ] run the cloud `inbox-apply` vitest suite (Node 20) — must pass before Task 6

### Task 6: Verify acceptance criteria
- [ ] `go build ./...` AND `go build -tags mobile ./...` both succeed
- [ ] `go test ./internal/cloudserver/... ./internal/cloudstore/... ./internal/tgclient/...` green
- [ ] Vitest (Node 20, `export PATH="/tmp/node-v20.18.1-linux-x64/bin:$PATH"`): `reminders.domain`, cloud `inbox-apply`, `push`, `relay` suites, and architecture suites (`domain-purity`, `cloud-tokens`, `globals`) green
- [ ] grep the diff for zero-knowledge: no ct/vault read in relay; re-fires copy only cleartext text+stem; edits use static consts; URLs carry only host + `?tab=`; `callback_data` ≤ 64B
- [ ] confirm reminders.js added no non-pure references (domain-purity test green)
- [ ] confirm no new `window.*` globals (globals test green)

## Technical Details

- **Callback shapes**: `bp:<fireAtUnix>:<action>`, `wt:<fireAtUnix>:<action>`, action ∈
  {`snooze1h`, `skip`}. Stem (pre-action) ≈ 13B; full ≈ 22B — well under 64B and the 40B stem cap.
- **Event shape (sealed to inbox, cleartext push side stays blind)**:
  `measureReminderEvent{Kind, Action, AtUnix, MessageID}` — mirrors `workoutSessionEvent`.
- **URL**: `https://<account.Subdomain>.<baseDomain>/?tab=<section>` where section =
  workouts | bp | weight. Built in telegram.go only.
- **Re-fire text**: static server-composed (e.g. reuse the reminder's own cleartext push text
  or a static "measure" nag) — never a vault value; `RescheduleRelayRefire` row carries no ct.

## Post-Completion
*No checkboxes — manual/external.*

**Manual verification**: in a live Telegram chat, tap Start/Open (opens app at section),
Snooze (re-nags with app closed), Skip (rewrites message, drops buttons, no double-nag).
Requires cloud redeploy (med-eas.70/.74 also awaiting deploy).

**Deferrals to flag in the PR**: the chosen deep-link route (`?tab=<section>` via a new bare
handler in deeplink-router.js) and BP/weight Skip semantics (end-of-day `dont_remind_until`,
mirroring the app's mute).
