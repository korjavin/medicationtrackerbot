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
import { planDosesWithTzPlan } from './tzplan.js';
import { minDoseIntervalMs } from './medschedule.js';

const REMINDERPREF_RECORD_TYPE = 'medreminderpref';
const REMINDERPREF_RECORD_ID = 'medreminderpref';
const BP_REMINDERPREF_RECORD_TYPE = 'bpreminderpref';
const BP_REMINDERPREF_RECORD_ID = 'bpreminderpref';
const WEIGHT_REMINDERPREF_RECORD_TYPE = 'weightreminderpref';
const WEIGHT_REMINDERPREF_RECORD_ID = 'weightreminderpref';

const DAY_MS = 24 * 60 * 60 * 1000;
const FORECAST_DAYS = 7;
const REREMIND_GRACE_MS = 60 * 60 * 1000; // first re-remind fires 1h past schedule
const REREMIND_INTERVAL_MS = 60 * 60 * 1000; // then hourly, matching medication_reminder.go
// ponytail: bounded per-intake re-remind chain (24h @ hourly) instead of an
// indefinite one — an open device re-runs this on every mutation anyway, and
// a closed device "self-heals" the rest of the chain on its next unlock (see
// the plan's Technical Details, "Reminder fidelity limits").
const MAX_REREMINDS_PER_INTAKE = 24;
// ponytail: hard cap far under the relay's 2000-entry/4KB limit; unrealistic
// to hit with real schedules, guards a pathological edge case only.
const MAX_HORIZON_ENTRIES = 500;

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

// computeReminderHorizon is pure: medications/intakes are raw records
// (server field names), timeZone is an IANA string, now is ms epoch, tzPlan
// is the optional active tzplan record (a passthrough, see tzplan.js).
export function computeReminderHorizon({
  medications = [], intakes = [], bps = [], weights = [],
  timeZone, now, tzPlan, bpStatus = { enabled: false }, weightStatus = { enabled: false },
} = {}) {
  const meds = medications.filter((m) => !m.deleted && !m.archived);
  const medById = new Map(meds.map((m) => [m.recordId ?? m.id, m]));
  const entries = [];

  // medschedule.js's candidateNormalTargets (ported near-verbatim from
  // medplan.go, which every other caller only ever drives with a <=12h
  // window) caps its look-ahead at "today + tomorrow" regardless of the
  // window's duration — every other call site only ever needs a 12h
  // forecast, so that cap was never a limitation. A 7-day reminder horizon
  // needs actual multi-day coverage, so walk one day at a time instead of
  // widening the window, and dedup by (medicationId, scheduledAtMs) since
  // consecutive day-windows overlap by design (each call also re-sees
  // "tomorrow").
  const medsShaped = meds.map((m) => ({ ...m, id: m.recordId ?? m.id }));
  const seenTargets = new Set();
  const targets = [];
  for (let day = 0; day < FORECAST_DAYS; day++) {
    const dayTargets = planDosesWithTzPlan({
      medications: medsShaped,
      timeZone,
      now: now + day * DAY_MS,
      window: DAY_MS,
      tzPlan,
    });
    for (const t of dayTargets) {
      const key = `${t.medicationId}-${t.scheduledAtMs}`;
      if (seenTargets.has(key)) continue;
      seenTargets.add(key);
      targets.push(t);
    }
  }
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
    const list = bySlot.get(t.scheduledAtMs) || [];
    list.push(med ? medDisplayName(med) : t.medName);
    bySlot.set(t.scheduledAtMs, list);
  }
  for (const [slotMs, names] of bySlot) {
    entries.push({ fireAtUnix: Math.floor(slotMs / 1000), text: doseSlotText(names) });
  }

  // Ported from medication_reminder.go's Check: re-remind a still-PENDING
  // intake starting 1h past schedule (or at snooze expiry if later), then
  // hourly, up to MAX_REREMINDS_PER_INTAKE.
  for (const intake of intakes) {
    if (intake.deleted || intake.status !== 'PENDING') continue;
    const med = medById.get(intake.medication_id);
    if (!med) continue;
    const scheduledMs = Date.parse(intake.scheduled_at);
    const snoozedUntilMs = intake.snoozed_until ? Date.parse(intake.snoozed_until) : null;
    let fireMs = snoozedUntilMs !== null ? snoozedUntilMs : scheduledMs + REREMIND_GRACE_MS;
    if (fireMs < now) fireMs = now;
    const text = `\u{1F514} REMINDER: You haven't confirmed taking ${medDisplayName(med)} yet on ${formatHHMM(scheduledMs, timeZone)}!`;
    for (let i = 0; i < MAX_REREMINDS_PER_INTAKE; i++) {
      entries.push({ fireAtUnix: Math.floor(fireMs / 1000), text });
      fireMs += REREMIND_INTERVAL_MS;
    }
  }

  // BP reminders logic
  if (bpStatus.enabled) {
    const sortedBPs = [...bps].sort((a, b) => new Date(b.measured_at || b.measuredAt) - new Date(a.measured_at || a.measuredAt));
    const lastBP = sortedBPs[0];
    const lastBPMs = lastBP ? new Date(lastBP.measured_at || lastBP.measuredAt).getTime() : 0;
    const preferredHour = bpStatus.preferred_reminder_hour !== undefined ? bpStatus.preferred_reminder_hour : 20;

    for (let day = 0; day < FORECAST_DAYS; day++) {
      const targetDate = new Date(now + day * DAY_MS);
      targetDate.setHours(preferredHour, 0, 0, 0);
      const targetMs = targetDate.getTime();

      // Fire if no reading within 12h before target
      if (targetMs > now && targetMs - lastBPMs > 12 * 60 * 60 * 1000) {
        entries.push({ fireAtUnix: Math.floor(targetMs / 1000), text: "📊 **Time to measure your blood pressure**\n\nPlease take a moment to measure and record your BP." });
      }
    }
  }

  // Weight reminders logic
  if (weightStatus.enabled) {
    const sortedWeights = [...weights].sort((a, b) => new Date(b.measured_at || b.measuredAt) - new Date(a.measured_at || a.measuredAt));
    const lastWeight = sortedWeights[0];
    const lastWeightMs = lastWeight ? new Date(lastWeight.measured_at || lastWeight.measuredAt).getTime() : 0;
    const preferredHour = weightStatus.preferred_reminder_hour !== undefined ? weightStatus.preferred_reminder_hour : 9;

    for (let day = 0; day < FORECAST_DAYS; day++) {
      const targetDate = new Date(now + day * DAY_MS);
      targetDate.setHours(preferredHour, 0, 0, 0);
      const targetMs = targetDate.getTime();

      // Fire if no reading within 7 days before target
      if (targetMs > now && targetMs - lastWeightMs > 7 * 24 * 60 * 60 * 1000) {
        entries.push({ fireAtUnix: Math.floor(targetMs / 1000), text: "⚖️ **Time to track your weight**\n\nIt's been about a week since your last measurement. Regular tracking helps you stay on top of your goals!" });
      }
    }
  }

  entries.sort((a, b) => a.fireAtUnix - b.fireAtUnix);
  return entries.slice(0, MAX_HORIZON_ENTRIES);
}

