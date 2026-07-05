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

const REMINDERPREF_RECORD_TYPE = 'medreminderpref';
const REMINDERPREF_RECORD_ID = 'medreminderpref';

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

function formatHHMM(ms, timeZone) {
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
  medications = [], intakes = [], timeZone, now, tzPlan,
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
  const bySlot = new Map();
  for (const t of targets) {
    const med = medById.get(t.medicationId);
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

  // buildHorizon returns [] when reminders are disabled — the caller uploads
  // that empty med portion via a replace-all pushSchedule, per the plan's
  // "disabled -> upload empty med portion" rule.
  async function buildHorizon({
    medications, intakes, timeZone, tzPlan,
  }) {
    const { enabled } = await getStatus();
    if (!enabled) return [];
    return computeReminderHorizon({
      medications, intakes, timeZone, now: now(), tzPlan,
    });
  }

  return { getStatus, setEnabled, buildHorizon };
}
