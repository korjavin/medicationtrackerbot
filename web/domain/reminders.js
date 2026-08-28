// Runtime-agnostic reminder-horizon computation. Pure logic, no records port
// for the computation itself (callers pass medication/intake arrays straight
// in, same style as medschedule.js) — plus a small records-port-backed
// enable/disable preference, so the same file can later run inside the Go
// server via goja (C6). Mirrors internal/scheduler/medication.go (fire
// targets, batched-by-slot text) and medication_reminder.go (re-remind
// rules), simplified per the C2b plan: rather than firing notifications on a
// live server tick, the client computes a bounded horizon of
// {fireAtUnix, text} entries and uploads them to the blind push relay
// (web/cloud/js/push.js's pushSchedule) after every mutation and on unlock.
//
// Record type: medreminderpref — a singleton {enabled} toggle (default true,
// matching the server always reminding while the medication feature is on)
// gating whether the med portion of the horizon is computed at all.
import { forecastDosesWithTzPlan } from './tzplan.js';
import {
  minDoseIntervalMs, localWallToUtcMs, localDateParts,
  listLowOnStock, getDaysOfStockRemaining,
} from './medschedule.js';

const REMINDERPREF_RECORD_TYPE = 'medreminderpref';
const REMINDERPREF_RECORD_ID = 'medreminderpref';
const BP_REMINDERPREF_RECORD_TYPE = 'bpreminderpref';
const BP_REMINDERPREF_RECORD_ID = 'bpreminderpref';
const WEIGHT_REMINDERPREF_RECORD_TYPE = 'weightreminderpref';
const WEIGHT_REMINDERPREF_RECORD_ID = 'weightreminderpref';
const DELIVERYPREF_RECORD_TYPE = 'reminderdeliverypref';
const DELIVERYPREF_RECORD_ID = 'reminderdeliverypref';
// slotmeds — the vault-resident record of which medications each pushed
// reminder NAMED, keyed by its "s:<slotUnix>" callback stem (bd med-eas.65).
// A Telegram Confirm carries only that stem, so this is what lets the drain
// resolve the tap to the message's own med set by identity instead of guessing
// from a time band. In the vault (not a device store, as med-eas.67 first had
// it) because the device that PUSHED the reminder is routinely not the device
// that DRAINS the tap — every cross-device Confirm used to miss the map.
const SLOTMEDS_RECORD_TYPE = 'slotmeds';
const SLOTMEDS_RECORD_ID_PREFIX = 'slotmeds-';
const LEGACY_SLOTMEDS_RECORD_ID = 'slotmeds-current'; // pre-med-onzf singleton, read-only fallback

export const DELIVERY_CHANNELS = ['webpush', 'telegram', 'both'];
export const VERBOSITIES = ['detailed', 'generic'];

const FORECAST_DAYS = 7;
// ponytail: hard cap far under the relay's 2000-entry/4KB limit; unrealistic
// to hit with real schedules, guards a pathological edge case only.
const MAX_HORIZON_ENTRIES = 500;

// How long a FIRED slot's med set is kept after its instant. The horizon is
// forward-looking and rebuilt constantly, so a slot leaves it as soon as the
// local day rolls over — but the Telegram message is still sitting in the
// user's chat, and the relay re-fires it for ~6h. Without retention, "tap
// yesterday evening's Confirm this morning" found no map and fell back to the
// ±band, which is exactly the drift case this whole record exists to fix.
// 48h covers a night, a phone that was off, and the re-fire chain. Past that a
// tap is legacy-shaped and takes the ±band path.
const SLOTMEDS_RETAIN_MS = 48 * 60 * 60 * 1000;

function medDisplayName(med) {
  return med.dosage ? `${med.name} (${med.dosage})` : med.name;
}

