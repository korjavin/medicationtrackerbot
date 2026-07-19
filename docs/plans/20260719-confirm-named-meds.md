# Cloud Confirm by identity, not time — stop dropping drifted course-meds (bd med-eas.67)

## Overview

**P1 medication data-loss.** In cloud mode, tapping Confirm on a Telegram reminder that
groups N meds can leave one med PENDING (adherence lost + a duplicate re-reminder an hour
later). Reproduced: 4 meds due 21:30, "✅ Confirmed 4 medications", but Coclav (a
non-daily antibiotic course) stayed PENDING and re-fired at 22:30.

**Root cause (contract, not band tuning).** The reminder decides the slot's med set at
PUSH time — `computeReminderHorizon` groups schedule targets by exact `scheduledAtMs` and
knows every med in the message — but the Telegram callback carries **only `slot_unix`**
(64-byte limit). So Confirm RE-DERIVES the med set at drain time by band-matching PENDING
intakes within **±10 min** of the slot (`inbox-apply.js:162-164`). For a course med the
two derivations diverge: tz-plan/DST steps (`tzplan.js:204-225`) and clustering
(`medintake.js:361-419`) drift the materialized intake **hours** off the named slot;
`materializeDueDoses`' ±`minDoseInterval` dedup (`medintake.js:148-154`) then keeps that
off-slot row and skips creating an on-slot one, so the confirm band misses it. med-eas.64
narrowed the band but **rejected widening it** (a genuinely different dose is
≥`minDoseInterval` away → widening risks FALSE-POSITIVE confirms).

**Fix: carry identity, not time.** Persist the reminder's own med set per slot at
horizon-build time (`slot_unix → [medicationId…]`), and at Confirm act on THAT set —
confirm each named med's due PENDING intake near the slot within **that med's own**
`minDoseInterval`. Scoping the wider interval to the exact meds the reminder named is what
makes it safe: we only ever confirm a dose the reminder explicitly told the user about, so
no false positive. Keep the ±10-min band as a fallback for reminders with no stored map
(pre-existing/legacy, or a cross-device gap).

