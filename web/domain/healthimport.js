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
// are a pure function of the HealthKit samples (no clock, no local history), so
// every device writes the same body under one id. Overlap rule (docs/ios.md):
// a Health night or workout overlapping one already in the vault (manual,
// Mi Band, or another Health source) is skipped; among new overlapping
// candidates the longest wins, ties to the smaller UUID.
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
// Health.swift pads each sleep window by 18h; a night is imported only when it
// lies whole inside the window (a gap clear of either edge), so a night clipped
// at an edge is read whole by the window of the page that holds it.
const SLEEP_GAP_MS = HOUR_MS;
// HKCategoryValueSleepAnalysis: 0 inBed (ignored: a bedtime schedule, not
// sleep), 1 asleepUnspecified, 2 awake, 3 asleepCore, 4 asleepDeep, 5 asleepREM.
const SLEEP_PHASE = { 1: 'asleep', 2: 'awake', 3: 'light', 4: 'deep', 5: 'rem' };
// HKWorkoutActivityType raw values. running/walking/cycling reuse the history
// list's labels (web/static/js/features/workout/history.js MIBAND_ACTIVITY_META).
const WORKOUT_NAMES = {
  37: 'running', 52: 'walking', 13: 'cycling', 24: 'Hiking', 46: 'Swimming',
  50: 'Strength Training', 20: 'Functional Strength', 59: 'Core Training',
  63: 'HIIT', 16: 'Elliptical', 35: 'Rowing', 44: 'Stair Climbing', 57: 'Yoga',
  66: 'Pilates', 73: 'Mixed Cardio', 11: 'Cross Training', 77: 'Dance', 78: 'Cardio Dance',
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
// HKMetadataKeyTimeZone) when it has one, else this device's.
function zoneOf(tz, fallback) {
  if (typeof tz === 'string' && tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return tz;
    } catch { /* unknown zone name */ }
  }
  return fallback;
}

// sleepNights groups one window of raw sleep samples into nights: per source,
// samples (inBed excluded) chained while the gap stays ≤ SLEEP_GAP_MS. A night
// counts only with some sleep in it; `whole` says it lies whole inside
// [from, to] (only those are imported; a clipped one still blocks what it
// overlaps, so it never loses to a shorter copy). `span` is the asleep time,
// the weight the overlap rule ranks by.
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
      const ms = { asleep: 0, awake: 0, light: 0, deep: 0, rem: 0 };
      for (const s of n.samples) ms[SLEEP_PHASE[s.value]] += s.end - s.start;
      return {
        // Named by its first sample (sorted by start, then UUID).
        uuid: n.samples[0].uuid,
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

  // Sleep / workout rows go straight to the LWW floor, like bp/weight's
  // derived create (the vitals and workout domains have no create for them).
  const floored = (type, uuid, body) => records.putIfAbsent(type, {
    recordId: healthRecordId(type, uuid), clientTs: 0, deleted: false,
    ...body, source: HEALTH_SOURCE, source_id: uuid,
  });

  const spans = (rows, startOf, endOf) => rows
    .map((r) => ({ start: startOf(r), end: endOf(r) }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end));

  // The overlap rule. `taken` starts as the vault's live spans; a candidate
  // already known (imported, or deleted: a tombstone) keeps its span taken so a
  // second source's copy of a deleted workout does not take its place. Then the
  // longest new candidate first, ties to the smaller UUID.
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

  async function importSleep(samples, window, have) {
    const all = sleepNights(samples, window && window.from, window && window.to);
    const nights = all.filter((n) => n.whole).map((n) => ({ ...n, recordId: healthRecordId('sleep', n.uuid) }));
    if (!nights.length) return 0;
    const taken = spans(await records.list('sleep'), (r) => Date.parse(r.start_time), (r) => Date.parse(r.end_time))
      .concat(all.filter((n) => !n.whole));
    const min = (v) => Math.round(v / MIN_MS);
    let added = 0;
    for (const n of pickFree(nights, have, taken)) {
      const offset = offsetMsAt(n.end, zoneOf(n.tz, timeZone));
      have.add(n.recordId);
      await floored('sleep', n.uuid, {
        start_time: rfc3339(n.start),
        end_time: rfc3339(n.end),
        // Minutes west of UTC, as the Mi Band import stores it.
        timezone_offset: -Math.round(offset / MIN_MS),
        // The wake day, on the night's local calendar.
        day: new Date(n.end + offset).toISOString().slice(0, 10),
        light_minutes: n.staged ? min(n.ms.light) : null,
        deep_minutes: n.staged ? min(n.ms.deep) : null,
        rem_minutes: n.staged ? min(n.ms.rem) : null,
        awake_minutes: min(n.ms.awake),
        total_minutes: min(n.span),
        user_modified: false,
      });
      added++;
    }
    return added;
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

  // importSamples(kind, samples, window) → { added }: the records that were new
  // here. `window` is the whole query result ({from, to} for sleep). Malformed
  // samples are skipped, never thrown on — one odd entry in Health must not
  // stall every later import behind the same anchor.
  async function importSamples(kind, samples, window) {
    const type = TYPE[kind];
    if (!type) throw new Error(`healthimport: unknown kind ${kind}`);
    // Tombstones included: a deleted reading stays deleted. A row restored by
    // an older client sits under a fresh id but keeps source_id — count it too
    // (deleting such an alias also tombstones its canonical id: healthsource.js).
    const have = new Set();
    for (const r of await records.listRaw(type)) {
      have.add(r.recordId);
      const id = healthImportRecordId(type, r);
      if (id) have.add(id);
    }
    if (kind === 'sleep') return { added: await importSleep(samples, window, have) };
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
