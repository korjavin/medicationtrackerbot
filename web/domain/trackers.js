// User trackers (epic med-1vy5): count + check-off trackers with a
// day/week/month target (atLeast) or limit (atMost). Pure logic over the
// injected records port — no browser globals.
//
// Two record types, no aggregates:
//   - tracker: random recordId; archive = archived:true (logs kept).
//   - trackerlog, count kind: one record per tap, random recordId — a per-day
//     counter record would LWW-lose a tap made on another device, so totals
//     are always summed on read.
//   - trackerlog, check kind: deterministic recordId
//     trackerlog:<trackerId>:<YYYY-MM-DD local>; uncheck writes done:false
//     (same LWW pattern as fooddaystatus).
// Day/period boundaries use the account time zone; week = ISO week.

import { isoWeekKey } from './reminders.js';

const TRACKER = 'tracker';
const LOG = 'trackerlog';
const KINDS = new Set(['count', 'check']);
const OPS = new Set(['atLeast', 'atMost']);
const PERIODS = new Set(['day', 'week', 'month']);
const MAX_NAME_RUNES = 60;
const MAX_HISTORY_DAYS = 366;

function invalid(message) {
  const err = new Error(message);
  err.code = 'invalid_request';
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.code = 'not_found';
  err.status = 404;
  return err;
}

function genId(prefix, nowMs) {
  return `${prefix}-${nowMs}_${Math.random().toString(36).slice(2, 10)}`;
}

// 'YYYY-MM-DD' of an instant in the zone (en-CA yields ISO order).
function localDay(ms, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

function isDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}

function periodKey(day, period) {
  if (period === 'week') return isoWeekKey(day);
  if (period === 'month') return day.slice(0, 7);
  return day;
}

function positive(v, field) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw invalid(`${field} must be > 0`);
  return n;
}

function nonNegative(v, field) {
  const n = Number(v);
  if (v === null || v === '' || !Number.isFinite(n) || n < 0) throw invalid(`${field} must be >= 0`);
  return n;
}

// normalizeTracker validates a full tracker body (create, or update merged
// over the stored one). Returns only the fields the record carries.
function normalizeTracker(input) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw invalid('name is required');
  if ([...name].length > MAX_NAME_RUNES) throw invalid(`name must be at most ${MAX_NAME_RUNES} characters`);
  if (!KINDS.has(input.kind)) throw invalid('kind must be count or check');
  const t = input.target || {};
  if (!OPS.has(t.op)) throw invalid('target.op must be atLeast or atMost');
  if (!PERIODS.has(t.period)) throw invalid('target.period must be day, week or month');
  let reminder = null;
  if (input.reminder) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.reminder.time || '')) throw invalid('reminder.time must be HH:MM');
    reminder = { time: input.reminder.time };
  }
  return {
    name,
    emoji: typeof input.emoji === 'string' ? input.emoji : '',
    kind: input.kind,
    unit: typeof input.unit === 'string' && input.unit.trim() ? input.unit.trim() : null,
    step: input.kind === 'count' ? positive(input.step ?? 1, 'step') : 1,
    // A limit of 0 is valid ("no cola"); a goal of 0 is not.
    target: { op: t.op, value: t.op === 'atMost' ? nonNegative(t.value, 'target.value') : positive(t.value, 'target.value'), period: t.period },
    reminder,
    archived: !!input.archived,
  };
}

function trackerView(r) {
  return {
    id: r.recordId,
    name: r.name,
    emoji: r.emoji,
    kind: r.kind,
    unit: r.unit,
    step: r.step,
    target: r.target,
    reminder: r.reminder,
    archived: !!r.archived,
    createdAt: r.createdAt,
  };
}

function logView(r) {
  return r.date !== undefined
    ? { id: r.recordId, trackerId: r.trackerId, date: r.date, done: !!r.done }
    : { id: r.recordId, trackerId: r.trackerId, at: r.at, amount: r.amount };
}

// trackerDayTotals: Map<'YYYY-MM-DD', total> for one tracker in the zone.
// Count = summed amounts per local day; check = 1 per done day. Exported for
// the habit-strength read in gamification.js.
export function trackerDayTotals(tracker, logs, timeZone) {
  const totals = new Map();
  for (const l of logs) {
    if (l.trackerId !== tracker.recordId) continue;
    if (tracker.kind === 'check') {
      if (l.done === true && isDay(l.date)) totals.set(l.date, 1);
      continue;
    }
    const ms = Date.parse(l.at);
    const amount = Number(l.amount);
    if (Number.isNaN(ms) || !Number.isFinite(amount)) continue;
    const day = localDay(ms, timeZone);
    totals.set(day, (totals.get(day) || 0) + amount);
  }
  return totals;
}