**Safety invariant (non-negotiable):** a false NEGATIVE (a med left PENDING, user re-nagged)
is acceptable; a false POSITIVE (marking a dose TAKEN the user didn't take) is NOT. Every
design choice below prefers the former.

## Context (from discovery)

- **Grouping / identity is known at build time** — `computeReminderHorizon`
  (`web/domain/reminders.js:321-335`): `bySlot` maps `t.scheduledAtMs → [displayName]`
  from schedule `targets`; each target has `t.medicationId`. The medication entry is
  emitted with `callback: 's:'+slotUnix` (`:334`) — the slot, no med ids. The re-remind
  loop (`:340-357`) emits per-intake entries keyed `s:<floor(intake.scheduled_at/1000)>`
  (the intake instant, which for a drifted med differs from the group slot).
- **Confirm re-derivation** — `web/cloud/js/inbox-apply.js` `applyIntakeSlotAction`
  (`:147`): `materializeDueDoses()` then band-match PENDING intakes
  `Math.abs(scheduled_at - slotMs) <= SLOT_DRIFT_BAND_MS` (10 min, `:162-164`); count via
  the same time filter (`:203-205`). `intake.confirm(recordId, atMs)` backdates taken_at.
- **Drift sources** — `web/domain/tzplan.js:204-225` (tz_step targets deliberately off the
  clock slot; `planDosesWithTzPlan` suppresses the normal slot, `:301-325`);
  `medintake.js:361-419` (cluster at `clusterEarliestMs`); dedup `medintake.js:148-154`.
- **`minDoseInterval`** — `web/domain/medschedule.js:200-206` (`minDoseIntervalMs`,
  the same helper the horizon/materialize already use — reuse it, don't hardcode).
- **Push seam** — `web/cloud/js/push.js` `pushSchedule` (`:267+`) calls the horizon and
  uploads entries; it's the client-side place with the built horizon in hand where a local
  `slot → medIds` map is written for `inbox-apply` to read. Check whether push.js already
  keeps any local copy of what it pushed and extend that rather than adding a parallel
  store.
- **Callback payload is slot-only** — `internal/cloudserver/telegram.go:1549-1555,1619-1625`
  (`intakeSlotEvent{SlotUnix,Action,AtUnix,MessageID}`) — do NOT try to widen it; the fix
  is entirely client-side (build + drain both run over the local vault).
- **Test** — `web/cloud/js/tests/inbox-apply.test.js` (the med-eas.64 suite). Run vitest
  with **Node 20** (`/tmp/node-v20.18.1-linux-x64/bin` on PATH; `node
  node_modules/vitest/vitest.mjs run <file>`).

## Development Approach

- **Testing approach**: Regular. Each task ends with passing tests (Node 20).
- Purity: `web/domain/*` stays pure (no storage/globals) — `computeReminderHorizon` only
  EXPOSES the med ids; the vault write happens in the cloud layer (`push.js`), the read in
  `inbox-apply.js`.
- Medication-safety first: keep the ±10-min band fallback; the identity path only ADDS
  coverage for named meds, never removes a guard.

## Progress Tracking
- Mark `[x]` immediately. `➕` new, `⚠️` blocker.

## Implementation Steps

### Task 1: expose the per-slot medication set from the horizon
- [x] `web/domain/reminders.js` `computeReminderHorizon`: build `bySlot` (and the
      re-remind loop) so each medication entry also carries `medicationIds: [medId…]`
      (dedupe within a slot; include the re-remind entry's single med id for its slot
      stem). Keep `text`/`callback` unchanged. Pure — just richer output.
- [x] Tests (`web/domain/` reminders test, or the owning suite): a slot grouping 3 meds
      emits an entry whose `medicationIds` holds all 3; a re-remind entry carries its one
      med id keyed to the intake-instant slot.
- [x] Run the reminders domain test (Node 20) — must pass before Task 2.

### Task 2: persist slot → medicationIds at push time
- [x] `web/cloud/js/push.js` `pushSchedule`: after building the horizon, write a local
      vault singleton (e.g. record type `reminder_slot_meds`) = `{ slots: { <slotUnix>:
      [medId…] } }`, OVERWRITING it each build (bounded to the current horizon window).
      Reuse any existing local push-state record if one exists. Prefer a device-local
      (non-synced) record to avoid oplog churn — the band fallback (Task 3) covers a
      cross-device/stale gap. Done: device store key `slotMeds` (same IndexedDB `device`
      store as `demoReminders`), built from entries' `s:<slotUnix>` stems + `medicationIds`.
- [x] A tiny reader helper (in push.js or a small module) `getSlotMedications(records,
      slotUnix) -> medId[]|null` for inbox-apply to consume. Done as
      `getSlotMedications(slotUnix)` reading the device store (device-local, so no
      `records` port arg needed; Task 3 injects it into inbox-apply).
- [x] Tests: after `pushSchedule`, the stored map contains each slot with its med ids;
      re-running with a changed schedule overwrites (no stale slots accumulate).
- [x] Run the push test (Node 20) — must pass before Task 3.

### Task 3: Confirm the named meds by identity (band as fallback)
- [ ] `web/cloud/js/inbox-apply.js` `applyIntakeSlotAction`: after `materializeDueDoses()`,
      look up `medicationIds = getSlotMedications(records, event.slot_unix)`.
  - **If found (identity path):** for EACH named med, select its PENDING intake nearest
    the slot within `minDoseIntervalMs(med.schedule, med.tz_shift_policy)` of the slot
    (nearest-wins; skip a med with no qualifying PENDING intake). Confirm (or snooze)
    exactly those. This is safe because the set is the reminder's own named meds.
  - **If not found (fallback):** the existing ±`SLOT_DRIFT_BAND_MS` band match, unchanged.
- [ ] Receipt count = **distinct named meds actually confirmed by this tap** (not a time
      filter) — fixes the "Confirmed 4" vs 3-taken mismatch. Preserve the at-least-once /
      double-tap idempotency (a redelivery re-runs with the meds already TAKEN → filtered
      out → don't clobber the good receipt; keep the `applied > 0` guard and the
      deterministic-atMs reasoning).
- [ ] Snooze path: same identity resolution (snooze each named med's due PENDING intake).
- [ ] Tests (`web/cloud/js/tests/inbox-apply.test.js`, Node 20) — the regression that
      currently FAILS:
      - **Course-med drift**: 4 meds named for slot S; one med's only PENDING intake sits
        >10 min but < its `minDoseInterval` from S (a tz_step/cluster drift) → Confirm marks
        **all 4** TAKEN (the drifted one included) and the receipt says "Confirmed 4".
      - **Count correctness**: receipt counts distinct meds, not band-matched rows.
      - **No false positive**: a PENDING dose of a med NOT named for the slot (or a
        different dose ≥ its interval away) is left untouched.
      - **Fallback**: with no stored map, behavior is exactly the current band match
        (existing tests still green).
      - **Idempotency**: redelivery / double-tap doesn't re-confirm or clobber the receipt.
- [ ] Run `inbox-apply.test.js` (Node 20) — must pass before Task 4.

### Task 4: verify + full suite
- [ ] Full frontend suite (`node node_modules/vitest/vitest.mjs run`, **Node 20**) incl.
      `architecture.domain-purity.test.js` (reminders.js stays pure) + globals — all green.
- [ ] `go build ./...` + `go build -tags mobile ./...` (no Go changes expected — confirm).

### Task 5: Verify acceptance criteria
- [ ] Tapping Confirm on an N-med reminder confirms EVERY med the reminder named, including
      a course med whose materialized intake drifted (tz-plan/cluster) beyond ±10 min —
      no med left PENDING, no duplicate re-reminder.
- [ ] The receipt count equals distinct meds confirmed.
- [ ] No false-positive confirms: only meds the reminder named, only their due doses within
      each med's own interval; unrelated PENDING doses untouched. Band fallback intact for
      mapless reminders. Idempotent across redelivery/double-tap.

## Technical Details

- **Why identity beats time**: a schedule edit or tz-plan approval between push and drain
  legitimately changes a dose's instant, so no deterministic-id scheme keeps push-time and
  drain-time derivations aligned. The med set the reminder NAMED is the stable join key.
- **Why the wider per-med interval is safe here**: unscoped, ±`minDoseInterval` risks
  confirming an unrelated dose (med-eas.64's rejection). Scoped to the exact meds the
  reminder named for this slot, "the named med's nearest due dose" is precisely the dose
  the user was told about — confirming it is correct, not a guess.
- **Fallback keeps old reminders working**: reminders pushed before this ships (no map
  entry) fall through to the unchanged band match — no regression, no migration.
  <!-- ponytail: device-local slot map + band fallback; a synced map would remove the
       cross-device gap but adds oplog churn on every horizon build — not worth it -->

## Post-Completion

**Manual verification** (cloud + Telegram): a med course with a tz-plan/medium policy so
one med's intake drifts off its clock slot; trigger a grouped reminder, tap Confirm, and
confirm ALL meds (incl. the drifted one) show TAKEN in the web app with no re-reminder an
hour later. Then confirm an unrelated later dose is still PENDING (no over-confirm).
