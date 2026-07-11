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

// addDays advances a 'YYYY-MM-DD' calendar date by n days (n may be negative).
// Calendar arithmetic in UTC keeps it independent of the display zone.
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// nextDayString advances a 'YYYY-MM-DD' calendar date by one (the lag=1 rule).
function nextDayString(day) {
  return addDays(day, 1);
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

// -------------------------------------------------------------------------
// Self-Experiments (N-of-1 trials) — §3.3, the flagship mechanic. A user
// pre-commits to a 14-day implementation intention (Gollwitzer's "when X, I
// will Y") around a LEVER — a behavior they choose day to day. NEVER a
// restriction, a calorie/weight target, or anything that exceeds an activity
// ceiling (§5 safety guardrail). The library is CURATED: users pick a template
// from this list, they never author an experiment shape. Each template mirrors
// a probe's lever→gauge pairing so "Test it" on a revealed discovery starts the
// matching trial.
//
// At the end the SAME honesty-gate math the Atlas uses computes a verdict over
// the user's OWN logged behavior across the window: effect / no_effect /
// not_enough_contrast, with the numbers shown. CRITICAL INVARIANT (§3.3): a
// no_effect verdict is a real finding, rewarded IDENTICALLY to an effect — the
// user is rewarded for running a clean trial, never for a positive result.
// Nothing below gates `rewarded` on the direction of the delta.
// -------------------------------------------------------------------------
const EXPERIMENT_RECORD_TYPE = 'gamificationexperiment';
const EXP_DURATION_DAYS = 14;      // §5: 7–28 day duration; 14 is the launch default
const EXP_MIN_PER_ARM = 4;         // real contrast needed in BOTH arms over the window
// Recovery/illness mode signal (§5: experiments auto-pause during recovery).
// The flag does NOT exist in the codebase yet — recoveryActive() reads this
// optional record and returns false when absent, so the pause activates for
// free once a recovery-mode subsystem lands. No subsystem is invented here.
const RECOVERY_MODE_RECORD_TYPE = 'gamificationmode';

export const EXPERIMENT_TEMPLATES = [
  {
    id: 'bedtime_window',
    fromProbe: 'short_sleep_next_morning_bp',
    title: 'A steady bedtime window',
    intention: 'When it’s 22:30, I will start winding down for a 7h+ night.',
    measure: 'Your next-morning systolic on window-nights (7h+) vs shorter nights.',
    unit: 'mmHg',
    lag: 0, // sleep wake-day shares the morning reading's date
    noiseFloor: 3,
    lever: (d) => (d.sleepMinutes === null ? null : d.sleepMinutes >= 7 * 60),
    gauge: (d) => d.firstMorningSystolic,
    onLabel: 'window nights',
    offLabel: 'shorter nights',
    effectPhrase: (delta, n) => `On your window nights, mornings ran ~${Math.abs(Math.round(delta))} mmHg ${delta < 0 ? 'lower' : 'higher'} · ${n} paired days`,
    noEffectPhrase: (n) => `Your morning BP held steady whether or not you hit the window — a clean null result over ${n} days`,
  },
  {
    id: 'workout_cadence',
    fromProbe: 'workout_next_morning_bp',
    title: 'Move before noon',
    intention: 'When I finish breakfast, I will fit a workout in before noon.',
    measure: 'Your next-morning systolic on workout days vs rest days.',
    unit: 'mmHg',
    lag: 1,
    noiseFloor: 3,
    lever: (d) => d.workoutCompleted === true,
    gauge: (d) => d.firstMorningSystolic,
    onLabel: 'workout days',
    offLabel: 'rest days',
    effectPhrase: (delta, n) => `Mornings after your workout days ran ~${Math.abs(Math.round(delta))} mmHg ${delta < 0 ? 'lower' : 'higher'} · ${n} paired days`,
    noEffectPhrase: (n) => `Your next-morning BP held steady with or without a workout — a clean null result over ${n} days`,
  },
  {
    id: 'early_dinner',
    fromProbe: 'late_dinner_sleep_duration',
    title: 'Dinner before 21:00',
    intention: 'When it’s 20:30, I will finish eating for the night.',
    measure: 'That night’s sleep on early-dinner days vs late.',
    unit: 'min',
    lag: 1, // the sleep that follows a day-d dinner is logged under d+1
    noiseFloor: 20,
    lever: (d) => (d.lastMealHour === null ? null : d.lastMealHour < 21),
    gauge: (d) => d.sleepMinutes,
    onLabel: 'early-dinner days',
    offLabel: 'late-dinner days',
    effectPhrase: (delta, n) => `After early dinners you slept ~${Math.abs(Math.round(delta))} min ${delta > 0 ? 'more' : 'less'} · ${n} paired days`,
    noEffectPhrase: (n) => `Dinner timing didn’t move your sleep length — a clean null result over ${n} days`,
  },
];

function experimentTemplateById(id) {
  return EXPERIMENT_TEMPLATES.find((t) => t.id === id) || null;
}

// -------------------------------------------------------------------------
// Chapters (§3.5) — opt-in 4-week themed narrative arcs. A chapter is never
// auto-enrolled and never "failed"; it ends with a deterministic written
// review (fresh-start effect). Themes are pace/consistency-only — never a
// weight-loss-amount theme (§5 guardrail). CURATED like the experiment
// library: users pick a theme, they never author a chapter shape.
// -------------------------------------------------------------------------
const CHAPTER_DURATION_DAYS = 28; // four weeks (§3.5)

export const CHAPTER_THEMES = [
  {
    id: 'steady_month',
    title: 'The Steady Month',
    focus: 'blood-pressure consistency',
    blurb: 'Log a morning reading most days and keep your levers steady.',
    pinnedProbes: ['workout_next_morning_bp', 'short_sleep_next_morning_bp'],
  },
  {
    id: 'early_sleeper',
    title: 'The Early Sleeper',
    focus: 'a steady bedtime window',
    blurb: 'Aim for a 7h+ night and watch how your mornings answer.',
    pinnedProbes: ['short_sleep_next_morning_bp', 'short_sleep_next_day_steps'],
  },
  {
    id: 'the_rebuild',
    title: 'The Rebuild',
    focus: 'a gentle return to movement',
    blurb: 'Ease workouts back in — every session counts, none are owed.',
    pinnedProbes: ['workout_next_morning_bp', 'workout_next_day_resting_hr'],
  },
];

function chapterThemeById(id) {
  return CHAPTER_THEMES.find((t) => t.id === id) || null;
}

// -------------------------------------------------------------------------
// Traits (§3.6) — present-tense identity statements earned from LEVER
// consistency over a trailing 28-day window. Levers only: there is no gauge
// trait — no "Weight Loser", no "Low BP" (§5 guardrail, test-enforced by
// gamification.traits.test.js scanning for outcome/body language). Traits go
// DORMANT, never destroyed, when the behavior lapses, and re-kindle cheaply
// (a handful of recent lever-days), defusing the what-the-hell effect.
//   earn     — lever-on days out of 28 required to first earn the trait.
//   rekindle — lever-on days in the trailing 7d that revive a dormant trait
//              (deliberately far below `earn`: the loss-aversion is gentle).
// -------------------------------------------------------------------------
export const TRAITS = [
  {
    id: 'early_sleeper',
    title: 'Early Sleeper',
    lever: (d) => (d.sleepMinutes === null ? null : d.sleepMinutes >= 7 * 60),
    leverLabel: 'window nights',
    earn: 21,
    rekindle: 5,
  },
  {
    id: 'consistent_mover',
    title: 'Consistent Mover',
    // Every calendar day is classifiable: a completed session is a move day,
    // every other day is implicitly a rest day (false, never null).
    lever: (d) => d.workoutCompleted === true,
    leverLabel: 'move days',
    earn: 12,
    rekindle: 3,
  },
  {
    id: 'early_diner',
    title: 'Early Diner',
    lever: (d) => (d.lastMealHour === null ? null : d.lastMealHour < 21),
    leverLabel: 'early dinners',
    earn: 14,
    rekindle: 4,
  },
];

const TRAIT_EARN_WINDOW_DAYS = 28;
const TRAIT_REKINDLE_WINDOW_DAYS = 7;
// A trend keystone needs a real sample, not a lucky week, before it's declared.
const KEYSTONE_BP_MIN_DAYS = 20;

// evaluateExperimentWindow is evaluateProbe scoped to a trial's day range with
// an experiment-appropriate gate. Buckets the window's classified days into two
// arms by the user's OWN behavior (lever), reads the outcome (gauge, honoring
// lag), then: too few days in EITHER arm → not_enough_contrast (no reward, no
// penalty — the trial couldn't be called); |delta| < noiseFloor → no_effect
// (rewarded); else effect (rewarded, same reward). Pure over the day map.
function evaluateExperimentWindow(template, days, startDay, endDay) {
  const on = [];
  const off = [];
  for (const d of days.values()) {
    if (d.key < startDay || d.key > endDay) continue;
    const a = template.lever(d);
    if (a === null || a === undefined) continue;
    const outcomeDay = template.lag === 0 ? d : days.get(nextDayString(d.key));
    if (!outcomeDay) continue;
    const g = template.gauge(outcomeDay);
    if (g === null || g === undefined || Number.isNaN(g)) continue;
    (a ? on : off).push(g);
  }
  const nOn = on.length;
  const nOff = off.length;
  const base = { unit: template.unit, n_on: nOn, n_off: nOff };
  if (Math.min(nOn, nOff) < EXP_MIN_PER_ARM) {
    return {
      ...base,
      verdict: 'not_enough_contrast',
      needed_per_arm: EXP_MIN_PER_ARM,
      rewarded: false,
      text: `Not enough contrast to call it — ${nOn} ${template.onLabel} vs ${nOff} ${template.offLabel}. No result, and no penalty; run it again when you can vary the days more.`,
    };
  }
  const delta = mean(on) - mean(off);
  const n = nOn + nOff;
  const numbers = { ...base, delta, n, mean_on: mean(on), mean_off: mean(off) };
  if (Math.abs(delta) < template.noiseFloor) {
    // A null result is a real finding — rewarded identically to an effect (§3.3).
    return { ...numbers, verdict: 'no_effect', rewarded: true, text: template.noEffectPhrase(n) };
  }
  return { ...numbers, verdict: 'effect', rewarded: true, text: template.effectPhrase(delta, n) };
}

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

  // The gamificationjournal singleton is shared state (§6.3): seen-discovery
  // ids, chapter enrollment + closed-chapter reviews, trait earned-timestamps,
  // and the keystone timeline all live on the ONE record. readJournal/writeJournal
  // merge so a write to one field never clobbers the others (the old
  // markDiscoverySeen wrote a fresh record and would have wiped chapters/traits).
  async function readJournal() {
    const all = await records.list(JOURNAL_RECORD_TYPE);
    return all.find((r) => r.recordId === JOURNAL_RECORD_ID) || null;
  }

  async function writeJournal(patch) {
    const cur = await readJournal();
    const next = {
      ...(cur || {}),
      recordId: JOURNAL_RECORD_ID, deleted: false, clientTs: now(),
      ...patch,
    };
    await records.put(JOURNAL_RECORD_TYPE, next);
    return next;
  }

  async function readSeen() {
    const rec = await readJournal();
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
    await writeJournal({ seen_discoveries: seen });
    return { seen };
  }

  // appendKeystone adds one permanent milestone to the journal timeline, deduped
  // by stable id. Keystones NEVER decay, expire, or count down (§3.7 / §5): the
  // list is append-only and re-reads the journal each call so a concurrent write
  // can't drop an entry. Returns the (possibly unchanged) list.
  async function appendKeystone(entry) {
    const journal = await readJournal();
    const list = Array.isArray(journal && journal.keystones) ? journal.keystones.slice() : [];
    if (list.some((k) => k.id === entry.id)) return list;
    list.push(entry);
    await writeJournal({ keystones: list });
    return list;
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

  // --- Self-Experiments lifecycle -----------------------------------------
  // Persisted state (§4.2: only irreducible user state is stored) — one
  // gamificationexperiment record per trial: status active → resolved(verdict)
  // | cancelled. Verdict math stays recompute-on-read while a trial runs; the
  // frozen snapshot is written once, on completion, exactly like the design's
  // "frozen verdict snapshot on completion" and markDiscoverySeen's reveal flag.

  async function readExperiments() {
    return await records.list(EXPERIMENT_RECORD_TYPE);
  }

  // recoveryActive — the defensive recovery/illness-mode seam (§5). No such
  // flag exists yet; this reads an optional signal record and returns false
  // when absent, so experiments auto-pause for free once the flag lands.
  async function recoveryActive() {
    try {
      const modes = await records.list(RECOVERY_MODE_RECORD_TYPE);
      return modes.some((m) => m && m.recovery === true);
    } catch (_) {
      return false;
    }
  }

  function experimentWindow(exp) {
    const startDay = localDayString(exp.started_at, timeZone);
    const duration = exp.duration_days || EXP_DURATION_DAYS;
    return { startDay, endDay: addDays(startDay, duration - 1), duration };
  }

  // resolveElapsed freezes a trial's verdict once its whole window has passed
  // (and we're not paused by recovery mode). Idempotent: a resolved record is
  // never recomputed. Returns { active, resolved } — active is nulled once
  // frozen so max-1-concurrent frees up.
  async function resolveElapsed(active, days, paused, nowMs) {
    if (!active) return { active: null, resolved: null };
    const template = experimentTemplateById(active.template_id);
    const { startDay, endDay } = experimentWindow(active);
    const todayKey = localDayString(nowMs, timeZone);
    if (paused || !template || todayKey <= endDay) return { active, resolved: null };
    const verdict = evaluateExperimentWindow(template, days, startDay, endDay);
    const resolved = {
      ...active, status: 'resolved', resolved_at: nowMs, verdict,
      acknowledged: false, clientTs: nowMs, deleted: false,
    };
    await records.put(EXPERIMENT_RECORD_TYPE, resolved);
    // A completed clean trial is a keystone — the milestone is running it, not
    // the direction of the result (§3.3: no_effect rewarded like effect). Only
    // a callable verdict earns one; not_enough_contrast is not a finding.
    if (verdict.rewarded) {
      await appendKeystone({
        id: `experiment-${active.recordId}`,
        kind: 'experiment',
        title: template.title,
        text: verdict.verdict === 'effect'
          ? `Completed a clean 14-day trial and found an effect: ${template.title.toLowerCase()}.`
          : `Completed a clean 14-day trial — a genuine null result, an equally real finding.`,
        earned_at: nowMs,
      });
    }
    return { active: null, resolved };
  }

  function enrichActive(exp, days, nowMs, paused) {
    const template = experimentTemplateById(exp.template_id) || {};
    const { startDay, duration } = experimentWindow(exp);
    const todayKey = localDayString(nowMs, timeZone);
    let dayNumber = 0;
    let leverOn = 0;
    let cur = startDay;
    for (let i = 0; i < duration; i++) {
      if (cur > todayKey) break;
      dayNumber = i + 1;
      const d = days.get(cur);
      if (d && template.lever && template.lever(d) === true) leverOn += 1;
      cur = addDays(cur, 1);
    }
    const onLabel = template.onLabel || 'lever days';
    return {
      id: exp.recordId,
      template_id: exp.template_id,
      title: template.title,
      intention: template.intention,
      measure: template.measure,
      on_label: onLabel,
      day_number: dayNumber,
      duration,
      lever_on_count: leverOn,
      source_discovery: exp.source_discovery || null,
      paused: !!paused,
      tracker: `Day ${dayNumber} of ${duration} · ${leverOn} ${onLabel} so far`,
    };
  }

  function verdictView(exp) {
    const template = experimentTemplateById(exp.template_id) || {};
    return {
      id: exp.recordId,
      template_id: exp.template_id,
      title: template.title,
      intention: template.intention,
      measure: template.measure,
      resolved_at: exp.resolved_at,
      ...exp.verdict,
      disclaimer: 'A verdict is an observation about your last 14 days — not medical advice.',
    };
  }

  // listExperiments — the whole experiment surface the Journey screen reads:
  // the one active trial (with its tracker), the latest un-acknowledged verdict
  // card, the curated template library for "Test it", and whether a new trial
  // can start. Auto-freezes an elapsed trial as a side effect (markDiscoverySeen
  // pattern).
  async function listExperiments() {
    const nowMs = now();
    const [all, days, paused] = await Promise.all([readExperiments(), buildDays(), recoveryActive()]);
    const activeRaw = all.find((e) => e.status === 'active') || null;
    const { active, resolved } = await resolveElapsed(activeRaw, days, paused, nowMs);

    const resolvedAll = all.filter((e) => e.status === 'resolved');
    if (resolved) {
      const idx = resolvedAll.findIndex((e) => e.recordId === resolved.recordId);
      if (idx >= 0) resolvedAll[idx] = resolved; else resolvedAll.push(resolved);
    }
    const latest = resolvedAll
      .filter((e) => !e.acknowledged && e.verdict)
      .sort((a, b) => (b.resolved_at || 0) - (a.resolved_at || 0))[0] || null;

    return {
      enabled: true,
      recovery_paused: paused,
      active: active ? enrichActive(active, days, nowMs, paused) : null,
      verdict: latest ? verdictView(latest) : null,
      can_start: !active && !paused,
      templates: EXPERIMENT_TEMPLATES.map((t) => ({
        id: t.id, title: t.title, intention: t.intention,
        measure: t.measure, from_probe: t.fromProbe, unit: t.unit,
      })),
    };
  }

  // startExperiment — begins a 14-day trial from a curated template. Enforces
  // lever-only (unknown template rejected), max-1-concurrent (auto-resolving an
  // elapsed prior trial first), and the recovery-mode pause. Returns { ok }.
  async function startExperiment(templateId, params) {
    const template = experimentTemplateById(templateId);
    if (!template) return { ok: false, error: 'unknown_template' };
    const paused = await recoveryActive();
    if (paused) return { ok: false, error: 'recovery_paused' };

    const nowMs = now();
    const [all, days] = await Promise.all([readExperiments(), buildDays()]);
    const activeRaw = all.find((e) => e.status === 'active') || null;
    const { active } = await resolveElapsed(activeRaw, days, paused, nowMs);
    if (active) return { ok: false, error: 'already_active', active: enrichActive(active, days, nowMs, paused) };

    const rec = {
      recordId: `exp-${templateId}-${nowMs}`,
      clientTs: nowMs, deleted: false,
      template_id: templateId,
      status: 'active',
      started_at: nowMs,
      duration_days: EXP_DURATION_DAYS,
      source_discovery: (params && params.source_discovery) || template.fromProbe || null,
    };
    await records.put(EXPERIMENT_RECORD_TYPE, rec);
    return { ok: true, active: enrichActive(rec, days, nowMs, paused) };
  }

  // cancelExperiment — DELETE semantics. On an active trial: cancel with no
  // penalty (§5). On a resolved trial: acknowledge/dismiss the verdict card so
  // it stops surfacing. Idempotent.
  async function cancelExperiment(id) {
    if (!id) return { ok: false };
    const all = await readExperiments();
    const rec = all.find((e) => e.recordId === id);
    if (!rec) return { ok: false };
    const nowMs = now();
    if (rec.status === 'active') {
      await records.put(EXPERIMENT_RECORD_TYPE, {
        ...rec, status: 'cancelled', cancelled_at: nowMs, clientTs: nowMs, deleted: false,
      });
      return { ok: true, status: 'cancelled' };
    }
    if (rec.status === 'resolved') {
      await records.put(EXPERIMENT_RECORD_TYPE, {
        ...rec, acknowledged: true, clientTs: nowMs, deleted: false,
      });
      return { ok: true, status: 'acknowledged' };
    }
    return { ok: true, status: rec.status };
  }

  // --- Chapters -----------------------------------------------------------
  // Persisted state: journal.chapter = { theme_id, started_at } (the one active
  // arc) and journal.closed_chapters = [ review, … ]. A review is computed
  // deterministically from the window's own logged behavior — recompute stays
  // on read until the chapter closes, then the recap is frozen once.

  function chapterWindow(chapter) {
    const startDay = localDayString(chapter.started_at, timeZone);
    return { startDay, endDay: addDays(startDay, CHAPTER_DURATION_DAYS - 1) };
  }

  // buildChapterReview folds the window into a short written recap. Deterministic
  // template (LLM narration is a later phase). A window with almost no logged
  // days closes as "a quiet chapter" (the §14.11 precedent) rather than a wall
  // of zeros.
  function buildChapterReview(chapter, days, nowMs) {
    const theme = chapterThemeById(chapter.theme_id) || {};
    const { startDay, endDay } = chapterWindow(chapter);
    let loggedDays = 0;
    let windowNights = 0;
    let moveDays = 0;
    let inBandMornings = 0;
    let morningReadings = 0;
    for (const d of days.values()) {
      if (d.key < startDay || d.key > endDay) continue;
      const logged = d.firstMorningSystolic !== null || d.sleepMinutes !== null || d.workoutCompleted;
      if (logged) loggedDays += 1;
      if (d.sleepMinutes !== null && d.sleepMinutes >= 7 * 60) windowNights += 1;
      if (d.workoutCompleted === true) moveDays += 1;
      if (d.firstMorningSystolic !== null) morningReadings += 1;
    }
    const base = {
      theme_id: chapter.theme_id,
      title: theme.title || 'Your chapter',
      focus: theme.focus || '',
      started_at: chapter.started_at,
      closed_at: nowMs,
    };
    if (loggedDays < 5) {
      return {
        ...base,
        quiet: true,
        lines: [],
        text: 'A quiet chapter — it still counts. Pick the next one whenever you’re ready.',
      };
    }
    const lines = [
      `${loggedDays} days logged over your four weeks.`,
      `${windowNights} nights of 7h+ sleep.`,
      `${moveDays} move days.`,
      `${morningReadings} morning readings recorded.`,
    ];
    return {
      ...base,
      quiet: false,
      logged_days: loggedDays,
      window_nights: windowNights,
      move_days: moveDays,
      morning_readings: morningReadings,
      lines,
      text: `Your ${(theme.title || 'chapter').replace(/^The /, '')} focused on ${theme.focus || 'your health'}. ${lines.join(' ')}`,
    };
  }

  // resolveElapsedChapter freezes an elapsed chapter into a review (idempotent,
  // and paused by recovery mode so a sick stretch never force-ends an arc).
  // Returns the still-active chapter (or null once closed).
  async function resolveElapsedChapter(days, paused, nowMs) {
    const journal = await readJournal();
    const chapter = journal && journal.chapter;
    if (!chapter) return null;
    const { endDay } = chapterWindow(chapter);
    const todayKey = localDayString(nowMs, timeZone);
    if (paused || todayKey <= endDay) return chapter;
    const review = buildChapterReview(chapter, days, nowMs);
    const closed = Array.isArray(journal.closed_chapters) ? journal.closed_chapters.slice() : [];
    closed.push(review);
    await writeJournal({ chapter: null, closed_chapters: closed });
    return null;
  }

  function chapterDayNumber(chapter, nowMs) {
    const { startDay } = chapterWindow(chapter);
    const todayKey = localDayString(nowMs, timeZone);
    let n = 0;
    let cur = startDay;
    for (let i = 0; i < CHAPTER_DURATION_DAYS; i++) {
      if (cur > todayKey) break;
      n = i + 1;
      cur = addDays(cur, 1);
    }
    return n;
  }

  function chapterActiveView(chapter, nowMs) {
    const theme = chapterThemeById(chapter.theme_id) || {};
    return {
      theme_id: chapter.theme_id,
      title: theme.title,
      focus: theme.focus,
      blurb: theme.blurb,
      pinned_probes: theme.pinnedProbes || [],
      day_number: chapterDayNumber(chapter, nowMs),
      duration: CHAPTER_DURATION_DAYS,
    };
  }

  // getChapter — the whole chapter surface: the active arc (with its day
  // tracker) OR, when none is running, the most recent review + the theme
  // library to start the next one. Auto-freezes an elapsed arc as a side effect.
  async function getChapter() {
    const nowMs = now();
    const [days, paused] = await Promise.all([buildDays(), recoveryActive()]);
    const active = await resolveElapsedChapter(days, paused, nowMs);
    const themes = CHAPTER_THEMES.map((t) => ({
      id: t.id, title: t.title, focus: t.focus, blurb: t.blurb,
    }));
    if (active) {
      return {
        enabled: true, recovery_paused: paused,
        active: chapterActiveView(active, nowMs),
        review: null, themes, can_start: false,
      };
    }
    const journal = await readJournal();
    const closed = Array.isArray(journal && journal.closed_chapters) ? journal.closed_chapters : [];
    const review = closed.length ? closed[closed.length - 1] : null;
    return {
      enabled: true, recovery_paused: paused,
      active: null, review, themes, can_start: true,
    };
  }

  async function startChapter(themeId) {
    const theme = chapterThemeById(themeId);
    if (!theme) return { ok: false, error: 'unknown_theme' };
    const nowMs = now();
    const [days, paused] = await Promise.all([buildDays(), recoveryActive()]);
    const active = await resolveElapsedChapter(days, paused, nowMs);
    if (active) return { ok: false, error: 'already_active', active: chapterActiveView(active, nowMs) };
    const chapter = { theme_id: themeId, started_at: nowMs };
    await writeJournal({ chapter });
    return { ok: true, active: chapterActiveView(chapter, nowMs) };
  }

  // closeChapter — end the arc early with no penalty (§3.5: chapters end, never
  // fail), writing the review immediately. Idempotent when nothing is active.
  async function closeChapter() {
    const nowMs = now();
    const journal = await readJournal();
    const chapter = journal && journal.chapter;
    if (!chapter) return { ok: true, review: null };
    const days = await buildDays();
    const review = buildChapterReview(chapter, days, nowMs);
    const closed = Array.isArray(journal.closed_chapters) ? journal.closed_chapters.slice() : [];
    closed.push(review);
    await writeJournal({ chapter: null, closed_chapters: closed });
    return { ok: true, review };
  }

  // --- Traits -------------------------------------------------------------
  // Recompute-on-read: held / dormant / developing is derived from the trailing
  // 28-day lever consistency every call. The only persisted fact is
  // journal.traits[id].earned_at — the durable "this was once true", which is
  // what lets a lapsed trait render DORMANT (never deleted). Recovery mode
  // pauses the dormancy clock: a sick week can't demote a held trait (§5).
  function evalTrait(trait, days, persistedTraits, paused, nowMs) {
    const earnStart = localDayString(nowMs - TRAIT_EARN_WINDOW_DAYS * DAY_MS, timeZone);
    const rekindleStart = localDayString(nowMs - TRAIT_REKINDLE_WINDOW_DAYS * DAY_MS, timeZone);
    let on28 = 0;
    let on7 = 0;
    for (const d of days.values()) {
      if (d.key < earnStart) continue;
      if (trait.lever(d) !== true) continue;
      on28 += 1;
      if (d.key >= rekindleStart) on7 += 1;
    }
    const persisted = persistedTraits[trait.id] || null;
    const earned = !!persisted;
    const meetsEarn = on28 >= trait.earn;
    const rekindled = earned && on7 >= trait.rekindle;
    // Held when currently consistent, freshly re-kindled, or paused by recovery
    // (the clock can't send it dormant mid-illness).
    let held = meetsEarn || rekindled;
    let recoveryHeld = false;
    if (!held && earned && paused) { held = true; recoveryHeld = true; }

    let state;
    if (held) state = 'held';
    else if (earned) state = 'dormant';
    else state = 'developing';

    const view = {
      id: trait.id,
      title: trait.title,
      lever_label: trait.leverLabel,
      state,
      on_28d: on28,
      earn: trait.earn,
      rekindle: trait.rekindle,
      earned_at: persisted ? persisted.earned_at : null,
      recovery_held: recoveryHeld,
    };
    if (state === 'developing') view.remaining = Math.max(0, trait.earn - on28);
    if (state === 'dormant') view.rekindle_remaining = Math.max(0, trait.rekindle - on7);
    return view;
  }

  // getTraits evaluates the whole trait shelf and persists a first-earn
  // timestamp the moment a trait clears its 28-day bar (never during recovery,
  // which shouldn't mint new identity off a paused clock). The write is the only
  // durable side effect; every other field is recomputed.
  async function getTraits() {
    const nowMs = now();
    const [days, paused, journal] = await Promise.all([buildDays(), recoveryActive(), readJournal()]);
    const persistedTraits = (journal && journal.traits) || {};
    let dirty = false;
    const next = { ...persistedTraits };
    const traits = TRAITS.map((trait) => {
      const view = evalTrait(trait, days, persistedTraits, paused, nowMs);
      const meetsEarn = view.on_28d >= trait.earn;
      if (meetsEarn && !persistedTraits[trait.id] && !paused) {
        next[trait.id] = { earned_at: nowMs };
        dirty = true;
        view.earned_at = nowMs;
      }
      return view;
    });
    if (dirty) await writeJournal({ traits: next });
    return { enabled: true, recovery_paused: paused, traits };
  }

  // --- Keystones ----------------------------------------------------------
  // The permanent timeline. Experiment completions are appended at resolution
  // (resolveElapsed → appendKeystone); real-outcome trend milestones are
  // detected on read and appended once. Nothing here ever decays or counts down.

  async function maybeDetectBpBandKeystone(days, band) {
    const journal = await readJournal();
    const list = Array.isArray(journal && journal.keystones) ? journal.keystones : [];
    if (list.some((k) => k.id === 'bp_in_target_band')) return;
    const vals = [];
    for (const d of days.values()) {
      if (Number.isFinite(d.meanSystolic)) vals.push(d.meanSystolic);
    }
    if (vals.length < KEYSTONE_BP_MIN_DAYS) return; // a trend, not a lucky week
    const avg = mean(vals);
    if (avg > band.max) return;
    await appendKeystone({
      id: 'bp_in_target_band',
      kind: 'bp_trend',
      title: 'Blood pressure in your target band',
      text: `Your ${WINDOW_DAYS}-day average systolic settled at ${Math.round(avg)}, inside your target of ${band.max}.`,
      earned_at: now(),
    });
  }

  async function getKeystones() {
    const [days, band] = await Promise.all([buildDays(), inRangeBand()]);
    await maybeDetectBpBandKeystone(days, band);
    const journal = await readJournal();
    const list = Array.isArray(journal && journal.keystones) ? journal.keystones.slice() : [];
    list.sort((a, b) => (b.earned_at || 0) - (a.earned_at || 0));
    return { enabled: true, keystones: list };
  }

  return {
    getAtlas, markDiscoverySeen, getForecast,
    listExperiments, startExperiment, cancelExperiment,
    getChapter, startChapter, closeChapter,
    getTraits, getKeystones,
  };
}
