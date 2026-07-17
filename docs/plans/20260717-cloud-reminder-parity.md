# Cloud reminder/notification parity: low-stock, workout-session, weekly digest

## Overview

Cloud computes its reminder horizon client-side in `web/domain/reminders.js`
(`computeReminderHorizon` / `createRemindersDomain.buildHorizon`) and uploads it to
the blind push relay via `web/cloud/js/reminders.js` → `pushSchedule`. Today it
emits `medication`, `bp`, and `weight` kinds only. Three bot-mode notifications
have no cloud equivalent (from the med-eas.54 parity audit):

- **med-eas.57** — low-stock medication reminder (bot: `internal/scheduler/low_stock.go`).
- **med-eas.59** — workout-session reminder (bot: `internal/scheduler/workout.go`).
- **med-eas.58** — weekly digest (bot: `internal/scheduler/weekly_digest.go`).

All three are reproducible **purely client-side** over vault data — no bot/server
changes. This plan adds the two new reminder kinds to the horizon and a weekly
digest entry, all riding the existing replace-all push relay.

**Acceptance:** in cloud, (57) a user low on a medication gets a low-stock push;
(59) a user with a scheduled workout gets a session reminder; (58) with the
weekly-digest toggle on, a weekly digest notification fires ~weekly. Bot mode
unchanged. Delivery uses the existing relay + delivery-pref (channel/verbosity).

## Context (from discovery)

- **Horizon internals** — `web/domain/reminders.js`: `computeReminderHorizon({medications, intakes, bps, weights, timeZone, now, tzPlan, bpStatus, weightStatus})` is a pure fn emitting entries `{fireAtUnix, kind, text, genericText, callback?}`; med block gated by enable (blanked upstream), bp/weight blocks `if(status.enabled)` + per-target `mutedUntil` over `FORECAST_DAYS=7` at a local wall hour via `localWallToUtcMs`/`localDateParts`; final `sort + slice(0, MAX_HORIZON_ENTRIES=500)`. Factory `createRemindersDomain({records, now})` reads pref singletons (`getStatus`/`getBPStatus`/`getWeightStatus`) and the delivery pref (`getDeliveryPref`). Raw record arrays are passed *in* (server field names) — a kind needing a new record type must be listed in the shim and threaded as a new arg.
- **Relay wire shape** — `web/cloud/js/push.js:281-296`: `{fire_at_unix, delivery, ct?(NK-enc {title,body,kind}), tg_text?(generic?genericText:text), tg_callback?}`. `recomputeAndPush` (`web/cloud/js/reminders.js:65-71`) merges `getDeliveryPref()`; invoked on unlock (`cloud-boot.js:318`) and after every relevant mutation (`scheduleReminderRecompute`). Forward-dated + replace-all ⇒ **dedup is automatic**, no last-sent state needed.
- **Low-stock (57)** — bot `low_stock.go`: fires user-TZ 11:00, threshold `< 7 days of supply` via days-of-supply (inventory/dailyUsage), text `⚠️ Low Stock Warning … • <Name>: <N> units (~<D> days left)`, no buttons. Cloud port already exists: `web/domain/medschedule.js` `listLowOnStock(medications, now, 7)` (`:176`), `getDaysOfStockRemaining` (`:147`), `DEFAULT_LOW_STOCK_THRESHOLD_DAYS=7`. Vault `medication` record has `inventory_count`, `schedule`, `end_date`, `archived`. **Fully reproducible; reuse the med-reminder enable gate (no new pref).**
- **Workout (59)** — bot `workout.go`: recurring groups (`days_of_week`+`scheduled_time`, notify at `scheduled - notification_advance_minutes`) + planned ad-hoc sessions (group_id -1, concrete `scheduled_date`/`scheduled_time`); text `🏋️ Workout starting in N minutes … <Group> - <Variant>` + exercises; Start/Snooze/Skip buttons; gated on `GetWorkoutEnabled`. Cloud `web/domain/workout.js` `getNext()` (`:1224`) already reproduces the recurring-group + rotation-variant scan (`resolveVariantId`, `localWallToUtcMs`); ad-hoc sessions enumerable from the vault. Record types: `workoutgroup, workoutvariant, workoutexercise, workoutrotation, workoutsession, exerciselog`. **Two scope decisions (below):** no cloud workout-enable pref exists → add one; the interactive re-notify(+3h)/auto-skip(+6h)/snooze/stale-90min state machine is NOT reproducible over a blind relay → emit primary fire only (same accepted limitation as medication re-reminders, `reminders.js:34-38`).
- **Weekly digest (58)** — bot `weekly_digest.go`: Sunday local 19:00, `FormatWeeklyReview(GetWeeklyReview(...))`, sections omitted-when-empty (header/quiet fallback, `Health Score`, levers, weight, BP-in-range, resting HR, best day). Cloud already ports the read model whole: `web/domain/gamification.js` `getWeeklyReview()` (`:2475`) returns the identical snake_case shape. Missing: a JS port of the Go `FormatWeeklyReview` text formatter (`internal/bot/gamification_commands.go:71-93`) + appending one forward-dated horizon entry. Gate: `getFeatures().weekly_digest` (+ gamification on). The cloud Settings toggle is currently **hidden** (`web/static/js/features/settings.js:628-631`, med-eas.44) — un-hide it. Anchor `getWeeklyReview` on `now-24h` to report the week that just ended (mirrors Go `weekly_digest.go:111-117`).
- **Tests** — `web/static/js/tests/reminders.domain.test.js` (pure `computeReminderHorizon`, seed record arrays, assert entries by `kind`/`fireAtUnix` vs `Date.UTC`); factory/pref tests use `createInMemoryRecordsPort` from `./helpers/cloud-shim-harness.js`; `gamification.substrate.test.js:345` already covers `getWeeklyReview`. genericText contract test asserts every entry has a non-empty name-free `genericText`.

