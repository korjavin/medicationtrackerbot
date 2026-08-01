// Runtime-agnostic workout strength-analysis domain module (Phase 3, epic
// med-qj4, bead med-qj4.3.1). Pure compute-on-read over the immutable per-set
// data landed in Phase 1 — no storage, no migration. Kept free of browser
// globals (window/document/fetch/IndexedDB) so the same source can run inside
// the Go server via goja (C6); purity enforced by architecture.domain-purity.test.js.
//
// A "log" here is an exerciselog response (toLogResponse in web/domain/workout.js)
// carrying `sets:[{set_index, weight_kg, reps, rpe?, set_type}]`, plus a `date`
// added by listExerciseLogsByName (the log's session scheduled_date). Warm-up
// sets (`set_type==='warmup'`) are excluded from every fold — they aren't
// strength-signal.

import { normalizeGoal, rirFromRpe, NEAR_FAILURE_RIR } from './workout-goals.js';

// Re-exported for the callers (and tests) that have always read the threshold
// from here; the definition moved down to workout-goals.js so the stats fold in
// workout.js can share it without an import cycle (med-vov).
export { NEAR_FAILURE_RIR };

// Epley: estimated 1-rep max from a weight lifted for `reps`. Rounded to 2dp for
// display stability. reps/weight ≤ 0 → 0 (not a real working set).
export function estimated1RM(weight, reps) {
  if (!(weight > 0) || !(reps > 0)) return 0;
  return Math.round(weight * (1 + reps / 30) * 100) / 100;
}

// Epley/Brzycki are fitted to low-rep sets and drift badly past ~10-12 reps — a
// "1RM" back-computed from a 20-rep set is a guess, not a measurement. Callers
// carry the rep count that produced an est-1RM so the UI can say so instead of
// presenting the number bare (med-qj4.6.4).
export const EST_1RM_CONFIDENT_MAX_REPS = 12;

export function est1RMLowConfidence(reps) {
  return Number(reps) > EST_1RM_CONFIDENT_MAX_REPS;
}

// nonWarmup returns a log's working sets (warm-ups dropped, absent → []).
function nonWarmup(log) {
  const sets = log && log.sets;
  if (!Array.isArray(sets)) return [];
  return sets.filter((s) => s && s.set_type !== 'warmup');
}

// exercisePRs folds over the non-warmup sets across a list of logs and returns
// the personal records: heaviest weight, best est-1RM, best single-set volume
// (weight×reps), best session volume (Σ over one log's working sets), most reps,
// and per-rep-count set-records ({<reps>: heaviest weight lifted for exactly
// that many reps}). Empty/absent input → zeros + empty set_records.
export function exercisePRs(logs) {
  const pr = {
    heaviest_weight: 0,
    best_est_1rm: 0,
    // Reps behind best_est_1rm — the confidence input, not a record of its own.
    best_est_1rm_reps: 0,
    best_set_volume: 0,
    best_session_volume: 0,
    most_reps: 0,
    set_records: {},
  };
  if (!Array.isArray(logs)) return pr;
  for (const log of logs) {
    const sets = nonWarmup(log);
    let sessionVolume = 0;
    for (const s of sets) {
      const w = s.weight_kg || 0;
      const reps = s.reps || 0;
      const setVolume = w * reps;
      sessionVolume += setVolume;
      if (w > pr.heaviest_weight) pr.heaviest_weight = w;
      if (reps > pr.most_reps) pr.most_reps = reps;
      if (setVolume > pr.best_set_volume) pr.best_set_volume = setVolume;
      const e1 = estimated1RM(w, reps);
      if (e1 > pr.best_est_1rm) { pr.best_est_1rm = e1; pr.best_est_1rm_reps = reps; }
      // Per-rep-count record: heaviest weight ever lifted for exactly `reps`.
      if (reps > 0 && w > 0 && (pr.set_records[reps] === undefined || w > pr.set_records[reps])) {
        pr.set_records[reps] = w;
      }
    }
    if (sessionVolume > pr.best_session_volume) pr.best_session_volume = sessionVolume;
  }
  // The confidence verdict is decided HERE, not by each renderer — the feature
  // layer is a plain script that can't import this module's threshold, and a
  // second copy of "12" is exactly the drift this keeps out.
  pr.best_est_1rm_low_confidence = est1RMLowConfidence(pr.best_est_1rm_reps);
  return pr;
}

// exerciseSeries returns one point per log (each log is one session's exercise
// entry, from listExerciseLogsByName), oldest-first, with the session-best
// est-1RM, the top weight, and the session's working-set volume — the shape the
// per-exercise progress graphs consume. Logs with no working sets contribute a
// zeroed point (so a session still shows on the timeline).
export function exerciseSeries(logs) {
  if (!Array.isArray(logs)) return [];
  return logs
    .map((log) => {
      const sets = nonWarmup(log);
      let est1rm = 0;
      let topWeight = 0;
      let volume = 0;
      let totalReps = 0;
      for (const s of sets) {
        const w = s.weight_kg || 0;
        const reps = s.reps || 0;
        volume += w * reps;
        totalReps += reps;
        if (w > topWeight) topWeight = w;
        const e1 = estimated1RM(w, reps);
        if (e1 > est1rm) est1rm = e1;
      }
      // `reps` (total working reps) and `work_sets` (hard-set count) are the
      // endurance / hypertrophy headline + weekly-volume inputs (med-qj4.6.4).
      return {
        date: log && log.date,
        est_1rm: est1rm,
        top_weight: topWeight,
        volume,
        reps: totalReps,
        work_sets: sets.length,
      };
    })
    .sort((a, b) => (String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0));
}

