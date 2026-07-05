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

function localDateParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return { year: +map.year, month: +map.month, day: +map.day };
}

// Two-pass refine, same technique as bp.js's dayStartMs: guess the offset,
// convert, then re-derive the offset at the guessed instant (handles DST
// transitions landing on the target wall-clock time).
function localWallToUtcMs(wallAsUtc, timeZone) {
  const guess = wallAsUtc - offsetMsAt(wallAsUtc, timeZone);
  return wallAsUtc - offsetMsAt(guess, timeZone);
}

function weekdayAllowed(weekday, days) {
  return Array.isArray(days) && days.includes(weekday);
}

// window === 0 → fire mode: include only targets at-or-before now.
// window  > 0 → forecast mode: include only targets in (now, now+window].
function targetInWindow(target, now, window) {
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
      if (typeof ts !== 'string' || ts.length !== 5) continue;
      const hour = parseInt(ts.slice(0, 2), 10);
      const minute = parseInt(ts.slice(3, 5), 10);
      if (Number.isNaN(hour) || Number.isNaN(minute)) continue;

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
    if (startMs !== null && startMs > now) continue;

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
