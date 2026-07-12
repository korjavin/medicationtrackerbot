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

// The vault holds one user's data; handleListSleepLogs stamps the row's
// user_id, so the wire shape carries it too.
const CLOUD_USER_ID = 1;

const SLEEP_RECORD_TYPE = 'sleep';
const DAYSTATS_RECORD_TYPE = 'daystats';
const HR_RECORD_TYPE = 'hrsample';
const SPO2_RECORD_TYPE = 'spo2sample';
const STRESS_RECORD_TYPE = 'stresssample';
// Mi-Band workouts live in the workout domain's 'miband' record type (see
// web/domain/workout.js WORKOUT_RECORD_TYPES.MIBAND). The NXK import writes them
// directly by natural key so re-drain converges; the read/edit side is workout.js.
const MIBAND_RECORD_TYPE = 'miband';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// MAX_SAMPLES_PER_RECORD keeps a day-batch record's ct well under the server's
// 64 KiB maxOpCTLen (internal/cloudserver/sync.go): a merged day over this splits
// into deterministic sub-records ('<type>-<day>#<k>') so the client never emits an
// op the server 400s. After server downsampling a day is ~96 samples, so this is a
// defensive net that only trips on un-downsampled input. readSamples' PK range
// already catches the '#' suffix ('#' 0x23 sorts below the padded <toDay> bound).
const MAX_SAMPLES_PER_RECORD = 500;

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
    user_id: CLOUD_USER_ID,
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
  //
  // Overflow sub-records ('<type>-<day>#<k>', see importDayBatched) fall inside
  // this range for free: '#' (0x23) sorts below any digit, so '<type>-<day>#k' is
  // always < the padded '<type>-<toDay>' bound (toDay is >= the last sample's day
  // + 1). The loop below unions every part's samples, so a split day reads whole.
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

  // importDayBatched merges an incoming NXK sample stream into the day-batch
  // records the read side already expects ({day, samples:[{date_time, tz_offset,
  // value[, type, info]}]}, recordId '<type>-YYYY-MM-DD'). Samples are grouped by
  // UTC day, then merged with any existing batch(es) for that day keyed by sample
  // instant so a re-applied import overwrites its own samples instead of appending
  // duplicates (LWW: the incoming sample wins). Idempotent — re-draining converges.
  //
  // A day whose merged sample count exceeds MAX_SAMPLES_PER_RECORD splits into
  // deterministic sub-records: fixed-size chunks over the instant-sorted samples,
  // part 0 keyed '<type>-<day>' (backward compatible), overflow parts
  // '<type>-<day>#<k>'. The chunking is a pure function of the sorted sample set,
  // so the same input always yields the same partition and re-drain converges;
  // readSamples' PK range scan already unions every part of a day.
  async function importDayBatched(recordType, samples) {
    if (!Array.isArray(samples) || samples.length === 0) return;
    const byDay = new Map();
    for (const s of samples) {
      if (!s || !s.date_time) continue;
      const ms = Date.parse(s.date_time);
      if (Number.isNaN(ms)) continue;
      const day = utcDayString(ms);
      let arr = byDay.get(day);
      if (!arr) { arr = []; byDay.set(day, arr); }
      arr.push(s);
    }
    const allRecords = await records.list(recordType);
    const existing = new Map(allRecords.map((r) => [r.recordId, r]));
    for (const [day, incoming] of byDay) {
      const base = `${recordType}-${day}`;
      // Merge across EVERY existing part for the day (base + '#k' overflow), keyed
      // by the sample instant (ms) so two RFC3339 spellings of the same moment
      // dedupe and the incoming sample overwrites (LWW). Reading all parts is what
      // lets a re-import with a different partition size not leave stale samples.
      const merged = new Map();
      for (const r of allRecords) {
        if (r.recordId !== base && !r.recordId.startsWith(`${base}#`)) continue;
        if (Array.isArray(r.samples)) {
          for (const s of r.samples) merged.set(Date.parse(s.date_time), s);
        }
      }
      for (const s of incoming) merged.set(Date.parse(s.date_time), { ...s });
      const samplesOut = [...merged.values()]
        .sort((a, b) => (a.date_time < b.date_time ? -1 : a.date_time > b.date_time ? 1 : 0));
      const parts = [];
      for (let i = 0; i < samplesOut.length; i += MAX_SAMPLES_PER_RECORD) {
        parts.push(samplesOut.slice(i, i + MAX_SAMPLES_PER_RECORD));
      }
      if (parts.length === 0) parts.push([]);
      for (let k = 0; k < parts.length; k += 1) {
        const recordId = k === 0 ? base : `${base}#${k}`;
        await records.put(recordType, {
          recordId, clientTs: now(), deleted: false, day, samples: parts[k],
        });
      }
      // Tombstone overflow parts a smaller partition no longer fills, else their
      // stale samples would be re-read as duplicates. Prior writes are contiguous
      // from #1, so stop at the first gap.
      for (let k = parts.length; ; k += 1) {
        const staleId = `${base}#${k}`;
        if (!existing.has(staleId)) break;
        await records.del(recordType, staleId);
      }
    }
  }

  // importSamples writes a drained NXK vitals_import event into vault records.
  // Every stream is upserted by a deterministic natural key so re-applying the
  // same import (the drain's ack-after-flush barrier may replay it) is a no-op:
  //   sleep     — recordId 'sleep-<startInstantMs>'
  //   daystats  — recordId 'daystats-<day>'
  //   hr/spo2/stress — day-batched, samples merged by instant (importDayBatched)
  //   workouts  — recordId 'miband-<source_start_ms>' (no GPS; the wire never
  //               carries it — locked scope decision)
  // The natural keys already make every write idempotent, so no separate
  // once-marker is needed (unlike the free-text agent path).
  // ponytail: no marker — natural keys converge; add one only if a stream ever
  // gains non-deterministic write ids.
  // Writes are monotonic merges against the stored record, mirroring the UPSERT
  // guards bot mode uses (repo.go ImportDayStats/importSleepLogs, miband.go):
  // Mi-Band .nxk backups are cumulative and get re-uploaded, and the drain's
  // replay-on-failed-flush barrier can re-apply an older import after a newer
  // one — a blind put would then downgrade steps / shorten a sleep session /
  // zero-out a populated workout field. Same-instant day-batched samples
  // (importDayBatched) carry the same device value, so LWW is fine there.
  async function importSamples({
    sleep: sleepLogs = [], hr = [], spo2 = [], stress = [], daystats = [], workouts = [],
  } = {}) {
    if (sleepLogs.length) {
      const existing = new Map((await records.list(SLEEP_RECORD_TYPE)).map((r) => [r.recordId, r]));
      for (const s of sleepLogs) {
        if (!s || !s.start_time) continue;
        const startMs = Date.parse(s.start_time);
        const key = Number.isNaN(startMs) ? s.day : startMs;
        const recordId = `sleep-${key}`;
        const prev = existing.get(recordId);
        const base = prev && !prev.deleted ? prev : null;
        if (base) {
          // Never downgrade a longer stored session (repo.go WHERE
          // total_minutes >). `{...base, ...s}` is COALESCE: omitempty drops
          // absent phase fields from the wire, so the spread keeps base's.
          if ((s.total_minutes || 0) < (base.total_minutes || 0)) continue;
          await records.put(SLEEP_RECORD_TYPE, {
            ...base, ...s, recordId, clientTs: now(), deleted: false,
            user_modified: base.user_modified || s.user_modified,
          });
          continue;
        }
        await records.put(SLEEP_RECORD_TYPE, {
          recordId, clientTs: now(), deleted: false, ...s,
        });
      }
    }

    if (daystats.length) {
      const existing = new Map((await records.list(DAYSTATS_RECORD_TYPE)).map((r) => [r.recordId, r]));
      for (const d of daystats) {
        if (!d || !d.day) continue;
        const recordId = `daystats-${d.day}`;
        const prev = existing.get(recordId);
        const base = prev && !prev.deleted ? prev : null;
        // MAX per field (repo.go), so a stale partial day never overwrites
        // higher totals; skip the write entirely when nothing increased.
        const steps = Math.max(base ? (base.steps || 0) : 0, d.steps || 0);
        const calories = Math.max(base ? (base.calories || 0) : 0, d.calories || 0);
        const distance = Math.max(base ? (base.distance || 0) : 0, d.distance || 0);
        if (base && steps === (base.steps || 0) && calories === (base.calories || 0)
          && distance === (base.distance || 0)) continue;
        await records.put(DAYSTATS_RECORD_TYPE, {
          recordId, clientTs: now(), deleted: false, day: d.day, steps, calories, distance,
        });
      }
    }

    await importDayBatched(HR_RECORD_TYPE, hr);
    await importDayBatched(SPO2_RECORD_TYPE, spo2);
    await importDayBatched(STRESS_RECORD_TYPE, stress);

    if (workouts.length) {
      const existing = new Map(
        (await records.list(MIBAND_RECORD_TYPE)).map((r) => [r.recordId, r]),
      );
      for (const w of workouts) {
        if (!w || !w.source_start_ms) continue;
        const recordId = `miband-${w.source_start_ms}`;
        const prev = existing.get(recordId);
        const base = prev && !prev.deleted ? prev : null;
        // Don't let an older session (earlier end) win, and fall back to the
        // stored value for any zero incoming field (miband.go CASE guards) —
        // a partial re-import must not zero a populated row.
        if (base && (w.source_end_ms || 0) < (base.source_end_ms || 0)) continue;
        const pick = (inc, k) => (inc ? inc : (base ? base[k] : inc));
        await records.put(MIBAND_RECORD_TYPE, {
          recordId,
          clientTs: now(),
          deleted: false,
          // Preserve a prior numeric id (edits key on it) else derive one
          // deterministically from the source instant so re-drain converges.
          id: prev ? prev.id : w.source_start_ms,
          activity_type: pick(w.activity_type, 'activity_type'),
          activity_name: pick(w.activity_name, 'activity_name'),
          source_start_ms: w.source_start_ms,
          source_end_ms: w.source_end_ms,
          duration_sec: pick(w.duration_sec, 'duration_sec'),
          distance_m: pick(w.distance_m, 'distance_m'),
          steps: pick(w.steps, 'steps'),
          calories: pick(w.calories, 'calories'),
          heart_rate_avg: pick(w.heart_rate_avg, 'heart_rate_avg'),
          spo2_avg: pick(w.spo2_avg, 'spo2_avg'),
          pause_ms: pick(w.pause_ms, 'pause_ms'),
          tz_offset: pick(w.tz_offset, 'tz_offset'),
          source: 'miband',
        });
      }
    }
  }

  return { overview, sleep, importSamples };
}
