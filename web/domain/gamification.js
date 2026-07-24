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

// meanOr0 mirrors the Go engine's mean(): the arithmetic mean, or 0 for an
// empty slice (unlike `mean` above, which is only ever fed non-empty arms).
function meanOr0(xs) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function medianOf(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// =========================================================================
// Substrate parity — a faithful, function-for-function port of the Go scoring
// engine (internal/domain/gamification/scoring/scoring.go), the single
// reference per docs/design/2026-07-11-gamification-redesign.md §6.1. Every
// number the HP/rings/Health-Score/gauges/weekly surfaces show is computed by
// these pure functions; gamification.substrate.test.js asserts they reproduce
// the Go tests' expected values verbatim. Levels are ported for DISPLAY only —
// nothing here (or downstream) gates any feature on level (§3.1 retcon).
// =========================================================================

// Ring / kind / metric identifiers (scoring.go). Kept as the ledger-shaped
// strings the read-model grouping and the frontend expect.
const RING_ADHERENCE = 'adherence';
const RING_MOVEMENT = 'movement';
const RING_VITALS = 'vitals';
const RING_NOURISHMENT = 'nourishment';
const RING_MIND = 'mind';
const KIND_FLOOR = 'floor';
const KIND_OUTCOME = 'outcome';
const KIND_CONSISTENCY = 'consistency';
const METRIC_MEDICATION = 'medication';
const METRIC_BP = 'bp';
const METRIC_SLEEP = 'sleep';
const METRIC_STEPS = 'steps';
const METRIC_ACTIVITY = 'activity';
const METRIC_MEAL = 'meal';
const METRIC_CALORIES = 'calories';
const METRIC_PROTEIN = 'protein';
const METRIC_VEG = 'veg';
const METRIC_WEIGHT = 'weight';
const METRIC_DIARY = 'diary';
const METRIC_WEIGHT_TREND_WEEK = 'weight_trend_week';
const METRIC_BP_SHARE_WEEK = 'bp_share_week';
const METRIC_RESTING_HR_TREND_WEEK = 'resting_hr_trend_week';

const HEALTH_KEY_BP = 'bp';
const HEALTH_KEY_SLEEP = 'sleep';
const HEALTH_KEY_RESTING_HR = 'resting_hr';
const HEALTH_KEY_WEIGHT = 'weight';
const HEALTH_KEY_ADHERENCE = 'adherence';

// DEFAULT_CONFIG mirrors scoring.DefaultConfig() value-for-value. Bands are
// { low, high, falloff }.
export const DEFAULT_CONFIG = {
  floorHP: 2,

  adherenceOutcomeMaxHP: 10,
  adherenceOnTimeGraceMin: 60,
  adherenceLateFalloffMin: 120,

  bpSystolic: { low: 90, high: 120, falloff: 10 },
  bpDiastolic: { low: 60, high: 80, falloff: 5 },

  restingHR: { low: 50, high: 80, falloff: 10 },
  vitalsImprovementSpan: 0.2,

  sleepHours: { low: 7, high: 9, falloff: 1.5 },
  sleepRegularityMaxHP: 10,
  bedtimeWindow: { low: 0, high: 45, falloff: 60 },

  stepsOutcomeMaxHP: 6,
  stepsBand: { low: 7000, high: 15000, falloff: 3000 },
  movementOutcomeMaxHP: 10,
  weeklyActivityTargetLow: 150,

  nourishmentCaloriesMaxHP: 8,
  calorieTolerancePct: 0.10,
  nourishmentProteinMaxHP: 4,
  nourishmentVegMaxHP: 3,

  weightSafePaceMaxPct: 1.0,
  weightSafePaceMinPct: 0.25,
  weightPaceFalloffBelowPct: 0.2,
  weightPaceFalloffAbovePct: 0.5,

  mindReflectBonusHP: 2,

  levelBase: 100,
  levelExponent: 1.5,
  levelMax: 1000,

  insightTierLevels: [3, 5, 7],
  insightMaxTier: 4,

  freezeEarnPerPeriod: 1,
  maxFreezes: 4,

  healthScoreWindowDays: 14,
  healthScoreBaselineDays: 60,
  healthScoreMinContributors: 2,
  healthScoreWeightBP: 1.0,
  healthScoreWeightSleep: 1.0,
  healthScoreWeightRestingHR: 1.0,
  healthScoreWeightBodyweight: 1.0,
  healthScoreWeightAdherence: 0.5,
  healthScoreAdherencePDCTarget: 0.8,
  healthScoreWeightStabilityPct: 0.02,

  habitStrengthHalfLifeDays: 13,

  adherenceAlertPDCThreshold: 0.90,

  gaugeWeightEMAAlpha: 0.10,
  gaugeWeightLookbackDays: 120,
  gaugeWeightVelocityWindowDays: 14,
  gaugeWeightAccelerationDeadbandPctPerWeek: 0.15,
  gaugeWeightMinHistoryDays: 28,

  gaugeBPRecentWindowDays: 14,
  gaugeBPMidWindowDays: 30,
  gaugeBPBaselineWindowDays: 60,
  gaugeBPMinBaselineReadings: 4,

  gaugeRestingHRRecentWindowDays: 14,
  gaugeRestingHRBaselineWindowDays: 60,
  gaugeRestingHRMinBaselineDays: 5,

  gaugeWeightWeeklyMaxHP: 20,
  gaugeBPWeeklyMaxHP: 20,
  gaugeBPShareFalloffPts: 0.20,
  gaugeRestingHRWeeklyMaxHP: 10,
  gaugeRestingHRFalloffBPM: 5,
};

function clamp01(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// trapezoid (scoring.go): full credit in [low,high], linear partial credit over
// independent below/above falloffs, 0 beyond; degenerate band (high<low) → 0.
function trapezoid(x, low, high, deltaLow, deltaHigh) {
  if (high < low) return 0;
  if (x >= low && x <= high) return 1;
  if (x < low) {
    if (deltaLow <= 0 || x <= low - deltaLow) return 0;
    return clamp01(1 - (low - x) / deltaLow);
  }
  if (deltaHigh <= 0 || x >= high + deltaHigh) return 0;
  return clamp01(1 - (x - high) / deltaHigh);
}

function rangeMembership(x, low, high, delta) {
  return trapezoid(x, low, high, delta, delta);
}

function bandMembership(band, x) {
  return rangeMembership(x, band.low, band.high, band.falloff);
}

// rampUp (scoring.go): one-sided-OK — 0 at/below 0, linear to 1 at full, then
// saturates.
function rampUp(x, full) {
  if (full <= 0) return 0;
  return clamp01(x / full);
}

// baselineRelative (scoring.go): grades x against a personal baseline; at
// x==baseline returns 0.5, a full span of improvement reaches 1.0.
function baselineRelative(x, baseline, lowerIsBetter, span) {
  if (baseline <= 0 || span <= 0) return 0;
  const delta = baseline * span;
  let improvement = x - baseline;
  if (lowerIsBetter) improvement = baseline - x;
  return clamp01(0.5 + improvement / (2 * delta));
}

// scaleHP (scoring.go): round(maxHP * clamp01(r)), never negative. Math.round
// and Go's math.Round agree for the non-negative values used here.
function scaleHP(maxHP, r) {
  const v = Math.round(maxHP * clamp01(r));
  return v < 0 ? 0 : v;
}

// mkAward carries the same fields as scoring.Award plus a numeric `r` (the
// membership the Go Detail JSON encodes) so ring-progress can read it back.
// Drops HP<=0 grants, exactly like addAward.
function pushAward(list, ring, source, kind, hp, r) {
  if (hp <= 0) return list;
  const a = { ring, source, kind, hp };
  if (r !== undefined) a.r = r;
  list.push(a);
  return list;
}

// ----- per-domain scorers (scoring.go) --------------------------------------
// Dose status: 'taken' | 'skipped' | 'missed'; a dose is { status, minutesLate }.

function scoreAdherence(doses, cfg) {
  const awards = [];
  let floorLogs = 0;
  let expected = 0;
  let takenSum = 0;
  for (const d of doses) {
    if (d.status === 'taken') {
      floorLogs += 1;
      expected += 1;
      takenSum += rangeMembership(d.minutesLate || 0, 0, cfg.adherenceOnTimeGraceMin, cfg.adherenceLateFalloffMin);
    } else if (d.status === 'skipped') {
      floorLogs += 1;
    } else if (d.status === 'missed') {
      expected += 1;
    }
  }
  pushAward(awards, RING_ADHERENCE, METRIC_MEDICATION, KIND_FLOOR, floorLogs * cfg.floorHP);
  if (expected > 0) {
    const r = takenSum / expected;
    pushAward(awards, RING_ADHERENCE, METRIC_MEDICATION, KIND_OUTCOME, scaleHP(cfg.adherenceOutcomeMaxHP, r), r);
  }
  return awards;
}

function scoreBP(hasReadings, cfg) {
  if (!hasReadings) return [];
  return pushAward([], RING_VITALS, METRIC_BP, KIND_FLOOR, cfg.floorHP);
}

// sleep = { logged, hasRegularity, timingDeviationMin }
function scoreSleep(sleep, cfg) {
  const awards = [];
  if (sleep.logged) pushAward(awards, RING_MIND, METRIC_SLEEP, KIND_FLOOR, cfg.floorHP);
  if (sleep.hasRegularity) {
    const r = bandMembership(cfg.bedtimeWindow, Math.abs(sleep.timingDeviationMin));
    pushAward(awards, RING_MIND, METRIC_SLEEP, KIND_CONSISTENCY, scaleHP(cfg.sleepRegularityMaxHP, r), r);
  }
  return awards;
}

// mov = { hasSteps, steps, workoutLogged, hasActivity, weeklyActivityMinutes }
function scoreMovement(mov, cfg) {
  const awards = [];
  if (mov.hasSteps) {
    pushAward(awards, RING_MOVEMENT, METRIC_STEPS, KIND_FLOOR, cfg.floorHP);
    const r = bandMembership(cfg.stepsBand, mov.steps);
    pushAward(awards, RING_MOVEMENT, METRIC_STEPS, KIND_OUTCOME, scaleHP(cfg.stepsOutcomeMaxHP, r), r);
  }
  if (mov.workoutLogged) pushAward(awards, RING_MOVEMENT, METRIC_ACTIVITY, KIND_FLOOR, cfg.floorHP);
  if (mov.hasActivity) {
    const r = rampUp(mov.weeklyActivityMinutes, cfg.weeklyActivityTargetLow);
    pushAward(awards, RING_MOVEMENT, METRIC_ACTIVITY, KIND_OUTCOME, scaleHP(cfg.movementOutcomeMaxHP, r), r);
  }
  return awards;
}

// nour = { logged, calories, calorieTarget, calorieFloor, protein, proteinTarget, vegServings, vegTarget }
function scoreNourishment(nour, cfg) {
  const awards = [];
  if (nour.logged) pushAward(awards, RING_NOURISHMENT, METRIC_MEAL, KIND_FLOOR, cfg.floorHP);
  if (nour.calorieTarget > 0) {
    const tol = cfg.calorieTolerancePct;
    let r = rangeMembership(nour.calories, nour.calorieTarget * (1 - tol), nour.calorieTarget * (1 + tol), nour.calorieTarget * tol);
    if (nour.calorieFloor > 0 && nour.calories < nour.calorieFloor) r = 0;
    pushAward(awards, RING_NOURISHMENT, METRIC_CALORIES, KIND_OUTCOME, scaleHP(cfg.nourishmentCaloriesMaxHP, r), r);
  }
  if (nour.proteinTarget > 0) {
    const r = rampUp(nour.protein, nour.proteinTarget);
    pushAward(awards, RING_NOURISHMENT, METRIC_PROTEIN, KIND_OUTCOME, scaleHP(cfg.nourishmentProteinMaxHP, r), r);
  }
  if (nour.vegTarget > 0) {
    const r = rampUp(nour.vegServings, nour.vegTarget);
    pushAward(awards, RING_NOURISHMENT, METRIC_VEG, KIND_OUTCOME, scaleHP(cfg.nourishmentVegMaxHP, r), r);
  }
  return awards;
}

function scoreWeight(logged, cfg) {
  if (!logged) return [];
  return pushAward([], RING_VITALS, METRIC_WEIGHT, KIND_FLOOR, cfg.floorHP);
}

// mind = { journaledEntries, engagedWithPrompt }
function scoreMind(mind, cfg) {
  const awards = [];
  if (mind.journaledEntries > 0) pushAward(awards, RING_MIND, METRIC_DIARY, KIND_FLOOR, cfg.floorHP);
  if (mind.engagedWithPrompt) pushAward(awards, RING_MIND, METRIC_DIARY, KIND_CONSISTENCY, cfg.mindReflectBonusHP);
  return awards;
}

// ----- weekly gauge awards (scoring.go) -------------------------------------

function scoreWeightWeekly(inp, cfg) {
  if (!inp.hasData) return [];
  let r;
  if (inp.goalDirection !== 0) {
    const toward = inp.velocityPctPerWeek * inp.goalDirection;
    r = trapezoid(toward, cfg.weightSafePaceMinPct, cfg.weightSafePaceMaxPct, cfg.weightPaceFalloffBelowPct, cfg.weightPaceFalloffAbovePct);
  } else {
    r = trapezoid(inp.velocityPctPerWeek, -cfg.weightSafePaceMinPct, cfg.weightSafePaceMinPct, cfg.weightPaceFalloffAbovePct, cfg.weightPaceFalloffAbovePct);
  }
  return pushAward([], RING_VITALS, METRIC_WEIGHT_TREND_WEEK, KIND_OUTCOME, scaleHP(cfg.gaugeWeightWeeklyMaxHP, r), r);
}

function scoreBPWeekly(inp, cfg) {
  if (!inp.hasData) return [];
  const delta = inp.share30d - inp.baselineShare60d;
  const r = trapezoid(delta, 0, 1, cfg.gaugeBPShareFalloffPts, 0);
  return pushAward([], RING_VITALS, METRIC_BP_SHARE_WEEK, KIND_OUTCOME, scaleHP(cfg.gaugeBPWeeklyMaxHP, r), r);
}

function scoreRestingHRWeekly(inp, cfg) {
  if (!inp.hasData) return [];
  let r = 1.0;
  if (inp.deltaFromBaseline > 0) {
    r = cfg.gaugeRestingHRFalloffBPM <= 0 ? 0 : clamp01(1 - inp.deltaFromBaseline / cfg.gaugeRestingHRFalloffBPM);
  }
  return pushAward([], RING_VITALS, METRIC_RESTING_HR_TREND_WEEK, KIND_OUTCOME, scaleHP(cfg.gaugeRestingHRWeeklyMaxHP, r), r);
}

// ----- levels, insight tiers, streaks (scoring.go) --------------------------

function hpToReachLevel(level, cfg) {
  if (level <= 1) return 0;
  return Math.round(cfg.levelBase * Math.pow(level - 1, cfg.levelExponent));
}

function levelForLifetimeHP(hp, cfg) {
  if (hp <= 0) return 1;
  let level = 1;
  while (level < cfg.levelMax && hpToReachLevel(level + 1, cfg) <= hp) level += 1;
  return level;
}

function insightTierForLevel(level, cfg) {
  let tier = 1;
  for (const lv of cfg.insightTierLevels) if (level >= lv) tier += 1;
  if (cfg.insightMaxTier > 0 && tier > cfg.insightMaxTier) tier = cfg.insightMaxTier;
  return tier;
}

// nextStreak (scoring.go): met period extends + banks a freeze (capped); a miss
// spends a banked freeze else resets. Never negative.
function nextStreak(prev, periodMet, cfg) {
  const cur = Math.max(0, prev.currentStreak || 0);
  const fz = Math.max(0, prev.freezes || 0);
  if (periodMet) {
    let left = fz + cfg.freezeEarnPerPeriod;
    if (cfg.maxFreezes > 0 && left > cfg.maxFreezes) left = cfg.maxFreezes;
    return { currentStreak: cur + 1, freezes: left };
  }
  if (fz > 0) return { currentStreak: cur, freezes: fz - 1 };
  return { currentStreak: 0, freezes: 0 };
}

// ----- health score & habit strength (scoring.go) ---------------------------

// computeHealthScore folds present contributors into a weighted mean scaled to
// 0-100, renormalizing over present weight only. Below minContributors present
// → score null. contributors: [{ key, label, value, weight, present }].
function computeHealthScore(contributors, cfg) {
  const missing = [];
  let sumWeight = 0;
  let sumWeightedValue = 0;
  let present = 0;
  for (const c of contributors) {
    if (!c.present) { missing.push(c.key); continue; }
    present += 1;
    sumWeight += c.weight;
    sumWeightedValue += c.weight * clamp01(c.value);
  }
  let minC = cfg.healthScoreMinContributors;
  if (minC <= 0) minC = 2;
  let score = null;
  if (present >= minC && sumWeight > 0) score = 100 * sumWeightedValue / sumWeight;
  return { score, contributors, missing };
}

function healthContributorBP(meanSystolic, meanDiastolic, present, cfg) {
  const c = { key: HEALTH_KEY_BP, label: 'Blood pressure', weight: cfg.healthScoreWeightBP, present, value: 0 };
  if (present) c.value = Math.min(bandMembership(cfg.bpSystolic, meanSystolic), bandMembership(cfg.bpDiastolic, meanDiastolic));
  return c;
}

function healthContributorSleep(meanDurationHours, meanTimingDeviationMin, hasRegularity, present, cfg) {
  const c = { key: HEALTH_KEY_SLEEP, label: 'Sleep', weight: cfg.healthScoreWeightSleep, present, value: 0 };
  if (present) {
    let v = bandMembership(cfg.sleepHours, meanDurationHours);
    if (hasRegularity) {
      const reg = bandMembership(cfg.bedtimeWindow, Math.abs(meanTimingDeviationMin));
      v = (v + reg) / 2;
    }
    c.value = v;
  }
  return c;
}

function healthContributorRestingHR(meanHR, baselineHR, present, cfg) {
  const c = { key: HEALTH_KEY_RESTING_HR, label: 'Resting heart rate', weight: cfg.healthScoreWeightRestingHR, present, value: 0 };
  if (present) c.value = Math.max(bandMembership(cfg.restingHR, meanHR), baselineRelative(meanHR, baselineHR, true, cfg.vitalsImprovementSpan));
  return c;
}

function healthContributorWeight(meanWeight, trailingAvg, present, cfg) {
  const c = { key: HEALTH_KEY_WEIGHT, label: 'Weight stability', weight: cfg.healthScoreWeightBodyweight, present, value: 0 };
  if (present && trailingAvg > 0) {
    const tol = trailingAvg * cfg.healthScoreWeightStabilityPct;
    c.value = rangeMembership(meanWeight, trailingAvg - tol, trailingAvg + tol, tol);
  }
  return c;
}

function healthContributorAdherence(pdc, present, cfg) {
  const c = { key: HEALTH_KEY_ADHERENCE, label: 'Medication adherence', weight: cfg.healthScoreWeightAdherence, present, value: 0 };
  if (present) {
    let target = cfg.healthScoreAdherencePDCTarget;
    if (target <= 0) target = 0.8;
    c.value = rampUp(pdc, target);
  }
  return c;
}

// habitStrength (scoring.go): Loop Habit Tracker EMA over oldest-first
// fractional checkmarks; m = 0.5^(sqrt(frequency)/halfLife).
function habitStrength(checkmarks, frequency, cfg) {
  let halfLife = cfg.habitStrengthHalfLifeDays;
  if (halfLife <= 0) halfLife = 13;
  let freq = frequency;
  if (freq <= 0) freq = 1;
  const m = Math.pow(0.5, Math.sqrt(freq) / halfLife);
  let score = 0;
  for (const ck of checkmarks) score = score * m + clamp01(ck) * (1 - m);
  return score;
}

// ----- substrate read-model helpers (pure, UTC-day math) --------------------
// The Go engine buckets instant-based signals on the UTC-midnight day key
// (scoreday.go utcMidnight) and string-based ones (sleep/daystats) on their own
// local `.day` string. These helpers replicate the UTC bucketing so the JS
// read-models line up with the Go scorers day-for-day.

function msToUTCDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
function utcDayToMs(dayStr) {
  return Date.parse(`${dayStr}T00:00:00Z`);
}
function utcDayUnix(dayStr) {
  return Math.floor(utcDayToMs(dayStr) / 1000);
}
// dayDiff = whole UTC days from a to b (b - a).
function dayDiff(aDay, bDay) {
  return Math.round((utcDayToMs(bDay) - utcDayToMs(aDay)) / DAY_MS);
}

// weekIndex/weekBounds/isWeekEndDay mirror streak.go's Monday-anchored bucketing
// (1970-01-01 was a Thursday, so +3 shifts the boundary onto Monday).
const SECONDS_PER_DAY = 86400;
function weekIndexOf(dayStr) {
  const unixDays = Math.floor(utcDayUnix(dayStr) / SECONDS_PER_DAY);
  return Math.floor((unixDays + 3) / 7);
}
function weekBoundsOf(week) {
  const firstDay = week * 7 - 3;
  return { first: firstDay * SECONDS_PER_DAY, last: (firstDay + 6) * SECONDS_PER_DAY };
}
function isWeekEndDayStr(dayStr) {
  const { last } = weekBoundsOf(weekIndexOf(dayStr));
  return utcDayUnix(dayStr) === last;
}

// sleepOnsetMinutes (wellbeing.go): bedtime instant → minutes-since-previous-noon
// on the local clock, so evening and after-midnight bedtimes share one scale.
function sleepOnsetMinutes(startIso, tzOffsetMin) {
  let off = tzOffsetMin || 0;
  if (off > 900 || off < -900) off = -off / 60; // legacy seconds-east normalize
  const local = new Date(Date.parse(startIso) - off * 60000); // getUTC* on the shifted instant reads local wall-clock
  let minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (local.getUTCHours() < 12) minutes += 24 * 60;
  return minutes;
}

// pctChangePerWeek (gauges.go): trend change over windowDays → %bodyweight/week.
function pctChangePerWeek(nowT, pastT, windowDays) {
  if (pastT === 0) return 0;
  return ((nowT - pastT) / pastT * 100) * 7 / windowDays;
}

// weightPaceStatus / weightAcceleration (gauges.go).
function weightPaceStatus(velocityPctPerWeek, currentTrend, goalWeight, cfg) {
  const atGoal = Number.isFinite(goalWeight)
    && Math.abs(goalWeight - currentTrend) <= Math.abs(currentTrend) * cfg.weightSafePaceMaxPct / 100;
  if (!Number.isFinite(goalWeight) || atGoal) return { status: 'no_goal', direction: 0 };
  const direction = goalWeight < currentTrend ? -1 : 1;
  const toward = velocityPctPerWeek * direction;
  let status;
  if (toward < 0) status = 'wrong_direction';
  else if (toward < cfg.weightSafePaceMinPct) status = 'too_slow';
  else if (toward > cfg.weightSafePaceMaxPct) status = 'too_fast';
  else status = 'on_pace';
  return { status, direction };
}
function weightAcceleration(velNow, velPrev, cfg) {
  const delta = Math.abs(velNow) - Math.abs(velPrev);
  if (delta > cfg.gaugeWeightAccelerationDeadbandPctPerWeek) return 'speeding_up';
  if (delta < -cfg.gaugeWeightAccelerationDeadbandPctPerWeek) return 'slowing';
  return 'holding';
}

// The pure scoring core, exported as a namespace so gamification.substrate.test.js
// can assert Go-parity vectors against it without reaching into the domain factory.
export const scoring = {
  rangeMembership, trapezoid, rampUp, baselineRelative, scaleHP, bandMembership,
  scoreAdherence, scoreBP, scoreSleep, scoreMovement, scoreNourishment, scoreWeight, scoreMind,
  scoreWeightWeekly, scoreBPWeekly, scoreRestingHRWeekly,
  hpToReachLevel, levelForLifetimeHP, insightTierForLevel, nextStreak,
  computeHealthScore, healthContributorBP, healthContributorSleep, healthContributorRestingHR,
  healthContributorWeight, healthContributorAdherence, habitStrength,
};

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
    // .slice(): the listed record is a shared reference under the records-port
    // read-only contract (cloud-mode memoizes and hands out live instances), so
    // markDiscoverySeen must push into a copy, not mutate the cached array in
    // place. Mirrors appendKeystone's keystones.slice() below.
    return Array.isArray(rec && rec.seen_discoveries) ? rec.seen_discoveries.slice() : [];
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

  // =======================================================================
  // Substrate parity read models (med-eyb / design §3.8): HP, rings, level,
  // Health Score, gauges, weekly review — all recomputed on read from vault
  // records via the ported pure scorers above (§4.2: scores are pure functions
  // of the log, nothing persisted but the targets overrides). These reproduce
  // the shapes internal/server/gamification_handlers.go serves so the shared
  // web/static screens (today.js rings, journey.js) render unchanged.
  //
  // ponytail: full-window recompute on every read (365d × scoreOneDay + gauge
  // folds). Fine for one user's data in-browser; add a session memo keyed on the
  // records change-counter only if a real device measurably stutters (design §6.1).
  // =======================================================================

  const SCORING_WINDOW_DAYS = 365; // trailing window folded for lifetime HP (Go backfill cap)
  const SUMMARY_PERIOD_DAYS = 7;
  const HABIT_LOOKBACK_DAYS = 90;
  const HS_MIN_NIGHTS = 5;          // sleepBaselineMinNights (wellbeing.go)
  const BEDTIME_BASELINE_DAYS = 14; // bedtimeBaselineDays (scoreday.go)
  const JOURNEY_HISTORY_DAYS = 90;
  const LEVEL_CURVE_LOOKAHEAD = 5;
  const WEIGHT_SPARKLINE_DAYS = 60;

  const WEIGHT_RECORD_TYPE = 'weight';
  const WEIGHTGOAL_RECORD_TYPE = 'weightgoal';
  const FOODTARGETS_RECORD_TYPE = 'foodtargets';
  const INTAKE_RECORD_TYPE = 'intake';
  const NOTE_RECORD_TYPE = 'note';
  const HR_RECORD_TYPE = 'hrsample';
  const TARGETS_RECORD_TYPE = 'gamificationtargets';
  const TARGETS_RECORD_ID = 'targets';

  // Lever rings (summary.go leverRings): the three surfaced rings, a view-layer
  // regroup of the five ledger rings. Bedtime reads only the Mind ring's sleep
  // award; movement/nourishment read their whole ring.
  const LEVER_RINGS = [
    { key: 'bedtime', ring: RING_MIND, source: METRIC_SLEEP },
    { key: 'movement', ring: RING_MOVEMENT, source: '' },
    { key: 'nourishment', ring: RING_NOURISHMENT, source: '' },
  ];

  // Overridable band-shaped target metrics (scoreday.go TargetKey*), in display
  // order, each mapped to the config band it overlays.
  const TARGET_METRICS = [
    { key: 'bp_systolic', band: 'bpSystolic' },
    { key: 'bp_diastolic', band: 'bpDiastolic' },
    { key: 'resting_hr', band: 'restingHR' },
    { key: 'sleep_hours', band: 'sleepHours' },
    { key: 'steps', band: 'stepsBand' },
    { key: 'bedtime', band: 'bedtimeWindow' },
  ];

  function isResolved(status) {
    return status === 'TAKEN' || status === 'SKIPPED' || status === 'MISSED';
  }

  // readTargets loads the singleton overrides record → array of { metric_key,
  // low_val, high_val, falloff } (nullable fields, mirroring gamstore.Target).
  async function readTargets() {
    const all = await records.list(TARGETS_RECORD_TYPE);
    const rec = all.find((r) => r.recordId === TARGETS_RECORD_ID && !r.deleted);
    return (rec && Array.isArray(rec.targets)) ? rec.targets : [];
  }

  // effectiveConfig overlays the user's stored overrides onto DEFAULT_CONFIG
  // (scoreday.go applyTarget/bandFromTarget). Bedtime keeps low=0 (scoreday.go).
  function applyTarget(cfg, t) {
    const m = TARGET_METRICS.find((x) => x.key === t.metric_key);
    if (!m) return;
    const base = cfg[m.band];
    const b = { low: base.low, high: base.high, falloff: base.falloff };
    if (t.low_val !== null && t.low_val !== undefined) b.low = t.low_val;
    if (t.high_val !== null && t.high_val !== undefined) b.high = t.high_val;
    if (t.falloff !== null && t.falloff !== undefined) b.falloff = t.falloff;
    if (m.key === 'bedtime') b.low = 0;
    cfg[m.band] = b;
  }
  async function effectiveConfig() {
    const cfg = { ...DEFAULT_CONFIG };
    // Deep-copy the bands we may mutate so overrides never leak into DEFAULT_CONFIG.
    for (const m of TARGET_METRICS) cfg[m.band] = { ...DEFAULT_CONFIG[m.band] };
    for (const t of await readTargets()) applyTarget(cfg, t);
    return cfg;
  }

  // buildAdherenceByDay ports loadAdherenceRange: tz_step dedupe, PENDING-past-due
  // miss inference (at most one per overdue slot), bucketed by scheduled UTC day.
  function buildAdherenceByDay(intakes, nowMs) {
    const slotOf = (i) => `${i.medication_id}|${Math.floor(Date.parse(i.scheduled_at) / 1000)}`;
    const shadowed = new Set();
    for (const i of intakes) {
      if ((i.source || 'schedule') === 'tz_step' && isResolved(i.status)) shadowed.add(slotOf(i));
    }
    const deduped = intakes.filter((i) => !((i.source || 'schedule') !== 'tz_step' && shadowed.has(slotOf(i))));
    const resolved = new Set();
    for (const i of deduped) if (isResolved(i.status)) resolved.add(slotOf(i));
    const missedSlots = new Set();
    const byDay = new Map();
    const push = (schedMs, dose) => {
      const day = msToUTCDay(schedMs);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(dose);
    };
    for (const i of deduped) {
      const schedMs = Date.parse(i.scheduled_at);
      if (i.status === 'TAKEN') {
        let mins = 0;
        if (i.taken_at) {
          const d = (Date.parse(i.taken_at) - schedMs) / 60000;
          if (d > 0) mins = Math.floor(d);
        }
        push(schedMs, { status: 'taken', minutesLate: mins });
      } else if (i.status === 'SKIPPED') {
        push(schedMs, { status: 'skipped' });
      } else if (i.status === 'MISSED') {
        push(schedMs, { status: 'missed' });
      } else if (i.status === 'PENDING') {
        const slot = slotOf(i);
        if (schedMs < nowMs && !resolved.has(slot) && !missedSlots.has(slot)) {
          missedSlots.add(slot);
          push(schedMs, { status: 'missed' });
        }
      }
    }
    return byDay;
  }
  // takenExpected (wellbeing.go): a taken dose counts toward both; missed toward
  // expected only; a skip toward neither.
  function takenExpected(doses) {
    let taken = 0; let expected = 0;
    for (const d of (doses || [])) {
      if (d.status === 'taken') { taken += 1; expected += 1; } else if (d.status === 'missed') expected += 1;
    }
    return { taken, expected };
  }

  // hrDailyMin (wellbeing.go dailyMinByDay): per-UTC-day minimum HR sample.
  function buildHRDailyMin(hrRecords) {
    const out = new Map();
    for (const rec of hrRecords) {
      for (const s of (rec.samples || [])) {
        const ms = Date.parse(s.date_time);
        if (Number.isNaN(ms)) continue;
        const day = msToUTCDay(ms);
        const v = s.value;
        if (!out.has(day) || v < out.get(day)) out.set(day, v);
      }
    }
    return out;
  }
  function meanInRange(dailyMap, startDay, endDay) {
    let sum = 0; let n = 0;
    let cur = startDay;
    while (cur <= endDay) {
      if (dailyMap.has(cur)) { sum += dailyMap.get(cur); n += 1; }
      cur = addDays(cur, 1);
    }
    return n === 0 ? { mean: 0, ok: false } : { mean: sum / n, ok: true };
  }

  // buildContext reads every vault type the substrate needs ONCE and derives the
  // per-day maps + raw arrays the scorers and gauges consume.
  async function buildContext(cfg) {
    const nowMs = now();
    const [bpAll, weightAll, weightGoalAll, sleepAll, dayStatsAll, hrAll, foodAll, foodTargetsAll, intakeAll, noteAll, workoutAll] = await Promise.all([
      records.list(BP_RECORD_TYPE), records.list(WEIGHT_RECORD_TYPE), records.list(WEIGHTGOAL_RECORD_TYPE),
      records.list(SLEEP_RECORD_TYPE), records.list(DAYSTATS_RECORD_TYPE), records.list(HR_RECORD_TYPE),
      records.list(FOOD_LOG_RECORD_TYPE), records.list(FOODTARGETS_RECORD_TYPE),
      records.list(INTAKE_RECORD_TYPE), records.list(NOTE_RECORD_TYPE), records.list(WORKOUT_SESSION_RECORD_TYPE),
    ]);

    const bpDays = new Set();
    const bpReadings = [];
    for (const r of bpAll) {
      if (r.deleted) continue;
      const ms = Date.parse(r.measured_at);
      if (!Number.isFinite(ms)) continue;
      bpDays.add(msToUTCDay(ms));
      bpReadings.push(r);
    }

    const weightDays = new Set();
    for (const r of weightAll) {
      if (r.deleted) continue;
      const ms = Date.parse(r.measured_at);
      if (Number.isFinite(ms)) weightDays.add(msToUTCDay(ms));
    }
    const weightLogsDesc = weightAll.filter((r) => !r.deleted && Number.isFinite(Date.parse(r.measured_at)))
      .sort((a, b) => Date.parse(b.measured_at) - Date.parse(a.measured_at));
    const weightGoal = weightGoalAll.filter((r) => !r.deleted)
      .sort((a, b) => Date.parse(b.set_at || 0) - Date.parse(a.set_at || 0))[0];
    const goalWeight = weightGoal && Number.isFinite(weightGoal.target_weight) ? weightGoal.target_weight : NaN;

    // Sleep, keyed by wake-day string; onsetByDay for the regularity baseline.
    const sleepByDay = new Map();
    const onsetByDay = new Map();
    for (const r of sleepAll) {
      if (r.deleted) continue;
      const day = r.day || (r.start_time ? msToUTCDay(Date.parse(r.start_time)) : '');
      if (!day) continue;
      const durationHours = (r.total_minutes !== null && r.total_minutes !== undefined)
        ? r.total_minutes / 60
        : (r.end_time && r.start_time ? (Date.parse(r.end_time) - Date.parse(r.start_time)) / 3600000 : 0);
      const onset = r.start_time ? sleepOnsetMinutes(r.start_time, r.timezone_offset || 0) : null;
      sleepByDay.set(day, { logged: true, durationHours });
      if (onset !== null) onsetByDay.set(day, onset);
    }

    const stepsByDay = new Map();
    for (const r of dayStatsAll) {
      if (r.deleted || !r.day) continue;
      stepsByDay.set(r.day, r.steps || 0);
    }

    // Completed workouts: per-day flag + a session list (instant, durationMin)
    // for the trailing-7d WHO activity minutes.
    const workoutDays = new Set();
    const sessions = [];
    for (const r of workoutAll) {
      if (r.deleted || r.status !== 'completed') continue;
      const instantMs = r.completed_at ? Date.parse(r.completed_at)
        : (r.scheduled_date ? Date.parse(`${String(r.scheduled_date).slice(0, 10)}T12:00:00Z`) : NaN);
      if (!Number.isFinite(instantMs)) continue;
      const day = r.completed_at ? msToUTCDay(instantMs) : String(r.scheduled_date).slice(0, 10);
      workoutDays.add(day);
      let durationMin = 0;
      if (r.started_at && r.completed_at) {
        const d = (Date.parse(r.completed_at) - Date.parse(r.started_at)) / 60000;
        if (d > 0) durationMin = d;
      }
      sessions.push({ instantMs, durationMin });
    }

    const foodByDay = new Map();
    for (const r of foodAll) {
      if (r.deleted) continue;
      const ms = Date.parse(r.eaten_at);
      if (!Number.isFinite(ms)) continue;
      const day = msToUTCDay(ms);
      const cur = foodByDay.get(day) || { logged: false, calories: 0, protein: 0 };
      cur.logged = true;
      cur.calories += r.calories || 0;
      cur.protein += r.protein || 0;
      foodByDay.set(day, cur);
    }
    const ftRec = foodTargetsAll.find((r) => r.recordId === 'foodtargets' && !r.deleted);
    const foodTargets = { calories: (ftRec && ftRec.calories) || 0, protein: (ftRec && ftRec.protein) || 0 };

    const diaryByDay = new Map();
    for (const r of noteAll) {
      if (r.deleted) continue;
      const ms = Date.parse(r.created_at);
      if (!Number.isFinite(ms)) continue;
      const day = msToUTCDay(ms);
      diaryByDay.set(day, (diaryByDay.get(day) || 0) + 1);
    }

    const adherenceByDay = buildAdherenceByDay(intakeAll.filter((r) => !r.deleted), nowMs);
    const hrDailyMin = buildHRDailyMin(hrAll.filter((r) => !r.deleted));

    return {
      nowMs, bpDays, weightDays, weightLogsDesc, goalWeight,
      sleepByDay, onsetByDay, stepsByDay, workoutDays, sessions,
      foodByDay, foodTargets, diaryByDay, adherenceByDay, hrDailyMin,
      _bpReadings: bpReadings,
    };
  }

  // sleepInputFor derives ScoreSleep's SleepDay for a wake-day: logged + the
  // regularity deviation vs the trailing-14d median onset (≥5 nights), matching
  // loadSleep/medianBedtimeOnset.
  function sleepInputFor(ctx, dayStr) {
    const s = ctx.sleepByDay.get(dayStr);
    if (!s) return { logged: false };
    const onset = ctx.onsetByDay.get(dayStr);
    const out = { logged: true, durationHours: s.durationHours };
    if (onset === undefined) return out;
    const baselineStart = addDays(dayStr, -BEDTIME_BASELINE_DAYS);
    const onsets = [];
    for (const [d, o] of ctx.onsetByDay) {
      if (d >= baselineStart && d < dayStr) onsets.push(o);
    }
    if (onsets.length >= HS_MIN_NIGHTS) {
      out.hasRegularity = true;
      out.timingDeviationMin = onset - medianOf(onsets);
    }
    return out;
  }

  function movementInputFor(ctx, dayStr) {
    const out = { hasSteps: false, steps: 0, workoutLogged: ctx.workoutDays.has(dayStr), hasActivity: false, weeklyActivityMinutes: 0 };
    if (ctx.stepsByDay.has(dayStr)) { out.hasSteps = true; out.steps = ctx.stepsByDay.get(dayStr); }
    const weekStartMs = utcDayToMs(addDays(dayStr, -6));
    const endMs = utcDayToMs(addDays(dayStr, 1));
    let weekMin = 0;
    for (const s of ctx.sessions) {
      if (s.instantMs >= weekStartMs && s.instantMs < endMs) weekMin += s.durationMin;
    }
    if (weekMin > 0) { out.hasActivity = true; out.weeklyActivityMinutes = weekMin; }
    return out;
  }

  function nourishmentInputFor(ctx, dayStr) {
    const f = ctx.foodByDay.get(dayStr) || { logged: false, calories: 0, protein: 0 };
    return {
      logged: f.logged, calories: f.calories, protein: f.protein,
      calorieTarget: ctx.foodTargets.calories, proteinTarget: ctx.foodTargets.protein,
      calorieFloor: 0, vegServings: 0, vegTarget: 0,
    };
  }

  // scoreOneDay runs every daily scorer for a day, plus the weekly gauge awards
  // on a week-end day (scoreDayAwards). A future day (> today) scores ONLY the
  // weekly gauge award on a week-end and nothing else (the Go read-path rule).
  function scoreOneDay(ctx, dayStr, todayStr, cfg) {
    let awards = [];
    const weekEnd = isWeekEndDayStr(dayStr);
    if (dayStr > todayStr) {
      if (weekEnd) awards = awards.concat(weeklyGaugeAwardsAt(ctx, dayStr, cfg));
      return awards;
    }
    awards = awards.concat(scoreAdherence(ctx.adherenceByDay.get(dayStr) || [], cfg));
    awards = awards.concat(scoreBP(ctx.bpDays.has(dayStr), cfg));
    awards = awards.concat(scoreSleep(sleepInputFor(ctx, dayStr), cfg));
    awards = awards.concat(scoreMovement(movementInputFor(ctx, dayStr), cfg));
    awards = awards.concat(scoreNourishment(nourishmentInputFor(ctx, dayStr), cfg));
    awards = awards.concat(scoreWeight(ctx.weightDays.has(dayStr), cfg));
    awards = awards.concat(scoreMind({ journaledEntries: ctx.diaryByDay.get(dayStr) || 0 }, cfg));
    if (weekEnd) awards = awards.concat(weeklyGaugeAwardsAt(ctx, dayStr, cfg));
    return awards;
  }

  // ----- gauges (gauges.go), computed as-of an arbitrary `todayStr` -----------

  function computeWeightGaugeAt(ctx, todayStr, cfg) {
    const startStr = addDays(todayStr, -(cfg.gaugeWeightLookbackDays - 1));
    const startMs = utcDayToMs(startStr);
    const windowEndMs = utcDayToMs(addDays(todayStr, 1));
    const byDay = new Map();
    let earliestMs = null; let latestMs = null;
    for (const r of ctx.weightLogsDesc) { // measured_at DESC → first-seen per day is latest
      const ms = Date.parse(r.measured_at);
      if (ms >= windowEndMs || ms < startMs) continue;
      const day = msToUTCDay(ms);
      if (!byDay.has(day)) byDay.set(day, r.weight);
      if (earliestMs === null || ms < earliestMs) earliestMs = ms;
      if (latestMs === null || ms > latestMs) latestMs = ms;
    }
    if (earliestMs === null || dayDiff(msToUTCDay(earliestMs), todayStr) < cfg.gaugeWeightMinHistoryDays) {
      return { status: 'insufficient_data' };
    }
    if (dayDiff(msToUTCDay(latestMs), todayStr) > cfg.gaugeWeightVelocityWindowDays) {
      return { status: 'insufficient_data' };
    }
    const trend = new Map();
    let current = 0; let have = false;
    let d = startStr;
    while (d <= todayStr) {
      if (byDay.has(d)) {
        const w = byDay.get(d);
        if (!have) { current = w; have = true; } else current += cfg.gaugeWeightEMAAlpha * (w - current);
      }
      trend.set(d, current);
      d = addDays(d, 1);
    }
    const velDays = cfg.gaugeWeightVelocityWindowDays;
    const nowTrend = trend.get(todayStr);
    const pastTrend = trend.get(addDays(todayStr, -velDays)) || 0;
    const velocity = pctChangePerWeek(nowTrend, pastTrend, velDays);
    const prevPast = trend.get(addDays(todayStr, -2 * velDays)) || 0;
    const prevVelocity = pctChangePerWeek(pastTrend, prevPast, velDays);
    const { status: paceStatus, direction } = weightPaceStatus(velocity, nowTrend, ctx.goalWeight, cfg);

    // sparkline: first real weigh-in, clamped to the trailing 60d window.
    let histStart = startStr;
    const earlyDay = msToUTCDay(earliestMs);
    if (earlyDay > histStart) histStart = earlyDay;
    const cutoff = addDays(todayStr, -(WEIGHT_SPARKLINE_DAYS - 1));
    if (cutoff > histStart) histStart = cutoff;
    const trendHistory = [];
    let h = histStart;
    while (h <= todayStr) { trendHistory.push(trend.get(h) || 0); h = addDays(h, 1); }

    return {
      status: 'ok', trend_weight: nowTrend, velocity_pct_per_week: velocity,
      pace_status: paceStatus, acceleration: weightAcceleration(velocity, prevVelocity, cfg),
      goal_direction: direction, trend_history: trendHistory,
    };
  }

  function computeBPGaugeAt(ctx, bpReadings, todayStr, cfg) {
    const baselineStartMs = utcDayToMs(addDays(todayStr, -(cfg.gaugeBPBaselineWindowDays - 1)));
    const midStartMs = utcDayToMs(addDays(todayStr, -(cfg.gaugeBPMidWindowDays - 1)));
    const recentStartMs = utcDayToMs(addDays(todayStr, -(cfg.gaugeBPRecentWindowDays - 1)));
    const windowEndMs = utcDayToMs(addDays(todayStr, 1));
    let n14 = 0; let in14 = 0; let n30 = 0; let in30 = 0; let n60 = 0; let in60 = 0;
    for (const r of bpReadings) {
      const ms = Date.parse(r.measured_at);
      if (r.ignore_calc || ms >= windowEndMs || ms < baselineStartMs) continue;
      const inBand = cfg.bpSystolic.low <= r.systolic && r.systolic <= cfg.bpSystolic.high
        && cfg.bpDiastolic.low <= r.diastolic && r.diastolic <= cfg.bpDiastolic.high;
      n60 += 1; if (inBand) in60 += 1;
      if (ms >= midStartMs) { n30 += 1; if (inBand) in30 += 1; }
      if (ms >= recentStartMs) { n14 += 1; if (inBand) in14 += 1; }
    }
    if (n60 < cfg.gaugeBPMinBaselineReadings) return { status: 'insufficient_data', count_14d: 0, count_30d: 0, count_60d: n60 };
    const view = { status: 'ok', count_14d: n14, count_30d: n30, count_60d: n60, baseline_share_60d: in60 / n60 };
    if (n14 > 0) view.share_14d = in14 / n14;
    if (n30 > 0) view.share_30d = in30 / n30;
    return view;
  }

  function computeRestingHRGaugeAt(ctx, todayStr, cfg) {
    const baselineStart = addDays(todayStr, -(cfg.gaugeRestingHRBaselineWindowDays - 1));
    const recentStart = addDays(todayStr, -(cfg.gaugeRestingHRRecentWindowDays - 1));
    const recent = meanInRange(ctx.hrDailyMin, recentStart, todayStr);
    if (!recent.ok) return { status: 'insufficient_data' };
    const baselineEnd = addDays(recentStart, -1);
    let baselineDays = 0;
    let d = baselineStart;
    while (d <= baselineEnd) { if (ctx.hrDailyMin.has(d)) baselineDays += 1; d = addDays(d, 1); }
    if (baselineDays < cfg.gaugeRestingHRMinBaselineDays) return { status: 'insufficient_data' };
    const baseline = meanInRange(ctx.hrDailyMin, baselineStart, baselineEnd);
    return {
      status: 'ok', recent_14d_mean: recent.mean, baseline_60d_mean: baseline.mean,
      delta_from_baseline: recent.mean - baseline.mean,
    };
  }

  function weeklyGaugeAwardsAt(ctx, dayStr, cfg) {
    let awards = [];
    const w = computeWeightGaugeAt(ctx, dayStr, cfg);
    if (w.status === 'ok') {
      awards = awards.concat(scoreWeightWeekly({ hasData: true, velocityPctPerWeek: w.velocity_pct_per_week, goalDirection: w.goal_direction }, cfg));
    }
    const bp = computeBPGaugeAt(ctx, ctx._bpReadings || [], dayStr, cfg);
    if (bp.status === 'ok' && bp.count_30d > 0) {
      awards = awards.concat(scoreBPWeekly({ hasData: true, share30d: bp.share_30d || 0, baselineShare60d: bp.baseline_share_60d || 0 }, cfg));
    }
    const hr = computeRestingHRGaugeAt(ctx, dayStr, cfg);
    if (hr.status === 'ok') {
      awards = awards.concat(scoreRestingHRWeekly({ hasData: true, deltaFromBaseline: hr.delta_from_baseline }, cfg));
    }
    return awards;
  }

  // ----- health score + strengths (wellbeing.go) ------------------------------

  function healthScoreContributors(ctx, bpReadings, todayStr, cfg) {
    // BP: recent-window mean of non-ignored readings.
    const bpRecentStartMs = utcDayToMs(addDays(todayStr, -(cfg.healthScoreWindowDays - 1)));
    const windowEndMs = utcDayToMs(addDays(todayStr, 1));
    let sumSys = 0; let sumDia = 0; let nBP = 0;
    for (const r of bpReadings) {
      const ms = Date.parse(r.measured_at);
      if (r.ignore_calc || ms >= windowEndMs || ms < bpRecentStartMs) continue;
      sumSys += r.systolic; sumDia += r.diastolic; nBP += 1;
    }
    const bp = nBP === 0 ? healthContributorBP(0, 0, false, cfg) : healthContributorBP(sumSys / nBP, sumDia / nBP, true, cfg);

    // Sleep: recent duration mean + deviation vs baseline mean onset.
    const recentStartStr = addDays(todayStr, -(cfg.healthScoreWindowDays - 1));
    const baselineStartStr = addDays(todayStr, -(cfg.healthScoreBaselineDays - 1));
    const recentDur = []; const recentOnsets = []; const baselineOnsets = [];
    for (const [day, s] of ctx.sleepByDay) {
      if (day < baselineStartStr || day > todayStr) continue;
      const onset = ctx.onsetByDay.get(day);
      if (onset !== undefined) baselineOnsets.push(onset);
      if (day >= recentStartStr) {
        recentDur.push(s.durationHours);
        if (onset !== undefined) recentOnsets.push(onset);
      }
    }
    let sleep;
    if (recentDur.length === 0) sleep = healthContributorSleep(0, 0, false, false, cfg);
    else {
      const hasReg = baselineOnsets.length >= HS_MIN_NIGHTS;
      let meanDev = 0;
      if (hasReg) {
        const baseAvg = meanOr0(baselineOnsets);
        meanDev = meanOr0(recentOnsets.map((o) => Math.abs(o - baseAvg)));
      }
      sleep = healthContributorSleep(meanOr0(recentDur), meanDev, hasReg, true, cfg);
    }

    // Resting HR: recent mean vs strictly-prior baseline mean.
    const hrBaselineStart = addDays(todayStr, -(cfg.healthScoreBaselineDays - 1));
    const hrRecentStart = addDays(todayStr, -(cfg.healthScoreWindowDays - 1));
    const hrRecent = meanInRange(ctx.hrDailyMin, hrRecentStart, todayStr);
    let hr;
    if (!hrRecent.ok) hr = healthContributorRestingHR(0, 0, false, cfg);
    else {
      const hrBaseline = meanInRange(ctx.hrDailyMin, hrBaselineStart, addDays(hrRecentStart, -1));
      hr = healthContributorRestingHR(hrRecent.mean, hrBaseline.ok ? hrBaseline.mean : 0, true, cfg);
    }

    // Weight: recent mean vs strictly-prior trailing mean.
    const wRecentStartMs = utcDayToMs(addDays(todayStr, -(cfg.healthScoreWindowDays - 1)));
    const wBaselineStartMs = utcDayToMs(addDays(todayStr, -(cfg.healthScoreBaselineDays - 1)));
    let rSum = 0; let rN = 0; let pSum = 0; let pN = 0;
    for (const r of ctx.weightLogsDesc) {
      const ms = Date.parse(r.measured_at);
      if (ms >= windowEndMs || ms < wBaselineStartMs) continue;
      if (ms >= wRecentStartMs) { rSum += r.weight; rN += 1; } else { pSum += r.weight; pN += 1; }
    }
    const weight = (rN === 0 || pN === 0) ? healthContributorWeight(0, 0, false, cfg) : healthContributorWeight(rSum / rN, pSum / pN, true, cfg);

    // Adherence: recent-window PDC (covered days / expected days).
    const aStart = addDays(todayStr, -(cfg.healthScoreWindowDays - 1));
    let covered = 0; let expectedDays = 0;
    let d = aStart;
    while (d <= todayStr) {
      const doses = ctx.adherenceByDay.get(d);
      if (doses) {
        const te = takenExpected(doses);
        if (te.expected > 0) { expectedDays += 1; if (te.taken > 0) covered += 1; }
      }
      d = addDays(d, 1);
    }
    const adherence = expectedDays === 0 ? healthContributorAdherence(0, false, cfg) : healthContributorAdherence(covered / expectedDays, true, cfg);

    return [bp, sleep, hr, weight, adherence];
  }

  function healthScoreView(ctx, bpReadings, todayStr, cfg) {
    const res = computeHealthScore(healthScoreContributors(ctx, bpReadings, todayStr, cfg), cfg);
    return {
      value: res.score,
      contributors: res.contributors.map((c) => ({ key: c.key, label: c.label, score: c.value, weight: c.weight, missing: !c.present })),
      missing: res.missing,
    };
  }

  function adherenceAlertView(ctx, todayStr, cfg) {
    const aStart = addDays(todayStr, -(cfg.healthScoreWindowDays - 1));
    let taken = 0; let expected = 0;
    let d = aStart;
    while (d <= todayStr) {
      const doses = ctx.adherenceByDay.get(d);
      if (doses) { const te = takenExpected(doses); taken += te.taken; expected += te.expected; }
      d = addDays(d, 1);
    }
    if (expected === 0) return { active: false, pdc: 0, missed_doses: 0 };
    const pdc = taken / expected;
    return { active: pdc < cfg.adherenceAlertPDCThreshold, pdc, missed_doses: expected - taken };
  }

  function strengthsView(ctx, bpReadings, todayStr, cfg) {
    const start = addDays(todayStr, -(HABIT_LOOKBACK_DAYS - 1));
    // meds
    const medMarks = [];
    let d = start;
    while (d <= todayStr) {
      const doses = ctx.adherenceByDay.get(d);
      if (doses) { const te = takenExpected(doses); if (te.expected > 0) medMarks.push(te.taken / te.expected); }
      d = addDays(d, 1);
    }
    const meds = { key: 'meds', label: 'Medication', value: habitStrength(medMarks, 1, cfg), frequency: 1 };
    // movement: implicit checkmark = min(1, workouts_in_trailing_7d/3)
    const movMarks = [];
    d = start;
    while (d <= todayStr) {
      let count = 0;
      for (let k = 0; k < 7; k += 1) if (ctx.workoutDays.has(addDays(d, -k))) count += 1;
      movMarks.push(Math.min(1, count / 3));
      d = addDays(d, 1);
    }
    const movement = { key: 'movement', label: 'Movement', value: habitStrength(movMarks, 3 / 7, cfg), frequency: 3 / 7 };
    // measurement: any bp/weight/food that day
    const foodDays = new Set(ctx.foodByDay.keys());
    const meaMarks = [];
    d = start;
    while (d <= todayStr) {
      meaMarks.push((ctx.bpDays.has(d) || ctx.weightDays.has(d) || foodDays.has(d)) ? 1 : 0);
      d = addDays(d, 1);
    }
    const measurement = { key: 'measurement', label: 'Measurement', value: habitStrength(meaMarks, 1, cfg), frequency: 1 };
    return [meds, movement, measurement];
  }

  // ----- ring aggregation (summary.go ringScores) -----------------------------

  function ringScoresFrom(awards, withProgress) {
    const hp = {}; const closed = {}; const progress = {};
    for (const a of awards) {
      if (a.r !== undefined && a.r > (progress[a.ring] || 0)) progress[a.ring] = a.r;
      for (const lv of LEVER_RINGS) {
        if (a.ring !== lv.ring || (lv.source !== '' && a.source !== lv.source)) continue;
        hp[lv.key] = (hp[lv.key] || 0) + a.hp;
        if (a.kind !== KIND_FLOOR) closed[lv.key] = true;
        break;
      }
    }
    return LEVER_RINGS.map((lv) => {
      let p = 0;
      if (withProgress) p = closed[lv.key] ? 1 : (progress[lv.ring] || 0);
      return { ring: lv.key, hp: hp[lv.key] || 0, closed: !!closed[lv.key], progress: p };
    });
  }

  // scoreWindow folds the trailing window into per-day awards + weekly HP sums.
  // Returns { byDay: Map<dayStr, awards[]>, lifetimeHP, weekHP: Map<week,hp> }.
  function scoreWindow(ctx, cfg) {
    const todayStr = msToUTCDay(ctx.nowMs);
    const startStr = addDays(todayStr, -(SCORING_WINDOW_DAYS - 1));
    // Include the current week's end day so an in-progress week's gauge award is
    // present in lifetime HP (the Go read-path RescoreInstants rule).
    const { last } = weekBoundsOf(weekIndexOf(todayStr));
    let endStr = todayStr;
    const weekEndStr = msToUTCDay(last * 1000);
    if (weekEndStr > endStr) endStr = weekEndStr;
    const byDay = new Map();
    const weekHP = new Map();
    let lifetimeHP = 0;
    let d = startStr;
    while (d <= endStr) {
      const awards = scoreOneDay(ctx, d, todayStr, cfg);
      byDay.set(d, awards);
      let dayHP = 0;
      for (const a of awards) dayHP += a.hp;
      lifetimeHP += dayHP;
      if (d <= todayStr && dayHP > 0) {
        const w = weekIndexOf(d);
        weekHP.set(w, (weekHP.get(w) || 0) + dayHP);
      }
      d = addDays(d, 1);
    }
    return { byDay, lifetimeHP, weekHP, todayStr, startStr };
  }

  // deriveStreak (streak.go): fold NextStreak oldest-first over completed weeks.
  function deriveStreak(weekHP, todayStr, cfg) {
    const lastComplete = weekIndexOf(todayStr) - 1;
    const weeks = [...weekHP.keys()].filter((w) => w <= lastComplete).sort((a, b) => a - b);
    if (weeks.length === 0) return { streak: 0, freezes: 0, longest: 0 };
    let st = { currentStreak: 0, freezes: 0 };
    let longest = 0;
    for (let w = weeks[0]; w <= lastComplete; w += 1) {
      st = nextStreak(st, (weekHP.get(w) || 0) > 0, cfg);
      if (st.currentStreak > longest) longest = st.currentStreak;
    }
    return { streak: st.currentStreak, freezes: st.freezes, longest };
  }

  async function loadForRead() {
    const cfg = await effectiveConfig();
    const ctx = await buildContext(cfg); // ctx._bpReadings stashed inside for gauges/health-score
    return { cfg, ctx };
  }

  // buildSummary is the shared core of getSummary / getRings / getJourney.
  function buildSummary(ctx, cfg) {
    const scored = scoreWindow(ctx, cfg);
    const { lifetimeHP, todayStr } = scored;
    const level = levelForLifetimeHP(lifetimeHP, cfg);
    const tier = insightTierForLevel(level, cfg);
    const floor = hpToReachLevel(level, cfg);
    const next = hpToReachLevel(level + 1, cfg);

    const todayAwards = scored.byDay.get(todayStr) || [];
    const periodAwards = [];
    let pd = addDays(todayStr, -(SUMMARY_PERIOD_DAYS - 1));
    while (pd <= todayStr) { periodAwards.push(...(scored.byDay.get(pd) || [])); pd = addDays(pd, 1); }

    const todayRings = ringScoresFrom(todayAwards, true);
    let todayHP = 0;
    for (const r of todayRings) todayHP += r.hp;

    const strk = deriveStreak(scored.weekHP, todayStr, cfg);

    return {
      summary: {
        enabled: true,
        lifetime_hp: lifetimeHP,
        level,
        insight_tier: tier,
        hp_into_level: Math.max(0, lifetimeHP - floor),
        level_span_hp: next - floor,
        hp_to_next_level: Math.max(0, next - lifetimeHP),
        current_streak: strk.streak,
        longest_streak: strk.longest,
        freezes: strk.freezes,
        today_hp: todayHP,
        today_rings: todayRings,
        period_days: SUMMARY_PERIOD_DAYS,
        period_rings: ringScoresFrom(periodAwards, false),
        health_score: healthScoreView(ctx, ctx._bpReadings, todayStr, cfg),
        strengths: strengthsView(ctx, ctx._bpReadings, todayStr, cfg),
        adherence_alert: adherenceAlertView(ctx, todayStr, cfg),
      },
      scored, todayStr, level, tier,
    };
  }

  async function getSummary() {
    const { cfg, ctx } = await loadForRead();
    return buildSummary(ctx, cfg).summary;
  }

  async function getRings() {
    const { cfg, ctx } = await loadForRead();
    const { summary } = buildSummary(ctx, cfg);
    return {
      enabled: true,
      level: summary.level,
      today_hp: summary.today_hp,
      rings: summary.today_rings,
      health_score: summary.health_score,
      adherence_alert: summary.adherence_alert,
    };
  }

  async function getJourney() {
    const { cfg, ctx } = await loadForRead();
    const built = buildSummary(ctx, cfg);
    const { summary, scored, todayStr, level, tier } = built;
    const start = addDays(todayStr, -(JOURNEY_HISTORY_DAYS - 1));
    const hpHistory = [];
    let d = start;
    while (d <= todayStr) {
      const awards = scored.byDay.get(d);
      if (awards && awards.length) {
        let hp = 0; for (const a of awards) hp += a.hp;
        if (hp > 0) hpHistory.push({ day_unix: utcDayUnix(d), hp });
      }
      d = addDays(d, 1);
    }
    const unlockedTiers = [];
    for (let t = 1; t <= tier; t += 1) unlockedTiers.push(t);
    let curveTop = level + LEVEL_CURVE_LOOKAHEAD;
    if (curveTop > cfg.levelMax) curveTop = cfg.levelMax;
    const levelCurve = [];
    for (let lv = 1; lv <= curveTop; lv += 1) levelCurve.push({ level: lv, hp_to_reach: hpToReachLevel(lv, cfg) });
    return { ...summary, hp_history: hpHistory, unlocked_tiers: unlockedTiers, level_curve: levelCurve };
  }

  async function getGauges() {
    const { cfg, ctx } = await loadForRead();
    const todayStr = msToUTCDay(ctx.nowMs);
    const weight = computeWeightGaugeAt(ctx, todayStr, cfg);
    delete weight.goal_direction; // internal-only (json:"-" in Go)
    return {
      enabled: true,
      weight,
      bp: computeBPGaugeAt(ctx, ctx._bpReadings, todayStr, cfg),
      resting_hr: computeRestingHRGaugeAt(ctx, todayStr, cfg),
    };
  }

  // getWeeklyReview ports weekly.go: this-week vs last-week lever closes, best
  // day, strengths now/prior, gauges (+ bp 30d share a week ago), health score
  // now/prior — anchored on the ISO week containing now().
  async function getWeeklyReview() {
    const { cfg, ctx } = await loadForRead();
    const scored = scoreWindow(ctx, cfg);
    const todayStr = scored.todayStr;
    const week = weekIndexOf(todayStr);
    const thisB = weekBoundsOf(week);
    const priorB = weekBoundsOf(week - 1);

    // closed days per lever within a [firstUnix,lastUnix] week from scored awards.
    const closedDaysByLever = (firstUnix, lastUnix) => {
      const out = {}; for (const lv of LEVER_RINGS) out[lv.key] = new Set();
      let d = msToUTCDay(firstUnix * 1000);
      const endDay = msToUTCDay(lastUnix * 1000);
      while (d <= endDay) {
        for (const a of (scored.byDay.get(d) || [])) {
          if (a.kind === KIND_FLOOR) continue;
          for (const lv of LEVER_RINGS) {
            if (a.ring !== lv.ring || (lv.source !== '' && a.source !== lv.source)) continue;
            out[lv.key].add(d); break;
          }
        }
        d = addDays(d, 1);
      }
      return out;
    };
    const thisClosed = closedDaysByLever(thisB.first, thisB.last);
    const lastClosed = closedDaysByLever(priorB.first, priorB.last);
    const levers = LEVER_RINGS.map((lv) => ({
      key: lv.key, closed_this_week: thisClosed[lv.key].size, closed_last_week: lastClosed[lv.key].size,
    }));

    // days with any HP this week + best day (most levers closed).
    const hpDays = new Set();
    const closedByDay = new Map();
    let dd = msToUTCDay(thisB.first * 1000);
    const weekEndDay = msToUTCDay(thisB.last * 1000);
    while (dd <= weekEndDay) {
      const awards = scored.byDay.get(dd) || [];
      let hp = 0; for (const a of awards) hp += a.hp;
      if (hp > 0) hpDays.add(dd);
      let n = 0; for (const lv of LEVER_RINGS) if (thisClosed[lv.key].has(dd)) n += 1;
      if (n > 0) closedByDay.set(dd, n);
      dd = addDays(dd, 1);
    }
    let bestDay = null;
    for (const [day, count] of closedByDay) {
      if (!bestDay || count > bestDay.rings_closed || (count === bestDay.rings_closed && utcDayUnix(day) < bestDay.day_unix)) {
        bestDay = { day_unix: utcDayUnix(day), rings_closed: count };
      }
    }

    const weekAgo = addDays(todayStr, -7);
    const sNow = strengthsView(ctx, ctx._bpReadings, todayStr, cfg);
    const sPrior = strengthsView(ctx, ctx._bpReadings, weekAgo, cfg);
    const strengths = sNow.map((s, i) => ({ key: s.key, label: s.label, value_now: s.value, value_prior: (sPrior[i] && sPrior[i].value) || 0 }));

    const weight = computeWeightGaugeAt(ctx, todayStr, cfg); delete weight.goal_direction;
    const bp = computeBPGaugeAt(ctx, ctx._bpReadings, todayStr, cfg);
    const bpPrior = computeBPGaugeAt(ctx, ctx._bpReadings, weekAgo, cfg);
    const hr = computeRestingHRGaugeAt(ctx, todayStr, cfg);
    const bpSharePrior = bpPrior.status === 'ok' ? (bpPrior.share_30d || 0) : 0;

    const hsNow = healthScoreView(ctx, ctx._bpReadings, todayStr, cfg);
    const hsPrior = healthScoreView(ctx, ctx._bpReadings, weekAgo, cfg);

    return {
      enabled: true,
      quiet: hpDays.size === 0,
      week_start: thisB.first,
      week_end: thisB.last,
      days_with_any_hp: hpDays.size,
      levers,
      best_day: bestDay,
      strengths,
      gauges: { weight, bp, bp_share_30d_prior: bpSharePrior, resting_hr: hr },
      health_score: { now: hsNow, prior: hsPrior },
    };
  }

  // ----- targets CRUD (targets.go) --------------------------------------------

  function effectiveTargetsView(overrides, cfg) {
    const custom = new Set(overrides.map((t) => t.metric_key));
    const eff = { ...DEFAULT_CONFIG };
    for (const m of TARGET_METRICS) eff[m.band] = { ...DEFAULT_CONFIG[m.band] };
    for (const t of overrides) applyTarget(eff, t);
    const out = TARGET_METRICS.map((m) => {
      const rec = DEFAULT_CONFIG[m.band];
      const cur = eff[m.band];
      return {
        metric_key: m.key,
        low: cur.low, high: cur.high, falloff: cur.falloff,
        recommended_low: rec.low, recommended_high: rec.high, recommended_falloff: rec.falloff,
        is_custom: custom.has(m.key), is_recommended: !custom.has(m.key),
      };
    });
    return { enabled: true, targets: out };
  }

  async function getTargets() {
    return effectiveTargetsView(await readTargets(), DEFAULT_CONFIG);
  }

  // putTargets validates + persists a batch (targets.go SetTargets): an item with
  // all band fields null is a RESET (drop the override); an unknown key or an
  // incoherent merged band rejects the whole batch. Overrides live on one
  // singleton record.
  function validateTarget(t) {
    if (!TARGET_METRICS.some((m) => m.key === t.metric_key)) return 'unknown_metric';
    if (t.low_val != null && t.low_val < 0) return 'invalid_band';
    if (t.high_val != null && t.high_val < 0) return 'invalid_band';
    if (t.low_val != null && t.high_val != null && t.low_val > t.high_val) return 'invalid_band';
    if (t.falloff != null && t.falloff < 0) return 'invalid_band';
    const m = TARGET_METRICS.find((x) => x.key === t.metric_key);
    const base = DEFAULT_CONFIG[m.band];
    const high = t.high_val != null ? t.high_val : base.high;
    const low = t.low_val != null ? t.low_val : base.low;
    if (high < low) return 'invalid_band';
    return null;
  }
  async function putTargets(body) {
    const incoming = (body && Array.isArray(body.targets)) ? body.targets : [];
    for (const t of incoming) {
      const err = validateTarget(t);
      if (err) return { ok: false, error: err };
    }
    const current = await readTargets();
    const byKey = new Map(current.map((t) => [t.metric_key, t]));
    for (const t of incoming) {
      const isReset = (t.low_val == null && t.high_val == null && t.falloff == null);
      if (isReset) byKey.delete(t.metric_key);
      else {
        byKey.set(t.metric_key, {
          metric_key: t.metric_key,
          low_val: t.low_val != null ? t.low_val : null,
          high_val: t.high_val != null ? t.high_val : null,
          falloff: t.falloff != null ? t.falloff : null,
        });
      }
    }
    const merged = [...byKey.values()];
    await records.put(TARGETS_RECORD_TYPE, {
      recordId: TARGETS_RECORD_ID, deleted: false, clientTs: now(), targets: merged,
    });
    return effectiveTargetsView(merged, DEFAULT_CONFIG);
  }

  return {
    getAtlas, markDiscoverySeen, getForecast,
    listExperiments, startExperiment, cancelExperiment,
    getChapter, startChapter, closeChapter,
    getTraits, getKeystones,
    // substrate parity (med-eyb)
    getSummary, getRings, getJourney, getGauges, getWeeklyReview,
    getTargets, putTargets,
  };
}
