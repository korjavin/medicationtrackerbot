// Runtime-agnostic workout domain module. Pure logic over an injected
// records port — no window/document/fetch/IndexedDB — so the same file can
// later run inside the Go server via goja (C6). Mirrors
// internal/store/workout/repo.go + internal/server/workout_handlers.go +
// workout_crud_handlers.go + internal/domain/workout/*.go.
//
// Record types (bodies use server JSON field names verbatim):
//   workoutgroup, workoutvariant, workoutexercise, exerciselibrary,
//   workoutsession, exerciselog, workoutrotation (one per group, deterministic
//   recordId `rotation-<groupId>`), miband.
//
// Numeric-id strategy (see docs/plans/2026-07-06-cloud-c2d-workouts.md,
// Decision 1): unlike medications.js (where recordId itself doubles as the
// numeric id), workout records carry a separate client-minted numeric `id`
// field in the body. This is because sessions need the sync identity
// (recordId) to be deterministic (`session-<groupId>-<date>`) for
// multi-device dedup, while the frontend's sentinels (sessions.js:559's
// `log.id > 0`, groups.js's `group_id == -1` / `variant_id == -1` ad-hoc
// markers) need a plain positive number. Every other workout record type
// also gets a body `id` for consistency, even though only sessions strictly
// require the split.
//
// LWW-merge id-self-heal property: two devices resolving "next" for the same
// group+date both write to the same deterministic recordId, so LWW keeps one
// body — one numeric id wins, the loser's id is simply never referenced again.
// A stale foreign-key lookup by numeric id (e.g. a rotation row pointing at a
// variant id from a losing write) self-heals on the next list() because
// lookups always re-resolve "record of type T whose body.id == n" against the
// live records port rather than caching the id mapping.
//
// ponytail: numeric ids exist solely for frontend sentinel compatibility
// (`id > 0`, `-1` ad-hoc) — revisit if a future migration wants stable ids
// instead of timestamp-derived ones.

import { localDateParts, localWallToUtcMs } from './medschedule.js';
import { formatHHMM } from './reminders.js';
import {
  normalizeGoal, TRAINING_GOALS, defaultsForGoal, rirFromRpe, formatEffort,
  NEAR_FAILURE_RIR,
} from './workout-goals.js';

const WORKOUT_RECORD_TYPES = {
  GROUP: 'workoutgroup',
  VARIANT: 'workoutvariant',
  EXERCISE: 'workoutexercise',
  LIBRARY: 'exerciselibrary',
  SESSION: 'workoutsession',
  LOG: 'exerciselog',
  ROTATION: 'workoutrotation',
  MIBAND: 'miband',
};

// Ad-hoc sessions use this literal pair — kept as-is (never minted) so the
// frontend's `group_id == -1 / variant_id == -1` checks keep working verbatim.
const ADHOC_ID = -1;

// Caps one schedule request, mirroring maxScheduledExercises in
// internal/server/workout_schedule_handlers.go.
const MAX_SCHEDULED_EXERCISES = 50;

// mintNumericId ports the nextId technique used by medications.js/notes.js:
// stamp from the millisecond clock (time-ordered) plus low-order random
// digits for cross-device entropy, falling back to localMax+1 so a stalled
// clock or same-ms collision never reuses an id already present in
// `existing` (a list of records of any workout type — callers pass whatever
// scope collisions must be avoided within, e.g. all groups, or all variants
// across all groups).
// ponytail: nowMs*1000 stays under Number.MAX_SAFE_INTEGER until ~year 2255.
function mintNumericId(existing, nowMs) {
  const localMax = existing.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
  const stamped = nowMs * 1000 + Math.floor(Math.random() * 1000);
  return Math.max(stamped, localMax + 1);
}

// genRecordId mints an opaque recordId for record types with no natural
// dedup slot (groups, variants, exercises, library entries, logs, ad-hoc
// sessions). Same shape as food.js/notes.js's genId.
function genRecordId(prefix, nowMs) {
  return `${prefix}_${nowMs}_${Math.random().toString(36).slice(2, 10)}`;
}

// sessionRecordId is the deterministic slot a schedule-materialized session
// occupies: N devices resolving "next" for the same group on the same local
// date all write to this same recordId, so LWW converges on one session
// rather than creating duplicates. `date` is a "YYYY-MM-DD" local-date
// string. Ad-hoc sessions (group_id/variant_id == -1) have no such slot and
// get a random recordId via genRecordId instead.
function sessionRecordId(groupId, date) {
  return `session-${groupId}-${date}`;
}

// rotationRecordId is the deterministic one-row-per-group slot for rotation
// cursor state, mirroring the server's one-row-per-group table.
function rotationRecordId(groupId) {
  return `rotation-${groupId}`;
}

// findByNumericId resolves "record of type T whose body.id == n" through the
// records port — the id-self-heal lookup: always re-reads the live list
// rather than caching a recordId, so a foreign key pointing at a losing
// LWW write's id simply misses (caller treats as not-found) instead of
// resolving to stale data.
async function findByNumericId(records, recordType, id) {
  const all = await records.list(recordType);
  return all.find((r) => !r.deleted && r.id === id) || null;
}

// Single-account cloud mode has exactly one user; the server's user_id
// column is preserved on record bodies for shape fidelity but no frontend
// code reads it (verified: no `.user_id` reference under
// web/static/js/features/workout/).
const CLOUD_USER_ID = 1;

function invalidRequest(message, code) {
  const err = new Error(message);
  err.code = code || 'invalid_request';
  return err;
}

// numOrNull ports the *int/*float64 optional-field pattern (nil in Go ==
// absent/blank in the form): empty string, null, and undefined all become
// null; isInt truncates (mirrors the target_reps_max / rotation_order
// columns being INTEGER, vs target_weight_kg's DECIMAL).
function numOrNull(v, isInt) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  // Reject non-finite (NaN and ±Infinity): a JSON literal like 1e999 parses to
  // Infinity, and `weightBase + Infinity` would poison target_weight_kg (which
  // then JSON.stringifies to null, corrupting the plan). Number.isFinite also
  // excludes NaN, preserving the prior blank/NaN→null behavior.
  if (!Number.isFinite(n)) return null;
  return isInt ? Math.trunc(n) : n;
}

function hasValue(v) {
  return v !== null && v !== undefined;
}

// -- Response shapes (mirror the Go structs' json tags, incl. omitempty) --

