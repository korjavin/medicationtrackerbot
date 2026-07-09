// Runtime-agnostic Vitals domain module. Pure logic over an injected
// records port — no window/document/fetch/IndexedDB — so the same file can
// later run inside the Go server via goja (C6) with a Go-backed records port.
// Mirrors internal/server/health_handlers.go (handleGetHealthOverview,
// handleListSleepLogs) + internal/store/vitals/repo.go.
//
// Record shapes (C2e import targets — no cloud ingestion path yet, so these
// lists are normally empty until the migration importer lands):
//   'sleep'    — one record per sleep session (store.SleepLog fields verbatim:
//                start_time, end_time, timezone_offset, day, light_minutes,
//                deep_minutes, rem_minutes, awake_minutes, total_minutes,
//                turn_over_count, heart_rate_avg, spo2_avg, user_modified, notes)
//   'daystats' — one record per day (store.DayStat fields: day, steps,
//                calories, distance)
//   'hrsample' / 'spo2sample' / 'stresssample' — day-batched: one record per
//                stream-day, body {day, samples: [{date_time, tz_offset,
//                value[, info]}]}. Per-sample records would explode the oplog
//                (a 90-day Mi-Band history is ~9k HR samples); day-batching
//                keeps one oplog entry per stream-day regardless of sample
//                density. Decided while implementing C2a Task 4.

import { dayStartMs } from './bp.js';

const SLEEP_RECORD_TYPE = 'sleep';
const DAYSTATS_RECORD_TYPE = 'daystats';
const HR_RECORD_TYPE = 'hrsample';
const SPO2_RECORD_TYPE = 'spo2sample';
const STRESS_RECORD_TYPE = 'stresssample';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function dayString(ms, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms));
}

