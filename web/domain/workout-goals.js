// Pure training-goal defaults for the goal-aware workout foundation
// (med-qj4.6.1). No browser globals — runtime-agnostic (C6 runs web/domain/
// inside Go via goja). The canonical GOAL_DEFAULTS table is duplicated by the
// plain-script exercise-editor cascade (WORKOUT_GOAL_DEFAULTS in
// web/static/js/features/workout/exercises.js — it can't import ES modules);
// keep the two in sync. GOAL_DEFAULTS/defaultsForGoal are staged here for the
// goja side and the later goal-differentiated progression/graphs/insight
// (med-qj4.6.3/.4/.5); only normalizeGoal/TRAINING_GOALS have callers today.
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
