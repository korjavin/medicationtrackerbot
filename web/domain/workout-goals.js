// Pure training-goal defaults + effort (RIR/RPE) conversion for the goal-aware
// workout foundation (med-qj4.6.1/.6.2). No browser globals — runtime-agnostic
// (C6 runs web/domain/ inside Go via goja). The canonical GOAL_DEFAULTS table is
// duplicated by the plain-script exercise-editor cascade (WORKOUT_GOAL_DEFAULTS
// in web/static/js/features/workout/exercises.js — it can't import ES modules);
// the two are pinned in sync by workout-goals.test.js. GOAL_DEFAULTS/
// defaultsForGoal drive the RIR-gated progression presets in
// web/domain/workout.js (med-qj4.6.3); normalizeGoal + rirFromRpe drive the
// goal-driven graph emphasis and the near-failure effort insight in
// web/domain/workout-analysis.js (med-qj4.6.4/.5). rpeFromRir is the display
// direction (rendering a goal's target_rir as an RPE cue).
//
// Table from docs/workout-depth.md §Science basis (repetition continuum).
// progression preset ids match the Phase-4 selector: 'none'|'linear'|'double'.

export const TRAINING_GOALS = ['strength', 'hypertrophy', 'endurance', 'general'];

export const DEFAULT_GOAL = 'hypertrophy';

export const GOAL_DEFAULTS = {
  strength:    { reps_min: 3,  reps_max: 6,  target_rir: 2,    progression: 'linear' },
  hypertrophy: { reps_min: 8,  reps_max: 12, target_rir: 1,    progression: 'double' },
  endurance:   { reps_min: 15, reps_max: 25, target_rir: 1,    progression: 'double' },
  general:     { reps_min: 8,  reps_max: 12, target_rir: null, progression: 'none' },
};

// Falls back to the default goal (hypertrophy) for unknown/empty input.
export function defaultsForGoal(goal) {
  return GOAL_DEFAULTS[goal] || GOAL_DEFAULTS[DEFAULT_GOAL];
}

// Normalize an arbitrary value to a valid goal, defaulting to hypertrophy.
export function normalizeGoal(goal) {
  return TRAINING_GOALS.includes(goal) ? goal : DEFAULT_GOAL;
}

// -- Effort: RIR ⇄ RPE (med-qj4.6.2) ---------------------------------------
//
// RIR (reps in reserve) and RPE (rate of perceived exertion) are ONE effort
// scalar read from opposite ends: RIR = 10 − RPE. The canonical STORED field is
// `rpe`, per set, validated 1–10 in web/domain/workout.js's normalizeSets and
// entered in the session logger — it is already persisted, synced and sitting in
// users' vaults, so nothing here introduces a second stored field. Goal defaults
// think in RIR (`target_rir` above), so these three functions are the single
// place the two ends meet: progression, graphs and insights convert HERE instead
// of each re-deriving `10 - x`.
//
// Absent/blank/non-finite effort → null (rpe is optional on every set), so
// callers can distinguish "no effort logged" from a real value.
function effortNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function rirFromRpe(rpe) {
  const n = effortNumber(rpe);
  return n === null ? null : 10 - n;
}

export function rpeFromRir(rir) {
  const n = effortNumber(rir);
  return n === null ? null : 10 - n;
}

// Display form of a stored RPE, spelling out both ends so no reader has to do
// the subtraction: 8 → 'RPE 8 · 2 RIR'. Null for absent/invalid effort.
export function formatEffort(rpe) {
  const n = effortNumber(rpe);
  return n === null ? null : `RPE ${n} · ${10 - n} RIR`;
}
