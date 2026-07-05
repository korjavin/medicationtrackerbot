// Runtime-agnostic blood-pressure domain module. Pure logic over an injected
// records port — no window/document/fetch/IndexedDB — so the same file can
// later run inside the Go server via goja (C6) with a Go-backed records port.
// Mirrors internal/store/bp/repo.go + internal/server/bp_handlers.go.

const RECORD_TYPE = 'bp';
const GOAL_RECORD_TYPE = 'bpgoal';
const GOAL_RECORD_ID = 'bpgoal';
const DAY_MS = 24 * 60 * 60 * 1000;

// Ported verbatim from internal/store/bp/repo.go:95 — identical buckets.
export function calculateBPCategory(systolic, diastolic) {
  if (systolic > 180 || diastolic > 120) return 'Hypertensive Crisis';
  if (systolic >= 140 || diastolic >= 90) return 'High BP Stage 2';
  if (systolic >= 130 || diastolic >= 80) return 'High BP Stage 1';
  if (systolic >= 120 && systolic < 130 && diastolic < 80) return 'Elevated';
  if (systolic < 120 && diastolic < 80) return 'Normal';
  return 'Unknown';
}

// Ported from internal/store/bp/repo.go:116.
export function categorySeverity(category) {
  switch (category) {
    case 'Hypertensive Crisis': return 5;
    case 'High BP Stage 2': return 4;
    case 'High BP Stage 1': return 3;
    case 'Elevated': return 2;
    case 'Normal': return 1;
    default: return 0;
  }
}

// ponytail: DST-at-midnight edge case can be off by the transition delta —
// Intl has no direct "start of local day" primitive. Acceptable for C1
// (single device, same tz); revisit only if a bug report ties to it.
function offsetMsAt(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const wallAsUtc = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return wallAsUtc - ms;
}

function dayStartMs(ms, timeZone) {
  const offset = offsetMsAt(ms, timeZone);
  const wallMidnight = Math.floor((ms + offset) / DAY_MS) * DAY_MS;
  const offset2 = offsetMsAt(wallMidnight - offset, timeZone);
  return wallMidnight - offset2;
}

function resolveCategory(input) {
  let category = input.category || '';
  if (category === '' && !input.ignore_calc) {
    category = calculateBPCategory(input.systolic, input.diastolic);
  }
  return category;
}

function toISOString(v) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  return v;
}

function genId(nowMs) {
  return `bp_${nowMs}_${Math.random().toString(36).slice(2, 10)}`;
}

function toResponse(record) {
  const resp = {
    id: record.recordId,
    measured_at: record.measured_at,
    systolic: record.systolic,
    diastolic: record.diastolic,
    ignore_calc: !!record.ignore_calc,
  };
  if (record.pulse !== null && record.pulse !== undefined) resp.pulse = record.pulse;
  if (record.site) resp.site = record.site;
  if (record.position) resp.position = record.position;
  if (record.category) resp.category = record.category;
  if (record.notes) resp.notes = record.notes;
  if (record.tag) resp.tag = record.tag;
  return resp;
}

function goalResponse(rec) {
  const resp = {};
  if (rec && rec.target_systolic !== null && rec.target_systolic !== undefined) {
    resp.target_systolic = rec.target_systolic;
  }
  if (rec && rec.target_diastolic !== null && rec.target_diastolic !== undefined) {
    resp.target_diastolic = rec.target_diastolic;
  }
  return resp;
}