function findSingleton(all, recordId) {
  return all.find((r) => r.recordId === recordId && !r.deleted);
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
      preferred_reminder_hour: rec && rec.preferred_reminder_hour !== undefined ? rec.preferred_reminder_hour : 20
    };
  }

  async function setBPEnabled(enabled, preferred_reminder_hour) {
    const current = await getBPStatus();
    const hour = preferred_reminder_hour !== undefined ? preferred_reminder_hour : current.preferred_reminder_hour;
    await records.put(BP_REMINDERPREF_RECORD_TYPE, {
      recordId: BP_REMINDERPREF_RECORD_ID, clientTs: now(), deleted: false, enabled: !!enabled, preferred_reminder_hour: hour,
    });
    return getBPStatus();
  }

  async function getWeightStatus() {
    const all = await records.list(WEIGHT_REMINDERPREF_RECORD_TYPE);
    const rec = findSingleton(all, WEIGHT_REMINDERPREF_RECORD_ID);
    return {
      enabled: rec ? !!rec.enabled : false,
      preferred_reminder_hour: rec && rec.preferred_reminder_hour !== undefined ? rec.preferred_reminder_hour : 9
    };
  }

  async function setWeightEnabled(enabled, preferred_reminder_hour) {
    const current = await getWeightStatus();
    const hour = preferred_reminder_hour !== undefined ? preferred_reminder_hour : current.preferred_reminder_hour;
    await records.put(WEIGHT_REMINDERPREF_RECORD_TYPE, {
      recordId: WEIGHT_REMINDERPREF_RECORD_ID, clientTs: now(), deleted: false, enabled: !!enabled, preferred_reminder_hour: hour,
    });
    return getWeightStatus();
  }

  // buildHorizon returns [] when reminders are disabled — the caller uploads
  // that empty med portion via a replace-all pushSchedule, per the plan's
  // "disabled -> upload empty med portion" rule.
  async function buildHorizon({
    medications, intakes, bps, weights, timeZone, tzPlan,
  }) {
    const [{ enabled }, bpStatus, weightStatus] = await Promise.all([
      getStatus(),
      getBPStatus(),
      getWeightStatus()
    ]);

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
      timeZone,
      now: now(),
      tzPlan,
      bpStatus,
      weightStatus
    });
  }

  return { getStatus, setEnabled, getBPStatus, setBPEnabled, getWeightStatus, setWeightEnabled, buildHorizon };
}
