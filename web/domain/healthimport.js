// Apple Health → vault import (bd med-w6gx.6). Pure logic over the injected
// records port, like every web/domain module: the iOS shell hands over raw
// HealthKit samples (web/cloud/js/health-import.js fetches them through
// window.Health), and this maps them onto the EXISTING bp / weight record
// shapes through their own domain create().
//
// Idempotent by construction: the recordId is derived from the HealthKit sample
// UUID, so a re-import, a reset anchor, or a second iPhone reading the same
// iCloud-synced Health data lands on the same slot. That makes it a derived
// write (CLAUDE.md rule 12): clientTs 0 via putIfAbsent, so an import never
// overwrites an edit to that reading and never resurrects a deleted one (a
// tombstone occupies the slot).
//
// The only new fields are the optional `source: 'apple_health'` and
// `source_id` (the sample UUID, so a vault restore keeps the id — vault.js);
// clients that predate them ignore them (toResponse picks known fields).
//
// Sleep and workouts (bd med-w6gx.7) land in the existing `sleep` night and
// `miband` activity shapes — never in strength sessions or sets. Their bodies
// are a pure function of the HealthKit samples (no clock, no device zone, no
// local history), so every device writes the same body under one id.
// Workouts follow the bp/weight floor (overlap rule: a workout overlapping one
// already in the vault is skipped; among new overlapping candidates the
// longest wins, ties to the smaller UUID). Sleep does not — see importSleep:
// one record per sleep day, written with a content-derived clientTs so the
// most complete version wins on every device (docs/ios.md).
import { createBPDomain, offsetMsAt } from './bp.js';
import { createWeightDomain } from './weight.js';
import {
  HEALTH_SOURCE, UUID_RE, healthRecordId, healthImportRecordId, healthNumericId,
} from './healthsource.js';

