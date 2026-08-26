// Runtime-agnostic medication schedule engine. Pure logic, no records port —
// callers (web/domain/medications.js, the shim's materialization timer) pass
// medication objects straight in and get dose targets / stock math back.
// Mirrors internal/domain/medplan/medplan.go (PlanDoses) and the low-stock
// math in internal/store/medication/repo.go:345-434.
//
// Medication objects use server field names: schedule, archived, start_date,
// end_date, created_at (ISO strings or null/undefined), inventory_count
// (number or null = not tracked).

import { offsetMsAt } from './bp.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOW_STOCK_THRESHOLD_DAYS = 7;

// Ported from internal/store/medication/repo.go:73 (ValidSchedule). Legacy
// "HH:MM" strings are daily with one dose; anything else must be the JSON
// ScheduleConfig shape. Returns null on parse failure (caller skips the med).
export function parseSchedule(schedule) {
  if (typeof schedule !== 'string') return null;
  if (schedule.length === 5 && schedule[2] === ':') {
    return { type: 'daily', days: [], times: [schedule] };
  }
  try {
    const parsed = JSON.parse(schedule);
    return {
      type: parsed.type || '',
      days: Array.isArray(parsed.days) ? parsed.days : [],
      times: Array.isArray(parsed.times) ? parsed.times : [],
    };
  } catch {
    return null;
  }
}

// Exported for workout.js's GetNext port (Task 3) — the two-week scheduling
// scan needs the identical local-calendar-day + wall-clock-to-UTC conversion
// this file already uses for dose targets.
export function localDateParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return { year: +map.year, month: +map.month, day: +map.day };
}

// localDateParts plus the wall-clock hour/minute (h23). tzplan.js's step math
// and medintake.js's upcoming-dose forecast both need the full wall-clock
// breakdown in the tracked zone, so it lives here with the rest of the
// zone-conversion helpers instead of being redeclared per module.
export function localDateTimeParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    year: +map.year, month: +map.month, day: +map.day, hour: +map.hour, minute: +map.minute,
  };
}

// Two-pass refine, same technique as bp.js's dayStartMs: guess the offset,
// convert, then re-derive the offset at the guessed instant (handles DST
// transitions landing on the target wall-clock time).
export function localWallToUtcMs(wallAsUtc, timeZone) {
  const guess = wallAsUtc - offsetMsAt(wallAsUtc, timeZone);
  return wallAsUtc - offsetMsAt(guess, timeZone);
}

function weekdayAllowed(weekday, days) {
  return Array.isArray(days) && days.includes(weekday);
}

