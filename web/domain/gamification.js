// Runtime-agnostic gamification domain module — the Discovery Atlas POC
// (Phase 1 of docs/design/2026-07-11-gamification-redesign.md). Pure logic over
// an injected records port — no window/document/fetch/IndexedDB — so the same
// file can later run inside the Go server via goja, exactly like bp.js/weight.js.
//
// The heart is a DETERMINISTIC probe evaluator over a fixed, hand-written probe
// catalog (PROBES). No data mining, no scanning of all record pairs: every probe
// is a pre-registered lever→gauge question with an evidence gate (min N per arm)
// and a clinical noise floor in the gauge's own units. Every number the user
// sees is recomputed on read from decrypted vault records; the only persisted
// state is reveal-once "seen" flags (§4.2 — scores are pure functions of the log).

import { dayStartMs } from './bp.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 90; // trailing window (§4.1)

// Tomorrow Forecast (§3.4). One fixed, pre-registered lever→outcome pairing —
// NOT a best-of scan (guardrail §5: no fishing). Lever: an adequate night
// (≥ 7h sleep, the tonight-actionable behavior in the design's example).
// Outcome: the same morning's first BP reading landing in range. Same-day
// bucketing (the probe catalog's short_sleep_next_morning_bp is lag 0). The
// forecast never reads weight — only bp + sleep + the user's own bp goal band.
const FORECAST_SLEEP_WINDOW_MIN = 7 * 60;
const FORECAST_GATE_PER_ARM = 8;          // min resolvable nights in EACH arm
const DEFAULT_IN_RANGE_SYSTOLIC = 130;    // High-BP Stage-1 threshold (bp.js)
const BP_GOAL_RECORD_TYPE = 'bpgoal';
const BP_GOAL_RECORD_ID = 'bpgoal';

function pct(x) {
  return Math.round(x * 100);
}

// Vault record types read (never written — the owning domain modules own writes).
const BP_RECORD_TYPE = 'bp';
const SLEEP_RECORD_TYPE = 'sleep';
const DAYSTATS_RECORD_TYPE = 'daystats';
const WORKOUT_SESSION_RECORD_TYPE = 'workoutsession';
const FOOD_LOG_RECORD_TYPE = 'foodlog';

// The one persisted record: a singleton holding reveal-once bookkeeping.
const JOURNAL_RECORD_TYPE = 'gamificationjournal';
const JOURNAL_RECORD_ID = 'journal';

// localDayString → 'YYYY-MM-DD' in the user's zone (en-CA yields ISO order),
// the same key vitals.js uses. All per-day signals bucket on this string so BP
// instants, sleep wake-days, daystats days and food instants share one key.
function localDayString(ms, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

// localHour → 0..23 wall-clock hour in the zone (for the late-dinner arm).
function localHour(ms, timeZone) {
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(ms));
  return parseInt(h, 10);
}

