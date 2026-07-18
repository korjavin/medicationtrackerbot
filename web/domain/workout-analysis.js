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

// Epley: estimated 1-rep max from a weight lifted for `reps`. Rounded to 2dp for
// display stability. reps/weight ≤ 0 → 0 (not a real working set). Note the
// formula degrades past ~10-12 reps; a low-confidence flag is deferred to the
// goal-aware sub-epic (med-qj4.6.4), not needed here.
export function estimated1RM(weight, reps) {
  if (!(weight > 0) || !(reps > 0)) return 0;
  return Math.round(weight * (1 + reps / 30) * 100) / 100;
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
      if (e1 > pr.best_est_1rm) pr.best_est_1rm = e1;
      // Per-rep-count record: heaviest weight ever lifted for exactly `reps`.
      if (reps > 0 && w > 0 && (pr.set_records[reps] === undefined || w > pr.set_records[reps])) {
        pr.set_records[reps] = w;
      }
    }
    if (sessionVolume > pr.best_session_volume) pr.best_session_volume = sessionVolume;
  }
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
      for (const s of sets) {
        const w = s.weight_kg || 0;
        const reps = s.reps || 0;
        volume += w * reps;
        if (w > topWeight) topWeight = w;
        const e1 = estimated1RM(w, reps);
        if (e1 > est1rm) est1rm = e1;
      }
      return {
        date: log && log.date, est_1rm: est1rm, top_weight: topWeight, volume,
      };
    })
    .sort((a, b) => (String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0));
}