function toGroupResponse(record) {
  const resp = {
    id: record.id,
    name: record.name,
    is_rotating: !!record.is_rotating,
    user_id: record.user_id,
    days_of_week: record.days_of_week,
    scheduled_time: record.scheduled_time,
    notification_advance_minutes: record.notification_advance_minutes || 0,
    active: !!record.active,
    training_goal: normalizeGoal(record.training_goal),
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
  if (record.description) resp.description = record.description;
  return resp;
}

function toVariantResponse(record) {
  const resp = {
    id: record.id,
    group_id: record.group_id,
    name: record.name,
    created_at: record.created_at,
  };
  if (hasValue(record.rotation_order)) resp.rotation_order = record.rotation_order;
  if (record.description) resp.description = record.description;
  return resp;
}

// toExerciseResponse mirrors the Go read: the canonical name comes from the
// referenced library row (COALESCE(el.name, we.exercise_name)) so a library
// rename shows through in plans. (History logs snapshot exercise_name at log
// time and are intentionally unaffected.) libById is the id→library-record map
// for non-deleted library rows; omit it (or a dangling/null FK) to fall back to
// the cached exercise_name.
function toExerciseResponse(record, libById) {
  const libId = record.exercise_library_id;
  let name = record.exercise_name;
  if (hasValue(libId) && libById) {
    const lib = libById.get(libId);
    if (lib) name = lib.name;
  }
  const resp = {
    id: record.id,
    variant_id: record.variant_id,
    exercise_name: name,
    target_sets: record.target_sets,
    target_reps_min: record.target_reps_min,
    order_index: record.order_index,
  };
  if (hasValue(record.target_reps_max)) resp.target_reps_max = record.target_reps_max;
  if (hasValue(record.target_weight_kg)) resp.target_weight_kg = record.target_weight_kg;
  if (hasValue(libId)) resp.exercise_library_id = libId;
  if (record.progression_rule && record.progression_rule.type !== 'none') {
    resp.progression_rule = record.progression_rule;
  }
  // training_goal is an optional per-exercise override; emit only when set —
  // absent means "inherit the routine's goal" (med-qj4.6.1).
  if (record.training_goal) resp.training_goal = record.training_goal;
  return resp;
}

function toLibraryResponse(record) {
  const resp = {
    id: record.id,
    user_id: record.user_id,
    name: record.name,
    default_sets: record.default_sets,
    default_reps_min: record.default_reps_min,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
  if (hasValue(record.default_reps_max)) resp.default_reps_max = record.default_reps_max;
  if (hasValue(record.default_weight_kg)) resp.default_weight_kg = record.default_weight_kg;
  if (record.notes) resp.notes = record.notes;
  // Manual body-part override (med library tags). Omitted when unset, so rows
  // that never got one keep falling back to the static catalog's classifier.
  if (record.body_part) resp.body_part = record.body_part;
  return resp;
}

function toSessionResponse(record) {
  const resp = {
    id: record.id,
    group_id: record.group_id,
    variant_id: record.variant_id,
    user_id: record.user_id,
    scheduled_date: record.scheduled_date,
    scheduled_time: record.scheduled_time,
    status: record.status,
    snooze_count: record.snooze_count || 0,
  };
  if (record.started_at) resp.started_at = record.started_at;
  if (record.completed_at) resp.completed_at = record.completed_at;
  if (record.snoozed_until) resp.snoozed_until = record.snoozed_until;
  if (record.notification_message_id) resp.notification_message_id = record.notification_message_id;
  if (record.notes) resp.notes = record.notes;
  if (record.exercise_snapshot) resp.exercise_snapshot = record.exercise_snapshot;
  return resp;
}

function toRotationResponse(record) {
  return {
    group_id: record.group_id,
    current_variant_id: record.current_variant_id,
    last_session_date: record.last_session_date || null,
    updated_at: record.updated_at,
  };
}

function toLogResponse(record) {
  const resp = {
    id: record.id,
    session_id: record.session_id,
    exercise_id: record.exercise_id,
    exercise_name: record.exercise_name,
    status: record.status,
    logged_at: record.logged_at,
    source: record.source,
  };
  if (hasValue(record.sets_completed)) resp.sets_completed = record.sets_completed;
  if (hasValue(record.reps_completed)) resp.reps_completed = record.reps_completed;
  if (hasValue(record.weight_kg)) resp.weight_kg = record.weight_kg;
  if (Array.isArray(record.sets)) resp.sets = record.sets;
  if (record.notes) resp.notes = record.notes;
  return resp;
}

// validateExerciseValues ports ValidateExerciseValues (exercise_logs.go:28):
// nil/undefined means "don't change" and is always allowed; only a present
// negative value is rejected.
function validateExerciseValues(sets, reps, weight) {
  if (hasValue(sets) && sets < 0) throw invalidRequest('sets must be non-negative');
  if (hasValue(reps) && reps < 0) throw invalidRequest('reps must be non-negative');
  if (hasValue(weight) && weight < 0) throw invalidRequest('weight must be non-negative');
}

const VALID_SET_TYPES = new Set(['normal', 'warmup', 'drop', 'failure']);

// normalizeSets validates + normalizes the optional per-set array on an
// exerciselog write (Phase 1, epic med-qj4). Absent (null/undefined) means
// "no per-set data" and preserves today's flat-scalar behavior. Each entry is
// {set_index, weight_kg>=0, reps>=0, rpe?(1-10), set_type∈normal/warmup/drop/
// failure}; set_index defaults to array position and set_type to 'normal'.
function normalizeSets(sets) {
  if (sets === null || sets === undefined) return null;
  if (!Array.isArray(sets)) throw invalidRequest('sets must be an array');
  // An empty array is "no per-set data", not "zero sets" — otherwise it would
  // zero the derived scalars and wipe any stored per-set breakdown. Collapse it
  // to the absent sentinel so create/update fall back to flat-scalar behavior.
  if (sets.length === 0) return null;
  // Cap length at the UI's add-set ceiling. This is the sole write-validation
  // seam for the cloud/MCP logs/create+update routes, so without a bound a
  // hostile/malformed write could persist a huge array that OOMs the tab when
  // toLogResponse emits it and the session card renders one row per set.
  if (sets.length > 20) throw invalidRequest('sets may not exceed 20 entries');
  return sets.map((s, i) => {
    const weight = numOrNull(s && s.weight_kg, false);
    const reps = numOrNull(s && s.reps, true);
    if (hasValue(weight) && weight < 0) throw invalidRequest('set weight_kg must be non-negative');
    if (hasValue(reps) && reps < 0) throw invalidRequest('set reps must be non-negative');
    const setType = (s && s.set_type) || 'normal';
    if (!VALID_SET_TYPES.has(setType)) {
      throw invalidRequest('set_type must be one of normal, warmup, drop, failure');
    }
    const out = {
      set_index: hasValue(s && s.set_index) ? Math.trunc(Number(s.set_index)) : i,
      weight_kg: hasValue(weight) ? weight : 0,
      reps: hasValue(reps) ? reps : 0,
      set_type: setType,
    };
    const rpe = numOrNull(s && s.rpe, false);
    if (hasValue(rpe)) {
      if (rpe < 1 || rpe > 10) throw invalidRequest('rpe must be between 1 and 10');
      out.rpe = rpe;
    }
    return out;
  });
}

const VALID_PROGRESSION_TYPES = new Set(['none', 'linear', 'double']);

// Load step used when a rule carries no explicit one. Same 2.5 kg the exercise
// editor sends for a blank increment field, and the step suggestExerciseTarget
// prices a goal preset's bump at for an exercise that has no saved rule yet.
const DEFAULT_INCREMENT_KG = 2.5;

// normalizeProgressionRule validates the optional opt-in progression rule on a
// workoutexercise record (Phase 4, epic med-qj4.4.1). Absent/null or
// {type:'none'} means "mirror last performance" (today's behavior) and returns
// null so nothing is persisted. Otherwise: {type:'linear'|'double',
// increment_kg>=0, min_reps?, max_reps?} — increment_kg defaults to 2.5;
// double-progression's rep window defaults are taken from the exercise's
// target reps at apply time, so min/max_reps are optional here.
function normalizeProgressionRule(input) {
  if (input === null || input === undefined) return null;
  const type = input.type || 'none';
  if (!VALID_PROGRESSION_TYPES.has(type)) {
    throw invalidRequest('progression type must be one of none, linear, double');
  }
  if (type === 'none') return null;
  const increment = numOrNull(input.increment_kg, false);
  // Cap at a physical ceiling: numOrNull already rejects non-finite, but a large
  // *finite* increment would overflow `weightBase + increment_kg` to Infinity at
  // apply time, which JSON.stringifies to null and permanently corrupts the plan.
  if (hasValue(increment) && (increment < 0 || increment > 1000)) {
    throw invalidRequest('increment_kg must be between 0 and 1000');
  }
  const out = { type, increment_kg: hasValue(increment) ? increment : DEFAULT_INCREMENT_KG };
  const minReps = numOrNull(input.min_reps, true);
  const maxReps = numOrNull(input.max_reps, true);
  if (hasValue(minReps)) {
    if (minReps < 0) throw invalidRequest('min_reps must be non-negative');
    out.min_reps = minReps;
  }
  if (hasValue(maxReps)) {
    if (maxReps < 0) throw invalidRequest('max_reps must be non-negative');
    out.max_reps = maxReps;
  }
  if (hasValue(out.min_reps) && hasValue(out.max_reps) && out.min_reps > out.max_reps) {
    throw invalidRequest('min_reps must not exceed max_reps');
  }
  return out;
}

// anchorDoubleWindow pins a double-progression rule's rep window to the
// exercise's current rep targets when the rule doesn't carry its own. Without
// this the window defaults live at apply time from `target_reps_min` — which
// progressionPatch *mutates* upward each session as prescribed reps climb — so
// the "reset to min" floor would drift up and the range collapse over
// successive sessions. The editor never sends min_reps/max_reps, so anchoring
// once at persist time keeps the window stable across automated progression.
function anchorDoubleWindow(rule, exercise) {
  if (!rule || rule.type !== 'double') return rule;
  const out = { ...rule };
  if (!hasValue(out.min_reps) && hasValue(exercise.target_reps_min)) {
    out.min_reps = exercise.target_reps_min;
  }
  const maxTarget = hasValue(exercise.target_reps_max) ? exercise.target_reps_max : exercise.target_reps_min;
  if (!hasValue(out.max_reps) && hasValue(maxTarget)) {
    out.max_reps = maxTarget;
  }
  // Re-run the ordering check normalizeProgressionRule can only enforce for an
  // explicit window: a window synthesized here from inverted exercise targets
  // (target_reps_max < target_reps_min — which validateExerciseValues doesn't
  // reject) would otherwise persist min > max and progress on the lower max.
  if (hasValue(out.min_reps) && hasValue(out.max_reps) && out.min_reps > out.max_reps) {
    throw invalidRequest('min_reps must not exceed max_reps');
  }
  return out;
}

// deriveSetScalars mirrors the Go mergePayloadValues contract
// (workout_resolver.go): sets_completed=len, reps_completed=max(reps),
// weight_kg=max(weight_kg) — so propagation, stats, and history keep working
// off the flat aggregates while the per-set array is stored alongside.
function deriveSetScalars(sets) {
  return {
    sets_completed: sets.length,
    reps_completed: sets.reduce((m, s) => Math.max(m, s.reps), 0),
    weight_kg: sets.reduce((m, s) => Math.max(m, s.weight_kg), 0),
  };
}

// logWorkTotals reduces one completed log to its WORKING (non-warmup) load —
// the input to every stats aggregate added for the Load/Balance views
// (med-904.1). Warm-ups are a ramp, not work, so they contribute nothing to
// volume, hard sets or reps.
//
// Per-set logs (Phase 1, epic med-qj4) are the accurate path: Σ weight×reps
// over the working sets. Flat-scalar logs have no per-set breakdown, so they
// keep the historical sets×reps×weight math — where reps_completed is the
// per-set rep count, hence total reps = sets_completed × reps_completed.
//
// `sets` and `hard_sets` are two DIFFERENT questions and both ship:
//   sets      — coverage. Every working set, ungated. "Did I train legs at all?"
//   hard_sets — effort. Only the sets taken near enough to failure.
// Overloading one field on the effort meaning is a bug, not a simplification:
// the Balance view folds coverage and prints the body parts with zero sets
// under "Not Trained", so an effort-gated count would tell a user who squatted
// three honest RPE-5 sets that they never trained legs. Rating honestly must
// never produce falser data than not rating at all.
//
// `hard_sets` counts effort, not sets (med-vov). A working set only counts as
// HARD when it was taken near enough to failure — RIR <= NEAR_FAILURE_RIR, i.e.
// RPE >= 6 — because that is what the term means everywhere it is borrowed from
// (JEFIT's "hard set equivalents"), and a set left 5 reps in reserve is not the
// same stimulus as one taken to failure.
//   • An UNRATED work set STILL COUNTS as hard. rpe is optional per set and
//     rating only the top set is normal practice, so an unrated set means "no
//     opinion", never "too easy" — the same rule workSetStats already applies to
//     minRpe below. Anything else would silently zero this number for every user
//     who doesn't rate every single set (i.e. most of them).
//   • Flat-scalar logs carry no effort at all, so every set counts, unchanged.
// `easy_sets` is the honesty counter: the RATED-but-easy working sets this fold
// excluded, so the UI can say "42 hard · 3 easy" rather than quietly shrinking a
// number users already saw. Volume and reps are unaffected — an easy set is
// still work done, it just isn't a hard set.
function logWorkTotals(log) {
  if (Array.isArray(log.sets) && log.sets.length > 0) {
    const work = log.sets.filter((s) => s && s.set_type !== 'warmup');
    let volume = 0;
    let reps = 0;
    let maxWeight = 0;
    let hardSets = 0;
    let easySets = 0;
    for (const s of work) {
      const w = s.weight_kg || 0;
      const r = s.reps || 0;
      volume += w * r;
      reps += r;
      if (w > maxWeight) maxWeight = w;
      const rir = rirFromRpe(s.rpe);
      if (rir === null || rir <= NEAR_FAILURE_RIR) hardSets++;
      else easySets++;
    }
    return {
      volume_kg: volume,
      sets: work.length,
      hard_sets: hardSets,
      easy_sets: easySets,
      reps,
      max_weight_kg: maxWeight,
    };
  }
  const sets = hasValue(log.sets_completed) ? log.sets_completed : 0;
  const reps = hasValue(log.reps_completed) ? log.reps_completed : 0;
  const weight = hasValue(log.weight_kg) ? log.weight_kg : 0;
  return {
    volume_kg: sets * reps * weight,
    sets,
    hard_sets: sets,
    easy_sets: 0,
    reps: sets * reps,
    max_weight_kg: weight,
  };
}

// workSetStats reduces a completed log to the two numbers the progression
// rules inspect: the count of work (non-warmup) sets and the *minimum* reps
// across them ("hit the target on ALL sets" ⟺ min >= target). Prefers the
// per-set array (Phase 1); when absent, falls back to the derived scalars —
// `sets`=sets_completed (count), `reps`=reps_completed (max). Returns null when
// there's nothing to judge (no reps logged), so the rule leaves the plan alone.
function workSetStats(sets, reps, perSet) {
  if (Array.isArray(perSet) && perSet.length > 0) {
    // Exclude warmup (sub-target ramp) AND drop sets (reduced load, done after
    // the work sets) from the rep-target gate: a drop set's lower reps at lighter
    // weight would otherwise drag minReps below target and suppress a legitimate
    // progression. `failure` stays — it's a work set taken to failure at working
    // weight, so its reps are a valid target judgment.
    const work = perSet.filter((s) => s.set_type !== 'warmup' && s.set_type !== 'drop');
    if (work.length === 0) return null;
    // minRpe is the RPE-side twin of minReps for the RIR gate (med-qj4.6.3):
    // the least-hard work set the user actually RATED. Unlike reps, effort is
    // optional per set, and rating only the top set is normal practice (the
    // science table prescribes "RIR 0-2 on the top set") — so an unrated set
    // means "no opinion", never "failed the gate". Counting it as non-qualifying
    // would silently stop progression for everyone who doesn't rate every single
    // set. No work set rated at all → null → gate open.
    const rpes = work.map((s) => s.rpe).filter((v) => hasValue(v));
    return {
      count: work.length,
      minReps: Math.min(...work.map((s) => s.reps)),
      minRpe: rpes.length ? Math.min(...rpes) : null,
    };
  }
  if (!hasValue(reps)) return null;
  // Flat-scalar logs carry no effort at all (the scalars derive from the sets).
  return { count: hasValue(sets) ? sets : 0, minReps: reps, minRpe: null };
}

// mirrorPatch is today's "mirror last performance" write-back: best-effort
// COALESCE of the logged scalars onto the plan targets, widening
// target_reps_max→null when the log exceeds it. This is the `none` (and
// default) progression behavior.
function mirrorPatch(exercise, sets, reps, weight) {
  const targetRepsMax = (hasValue(reps) && hasValue(exercise.target_reps_max) && reps > exercise.target_reps_max)
    ? null : exercise.target_reps_max;
  return {
    target_sets: hasValue(sets) ? sets : exercise.target_sets,
    target_reps_min: hasValue(reps) ? reps : exercise.target_reps_min,
    target_reps_max: targetRepsMax,
    target_weight_kg: hasValue(weight) ? weight : exercise.target_weight_kg,
  };
}

// progressionPatch computes the plan-target delta for a completed log under the
// exercise's opt-in progression rule (Phase 4, med-qj4.4.1). Returns a partial
// patch merged over the existing record; {} means "leave the plan unchanged"
// (condition not met — the rule holds the target steady rather than mirroring).
//   linear: all work sets hit target_reps_max (and set count >= target_sets)
//           → target_weight_kg += increment_kg; rep range stays fixed.
//   double: rep window [min,max] (defaults from the exercise's rep targets) —
//           all sets at max → weight += increment_kg and reps reset to min;
//           else all sets >= min → prescribed reps climb one toward max.
// `goal` (med-qj4.6.3) parameterizes both presets: its rep band fills in any
// target the user left unset, and its target_rir gates the LOAD BUMP on
// proximity to failure. Nothing here changes for an exercise without an opt-in
// rule, and nothing changes for a log that carries no RPE.
function progressionPatch(exercise, sets, reps, weight, perSet, goal) {
  const rule = exercise.progression_rule;
  if (!rule || rule.type === 'none') return mirrorPatch(exercise, sets, reps, weight);
  const stats = workSetStats(sets, reps, perSet);
  const setsOk = stats && (!hasValue(exercise.target_sets) || stats.count >= exercise.target_sets);
  if (!setsOk) return {};
  // Anchor the bump to the LOGGED weight, not the live plan target. propagate
  // re-fires on every log write while the session is pending/in_progress (the
  // UI re-sends every existing log on each Save), so basing the increment on
  // the mutable target_weight_kg would compound it (62.5→65→67.5…) each save.
  // The logged weight is a stable input, so `logged + increment` is idempotent
  // — same seam the rep-climb already uses (stats.minReps + 1). When the log
  // carries no weight there is NO stable anchor (the plan target is the very
  // thing we mutate, so falling back to it re-compounds), so hold the weight
  // steady — double still resets reps, linear just holds the plan unchanged.
  // A bodyweight log arrives as weight_kg=0 (the UI/deriveSetScalars collapse
  // to 0, never null), so treat non-positive as "no anchor" too — otherwise a
  // bodyweight exercise on linear/double would bump its target to increment_kg.
  const weightBase = (hasValue(weight) && weight > 0) ? weight : null;
  // "Hold the plan": anchor to the stable logged weight so re-propagation is
  // idempotent. If an earlier same-session save qualified (weight += increment)
  // and a later edit no longer does, returning {} would leave that un-earned
  // bump stuck on the plan with no recovery path. No anchor → hold as-is.
  const hold = () => (hasValue(weightBase) ? { target_weight_kg: weightBase } : {});

  // Goal-differentiated preset parameters (med-qj4.6.3). The band FILLS IN only
  // where the user left a rep target unset: an explicit target on the exercise
  // (or an anchored window on the rule) always wins. 0 is createExercise's
  // "unset" default for target_reps_min, not a real target — treated as absent
  // so the goal band can supply a meaningful gate instead of `reps >= 0`.
  const band = defaultsForGoal(goal);
  const pos = (v) => (hasValue(v) && v > 0 ? v : null);

  // RIR gate (med-qj4.6.3): a load bump fires only when the work sets were taken
  // near enough to failure for the goal — RIR = 10 − RPE ≤ the goal's target_rir
  // (strength 2, hypertrophy/endurance 1, general ungated). Hitting the rep
  // target with reps still in reserve holds the plan; that case is the effort
  // insight (med-qj4.6.5), not a heavier bar — `stats.minRpe` + `effortOk` are
  // the hook it reads. No RPE logged → effort unknown → gate open, so users who
  // don't log effort keep today's behavior exactly.
  const worstRir = rirFromRpe(stats.minRpe);
  const effortOk = worstRir === null || !hasValue(band.target_rir) || worstRir <= band.target_rir;

  if (rule.type === 'linear') {
    const goalReps = pos(exercise.target_reps_max) ?? pos(exercise.target_reps_min) ?? band.reps_max;
    if (stats.minReps >= goalReps && effortOk && hasValue(weightBase)) {
      return { target_weight_kg: weightBase + rule.increment_kg };
    }
    return hold();
  }

  // double progression
  const minSet = pos(rule.min_reps) ?? pos(exercise.target_reps_min);
  const maxSet = pos(rule.max_reps) ?? pos(exercise.target_reps_max) ?? pos(exercise.target_reps_min);
  let min = minSet ?? band.reps_min;
  let max = maxSet ?? band.reps_max;
  // The two can cross when only ONE end was set and the goal band supplied the
  // other (e.g. an explicit 6-rep ceiling with no floor, on hypertrophy's floor
  // of 8). The band-derived end always yields — an explicit target must never be
  // rewritten by a default. Both explicit and crossed can't reach here
  // (anchorDoubleWindow rejects an inverted window at persist time); the else is
  // a defensive tie-break.
  if (min > max) {
    if (minSet === null) min = max;
    else max = min;
  }
  if (stats.minReps >= max) {
    // Reps maxed but not near failure → no load bump, no rep reset: the plan
    // stands and the user gets the effort nudge instead.
    if (!effortOk) return hold();
    const patch = { target_reps_min: min, target_reps_max: max };
    if (hasValue(weightBase)) patch.target_weight_kg = weightBase + rule.increment_kg;
    return patch;
  }
  if (stats.minReps >= min) {
    // Deliberately NOT effort-gated: reps in reserve is precisely the signal to
    // prescribe MORE REPS at the same load, which is what this branch does.
    // Track the logged weight here too. propagate merges partial patches over the
    // live (possibly already-bumped) plan, so if an earlier same-session save hit
    // max (reset → weight += increment) and a later edit drops to a mere climb,
    // omitting the weight key would leave the un-earned bump stuck on the plan.
    // weightBase is the stable logged weight, so this is idempotent.
    const patch = { target_reps_min: Math.min(stats.minReps + 1, max), target_reps_max: max };
    if (hasValue(weightBase)) patch.target_weight_kg = weightBase;
    return patch;
  }
  // Below min: same idempotency anchor as the climb branch — an earlier
  // same-session save that hit max bumped the weight; without re-pinning to the
  // logged weight a later edit below min would leave that bump stuck.
  return hold();
}

const VALID_LOG_STATUSES = new Set(['', 'completed', 'skipped']);

// assertNoDuplicateLibraryName ports the DB's
// `UNIQUE INDEX idx_exercise_library_user_name (user_id, name)` (migration
// 028) into an app-layer check, since the cloud records port has no SQL
// constraint to enforce it. Case-sensitive (no COLLATE NOCASE on the real
// index) — matches medications.js's assertNoDuplicate convention (err.code
// 'duplicate', mapped to 409 by the shim's withDuplicateStatus in Task 6).
function assertNoDuplicateLibraryName(all, name, excludeRecordId) {
  const dup = all.some((item) => !item.deleted && item.recordId !== excludeRecordId && item.name === name);
  if (dup) throw invalidRequest('Exercise with this name already exists in your library', 'duplicate');
}

// createWorkoutDomain builds the groups/variants/exercises/library CRUD
// surface over the injected records port. Mirrors
// internal/store/workout/repo.go's group/variant/exercise/library methods +
// internal/server/workout_handlers.go's group handlers +
// internal/server/workout_crud_handlers.go's variant/exercise/library
// handlers. Session/rotation/log/stats/miband ops land in later tasks on
// this same factory.
export function createWorkoutDomain({ records, now, timeZone }) {
  async function activeRecords(type) {
    return (await records.list(type)).filter((r) => !r.deleted);
  }

  // localDateStr renders the "YYYY-MM-DD" local calendar day for `ms` in the
  // device timezone — used everywhere the Go side compares a stored
  // scheduled_date/checked date via string prefix, so day boundaries land on
  // the same instant the deterministic session recordId was minted from.
  function localDateStr(ms, tz) {
    const { year, month, day } = localDateParts(ms, tz);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  // addLocalDays returns the {year, month, day} of the local calendar date
  // `daysAhead` days after `nowMs`'s local date — mirrors Go's
  // `now.AddDate(0, 0, daysAhead)` follow by Year()/Month()/Day(). Calendar-day
  // arithmetic only (no wall-clock instant involved), so plain UTC-based Date
  // math is safe here regardless of DST.
  function addLocalDays(nowMs, tz, daysAhead) {
    const { year, month, day } = localDateParts(nowMs, tz);
    const d = new Date(Date.UTC(year, month - 1, day + daysAhead));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }

  // scheduledDateRFC renders "YYYY-MM-DD" local calendar day as an RFC3339
  // instant carrying the local offset — mirroring Go's time.Time JSON, where
  // scheduled_date is a local-zoned instant. The frontend reads only the date
  // prefix (`scheduled_date.split('T')[0]`) as the local calendar day
  // (next-card.js, history.js, sessions.js), so it MUST equal `dateStr`;
  // rendering via toISOString()/UTC would shift the day backward in
  // positive-offset zones. Value stays a parseable, correctly-ordered instant
  // for sortSessions' `new Date(...).getTime()`.
  function scheduledDateRFC(dateStr, tz) {
    const wallUtc = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10));
    let offMin = Math.round((wallUtc - localWallToUtcMs(wallUtc, tz)) / 60000);
    if (offMin === 0) return `${dateStr}T00:00:00Z`;
    const sign = offMin > 0 ? '+' : '-';
    offMin = Math.abs(offMin);
    const oh = String(Math.floor(offMin / 60)).padStart(2, '0');
    const om = String(offMin % 60).padStart(2, '0');
    return `${dateStr}T00:00:00${sign}${oh}:${om}`;
  }

  // parseHHMM ports fmt.Sscanf(s, "%d:%d", ...)'s leniency: digits, a colon,
  // more digits, trailing content ignored. Returns null on parse failure
  // (caller skips the group, matching the Go continue).
  function parseHHMM(s) {
    const m = /^(\d+):(\d+)/.exec(s || '');
    if (!m) return null;
    return { hour: Number(m[1]), minute: Number(m[2]) };
  }

  // -- Groups --

  async function createGroup(input) {
    const nowMs = now();
    const record = {
      recordId: genRecordId('group', nowMs),
      clientTs: nowMs,
      deleted: false,
      id: mintNumericId(await records.list(WORKOUT_RECORD_TYPES.GROUP), nowMs),
      user_id: CLOUD_USER_ID,
      name: (input && input.name) || '',
      description: (input && input.description) || '',
      is_rotating: !!(input && input.is_rotating),
      days_of_week: (input && input.days_of_week) || '[]',
      scheduled_time: (input && input.scheduled_time) || '',
      notification_advance_minutes: Number(input && input.notification_advance_minutes) || 0,
      training_goal: normalizeGoal(input && input.training_goal),
      // CreateGroup's INSERT omits the `active` column, so it always takes
      // the schema DEFAULT 1 regardless of what the create request sends.
      active: true,
      created_at: new Date(nowMs).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
    };
    await records.put(WORKOUT_RECORD_TYPES.GROUP, record);
    return toGroupResponse(record);
  }

  // list({activeOnly}) mirrors ListGroups(userID, activeOnly) — activeOnly
  // is only ever passed true by the (Task 3) next-workout engine; the HTTP
  // list route always passes false.
  async function listGroups({ activeOnly } = {}) {
    let all = await activeRecords(WORKOUT_RECORD_TYPES.GROUP);
    if (activeOnly) all = all.filter((g) => g.active);
    all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return all.map(toGroupResponse);
  }

  async function updateGroup(id, input) {
    const group = await findByNumericId(records, WORKOUT_RECORD_TYPES.GROUP, id);
    // UpdateGroup's `UPDATE ... WHERE id = ?` silently matches zero rows on
    // an unknown id — no error, so no-op here too.
    if (!group) return;
    const nowMs = now();
    await records.put(WORKOUT_RECORD_TYPES.GROUP, {
      ...group,
      name: (input && input.name) || '',
      description: (input && input.description) || '',
      is_rotating: !!(input && input.is_rotating),
      days_of_week: (input && input.days_of_week) || '[]',
      scheduled_time: (input && input.scheduled_time) || '',
      notification_advance_minutes: Number(input && input.notification_advance_minutes) || 0,
      training_goal: normalizeGoal(input && input.training_goal),
      active: !!(input && input.active),
      clientTs: nowMs,
      updated_at: new Date(nowMs).toISOString(),
    });
  }

  // deleteGroup ports DeleteGroup's precondition guards (repo.go:222) verbatim
  // — refuse while exercises remain in any of the group's variants, or while
  // sessions are still pending/active — then cascades rotation state +
  // schedule-snapshot-equivalent (none ported, see plan) + variants before
  // deleting the group itself.
  async function deleteGroup(id) {
    const variants = (await activeRecords(WORKOUT_RECORD_TYPES.VARIANT)).filter((v) => v.group_id === id);
    const variantIds = new Set(variants.map((v) => v.id));
    const exerciseCount = (await activeRecords(WORKOUT_RECORD_TYPES.EXERCISE))
      .filter((e) => variantIds.has(e.variant_id)).length;
    if (exerciseCount > 0) {
      throw invalidRequest(`cannot delete group: remove all exercises from its variants first (${exerciseCount} remaining)`, 'precondition_failed');
    }
    const activeSessionCount = (await activeRecords(WORKOUT_RECORD_TYPES.SESSION))
      .filter((s) => s.group_id === id && s.status !== 'completed' && s.status !== 'skipped').length;
    if (activeSessionCount > 0) {
      throw invalidRequest(`cannot delete group: it has ${activeSessionCount} pending/active sessions`, 'precondition_failed');
    }

    await records.del(WORKOUT_RECORD_TYPES.ROTATION, rotationRecordId(id));
    for (const v of variants) await records.del(WORKOUT_RECORD_TYPES.VARIANT, v.recordId);
    const group = await findByNumericId(records, WORKOUT_RECORD_TYPES.GROUP, id);
    if (group) await records.del(WORKOUT_RECORD_TYPES.GROUP, group.recordId);
  }

  // -- Variants --

  async function createVariant(input) {
    const nowMs = now();
    const record = {
      recordId: genRecordId('variant', nowMs),
      clientTs: nowMs,
      deleted: false,
      id: mintNumericId(await records.list(WORKOUT_RECORD_TYPES.VARIANT), nowMs),
      group_id: Number(input && input.group_id) || 0,
      name: (input && input.name) || '',
      rotation_order: numOrNull(input && input.rotation_order, true),
      description: (input && input.description) || '',
      created_at: new Date(nowMs).toISOString(),
    };
    await records.put(WORKOUT_RECORD_TYPES.VARIANT, record);
    return toVariantResponse(record);
  }

  // listVariants mirrors ListVariantsByGroup's
  // `ORDER BY COALESCE(rotation_order, 999), name ASC`.
  async function listVariants(groupId) {
    const all = (await activeRecords(WORKOUT_RECORD_TYPES.VARIANT)).filter((v) => v.group_id === groupId);
    all.sort((a, b) => {
      const ra = hasValue(a.rotation_order) ? a.rotation_order : 999;
      const rb = hasValue(b.rotation_order) ? b.rotation_order : 999;
      if (ra !== rb) return ra - rb;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return all.map(toVariantResponse);
  }

  async function updateVariant(id, input) {
    const variant = await findByNumericId(records, WORKOUT_RECORD_TYPES.VARIANT, id);
    if (!variant) return;
    await records.put(WORKOUT_RECORD_TYPES.VARIANT, {
      ...variant,
      name: (input && input.name) || '',
      rotation_order: numOrNull(input && input.rotation_order, true),
      description: (input && input.description) || '',
      clientTs: now(),
    });
  }

  // deleteVariant cascades to its exercises first (DeleteVariant, repo.go:346).
  async function deleteVariant(id) {
    const variant = await findByNumericId(records, WORKOUT_RECORD_TYPES.VARIANT, id);
    if (!variant) return;
    const exercises = (await activeRecords(WORKOUT_RECORD_TYPES.EXERCISE)).filter((e) => e.variant_id === id);
    for (const e of exercises) await records.del(WORKOUT_RECORD_TYPES.EXERCISE, e.recordId);
    await records.del(WORKOUT_RECORD_TYPES.VARIANT, variant.recordId);
  }

  // -- Exercises --

  async function createExercise(input) {
    const nowMs = now();
    const record = {
      recordId: genRecordId('exercise', nowMs),
      clientTs: nowMs,
      deleted: false,
      id: mintNumericId(await records.list(WORKOUT_RECORD_TYPES.EXERCISE), nowMs),
      variant_id: Number(input && input.variant_id) || 0,
      exercise_name: ((input && input.exercise_name) || '').trim(),
      target_sets: Number(input && input.target_sets) || 0,
      target_reps_min: Number(input && input.target_reps_min) || 0,
      target_reps_max: numOrNull(input && input.target_reps_max, true),
      target_weight_kg: numOrNull(input && input.target_weight_kg),
      order_index: Number(input && input.order_index) || 0,
    };
    const rule = normalizeProgressionRule(input && input.progression_rule);
    if (rule) record.progression_rule = anchorDoubleWindow(rule, record);
    // Optional per-exercise goal override — store only a valid enum value;
    // absent/blank/invalid means inherit from the routine (med-qj4.6.1).
    const goal = input && input.training_goal;
    if (TRAINING_GOALS.includes(goal)) record.training_goal = goal;
    // med-spp / med-prk.2: promote the plan exercise into the library
    // (Exercises tab), deduped by name to match the Go (user_id, name) unique
    // index, and link back via exercise_library_id so a later library rename
    // shows through in this plan exercise. Mirrors CreateExerciseInVariant's
    // ON CONFLICT DO NOTHING upsert + FK write.
    const libId = await promoteExerciseToLibrary(record);
    if (libId) record.exercise_library_id = libId;
    await records.put(WORKOUT_RECORD_TYPES.EXERCISE, record);
    // On create the resolved name is just record.exercise_name (the trimmed name
    // we promoted from), so skip the extra libraryById() scan and match Go, which
    // trims and stores the same name in both columns.
    return toExerciseResponse(record);
  }

  // libraryById maps id → non-deleted library record, for resolving the
  // canonical exercise name on read (the JS side of the Go LEFT JOIN).
  async function libraryById() {
    const m = new Map();
    for (const item of await activeRecords(WORKOUT_RECORD_TYPES.LIBRARY)) m.set(item.id, item);
    return m;
  }

  // promoteExerciseToLibrary upserts a library record from a plan exercise,
  // seeding defaults from its targets, and returns the library row's numeric id
  // (existing or newly minted). No-op returning null when the name is blank.
  // The upsert-by-name counterpart of the Go upsert; returning the existing id
  // makes "same name twice = one library row" hold on both create and update.
  async function promoteExerciseToLibrary(exercise) {
    const name = (exercise.exercise_name || '').trim();
    if (!name) return null;
    const all = await records.list(WORKOUT_RECORD_TYPES.LIBRARY);
    const existing = all.find((item) => !item.deleted && item.name === name);
    if (existing) return existing.id;
    const nowMs = now();
    const id = mintNumericId(all, nowMs);
    await records.put(WORKOUT_RECORD_TYPES.LIBRARY, {
      recordId: genRecordId('library', nowMs),
      clientTs: nowMs,
      deleted: false,
      id,
      user_id: CLOUD_USER_ID,
      name,
      default_sets: exercise.target_sets,
      default_reps_min: exercise.target_reps_min,
      default_reps_max: exercise.target_reps_max,
      default_weight_kg: exercise.target_weight_kg,
      notes: '',
      created_at: new Date(nowMs).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
    });
    return id;
  }

  async function listExercises(variantId) {
    const all = (await activeRecords(WORKOUT_RECORD_TYPES.EXERCISE)).filter((e) => e.variant_id === variantId);
    all.sort((a, b) => a.order_index - b.order_index);
    const libById = await libraryById();
    return all.map((e) => toExerciseResponse(e, libById));
  }

  async function updateExercise(id, input) {
    const exercise = await findByNumericId(records, WORKOUT_RECORD_TYPES.EXERCISE, id);
    if (!exercise) return;
    const updated = {
      ...exercise,
      exercise_name: ((input && input.exercise_name) || '').trim(),
      target_sets: Number(input && input.target_sets) || 0,
      target_reps_min: Number(input && input.target_reps_min) || 0,
      target_reps_max: numOrNull(input && input.target_reps_max, true),
      target_weight_kg: numOrNull(input && input.target_weight_kg),
      order_index: Number(input && input.order_index) || 0,
      clientTs: now(),
    };
    // Replace the rule from the incoming payload. normalize returns null for an
    // explicit `none`; only then (i.e. the key is PRESENT) do we clear a stored
    // rule. A payload that OMITS the key entirely (e.g. the MCP
    // workouts.exercises.update op, whose body schema has no progression_rule
    // field, or any non-editor writer) must PRESERVE the stored rule rather than
    // silently wipe the user's opt-in progression config. The web editor always
    // sends the key, so its "None clears the rule" behavior is unchanged.
    const rule = normalizeProgressionRule(input && input.progression_rule);
    if (rule) {
      // Preserve an already-anchored double window when the payload omits it —
      // the editor only round-trips {type, increment_kg}. anchorDoubleWindow
      // would otherwise re-derive min/max from target_reps_min, which
      // progressionPatch has already climbed, collapsing the range on any edit.
      // BUT only preserve when BOTH visible rep targets are unchanged from the
      // stored exercise. The editor loads target_reps_{min,max} and writes them
      // back verbatim (parseInt round-trip), so an untouched save re-sends the
      // stored — possibly climbed — values; a deliberate range change (either
      // floor OR ceiling, e.g. 8-12 → 6-12) moves at least one and must re-anchor
      // to the new targets rather than keep the stale hidden window. Comparing
      // the ceiling alone missed floor-only edits, keeping a stale reset floor.
      const prev = exercise.progression_rule;
      const targetsUnchanged =
        updated.target_reps_min === exercise.target_reps_min &&
        updated.target_reps_max === exercise.target_reps_max;
      if (rule.type === 'double' && prev && prev.type === 'double' && targetsUnchanged) {
        if (!hasValue(rule.min_reps) && hasValue(prev.min_reps)) rule.min_reps = prev.min_reps;
        if (!hasValue(rule.max_reps) && hasValue(prev.max_reps)) rule.max_reps = prev.max_reps;
      }
      updated.progression_rule = anchorDoubleWindow(rule, updated);
    } else if (input && 'progression_rule' in input) {
      delete updated.progression_rule;
    }
    // Per-exercise goal override: a valid enum sets it; the editor sending a
    // blank value (key PRESENT) clears it back to "inherit"; a payload that
    // OMITS the key preserves the stored override (mirrors progression_rule).
    const goal = input && input.training_goal;
    if (TRAINING_GOALS.includes(goal)) updated.training_goal = goal;
    else if (input && 'training_goal' in input) delete updated.training_goal;
    // Mirror the Go UpdateExercise upsert-by-name: relink the FK to the library
    // row for the (possibly changed) name.
    // Clear the FK on a blank name (promote returns null) so the read falls back
    // to the cached exercise_name and no whitespace-only library row is created —
    // matching Go, which nulls the FK on a blank name (repo.go UpdateExercise).
    updated.exercise_library_id = (await promoteExerciseToLibrary(updated)) ?? null;
    await records.put(WORKOUT_RECORD_TYPES.EXERCISE, updated);
  }

  async function deleteExercise(id) {
    const exercise = await findByNumericId(records, WORKOUT_RECORD_TYPES.EXERCISE, id);
    if (exercise) await records.del(WORKOUT_RECORD_TYPES.EXERCISE, exercise.recordId);
  }

  // -- Exercise library --

  async function createLibraryItem(input) {
    const name = ((input && input.name) || '').trim();
    if (!name) throw invalidRequest('Name is required');
    const all = await records.list(WORKOUT_RECORD_TYPES.LIBRARY);
    assertNoDuplicateLibraryName(all, name, null);
    const nowMs = now();
    const record = {
      recordId: genRecordId('library', nowMs),
      clientTs: nowMs,
      deleted: false,
      id: mintNumericId(all, nowMs),
      user_id: CLOUD_USER_ID,
      name,
      default_sets: Number(input && input.default_sets) || 0,
      default_reps_min: Number(input && input.default_reps_min) || 0,
      default_reps_max: numOrNull(input && input.default_reps_max, true),
      default_weight_kg: numOrNull(input && input.default_weight_kg),
      notes: (input && input.notes) || '',
      body_part: ((input && input.body_part) || '').trim(),
      created_at: new Date(nowMs).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
    };
    await records.put(WORKOUT_RECORD_TYPES.LIBRARY, record);
    return toLibraryResponse(record);
  }

  // listUniqueExercises ports ListAllUniqueExercises (repo.go:448): the
  // exercise library when it has entries, else the highest-id row per distinct
  // exercise name across every variant, alphabetical. Shape is WorkoutExercise
  // either way.
  async function listUniqueExercises() {
    const lib = await listLibrary();
    if (lib.length > 0) {
      return lib.map((item) => toExerciseResponse({
        id: item.id,
        variant_id: 0,
        exercise_name: item.name,
        target_sets: item.default_sets,
        target_reps_min: item.default_reps_min,
        target_reps_max: item.default_reps_max,
        target_weight_kg: item.default_weight_kg,
        order_index: 0,
      }));
    }
    const latestByName = new Map();
    for (const e of await activeRecords(WORKOUT_RECORD_TYPES.EXERCISE)) {
      const prev = latestByName.get(e.exercise_name);
      if (!prev || e.id > prev.id) latestByName.set(e.exercise_name, e);
    }
    return [...latestByName.values()]
      .sort((a, b) => a.exercise_name.localeCompare(b.exercise_name))
      .map((e) => toExerciseResponse(e));
  }

  async function listLibrary() {
    const all = await activeRecords(WORKOUT_RECORD_TYPES.LIBRARY);
    all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return all.map(toLibraryResponse);
  }

  async function updateLibraryItem(id, input) {
    const item = await findByNumericId(records, WORKOUT_RECORD_TYPES.LIBRARY, id);
    if (!item) return;
    const name = ((input && input.name) || '').trim();
    if (!name) throw invalidRequest('Name is required');
    const all = await records.list(WORKOUT_RECORD_TYPES.LIBRARY);
    assertNoDuplicateLibraryName(all, name, item.recordId);
    const nowMs = now();
    await records.put(WORKOUT_RECORD_TYPES.LIBRARY, {
      ...item,
      name,
      default_sets: Number(input && input.default_sets) || 0,
      default_reps_min: Number(input && input.default_reps_min) || 0,
      default_reps_max: numOrNull(input && input.default_reps_max, true),
      default_weight_kg: numOrNull(input && input.default_weight_kg),
      notes: (input && input.notes) || '',
      body_part: ((input && input.body_part) || '').trim(),
      clientTs: nowMs,
      updated_at: new Date(nowMs).toISOString(),
    });
  }

  async function deleteLibraryItem(id) {
    const item = await findByNumericId(records, WORKOUT_RECORD_TYPES.LIBRARY, id);
    if (!item) return;
    // Mirror Go's DeleteExerciseLibraryItem: snapshot this library row's
    // (possibly renamed) name into every plan exercise that still references it
    // and clear the FK, so deleting a library item leaves plans showing its last
    // name instead of reverting to a stale cached exercise_name + dangling ref.
    const refless = (await activeRecords(WORKOUT_RECORD_TYPES.EXERCISE))
      .filter((e) => e.exercise_library_id === id);
    for (const ex of refless) {
      await records.put(WORKOUT_RECORD_TYPES.EXERCISE, {
        ...ex,
        exercise_name: item.name,
        exercise_library_id: null,
        clientTs: now(),
      });
    }
    await records.del(WORKOUT_RECORD_TYPES.LIBRARY, item.recordId);
  }

  // -- Rotation state --

  async function getRotationState(groupId) {
    const all = await activeRecords(WORKOUT_RECORD_TYPES.ROTATION);
    const rec = all.find((r) => r.recordId === rotationRecordId(groupId));
    return rec ? toRotationResponse(rec) : null;
  }

  async function initializeRotation(groupId, startingVariantId) {
    // Go's INSERT OR REPLACE happily writes a group_id=0 row from an empty
    // request body; refuse instead, so a malformed MCP call can't strand an
    // orphan rotation record in the vault (LWW never garbage-collects it).
    if (!groupId || !startingVariantId) {
      throw invalidRequest('group_id and starting_variant_id are required');
    }
    const nowMs = now();
    const record = {
      recordId: rotationRecordId(groupId),
      clientTs: nowMs,
      deleted: false,
      group_id: groupId,
      current_variant_id: startingVariantId,
      last_session_date: null,
      updated_at: new Date(nowMs).toISOString(),
    };
    await records.put(WORKOUT_RECORD_TYPES.ROTATION, record);
    return toRotationResponse(record);
  }

  // advanceRotation ports AdvanceRotation (repo.go:653): variants ordered by
  // rotation_order/name, circular next, reset-to-0 when the cursor no longer
  // matches a variant. Deviation from the Go source: Go errors when no
  // rotation state row exists yet, because the background scheduler
  // auto-initializes one (internal/scheduler/workout.go:198) on its first
  // tick for a rotating group — that scheduler loop is out of scope for
  // C2d (see plan Overview), so nothing else in this file would ever call
  // initializeRotation. Auto-initializing here (to the first variant) keeps
  // rotation actually advancing in cloud mode instead of silently never
  // starting.
  async function advanceRotation(groupId) {
    const variants = await listVariants(groupId);
    if (variants.length === 0) throw invalidRequest(`no variants found for group ${groupId}`);

    let state = await getRotationState(groupId);
    if (!state) state = await initializeRotation(groupId, variants[0].id);

    let currentIndex = variants.findIndex((v) => v.id === state.current_variant_id);
    if (currentIndex === -1) currentIndex = 0;
    const nextVariantId = variants[(currentIndex + 1) % variants.length].id;

    const nowMs = now();
    await records.put(WORKOUT_RECORD_TYPES.ROTATION, {
      recordId: rotationRecordId(groupId),
      clientTs: nowMs,
      deleted: false,
      group_id: groupId,
      current_variant_id: nextVariantId,
      last_session_date: new Date(nowMs).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
    });
    // ponytail: a future day materialized off the OLD cursor keeps its stale
    // variant_id, which getNext's PRIORITY 2 already overrides with the live
    // cursor when it renders that day — a pre-existing split between what the
    // card names and what the record stores (reachable through any skip with a
    // future day materialized). Re-pointing those records here also has to
    // migrate their exercise_snapshot/logs, so it is its own bead, not a rider
    // on bd med-gmyf.
  }

  // tryAdvanceRotation is the best-effort wrapper service.go's SkipSession/
  // CompleteSession use: rotation-advance failures never fail the primary
  // transition, they're swallowed (the Go side logs and moves on).
  async function tryAdvanceRotation(session) {
    if (!session) return;
    const group = await findByNumericId(records, WORKOUT_RECORD_TYPES.GROUP, session.group_id);
    if (!group || !group.is_rotating) return;
    try {
      await advanceRotation(group.id);
    } catch {
      // best-effort — matches service.go's tryAdvanceRotation swallowing the error.
    }
  }

  // resolveVariantId ports next.go's resolveVariantID: the rotation cursor for
  // rotating groups (whatever it is, even if stale — matches Go, which does
  // not validate it here), else the first variant. Returns 0 (no variants).
  async function resolveVariantId(group) {
    if (group.is_rotating) {
      const state = await getRotationState(group.id);
      if (state) return state.current_variant_id;
    }
    const variants = await listVariants(group.id);
    return variants.length > 0 ? variants[0].id : 0;
  }

  // -- Sessions --

  async function findSession(id) {
    return findByNumericId(records, WORKOUT_RECORD_TYPES.SESSION, id);
  }

  async function countSessionExerciseLogs(sessionId) {
    const logs = await activeRecords(WORKOUT_RECORD_TYPES.LOG);
    return logs.filter((l) => l.session_id === sessionId).length;
  }

  // createAdHocSession ports CreateAdHocSession (repo.go:721): -1/-1 sentinel
  // group/variant, already in_progress, started_at=now. The HTTP handler
  // wraps this in `{session, group_name: "Ad-hoc Workout", variant_name: ""}`
  // — that wrapping is shim glue (Task 6), not a domain concern.
  //
  // Optional recordId/notes support the Telegram /workout drain (bd med-eas.29.5):
  // a deterministic recordId (tg-<eventId>) makes a re-drain overwrite the same
  // session instead of logging a second workout — the same idempotency the /bp
  // command path relies on — and notes carries the optional workout label.
  async function createAdHocSession({ recordId, notes } = {}) {
    const nowMs = now();
    // At most one IN-FLIGHT session at a time: a second Start tap resumes the
    // session already running today instead of minting a duplicate (bd med-9tx).
    // Only `in_progress` counts — a `pre_skipped` session was explicitly
    // declined and a `notified` one merely had its reminder fire, so resuming
    // either would hand the user the scheduled variant's planned exercises in
    // what they asked to be a fresh ad-hoc (bd med-3q8.2: the session modal
    // pre-fills the plan for any session with variant_id > 0). This is
    // deliberately narrower than getNext's PRIORITY-0 filter, which is about
    // what to SURFACE next, not what an explicit Start should adopt.
    //
    // A caller-supplied recordId (the Telegram drain) skips the guard entirely:
    // that path is idempotent by recordId — a re-drain overwrites its own
    // record — and must not adopt, and then complete, the app's live session.
    if (!recordId) {
      const todayStr = localDateStr(nowMs, timeZone);
      const activeToday = (await activeRecords(WORKOUT_RECORD_TYPES.SESSION))
        .filter((s) => s.status === 'in_progress'
          && localDateStr(new Date(s.scheduled_date).getTime(), timeZone) === todayStr)
        .sort((a, b) => (a.scheduled_time < b.scheduled_time ? -1 : a.scheduled_time > b.scheduled_time ? 1 : 0));
      if (activeToday.length > 0) {
        return toSessionResponse(activeToday[0]);
      }
    }
    const record = {
      recordId: recordId || genRecordId('session', nowMs),
      clientTs: nowMs,
      deleted: false,
      id: mintNumericId(await records.list(WORKOUT_RECORD_TYPES.SESSION), nowMs),
      user_id: CLOUD_USER_ID,
      group_id: ADHOC_ID,
      variant_id: ADHOC_ID,
      scheduled_date: scheduledDateRFC(localDateStr(nowMs, timeZone), timeZone),
      scheduled_time: formatHHMM(nowMs, timeZone),
      status: 'in_progress',
      started_at: new Date(nowMs).toISOString(),
      completed_at: null,
      snoozed_until: null,
      snooze_count: 0,
      notification_message_id: null,
      notes: notes || '',
    };
    await records.put(WORKOUT_RECORD_TYPES.SESSION, record);
    return toSessionResponse(record);
  }

  // schedulePlannedAdHocSession ports handleScheduleAdHocWorkoutSession's
  // validation (workout_schedule_handlers.go) plus SchedulePlannedAdHocSession
  // (service.go:202) — in cloud mode the domain module is the only validation
  // seam, so the handler's guards live here. Placeholders carry no
  // sets/reps/weight, matching the Go LogExerciseWithSource(nil, nil, nil)
  // call; the targets exist only to name the exercises up front.
  async function schedulePlannedAdHocSession(input) {
    const dateStr = (input && input.scheduled_date) || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw invalidRequest('scheduled_date must be YYYY-MM-DD');
    const timeStr = (input && input.scheduled_time) || '';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeStr)) throw invalidRequest('scheduled_time must be HH:MM');

    const requested = (input && input.exercises) || [];
    if (requested.length === 0) throw invalidRequest('exercises must not be empty');
    if (requested.length > MAX_SCHEDULED_EXERCISES) throw invalidRequest('too many exercises in a single request');

    const nowMs = now();
    const wallUtc = Date.UTC(
      +dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10),
      +timeStr.slice(0, 2), +timeStr.slice(3, 5),
    );
    if (localWallToUtcMs(wallUtc, timeZone) <= nowMs) throw invalidRequest('scheduled time is in the past');

    // The unique index on workout_exercise_logs is (session_id, exercise_id,
    // source) WHERE exercise_id > 0, so it catches neither two free-form
    // entries with the same name nor a library entry colliding with one.
    const library = await listLibrary();
    const seenIds = new Set();
    const seenNames = new Set();
    const planned = [];
    for (const ex of requested) {
      const exerciseId = Number(ex && ex.exercise_id) || 0;
      if (exerciseId < 0) throw invalidRequest('exercises[].exercise_id must be >= 0');
      let name = String((ex && ex.exercise_name) || '').trim();
      if (!name && !exerciseId) throw invalidRequest('exercises[] requires exercise_id or exercise_name');
      const sets = Number(ex && ex.target_sets) || 0;
      const repsMin = Number(ex && ex.target_reps_min) || 0;
      if (sets < 1 || repsMin < 1) throw invalidRequest('exercises[].target_sets and target_reps_min must be >= 1');
      const repsMax = numOrNull(ex && ex.target_reps_max, true);
      if (repsMax !== null && repsMax < repsMin) {
        throw invalidRequest('exercises[].target_reps_max must be >= target_reps_min');
      }
      if (exerciseId > 0) {
        if (seenIds.has(exerciseId)) {
          throw invalidRequest('exercises[].exercise_id values must be unique within a request');
        }
        seenIds.add(exerciseId);
        const item = library.find((l) => l.id === exerciseId);
        if (!item) throw invalidRequest("exercises[].exercise_id not found in this user's library");
        if (!name) name = item.name;
      }
      const nameKey = name.toLowerCase();
      if (nameKey) {
        if (seenNames.has(nameKey)) throw invalidRequest('exercises[] names must be unique within a request');
        seenNames.add(nameKey);
      }
      planned.push({ exerciseId, name });
    }

    const session = {
      recordId: genRecordId('session', nowMs),
      clientTs: nowMs,
      deleted: false,
      id: mintNumericId(await records.list(WORKOUT_RECORD_TYPES.SESSION), nowMs),
      user_id: CLOUD_USER_ID,
      group_id: ADHOC_ID,
      variant_id: ADHOC_ID,
      scheduled_date: scheduledDateRFC(dateStr, timeZone),
      scheduled_time: timeStr,
      status: 'pending',
      started_at: null,
      completed_at: null,
      snoozed_until: null,
      snooze_count: 0,
      notification_message_id: null,
      notes: '',
    };
    await records.put(WORKOUT_RECORD_TYPES.SESSION, session);

    try {
      const logs = await records.list(WORKOUT_RECORD_TYPES.LOG);
      for (const ex of planned) {
        const record = {
          recordId: genRecordId('log', nowMs),
          clientTs: nowMs,
          deleted: false,
          id: mintNumericId(logs, nowMs),
          session_id: session.id,
          exercise_id: ex.exerciseId,
          exercise_name: ex.name,
          sets_completed: null,
          reps_completed: null,
          weight_kg: null,
          sets: [],
          status: '',
          notes: '',
          logged_at: new Date(nowMs).toISOString(),
          source: ex.exerciseId > 0 ? 'library' : 'schedule',
        };
        logs.push(record);
        await records.put(WORKOUT_RECORD_TYPES.LOG, record);
      }
    } catch (e) {
      // Roll back rather than leave a session whose placeholders are partial
      // (deleteSession also removes the ones already written).
      await deleteSession(session.id);
      throw e;
    }

    return { session: toSessionResponse(session), planned: planned.length };
  }

  // startSession ports StartSession + the service-level ClearSnooze that
  // always follows it (service.go:153) as one combined write — both are
  // plain SQL column UPDATEs in the Go source with no observable
  // intermediate state, so folding them is behavior-preserving. A missing
  // session no-ops (mirrors `UPDATE ... WHERE id = ?` matching zero rows).
  async function startSession(id) {
    const session = await findSession(id);
    if (!session) return;
    const nowMs = now();
    // bd med-gmyf: starting a session scheduled for another day logs the workout
    // for TODAY, it does not consume the other day's slot. The card offers
    // "Start Scheduled" on whatever occurrence getNext surfaces, which on a
    // rest day (or after today's slot is done) is a future one — starting it
    // marked Friday complete on a Wednesday, killing Friday's reminder and card.
    // Re-key onto today's deterministic slot for the same group, carrying the
    // started session's variant, and leave the original untouched (pending).
    // Ad-hoc sessions (group_id -1) have no per-day slot, so they start as-is.
    const todayStr = localDateStr(nowMs, timeZone);
    let target = session;
    if (session.group_id > 0
      && localDateStr(new Date(session.scheduled_date).getTime(), timeZone) !== todayStr) {
      const slot = await findOrCreateScheduledSession(session.group_id, todayStr, session.variant_id);
      // Starting used to clear the tapped session's snooze. Now that the tapped
      // session survives, an ALREADY-ELAPSED snooze on it would keep winning
      // getNext's PRIORITY 1 and re-prompt the workout the user just did — the
      // old day is done with, so drop it (a still-live snooze is left alone).
      if (session.snoozed_until && new Date(session.snoozed_until).getTime() <= nowMs) {
        await records.put(WORKOUT_RECORD_TYPES.SESSION, { ...session, snoozed_until: null, clientTs: nowMs });
      }
      // Today's own occurrence is already completed/skipped (that is one reason
      // getNext surfaced a future one at all): reopening it would rewrite a
      // finished workout — old completed_at, its logs, a second rotation
      // advance on re-completion. A second workout on a finished day IS an
      // ad-hoc session, so mint one instead (it also adopts a session already
      // running today rather than duplicating).
      if (slot.status === 'completed' || slot.status === 'skipped') {
        await createAdHocSession();
        return;
      }
      target = slot;
    }
    await records.put(WORKOUT_RECORD_TYPES.SESSION, {
      ...target,
      status: 'in_progress',
      started_at: new Date(nowMs).toISOString(),
      snoozed_until: null,
      clientTs: nowMs,
    });
  }

  async function snoozeSession(id, minutes) {
    const session = await findSession(id);
    if (!session) return;
    const nowMs = now();
    await records.put(WORKOUT_RECORD_TYPES.SESSION, {
      ...session,
      snoozed_until: new Date(nowMs + Number(minutes) * 60 * 1000).toISOString(),
      snooze_count: (session.snooze_count || 0) + 1,
      clientTs: nowMs,
    });
  }

  async function skipSession(id) {
    const session = await findSession(id);
    if (!session) return;
    await records.put(WORKOUT_RECORD_TYPES.SESSION, { ...session, status: 'skipped', clientTs: now() });
    await tryAdvanceRotation(session);
  }

  // findOrCreateScheduledSession resolves the deterministic slot for a recurring
  // group reminder. A Telegram snooze/skip tap arrives BEFORE the session is
  // materialized (the reminder fires ahead of getNext's first run), so the drain
  // must find-or-create `session-<groupId>-<date>` rather than look up a numeric
  // id. A materialized session with this recordId also suppresses future primary
  // fires via reminders.js sessionStatusByKey.
  // `variantIdOverride` pins the created session's variant instead of resolving
  // the group's rotation cursor — startSession's re-key path carries the variant
  // the user tapped Start on, so re-dating the workout doesn't also swap it.
  async function findOrCreateScheduledSession(groupId, date, variantIdOverride) {
    const recordId = sessionRecordId(groupId, date);
    const existing = (await activeRecords(WORKOUT_RECORD_TYPES.SESSION)).find((s) => s.recordId === recordId);
    if (existing) return existing;
    const nowMs = now();
    // Resolve the group's current variant + scheduled time exactly like getNext's
    // PRIORITY-2 materialization: this session is the one getNext surfaces (P0
    // while still notified today, P1 once the snooze elapses) and buildSessionResponse
    // reads variant_id/scheduled_time straight off it, so leaving them at 0/''
    // would render the next-workout card as "Unknown" variant, 0 exercises, no time.
    const group = await findByNumericId(records, WORKOUT_RECORD_TYPES.GROUP, groupId);
    const variantId = variantIdOverride || (group ? await resolveVariantId(group) : 0);
    return {
      recordId,
      clientTs: nowMs,
      deleted: false,
      id: mintNumericId(await records.list(WORKOUT_RECORD_TYPES.SESSION), nowMs),
      user_id: CLOUD_USER_ID,
      group_id: groupId,
      variant_id: variantId || 0,
      scheduled_date: scheduledDateRFC(date, timeZone),
      scheduled_time: group ? group.scheduled_time : '',
      status: 'notified',
      started_at: null,
      completed_at: null,
      snoozed_until: null,
      snooze_count: 0,
      notification_message_id: null,
      notes: '',
    };
  }

  // snoozeScheduledSession / skipScheduledSession are the Telegram-drain twins of
  // snoozeSession/skipSession, resolving by (groupId, date) instead of numeric id
  // so a tap can land before the session exists. The caller pins now() to the
  // server tap time (like the med path), so these read now() like their twins.
  async function snoozeScheduledSession({ groupId, date, minutes }) {
    const session = await findOrCreateScheduledSession(groupId, date);
    const nowMs = now();
    const snoozedUntil = new Date(nowMs + Number(minutes) * 60 * 1000).toISOString();
    // The inbox drain is at-least-once (inbox.js drain rule 2): a crash between
    // flush and ack re-applies this event. now() is pinned to the server tap
    // time, so a redelivery yields the identical snoozedUntil — skip it so
    // snooze_count is not re-incremented. A genuine second tap arrives with a
    // different at_unix (hence a different snoozedUntil) and still applies.
    if (session.snoozed_until === snoozedUntil) return;
    await records.put(WORKOUT_RECORD_TYPES.SESSION, {
      ...session,
      snoozed_until: snoozedUntil,
      snooze_count: (session.snooze_count || 0) + 1,
      clientTs: nowMs,
    });
  }

  async function skipScheduledSession({ groupId, date }) {
    const session = await findOrCreateScheduledSession(groupId, date);
    // Same at-least-once re-apply guard: advanceRotation is NOT idempotent, so
    // only advance on a real transition into a terminal state. A redelivery — or
    // a session already terminal (skipped OR completed elsewhere) — must no-op:
    // a stale/re-delivered Skip must not overwrite a completed session to skipped
    // nor advance rotation a second time on top of the completion.
    if (session.status === 'skipped' || session.status === 'completed') return;
    await records.put(WORKOUT_RECORD_TYPES.SESSION, { ...session, status: 'skipped', clientTs: now() });
    await tryAdvanceRotation(session);
  }

  async function completeSession(id) {
    const session = await findSession(id);
    if (!session) return;
    // Already completed: no-op, mirroring skipSession's guard above. A second
    // completion is not cosmetic — it re-stamps completed_at with a fresh
    // clientTs (so the rewrite wins LWW across devices) and re-runs
    // tryAdvanceRotation, which is NOT idempotent: a rotating group would skip
    // a variant (Push -> Legs). Only `completed` bails; pending / notified /
    // pre_skipped / in_progress -> completed all stay live transitions, and so
    // does skipped -> completed (a genuine correction).
    if (session.status === 'completed') return;
    const nowMs = now();
    const updated = {
      ...session, status: 'completed', completed_at: new Date(nowMs).toISOString(), clientTs: nowMs,
    };
    // Snapshot the planned exercises + targets so later edits to the variant,
    // library, or targets don't retroactively rewrite this completed session.
    // Ad-hoc sessions render exclusively from logs, so skip them. The snapshot
    // is immutable "plan as performed": once a session carries one (already
    // spread into `updated`), a repeat/retry completed-status call must not
    // rebuild it against a now-changed variant.
    if (session.variant_id !== ADHOC_ID && !updated.exercise_snapshot) {
      updated.exercise_snapshot = await buildExerciseSnapshot(session.variant_id);
    }
    await records.put(WORKOUT_RECORD_TYPES.SESSION, updated);
    await tryAdvanceRotation(session);
  }

  // buildExerciseSnapshot renders a variant's plan into the session's immutable
  // "plan as performed" shape. Two writers materialize it — completeSession and
  // removePlannedExercise — so the mapping lives here once; the modal prefill
  // reads these exact field names.
  async function buildExerciseSnapshot(variantId) {
    return (await listExercises(variantId)).map((e) => ({
      exercise_id: e.id,
      exercise_name: e.exercise_name,
      target_sets: e.target_sets,
      target_reps_min: e.target_reps_min,
      target_reps_max: e.target_reps_max ?? null,
      target_weight_kg: e.target_weight_kg ?? null,
      order_index: e.order_index,
    }));
  }

  // removePlannedExercise makes "drop this exercise from TODAY's workout"
  // durable. Deleting the exercise_log is not enough: the modal re-materializes
  // the plan on every open, so an un-logged planned row (which never had a log
  // at all) or a freshly de-logged one comes straight back as a placeholder.
  // The session's exercise_snapshot is the only per-session copy of the plan, so
  // the removal is recorded there. The variant is deliberately NOT touched —
  // that would drop the exercise from every future workout, which is a
  // different feature (/api/workout/exercises/delete).
  //
  // ponytail: materializing the snapshot on the first removal freezes this
  // session's plan, so later variant edits stop showing up in it. That is
  // already the rule once a session completes and is the whole point of the
  // field; it just starts earlier now. Upgrade path if that bites: store a
  // `removed_exercises` deny-list on the session and keep reading the live
  // variant through it.
  async function removePlannedExercise(input) {
    const session = await findSession(Number(input && input.session_id) || 0);
    // Ad-hoc sessions (and any session with no variant) render exclusively from
    // logs — no prefill, nothing to remember.
    if (!session || !(session.variant_id > 0)) return;

    const exerciseId = Number(input && input.exercise_id) || 0;
    const exerciseName = (input && input.exercise_name) || '';
    const snapshot = Array.isArray(session.exercise_snapshot)
      ? session.exercise_snapshot
      : await buildExerciseSnapshot(session.variant_id);

    // Mirror the prefill's own dedupe: match on exercise_id when both sides
    // carry one, else fall back to the name so legacy id-less snapshot rows
    // (and log rows saved before exercise_id was populated) still match.
    const next = snapshot.filter((ex) => (exerciseId && ex.exercise_id
      ? ex.exercise_id !== exerciseId
      : ex.exercise_name !== exerciseName));

    await records.put(WORKOUT_RECORD_TYPES.SESSION, {
      ...session,
      exercise_snapshot: next,
      clientTs: now(),
    });
  }

  async function preSkipSession(id) {
    const session = await findSession(id);
    if (!session) return;
    await records.put(WORKOUT_RECORD_TYPES.SESSION, { ...session, status: 'pre_skipped', clientTs: now() });
  }

  async function cancelPreSkipSession(id) {
    const session = await findSession(id);
    if (!session) return;
    await records.put(WORKOUT_RECORD_TYPES.SESSION, { ...session, status: 'pending', clientTs: now() });
  }

  // deleteSession ports DeleteSession (repo.go:1029): tombstone the session's
  // logs first, then the session itself — a missing session no-ops (mirrors
  // the Go store's `DELETE ... WHERE id = ?` affecting zero rows).
  async function deleteSession(id) {
    const session = await findSession(id);
    if (!session) return;
    const logs = (await activeRecords(WORKOUT_RECORD_TYPES.LOG)).filter((l) => l.session_id === id);
    for (const l of logs) await records.del(WORKOUT_RECORD_TYPES.LOG, l.recordId);
    await records.del(WORKOUT_RECORD_TYPES.SESSION, session.recordId);
  }

  const VALID_SESSION_STATUSES = new Set(['in_progress', 'completed', 'skipped']);

  // setSessionStatus ports transitions.go's SetSessionStatus. Returns null
  // when the session doesn't exist (caller/shim maps that to 404, mirroring
  // the Go handler); throws invalid_request for a status outside the allowed
  // set (mirrors the 400).
  async function setSessionStatus(id, status) {
    if (!VALID_SESSION_STATUSES.has(status)) {
      throw invalidRequest('invalid session status', 'invalid_request');
    }
    const session = await findSession(id);
    if (!session) return null;

    if (status === 'skipped') await skipSession(id);
    else if (status === 'completed') await completeSession(id);
    else await records.put(WORKOUT_RECORD_TYPES.SESSION, { ...session, status, clientTs: now() });

    return { session, terminal: status === 'skipped' || status === 'completed' };
  }

  // nextVariant ports transitions.go's NextVariant: advance the rotation then
  // delete the current (not-yet-started) session so the next resolution
  // surfaces the new variant. Errors propagate (unlike tryAdvanceRotation).
  async function nextVariant(id) {
    const session = await findSession(id);
    if (!session) throw invalidRequest('session not found', 'not_found');
    if (session.status === 'in_progress' || session.status === 'completed' || session.status === 'skipped') {
      throw invalidRequest('cannot change variant for an active or completed session', 'invalid_request');
    }
    const group = await findByNumericId(records, WORKOUT_RECORD_TYPES.GROUP, session.group_id);
    if (!group) throw invalidRequest('workout group not found', 'not_found');
    if (!group.is_rotating) throw invalidRequest('workout group does not use rotation', 'invalid_request');

    await advanceRotation(group.id);
    // Cascade-delete the session's exercise logs first, matching Go's
    // DeleteSession (repo.go:1029) — FK cascade is disabled, so records.del
    // on the session alone would orphan any logs created against it.
    await deleteSession(id);
  }

  // -- Exercise logs --

  // effectiveGoal resolves the training goal that parameterizes progression
  // (med-qj4.6.3): the exercise's own override, else the owning routine's goal,
  // else the hypertrophy default — the same precedence the exercise editor's
  // cascade uses (med-qj4.6.1). The routine is reached exercise → variant →
  // group; a missing link just falls through to the default.
  async function effectiveGoal(exercise) {
    if (exercise && exercise.training_goal) return normalizeGoal(exercise.training_goal);
    const variant = await findByNumericId(records, WORKOUT_RECORD_TYPES.VARIANT, exercise.variant_id);
    const group = variant && await findByNumericId(records, WORKOUT_RECORD_TYPES.GROUP, variant.group_id);
    return normalizeGoal(group && group.training_goal);
  }

  // propagateExerciseToSchedule ports PropagateExerciseToSchedule (repo.go:1330):
  // best-effort write-back of non-null sets/reps/weight onto the scheduled
  // exercise definition, guarded only if the session is still
  // pending/notified/in_progress with that exercise's variant — a mismatch is a
  // silent no-op, matching the SQL affecting zero rows. Go's WHERE also checks
  // exercise_name to defend against cross-table id collisions between
  // exercise_library and workout_exercises; that collision cannot occur here —
  // findByNumericId is scoped to the EXERCISE record type — so the name check is
  // dropped. Keeping it would make a rename (which leaves the log's cached
  // exercise_name stale) wrongly no-op the propagation for that exercise's own
  // pending session. `exerciseName` is retained in the signature for callers but
  // is intentionally not part of the guard.
  async function propagateExerciseToSchedule(sessionId, exerciseId, exerciseName, sets, reps, weight, perSet) {
    const session = await findSession(sessionId);
    if (!session || !['pending', 'notified', 'in_progress'].includes(session.status)) return;
    const exercise = await findByNumericId(records, WORKOUT_RECORD_TYPES.EXERCISE, exerciseId);
    if (!exercise || exercise.variant_id !== session.variant_id) return;

    // `none`/absent rule → mirror; linear/double → apply the opt-in rule. An
    // unmet rule returns {} (plan held steady), so the spread leaves it as-is.
    const patch = progressionPatch(exercise, sets, reps, weight, perSet, await effectiveGoal(exercise));
    await records.put(WORKOUT_RECORD_TYPES.EXERCISE, {
      ...exercise,
      ...patch,
      clientTs: now(),
    });
  }

  // createLog ports AddExerciseToSession (exercise_logs.go:119) + the
  // handler's request validation (workout_handlers.go:485): required
  // session/exercise ids, non-negative target values, source defaulting to
  // "schedule", the session-exists guard, and the
  // (session_id, exercise_id, source) uniqueness the DB enforces via a
  // partial unique index (migration 052) for exercise_id > 0.
  async function createLog(input) {
    const sessionId = Number(input && input.session_id) || 0;
    const exerciseId = Number(input && input.exercise_id) || 0;
    if (!sessionId || !exerciseId) {
      throw invalidRequest('SessionID and ExerciseID are required');
    }

    const targetSets = Number(input && input.target_sets) || 0;
    const targetRepsMin = Number(input && input.target_reps_min) || 0;
    const targetWeightKg = numOrNull(input && input.target_weight_kg);
    validateExerciseValues(targetSets, targetRepsMin, targetWeightKg);

    const source = (input && input.source) || 'schedule';
    if (source !== 'schedule' && source !== 'library') {
      throw invalidRequest("source must be 'schedule' or 'library'");
    }

    const session = await findSession(sessionId);
    if (!session) throw invalidRequest('Session not found', 'not_found');

    if (exerciseId > 0) {
      const dup = (await activeRecords(WORKOUT_RECORD_TYPES.LOG))
        .some((l) => l.session_id === sessionId && l.exercise_id === exerciseId && l.source === source);
      if (dup) throw invalidRequest('exercise already logged for this session', 'conflict');
    }

    // Per-set array (Phase 1): when present, derive the flat scalars from it
    // so bot-compat consumers, propagation, and stats keep working; when
    // absent, fall back to the target_* aggregates as before.
    const perSet = normalizeSets(input && input.sets);
    const scalars = perSet ? deriveSetScalars(perSet) : null;
    const effSets = scalars ? scalars.sets_completed : targetSets;
    const effReps = scalars ? scalars.reps_completed : targetRepsMin;
    const effWeight = scalars ? scalars.weight_kg : targetWeightKg;

    const nowMs = now();
    const exerciseName = (input && input.exercise_name) || '';
    const record = {
      recordId: genRecordId('log', nowMs),
      clientTs: nowMs,
      deleted: false,
      id: mintNumericId(await records.list(WORKOUT_RECORD_TYPES.LOG), nowMs),
      session_id: sessionId,
      exercise_id: exerciseId,
      exercise_name: exerciseName,
      sets_completed: effSets,
      reps_completed: effReps,
      weight_kg: effWeight,
      status: (input && input.status) || '',
      notes: (input && input.notes) || '',
      logged_at: new Date(nowMs).toISOString(),
      source,
    };
    if (perSet) record.sets = perSet;
    await records.put(WORKOUT_RECORD_TYPES.LOG, record);

    if (source !== 'library') {
      const propagateSets = effSets === 0 ? null : effSets;
      const propagateReps = effReps === 0 ? null : effReps;
      await propagateExerciseToSchedule(sessionId, exerciseId, exerciseName, propagateSets, propagateReps, effWeight, perSet);
    }

    return { id: record.id };
  }

  // updateLog ports UpdateExerciseLog (exercise_logs.go:47): validation,
  // the store write (sets/reps/weight/notes, logged_at bumped only while the
  // row is still a placeholder), best-effort schedule propagation skipped
  // for source="library", and auto-promotion of a placeholder to
  // "completed" once sets_completed >= 1. A missing log id no-ops, matching
  // the Go store's `UPDATE ... WHERE id = ?` affecting zero rows.
  async function updateLog(id, input) {
    // Per-set array (Phase 1): when present, the derived scalars override the
    // flat sets_completed/reps_completed/weight_kg fields (mirroring the Go
    // mergePayloadValues collapse); when absent, use the flat fields directly.
    const perSet = normalizeSets(input && input.sets);
    const derived = perSet ? deriveSetScalars(perSet) : null;
    const sets = derived ? derived.sets_completed : numOrNull(input && input.sets_completed, true);
    const reps = derived ? derived.reps_completed : numOrNull(input && input.reps_completed, true);
    const weight = derived ? derived.weight_kg : numOrNull(input && input.weight_kg, false);
    validateExerciseValues(sets, reps, weight);

    const status = (input && input.status) || '';
    if (!VALID_LOG_STATUSES.has(status)) {
      throw invalidRequest('status must be one of "", "completed", "skipped"');
    }

    const log = await findByNumericId(records, WORKOUT_RECORD_TYPES.LOG, id);
    if (!log) return;

    const wasPlaceholder = log.status === '';
    let newStatus = status;
    if (newStatus === '' && wasPlaceholder && hasValue(sets) && sets >= 1) newStatus = 'completed';

    const effSets = hasValue(sets) ? sets : log.sets_completed;
    const effReps = hasValue(reps) ? reps : log.reps_completed;
    const effWeight = hasValue(weight) ? weight : log.weight_kg;

    // Reconcile the stored per-set array with a flat-only update. A caller that
    // changes the scalar aggregates without resending `sets` (the MCP/API
    // logs/update route) would otherwise leave a stale array that contradicts
    // the new flat values — and toLogResponse emits both, so reads (and the UI,
    // which prefers the array) would silently mask the flat change. When the
    // effective scalars diverge from what the stored sets derive, drop the now-
    // inconsistent array so reads fall back to the flat aggregate. A notes-only
    // resend keeps identical scalars, so real per-set data is preserved.
    let setsWrite = {};
    if (perSet) {
      setsWrite = { sets: perSet };
    } else if (Array.isArray(log.sets) && log.sets.length > 0) {
      const d = deriveSetScalars(log.sets);
      if (effSets !== d.sets_completed || effReps !== d.reps_completed || effWeight !== d.weight_kg) {
        setsWrite = { sets: [] };
      }
    }

    const nowMs = now();
    await records.put(WORKOUT_RECORD_TYPES.LOG, {
      ...log,
      sets_completed: effSets,
      reps_completed: effReps,
      weight_kg: effWeight,
      ...setsWrite,
      notes: (input && input.notes) || '',
      // Go's UpdateExerciseLog never writes status; UpdateExerciseLogStatus
      // fires only for a non-empty newStatus. So an omitted status preserves
      // the existing one — editing a completed log must not reset it to ''.
      status: newStatus === '' ? log.status : newStatus,
      logged_at: wasPlaceholder ? new Date(nowMs).toISOString() : log.logged_at,
      clientTs: nowMs,
    });

    if (log.source !== 'library') {
      const propagateSets = sets === 0 ? null : sets;
      const propagateReps = reps === 0 ? null : reps;
      // Feed progression the EFFECTIVE stored per-set array, not the request-only
      // `perSet` (null when the update omits `sets` — e.g. a notes-only re-save).
      // Without this, workSetStats falls back to reps_completed (the MAX) as the
      // per-set min, so a heterogeneous log like [12,8] would falsely read "all
      // sets hit 12" and advance the plan on a benign edit. `setsWrite` already
      // holds the reconciled array: {sets:perSet} kept, {sets:[]} dropped, or {}
      // meaning the stored log.sets is preserved.
      const finalSets = perSet ? perSet : ('sets' in setsWrite ? setsWrite.sets : log.sets);
      const propagatePerSet = Array.isArray(finalSets) && finalSets.length > 0 ? finalSets : null;
      // Pass effWeight (the stored logged weight when the update omits weight_kg),
      // not the raw input weight: progressionPatch anchors its bump to this value,
      // so a re-save that changes reps but omits weight falls back to the stable
      // logged weight rather than the mutable plan target (which would compound
      // the increment on each save). Matches createLog, which passes effWeight.
      await propagateExerciseToSchedule(log.session_id, log.exercise_id, log.exercise_name, propagateSets, propagateReps, effWeight, propagatePerSet);
    }
  }

  async function deleteLog(id) {
    const log = await findByNumericId(records, WORKOUT_RECORD_TYPES.LOG, id);
    if (log) await records.del(WORKOUT_RECORD_TYPES.LOG, log.recordId);
  }

  // -- Next-workout engine --

  // buildSessionResponse ports next.go's buildSessionResponse for the
  // active-today (P0) and snoozed (P1) branches. snoozed_until is always
  // present (possibly null) here — the Go source's plain map always carries
  // the key too; the P2/pending branch below never had it, but no known
  // frontend caller distinguishes "absent" from "null" (verified: next-card.js
  // and modals.js only read `session.is_snoozed`), so this file always emits
  // the key for a simpler shape.
  async function buildSessionResponse(session, todayStr, isSnoozed) {
    const group = await findByNumericId(records, WORKOUT_RECORD_TYPES.GROUP, session.group_id);
    const variant = await findByNumericId(records, WORKOUT_RECORD_TYPES.VARIANT, session.variant_id);
    // Prefer the session's snapshot (same rule as listSessions) so the
    // next-workout card stops counting an exercise the user removed from this
    // session; fall back to the live variant for snapshot-less sessions.
    const exercises = session.exercise_snapshot || (await listExercises(session.variant_id));

    let exerciseCount = exercises.length;
    if (session.group_id === ADHOC_ID) {
      exerciseCount = await countSessionExerciseLogs(session.id);
    }

    return {
      session: {
        id: session.id,
        scheduled_date: session.scheduled_date,
        scheduled_time: session.scheduled_time,
        status: session.status,
        is_snoozed: isSnoozed,
        snoozed_until: session.snoozed_until || null,
        is_today: localDateStr(new Date(session.scheduled_date).getTime(), timeZone) === todayStr,
      },
      group_name: group ? group.name : 'Unknown',
      variant_name: variant ? variant.name : 'Unknown',
      exercises_count: exerciseCount,
      variant_id: session.variant_id,
      group_id: session.group_id,
      is_rotating: !!(group && group.is_rotating),
    };
  }

  // getNext ports GetNext (next.go:60), the 3-priority scheduling engine:
  // P0 active session today, P1 earliest expired snooze, P2 a two-week scan
  // across active groups lazily materializing the pending session. Returns
  // null when nothing is upcoming (mirrors the Go (nil, nil)).
  //
  // Simplification vs. the Go source: resolveVariantId's result and the
  // scheduled_time parse don't vary per day within one group, so this port
  // hoists both above the 14-day loop instead of re-deriving (and
  // `continue`-ing past) them on every matching weekday — same observable
  // outcome (a group with no variants, or an unparseable scheduled_time,
  // never produces a candidate), fewer lookups.
  async function getNext() {
    const nowMs = now();
    const todayStr = localDateStr(nowMs, timeZone);

    // PRIORITY 0: active sessions today (notified/in_progress/pre_skipped),
    // earliest first — except that a session actually IN PROGRESS outranks one
    // merely notified or declined, whatever the clock says. Since med-3q8.2 an
    // ad-hoc started after today's workout was pre-skipped coexists with that
    // declined row; ordering purely by scheduled_time would point the card at
    // the workout the user said no to instead of the one they are doing.
    const activeToday = (await activeRecords(WORKOUT_RECORD_TYPES.SESSION))
      .filter((s) => (s.status === 'notified' || s.status === 'in_progress' || s.status === 'pre_skipped')
        && localDateStr(new Date(s.scheduled_date).getTime(), timeZone) === todayStr)
      .sort((a, b) => (a.status === 'in_progress' ? 0 : 1) - (b.status === 'in_progress' ? 0 : 1)
        || (a.scheduled_time < b.scheduled_time ? -1 : a.scheduled_time > b.scheduled_time ? 1 : 0));
    if (activeToday.length > 0) {
      return buildSessionResponse(activeToday[0], todayStr, !!activeToday[0].snoozed_until);
    }

    // PRIORITY 1: earliest snoozed session whose snooze has elapsed.
    const snoozed = (await activeRecords(WORKOUT_RECORD_TYPES.SESSION))
      .filter((s) => s.snoozed_until && new Date(s.snoozed_until).getTime() < nowMs
        && s.status !== 'completed' && s.status !== 'skipped');
    if (snoozed.length > 0) {
      let earliest = snoozed[0];
      for (const s of snoozed) {
        if (new Date(s.snoozed_until).getTime() < new Date(earliest.snoozed_until).getTime()) earliest = s;
      }
      return buildSessionResponse(earliest, todayStr, true);
    }

    // PRIORITY 2: earliest upcoming occurrence across the next two weeks.
    const groups = await listGroups({ activeOnly: true });
    let best = null;
    let bestMs = null;

    for (const group of groups) {
      let daysOfWeek;
      try {
        daysOfWeek = JSON.parse(group.days_of_week);
      } catch {
        continue;
      }
      if (!Array.isArray(daysOfWeek)) continue;

      const variantId = await resolveVariantId(group);
      if (!variantId) continue;

      const hhmm = parseHHMM(group.scheduled_time);
      if (!hhmm) continue;

      for (let daysAhead = 0; daysAhead < 14; daysAhead++) {
        const parts = addLocalDays(nowMs, timeZone, daysAhead);
        const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
        if (!daysOfWeek.includes(weekday)) continue;

        const scheduledMs = localWallToUtcMs(
          Date.UTC(parts.year, parts.month - 1, parts.day, hhmm.hour, hhmm.minute),
          timeZone,
        );
        // No past-occurrence skip (Go's next.go:120 had one): today's slot stays
        // a candidate after its time passes. The Go scheduler flipped
        // pending->notified at fire time so P0 caught the day; cloud has no
        // scheduler, so skipping here dropped a workout the user never
        // completed or skipped. Completed/skipped days are still filtered below,
        // and a future daysAhead can never be in the past.

        if (best === null || scheduledMs < bestMs) {
          const variant = await findByNumericId(records, WORKOUT_RECORD_TYPES.VARIANT, variantId);
          if (!variant) continue;

          const exercises = await listExercises(variantId);
          const dateStr = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
          const existingRecordId = sessionRecordId(group.id, dateStr);
          const existing = (await activeRecords(WORKOUT_RECORD_TYPES.SESSION))
            .find((s) => s.recordId === existingRecordId) || null;

          let status = 'pending';
          let sessionId = null;
          if (existing) {
            if (existing.status === 'completed' || existing.status === 'skipped') continue;
            status = existing.status;
            sessionId = existing.id;
          }

          best = {
            sessionId,
            groupId: group.id,
            groupName: group.name,
            variantId,
            variantName: variant.name,
            scheduledMs,
            dateStr,
            scheduledTime: group.scheduled_time,
            exercisesCount: exercises.length,
            status,
            isRotating: !!group.is_rotating,
          };
          bestMs = scheduledMs;
        }
        break;
      }
    }

    if (!best) return null;

    if (!best.sessionId) {
      const nowMs2 = now();
      const record = {
        recordId: sessionRecordId(best.groupId, best.dateStr),
        // DERIVED state, so it takes the LOWEST possible LWW precedence — not
        // now() (same rule as medintake.js's dose materialization, bd med-d4w).
        // getNext is a READ that writes: every device re-derives this row from
        // the group's schedule, into the same deterministic recordId. A device
        // whose mirror predates today's workout (a second browser left open
        // since last week) sees no slot for today and re-creates it as PENDING.
        // Stamped with now() that stale re-creation is the NEWEST write, so LWW
        // erases the real COMPLETED session — the finished workout vanishes from
        // history, its exercise logs orphan onto a session id that no longer
        // exists, and the reminder un-suppresses (bd med-9a87). A floor clientTs
        // makes materialization lose every merge against a real write, which is
        // exactly its standing: it only ever needs to win against nothing at all.
        // Not absolute through writeRecord, which promotes this over any raw row
        // already at the recordId (tombstones included) — bd med-qhpu.
        clientTs: 0,
        deleted: false,
        id: mintNumericId(await records.list(WORKOUT_RECORD_TYPES.SESSION), nowMs2),
        user_id: CLOUD_USER_ID,
        group_id: best.groupId,
        variant_id: best.variantId,
        scheduled_date: scheduledDateRFC(best.dateStr, timeZone),
        scheduled_time: best.scheduledTime,
        status: 'pending',
        started_at: null,
        completed_at: null,
        snoozed_until: null,
        snooze_count: 0,
        notification_message_id: null,
        notes: '',
      };
      await records.put(WORKOUT_RECORD_TYPES.SESSION, record);
      best.sessionId = record.id;
      best.status = record.status;
    }

    return {
      session: {
        id: best.sessionId,
        scheduled_date: scheduledDateRFC(best.dateStr, timeZone),
        scheduled_time: best.scheduledTime,
        status: best.status,
        is_snoozed: false,
        is_today: best.dateStr === todayStr,
      },
      group_name: best.groupName,
      variant_name: best.variantName,
      exercises_count: best.exercisesCount,
      variant_id: best.variantId,
      group_id: best.groupId,
      is_rotating: best.isRotating,
    };
  }

  // -- Session views + stats --

  // sessionSortKey/sortSessions ports ListHistory's `ORDER BY scheduled_date
  // DESC, scheduled_time DESC`. scheduled_date already carries a full instant
  // here (local midnight rendered as UTC ISO), so same-day sessions tie-break
  // on the scheduled_time string, exactly like the SQL two-column ORDER BY.
  function sortSessions(sessions) {
    return [...sessions].sort((a, b) => {
      const da = new Date(a.scheduled_date).getTime();
      const db = new Date(b.scheduled_date).getTime();
      if (da !== db) return db - da;
      return a.scheduled_time < b.scheduled_time ? 1 : a.scheduled_time > b.scheduled_time ? -1 : 0;
    });
  }

  // listSessions ports ListSessions (sessions.go:34): recent sessions newest
  // first, enriched with group/variant names, per-session exercise counts,
  // completed count, and total volume. Ad-hoc sessions (group_id == -1) are
  // labelled "Ad-hoc" and take their "variant" name from the biggest
  // completed exercise by volume (falling back to sets*reps for bodyweight
  // exercises); their exercise count comes from the logged exercises rather
  // than a variant.
  async function listSessions(limit) {
    const lim = limit || 30;
    const sessions = sortSessions(await activeRecords(WORKOUT_RECORD_TYPES.SESSION)).slice(0, lim);
    const allLogs = await activeRecords(WORKOUT_RECORD_TYPES.LOG);

    const views = [];
    for (const session of sessions) {
      const logs = allLogs.filter((l) => l.session_id === session.id);
      // Prefer the completion snapshot so history counts stay stable across
      // later plan edits; fall back to the live variant for legacy sessions.
      const exercises = session.exercise_snapshot || (await listExercises(session.variant_id));

      let groupName = 'Unknown';
      let variantName = 'Unknown';
      if (session.group_id === ADHOC_ID) {
        groupName = 'Ad-hoc';
        let bestName = '';
        let bestVol = -1;
        for (const log of logs) {
          if (log.status !== 'completed') continue;
          let vol = 0;
          if (hasValue(log.sets_completed) && hasValue(log.reps_completed) && hasValue(log.weight_kg)) {
            vol = log.sets_completed * log.reps_completed * log.weight_kg;
          } else if (hasValue(log.sets_completed) && hasValue(log.reps_completed)) {
            vol = log.sets_completed * log.reps_completed;
          }
          if (vol > bestVol) {
            bestVol = vol;
            bestName = log.exercise_name;
          }
        }
        variantName = bestName;
      } else {
        const group = await findByNumericId(records, WORKOUT_RECORD_TYPES.GROUP, session.group_id);
        const variant = await findByNumericId(records, WORKOUT_RECORD_TYPES.VARIANT, session.variant_id);
        if (group) groupName = group.name;
        if (variant) variantName = variant.name;
      }

      let completed = 0;
      let totalVolume = 0;
      for (const log of logs) {
        if (log.status !== 'completed') continue;
        completed++;
        if (hasValue(log.sets_completed) && hasValue(log.reps_completed) && hasValue(log.weight_kg)) {
          totalVolume += log.sets_completed * log.reps_completed * log.weight_kg;
        }
      }

      views.push({
        session: toSessionResponse(session),
        group_name: groupName,
        variant_name: variantName,
        exercises_count: session.group_id === ADHOC_ID ? logs.length : exercises.length,
        exercises_completed: completed,
        total_volume: totalVolume,
      });
    }
    return views;
  }

  // getSessionDetails ports GetSessionDetails (sessions.go:113): returns
  // null when the session doesn't exist (caller/shim maps that to 404).
  async function getSessionDetails(id) {
    const session = await findSession(id);
    if (!session) return null;
    const logs = (await activeRecords(WORKOUT_RECORD_TYPES.LOG))
      .filter((l) => l.session_id === session.id)
      .sort((a, b) => a.id - b.id);
    return { session: toSessionResponse(session), logs: logs.map(toLogResponse) };
  }

  // mondayOf ports stats.go's mondayOf, bucketing by the ISO Monday of the
  // session's LOCAL calendar day. scheduled_date is an offset-carrying instant
  // (scheduledDateRFC) whose date prefix IS the local day, so we bucket off
  // that prefix — matching Go walking `session.ScheduledDate.Weekday()` on the
  // offset-aware time. Reading getUTCDay() off the raw instant would shift the
  // bucket a UTC day (and possibly a whole week) earlier for positive-offset
  // zones, since local midnight maps to the previous UTC calendar day.
  function mondayOf(dateStr) {
    const y = +dateStr.slice(0, 4);
    const mo = +dateStr.slice(5, 7) - 1;
    const dd = +dateStr.slice(8, 10);
    const day = new Date(Date.UTC(y, mo, dd)).getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    const monday = new Date(Date.UTC(y, mo, dd + diff));
    return monday.toISOString().slice(0, 10);
  }

  // The Monday one week before `monday` ("YYYY-MM-DD" in, same out).
  function weekBefore(monday) {
    return new Date(new Date(`${monday}T00:00:00Z`).getTime() - 7 * 86400000)
      .toISOString().slice(0, 10);
  }

  // getStats ports GetStats (stats.go:44): session counts + completion rate,
  // a completed/skipped heatmap bucketed by ISO Monday, and top exercises by
  // aggregate volume. weekly_activity and top_exercises both stay `null`
  // (never `[]`) when nothing falls in their window — the Go source declares
  // both with `var` and only appends, so an empty result marshals to JSON
  // null; that's a real frontend contract (stats.js reads `Array.isArray(...)`
  // / truthiness), not an oversight.
  //
  // `range` ('7d' | '30d' | '90d' | 'all', default '30d' = the historical
  // window) scopes the counts AND top_exercises, so the Stats tab's range
  // pills move every number on screen instead of only the chart.
  // current_streak_weeks is deliberately range-independent: a streak is a
  // property of the whole history, not of the window you happen to be viewing.
  //
  // med-904.1 adds `totals`, `weekly_volume` and `exercise_totals` so ONE fetch
  // feeds all three Stats views (Consistency / Load / Balance) and switching
  // views is a client-side re-render, never a refetch.
  //
  // med-zte adds `daily_activity` — one entry per LOCAL calendar day inside the
  // active range that saw a completed or skipped session. Sparse by design (a
  // rest day is simply absent, exactly like an untrained week in
  // weekly_activity); the Consistency calendar fills the gaps itself.
  //
  // med-904.3 adds `hard_set_band` — the user's OWN trailing-3-window average
  // of hard sets and the ±20% band around it, so the Balance view can say "in
  // range / below / above" instead of an uncalibrated absolute. `null` until
  // there is enough history to have a baseline at all (see below).
  async function getStats(opts) {
    // '180d' has no range pill in the Stats view — it exists because the
    // doctor-visit brief (brief.js) offers a 180-day window and folds its
    // workout counts out of this same op instead of re-deriving them.
    const rangeDays = {
      '7d': 7, '30d': 30, '90d': 90, '180d': 180,
    };
    const requested = opts && opts.range;
    const range = (requested === 'all' || rangeDays[requested]) ? requested : '30d';
    // The 500-cap mirrors Go's ListHistory(userID, 500).
    const allSessions = sortSessions(await activeRecords(WORKOUT_RECORD_TYPES.SESSION));
    const sessions = allSessions.slice(0, 500);
    const nowMs = now();
    const since30 = range === 'all' ? -Infinity : nowMs - rangeDays[range] * 24 * 60 * 60 * 1000;
    // The heatmap covers at least 12 weeks (the chart filters down to the
    // active range itself), and everything we have when the range is 'all' —
    // otherwise the "All" pill would silently cap the trend at 12 weeks.
    const cutoff12w = Math.min(nowMs - 84 * 24 * 60 * 60 * 1000, since30);

    let totalSessions = 0;
    let completedSessions = 0;
    let skippedSessions = 0;
    const weekMap = new Map();
    // Local calendar day -> { date, completed, skipped }, scoped to the ACTIVE
    // range (not the wider 12-week heatmap span) so the calendar grid covers
    // exactly the window the range pills claim.
    const dayMap = new Map();
    // session id -> its heatmap week, for the log pass below. Only sessions
    // inside the heatmap span get one, so weekly_volume spans exactly the same
    // weeks as weekly_activity.
    const sessionWeek = new Map();

    // Weeks (ISO Monday) holding at least one completed session, over the whole
    // history rather than the active range — the streak below walks it.
    const completedWeeks = new Set();

    for (const session of sessions) {
      const schedMs = new Date(session.scheduled_date).getTime();
      if (schedMs >= since30 && (session.status === 'completed' || session.status === 'skipped')) {
        totalSessions++;
        // Same local-date-prefix rule as mondayOf: scheduled_date is an
        // offset-carrying instant whose "YYYY-MM-DD" prefix IS the local day.
        const day = String(session.scheduled_date).slice(0, 10);
        if (!dayMap.has(day)) dayMap.set(day, { date: day, completed: 0, skipped: 0 });
        const dayEntry = dayMap.get(day);
        if (session.status === 'completed') { completedSessions++; dayEntry.completed++; }
        else { skippedSessions++; dayEntry.skipped++; }
      }
      if (session.status === 'completed' && !Number.isNaN(schedMs)) {
        completedWeeks.add(mondayOf(String(session.scheduled_date).slice(0, 10)));
      }
      if (schedMs >= cutoff12w) {
        const week = mondayOf(String(session.scheduled_date).slice(0, 10));
        if (!weekMap.has(week)) weekMap.set(week, { week, completed: 0, skipped: 0 });
        const entry = weekMap.get(week);
        if (session.status === 'completed') entry.completed++;
        else if (session.status === 'skipped') entry.skipped++;
        sessionWeek.set(session.id, week);
      }
    }

    const weekKeys = Array.from(weekMap.keys()).sort();
    let weeklyActivity = null;
    let activeWeeks = 0;
    for (const week of weekKeys) {
      if (!weeklyActivity) weeklyActivity = [];
      const entry = weekMap.get(week);
      weeklyActivity.push(entry);
      if (entry.completed > 0) activeWeeks++;
    }

    // Consecutive weeks with at least one completed session, counting back
    // from the current week. An untrained current week does not break the
    // streak (it isn't over yet) — we start the walk one week back instead.
    let cursor = mondayOf(localDateStr(nowMs, timeZone));
    if (!completedWeeks.has(cursor)) cursor = weekBefore(cursor);
    let currentStreakWeeks = 0;
    while (completedWeeks.has(cursor)) { currentStreakWeeks++; cursor = weekBefore(cursor); }

    const sessionSchedule = new Map(allSessions.map((s) => [s.id, new Date(s.scheduled_date).getTime()]));

    // Completed logs, oldest session first. The PR pass below needs a running
    // heaviest-per-exercise over the WHOLE history (an in-range log only counts
    // as a PR if it also beats out-of-range history), so this list is NOT
    // windowed — the window tests happen per log inside the loop.
    const completedLogs = [];
    for (const log of await activeRecords(WORKOUT_RECORD_TYPES.LOG)) {
      const schedMs = sessionSchedule.get(log.session_id);
      if (log.status !== 'completed' || schedMs === undefined) continue;
      // A corrupt/unparseable scheduled_date sorts to the epoch rather than
      // poisoning the comparator; the window tests still use the raw value so
      // NaN keeps failing them exactly as it did before.
      completedLogs.push({ log, schedMs, sortAt: Number.isFinite(schedMs) ? schedMs : 0, work: logWorkTotals(log) });
    }
    completedLogs.sort((a, b) => (a.sortAt - b.sortAt) || (a.log.id - b.log.id));

    // weekly_volume mirrors weekly_activity's buckets exactly — a trained week
    // with no logged load is a real zero, not a gap in the trend line.
    const volumeWeeks = new Map();
    for (const week of weekKeys) volumeWeeks.set(week, { week, volume_kg: 0, hard_sets: 0, reps: 0 });

    // med-904.3 — the own-baseline band on weekly hard sets (JEFIT's Stimulus
    // Volume Engine / Strava's Relative Effort): the last 7 days' hard sets
    // against the average of the three 7-day windows before them, so the
    // headline is "in range / below / above" instead of an absolute number no
    // user can calibrate. windowHardSets[0] is the current window, [1..3] the
    // baseline ones.
    //
    // ROLLING 7-day windows, not the ISO weeks weekly_volume buckets by: a
    // calendar week is partial until Sunday, so an ISO-week comparison would
    // report "below" every Monday through Thursday for someone training
    // exactly as much as they always do.
    //
    // Range-independent, like current_streak_weeks — "am I training my usual
    // amount" is a property of recent history, not of the window the range
    // pills happen to show.
    const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
    const windowHardSets = [0, 0, 0, 0];
    let oldestLogMs = Infinity;

    const agg = new Map();
    const heaviestSoFar = new Map(); // exercise_name -> heaviest working set seen
    let rangeVolume = 0;
    let rangeHardSets = 0;
    let rangeEasySets = 0;
    let rangeReps = 0;
    let prCount = 0;

    for (const { log, schedMs, work } of completedLogs) {
      // PR check runs before any window test: "beat every earlier set" spans
      // the full history, we only *count* the ones landing inside the range.
      // A zero-weight (bodyweight) log can never set a weight PR.
      if (work.max_weight_kg > (heaviestSoFar.get(log.exercise_name) || 0)) {
        heaviestSoFar.set(log.exercise_name, work.max_weight_kg);
        if (schedMs >= since30) prCount++;
      }

      if (Number.isFinite(schedMs)) {
        if (schedMs < oldestLogMs) oldestLogMs = schedMs;
        // A future-dated session lands at a negative age and is excluded.
        const age = nowMs - schedMs;
        if (age >= 0 && age < 4 * WINDOW_MS) windowHardSets[Math.floor(age / WINDOW_MS)] += work.hard_sets;
      }

      const week = sessionWeek.get(log.session_id);
      const bucket = week !== undefined ? volumeWeeks.get(week) : undefined;
      if (bucket) {
        bucket.volume_kg += work.volume_kg;
        bucket.hard_sets += work.hard_sets;
        bucket.reps += work.reps;
      }

      if (schedMs < since30) continue;
      rangeVolume += work.volume_kg;
      rangeHardSets += work.hard_sets;
      rangeEasySets += work.easy_sets;
      rangeReps += work.reps;

      // A log carrying no WORKING sets is a ramp nobody trained on: it must not
      // open a row (the cosmetic "0 kg" line in Top Exercises, bd med-45u) and
      // must not add its session to one, or an exercise warmed up on Tuesday
      // and actually worked on Thursday would report two sessions. It adds
      // nothing to the range totals above either — volume, hard/easy sets and
      // reps are all 0 whenever `sets` is — so skipping here changes only the
      // per-exercise fold.
      //
      // The test is WORKING SETS and must never become a volume test: a
      // bodyweight push-up has real working sets at total_volume_kg 0, and
      // dropping it on volume would move a body part the user actually trained
      // into the Balance view's "Not Trained" chips.
      if (work.sets === 0) continue;

      let entry = agg.get(log.exercise_name);
      if (!entry) {
        entry = {
          exercise_name: log.exercise_name,
          sessionIds: new Set(),
          total_volume_kg: 0,
          sets: 0,
          hard_sets: 0,
          reps: 0,
          max_weight_kg: 0,
        };
        agg.set(log.exercise_name, entry);
      }
      entry.sessionIds.add(log.session_id);
      entry.total_volume_kg += work.volume_kg;
      // `sets` is coverage (every working set) and stays ungated — the Balance
      // view's "Not Trained" list is built from it. `hard_sets` is the effort
      // twin, alongside rather than instead of it.
      entry.sets += work.sets;
      entry.hard_sets += work.hard_sets;
      entry.reps += work.reps;
      if (work.max_weight_kg > entry.max_weight_kg) entry.max_weight_kg = work.max_weight_kg;
    }

    // Every exercise trained in range, which is what lets the Balance view fold
    // a COMPLETE body-part split instead of guessing from eight rows.
    const totalRows = Array.from(agg.values())
      .map((entry) => ({
        exercise_name: entry.exercise_name,
        session_count: entry.sessionIds.size,
        sets: entry.sets,
        hard_sets: entry.hard_sets,
        reps: entry.reps,
        total_volume_kg: entry.total_volume_kg,
        max_weight_kg: entry.max_weight_kg,
      }))
      .sort((a, b) => b.total_volume_kg - a.total_volume_kg);

    // top_exercises is now literally the top-8 slice of those same rows
    // (med-7pq). It used to carry its own pre-per-set math — sets_completed ×
    // reps_completed × weight_kg off the derived scalars, where reps/weight are
    // the MAX across the sets and warm-ups were counted as work — so a 40×10
    // warm-up plus 80×5 and 85×5 reported 3×10×85 = 2550 kg against a true 825.
    // The same exercise therefore showed two different volumes depending on
    // which Stats view you were on. One fold, one number.
    const exerciseTotals = totalRows.length ? totalRows : null;
    const topExercises = totalRows.length
      ? totalRows.slice(0, 8).map(({ exercise_name, session_count, total_volume_kg, max_weight_kg }) => ({
        exercise_name, session_count, total_volume_kg, max_weight_kg,
      }))
      : null;

    const weeklyVolume = weekKeys.length ? weekKeys.map((week) => volumeWeeks.get(week)) : null;

    // Ascending by date; `null` (never `[]`) on an empty window, matching the
    // weekly_activity / top_exercises contract the frontend reads with
    // Array.isArray(...).
    const dailyActivity = dayMap.size
      ? Array.from(dayMap.keys()).sort().map((day) => dayMap.get(day))
      : null;

    // A baseline needs three whole trailing windows of history behind it: a
    // two-week-old account has no "usual" yet, and averaging a partial history
    // would call every honest session "above". `null` (never a zero band) when
    // there isn't one — the UI says "keep logging" rather than judging.
    // ±20% around the average, floored/ceiled OUTWARD so a small baseline
    // (avg 2 → 1–3) still leaves a band rather than collapsing to a point.
    const baseline = (windowHardSets[1] + windowHardSets[2] + windowHardSets[3]) / 3;
    const bandLow = Math.floor(baseline * 0.8);
    const bandHigh = Math.ceil(baseline * 1.2);
    const hardSetBand = (baseline > 0 && nowMs - oldestLogMs >= 4 * WINDOW_MS)
      ? {
        current: windowHardSets[0],
        baseline: Math.round(baseline * 10) / 10,
        low: bandLow,
        high: bandHigh,
        status: windowHardSets[0] < bandLow ? 'below' : (windowHardSets[0] > bandHigh ? 'above' : 'in_range'),
      }
      : null;

    return {
      range,
      total_sessions: totalSessions,
      completed_sessions: completedSessions,
      skipped_sessions: skippedSessions,
      completion_rate: totalSessions > 0 ? (completedSessions / totalSessions) * 100 : 0,
      active_weeks: activeWeeks,
      current_streak_weeks: currentStreakWeeks,
      top_exercises: topExercises,
      weekly_activity: weeklyActivity,
      daily_activity: dailyActivity,
      totals: {
        volume_kg: rangeVolume,
        hard_sets: rangeHardSets,
        // Rated-but-easy working sets excluded from hard_sets — shipped so the
        // Load view can show the exclusion instead of hiding it (med-vov).
        easy_sets: rangeEasySets,
        reps: rangeReps,
        pr_count: prCount,
      },
      weekly_volume: weeklyVolume,
      exercise_totals: exerciseTotals,
      hard_set_band: hardSetBand,
    };
  }

  // progressionPreview (Phase 4, med-qj4.4.1) is the read-only, compute-only
  // dry run of propagateExerciseToSchedule: for every exercise carrying an
  // opt-in rule (type != none), it finds that exercise's most recent completed
  // log and runs the exact same progressionPatch math — but never writes. The
  // result lets an agent (or the UI) see the suggested next targets before a
  // session is completed. `none`/absent-rule exercises are skipped: their
  // "progression" is just mirroring, nothing to preview.
  async function progressionPreview() {
    const exercises = (await activeRecords(WORKOUT_RECORD_TYPES.EXERCISE))
      .filter((e) => e.progression_rule && e.progression_rule.type !== 'none');
    const logs = await activeRecords(WORKOUT_RECORD_TYPES.LOG);
    const out = [];
    for (const exercise of exercises) {
      // Latest completed log for this exercise, newest logged_at first.
      // Exclude source:'library' logs: their exercise_id lives in the
      // exercise_library id space, which can numerically collide with a
      // scheduled exercise's id — matching propagation, which never fires for
      // library logs (createLog/updateLog skip them). Schedule logs' exercise_id
      // maps 1:1 to one workout_exercises row, so no variant join is needed here.
      const latest = logs
        .filter((l) => l.exercise_id === exercise.id && l.status === 'completed' && l.source !== 'library')
        .sort((a, b) => (a.logged_at < b.logged_at ? 1 : a.logged_at > b.logged_at ? -1 : b.id - a.id))[0];
      if (!latest) continue;

      // Same effective-scalar collapse propagate does at write time.
      const sets = latest.sets_completed === 0 ? null : latest.sets_completed;
      const reps = latest.reps_completed === 0 ? null : latest.reps_completed;
      const goal = await effectiveGoal(exercise);
      const patch = progressionPatch(exercise, sets, reps, latest.weight_kg, latest.sets, goal);
      // Effort of that log, in the goal's own terms — without it a `changed:
      // false` entry is unexplainable when the RIR gate (med-qj4.6.3) is what
      // held the load. null when the log carries no RPE (gate not applied).
      const stats = workSetStats(sets, reps, latest.sets);
      const current = {
        target_sets: exercise.target_sets,
        target_reps_min: exercise.target_reps_min,
        target_reps_max: exercise.target_reps_max ?? null,
        target_weight_kg: exercise.target_weight_kg ?? null,
      };
      const proposed = { ...current, ...patch };
      out.push({
        exercise_id: exercise.id,
        exercise_name: exercise.exercise_name,
        variant_id: exercise.variant_id,
        rule: exercise.progression_rule,
        training_goal: goal,
        effort: stats ? formatEffort(stats.minRpe) : null,
        current,
        proposed,
        changed: Object.keys(patch).some((k) => patch[k] !== current[k]),
      });
    }
    return { exercises: out };
  }

  // sortedLogsByName is THE per-exercise-name history scan: every completed LOG
  // record for one exercise_name whose session still exists, newest-first by the
  // session's scheduled_date. Two consumers share it so there is exactly one
  // definition of "the most recent log of this exercise" —
  // listExerciseLogsByName (the detail view's read) and suggestExerciseTarget
  // (the editor's weight suggestion).
  async function sortedLogsByName(name) {
    const sessions = await activeRecords(WORKOUT_RECORD_TYPES.SESSION);
    const dateById = new Map(sessions.map((s) => [s.id, s.scheduled_date]));
    const timeById = new Map(sessions.map((s) => [s.id, s.scheduled_time || '']));
    const logs = (await activeRecords(WORKOUT_RECORD_TYPES.LOG))
      .filter((l) => l.status === 'completed' && l.exercise_name === name && dateById.has(l.session_id))
      .sort((a, b) => {
        const byDate = new Date(dateById.get(b.session_id)).getTime()
          - new Date(dateById.get(a.session_id)).getTime();
        if (byDate) return byDate;
        // scheduled_date is day-granular, so two sessions on one day tie. Break
        // on scheduled_time like sortSessions does (the canonical within-day
        // order — two same-day sessions can be created in either order), then on
        // session id so the result is still total — otherwise "newest" is
        // whatever order the record store happened to return, which the goal
        // resolution below reads.
        const ta = timeById.get(a.session_id);
        const tb = timeById.get(b.session_id);
        if (ta !== tb) return ta < tb ? 1 : -1;
        return b.session_id - a.session_id;
      });
    return { logs, dateById, timeById };
  }

  // listExerciseLogsByName is the per-exercise history read (Phase 3, epic
  // med-qj4): all completed LOG records for one exercise_name, each joined to
  // its session's scheduled_date, newest-first. The per-set `sets` array rides
  // through untouched — web/domain/workout-analysis.js folds est-1RM/PRs/series
  // over it on the read side. No storage, no MCP catalog entry (UI read only).
  async function listExerciseLogsByName(name, opts) {
    const lim = opts && opts.limit > 0 ? opts.limit : 500;
    const { logs, dateById, timeById } = await sortedLogsByName(name);

    // The exercise's effective training goal rides along (med-qj4.6.4/.5): the
    // detail view's headline emphasis and near-failure advisory are goal-driven,
    // and an exercise *name* is the only handle the client has here — there is
    // no other route from a name to its workout_exercises row. Resolved from the
    // NEWEST scheduled log, because one name can have history under several
    // workout_exercises rows (two routines, or a rebuilt plan) with different
    // goals — picking whichever record happened to come back first would show a
    // retired routine's emphasis. Library logs live in a different id space and
    // carry no plan, so they're skipped; no scheduled log at all → null, and the
    // UI falls back to the hypertrophy default via normalizeGoal.
    const scheduled = logs.find((l) => l.source !== 'library' && l.exercise_id > 0);
    const exercise = scheduled
      ? await findByNumericId(records, WORKOUT_RECORD_TYPES.EXERCISE, scheduled.exercise_id)
      : null;
    const goal = exercise ? await effectiveGoal(exercise) : null;

    return logs
      .map((l) => ({
        date: dateById.get(l.session_id),
        // The session's within-day key: scheduled_date is day-granular, so the
        // graph series (exerciseSeries) needs this to order two same-day
        // sessions chronologically instead of by record-store luck (med-qj4.7).
        scheduled_time: timeById.get(l.session_id),
        sets: l.sets,
        session_id: l.session_id,
        training_goal: goal,
      }))
      .slice(0, lim);
  }

  // suggestExerciseTarget (med-73o) answers the exercise editor's one open
  // question when you add a lift you have trained for months: what weight?
  // The vault already holds every set of it you ever logged, with per-set RPE,
  // so the field has no business opening blank.
  //
  // It runs the SAME progression engine that advances a plan after a session —
  // progressionPatch, with the goal's rep band and its RIR gate — over the most
  // recent completed log of that NAME. Reusing it is the whole point: a second
  // weight model that disagreed with the automatic progression would be worse
  // than no suggestion at all. The exercise does not exist yet at suggest time,
  // so the plan handed to the engine is synthesized from the goal defaults the
  // editor's cascade seeds into the very same form (rep band + progression
  // preset + the default load step), which makes the suggestion exactly "what
  // this plan would prescribe next".
  //
  // No history → null, and the editor leaves the field blank: a brand-new
  // exercise behaves precisely as it did before this existed. A bodyweight log
  // (weight 0 — there is no load to progress) is null for the same reason.
  //
  // The evidence rides along in `last`, because the number alone is unarguable
  // in the wrong direction: seeing "Last: 80 kg × 5 · RPE 8 · 2 RIR" is how a
  // user finds out their own effort ratings drive something. `effort` is null
  // when no work set of that log was rated — the caller then omits the clause
  // entirely rather than printing an empty or placeholder one.
  async function suggestExerciseTarget(input) {
    const name = String((input && input.exercise_name) || '').trim();
    if (!name) return null;
    const goal = normalizeGoal(input && input.goal);
    const { logs } = await sortedLogsByName(name);
    const latest = logs[0];
    if (!latest) return null;

    // Same effective-scalar collapse propagate and progressionPreview do: a
    // stored 0 means "not logged", not "zero sets".
    const sets = latest.sets_completed === 0 ? null : latest.sets_completed;
    const reps = latest.reps_completed === 0 ? null : latest.reps_completed;
    const stats = workSetStats(sets, reps, latest.sets);
    if (!stats) return null;

    const band = defaultsForGoal(goal);
    const plan = {
      // target_sets stays null so the set-count gate is open: the editor's sets
      // field is the user's *intent* for the next session, not a bar the last
      // log had to clear to earn a suggestion.
      target_sets: null,
      target_reps_min: band.reps_min,
      target_reps_max: band.reps_max,
      target_weight_kg: null,
      progression_rule: { type: band.progression, increment_kg: DEFAULT_INCREMENT_KG },
    };
    // `general` seeds the 'none' preset, whose patch is mirrorPatch — so an
    // ungated goal suggests the weight you last lifted. That is the correct
    // answer for a goal that prescribes no progression, not a missing feature.
    const patch = progressionPatch(plan, sets, reps, latest.weight_kg, latest.sets, goal);
    const lastWeight = hasValue(latest.weight_kg) && latest.weight_kg > 0 ? latest.weight_kg : null;
    // {} means the rule held the plan with no anchor to hold it at; fall back to
    // the logged weight so "hold" still beats a blank field.
    const target = hasValue(patch.target_weight_kg) ? patch.target_weight_kg : lastWeight;
    if (!hasValue(target) || target <= 0) return null;

    return {
      target_weight_kg: target,
      training_goal: goal,
      last: {
        weight_kg: lastWeight,
        // The MINIMUM reps across the work sets — the same number the engine
        // judged, not the best set. Showing the max would explain a suggestion
        // the engine did not make.
        reps: stats.minReps,
        effort: formatEffort(stats.minRpe),
        logged_at: latest.logged_at || null,
      },
    };
  }

  // -- Mi-Band (read/edit side only — see plan Task 5: ingestion has no
  // cloud path, records arrive via the C2e import) --

  // formatMiBandTime ports the handler's local-time rendering
  // (miband_handlers.go: `if wo.TzOffset != 0 { ... FixedZone ... }` then
  // `Format(time.RFC3339)`): a zero offset keeps the UTC `Z` suffix instead
  // of emitting `+00:00`, matching Go's `.UTC()` fallback path exactly.
  function formatMiBandTime(ms, offsetSeconds) {
    const local = new Date(ms + (offsetSeconds || 0) * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const base = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
      `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
    if (!offsetSeconds) return `${base}Z`;
    const sign = offsetSeconds < 0 ? '-' : '+';
    const abs = Math.abs(offsetSeconds);
    return `${base}${sign}${pad(Math.floor(abs / 3600))}:${pad(Math.floor((abs % 3600) / 60))}`;
  }

  // toMiBandResponse mirrors handleListMiBandWorkouts's `enriched` shape.
  function toMiBandResponse(record) {
    return {
      id: record.id,
      activity_type: record.activity_type,
      activity_name: record.activity_name,
      start_time: formatMiBandTime(record.source_start_ms, record.tz_offset),
      end_time: formatMiBandTime(record.source_end_ms, record.tz_offset),
      duration_sec: record.duration_sec,
      distance_m: record.distance_m,
      steps: record.steps,
      calories: record.calories,
      heart_rate_avg: record.heart_rate_avg,
      spo2_avg: record.spo2_avg,
      source_start_ms: record.source_start_ms,
      source_end_ms: record.source_end_ms,
      source: record.source,
    };
  }

  // createMiBand logs one manual mi-band activity (activity_type 0, source
  // 'manual'), mirroring internal/bot/activity_commands.go: start = now, end =
  // start + durationSec. recordId is deterministic (tg-<eventId>) so a re-drain
  // overwrites rather than duplicates; the numeric id is preserved from a prior
  // active record, else minted with cross-record entropy. The mint (not a bare
  // source_start_ms) matters here because the drain clock is second-precision
  // and the tg-<eventId> recordId namespace gives no same-instant dedup — two
  // /activity messages in one wall-clock second would otherwise share a numeric
  // id and collide the per-id edit/delete path. Re-drain still converges: the
  // recordId lookup below reuses the prior row's id.
  async function createMiBand({ recordId, activityName, durationSec, distanceM } = {}) {
    const startMs = now();
    const endMs = startMs + (durationSec || 0) * 1000;
    const existing = await records.list(WORKOUT_RECORD_TYPES.MIBAND);
    const prev = recordId
      ? existing.find((r) => !r.deleted && r.recordId === recordId)
      : null;
    const id = prev ? prev.id : mintNumericId(existing, startMs);
    const record = {
      recordId: recordId || genRecordId('miband', startMs),
      clientTs: startMs,
      deleted: false,
      id,
      activity_type: 0,
      activity_name: activityName || '',
      source_start_ms: startMs,
      source_end_ms: endMs,
      duration_sec: durationSec || 0,
      distance_m: distanceM || 0,
      steps: 0,
      calories: 0,
      heart_rate_avg: 0,
      spo2_avg: 0,
      pause_ms: 0,
      tz_offset: 0,
      source: 'manual',
      user_id: CLOUD_USER_ID,
    };
    await records.put(WORKOUT_RECORD_TYPES.MIBAND, record);
    return toMiBandResponse(record);
  }

  // listMiBand ports ListMiBand: last-90-days cutoff, source_start_ms DESC,
  // default limit 100 (the handler's default; the store's own default of 50
  // is unreachable from HTTP since the handler always passes a positive
  // limit).
  async function listMiBand(limit) {
    const lim = limit && limit > 0 ? limit : 100;
    const cutoffMs = now() - 90 * 24 * 60 * 60 * 1000;
    const all = (await activeRecords(WORKOUT_RECORD_TYPES.MIBAND))
      .filter((w) => w.source_start_ms >= cutoffMs)
      .sort((a, b) => b.source_start_ms - a.source_start_ms)
      .slice(0, lim);
    return all.map(toMiBandResponse);
  }

  // providedNum ports the *int/*float64 "absent means don't touch" pattern
  // of UpdateMiBandWorkoutFields — distinct from numOrNull, which treats an
  // absent field as "clear to null"; here absent/null means "leave alone"
  // (returns undefined, never null).
  function providedNum(input, key, isInt) {
    const v = input && input[key];
    if (v === null || v === undefined) return undefined;
    const n = Number(v);
    if (Number.isNaN(n)) return undefined;
    return isInt ? Math.trunc(n) : n;
  }

  // updateMiBand ports UpdateMiBand's diff semantics (miband.go:453): builds
  // the six optional fields first and no-ops (without checking existence,
  // matching the Go early-return-before-the-query order) when none are
  // present; only once there's something to write does a missing record
  // become a not_found error (mirrors the Go rowsAffected==0 -> sql.ErrNoRows).
  async function updateMiBand(id, input) {
    const steps = providedNum(input, 'steps', true);
    const distanceM = providedNum(input, 'distance_m', false);
    const durationSec = providedNum(input, 'duration_sec', true);
    const calories = providedNum(input, 'calories', true);
    const heartRateAvg = providedNum(input, 'heart_rate_avg', true);
    const spo2Avg = providedNum(input, 'spo2_avg', true);
    if ([steps, distanceM, durationSec, calories, heartRateAvg, spo2Avg].every((v) => v === undefined)) {
      return;
    }

    const rec = await findByNumericId(records, WORKOUT_RECORD_TYPES.MIBAND, id);
    if (!rec) throw invalidRequest('Workout not found', 'not_found');

    await records.put(WORKOUT_RECORD_TYPES.MIBAND, {
      ...rec,
      steps: steps === undefined ? rec.steps : steps,
      distance_m: distanceM === undefined ? rec.distance_m : distanceM,
      duration_sec: durationSec === undefined ? rec.duration_sec : durationSec,
      calories: calories === undefined ? rec.calories : calories,
      heart_rate_avg: heartRateAvg === undefined ? rec.heart_rate_avg : heartRateAvg,
      spo2_avg: spo2Avg === undefined ? rec.spo2_avg : spo2Avg,
      clientTs: now(),
    });
  }

  // deleteMiBand ports DeleteMiBand: missing record -> not_found (mirrors
  // the handler's sql.ErrNoRows -> 404 mapping); del() is the tombstone.
  async function deleteMiBand(id) {
    const rec = await findByNumericId(records, WORKOUT_RECORD_TYPES.MIBAND, id);
    if (!rec) throw invalidRequest('Workout not found', 'not_found');
    await records.del(WORKOUT_RECORD_TYPES.MIBAND, rec.recordId);
  }

  return {
    createGroup,
    listGroups,
    updateGroup,
    deleteGroup,
    createVariant,
    listVariants,
    updateVariant,
    deleteVariant,
    createExercise,
    listExercises,
    updateExercise,
    deleteExercise,
    createLibraryItem,
    listLibrary,
    updateLibraryItem,
    deleteLibraryItem,
    listUniqueExercises,
    getRotationState,
    initializeRotation,
    getNext,
    createAdHocSession,
    schedulePlannedAdHocSession,
    startSession,
    snoozeSession,
    skipSession,
    snoozeScheduledSession,
    skipScheduledSession,
    preSkipSession,
    cancelPreSkipSession,
    deleteSession,
    setSessionStatus,
    nextVariant,
    createLog,
    updateLog,
    deleteLog,
    removePlannedExercise,
    listSessions,
    getSessionDetails,
    getStats,
    progressionPreview,
    listExerciseLogsByName,
    suggestExerciseTarget,
    createMiBand,
    listMiBand,
    updateMiBand,
    deleteMiBand,
  };
}