// "HH:MM" -> {hour, minute}, or null for anything candidateNormalTargets would
// skip. Shared with scheduleYieldsDoses so the two cannot disagree about what
// counts as a usable time entry.
function parseTimeOfDay(ts) {
  if (typeof ts !== 'string' || ts.length !== 5) return null;
  const hour = parseInt(ts.slice(0, 2), 10);
  const minute = parseInt(ts.slice(3, 5), 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return { hour, minute };
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

// window === 0 → fire mode: include only targets at-or-before now.
// window  > 0 → forecast mode: include only targets in (now, now+window].
// Exported so tzplan.js's forecast union (Task 4) applies the identical
// fire/forecast rule to transition-plan steps.
export function targetInWindow(target, now, window) {
  if (window === 0) return target <= now;
  return target > now && target - now <= window;
}

// Ported from internal/domain/medplan/medplan.go:138 (candidateNormalTargets).
function candidateNormalTargets(cfg, timeZone, now, window) {
  if (!cfg || cfg.times.length === 0) return [];
  const { year, month, day } = localDateParts(now, timeZone);
  const endOffset = window > 0 ? 1 : 0;

  const out = [];
  for (let d = 0; d <= endOffset; d++) {
    const dayUtc = new Date(Date.UTC(year, month - 1, day + d));
    if (cfg.type === 'weekly' && !weekdayAllowed(dayUtc.getUTCDay(), cfg.days)) continue;

    for (const ts of cfg.times) {
      const hm = parseTimeOfDay(ts);
      if (!hm) continue;
      const { hour, minute } = hm;

      const wallAsUtc = Date.UTC(dayUtc.getUTCFullYear(), dayUtc.getUTCMonth(), dayUtc.getUTCDate(), hour, minute);
      const target = localWallToUtcMs(wallAsUtc, timeZone);
      if (!targetInWindow(target, now, window)) continue;
      out.push(target);
    }
  }
  return out;
}

// Ported from internal/domain/medplan/medplan.go:75 (PlanDoses).
// medications: array of medication records (server field names).
// timeZone: IANA zone string. now: ms epoch. window: ms, 0 = fire mode.
// Returns dose targets sorted by (scheduledAtMs, medicationId).
export function planDoses({ medications = [], timeZone, now, window = 0 }) {
  const out = [];

  for (const med of medications) {
    if (med.archived) continue;

    const cfg = parseSchedule(med.schedule);
    if (!cfg || cfg.type === 'as_needed') continue;

    const startMs = med.start_date ? Date.parse(med.start_date) : null;
    const endMs = med.end_date ? Date.parse(med.end_date) : null;
    const createdMs = med.created_at ? Date.parse(med.created_at) : 0;

    if (endMs !== null && endMs <= now) continue;
    // The medication-level start gate has to admit a course that begins
    // INSIDE the forecast window, not just one already running: with
    // `startMs > now` a med starting tomorrow morning was skipped outright
    // by the window that contains its first dose, and the next window began
    // after that dose — so it silently vanished from the forecast. The
    // per-target `target < startMs` guard below is what actually enforces the
    // course start. In fire mode (window === 0) this is `startMs > now`,
    // exactly as before.
    if (startMs !== null && startMs > now + window) continue;

    for (const target of candidateNormalTargets(cfg, timeZone, now, window)) {
      if (startMs !== null && target < startMs) continue;
      if (endMs !== null && target > endMs) continue;
      if (target < createdMs) continue;
      out.push({
        medicationId: med.id,
        medName: med.name,
        scheduledAtMs: target,
        source: 'normal_schedule',
      });
    }
  }

  out.sort((a, b) => (a.scheduledAtMs !== b.scheduledAtMs
    ? a.scheduledAtMs - b.scheduledAtMs
    : a.medicationId - b.medicationId));
  return out;
}

// Can this schedule ever produce a dose on some day? Exactly the conditions
// planDoses + candidateNormalTargets apply, over the same parseTimeOfDay and
// weekdayAllowed predicates so the two cannot drift: a schedule that never
// yields a target is one planDoses silently skips forever.
//
// Nothing validates a schedule on the way in — medications.js stores the string
// verbatim — so this has to reject more than just `as_needed`: unparseable
// strings, slotless configs ({"type":"daily","times":[]}), junk time entries
// ({"times":["bad"]}) and weekly configs whose days are all out of range. Note
// an UNKNOWN type is scheduled: candidateNormalTargets only special-cases
// 'weekly', so anything else materializes on the daily path.
//
// Used by medintake.js's adherence fold: a med planDoses skips has no doses to
// miss, so counting its manual logs as adherence invents compliance (med-29gh.1).
// Deliberately independent of start_date/end_date/archived — a finished course's
// past doses were still real scheduled doses.
export function scheduleYieldsDoses(schedule) {
  const cfg = parseSchedule(schedule);
  if (!cfg || cfg.type === 'as_needed') return false;
  if (!cfg.times.some((ts) => parseTimeOfDay(ts) !== null)) return false;
  if (cfg.type === 'weekly') return WEEKDAYS.some((d) => weekdayAllowed(d, cfg.days));
  return true;
}

// Ported from internal/store/medication/repo.go:394 (calculateDailyUsage).
export function calculateDailyUsage(med) {
  const cfg = parseSchedule(med.schedule);
  if (!cfg || cfg.type === 'as_needed') return 0;

  const timesPerDay = cfg.times.length;
  if (cfg.type === 'daily') return timesPerDay;
  if (cfg.type === 'weekly') return (cfg.days.length / 7) * timesPerDay;
  return 0;
}

// Ported from internal/store/medication/repo.go:418 (GetDaysOfStockRemaining).
export function getDaysOfStockRemaining(med) {
  if (med.inventory_count === null || med.inventory_count === undefined) return null;
  const dailyUsage = calculateDailyUsage(med);
  if (dailyUsage === 0) return null;
  return med.inventory_count / dailyUsage;
}

// Ported from internal/store/medication/repo.go:375 (hasEnoughStock).
function hasEnoughStock(med, dailyUsage, daysThreshold, now) {
  if (med.inventory_count === null || med.inventory_count === undefined) return true;
  const daysOfStock = med.inventory_count / dailyUsage;

  if (med.end_date) {
    const daysUntilEnd = (Date.parse(med.end_date) - now) / DAY_MS;
    if (daysUntilEnd <= 0) return true;
    return daysOfStock >= daysUntilEnd;
  }
  return daysOfStock >= daysThreshold;
}

// Ported from internal/store/medication/repo.go:434 (IsLowOnStock).
export function isLowOnStock(med, now, daysThreshold = DEFAULT_LOW_STOCK_THRESHOLD_DAYS) {
  if (med.inventory_count === null || med.inventory_count === undefined) return false;
  const dailyUsage = calculateDailyUsage(med);
  if (dailyUsage === 0) return false;
  return !hasEnoughStock(med, dailyUsage, daysThreshold, now);
}

// Ported from internal/store/medication/repo.go:345 (ListLowOnStock).
export function listLowOnStock(medications, now, daysThreshold = DEFAULT_LOW_STOCK_THRESHOLD_DAYS) {
  return medications.filter((med) => !med.archived && isLowOnStock(med, now, daysThreshold));
}

// Ported from internal/domain/tzreschedule/engine.go:305 (nominalIntervalHours).
// Exported so tzplan.js's step-shift math (Task 4) can share this definition.
export function nominalIntervalHours(cfg) {
  if (!cfg || !Array.isArray(cfg.times) || cfg.times.length === 0) return 24;
  if (cfg.type === 'weekly') {
    const dosesPerWeek = cfg.days.length > 0 ? cfg.days.length * cfg.times.length : cfg.times.length;
    const interval = 168 / dosesPerWeek;
    return interval < 1 ? 1 : interval;
  }
  return 24 / cfg.times.length;
}

// Ported from internal/domain/tzreschedule/policy.go:44 (MinDoseInterval),
// used by medintake.js's due-dose materialization as the ±band dedup replacing
// the server's HasIntakeNearScheduledTime SQL query, and by tzplan.js's step
// generation (Task 4) as the hard minimum gap between transition steps.
// tzShiftPolicy defaults to "flexible" for empty/unknown values, matching
// NormalizePolicy.
const MIN_DOSE_INTERVAL_FACTOR = { strict: 0.70, medium: 0.65, flexible: 0.60 };

export function minDoseIntervalMs(schedule, tzShiftPolicy) {
  const cfg = parseSchedule(schedule);
  if (!cfg || cfg.type === 'as_needed') return 0;
  const hours = nominalIntervalHours(cfg);
  const factor = MIN_DOSE_INTERVAL_FACTOR[tzShiftPolicy] || MIN_DOSE_INTERVAL_FACTOR.flexible;
  return hours * 60 * 60 * 1000 * factor;
}

// Ported from internal/domain/tzreschedule/policy.go:59 (MaxDoseInterval) —
// tzplan.js's step generation (Task 4) hard maximum gap between steps.
const MAX_DOSE_INTERVAL_FACTOR = { strict: 1.50, medium: 1.75, flexible: 2.00 };

export function maxDoseIntervalMs(schedule, tzShiftPolicy) {
  const cfg = parseSchedule(schedule);
  if (!cfg || cfg.type === 'as_needed') return 0;
  const hours = nominalIntervalHours(cfg);
  const factor = MAX_DOSE_INTERVAL_FACTOR[tzShiftPolicy] || MAX_DOSE_INTERVAL_FACTOR.flexible;
  return hours * 60 * 60 * 1000 * factor;
}