// -- Goal-driven emphasis (med-qj4.6.4) ------------------------------------
//
// The same history answers a different question per training goal, so the detail
// view leads with the metric that goal is actually chasing instead of always
// leading with est-1RM. `general` shares hypertrophy's emphasis for the same
// reason its GOAL_DEFAULTS rep-range does: it's an unopinionated middle.
// `charts` is the ordered wg-workout-chart metric list — primary first.
export const GOAL_EMPHASIS = {
  strength:    { metric: 'est-1rm', charts: ['est-1rm', 'top-weight'] },
  hypertrophy: { metric: 'volume',  charts: ['volume', 'est-1rm'] },
  endurance:   { metric: 'reps',    charts: ['reps', 'volume'] },
  general:     { metric: 'volume',  charts: ['volume', 'est-1rm'] },
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// weeklyHardSets sums working sets over the 7 days ending at the NEWEST series
// point — anchoring on the data, not on a clock, keeps this pure and makes the
// number mean "your latest training week" even when the history is stale.
export function weeklyHardSets(series) {
  if (!Array.isArray(series) || series.length === 0) return 0;
  const times = series.map((p) => new Date(p.date).getTime()).filter((t) => Number.isFinite(t));
  if (times.length === 0) return 0;
  const newest = Math.max(...times);
  return series.reduce((sum, p) => {
    const t = new Date(p.date).getTime();
    return Number.isFinite(t) && newest - t < WEEK_MS ? sum + (p.work_sets || 0) : sum;
  }, 0);
}

// goalHeadline picks the one number the detail view leads with, in the units the
// goal cares about. Presentation-only: every input is already computed by
// exercisePRs / exerciseSeries. `unit` tells the renderer how to format
// ('kg' → weight formatter, everything else → plain count); `low_confidence`
// only ever rides on the est-1RM headline.
export function goalHeadline(goal, prs, series) {
  const g = normalizeGoal(goal);
  const emphasis = GOAL_EMPHASIS[g];
  const points = Array.isArray(series) ? series : [];
  const latest = points.length ? points[points.length - 1] : null;
  const base = {
    goal: g, metric: emphasis.metric, charts: emphasis.charts, low_confidence: false, confidence_reps: null,
  };

  if (emphasis.metric === 'est-1rm') {
    return {
      ...base,
      label: 'Best est. 1RM',
      value: (prs && prs.best_est_1rm) || 0,
      unit: 'kg',
      sub_label: 'Heaviest weight',
      sub_value: (prs && prs.heaviest_weight) || 0,
      sub_unit: 'kg',
      low_confidence: !!(prs && prs.best_est_1rm_low_confidence),
      confidence_reps: (prs && prs.best_est_1rm_reps) || null,
    };
  }
  if (emphasis.metric === 'reps') {
    return {
      ...base,
      label: 'Reps · last session',
      value: latest ? latest.reps || 0 : 0,
      unit: 'reps',
      sub_label: 'Most reps in a set',
      sub_value: (prs && prs.most_reps) || 0,
      sub_unit: 'reps',
    };
  }
  return {
    ...base,
    label: 'Volume load · last session',
    value: latest ? Math.round(latest.volume || 0) : 0,
    unit: 'kg',
    sub_label: 'Hard sets · last 7 days',
    sub_value: weeklyHardSets(points),
    sub_unit: 'sets',
  };
}

// -- Near-failure effort insight (med-qj4.6.5) ------------------------------
//
// Hypertrophy is driven by proximity to failure: sets stopped 4+ reps short
// leave most of the stimulus on the table. `advise` fires only when a
// hypertrophy-goal exercise's recent RATED work sets sit that far out.
//
// Deliberately quiet: RPE is optional, so no rated set → null (no card, no
// error), and a single rated set is not evidence — MIN_RATED_SETS keeps one easy
// warm-down from triggering a lecture. Strength/endurance/general goals still
// get the effort summary but never the advisory: RIR 2-3 is correct programming
// for strength. Advice, never a gate — nothing here feeds progression.
// (NEAR_FAILURE_RIR itself is defined in workout-goals.js and re-exported at the
// top of this file.)
export const EFFORT_WINDOW_SETS = 6;
const MIN_RATED_SETS = 3;

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// effortInsight folds the newest-first `logs` (listExerciseLogsByName order)
// into the rolling median RIR of the last ~EFFORT_WINDOW_SETS rated work sets.
// Returns null when nothing was rated.
export function effortInsight(logs, goal) {
  if (!Array.isArray(logs)) return null;
  const rirs = [];
  for (const log of logs) {
    // `logs` is newest-first but a log's own sets run set_index ascending, so
    // walk each session backwards — otherwise a session with more rated sets
    // than the window fills it from that session's OLDEST sets, and effort
    // reliably drifts across a workout (fatigue), so that's a real skew.
    for (const s of nonWarmup(log).reverse()) {
      const rir = rirFromRpe(s && s.rpe);
      if (rir !== null) rirs.push(rir);
    }
    if (rirs.length >= EFFORT_WINDOW_SETS) break;
  }
  if (rirs.length === 0) return null;
  // (`recent`, not `window` — web/domain/ may not so much as name a browser
  // global; architecture.domain-purity.test.js is a substring scan.)
  const recent = rirs.slice(0, EFFORT_WINDOW_SETS);
  const medianRir = median(recent);
  return {
    median_rir: medianRir,
    sets: recent.length,
    advise: normalizeGoal(goal) === 'hypertrophy'
      && recent.length >= MIN_RATED_SETS
      && medianRir >= NEAR_FAILURE_RIR,
  };
}