## Development Approach

- **Testing approach:** Regular. Match bot text/semantics (use the Go schedulers as the oracle for text + trigger).
- Purity: all new domain logic in `web/domain/*.js` stays pure (no browser globals) — `architecture.domain-purity.test.js` enforces it. Wiring that reads records/settings lives in `web/cloud/js/reminders.js`.
- No hardcoded colors/inline styles for the un-hidden toggle (rule 3); no new `window.*` globals (rule 4).
- Each task ends with passing tests before the next.

## Testing Strategy

- Pure-fn tests in `reminders.domain.test.js` for the low_stock kind, workout kind, and digest formatter/fire-time. Factory/pref + wiring tests via `createInMemoryRecordsPort`. Extend the genericText contract test to cover new kinds. Reuse the `gamification.substrate.test.js` seeding for the digest.

## Progress Tracking

- Mark items `[x]` immediately. `➕` new tasks, `⚠️` blockers.

## Implementation Steps

### Task 1: Low-stock reminder kind (med-eas.57)
- [ ] In `web/domain/reminders.js` `computeReminderHorizon`, append a `low_stock` block gated on the medication-reminder enable flag (already resolved in `buildHorizon`): for each day 0..`FORECAST_DAYS`, compute local 11:00; if in the future and `listLowOnStock(medications, targetInstant)` (import from `web/domain/medschedule.js`) is non-empty, push one entry.
- [ ] Entry shape `{fireAtUnix, kind:'low_stock', text, genericText}` — `text` = `⚠️ Low Stock Warning` header + `• <Name>: <N> units (~<D> days left)` per low med (mirror `low_stock.go:75-86`); `genericText` = name-free (e.g. `⚠️ Some medications are running low`); no callback.
- [ ] Write tests: low-inventory med → a `low_stock` entry at the next local 11:00 with the med named in `text` and not in `genericText`; high-inventory / null-inventory / as-needed → no entry; extend the genericText contract test.
- [ ] Run the reminders domain suite — must pass before Task 2.

### Task 2: Workout reminder preference singleton (med-eas.59 part 1)
- [ ] In `web/domain/reminders.js` factory, add a `workoutreminderpref` singleton (mirror the bp/weight pref pattern: `enabled`, `snoozed_until`, `dont_remind_until`) with `getWorkoutStatus`/`setWorkoutEnabled`/`snoozeWorkout`/`dontBugWorkout`. Default `enabled` per the bp/weight convention.
- [ ] Write tests for the pref read/write defaults (via `createInMemoryRecordsPort`).
- [ ] Run tests — must pass before Task 3.

