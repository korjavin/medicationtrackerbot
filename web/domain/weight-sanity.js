// Weight sanity (med-l5yr.5): advisory flags on a logged working set whose
// weight looks like a typo. Pure, no imports. ONE pre-pass (flagLogs) decides
// the final flags of every log of one exercise; the stats fold, history,
// suggest-target, propagation, the progression preview and the session view
// (through GET /api/workout/exercises/weight-check + flagSets) all read it.
//
// The flag is never stored. What is stored is the user's answer: `confirmed:
// true` on the set (log.sets[i]), written by "It's right" / "Keep N kg". A
// flagged set without it counts toward nothing but the session (coverage): no
// PR, max weight, volume, reps, hard sets or next target.
//
// Rules (Archie, bd med-l5yr.5 "AMENDED, replaces 8774"):
//   jump — a working set with at least JUMP_MIN_PRIOR_LOGS earlier logs and a
//     weight above JUMP_FACTOR × the heaviest ACCEPTED set before it. It is
//     accepted (and raises the reference) when confirmed, or when any working
//     set in a LATER log weighs at least HEAL_FACTOR × it: repeated means
//     real. Sets of one log never heal each other (the editor copies a weight
//     across sets; one slip is one piece of evidence). Two slips in a row heal
//     each other — accepted cost, this is a typo detector.
//   unweighted — kg above 0 on a band, only while that log is the exercise's
//     only log with any weight (bands are sold as "15 kg"; a second weighted
//     log means the user means it). Confirmed → accepted.

// Thresholds (Miles may tune; a change re-evaluates old history, nothing is
// pre-materialized).
export const JUMP_MIN_PRIOR_LOGS = 3; // earlier completed logs of the exercise
export const JUMP_FACTOR = 2; // > 2x the heaviest accepted working set
export const HEAL_FACTOR = 0.8; // a later log at >= 80% of the jump makes it real

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

// setsOf is the per-set view of a log: its sets, else a flat-scalar log's
// sets_completed copies of its weight — the same rows the session view draws
// for it (sessions.js _ensureLogSets), so both judge the same sets and a
// confirm there writes them out as real sets.
export function setsOf(log) {
  if (log && Array.isArray(log.sets) && log.sets.length > 0) return log.sets;
  const n = Math.min(20, Math.max(0, Math.round(Number(log && log.sets_completed) || 0)));
  const weight = Math.max(0, Number(log && log.weight_kg) || 0);
  return Array.from({ length: n }, () => ({ weight_kg: weight, set_type: 'normal' }));
}

const working = (s) => !!s && s.set_type !== 'warmup';
const kg = (s) => Number(s && s.weight_kg) || 0;

// flagLogs is THE pre-pass: one exercise's logs, oldest first → per log, per
// set, null or { flag: 'jump'|'unweighted', reference_kg } for an unconfirmed
// flagged working set.
// ponytail: suffix max + one walk is O(n·sets); the heal lookahead is "any
// later log", so nothing smarter is needed until history is huge.
export function flagLogs(logsOldestFirst, unweighted) {
  const logs = Array.isArray(logsOldestFirst) ? logsOldestFirst : [];
  const sets = logs.map(setsOf);
  const maxOf = (ss) => ss.reduce((m, s) => (working(s) ? Math.max(m, kg(s)) : m), 0);
  // laterMax[i] = heaviest working set in any log after i.
  const laterMax = new Array(logs.length).fill(0);
  for (let i = logs.length - 2; i >= 0; i--) laterMax[i] = Math.max(laterMax[i + 1], maxOf(sets[i + 1]));
  const weightedLogs = sets.filter((ss) => maxOf(ss) > 0).length;

  let heaviest = 0;
  return sets.map((ss, i) => ss.map((s) => {
    if (!working(s)) return null;
    const w = kg(s);
    const confirmed = s.confirmed === true;
    if (unweighted) {
      return w > 0 && weightedLogs <= 1 && !confirmed ? { flag: 'unweighted', reference_kg: null } : null;
    }
    if (i >= JUMP_MIN_PRIOR_LOGS && heaviest > 0 && w > JUMP_FACTOR * heaviest
      && !confirmed && !(laterMax[i] >= HEAL_FACTOR * w)) {
      return { flag: 'jump', reference_kg: heaviest };
    }
    if (w > heaviest) heaviest = w;
    return null;
  }));
}

// flagSets judges `sets` as the log at `context.index` among the other logs
// of its exercise (`context.logs`, oldest first — the weight-check route's
// answer): the session view's and propagation's "before you save" view of
// the very same pre-pass. → { flags }.
export function flagSets(sets, context) {
  const others = Array.isArray(context && context.logs) ? context.logs : [];
  const at = Math.max(0, Math.min(others.length, Number(context && context.index) || 0));
  const logs = [...others.slice(0, at), { sets: Array.isArray(sets) ? sets : [] }, ...others.slice(at)];
  return { flags: flagLogs(logs, !!(context && context.unweighted))[at] };
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