function positive(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
// Sleep samples of one source at most this far apart make one night.
// Health.swift pads each sleep window by 48h — wide enough to hold every night
// of the sleep day any of its samples belongs to; a night is used only when it
// lies whole inside the window (a gap clear of either edge).
const SLEEP_GAP_MS = HOUR_MS;
// HKCategoryValueSleepAnalysis: 0 inBed (ignored: a bedtime schedule, not
// sleep), 1 asleepUnspecified, 2 awake, 3 asleepCore, 4 asleepDeep, 5 asleepREM.
const SLEEP_PHASE = { 1: 'asleep', 2: 'awake', 3: 'light', 4: 'deep', 5: 'rem' };
// Where samples of one night overlap (a summary "asleep" sample under the
// Watch's stages, or a duplicate), each minute counts once, as the highest of:
// deep > REM > core > awake > unspecified asleep.
const SLEEP_RANK = { 4: 5, 5: 4, 3: 3, 2: 2, 1: 1 };
// A sleep day is written only once its last sample ended this long ago, so a
// night still being written is not churned through partial versions — and so
// its content-derived clientTs (sleepClientTs) is always older than the moment
// the row became visible, i.e. than any edit or delete of it. The cloud side
// re-reads unsettled nights by time window (health-import.js).
export const SLEEP_SETTLE_MS = 3 * HOUR_MS;
// A sleep day runs from 18:00 to 18:00 local, by when a night ENDS: a night
// ending 07:00 belongs to that date (its wake day), a nap at 15:00 to the
// same one, a night still going at 18:00 to the next.
const SLEEP_DAY_SHIFT_MS = 6 * HOUR_MS;
// HKWorkoutActivityType raw values. running/walking/cycling reuse the history
// list's labels (web/static/js/features/workout/history.js MIBAND_ACTIVITY_META).
const WORKOUT_NAMES = {
  37: 'running', 52: 'walking', 13: 'cycling', 24: 'Hiking', 46: 'Swimming',
  50: 'Strength Training', 20: 'Functional Strength', 59: 'Core Training',
  63: 'HIIT', 16: 'Elliptical', 35: 'Rowing', 44: 'Stair Climbing', 57: 'Yoga',
  66: 'Pilates', 73: 'Mixed Cardio', 11: 'Cross Training', 14: 'Dance', 77: 'Cardio Dance', 78: 'Social Dance',
};
// A strength workout also yields to an in-app workout session it overlaps:
// per-set logging (docs/workout-depth.md) is the record of that gym visit. A
// session never completed counts for this long after its start.
const STRENGTH_TYPES = new Set([20, 50]);
const OPEN_SESSION_MS = 4 * HOUR_MS;

function rfc3339(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function overlaps(a, list) {
  return list.some((b) => a.start < b.end && b.start < a.end);
}

const byUuid = (a, b) => (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0);

// A night's local day and offset use the sample's own zone (Health's
// HKMetadataKeyTimeZone) when it has one, else UTC — never this device's zone:
// the body sits at clientTs 0, so two devices must write it identically.
function zoneOf(tz) {
  if (typeof tz === 'string' && tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return tz;
    } catch { /* unknown zone name */ }
  }
  return 'UTC';
}

// Milliseconds per phase over the union of a night's samples: cut at every
// sample edge, each piece counted once at its highest-ranked sample.
// ponytail: O(cuts × samples), fine for one night's few hundred samples.
function phaseMs(samples) {
  const ms = { asleep: 0, awake: 0, light: 0, deep: 0, rem: 0 };
  const cuts = [...new Set(samples.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b);
  for (let i = 0; i + 1 < cuts.length; i++) {
    let best = null;
    for (const s of samples) {
      if (s.start <= cuts[i] && s.end >= cuts[i + 1] && (!best || SLEEP_RANK[s.value] > SLEEP_RANK[best.value])) best = s;
    }
    if (best) ms[SLEEP_PHASE[best.value]] += cuts[i + 1] - cuts[i];
  }
  return ms;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

// sleepClientTs: the LWW stamp of a Health sleep day, derived from its content
// instead of the clock (a deliberate exception to CLAUDE.md rule 12's floor).
// More asleep minutes, then staged over unstaged, then a body hash: so the
// most complete version wins on every device, identical bodies tie exactly,
// and different bodies never tie (bar a hash collision). It stays below
//   base + 2881 × 3500 + 3500 ≈ base + 2.8h,  base = the day's UTC midnight − 20h
// which is at or before 18:00 local of the previous day in every zone
// (UTC−12…UTC+14), i.e. before the earliest end of any night of that day. The
// row is written only SLEEP_SETTLE_MS (3h) after that end, so every edit or
// delete of it — stamped with the clock — outranks every import of it, and a
// stale device's shorter version loses to a fuller one instead of erasing it.
export function sleepClientTs(day, body) {
  const base = Date.parse(`${day}T00:00:00Z`) - 20 * HOUR_MS;
  const minutes = Math.min(Math.max(body.total_minutes || 0, 0), 1440);
  const staged = body.light_minutes === null || body.light_minutes === undefined ? 0 : 1;
  return base + (minutes * 2 + staged) * 3500 + (fnv1a(JSON.stringify(body)) % 3500);
}

// sleepNights groups one window of raw sleep samples into nights: per source,
// samples (inBed excluded) chained while the gap stays ≤ SLEEP_GAP_MS. A night
// counts only with some sleep in it; `whole` says it lies whole inside
// [from, to] (a sleep day is written only when all its nights are).
export function sleepNights(samples, from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
  const valid = (Array.isArray(samples) ? samples : [])
    .filter((s) => s && UUID_RE.test(s.uuid) && Number.isFinite(s.start) && Number.isFinite(s.end)
      && s.end > s.start && SLEEP_PHASE[s.value])
    .map((s) => ({ ...s, uuid: s.uuid.toLowerCase(), src: String(s.source || '') }))
    .sort((a, b) => (a.src < b.src ? -1 : a.src > b.src ? 1 : 0) || (a.start - b.start) || byUuid(a, b));
  const nights = [];
  let cur = null;
  for (const s of valid) {
    if (cur && cur.src === s.src && s.start - cur.end <= SLEEP_GAP_MS) {
      cur.samples.push(s);
      cur.end = Math.max(cur.end, s.end);
    } else {
      cur = { src: s.src, start: s.start, end: s.end, samples: [s] };
      nights.push(cur);
    }
  }
  return nights
    .map((n) => {
      const ms = phaseMs(n.samples);
      return {
        src: n.src,
        tz: (n.samples.find((s) => typeof s.tz === 'string' && s.tz) || {}).tz,
        start: n.start,
        end: n.end,
        span: ms.asleep + ms.light + ms.deep + ms.rem,
        ms,
        staged: n.samples.some((s) => s.value >= 3),
        whole: n.start >= from + SLEEP_GAP_MS && n.end <= to - SLEEP_GAP_MS,
      };
    })
    .filter((n) => n.span > 0);
}

// createHealthImportDomain({ records, now, timeZone }) — records must carry
// list, listRaw and putIfAbsent (web/cloud/js/sync.js recordsPort).
export function createHealthImportDomain({ records, now, timeZone }) {
  const bp = createBPDomain({ records, now, timeZone });
  const weight = createWeightDomain({ records, now, timeZone });

  // Sample shapes come from ios/App/Health.swift: start is ms epoch, BP in
  // mmHg, body mass in kg.
  const KINDS = {
    bp: {
      valid: (s) => positive(s.systolic) && positive(s.diastolic),
      create: (s, opts) => bp.create({
        measured_at: s.start,
        systolic: Math.round(s.systolic),
        diastolic: Math.round(s.diastolic),
        source: HEALTH_SOURCE,
        source_id: s.uuid,
      }, opts),
    },
    weight: {
      valid: (s) => positive(s.kg),
      create: (s, opts) => weight.create({
        measured_at: s.start,
        weight: Math.round(s.kg * 100) / 100,
        source: HEALTH_SOURCE,
        source_id: s.uuid,
      }, opts),
    },
  };

  // The record type each bridge kind lands in.
  const TYPE = { bp: 'bp', weight: 'weight', sleep: 'sleep', workout: 'miband' };

  // Workout rows go straight to the LWW floor, like bp/weight's derived
  // create (the workout domain has no create for them).
  const floored = (type, uuid, body) => records.putIfAbsent(type, {
    recordId: healthRecordId(type, uuid), clientTs: 0, deleted: false,
    ...body, source: HEALTH_SOURCE, source_id: uuid,
  });

  const spans = (rows, startOf, endOf) => rows
    .map((r) => ({ start: startOf(r), end: endOf(r) }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end));

  // The overlap rule. `taken` starts as the vault's live spans; a candidate
  // already known (imported, or deleted: a tombstone) keeps its span taken, so
  // a rescan does not hand a deleted workout's slot to a copy in the same page.
  // ponytail: a tombstone has no body, so a copy arriving in another page (a
  // late second source, a long rescan) is imported — docs/ios.md residuals.
  // Then the longest new candidate first, ties to the smaller UUID.
  function pickFree(candidates, have, taken, alsoTaken = () => []) {
    const known = candidates.filter((c) => have.has(c.recordId));
    taken.push(...known);
    const out = [];
    for (const c of candidates.filter((x) => !have.has(x.recordId))
      .sort((a, b) => (b.span - a.span) || byUuid(a, b))) {
      if (overlaps(c, taken) || overlaps(c, alsoTaken(c))) continue;
      taken.push(c);
      out.push(c);
    }
    return out;
  }

  // importSleep → { added, pending }. Health sleep is one record per sleep day
  // (SLEEP_DAY_SHIFT_MS), id `sleep-hk-<day>`: every night and nap of that day
  // from ONE source, the one with the highest sleepClientTs (most asleep
  // minutes). The key is the same across sources and devices, so copies of a
  // night converge on one row by LWW instead of piling up, and a fuller
  // version (late stages, a lagging iPhone) replaces a partial one.
  // Not written: a day whose best version is clipped by the window or not
  // settled (`pending` = the earliest unsettled start, for the caller to
  // re-read by time window); a day overlapping a non-Health sleep entry
  // (Mi Band, manual: it wins); a day an edit or delete already outranks.
  async function importSleep(samples, bounds) {
    const all = sleepNights(samples, bounds && bounds.from, bounds && bounds.to);
    const settledBy = now() - SLEEP_SETTLE_MS;
    const open = all.filter((n) => n.end > settledBy);
    const pending = open.length ? Math.min(...open.map((n) => n.start)) : undefined;
    if (!all.length) return { added: 0, pending };

    const min = (v) => Math.round(v / MIN_MS);
    const days = new Map(); // day -> source -> nights
    for (const n of all) {
      const offset = offsetMsAt(n.end, zoneOf(n.tz));
      const day = new Date(n.end + offset + SLEEP_DAY_SHIFT_MS).toISOString().slice(0, 10);
      if (!days.has(day)) days.set(day, new Map());
      const bySrc = days.get(day);
      if (!bySrc.has(n.src)) bySrc.set(n.src, []);
      bySrc.get(n.src).push(n);
    }

    const raw = await records.listRaw('sleep');
    const byId = new Map(raw.map((r) => [r.recordId, r]));
    // A Health row an older client's restore re-minted under a fresh id keeps
    // source_id (its day): that day is already there, leave it.
    const aliased = new Set();
    for (const r of raw) {
      const id = healthImportRecordId('sleep', r);
      if (id && id !== r.recordId) aliased.add(id);
    }
    const others = spans(
      raw.filter((r) => !r.deleted && !healthImportRecordId('sleep', r)),
      (r) => Date.parse(r.start_time), (r) => Date.parse(r.end_time),
    );

    let added = 0;
    for (const [day, bySrc] of days) {
      let best = null;
      for (const nights of bySrc.values()) {
        const ms = { asleep: 0, awake: 0, light: 0, deep: 0, rem: 0 };
        for (const n of nights) for (const k of Object.keys(ms)) ms[k] += n.ms[k];
        const start = Math.min(...nights.map((n) => n.start));
        const end = Math.max(...nights.map((n) => n.end));
        const last = nights.reduce((a, n) => (n.end > a.end ? n : a));
        const offset = offsetMsAt(end, zoneOf(last.tz));
        const staged = nights.some((n) => n.staged);
        const body = {
          start_time: rfc3339(start),
          end_time: rfc3339(end),
          // Minutes west of UTC, as the Mi Band import stores it.
          timezone_offset: -Math.round(offset / MIN_MS) || 0,
          day,
          light_minutes: staged ? min(ms.light) : null,
          deep_minutes: staged ? min(ms.deep) : null,
          rem_minutes: staged ? min(ms.rem) : null,
          awake_minutes: min(ms.awake),
          total_minutes: min(ms.asleep + ms.light + ms.deep + ms.rem),
          user_modified: false,
          source: HEALTH_SOURCE,
          source_id: day,
        };
        const c = {
          body, start, end, ts: sleepClientTs(day, body),
          ready: end <= settledBy && nights.every((n) => n.whole),
        };
        if (!best || c.ts > best.ts) best = c;
      }
      const recordId = healthRecordId('sleep', day);
      const prev = byId.get(recordId);
      if (!best.ready || aliased.has(recordId)) continue;
      if (prev && (prev.deleted || prev.clientTs >= best.ts)) continue;
      // Same body already there: the sync layer may have shifted its stamp by
      // this device's clock skew, which must not trigger a rewrite every run.
      if (prev && Object.keys(best.body).every((k) => prev[k] === best.body[k])) continue;
      if (overlaps(best, others)) continue;
      await records.put('sleep', { recordId, clientTs: best.ts, deleted: false, ...best.body });
      added++;
    }
    return { added, pending };
  }

  async function importWorkouts(samples, have) {
    const fresh = (Array.isArray(samples) ? samples : [])
      .filter((s) => s && UUID_RE.test(s.uuid) && Number.isFinite(s.start) && Number.isFinite(s.end)
        && s.end > s.start)
      .map((s) => {
        const uuid = s.uuid.toLowerCase();
        return { ...s, uuid, recordId: healthRecordId('miband', uuid), span: s.end - s.start };
      });
    if (!fresh.length) return 0;
    const taken = spans(await records.list('miband'), (r) => r.source_start_ms, (r) => r.source_end_ms);
    const sessions = spans(
      (await records.list('workoutsession')).filter((r) => r.started_at),
      (r) => Date.parse(r.started_at),
      (r) => (r.completed_at ? Date.parse(r.completed_at) : Date.parse(r.started_at) + OPEN_SESSION_MS),
    );
    const num = (v) => (positive(v) ? Math.round(v) : 0);
    let added = 0;
    for (const w of pickFree(fresh, have, taken, (c) => (STRENGTH_TYPES.has(c.activity) ? sessions : []))) {
      const durationSec = positive(w.duration) ? Math.round(w.duration) : Math.round(w.span / 1000);
      have.add(w.recordId);
      await floored('miband', w.uuid, {
        id: healthNumericId(w.uuid),
        activity_type: 0,
        activity_name: WORKOUT_NAMES[w.activity] || 'Workout',
        source_start_ms: w.start,
        source_end_ms: w.end,
        duration_sec: durationSec,
        distance_m: num(w.distance),
        steps: 0,
        calories: num(w.energy),
        heart_rate_avg: num(w.hr),
        spo2_avg: 0,
        pause_ms: Math.max(0, w.span - durationSec * 1000),
        tz_offset: 0,
      });
      added++;
    }
    return added;
  }

  // importSamples(kind, samples, bounds) → { added } (sleep adds `pending`): what was new
  // here. `bounds` is the whole query result ({from, to} for sleep). Malformed
  // samples are skipped, never thrown on — one odd entry in Health must not
  // stall every later import behind the same anchor.
  async function importSamples(kind, samples, bounds) {
    const type = TYPE[kind];
    if (!type) throw new Error(`healthimport: unknown kind ${kind}`);
    if (kind === 'sleep') return importSleep(samples, bounds);
    // Tombstones included: a deleted reading stays deleted. A row restored by
    // an older client sits under a fresh id but keeps source_id — count it too
    // (deleting such an alias also tombstones its canonical id: healthsource.js).
    const have = new Set();
    for (const r of await records.listRaw(type)) {
      have.add(r.recordId);
      const id = healthImportRecordId(type, r);
      if (id) have.add(id);
    }
    if (kind === 'workout') return { added: await importWorkouts(samples, have) };
    const k = KINDS[kind];
    // Oldest first: a stable write order. (weight.create stores a derived row
    // without a trend, so every device writes the same body.)
    const fresh = (Array.isArray(samples) ? samples : [])
      .filter((s) => s && UUID_RE.test(s.uuid) && Number.isFinite(s.start) && k.valid(s))
      .sort((a, b) => a.start - b.start);
    let added = 0;
    for (const s of fresh) {
      const recordId = healthRecordId(kind, s.uuid);
      if (have.has(recordId)) continue;
      have.add(recordId);
      await k.create(s, { recordId, derived: true });
      added++;
    }
    return { added };
  }

  return { importSamples };
}