// Two-stage daily-weighted average, ported from
// internal/store/bp/repo.go:346 (GetDailyWeightedStats). Stage 1: per-day
// time-weighted average (each reading weighted by seconds until the next
// event). Stage 2: equal-weight average of the day-averages over the window.
function buildDailyWeightedStats(bpRecords, nowMs, timeZone) {
  const maxDays = 60;
  const windowStart = dayStartMs(nowMs - maxDays * DAY_MS, timeZone);

  const readings = bpRecords
    .filter((r) => !r.ignore_calc)
    .map((r) => ({ measuredMs: Date.parse(r.measured_at), systolic: r.systolic, diastolic: r.diastolic }))
    .filter((r) => r.measuredMs >= windowStart)
    .sort((a, b) => a.measuredMs - b.measuredMs);

  if (readings.length === 0) return {};

  const dayAggs = new Map(); // dayStartMs -> { sumSys, sumDia, durSec }

  for (let i = 0; i < readings.length; i++) {
    if (i + 1 < readings.length && readings[i + 1].measuredMs === readings[i].measuredMs) continue;
    const start = readings[i].measuredMs;
    if (start > nowMs) continue;

    const dayStart = dayStartMs(start, timeZone);
    let end = dayStart + DAY_MS;
    if (i + 1 < readings.length) {
      const next = readings[i + 1].measuredMs;
      if (dayStartMs(next, timeZone) === dayStart) end = next;
    }
    if (end > nowMs) end = nowMs;
    if (end <= start) continue;

    const durSec = (end - start) / 1000;
    let agg = dayAggs.get(dayStart);
    if (!agg) {
      agg = { sumSys: 0, sumDia: 0, durSec: 0 };
      dayAggs.set(dayStart, agg);
    }
    agg.sumSys += readings[i].systolic * durSec;
    agg.sumDia += readings[i].diastolic * durSec;
    agg.durSec += durSec;
  }

  const todayStart = dayStartMs(nowMs, timeZone);

  function buildPeriod(periodDays) {
    const periodStart = dayStartMs(nowMs - periodDays * DAY_MS, timeZone);
    let sumSys = 0;
    let sumDia = 0;
    let days = 0;
    for (const [day, agg] of dayAggs) {
      if (day < periodStart || day > todayStart || agg.durSec <= 0) continue;
      sumSys += agg.sumSys / agg.durSec;
      sumDia += agg.sumDia / agg.durSec;
      days++;
    }
    if (days === 0) return null;

    let readingsCount = 0;
    for (const r of readings) {
      if (r.measuredMs < periodStart || r.measuredMs > nowMs) continue;
      readingsCount++;
    }

    return {
      systolic: Math.round(sumSys / days),
      diastolic: Math.round(sumDia / days),
      days,
      readings: readingsCount,
    };
  }

  const result = {};
  const s14 = buildPeriod(14);
  const s30 = buildPeriod(30);
  const s60 = buildPeriod(60);
  if (s14) result.stats_14 = s14;
  if (s30) result.stats_30 = s30;
  if (s60) result.stats_60 = s60;
  return result;
}

// createBPDomain builds the BP domain API over the injected ports:
//   records — { list(type), put(type, record), del(type, id) }
//   now()   — current time in ms epoch
//   timeZone — IANA zone string for day-boundary calculations
export function createBPDomain({ records, now, timeZone }) {
  async function create(input) {
    const nowMs = now();
    const record = {
      recordId: genId(nowMs),
      clientTs: nowMs,
      deleted: false,
      measured_at: toISOString(input.measured_at),
      systolic: input.systolic,
      diastolic: input.diastolic,
      pulse: input.pulse ?? null,
      site: input.site || '',
      position: input.position || '',
      category: resolveCategory(input),
      ignore_calc: !!input.ignore_calc,
      notes: input.notes || '',
      tag: input.tag || '',
    };
    await records.put(RECORD_TYPE, record);
    return toResponse(record);
  }

  async function list({ days = 30, limit = 100 } = {}) {
    const since = days > 0 ? now() - days * DAY_MS : 0;
    const all = await records.list(RECORD_TYPE);
    const filtered = all
      .filter((r) => !since || Date.parse(r.measured_at) >= since)
      .sort((a, b) => Date.parse(b.measured_at) - Date.parse(a.measured_at));
    const limited = limit > 0 ? filtered.slice(0, limit) : filtered;
    return limited.map(toResponse);
  }

  async function remove(id) {
    const all = await records.list(RECORD_TYPE);
    if (!all.some((r) => r.recordId === id)) {
      const err = new Error('reading not found');
      err.code = 'not_found';
      throw err;
    }
    await records.del(RECORD_TYPE, id);
  }

  async function getGoal() {
    const all = await records.list(GOAL_RECORD_TYPE);
    return goalResponse(all.find((r) => r.recordId === GOAL_RECORD_ID));
  }

  async function setGoal(goal) {
    const body = {
      target_systolic: goal.target_systolic ?? null,
      target_diastolic: goal.target_diastolic ?? null,
    };
    await records.put(GOAL_RECORD_TYPE, { recordId: GOAL_RECORD_ID, clientTs: now(), deleted: false, ...body });
    return goalResponse(body);
  }

  async function getStats() {
    const all = await records.list(RECORD_TYPE);
    return buildDailyWeightedStats(all, now(), timeZone);
  }

  return { create, list, remove, getGoal, setGoal, getStats };
}