// Exported for workout.js's ad-hoc session creation (Task 3), which needs the
// same device-local HH:MM stamp the server derives from `time.Now().Format("15:04")`.
export function formatHHMM(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.hour}:${map.minute}`;
}

// Ported from the batched text in internal/scheduler/medication.go's Check
// (grouped by exact slot) and the singular body in
// internal/webpush/webpush.go's SendMedicationNotification.
function doseSlotText(names) {
  return names.length === 1
    ? `\u{1F48A} Time to take: ${names[0]}`
    : `\u{1F48A} Time to take (${names.length} medications): ${names.join(', ')}`;
}

// Mute windows, ported from internal/store/{bp,weight}/reminders.go's
// SnoozeReminder (2h) and DontBugMeReminder (24h). Both are "mute until"
// instants, not flags: `enabled` stays true and the schedule resumes on its own.
export const SNOOZE_MS = 2 * 60 * 60 * 1000;
export const DONT_BUG_MS = 24 * 60 * 60 * 1000;

// mutedUntil collapses a pref record's two independent mute instants into the
// later of the two — the same OR-gate the Go scheduler applies
// (internal/scheduler/bp_reminders.go: skip while now < snoozed_until OR
// now < dont_remind_until).
function mutedUntil(status) {
  return Math.max(status.snoozed_until || 0, status.dont_remind_until || 0);
}

// Every entry carries a name-free twin of its `text`. Cloud mode forwards
// Telegram reminders to the relay in plaintext, so a user who doesn't want
// medication names leaving the vault picks `generic` verbosity and we send
// these instead (see docs/cloud-mode.md, bd med-76c.1).
const GENERIC_DOSE_TEXT = '\u{1F48A} Medication time';
const GENERIC_BP_TEXT = '\u{1F4CA} Time for a scheduled measurement';
const GENERIC_WEIGHT_TEXT = '\u{2696}\u{FE0F} Time for a scheduled measurement';
const GENERIC_LOW_STOCK_TEXT = '\u{26A0}\u{FE0F} Some medications are running low';
const GENERIC_WORKOUT_TEXT = '\u{1F3CB}\u{FE0F} Time for your workout';

const LOW_STOCK_HOUR = 11; // bot fires the daily low-stock warning at 11:00 local (low_stock.go)

const WORKOUT_ADHOC_GROUP_ID = -1;
// Ad-hoc sessions have no group/variant/exercise list threaded (see the plan's
// record-type list); mirror the bot's header-only body for a planned one-off.
const WORKOUT_ADHOC_TEXT = '\u{1F3CB}\u{FE0F} **Workout starting now**';

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(s || '');
  return m ? { hour: +m[1], minute: +m[2] } : null;
}

// Ported from sendWorkoutNotification (internal/scheduler/workout.go:539): the
// "starting in N minutes" header, the "Group - Variant" line, and one bullet
// per exercise `N. **name**: sets × reps[ @ Wkg]` (reps as `min-max` when a
// distinct max is set).
function workoutRecurringText(advanceMinutes, groupName, variantName, exercises) {
  const lines = [
    `\u{1F3CB}\u{FE0F} **Workout starting in ${advanceMinutes} minutes**`,
    '',
    `**${groupName} - ${variantName}**`,
  ];
  if (exercises.length > 0) {
    lines.push('', 'Exercises:');
    exercises.forEach((ex, i) => {
      const max = ex.target_reps_max;
      const reps = max !== null && max !== undefined && max !== ex.target_reps_min
        ? `${ex.target_reps_min}-${max}` : `${ex.target_reps_min}`;
      let line = `${i + 1}. **${ex.exercise_name}**: ${ex.target_sets} \u{00D7} ${reps}`;
      if (ex.target_weight_kg !== null && ex.target_weight_kg !== undefined) {
        line += ` @ ${Math.round(ex.target_weight_kg)}kg`;
      }
      lines.push(line);
    });
  }
  return lines.join('\n');
}

// Ported from internal/scheduler/low_stock.go's Check text builder: a header
// plus one bullet per low med `• **<Name>**: <N> units (~<D> days left)`.
function lowStockText(lowMeds) {
  const lines = [
    '\u{26A0}\u{FE0F} **Low Stock Warning**',
    '',
    'The following medications are running low (< 7 days):',
    '',
  ];
  for (const med of lowMeds) {
    const days = getDaysOfStockRemaining(med);
    const daysStr = days !== null && days !== undefined ? ` (~${Math.round(days)} days left)` : '';
    lines.push(`\u{2022} **${med.name}**: ${med.inventory_count} units${daysStr}`);
  }
  lines.push('');
  lines.push('Please restock soon!');
  return lines.join('\n');
}

// ---- Weekly digest (med-eas.58) --------------------------------------------
// Ports the Go text formatter internal/bot/gamification_commands.go's
// FormatWeeklyReview + friends line-for-line. Input is the snake_case
// WeeklyReview read model web/domain/gamification.js getWeeklyReview() returns
// (identical shape to the Go read model). Kept pure so the same file runs in
// goja server-side later. Wired into the horizon by web/cloud/js/reminders.js
// (Task 5).
const DIGEST_LEVER_LABELS = { bedtime: 'Bedtime', movement: 'Movement', nourishment: 'Nourishment' };
const DIGEST_PACE_LABELS = {
  on_pace: 'on pace',
  too_slow: 'slower than your pace',
  too_fast: 'faster than your pace',
  wrong_direction: 'moving away from goal',
};
const DIGEST_ACCEL_LABELS = { speeding_up: 'speeding up', holding: 'holding steady', slowing: 'slowing' };
const DIGEST_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function digestScoreLine(hs) {
  if (!hs || !hs.now || hs.now.value === null || hs.now.value === undefined) return '';
  const now = Math.round(hs.now.value);
  if (!hs.prior || hs.prior.value === null || hs.prior.value === undefined) return `Health Score ${now}`;
  const delta = now - Math.round(hs.prior.value);
  if (delta === 0) return `Health Score ${now} \u{00B7} holding steady`;
  return delta > 0 ? `Health Score ${now} \u{00B7} up ${delta}` : `Health Score ${now} \u{00B7} down ${-delta}`;
}

function digestLeverLine(levers) {
  if (!levers || levers.length === 0) return '';
  return levers.map((lv, i) => {
    const label = DIGEST_LEVER_LABELS[lv.key] || lv.key;
    return i === 0 ? `${label} closed ${lv.closed_this_week} of 7` : `${label} ${lv.closed_this_week}`;
  }).join(' \u{00B7} ');
}

function digestWeightLine(w) {
  if (!w || w.status !== 'ok') return '';
  const sign = w.velocity_pct_per_week >= 0 ? '+' : '';
  const parts = [`${sign}${w.velocity_pct_per_week.toFixed(1)}%/wk`];
  const pace = DIGEST_PACE_LABELS[w.pace_status];
  if (pace) parts.push(pace);
  const accel = DIGEST_ACCEL_LABELS[w.acceleration];
  if (accel) parts.push(accel);
  return 'Weight ' + parts.join(' \u{00B7} ');
}

function digestBPLine(bp, priorShare) {
  if (!bp || bp.status !== 'ok' || !(bp.count_30d > 0)) return '';
  const share = Math.round((bp.share_30d || 0) * 100);
  const prior = Math.round((priorShare || 0) * 100);
  if (prior <= 0) return `BP in range ${share}%`;
  const delta = share - prior;
  const word = delta > 0 ? `up from ${prior}%` : delta < 0 ? `down from ${prior}%` : 'holding steady';
  return `BP in range ${share}% \u{00B7} ${word}`;
}

function digestRestingHRLine(hr) {
  if (!hr || hr.status !== 'ok') return '';
  const recent = Math.round(hr.recent_14d_mean);
  const delta = Math.round(hr.delta_from_baseline);
  const deltaWord = delta > 0 ? `${delta} above your baseline`
    : delta < 0 ? `${-delta} below your baseline` : 'at your baseline';
  return `Resting HR ${recent} avg \u{00B7} ${deltaWord}`;
}

function digestBestDayLine(bd) {
  if (!bd) return '';
  const day = DIGEST_WEEKDAYS[new Date(bd.day_unix * 1000).getUTCDay()];
  const plural = bd.rings_closed === 1 ? '' : 's';
  return `Best day: ${day} \u{00B7} ${bd.rings_closed} ring${plural} closed`;
}

export function formatWeeklyDigest(review) {
  if (!review || !review.enabled) return '\u{1F3AE} Gamification is turned off in Settings.';
  if (review.quiet) {
    return '\u{1F5D3} Your week\nA quiet week \u{2014} everything picks up where you left off.';
  }
  const g = review.gauges || {};
  const lines = ['\u{1F5D3} Your week'];
  for (const line of [
    digestScoreLine(review.health_score),
    digestLeverLine(review.levers),
    digestWeightLine(g.weight),
    digestBPLine(g.bp, g.bp_share_30d_prior),
    digestRestingHRLine(g.resting_hr),
    digestBestDayLine(review.best_day),
  ]) {
    if (line !== '') lines.push(line);
  }
  return lines.join('\n');
}

// Next Sunday 19:00 in the given IANA zone, as unix seconds. Mirrors the bot's
// fire gate (weekly_digest.go: now.Weekday()==Sunday && now.Hour()==19). If the
// current Sunday's 19:00 has already passed, rolls to next week.
export const WEEKLY_DIGEST_HOUR = 19;
export function nextWeeklyDigestFireUnix(now, timeZone) {
  const { year, month, day } = localDateParts(now, timeZone);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const daysUntilSunday = (7 - weekday) % 7; // 0 when today is Sunday
  let fireMs = localWallToUtcMs(Date.UTC(year, month - 1, day + daysUntilSunday, WEEKLY_DIGEST_HOUR, 0), timeZone);
  if (fireMs <= now) fireMs = localWallToUtcMs(Date.UTC(year, month - 1, day + daysUntilSunday + 7, WEEKLY_DIGEST_HOUR, 0), timeZone);
  return Math.floor(fireMs / 1000);
}

// computeReminderHorizon is pure: medications/intakes are raw records
// (server field names), timeZone is an IANA string, now is ms epoch, tzPlan
// is the optional active tzplan record (a passthrough, see tzplan.js).
export function computeReminderHorizon({
  medications = [], intakes = [], bps = [], weights = [],
  workoutGroups = [], workoutVariants = [], workoutExercises = [],
  workoutRotations = [], workoutSessions = [],
  timeZone, now, tzPlan, bpStatus = { enabled: false }, weightStatus = { enabled: false },
  workoutStatus = { enabled: false },
} = {}) {
  const meds = medications.filter((m) => !m.deleted && !m.archived);
  const medById = new Map(meds.map((m) => [m.recordId ?? m.id, m]));
  const entries = [];

  // A 7-day reminder horizon needs actual multi-day coverage, which
  // planDosesWithTzPlan alone cannot give (its look-ahead is capped at "today
  // + tomorrow" regardless of window duration) — forecastDosesWithTzPlan is
  // the day-by-day walk that does, shared with medintake.js's upcomingDoses.
  const medsShaped = meds.map((m) => ({ ...m, id: m.recordId ?? m.id }));
  const targets = forecastDosesWithTzPlan({
    medications: medsShaped, timeZone, now, days: FORECAST_DAYS, tzPlan,
  });
  // A dose the user already confirmed early (via trigger-next-intake) or
  // skipped must not resurface as a "Time to take" push. Mirrors the server
  // scheduler's dedup, which skips a normal target already covered by a
  // handled intake (internal/scheduler/medication.go): an exact-slot match
  // plus the symmetric ±minDoseInterval band (same rule as medintake.js's
  // materializeDueDoses / HasIntakeNearScheduledTime), so a schedule edit or
  // tz-plan shift that moves the forecast target near — but not exactly onto —
  // an already-handled intake still suppresses the duplicate push.
  const handledByMed = new Map();
  for (const intake of intakes) {
    if (intake.deleted) continue;
    if (intake.status === 'TAKEN' || intake.status === 'SKIPPED') {
      const list = handledByMed.get(intake.medication_id) || [];
      list.push(Date.parse(intake.scheduled_at));
      handledByMed.set(intake.medication_id, list);
    }
  }
  const isHandled = (t, med) => {
    const handled = handledByMed.get(t.medicationId);
    if (!handled) return false;
    // bandMs === 0 (as_needed / unparseable) collapses to exact-slot equality.
    const bandMs = med ? minDoseIntervalMs(med.schedule, med.tz_shift_policy) : 0;
    return handled.some((ms) => Math.abs(ms - t.scheduledAtMs) <= bandMs);
  };
  const bySlot = new Map();
  for (const t of targets) {
    const med = medById.get(t.medicationId);
    if (isHandled(t, med)) continue;
    const slot = bySlot.get(t.scheduledAtMs) || { names: [], medicationIds: [] };
    slot.names.push(med ? medDisplayName(med) : t.medName);
    // Carry the identity of every med the reminder names for this slot so
    // Confirm can act by identity, not by re-deriving from a time band. Dedupe
    // within a slot (a med can't be named twice for one instant).
    if (t.medicationId != null && !slot.medicationIds.includes(t.medicationId)) slot.medicationIds.push(t.medicationId);
    bySlot.set(t.scheduledAtMs, slot);
  }
  for (const [slotMs, slot] of bySlot) {
    const slotUnix = Math.floor(slotMs / 1000);
    // callback carries the SLOT, not a medication: one Telegram message covers
    // every med due at this instant, so one Confirm tap covers all of them.
    // The relay appends ":confirm"/":snooze" to build the two buttons.
    entries.push({ fireAtUnix: slotUnix, kind: 'medication', text: doseSlotText(slot.names), genericText: GENERIC_DOSE_TEXT, callback: `s:${slotUnix}`, medicationIds: slot.medicationIds });
  }

  // Re-reminders for still-PENDING doses are no longer client-pre-computed. For
  // Telegram delivery the relay owns them server-side (med-eas.74): a med send
  // schedules the next hourly re-fire until ~6h past the slot, so an unconfirmed
  // dose keeps nagging even when the PWA never reopens, and a Confirm/Snooze tap
  // supersedes the chain. Web-push-only delivery has no server-side re-fire —
  // it gets the primary per-slot fire only (the old client loop, which the app
  // rarely rebuilt in practice, is gone). The primary per-slot fire above is all
  // the client emits.

  // BP reminders logic
  const bpMutedUntil = mutedUntil(bpStatus);
  if (bpStatus.enabled) {
    const sortedBPs = [...bps].sort((a, b) => new Date(b.measured_at || b.measuredAt) - new Date(a.measured_at || a.measuredAt));
    const lastBP = sortedBPs[0];
    const lastBPMs = lastBP ? new Date(lastBP.measured_at || lastBP.measuredAt).getTime() : 0;
    const preferredHour = bpStatus.preferred_reminder_hour !== undefined ? bpStatus.preferred_reminder_hour : 20;

    const { year, month, day } = localDateParts(now, timeZone);

    for (let d = 0; d < FORECAST_DAYS; d++) {
      const wallAsUtc = Date.UTC(year, month - 1, day + d, preferredHour, 0);
      const targetMs = localWallToUtcMs(wallAsUtc, timeZone);

      // Fire if no reading within 12h before target, and the target lands
      // outside any active snooze / don't-bug window.
      if (targetMs > now && targetMs > bpMutedUntil && targetMs - lastBPMs > 12 * 60 * 60 * 1000) {
        const fireAtUnix = Math.floor(targetMs / 1000);
        entries.push({ fireAtUnix, kind: 'bp', text: "📊 **Time to measure your blood pressure**\n\nPlease take a moment to measure and record your BP.", genericText: GENERIC_BP_TEXT, callback: `bp:${fireAtUnix}` });
      }
    }
  }

  // Weight reminders logic
  const weightMutedUntil = mutedUntil(weightStatus);
  if (weightStatus.enabled) {
    const sortedWeights = [...weights].sort((a, b) => new Date(b.measured_at || b.measuredAt) - new Date(a.measured_at || a.measuredAt));
    const lastWeight = sortedWeights[0];
    const lastWeightMs = lastWeight ? new Date(lastWeight.measured_at || lastWeight.measuredAt).getTime() : 0;
    const preferredHour = weightStatus.preferred_reminder_hour !== undefined ? weightStatus.preferred_reminder_hour : 9;

    const { year, month, day } = localDateParts(now, timeZone);

    for (let d = 0; d < FORECAST_DAYS; d++) {
      const wallAsUtc = Date.UTC(year, month - 1, day + d, preferredHour, 0);
      const targetMs = localWallToUtcMs(wallAsUtc, timeZone);

      // Fire if no reading within 7 days before target
      // Same mute gate as BP: skip targets inside an active snooze / don't-bug window.
      if (targetMs > now && targetMs > weightMutedUntil && targetMs - lastWeightMs > 7 * 24 * 60 * 60 * 1000) {
        const fireAtUnix = Math.floor(targetMs / 1000);
        entries.push({ fireAtUnix, kind: 'weight', text: "⚖️ **Time to track your weight**\n\nIt's been about a week since your last measurement. Regular tracking helps you stay on top of your goals!", genericText: GENERIC_WEIGHT_TEXT, callback: `wt:${fireAtUnix}` });
      }
    }
  }

  // Low-stock warnings (med-eas.57), ported from internal/scheduler/low_stock.go:
  // the bot fires a daily 11:00-local warning when any med is < 7 days of supply.
  // Gated on the med-reminder enable flag upstream (buildHorizon blanks
  // `medications` when disabled, so `meds` is empty here). No callback (bot has
  // no buttons on this notification).
  {
    const { year, month, day } = localDateParts(now, timeZone);
    for (let d = 0; d < FORECAST_DAYS; d++) {
      const wallAsUtc = Date.UTC(year, month - 1, day + d, LOW_STOCK_HOUR, 0);
      const targetMs = localWallToUtcMs(wallAsUtc, timeZone);
      if (targetMs <= now) continue;
      // listLowOnStock keys off `now` (via end_date proximity), so evaluate at
      // the fire instant rather than the current time.
      const lowMeds = listLowOnStock(meds, targetMs);
      if (lowMeds.length === 0) continue;
      entries.push({
        fireAtUnix: Math.floor(targetMs / 1000),
        kind: 'low_stock',
        text: lowStockText(lowMeds),
        genericText: GENERIC_LOW_STOCK_TEXT,
      });
    }
  }

  // Workout-session reminders (med-eas.59), ported from internal/scheduler/workout.go.
  // Gated on the workout feature flag (workoutStatus.enabled), mirroring the bot's
  // GetWorkoutEnabled gate — the bot has no separate workout-reminder pref.
  // PRIMARY FIRE ONLY: the bot's interactive re-notify(+3h)/auto-skip(+6h)/snooze/
  // stale-90min state machine needs server-observed session state a blind relay
  // can't see, so we emit only the single "workout starting" push — the same
  // accepted limitation as the medication re-reminders above (see the plan).
  if (workoutStatus.enabled) {
    const variants = workoutVariants.filter((v) => !v.deleted);
    const variantById = new Map(variants.map((v) => [v.id, v]));

    const variantsByGroup = new Map();
    for (const v of variants) {
      const list = variantsByGroup.get(v.group_id) || [];
      list.push(v);
      variantsByGroup.set(v.group_id, list);
    }
    // listVariants order: rotation_order asc (999 default), then name — the
    // first variant is the non-rotating group's picked variant.
    for (const list of variantsByGroup.values()) {
      list.sort((a, b) => {
        const ra = a.rotation_order !== null && a.rotation_order !== undefined ? a.rotation_order : 999;
        const rb = b.rotation_order !== null && b.rotation_order !== undefined ? b.rotation_order : 999;
        if (ra !== rb) return ra - rb;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
    }

    const rotationByGroup = new Map();
    for (const r of workoutRotations.filter((r) => !r.deleted)) {
      rotationByGroup.set(r.group_id, r.current_variant_id);
    }

    const exercisesByVariant = new Map();
    for (const e of workoutExercises.filter((e) => !e.deleted)) {
      const list = exercisesByVariant.get(e.variant_id) || [];
      list.push(e);
      exercisesByVariant.set(e.variant_id, list);
    }
    for (const list of exercisesByVariant.values()) {
      list.sort((a, b) => (a.order_index || 0) - (b.order_index || 0));
    }

    // resolveVariantId ports next.go's resolveVariantID: rotation cursor for a
    // rotating group (if present), else the first variant; 0 when none.
    const resolveVariantId = (group) => {
      if (group.is_rotating && rotationByGroup.has(group.id)) return rotationByGroup.get(group.id);
      const vs = variantsByGroup.get(group.id) || [];
      return vs.length > 0 ? vs[0].id : 0;
    };

    const pushWorkout = (fireMs, text, callback) => {
      if (fireMs <= now) return;
      const entry = { fireAtUnix: Math.floor(fireMs / 1000), kind: 'workout', text, genericText: GENERIC_WORKOUT_TEXT };
      // Only recurring group reminders carry a callback stem (`w:<groupId>:<YYYYMMDD>`);
      // ad-hoc reminders stay button-less (non-unique (groupId,date), documented ceiling).
      if (callback) entry.callback = callback;
      entries.push(entry);
    };

    // Schedule-materialized sessions (real group_id, keyed by local day) suppress
    // the primary fire once the user has acted: the bot only notifies a 'pending'
    // session (workout.go step 9), and getNext skips completed/skipped ones. Key
    // by `group_id|YYYY-MM-DD` — the scheduled_date prefix IS the local day.
    const sessionStatusByKey = new Map();
    for (const s of workoutSessions.filter((x) => !x.deleted && x.group_id !== WORKOUT_ADHOC_GROUP_ID)) {
      const p = /^(\d{4}-\d{2}-\d{2})/.exec(String(s.scheduled_date));
      if (p) sessionStatusByKey.set(`${s.group_id}|${p[1]}`, s.status);
    }

    const { year, month, day } = localDateParts(now, timeZone);

    // Recurring groups: every matching-weekday occurrence within the horizon,
    // fired at scheduledInstant - notification_advance_minutes.
    for (const group of workoutGroups.filter((g) => !g.deleted && g.active)) {
      let daysOfWeek;
      try { daysOfWeek = JSON.parse(group.days_of_week); } catch { continue; }
      if (!Array.isArray(daysOfWeek)) continue;
      const variantId = resolveVariantId(group);
      if (!variantId) continue;
      const variant = variantById.get(variantId);
      if (!variant) continue;
      const hhmm = parseHHMM(group.scheduled_time);
      if (!hhmm) continue;
      const advance = group.notification_advance_minutes || 0;
      const text = workoutRecurringText(advance, group.name, variant.name, exercisesByVariant.get(variantId) || []);
      for (let d = 0; d < FORECAST_DAYS; d++) {
        const occ = new Date(Date.UTC(year, month - 1, day + d));
        if (!daysOfWeek.includes(occ.getUTCDay())) continue;
        const dateStr = `${occ.getUTCFullYear()}-${String(occ.getUTCMonth() + 1).padStart(2, '0')}-${String(occ.getUTCDate()).padStart(2, '0')}`;
        const existingStatus = sessionStatusByKey.get(`${group.id}|${dateStr}`);
        if (existingStatus !== undefined && existingStatus !== 'pending') continue;
        const scheduledMs = localWallToUtcMs(Date.UTC(year, month - 1, day + d, hhmm.hour, hhmm.minute), timeZone);
        const callback = `w:${group.id}:${dateStr.replaceAll('-', '')}`;
        pushWorkout(scheduledMs - advance * 60 * 1000, text, callback);
      }
    }

    // Planned ad-hoc sessions (group_id === -1, status 'pending'): a concrete
    // scheduled_date (local midnight rendered as an offset-stamped instant) +
    // scheduled_time. The date prefix IS the local calendar day (scheduledDateRFC,
    // workout.js) — read it as a string, never via UTC parts, which shift the day
    // backward in positive-offset zones. Re-anchor HH:MM to the local wall.
    for (const s of workoutSessions.filter((s) => !s.deleted && s.group_id === WORKOUT_ADHOC_GROUP_ID && s.status === 'pending')) {
      const hhmm = parseHHMM(s.scheduled_time);
      if (!hhmm) continue;
      const datePrefix = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s.scheduled_date));
      if (!datePrefix) continue;
      const scheduledMs = localWallToUtcMs(
        Date.UTC(+datePrefix[1], +datePrefix[2] - 1, +datePrefix[3], hhmm.hour, hhmm.minute),
        timeZone,
      );
      pushWorkout(scheduledMs, WORKOUT_ADHOC_TEXT);
    }
  }

  entries.sort((a, b) => a.fireAtUnix - b.fireAtUnix);
  return entries.slice(0, MAX_HORIZON_ENTRIES);
}

function findSingleton(all, recordId) {
  return all.find((r) => r.recordId === recordId && !r.deleted);
}

// The "s:<slotUnix>" stem computeReminderHorizon puts on every medication entry
// (grouped dose reminders and the relay's re-fires alike). BP/weight/workout
// entries carry a different stem or none, and contribute no slot.
function slotUnixFromCallback(cb) {
  const m = /^s:(\d+)$/.exec(cb || '');
  return m ? Number(m[1]) : null;
}

// slotMedicationsFromEntries collapses a horizon into slotUnix → [medId…],
// deduped within a slot (a re-reminder shares its grouped slot's stem, so its
// single med folds back in).
export function slotMedicationsFromEntries(entries) {
  const slots = {};
  for (const e of entries || []) {
    const slotUnix = slotUnixFromCallback(e.callback);
    if (slotUnix == null || !Array.isArray(e.medicationIds)) continue;
    const ids = slots[slotUnix] || (slots[slotUnix] = []);
    for (const id of e.medicationIds) if (id != null && !ids.includes(id)) ids.push(id);
  }
  return slots;
}

// createRemindersDomain builds the enable/disable preference + horizon-build
// API over the injected ports:
//   records — { list(type), put(type, record), del(type, id) }
//   now()   — current time in ms epoch
// The shim layer reads medication/intake/tzplan records itself and calls
// buildHorizon with them, then uploads the result via web/cloud/js/push.js's
// pushSchedule (see web/cloud/js/reminders.js).
export function createRemindersDomain({ records, now }) {
  async function getStatus() {
    const all = await records.list(REMINDERPREF_RECORD_TYPE);
    const rec = findSingleton(all, REMINDERPREF_RECORD_ID);
    return { enabled: rec ? !!rec.enabled : true };
  }

  async function setEnabled(enabled) {
    await records.put(REMINDERPREF_RECORD_TYPE, {
      recordId: REMINDERPREF_RECORD_ID, clientTs: now(), deleted: false, enabled: !!enabled,
    });
    return getStatus();
  }

  async function getBPStatus() {
    const all = await records.list(BP_REMINDERPREF_RECORD_TYPE);
    const rec = findSingleton(all, BP_REMINDERPREF_RECORD_ID);
    return {
      enabled: rec ? !!rec.enabled : false,
      preferred_reminder_hour: rec && rec.preferred_reminder_hour !== undefined ? rec.preferred_reminder_hour : 20,
      snoozed_until: (rec && rec.snoozed_until) || 0,
      dont_remind_until: (rec && rec.dont_remind_until) || 0,
    };
  }

  // Writing a pref always carries the mute instants forward — a toggle must not
  // silently clear an active snooze, and a snooze must not clear `enabled`.
  async function putBPPref(patch) {
    const current = await getBPStatus();
    await records.put(BP_REMINDERPREF_RECORD_TYPE, {
      recordId: BP_REMINDERPREF_RECORD_ID, clientTs: now(), deleted: false, ...current, ...patch,
    });
    return getBPStatus();
  }

  async function setBPEnabled(enabled, preferred_reminder_hour) {
    const patch = { enabled: !!enabled };
    if (preferred_reminder_hour !== undefined) patch.preferred_reminder_hour = preferred_reminder_hour;
    return putBPPref(patch);
  }

  // Mirrors bp.SnoozeReminder / bp.DontBugMeReminder: mute until an instant,
  // leaving `enabled` alone. computeReminderHorizon then drops every target
  // inside the window, and the caller re-uploads the shortened horizon.
  async function snoozeBPReminder(durationMs = SNOOZE_MS) {
    return putBPPref({ snoozed_until: now() + durationMs });
  }

  async function dontBugBPReminder() {
    return putBPPref({ dont_remind_until: now() + DONT_BUG_MS });
  }

  async function getWeightStatus() {
    const all = await records.list(WEIGHT_REMINDERPREF_RECORD_TYPE);
    const rec = findSingleton(all, WEIGHT_REMINDERPREF_RECORD_ID);
    return {
      enabled: rec ? !!rec.enabled : false,
      preferred_reminder_hour: rec && rec.preferred_reminder_hour !== undefined ? rec.preferred_reminder_hour : 9,
      snoozed_until: (rec && rec.snoozed_until) || 0,
      dont_remind_until: (rec && rec.dont_remind_until) || 0,
    };
  }

  async function putWeightPref(patch) {
    const current = await getWeightStatus();
    await records.put(WEIGHT_REMINDERPREF_RECORD_TYPE, {
      recordId: WEIGHT_REMINDERPREF_RECORD_ID, clientTs: now(), deleted: false, ...current, ...patch,
    });
    return getWeightStatus();
  }

  async function setWeightEnabled(enabled, preferred_reminder_hour) {
    const patch = { enabled: !!enabled };
    if (preferred_reminder_hour !== undefined) patch.preferred_reminder_hour = preferred_reminder_hour;
    return putWeightPref(patch);
  }

  async function snoozeWeightReminder(durationMs = SNOOZE_MS) {
    return putWeightPref({ snoozed_until: now() + durationMs });
  }

  async function dontBugWeightReminder() {
    return putWeightPref({ dont_remind_until: now() + DONT_BUG_MS });
  }

  // Where reminders are delivered, and how much they say. Telegram reminders
  // transit the relay as plaintext, so `verbosity` is the user's control over
  // what leaves the vault: 'generic' (default) sends only "Medication time",
  // 'detailed' is an explicit opt-in that sends medication names. Defaulting to
  // generic keeps names in the vault unless the user chooses otherwise (bd
  // med-yor.13).
  async function getDeliveryPref() {
    const all = await records.list(DELIVERYPREF_RECORD_TYPE);
    const rec = findSingleton(all, DELIVERYPREF_RECORD_ID);
    const delivery = rec && DELIVERY_CHANNELS.includes(rec.delivery) ? rec.delivery : 'webpush';
    const verbosity = rec && VERBOSITIES.includes(rec.verbosity) ? rec.verbosity : 'generic';
    return { delivery, verbosity };
  }

  async function setDeliveryPref({ delivery, verbosity } = {}) {
    const current = await getDeliveryPref();
    const next = {
      delivery: DELIVERY_CHANNELS.includes(delivery) ? delivery : current.delivery,
      verbosity: VERBOSITIES.includes(verbosity) ? verbosity : current.verbosity,
    };
    await records.put(DELIVERYPREF_RECORD_TYPE, {
      recordId: DELIVERYPREF_RECORD_ID, clientTs: now(), deleted: false, ...next,
    });
    return getDeliveryPref();
  }

  // --- slot → named medications (bd med-eas.65) ---
  //
  // The map is NOT replace-all like the relay schedule it accompanies: a slot's
  // entry describes what a message SAID, and a delivered Telegram message stays
  // tappable long after its slot has left the forward horizon. So the shim
  // writes it in two moves around the upload, and only the second one is
  // allowed to go missing:
  //
  //   dropFutureSlotMedications()  BEFORE the schedule PUT
  //   recordSlotMedications(horizon) AFTER it succeeds
  //
  // One record per slot: `slotmeds-<slotUnix>` → { slotUnix, medicationIds }.
  // Per-slot (not the singleton med-eas.65 first shipped) so the two writes
  // around an upload only ever touch the slots they mean: dropFuture tombstones
  // the not-yet-fired slots, record puts the pushed ones, and a FIRED slot's
  // record is never rewritten by either — so a second device that synced the
  // post-drop state and recomputed could not, as the singleton let it, win LWW
  // with a copy that lacked the fired slot (bd med-onzf: that lost slot put the
  // Confirm drain on the mapless path, which never cancels the relay's hourly
  // re-fire, and the user was nagged for 6h after taking every dose).
  function slotRecordId(slotUnix) {
    return `${SLOTMEDS_RECORD_ID_PREFIX}${slotUnix}`;
  }

  async function listSlotRecords() {
    return (await records.list(SLOTMEDS_RECORD_TYPE))
      .filter((r) => !r.deleted && r.recordId.startsWith(SLOTMEDS_RECORD_ID_PREFIX) && Number.isFinite(Number(r.slotUnix)));
  }

  // Tombstones every per-slot record outside [now - retention, now]: the
  // not-yet-fired ones because a stale FUTURE entry is the one dangerous state
  // (the relay serving a reminder that names fewer meds than the map claims,
  // and Confirm marking an unnamed med taken — clearing first turns a lost
  // follow-up write into a mapless slot, the ±band fallback, a false negative);
  // the expired ones to keep the vault bounded. Already-fired slots inside the
  // window are untouched: their messages went out under the schedule that
  // named them and cannot change.
  async function pruneSlotRecords(keepFuture) {
    const nowMs = now();
    for (const r of await listSlotRecords()) {
      const slotMs = Number(r.slotUnix) * 1000;
      const expired = slotMs < nowMs - SLOTMEDS_RETAIN_MS;
      const future = slotMs > nowMs;
      if (expired || (future && !keepFuture)) await records.del(SLOTMEDS_RECORD_TYPE, r.recordId);
    }
  }

  // dropFutureSlotMedications runs BEFORE the new schedule is uploaded.
  async function dropFutureSlotMedications() {
    await pruneSlotRecords(false);
  }

  // recordSlotMedications runs AFTER the upload succeeds: one put per pushed
  // slot. A slot the newest horizon no longer lists keeps its record (its
  // Telegram message is still in the chat, tappable, re-fired for ~6h) until
  // retention expires it. A re-listed slot's record is replaced — it describes
  // the message the relay is serving for it now.
  async function recordSlotMedications(entries) {
    await pruneSlotRecords(true);
    for (const [slotUnix, medicationIds] of Object.entries(slotMedicationsFromEntries(entries))) {
      await records.put(SLOTMEDS_RECORD_TYPE, {
        recordId: slotRecordId(slotUnix), clientTs: now(), deleted: false, slotUnix: Number(slotUnix), medicationIds,
      });
    }
  }

  // getSlotMedications returns the med ids the reminder NAMED for slotUnix, or
  // null when nothing is recorded for it — a reminder pushed before this
  // shipped, or one older than the retention window. inbox-apply then falls
  // back to its fixed ±band match.
  //
  // The age check is repeated HERE, not left to the prune: pruning only happens
  // when a recompute runs, so a device that was closed for a week and drains an
  // old tap on first open would otherwise take the identity path on an entry
  // the design considers expired. Retention is a property of the answer, not
  // of write scheduling.
  //
  // ponytail: the pre-med-onzf singleton (`slotmeds-current`, { slots }) is
  // still read as a fallback so a message pushed before this deploy stays
  // resolvable by identity for its 48h; nothing writes it any more, so it goes
  // inert on its own. Delete this branch once the retention window has passed.
  async function getSlotMedications(slotUnix) {
    if (!(Number(slotUnix) * 1000 >= now() - SLOTMEDS_RETAIN_MS)) return null;
    const all = await records.list(SLOTMEDS_RECORD_TYPE);
    const rec = findSingleton(all, slotRecordId(slotUnix));
    let ids = rec && rec.medicationIds;
    if (!Array.isArray(ids)) {
      const legacy = findSingleton(all, LEGACY_SLOTMEDS_RECORD_ID);
      ids = legacy && legacy.slots && legacy.slots[slotUnix];
    }
    return Array.isArray(ids) && ids.length ? ids : null;
  }

  // buildHorizon returns [] when reminders are disabled — the caller uploads
  // that empty med portion via a replace-all pushSchedule, per the plan's
  // "disabled -> upload empty med portion" rule.
  async function buildHorizon({
    medications, intakes, bps, weights, timeZone, tzPlan,
    workoutGroups = [], workoutVariants = [], workoutExercises = [],
    workoutRotations = [], workoutSessions = [], workoutEnabled = false,
  }) {
    const [{ enabled }, bpStatus, weightStatus] = await Promise.all([
      getStatus(),
      getBPStatus(),
      getWeightStatus(),
    ]);
    const workoutStatus = { enabled: !!workoutEnabled };

    // We compute the horizon for everything enabled. If medication reminders are disabled,
    // we still need to compute BP/Weight reminders if they are enabled.
    // If all are disabled, computeReminderHorizon returns empty arrays anyway based on the statuses.
    let medsToPass = medications;
    let intakesToPass = intakes;
    if (!enabled) {
      medsToPass = [];
      intakesToPass = [];
    }

    return computeReminderHorizon({
      medications: medsToPass,
      intakes: intakesToPass,
      bps,
      weights,
      workoutGroups,
      workoutVariants,
      workoutExercises,
      workoutRotations,
      workoutSessions,
      timeZone,
      now: now(),
      tzPlan,
      bpStatus,
      weightStatus,
      workoutStatus,
    });
  }

  return {
    getStatus, setEnabled, getBPStatus, setBPEnabled, getWeightStatus, setWeightEnabled,
    snoozeBPReminder, dontBugBPReminder, snoozeWeightReminder, dontBugWeightReminder,
    getDeliveryPref, setDeliveryPref, buildHorizon,
    dropFutureSlotMedications, recordSlotMedications, getSlotMedications,
  };
}