// nextDayString advances a 'YYYY-MM-DD' calendar date by one (the lag=1 rule).
// Calendar arithmetic in UTC keeps it independent of the display zone.
function nextDayString(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// dayOfWeek: 0=Sun … 6=Sat for a calendar date string.
function dayOfWeek(day) {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// -------------------------------------------------------------------------
// The probe catalog. Six pre-registered lever→gauge questions. Each probe:
//   lag        — 0 = gauge read on the same day the lever is classified;
//                1 = gauge read the next calendar day.
//   gate       — { minPerArm, noiseFloor }. minPerArm is required in BOTH arms
//                before anything is reported (honest statistical minimum); the
//                noiseFloor is in the gauge's clinical units, so a sub-clinical
//                1 mmHg / 1 bpm "effect" is reported as no_effect, never a find.
//   arm(day)   — true / false / null. null excludes the day (unclassifiable,
//                e.g. no sleep record that night). Never dredges: the predicate
//                is fixed, not chosen from the data.
//   gauge(day) — the outcome number for a day, or null if absent.
//   the *Phrase / next fields are deterministic copy templates (never causal
//   language, §4.1): "mornings after X were lower", never "X lowered".
// -------------------------------------------------------------------------
export const PROBES = [
  {
    id: 'workout_next_morning_bp',
    question: 'Do workout days lower your next-morning blood pressure?',
    unit: 'mmHg',
    lag: 1,
    gate: { minPerArm: 8, noiseFloor: 3 },
    arm: (d) => d.workoutCompleted === true,
    gauge: (d) => d.firstMorningSystolic,
    next: 'Log a workout, then your BP the next morning, to add a pair.',
    revealPhrase: (delta, n) => `Mornings after workout days: systolic ~${Math.abs(Math.round(delta))} mmHg ${delta < 0 ? 'lower' : 'higher'} · ${n} paired days`,
    noEffectPhrase: (n) => `Your next-morning BP holds steady whether or not you worked out — stability worth having · ${n} days`,
  },
  {
    id: 'short_sleep_next_morning_bp',
    question: 'Do short nights raise your next-morning blood pressure?',
    unit: 'mmHg',
    lag: 0, // sleep.day is the wake day; the morning reading shares that date
    gate: { minPerArm: 8, noiseFloor: 3 },
    arm: (d) => (d.sleepMinutes === null ? null : d.sleepMinutes < 7 * 60),
    gauge: (d) => d.firstMorningSystolic,
    next: 'Keep logging sleep and a morning BP reading to add a pair.',
    revealPhrase: (delta, n) => `Mornings after nights under 7h: systolic ~${Math.abs(Math.round(delta))} mmHg ${delta > 0 ? 'higher' : 'lower'} · ${n} paired days`,
    noEffectPhrase: (n) => `Your morning BP looks steady regardless of sleep length — solid · ${n} days`,
  },
  {
    id: 'weekend_systolic',
    question: 'Does your blood pressure run differently on weekends?',
    unit: 'mmHg',
    lag: 0,
    gate: { minPerArm: 8, noiseFloor: 3 },
    arm: (d) => d.isWeekend,
    gauge: (d) => d.meanSystolic,
    next: 'Keep logging BP across the week to fill in weekend readings.',
    revealPhrase: (delta, n) => `Weekend readings run ~${Math.abs(Math.round(delta))} mmHg ${delta > 0 ? 'higher' : 'lower'} than your weekdays · ${n} days`,
    noEffectPhrase: (n) => `Your BP reads about the same on weekends as weekdays · ${n} days`,
  },
  {
    id: 'workout_next_day_resting_hr',
    question: 'Do workout days lower your next-day resting heart rate?',
    unit: 'bpm',
    lag: 1,
    gate: { minPerArm: 8, noiseFloor: 2 },
    arm: (d) => d.workoutCompleted === true,
    gauge: (d) => d.sleepHeartRate,
    next: 'Log a workout, then wear your band overnight, to add a pair.',
    revealPhrase: (delta, n) => `Resting HR after workout days: ~${Math.abs(Math.round(delta))} bpm ${delta < 0 ? 'lower' : 'higher'} · ${n} paired days`,
    noEffectPhrase: (n) => `Your resting HR holds steady whether or not you worked out · ${n} days`,
  },
  {
    id: 'short_sleep_next_day_steps',
    question: 'Do short nights change how much you move the next day?',
    unit: 'steps',
    lag: 0, // sleep.day is the wake day; steps accrue across that same day
    gate: { minPerArm: 8, noiseFloor: 500 },
    arm: (d) => (d.sleepMinutes === null ? null : d.sleepMinutes < 7 * 60),
    gauge: (d) => d.steps,
    next: 'Keep logging sleep and wearing your band for step counts.',
    revealPhrase: (delta, n) => `After nights under 7h you take ~${Math.abs(Math.round(delta))} ${delta < 0 ? 'fewer' : 'more'} steps · ${n} days`,
    noEffectPhrase: (n) => `Your step count looks the same after short nights as long ones · ${n} days`,
  },
  {
    id: 'late_dinner_sleep_duration',
    question: 'Do late dinners cost you sleep?',
    unit: 'min',
    lag: 1, // a late meal on day d, the sleep it precedes is logged under d+1
    gate: { minPerArm: 8, noiseFloor: 20 },
    arm: (d) => (d.lastMealHour === null ? null : d.lastMealHour >= 21),
    gauge: (d) => d.sleepMinutes,
    next: 'Log your dinner time and that night’s sleep to add a pair.',
    revealPhrase: (delta, n) => `After dinners past 21:00 you sleep ~${Math.abs(Math.round(delta))} min ${delta < 0 ? 'less' : 'more'} · ${n} paired days`,
    noEffectPhrase: (n) => `Late dinners don’t seem to shorten your sleep · ${n} days`,
  },
];

// createGamificationDomain builds the Atlas domain API over the injected ports:
//   records  — { list(type), put(type, record), del(type, id) }
//   now()    — current time in ms epoch
//   timeZone — IANA zone string for local-day bucketing
export function createGamificationDomain({ records, now, timeZone }) {
  // buildDays materializes the trailing-window per-day signal map from the vault.
  // One pass per record type; every signal buckets on the same local-day string,
  // so a probe's arm/gauge just reads fields off a day object. Recompute-on-read:
  // nothing here is cached or persisted (§4.2).
  async function buildDays() {
    const nowMs = now();
    const windowStartMs = dayStartMs(nowMs - WINDOW_DAYS * DAY_MS, timeZone);
    const days = new Map(); // 'YYYY-MM-DD' -> signal object

    function dayObj(key) {
      let d = days.get(key);
      if (!d) {
        d = {
          key,
          isWeekend: dayOfWeek(key) === 0 || dayOfWeek(key) === 6,
          systolics: [], // { ms, systolic }
          sleepMinutes: null,
          sleepHeartRate: null,
          sleepBestMinutes: -1, // internal: pick the longest session's HR
          steps: null,
          workoutCompleted: false,
          lastMealMs: null,
          lastMealHour: null,
        };
        days.set(key, d);
      }
      return d;
    }

    const inWindow = (ms) => Number.isFinite(ms) && ms >= windowStartMs && ms <= nowMs;

    // BP — first-morning + daily-mean systolic. Skip ignore_calc rows, matching
    // every other BP aggregate.
    for (const r of await records.list(BP_RECORD_TYPE)) {
      if (r.ignore_calc) continue;
      const ms = Date.parse(r.measured_at);
      if (!inWindow(ms)) continue;
      dayObj(localDayString(ms, timeZone)).systolics.push({ ms, systolic: r.systolic });
    }

    // Sleep — total minutes + a resting-HR proxy, bucketed on the wake day.
    for (const r of await records.list(SLEEP_RECORD_TYPE)) {
      if (r.total_minutes === null || r.total_minutes === undefined) continue;
      const key = r.day || (r.start_time ? localDayString(Date.parse(r.start_time), timeZone) : '');
      if (!key) continue;
      const anchorMs = Date.parse(`${key}T00:00:00Z`);
      if (!inWindow(anchorMs)) continue;
      const d = dayObj(key);
      d.sleepMinutes = (d.sleepMinutes || 0) + r.total_minutes;
      if (r.heart_rate_avg && r.total_minutes > d.sleepBestMinutes) {
        d.sleepBestMinutes = r.total_minutes;
        d.sleepHeartRate = r.heart_rate_avg;
      }
    }

    // Daily steps.
    for (const r of await records.list(DAYSTATS_RECORD_TYPE)) {
      if (!r.day) continue;
      const anchorMs = Date.parse(`${r.day}T00:00:00Z`);
      if (!inWindow(anchorMs)) continue;
      dayObj(r.day).steps = r.steps || 0;
    }

    // Completed workout sessions — a "workout day" is one with a completed
    // session; every other day is implicitly a rest day (arm === false).
    for (const r of await records.list(WORKOUT_SESSION_RECORD_TYPE)) {
      if (r.status !== 'completed') continue;
      const ms = r.completed_at ? Date.parse(r.completed_at)
        : (r.scheduled_date ? Date.parse(`${r.scheduled_date}T12:00:00Z`) : NaN);
      if (!inWindow(ms)) continue;
      const key = r.completed_at ? localDayString(ms, timeZone) : r.scheduled_date;
      dayObj(key).workoutCompleted = true;
    }

    // Food logs — latest meal hour per day (the late-dinner lever).
    for (const r of await records.list(FOOD_LOG_RECORD_TYPE)) {
      const ms = Date.parse(r.eaten_at);
      if (!inWindow(ms)) continue;
      const d = dayObj(localDayString(ms, timeZone));
      if (d.lastMealMs === null || ms > d.lastMealMs) {
        d.lastMealMs = ms;
        d.lastMealHour = localHour(ms, timeZone);
      }
    }

    // Finalize derived BP fields.
    for (const d of days.values()) {
      if (d.systolics.length > 0) {
        d.systolics.sort((a, b) => a.ms - b.ms);
        d.firstMorningSystolic = d.systolics[0].systolic;
        d.meanSystolic = mean(d.systolics.map((s) => s.systolic));
      } else {
        d.firstMorningSystolic = null;
        d.meanSystolic = null;
      }
    }
    return days;
  }

  // evaluateProbe buckets the window's classified days into two arms, gates on
  // min N per arm, then applies the noise floor. Pure over the day map + a probe.
  function evaluateProbe(probe, days) {
    const armTrue = [];
    const armFalse = [];
    for (const d of days.values()) {
      const a = probe.arm(d);
      if (a === null || a === undefined) continue;
      const outcomeDay = probe.lag === 0 ? d : days.get(nextDayString(d.key));
      if (!outcomeDay) continue;
      const g = probe.gauge(outcomeDay);
      if (g === null || g === undefined || Number.isNaN(g)) continue;
      (a ? armTrue : armFalse).push(g);
    }

    const nTrue = armTrue.length;
    const nFalse = armFalse.length;
    const have = Math.min(nTrue, nFalse);
    const needed = probe.gate.minPerArm;
    const base = { id: probe.id, question: probe.question, unit: probe.unit };

    if (have < needed) {
      return {
        ...base,
        state: 'developing',
        have,
        needed,
        remaining: needed - have,
        next: probe.next,
      };
    }

    const delta = mean(armTrue) - mean(armFalse);
    const n = nTrue + nFalse;
    if (Math.abs(delta) < probe.gate.noiseFloor) {
      return {
        ...base, state: 'no_effect', n, text: probe.noEffectPhrase(n),
      };
    }
    return {
      ...base,
      state: 'revealed',
      delta,
      n,
      mean_true: mean(armTrue),
      mean_false: mean(armFalse),
      text: probe.revealPhrase(delta, n),
    };
  }

  async function readSeen() {
    const all = await records.list(JOURNAL_RECORD_TYPE);
    const rec = all.find((r) => r.recordId === JOURNAL_RECORD_ID);
    return Array.isArray(rec && rec.seen_discoveries) ? rec.seen_discoveries : [];
  }

  // getAtlas evaluates the whole catalog and stamps reveal-once seen flags on
  // the two terminal states. Developing cards are never "seen" (nothing revealed
  // yet). Returns { enabled, cards } — the shape journey.js's Atlas feed reads.
  async function getAtlas() {
    const [days, seen] = await Promise.all([buildDays(), readSeen()]);
    const seenSet = new Set(seen);
    const cards = PROBES.map((probe) => {
      const card = evaluateProbe(probe, days);
      if (card.state === 'revealed' || card.state === 'no_effect') {
        card.seen = seenSet.has(card.id);
      }
      return card;
    });
    return { enabled: true, cards };
  }

  // markDiscoverySeen records that the user has seen a card's reveal, so the UI
  // never re-fires the one-time reveal moment (§5 guardrail). Idempotent.
  async function markDiscoverySeen(id) {
    if (!id) return { seen: [] };
    const seen = await readSeen();
    if (!seen.includes(id)) seen.push(id);
    await records.put(JOURNAL_RECORD_TYPE, {
      recordId: JOURNAL_RECORD_ID, clientTs: now(), deleted: false, seen_discoveries: seen,
    });
    return { seen };
  }

  // inRangeBand reads the user's own bp goal (systolic) so the forecast is
  // never a black box — in-range means "at or below your target", or the
  // High-BP Stage-1 threshold when no goal is set. Weight is never consulted.
  async function inRangeBand() {
    const goals = await records.list(BP_GOAL_RECORD_TYPE);
    const g = goals.find((r) => r.recordId === BP_GOAL_RECORD_ID);
    const target = g && g.target_systolic;
    if (Number.isFinite(target) && target > 0) {
      return { max: target, source: 'goal' };
    }
    return { max: DEFAULT_IN_RANGE_SYSTOLIC, source: 'default' };
  }

  // forecastPairs buckets the trailing window into the two lever arms. A day is
  // "resolvable" only when it has BOTH a classifiable night (sleepMinutes) and a
  // first-morning systolic — the exact same-day pairing the probe catalog uses.
  // Each entry carries the outcome boolean (in range) so calibration can replay
  // the model's majority-class call per arm. Pure over the day map.
  function forecastPairs(days, band) {
    const good = []; // { key, inRange, systolic, sleepMinutes }
    const short = [];
    for (const d of days.values()) {
      if (d.sleepMinutes === null || d.sleepMinutes === undefined) continue;
      if (d.firstMorningSystolic === null || d.firstMorningSystolic === undefined) continue;
      const inRange = d.firstMorningSystolic <= band.max;
      const entry = {
        key: d.key, inRange, systolic: d.firstMorningSystolic, sleepMinutes: d.sleepMinutes,
      };
      (d.sleepMinutes >= FORECAST_SLEEP_WINDOW_MIN ? good : short).push(entry);
    }
    return { good, short };
  }

  function share(arm) {
    return arm.length ? arm.reduce((a, e) => a + (e.inRange ? 1 : 0), 0) / arm.length : 0;
  }

  function fmtHours(min) {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }

  // getForecast — tonight's prospective card + this morning's resolution + the
  // "how well do we know you" calibration meter (§3.4). Recompute-on-read: the
  // model, the resolution, and the trailing hit-rate are all pure functions of
  // the log (§4.2), so nothing here is persisted. Self-suppresses below the gate:
  // when either arm holds fewer than FORECAST_GATE_PER_ARM nights it declines to
  // quote a probability and the calibration meter carries the progress instead.
  async function getForecast() {
    const nowMs = now();
    const [days, band] = await Promise.all([buildDays(), inRangeBand()]);
    const { good, short } = forecastPairs(days, band);
    const nGood = good.length;
    const nShort = short.length;
    const have = Math.min(nGood, nShort);
    const needed = FORECAST_GATE_PER_ARM;
    const total = nGood + nShort;
    const calibrated = have >= needed;

    const goodShare = share(good);
    const shortShare = share(short);
    const phase = localHour(nowMs, timeZone) < 12 ? 'morning' : 'evening';

    // Evening card — the tonight-actionable, lever-conditioned chance. Below the
    // gate it names no number (honesty over theater, §5 forecast guardrail).
    let evening;
    if (!calibrated) {
      evening = {
        state: 'insufficient',
        lever: 'sleep_window',
        text: 'We don’t know your mornings well enough yet — keep logging a morning BP after each night and this fills in.',
      };
    } else {
      evening = {
        state: 'ready',
        lever: 'sleep_window',
        goodShare: pct(goodShare),
        otherShare: pct(shortShare),
        n: total,
        text: `A 7h+ night tonight → mornings like that have been in range ${pct(goodShare)}% for you (vs ${pct(shortShare)}% after shorter nights).`,
      };
    }

    // Morning resolution — the most recent resolvable morning, today or
    // yesterday, scored against the model's majority-class call for its arm.
    // Only meaningful once calibrated; a miss is always framed as noise.
    let resolution = null;
    if (calibrated) {
      const todayKey = localDayString(nowMs, timeZone);
      const yesterdayKey = localDayString(nowMs - DAY_MS, timeZone);
      let latest = null;
      for (const e of [...good, ...short]) {
        if (e.key !== todayKey && e.key !== yesterdayKey) continue;
        if (!latest || e.key > latest.key) latest = e;
      }
      if (latest) {
        const wasGoodNight = latest.sleepMinutes >= FORECAST_SLEEP_WINDOW_MIN;
        const armShare = wasGoodNight ? goodShare : shortShare;
        const predictedInRange = armShare >= 0.5;
        const matched = predictedInRange === latest.inRange;
        resolution = {
          day: latest.key,
          nightMinutes: latest.sleepMinutes,
          systolic: latest.systolic,
          inRange: latest.inRange,
          matched,
          text: `Last night ${fmtHours(latest.sleepMinutes)} · this morning ${latest.systolic} — ${latest.inRange ? 'in range ✓' : 'above your range'}. ${matched ? 'Your body agreed ✓' : 'Not this time — one morning is noise; the pattern needs weeks.'}`,
        };
      }
    }

    // Calibration meter — the honest progress bar. While learning, the fill is
    // data readiness toward the gate; once calibrated, the fill IS the model's
    // trailing hit-rate over every resolvable morning (majority-class call vs
    // actual), which can honestly be modest.
    let calibration;
    if (!calibrated) {
      calibration = {
        state: 'learning',
        have,
        needed,
        fraction: needed > 0 ? Math.min(1, have / needed) : 0,
        label: `Getting to know your mornings — ${have} of ${needed} paired nights each way.`,
      };
    } else {
      let hits = 0;
      for (const e of good) if ((goodShare >= 0.5) === e.inRange) hits += 1;
      for (const e of short) if ((shortShare >= 0.5) === e.inRange) hits += 1;
      const hitRate = total ? hits / total : 0;
      calibration = {
        state: 'calibrated',
        have,
        needed,
        n: total,
        hitRate: pct(hitRate),
        fraction: hitRate,
        label: `Calibrated on ${total} mornings — the pattern held ${pct(hitRate)}% of the time so far.`,
      };
    }

    return {
      enabled: true, phase, band, evening, resolution, calibration,
    };
  }

  return { getAtlas, markDiscoverySeen, getForecast };
}
