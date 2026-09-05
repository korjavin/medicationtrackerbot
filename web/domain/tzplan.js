// Runtime-agnostic timezone-transition domain module. Pure planner math
// (generatePlan/planDosesWithTzPlan) plus a records-port-backed lifecycle —
// no window/document/fetch/IndexedDB — so the same file can later run inside
// the Go server via goja (C6). Mirrors internal/domain/tzreschedule/
// engine.go + policy.go (GeneratePlan/stepsForMedication, shift caps) and the
// cross-transport tzsuggestion.Service (ShouldPrompt/RecordDismissal) +
// tzupdate.Service (UpdateTimezone) decisions, simplified per the C2b plan:
//
//   - No OldTZ-pinning, no notifier gating, no per-plan mutex: this client
//     is single-user/single-writer, so the multi-transport races those
//     mechanisms guard against cannot happen here.
//   - One tzplan record IS the plan: `steps` live inline (recordId
//     'tzplan-current', a singleton — creating a new plan simply overwrites
//     it, which is exactly the "cancel any active plan" semantics for free).
//     Nothing is pre-materialized into intake records; PlanDoses callers
//     union the plan's own steps in at read time (planDosesWithTzPlan below).
//   - Flexible-policy medications need no plan at all: GeneratePlan skips
//     them entirely (a single clock-slot jump is exactly what recomputing
//     PlanDoses under the new timeZone already produces), so
//     proposeTimezoneChange only ever stages a plan for medium/strict meds.
//
// Record type: tzplan — old_tz, new_tz, status
// (PENDING_APPROVAL|APPROVED|REJECTED|COMPLETED), steps (array of
// {medicationId, medName, stepNumber, totalSteps, scheduledAtMs, note}),
// created_at, approved_at. Wire responses convert to the banner's snake_case
// shape (medication_id, step_number, scheduled_at) — see toStepsResponse.
import {
  parseSchedule, planDoses, targetInWindow, nominalIntervalHours, minDoseIntervalMs, maxDoseIntervalMs,
  localDateTimeParts,
} from './medschedule.js';
import { offsetMsAt } from './bp.js';
import { createSettingsDomain } from './settings.js';

const TZPLAN_RECORD_TYPE = 'tzplan';
const TZPLAN_RECORD_ID = 'tzplan-current';
const MEDICATION_RECORD_TYPE = 'medication';
const INTAKE_RECORD_TYPE = 'intake';

const MAX_SHIFT_PER_DOSE_MS = { strict: 2 * 60 * 60 * 1000, medium: 3 * 60 * 60 * 1000 };
const DAY_MS = 24 * 60 * 60 * 1000;

function notFound(message) {
  const err = new Error(message);
  err.code = 'not_found';
  return err;
}

// Ported from internal/domain/tzreschedule/policy.go:17 (NormalizePolicy) —
// unlike medications.js's normalizeTzPolicy (which validates and throws),
// this silently defaults unknown/empty values, matching the Go engine.
function normalizeTzShiftPolicy(raw) {
  return raw === 'medium' || raw === 'strict' ? raw : 'flexible';
}

function lastTakenAtMs(medId, intakes) {
  let max = null;
  for (const i of intakes) {
    if (i.deleted || i.medication_id !== medId || i.status !== 'TAKEN' || !i.taken_at) continue;
    const t = Date.parse(i.taken_at);
    if (max === null || t > max) max = t;
  }
  return max;
}

// Same two-pass DST refine as medschedule.js's localWallToUtcMs.
function localWallToUtcMs(wallAsUtc, timeZone) {
  const guess = wallAsUtc - offsetMsAt(wallAsUtc, timeZone);
  return wallAsUtc - offsetMsAt(guess, timeZone);
}

function slotAt(year, month, day, hour, minute, timeZone) {
  return localWallToUtcMs(Date.UTC(year, month - 1, day, hour, minute), timeZone);
}