// createTrackersDomain builds the trackers API over the injected ports:
//   records  — { list(type), put(type, record), del(type, id) }
//   now()    — current time in ms epoch
//   timeZone — IANA zone for day/period boundaries
export function createTrackersDomain({ records, now, timeZone }) {
  async function getTracker(id) {
    const rec = (await records.list(TRACKER)).find((r) => r.recordId === id);
    if (!rec) throw notFound('tracker not found');
    return rec;
  }

  const dayTotals = (tracker, logs) => trackerDayTotals(tracker, logs, timeZone);

  function progress(tracker, totals, today) {
    const { op, value, period } = tracker.target;
    const key = periodKey(today, period);
    let total = 0;
    for (const [day, n] of totals) if (periodKey(day, period) === key) total += n;
    // atMost: an empty period (zero logs) is within the limit, so met.
    const met = op === 'atLeast' ? total >= value : total <= value;
    const out = { total, target: value, met };
    if (period === 'week') {
      // Mon..Sun of today's ISO week, for the tile's 7-segment strip.
      const mon = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
      out.days = Array.from({ length: 7 }, (_, i) => {
        const day = addDays(mon, i);
        return { day, total: totals.get(day) || 0 };
      });
    }
    return out;
  }

  // todayLogs: the logs behind today's total, newest first — the Today tile's
  // done state and the log sheet's delete list (count: one per tap; check:
  // today's done entry, if any).
  function todayLogs(tracker, logs, today) {
    return logs
      .filter((l) => l.trackerId === tracker.recordId && (tracker.kind === 'check'
        ? l.done === true && l.date === today
        : !Number.isNaN(Date.parse(l.at)) && localDay(Date.parse(l.at), timeZone) === today))
      .map(logView)
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  }

  async function list() {
    const [trackers, logs] = await Promise.all([records.list(TRACKER), records.list(LOG)]);
    const today = localDay(now(), timeZone);
    return trackers
      .filter((t) => !t.archived)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((t) => ({
        ...trackerView(t),
        progress: progress(t, dayTotals(t, logs), today),
        todayLogs: todayLogs(t, logs, today),
        // The account-local day progress/todayLogs describe, and its zone:
        // a client holding a cached list can tell it went stale at midnight.
        day: today,
        timeZone,
      }));
  }

  async function create(input) {
    const nowMs = now();
    const record = {
      ...normalizeTracker({ ...(input || {}), archived: false }),
      recordId: genId(TRACKER, nowMs),
      clientTs: nowMs,
      deleted: false,
      createdAt: new Date(nowMs).toISOString(),
    };
    await records.put(TRACKER, record);
    return trackerView(record);
  }

  async function update(id, patch) {
    const existing = await getTracker(id);
    if (patch && patch.kind !== undefined && patch.kind !== existing.kind) {
      throw invalid('kind cannot be changed');
    }
    const record = {
      ...existing,
      ...normalizeTracker({ ...existing, ...(patch || {}), kind: existing.kind }),
      clientTs: now(),
    };
    await records.put(TRACKER, record);
    return trackerView(record);
  }

  async function archive(id) {
    const existing = await getTracker(id);
    await records.put(TRACKER, { ...existing, archived: true, clientTs: now() });
  }

  async function setDay(trackerId, date, done) {
    const tracker = await getTracker(trackerId);
    if (tracker.kind !== 'check') throw invalid('only check trackers have done days');
    if (!isDay(date)) throw invalid('date must be YYYY-MM-DD');
    if (typeof done !== 'boolean') throw invalid('done must be a boolean');
    const record = {
      recordId: `${LOG}:${trackerId}:${date}`,
      clientTs: now(),
      deleted: false,
      trackerId,
      date,
      done,
    };
    await records.put(LOG, record);
    return logView(record);
  }

  // resolveTracker: an exact id, else a case-insensitive name match among
  // active trackers — so an agent can "log 2 glasses of water" by name.
  async function resolveTracker(ref) {
    const all = await records.list(TRACKER);
    const byId = all.find((r) => r.recordId === ref);
    if (byId) return byId;
    const name = String(ref).trim().toLowerCase();
    const hits = all.filter((r) => !r.archived && String(r.name).toLowerCase() === name);
    if (hits.length > 1) throw invalid(`more than one tracker is named "${ref}"; use its id`);
    if (!hits.length) throw notFound('tracker not found');
    return hits[0];
  }

  // log: count appends one tap (amount defaults to step, at to now); check
  // marks a date (default today) done. trackerId may also be a tracker name.
  async function log(trackerRef, input = {}) {
    const tracker = await resolveTracker(trackerRef);
    const trackerId = tracker.recordId;
    const nowMs = now();
    if (tracker.kind === 'check') {
      return setDay(trackerId, input.date || localDay(nowMs, timeZone), true);
    }
    const amount = input.amount === undefined ? tracker.step : positive(input.amount, 'amount');
    let at = new Date(nowMs).toISOString();
    if (input.at !== undefined) {
      const ms = Date.parse(input.at);
      if (Number.isNaN(ms)) throw invalid('at must be an ISO timestamp');
      at = new Date(ms).toISOString();
    }
    const record = {
      recordId: genId(LOG, nowMs), clientTs: nowMs, deleted: false, trackerId, at, amount,
    };
    await records.put(LOG, record);
    return logView(record);
  }

  // unlog: count deletes that one tap; check writes done:false for the day
  // the logId names (an uncheck must win LWW, not vanish as a tombstone).
  async function unlog(trackerId, logId) {
    const tracker = await getTracker(trackerId);
    if (tracker.kind === 'check') {
      const prefix = `${LOG}:${trackerId}:`;
      const date = String(logId).startsWith(prefix) ? String(logId).slice(prefix.length) : '';
      if (!isDay(date)) throw notFound('log not found');
      return setDay(trackerId, date, false);
    }
    const logs = await records.list(LOG);
    if (!logs.some((r) => r.recordId === logId && r.trackerId === trackerId)) throw notFound('log not found');
    await records.del(LOG, logId);
    return true;
  }

  // history: per-day totals for the last `days` local days, oldest first.
  async function history(trackerId, days = 30) {
    const tracker = await getTracker(trackerId);
    const n = Math.min(Math.max(Math.floor(Number(days)) || 30, 1), MAX_HISTORY_DAYS);
    const totals = dayTotals(tracker, await records.list(LOG));
    const today = localDay(now(), timeZone);
    const out = [];
    for (let i = n - 1; i >= 0; i -= 1) {
      const date = addDays(today, -i);
      out.push({ date, total: totals.get(date) || 0 });
    }
    return out;
  }

  return { list, create, update, archive, log, unlog, setDay, history };
}