// The day-batch recordId suffix: the sample's UTC day (vault.js utcDay), which
// is deliberately NOT dayString's local day.
function utcDayString(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function calcAvg(values) {
  if (values.length === 0) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.trunc(sum / values.length);
}

// Ported from health_handlers.go bucketVitals: groups samples into UTC
// hour-aligned buckets (Go's time.Truncate(time.Hour) truncates the absolute
// instant, not the local wall clock), dropping samples before cutoffMs.
function bucketVitals(samples, cutoffMs) {
  const buckets = new Map();
  for (const { ms, value } of samples) {
    if (ms < cutoffMs) continue;
    const ts = Math.floor(ms / HOUR_MS) * HOUR_MS;
    const b = buckets.get(ts);
    if (b) {
      b.sum += value;
      b.count++;
      if (value < b.min) b.min = value;
      if (value > b.max) b.max = value;
    } else {
      buckets.set(ts, { sum: value, count: 1, min: value, max: value });
    }
  }
  return [...buckets.entries()]
    .map(([timestamp, b]) => ({ timestamp, min: b.min, max: b.max, avg: Math.trunc(b.sum / b.count) }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

function sleepToResponse(r) {
  const resp = {
    id: r.recordId,
    start_time: r.start_time,
    end_time: r.end_time,
    timezone_offset: r.timezone_offset || 0,
    day: r.day,
    user_modified: !!r.user_modified,
  };
  if (r.light_minutes !== null && r.light_minutes !== undefined) resp.light_minutes = r.light_minutes;
  if (r.deep_minutes !== null && r.deep_minutes !== undefined) resp.deep_minutes = r.deep_minutes;
  if (r.rem_minutes !== null && r.rem_minutes !== undefined) resp.rem_minutes = r.rem_minutes;
  if (r.awake_minutes !== null && r.awake_minutes !== undefined) resp.awake_minutes = r.awake_minutes;
  if (r.total_minutes !== null && r.total_minutes !== undefined) resp.total_minutes = r.total_minutes;
  if (r.turn_over_count !== null && r.turn_over_count !== undefined) resp.turn_over_count = r.turn_over_count;
  if (r.heart_rate_avg !== null && r.heart_rate_avg !== undefined) resp.heart_rate_avg = r.heart_rate_avg;
  if (r.spo2_avg !== null && r.spo2_avg !== undefined) resp.spo2_avg = r.spo2_avg;
  if (r.notes) resp.notes = r.notes;
  return resp;
}

// createVitalsDomain builds the Vitals domain API over the injected ports:
//   records  — { list(type), put(type, record), del(type, id) }
//   now()    — current time in ms epoch
//   timeZone — IANA zone string for the 7d/30d dashboard window boundaries
export function createVitalsDomain({ records, now, timeZone }) {
  // readSamples reads ONLY the day-batches overlapping [fromMs, toMs]. The batch
  // recordIds are already '<type>-YYYY-MM-DD', and lexicographic order over that
  // prefix is chronological, so a primary-key range is the whole window — no
  // index, no schema change. Without the bound, a multi-year account re-expanded
  // every stored day on every overview() call just to throw all but 30 away.
  // Mirrors bot mode, which never loads those rows either (SQL `date_time >=`,
  // internal/store/vitals/repo.go).
  //
  // The batch key is the sample's UTC day (vault.js utcDay), NOT its local day,
  // so the range is derived in UTC and padded one day on each side: at a +14/-12
  // offset the local day and the UTC day disagree, and an unpadded local-day
  // bound would silently drop a whole edge batch. Overshooting costs at most two
  // extra clones; the caller filters to the exact ms window anyway.
  async function readSamples(recordType, fromMs, toMs) {
    const fromDay = utcDayString(fromMs - DAY_MS);
    const toDay = utcDayString(toMs + DAY_MS);
    const all = await records.listRange(recordType, `${recordType}-${fromDay}`, `${recordType}-${toDay}`);
    const out = [];
    for (const rec of all) {
      if (rec.deleted || !Array.isArray(rec.samples)) continue;
      for (const s of rec.samples) {
        const ms = Date.parse(s.date_time);
        if (!Number.isNaN(ms)) out.push({ ms, value: s.value });
      }
    }
    return out;
  }

  async function readSleepLogs() {
    const all = await records.list(SLEEP_RECORD_TYPE);
    return all.filter((r) => !r.deleted);
  }

  async function readDayStats() {
    const all = await records.list(DAYSTATS_RECORD_TYPE);
    return all
      .filter((r) => !r.deleted)
      .map((r) => ({ day: r.day, steps: r.steps || 0, calories: r.calories || 0, distance: r.distance || 0 }));
  }

  // vitalWindow computes 7d/30d averages + hourly history for one sample
  // stream, mirroring the repeated HR/SpO2/stress block in handleGetHealthOverview.
  async function vitalWindow(recordType, start7d, start30d, nowMs) {
    const samples = (await readSamples(recordType, start30d, nowMs))
      .filter((s) => s.ms >= start30d && s.ms <= nowMs);
    const samples7d = samples.filter((s) => s.ms >= start7d);
    return {
      avg7d: calcAvg(samples7d.map((s) => s.value)),
      avg30d: calcAvg(samples.map((s) => s.value)),
      history7d: bucketVitals(samples, start7d),
      history30d: bucketVitals(samples, start30d),
    };
  }

  async function overview() {
    const nowMs = now();
    const todayStart = dayStartMs(nowMs, timeZone);
    const start7d = todayStart - 6 * DAY_MS;
    const start30d = todayStart - 29 * DAY_MS;
    const start7dDay = dayString(start7d, timeZone);
    const start30dDay = dayString(start30d, timeZone);

    const [hr, spo2, stress] = await Promise.all([
      vitalWindow(HR_RECORD_TYPE, start7d, start30d, nowMs),
      vitalWindow(SPO2_RECORD_TYPE, start7d, start30d, nowMs),
      vitalWindow(STRESS_RECORD_TYPE, start7d, start30d, nowMs),
    ]);

    // Daily sleep stats: sum per-day phase minutes across sessions, then a
    // minutes-weighted average heart rate per day (mirrors the dailyHRAcc
    // pass in handleGetHealthOverview).
    const sleepLogs = (await readSleepLogs())
      .filter((l) => l.total_minutes !== null && l.total_minutes !== undefined);
    const dailyMap = new Map();
    const hrAcc = new Map();
    for (const l of sleepLogs) {
      const day = l.day || (l.start_time ? l.start_time.slice(0, 10) : '');
      if (!day) continue;
      let stat = dailyMap.get(day);
      if (!stat) {
        stat = {
          date: day, light_mins: 0, deep_mins: 0, rem_mins: 0, awake_mins: 0, total_mins: 0, heart_rate_avg: 0,
        };
        dailyMap.set(day, stat);
      }
      stat.total_mins += l.total_minutes;
      if (l.light_minutes) stat.light_mins += l.light_minutes;
      if (l.deep_minutes) stat.deep_mins += l.deep_minutes;
      if (l.rem_minutes) stat.rem_mins += l.rem_minutes;
      if (l.awake_minutes) stat.awake_mins += l.awake_minutes;
      if (l.heart_rate_avg) {
        const mins = l.total_minutes || 1;
        const acc = hrAcc.get(day) || { weightedSum: 0, totalMins: 0 };
        acc.weightedSum += l.heart_rate_avg * mins;
        acc.totalMins += mins;
        hrAcc.set(day, acc);
      }
    }
    for (const [day, acc] of hrAcc) {
      if (acc.totalMins <= 0) continue;
      const stat = dailyMap.get(day);
      if (stat) stat.heart_rate_avg = Math.trunc(acc.weightedSum / acc.totalMins);
    }

    const sleepStats7d = []; const sleepStats30d = [];
    const sleep7dMins = []; const sleep30dMins = [];
    for (const [day, stat] of dailyMap) {
      if (day < start30dDay) continue;
      sleepStats30d.push(stat);
      sleep30dMins.push(stat.total_mins);
      if (day >= start7dDay) {
        sleepStats7d.push(stat);
        sleep7dMins.push(stat.total_mins);
      }
    }
    sleepStats7d.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    sleepStats30d.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const avgSleepMins7d = calcAvg(sleep7dMins);
    const avgSleepMins30d = calcAvg(sleep30dMins);

    const dayStats30d = (await readDayStats())
      .filter((d) => d.day >= start30dDay)
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const dayStats7d = dayStats30d.filter((d) => d.day >= start7dDay);

    return {
      average_heart_rate_7d: hr.avg7d,
      average_heart_rate_30d: hr.avg30d,
      average_spo2_7d: spo2.avg7d,
      average_spo2_30d: spo2.avg30d,
      average_stress_7d: stress.avg7d,
      average_stress_30d: stress.avg30d,
      average_sleep_hours_7d: avgSleepMins7d === null ? null : avgSleepMins7d / 60,
      average_sleep_hours_30d: avgSleepMins30d === null ? null : avgSleepMins30d / 60,
      average_steps_7d: calcAvg(dayStats7d.map((d) => d.steps)),
      average_steps_30d: calcAvg(dayStats30d.map((d) => d.steps)),
      sleep_stats_7d: sleepStats7d,
      sleep_stats_30d: sleepStats30d,
      heart_rate_history_7d: hr.history7d,
      heart_rate_history_30d: hr.history30d,
      spo2_history_7d: spo2.history7d,
      spo2_history_30d: spo2.history30d,
      stress_history_7d: stress.history7d,
      stress_history_30d: stress.history30d,
      step_stats_7d: dayStats7d,
      step_stats_30d: dayStats30d,
    };
  }

  // sleep mirrors handleListSleepLogs: raw sessions over an explicit from/to
  // range (default 90d look-back), newest-first, optional limit.
  // ponytail: skips the server's bare-date "inclusive of whole day" nuance
  // for `to` (health_handlers.go parseSleepBound) — no cloud UI calls this
  // route yet, add exact date-only semantics if a caller needs them.
  async function sleep({
    from, to, days = 90, limit = 0,
  } = {}) {
    const nowMs = now();
    const since = from ? Date.parse(from) : nowMs - days * DAY_MS;
    const until = to ? Date.parse(to) : null;
    const all = (await readSleepLogs())
      .filter((l) => Date.parse(l.start_time) >= since)
      .filter((l) => until === null || Date.parse(l.start_time) <= until)
      .sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time));
    const limited = limit > 0 ? all.slice(0, limit) : all;
    return limited.map(sleepToResponse);
  }

  return { overview, sleep };
}