### Task 3: Workout-session reminder kind (med-eas.59 part 2)
- [ ] Thread workout data into the horizon: update `web/cloud/js/reminders.js` `computeReminderEntries` to list the workout record types (`workoutgroup`, `workoutvariant`, `workoutexercise`, `workoutrotation`, `workoutsession`) and pass them (plus `workoutStatus`) into `buildHorizon` → `computeReminderHorizon` as new args.
- [ ] In `computeReminderHorizon`, append a `workout` block gated on `workoutStatus.enabled`: compute upcoming scheduled instants — recurring groups (`days_of_week`+`scheduled_time` across `FORECAST_DAYS`, resolving the rotation variant like `web/domain/workout.js` `getNext`) and planned ad-hoc sessions (concrete `scheduled_date`/`scheduled_time`) — fire at `instant - notification_advance_minutes`. Apply the `mutedUntil` gate.
- [ ] Entry `{fireAtUnix, kind:'workout', text: '🏋️ Workout starting … <Group> - <Variant>' (+ exercises), genericText: '🏋️ Time for your workout', callback?}`. Emit the **primary fire only** — explicitly do NOT reproduce the +3h re-notify / +6h auto-skip / snooze / stale-90min state machine (not reproducible over a blind relay; documented limitation, same as medication re-reminders).
- [ ] Write tests: a scheduled recurring group → a `workout` entry at `scheduledInstant - advance`; a planned ad-hoc session → an entry; workout pref disabled → no entry; genericText present + name-generic.
- [ ] Run tests — must pass before Task 4.

### Task 4: Weekly-digest formatter + fire-time helper (med-eas.58 part 1)
- [ ] In `web/domain/reminders.js` (or a pure sibling in `web/domain/`), add `formatWeeklyDigest(review)` porting Go `FormatWeeklyReview` (`internal/bot/gamification_commands.go:71-93`) line-for-line: `🗓 Your week` header / `A quiet week …` fallback, Health Score line, lever line, weight line, BP-in-range line, resting-HR line, best-day line — each omitted when its data is absent.
- [ ] Add `nextWeeklyDigestFireUnix(now, timeZone)` → next Sunday 19:00 local via `localDateParts`/`localWallToUtcMs`.
- [ ] Write tests: formatter over a populated `getWeeklyReview`-shaped review (asserts the section lines) and a quiet-week review (asserts the fallback); fire-time correctness vs `Date.UTC`.
- [ ] Run tests — must pass before Task 5.

### Task 5: Wire the digest into the cloud horizon + un-hide the toggle (med-eas.58 part 2)
- [ ] In `web/cloud/js/reminders.js` `computeReminderEntries`: when `getFeatures().weekly_digest` (and gamification enabled), build `createGamificationDomain({records, now: () => now() - 86400000, timeZone}).getWeeklyReview()`, and append `{fireAtUnix: nextWeeklyDigestFireUnix(now(), timeZone), kind:'digest', text: formatWeeklyDigest(review), genericText: 'Your weekly summary is ready'}` (skip when `review.enabled === false`). No callback.
- [ ] In `web/static/js/features/settings.js` (~:628-631), stop hiding the `weekly-digest-feature-toggle` row in cloud so the toggle drives the producer (keep it hidden only if gamification is off, matching the bot's both-on gate). No hardcoded styles.
- [ ] Write tests: toggle on + seeded gamification records → exactly one `digest` entry at next Sunday 19:00 local, no callback, name-free `genericText`, `text` containing `🗓 Your week`; toggle off → no digest entry.
- [ ] Run tests — must pass before Task 6.

### Task 6: Verify acceptance + full suite
- [ ] Verify the uploaded horizon includes `low_stock`, `workout`, and `digest` entries under the right gates; bot mode unchanged (no Go touched).
- [ ] Run `go build ./...` + `go build -tags mobile ./...` (should be untouched) and the full frontend suite (`pnpm test`), including `architecture.domain-purity` and `architecture.globals` — all must pass.

### Task 7: [Final] Docs
- [ ] Update `docs/cloud-bot-parity.md`: move the low-stock, workout-session, and weekly-digest rows from **gap** to **parity**, and add a one-line note that the workout interactive re-notify/auto-skip/snooze state machine is intentionally not reproduced over the blind relay (primary fire only).

## Technical Details

- **Dedup without state:** the horizon is forward-dated and replace-all, so `recomputeAndPush` on each unlock/mutation re-derives the next low-stock 11:00, next workout instants, and next Sunday 19:00 digest; once an instant passes it isn't re-added. This replaces the bot's server-side `lastSentAt`/`lastCheck` guards entirely — no digest/state record.
- **Workout limitation (explicit):** only the primary fire is emitted. The bot's interaction-driven transitions (re-notify, auto-skip, stale nag, snooze wake) require server-observed session state a blind relay can't see; reproducing them would need server involvement, which is out of scope for a pure-cloud change.

## Post-Completion

**Manual verification** (needs a real cloud account with seeded data + a Telegram/webpush channel):
- Set a med low on stock → confirm a low-stock notification near the next 11:00.
- Schedule a workout → confirm a session reminder at `scheduled - advance`.
- Enable the weekly-digest toggle → confirm a digest notification the next Sunday evening matching what bot mode would send for the same data.