function weekdayInZone(ms, timeZone) {
  const p = localDateTimeParts(ms, timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

function parseTimeStr(ts) {
  if (typeof ts !== 'string' || ts.length !== 5) return null;
  const hour = parseInt(ts.slice(0, 2), 10);
  const minute = parseInt(ts.slice(3, 5), 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return { hour, minute };
}

function formatLocal(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).formatToParts(new Date(ms));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.hour}:${map.minute} ${map.timeZoneName || ''}`.trim();
}

// Ported from internal/domain/tzreschedule/engine.go:458 (buildNote).
function buildNote(medName, policy, stepIdx, totalSteps, atMs, oldTz, newTz) {
  const policyLabel = policy === 'strict' ? 'strict — gradual shift' : 'medium';
  return `${medName} (${policyLabel}): step ${stepIdx}/${totalSteps} — ${formatLocal(atMs, oldTz)} old / ${formatLocal(atMs, newTz)} new`;
}

// Ported from internal/domain/tzreschedule/engine.go:286 (partialShift).
function partialShiftMs(totalDeltaMs, stepIdx, numSteps) {
  if (numSteps === 0) return 0;
  return -Math.trunc((totalDeltaMs * stepIdx) / numSteps);
}

// Ported from internal/domain/tzreschedule/engine.go:438 (nextAllowedWeekday):
// advance candidateMs in whole-day increments (same wall clock) until its
// weekday-in-newTz is one of `days`.
function nextAllowedWeekdaySlot(candidateMs, days, newTz, parsed) {
  if (!days || days.length === 0) return candidateMs;
  const wd = weekdayInZone(candidateMs, newTz);
  let minOffset = 8;
  for (const d of days) {
    const offset = (d - wd + 7) % 7;
    if (offset < minOffset) minOffset = offset;
  }
  if (minOffset === 0 || minOffset === 8) return candidateMs;
  const p = localDateTimeParts(candidateMs, newTz);
  return slotAt(p.year, p.month, p.day + minOffset, parsed.hour, parsed.minute, newTz);
}

// Ported from internal/domain/tzreschedule/engine.go:411 (firstNormalDoseAfter).
function firstNormalDoseAfter(tMs, cfg, newTz) {
  const p = localDateTimeParts(tMs, newTz);
  let earliest = null;
  for (const ts of cfg.times) {
    const parsed = parseTimeStr(ts);
    if (!parsed) continue;
    let candidate = slotAt(p.year, p.month, p.day, parsed.hour, parsed.minute, newTz);
    if (candidate <= tMs) candidate = slotAt(p.year, p.month, p.day + 1, parsed.hour, parsed.minute, newTz);
    if (cfg.type === 'weekly' && cfg.days && cfg.days.length > 0) {
      candidate = nextAllowedWeekdaySlot(candidate, cfg.days, newTz, parsed);
    }
    if (earliest === null || candidate < earliest) earliest = candidate;
  }
  return earliest;
}

// Ported from internal/domain/tzreschedule/engine.go:336 (snapLastStepToClock):
// pick the newTz clock-slot inside [prevStepMs+minInterval, +maxInterval]
// closest to proposedMs, tie-breaking toward the later slot. Returns null
// when no slot fits the safe window.
function snapLastStepToClock(proposedMs, prevStepMs, cfg, newTz, minIntervalMs, maxIntervalMs) {
  if (!cfg || !cfg.times || cfg.times.length === 0) return null;
  const earliest = prevStepMs + minIntervalMs;
  const latest = prevStepMs + maxIntervalMs;
  if (latest <= earliest) return null;

  let best = null;
  let bestDist = null;
  function consider(target) {
    if (target < earliest || target > latest) return;
    const dist = Math.abs(target - proposedMs);
    if (best === null || dist < bestDist || (dist === bestDist && target > best)) {
      best = target;
      bestDist = dist;
    }
  }

  const p = localDateTimeParts(proposedMs, newTz);
  for (let d = -2; d <= 2; d++) {
    const day = { year: p.year, month: p.month, day: p.day + d };
    if (cfg.type === 'weekly' && cfg.days && cfg.days.length > 0) {
      const wd = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
      if (!cfg.days.includes(wd)) continue;
    }
    for (const ts of cfg.times) {
      const parsed = parseTimeStr(ts);
      if (!parsed) continue;
      consider(slotAt(day.year, day.month, day.day, parsed.hour, parsed.minute, newTz));
    }
  }
  return best;
}

// Ported from internal/domain/tzreschedule/engine.go:131 (stepsForMedication).
function stepsForMedication(med, cfg, policy, offsetDeltaMs, oldTz, newTz, anchorMs) {
  const intervalHours = nominalIntervalHours(cfg);
  const maxShiftAllowedMs = MAX_SHIFT_PER_DOSE_MS[policy];
  const minIntervalMs = minDoseIntervalMs(med.schedule, policy);
  const maxIntervalMs = maxDoseIntervalMs(med.schedule, policy);
  const medId = med.recordId ?? med.id;

  const numSteps = Math.ceil(Math.abs(offsetDeltaMs) / maxShiftAllowedMs);
  if (numSteps === 0) return [];

  const steps = [];
  let prevTimeMs = anchorMs;
  for (let i = 1; i <= numSteps; i++) {
    let proposedMs = anchorMs + i * intervalHours * 60 * 60 * 1000 + partialShiftMs(offsetDeltaMs, i, numSteps);
    const gap = proposedMs - prevTimeMs;
    if (gap < minIntervalMs) proposedMs = prevTimeMs + minIntervalMs;
    else if (gap > maxIntervalMs) proposedMs = prevTimeMs + maxIntervalMs;

    steps.push({
      medicationId: medId,
      medName: med.name,
      stepNumber: i,
      totalSteps: numSteps,
      scheduledAtMs: proposedMs,
      note: buildNote(med.name, policy, i, numSteps, proposedMs, oldTz, newTz),
    });
    prevTimeMs = proposedMs;
  }

  // Snap the last step onto a real clock slot in newTz (see engine.go's
  // rationale: only the final step should land exactly on a schedule slot;
  // intermediate steps intentionally drift as the gradual shift).
  const lastIdx = steps.length - 1;
  const prevStepMs = steps.length > 1 ? steps[steps.length - 2].scheduledAtMs : anchorMs;
  const snapped = snapLastStepToClock(prevTimeMs, prevStepMs, cfg, newTz, minIntervalMs, maxIntervalMs);
  if (snapped !== null && snapped !== steps[lastIdx].scheduledAtMs) {
    steps[lastIdx].scheduledAtMs = snapped;
    steps[lastIdx].note = buildNote(med.name, policy, steps[lastIdx].stepNumber, steps[lastIdx].totalSteps, snapped, oldTz, newTz);
    prevTimeMs = snapped;
  }

  // Hand-off guard: if the gap from the (possibly snapped) last step to the
  // first normal new-tz dose is too tight, pull the last step earlier.
  const nextNormalMs = firstNormalDoseAfter(prevTimeMs, cfg, newTz);
  if (nextNormalMs !== null) {
    const handoffGap = nextNormalMs - prevTimeMs;
    if (handoffGap < minIntervalMs) {
      const adjustedMs = nextNormalMs - minIntervalMs;
      const priorStepMs = steps.length > 1 ? steps[steps.length - 2].scheduledAtMs : anchorMs;
      if (adjustedMs > priorStepMs && adjustedMs - priorStepMs >= minIntervalMs) {
        steps[lastIdx].scheduledAtMs = adjustedMs;
        steps[lastIdx].note = buildNote(med.name, policy, steps[lastIdx].stepNumber, steps[lastIdx].totalSteps, adjustedMs, oldTz, newTz);
      } else {
        steps[lastIdx].note += '; review manually: gap to first normal dose may be too short';
      }
    }
  }

  return steps;
}

// Ported from internal/domain/tzreschedule/engine.go:48 (GeneratePlan), with
// the flexible-policy branch dropped (see module header): pure, deterministic,
// no I/O. `recentIntakes` is the full intake array (medications.js/
// medintake.js style) — the anchor for each med is its last actual TAKEN
// intake, falling back to now-interval when none exists.
export function generatePlan({
  medications = [], oldTz, newTz, now, recentIntakes = [],
}) {
  const offsetDeltaMs = offsetMsAt(now, newTz) - offsetMsAt(now, oldTz);
  if (offsetDeltaMs === 0) return { steps: [], direction: 'no-change', offsetDeltaMs: 0 };
  const direction = offsetDeltaMs > 0 ? 'eastbound' : 'westbound';

  const steps = [];
  for (const med of medications) {
    if (med.archived) continue;
    const endMs = med.end_date ? Date.parse(med.end_date) : null;
    const startMs = med.start_date ? Date.parse(med.start_date) : null;
    if (endMs !== null && endMs <= now) continue;
    if (startMs !== null && startMs > now) continue;

    const cfg = parseSchedule(med.schedule);
    if (!cfg || cfg.type === 'as_needed') continue;
    if (!cfg.times || cfg.times.length === 0) continue;

    // Flexible needs no plan: a single clock-slot jump is exactly what
    // recomputing PlanDoses under the new timeZone already produces.
    const policy = normalizeTzShiftPolicy(med.tz_shift_policy);
    if (policy === 'flexible') continue;

    const medId = med.recordId ?? med.id;
    const anchorMs = lastTakenAtMs(medId, recentIntakes) ?? (now - nominalIntervalHours(cfg) * 60 * 60 * 1000);
    steps.push(...stepsForMedication(med, cfg, policy, offsetDeltaMs, oldTz, newTz, anchorMs));
  }

  steps.sort((a, b) => (a.scheduledAtMs !== b.scheduledAtMs
    ? a.scheduledAtMs - b.scheduledAtMs
    : a.medicationId - b.medicationId));
  return { steps, direction, offsetDeltaMs };
}

// planDosesWithTzPlan composes medschedule.js's planDoses with an APPROVED
// tz transition plan: unions in the plan's own due/forecast steps and drops
// a medication's normal-schedule targets only while that med is still mid-
// transition — mirroring the server's MedsWithFuturePendingTZStepsForPlan
// gate. Keying the suppression on every med in the plan instead would keep an
// early-finishing med's normal doses suppressed until the whole plan flips
// COMPLETED (the last step of any med), silently dropping that med's doses
// mid-plan. `tzPlan` is the raw stored record (or null/non-APPROVED, in which
// case this is a pure passthrough).
//
// "Mid-transition" is judged per TARGET, not once against `now`: a target is
// inside the transition when the med still has a step at or after it. The two
// rules agree in fire mode (every target is <= now, so any future step covers
// them all), but in a forecast the once-against-`now` version dropped normal
// doses that land AFTER the last step — the very doses materializeDueDoses
// will happily create when that instant arrives, so the forecast under-
// reported reality and the reminder horizon skipped a real dose. The plan
// generator's hand-off guard (stepsForMedication → firstNormalDoseAfter) is
// what keeps the gap between the last step and that resuming dose safe.
export function planDosesWithTzPlan({
  medications, timeZone, now, window = 0, tzPlan,
}) {
  const base = planDoses({
    medications, timeZone, now, window,
  });
  if (!tzPlan || tzPlan.status !== 'APPROVED' || !Array.isArray(tzPlan.steps) || tzPlan.steps.length === 0) {
    return base;
  }

  // medicationId -> the instant its transition finishes (its last still-future
  // step). A med whose every step is already behind us is not in the map, so
  // it is not suppressed at all.
  const transitionEndsAt = new Map();
  for (const s of tzPlan.steps) {
    if (!(s.scheduledAtMs > now)) continue;
    const prev = transitionEndsAt.get(s.medicationId);
    if (prev === undefined || s.scheduledAtMs > prev) transitionEndsAt.set(s.medicationId, s.scheduledAtMs);
  }
  // stepNumber/totalSteps/note ride along so a forecast consumer can say WHICH
  // transition step a dose is and show buildNote's human-readable explanation
  // (medintake.js's upcomingDoses → the Meds Schedule tab's Upcoming list).
  // Every other consumer reads only medicationId/scheduledAtMs/source.
  const stepTargets = tzPlan.steps
    .filter((s) => targetInWindow(s.scheduledAtMs, now, window))
    .map((s) => ({
      medicationId: s.medicationId,
      medName: s.medName,
      scheduledAtMs: s.scheduledAtMs,
      source: 'tz_step',
      stepNumber: s.stepNumber,
      totalSteps: s.totalSteps,
      note: s.note,
    }));

  const merged = base.filter((t) => {
    const endsAt = transitionEndsAt.get(t.medicationId);
    return endsAt === undefined || t.scheduledAtMs > endsAt;
  }).concat(stepTargets);
  merged.sort((a, b) => (a.scheduledAtMs !== b.scheduledAtMs
    ? a.scheduledAtMs - b.scheduledAtMs
    : a.medicationId - b.medicationId));
  return merged;
}

// forecastDosesWithTzPlan is planDosesWithTzPlan over a multi-DAY horizon.
// Two reasons it walks day-by-day instead of just widening `window`:
//   1. medschedule.js's candidateNormalTargets (ported from medplan.go) caps
//      its look-ahead at "today + tomorrow" regardless of the window duration,
//      so a wide window silently returns <=2 days of normal doses.
//   2. The tz-plan suppression is keyed on "this med still has a FUTURE step",
//      evaluated against `now`. Re-evaluating it per day is what lets a
//      medication resume its normal schedule the day after its last transition
//      step, instead of staying suppressed for the whole horizon.
// Day windows are disjoint ((now, now+24h], (now+24h, now+48h], …) so the
// concatenation is already ascending; the dedupe is a cheap belt-and-braces
// against a step landing on a boundary twice. Extracted from reminders.js's
// computeReminderHorizon, which drove the identical loop.
export function forecastDosesWithTzPlan({
  medications = [], timeZone, now, days = 7, tzPlan,
} = {}) {
  const seen = new Set();
  const out = [];
  for (let day = 0; day < days; day++) {
    const dayTargets = planDosesWithTzPlan({
      medications, timeZone, now: now + day * DAY_MS, window: DAY_MS, tzPlan,
    });
    for (const t of dayTargets) {
      const key = `${t.medicationId}-${t.scheduledAtMs}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

function toPlanResponse(rec) {
  if (!rec) return null;
  return {
    id: rec.recordId, old_tz: rec.old_tz, new_tz: rec.new_tz, status: rec.status, created_at: rec.created_at,
  };
}

function toStepsResponse(rec) {
  if (!rec || !Array.isArray(rec.steps)) return [];
  return rec.steps.map((s) => ({
    medication_id: s.medicationId,
    // med_name is additive over the Go wire shape (uiTZPlanStep omits it) and
    // matches the vault-format field name; the in-progress banner labels the
    // next shifted dose with it. Consumers must tolerate its absence.
    med_name: s.medName,
    step_number: s.stepNumber,
    scheduled_at: new Date(s.scheduledAtMs).toISOString(),
    note: s.note,
  }));
}

// createTzPlanDomain builds the TZ-suggestion + plan-lifecycle API over the
// injected ports:
//   records — { list(type), put(type, record), del(type, id) }
//   now()   — current time in ms epoch
//   timeZone — IANA zone string (settings.js's fallback default)
export function createTzPlanDomain({ records, now, timeZone }) {
  const settings = createSettingsDomain({ records, now, timeZone });

  async function loadMeds() {
    const all = await records.list(MEDICATION_RECORD_TYPE);
    return all.filter((m) => !m.deleted);
  }
  async function loadIntakes() {
    const all = await records.list(INTAKE_RECORD_TYPE);
    return all.filter((i) => !i.deleted);
  }
  async function getPlanRecord() {
    const all = await records.list(TZPLAN_RECORD_TYPE);
    return all.find((r) => r.recordId === TZPLAN_RECORD_ID && !r.deleted) || null;
  }
  async function putPlanRecord(rec) {
    await records.put(TZPLAN_RECORD_TYPE, rec);
  }

  // Ported from tzsuggestion.Service.ShouldPrompt.
  async function shouldPromptSuggestion(detectedTz) {
    if (!detectedTz) return { prompt: false, reason: 'empty detected timezone' };
    const general = await settings.getGeneral();
    if (general.timezone === detectedTz) return { prompt: false, reason: 'detected timezone matches stored timezone' };
    if (general.dismissed_tz_suggestion && general.dismissed_tz_suggestion === detectedTz) {
      return { prompt: false, reason: 'user already dismissed this detected timezone' };
    }
    const plan = await getPlanRecord();
    if (plan && (plan.status === 'PENDING_APPROVAL' || plan.status === 'APPROVED') && plan.new_tz === detectedTz) {
      return { prompt: false, reason: 'active transition plan already targets this timezone' };
    }
    return { prompt: true, reason: '' };
  }

  // Ported from tzsuggestion.Service.RecordDismissal.
  async function recordDismissal(detectedTz) {
    if (!detectedTz) {
      const err = new Error('detected timezone is required');
      err.code = 'invalid_timezone';
      throw err;
    }
    await settings.setDismissedTzSuggestion(detectedTz);
    return { status: 'dismissed' };
  }

  // Ported from tzupdate.Service.UpdateTimezone, minus the multi-transport
  // mutex/notifier gating (see module header): generate a plan; if no
  // medium/strict medication needs gradual steps, apply the timezone right
  // away (matches the "flexible needs no plan" simplification). Otherwise
  // stage a PENDING_APPROVAL plan and defer the timezone write to
  // approvePlan — the banner surfaces it for the user to Apply/Cancel.
  async function proposeTimezoneChange(newTz) {
    const general = await settings.getGeneral();
    const oldTz = general.timezone;
    if (oldTz === newTz) return { changed: false, planCreated: false };

    const nowMs = now();
    const meds = await loadMeds();
    const intakes = await loadIntakes();
    const { steps } = generatePlan({
      medications: meds, oldTz, newTz, now: nowMs, recentIntakes: intakes,
    });

    if (steps.length === 0) {
      await settings.setTimezone(newTz);
      return { changed: true, planCreated: false };
    }

    const createdAt = new Date(nowMs).toISOString();
    await putPlanRecord({
      recordId: TZPLAN_RECORD_ID,
      clientTs: nowMs,
      deleted: false,
      old_tz: oldTz,
      new_tz: newTz,
      status: 'PENDING_APPROVAL',
      steps,
      created_at: createdAt,
    });
    return {
      changed: false,
      planCreated: true,
      plan: toPlanResponse({
        recordId: TZPLAN_RECORD_ID, old_tz: oldTz, new_tz: newTz, status: 'PENDING_APPROVAL', created_at: createdAt,
      }),
    };
  }

  // approve → status APPROVED + settings.timezone updated to new_tz (the
  // timezone write server-side happens at UpdateTimezone time; here it's
  // deferred to this call since the client never pins an OldTZ in between).
  async function approvePlan() {
    const plan = await getPlanRecord();
    if (!plan || plan.status !== 'PENDING_APPROVAL') throw notFound('no pending transition plan');
    const nowMs = now();
    await putPlanRecord({
      ...plan, clientTs: nowMs, status: 'APPROVED', approved_at: new Date(nowMs).toISOString(),
    });
    await settings.setTimezone(plan.new_tz);
    return { status: 'approved' };
  }

  // reject → status REJECTED, timezone reverted to old_tz (a no-op if it was
  // never applied, which is always true in this client — see approvePlan).
  async function rejectPlan() {
    const plan = await getPlanRecord();
    if (!plan || plan.status !== 'PENDING_APPROVAL') throw notFound('no pending transition plan');
    const nowMs = now();
    await putPlanRecord({ ...plan, clientTs: nowMs, status: 'REJECTED' });
    await settings.setTimezone(plan.old_tz);
    return { status: 'rejected' };
  }

  // Ported from handleGetCurrentTZPlan (GET /api/tz-plan/current).
  async function getCurrentPlan() {
    const plan = await getPlanRecord();
    return { plan: toPlanResponse(plan), steps: toStepsResponse(plan) };
  }

  // Flips an APPROVED plan to COMPLETED once every step is in the past.
  // Called by the shim's materialization timer alongside medintake's
  // due-dose sweep (Task 5 wiring) — this module has no timer of its own.
  async function refreshPlanStatus() {
    const plan = await getPlanRecord();
    if (!plan || plan.status !== 'APPROVED') return;
    const nowMs = now();
    const hasFuture = Array.isArray(plan.steps) && plan.steps.some((s) => s.scheduledAtMs > nowMs);
    if (!hasFuture) {
      // clientTs 0, not nowMs: a timer-side transition on the singleton plan,
      // written from a read that may be stale (bd med-y4ue). The floor is
      // promoted to `existing.clientTs + 1` by the write path, so completing
      // the plan beats exactly the APPROVED record this device saw and loses
      // to a newer PENDING_APPROVAL another device staged in the meantime —
      // which used to be overwritten straight to COMPLETED.
      await putPlanRecord({ ...plan, clientTs: 0, status: 'COMPLETED' });
    }
  }

  return {
    shouldPromptSuggestion,
    recordDismissal,
    proposeTimezoneChange,
    approvePlan,
    rejectPlan,
    getCurrentPlan,
    refreshPlanStatus,
  };
}
