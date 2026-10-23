# Brief — Meds timeline

Short single-feature brief (claude-design skill, "Owner decisions"). Screens land in
`ui_kits/app-v2/screens-meds.html` as MT1…; beads reference them as `Spec: screens-meds.html MTn`.

## What it does

One scrollable timeline replaces the History and Upcoming sub-tabs: what is planned, what is due,
and what happened, in one consistent picture. It reads from the single dose engine (Archie and
Socrates, `Meds timeline · work`), so every dose shown here is the same dose that Telegram and
the native notifications show, with the same id, time and state.

Owner's sketch (Zulip msg 3404), from top to bottom:

    Tomorrow
      08:20  meds…
    Today                    ← lands here, in the best spot on screen
      Next     (grouped by time)
      Pending  (fired, not confirmed; grouped by time)
      08:20  meds… (taken)
    Yesterday
      21:30  group taken
      08:20  group taken
    22.10 …                  ← more loads on scroll

## The engine's row (Archie, `Meds timeline · work` msg 3456)

Every surface reads the same projection, and each timeline row is one occurrence:

    {occId, medId, name, dosage, plannedAt, localDate, localTime, tz,
     source: schedule | tz_step | manual,
     state: upcoming | due | snoozed | taken | skipped,
     takenAt?, snoozedUntil?, stepNote?}

- Rows are grouped by (localDate, localTime). A group's action acts on exactly that group's
  occIds.
- **Today:** Next = `upcoming` today; Pending = `due` and `snoozed`, including `due` rows from
  earlier days (labelled with their date); Taken = `taken` and `skipped` today.
- **Tomorrow** = `upcoming`. **Earlier days** = the ledger, loaded by localDate as you scroll.
- `tz` is the zone the time was planned in. Show it only when it differs from the current
  zone (e.g. "08:20 · Berlin").
- `source: tz_step` rows carry `stepNote` (a transition step). `manual` rows are logs with no
  plan behind them.
- Correction writes to the same occurrence: change `takenAt`, flip to skipped, or "Not taken"
  (back to due). Confirming from Telegram, a notification or the app hits the same id, so a
  duplicate is impossible by construction.

## Current screens being replaced

`current/screenshots/07-meds-history.png`, `33-meds-upcoming.png`, `32-meds-schedule.png`;
`current/screenshots/test-vault/18-meds-history.png`, `19-meds-upcoming.png`, `15-meds-schedule.png`.

## Screens wanted

- **MT1: Timeline, a normal day.** Tomorrow collapsed above; Today anchored with Next, Pending
  and Taken; two earlier days below.
- **MT2: Pending after a timezone change.** Doses in two zones, a tz-step dose, and how the
  timeline says which clock a time belongs to.
- **MT3: Correct a dose, in one action.** Tapping a row opens the M2 take sheet in edit mode:
  Taken / Skipped / Not taken, plus the taken time. Covers a stale pending dose, a wrong
  "taken" and a wrong time. A group row opens the sheet with each med as a check row.
- **MT4: Past unconfirmed dose.** A dose from an earlier day that is still pending: its row in
  its own day, and its dated row in Today's Pending block, with Take and Skip. Pending never
  expires, so after a trip they can pile up: each earlier day that still has pending doses gets
  one bulk cleanup action ("Mark all taken" / "Skip all", Miles msg 3459), confirmed through an
  undo toast rather than a dialog. Draw a day with 5+ stale pending doses.
- **MT6: Out-of-date reminder.** A Telegram or notification tap that no longer matches a dose
  (combined proposal 3493, Phase 1 (4)) opens the timeline scrolled to that med. A note shows
  the reminder's original time ("Reminder for 08:20 Berlin is out of date"); nothing is
  preselected or auto-logged, and the user picks the dose deliberately.
- **MT2 addition: a flagged conflict.** After a zone change, if both the old and the new
  instant of one dose have evidence, show both rows, flagged (warn) "Logged twice? Check", and
  never settle it silently. Fixing it uses the MT3 sheet.
- **MT5: Empty, loading and offline.** No meds; the skeleton while older days load; offline;
  and the outdated-app banner "Update to keep logging medications" (writes blocked, reads
  fine; proposal Phase 2 (e)), reusing the offline banner pattern.

## Neighbouring kit screens

M1 Schedule (time buckets with Take N / Log late), M2 Take sheet (reused for confirm and edit),
M3 Stock, M4 Empty, T1 Today Next up (same doses, different view), T2 tz card.

## Constraints

`wg-*` kit v2 at 390×844, dark only. One sun-filled control per view (kit rule 1): the
Take action of the soonest Next group. Status only via ok, warn, danger, stale and pending
tokens; no emoji. Tap a row = edit (kit rule 3). Hit targets of at least 44px.

## Owner decisions (2026-10-23, msg 3420)

1. **Schedule and Stock stay.** The Meds sub-tabs become **Timeline · Schedule · Stock**; the
   timeline replaces History and Upcoming only.
2. **No "missed" state.** An unconfirmed dose stays pending until the user acts; only the user
   marks it taken or skipped. Design consequence: no pending dose may be out of sight. Pending
   doses from earlier days are also listed in Today's Pending block, each labelled with its
   date, and stay in their own day too.
3. **Tomorrow:** the first 2 groups, plus "N more" when space allows.
4. **Taken today:** one row per group, with the meds visible without a tap.

## Out of scope here

The Stock split into "Add refill" / "Count stock" (proposal Phase 3) is an M3 change and gets
its own brief later.

## Review of the first pass (Archie msg 3545)

- Phase 1 vs Phase 2 data: "Was 08:24" (prior taken_at), "via Telegram" (evidence `via`),
  "travel day" (tz switch_at), "marked 23.10" (acted_at) and the conflict rows are **Phase 2**.
  Captions mark them "P2"; P1 renders without them.
- Cut: "Logged in the app"; MT6's reason sentence (keep "Reminder for 08:20 Berlin is out of
  date. Pick the dose you mean."); MT6's "never comes back" note.
- MT2 zone note rule: shown whenever the device zone ≠ the tracked zone (not "3 days").
- Bulk "Mark all taken" writes taken_at = planned time.
- Snoozed: a pending row with a "Snoozed until 08:30" chip; no snooze button in the timeline.
- Conflict: skipping or undoing either row clears the flag on both (confirmed).
- M1 follow-up: "missed today" → Pending.
