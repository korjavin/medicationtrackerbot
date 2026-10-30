// Weight sanity (med-l5yr.5): advisory flags on a logged working set whose
// weight looks like a typo. Pure, no imports — the stats fold, the per-exercise
// history read and suggest-target in workout.js use it, and the session view
// imports it to evaluate the sets on screen against a baseline from
// GET /api/workout/exercises/weight-check. One rule, everywhere.
//
// The flag is never stored. What is stored is the user's answer: `confirmed:
// true` on the set (log.sets[i]), written by "It's right" / "Keep N kg". A
// flagged set without it counts toward nothing but the session (coverage): no
// PR, max weight, volume, reps, hard sets or next target. A flagged set also
// never raises the reference, so one slip can't hide the next.

// Thresholds (Miles may tune; a change re-evaluates old history, nothing is
// pre-materialized).
export const JUMP_MIN_PRIOR_LOGS = 3; // earlier completed logs of the exercise
export const JUMP_FACTOR = 2; // > 2x the heaviest accepted working set

// A band carries no load in kg. Exercises have no implement field, so this is
// a name rule like equipment.js implementForExerciseName: the word "band(s)"
// ("Band pull-apart", "Resistance band row"), not "banded" (a band added to a
// loaded bar), plus the RU stem the owner uses.
// ponytail: name rule only; body-weight exercises are not detected (a weighted
// pull-up is legit) — add an implement value if a real miss shows up.
const UNWEIGHTED_NAME = /(?<!\p{L})(?:bands?(?!\p{L})|резинк)/iu;

export function isUnweightedExercise(name) {
  return UNWEIGHTED_NAME.test(typeof name === 'string' ? name : '');
}

// weightSanity judges one working-set weight against a baseline:
// { prior_logs, heaviest_kg, unweighted }. → { flags: [] | ['unweighted'] |
// ['jump'], reference_kg } (reference = the heaviest accepted set, null when
// there is none). Only upward jumps are checked; a drop is a deload.
export function weightSanity({ weight_kg, prior_logs, heaviest_kg, unweighted }) {
  const w = Number(weight_kg) || 0;
  const ref = Number(heaviest_kg) || 0;
  const reference = ref > 0 ? ref : null;
  if (w <= 0) return { flags: [], reference_kg: reference };
  if (unweighted) return { flags: ['unweighted'], reference_kg: reference };
  if ((Number(prior_logs) || 0) >= JUMP_MIN_PRIOR_LOGS && ref > 0 && w > JUMP_FACTOR * ref) {
    return { flags: ['jump'], reference_kg: ref };
  }
  return { flags: [], reference_kg: reference };
}

export function emptyBaseline(unweighted) {
  return { prior_logs: 0, heaviest_kg: 0, unweighted: !!unweighted };
}

// flagSets walks one log's sets in order. → { flags, heaviest_kg }: flags[i]
// is null or { flag: 'jump'|'unweighted', reference_kg } for an UNCONFIRMED
// flagged working set; an accepted set (unflagged, or confirmed) raises the
// running heaviest for the sets after it. Warm-ups are never judged.
export function flagSets(sets, baseline) {
  const base = baseline || emptyBaseline(false);
  let heaviest = Number(base.heaviest_kg) || 0;
  const flags = (Array.isArray(sets) ? sets : []).map((s) => {
    if (!s || s.set_type === 'warmup') return null;
    const w = Number(s.weight_kg) || 0;
    const r = weightSanity({ weight_kg: w, prior_logs: base.prior_logs, heaviest_kg: heaviest, unweighted: base.unweighted });
    if (r.flags.length && s.confirmed !== true) return { flag: r.flags[0], reference_kg: r.reference_kg };
    if (w > heaviest) heaviest = w;
    return null;
  });
  return { flags, heaviest_kg: heaviest };
}

// setsOf is the per-set view of a log: its sets, else a flat-scalar log's
// sets_completed copies of weight × reps — the same rows the session view
// draws for it (sessions.js _ensureLogSets), so both judge the same sets and
// a confirm there writes them out as real sets.
export function setsOf(log) {
  if (log && Array.isArray(log.sets) && log.sets.length > 0) return log.sets;
  const n = Math.min(20, Math.max(0, Math.round(Number(log && log.sets_completed) || 0)));
  const weight = Math.max(0, Number(log && log.weight_kg) || 0);
  return Array.from({ length: n }, () => ({ weight_kg: weight, set_type: 'normal' }));
}

// sanityStep folds one completed log (oldest-first walk of one resolved
// exercise) into the baseline.
export function sanityStep(baseline, log) {
  const res = flagSets(setsOf(log), baseline);
  return {
    flags: res.flags,
    next: { ...baseline, prior_logs: (Number(baseline.prior_logs) || 0) + 1, heaviest_kg: res.heaviest_kg },
  };
}

// withoutFlagged returns the log a progression read should see: unconfirmed
// flagged sets dropped (scalars re-derived like deriveSetScalars). No flag →
// the log itself.
export function withoutFlagged(log, flags) {
  if (!Array.isArray(flags) || !flags.some(Boolean)) return log;
  // A flat log's synthesized sets share one weight, so a flag drops them all.
  const sets = Array.isArray(log.sets) ? log.sets.filter((_, i) => !flags[i]) : [];
  return {
    ...log,
    sets,
    sets_completed: sets.length,
    reps_completed: sets.reduce((m, s) => Math.max(m, s.reps || 0), 0),
    weight_kg: sets.reduce((m, s) => Math.max(m, s.weight_kg || 0), 0),
  };
}
