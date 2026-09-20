// Runtime-agnostic portable workout-plan share domain module. Pure logic over
// an injected workoutDomain — no window/document/fetch/IndexedDB, no records
// port of its own, no id minting. Reads/writes ONLY through the existing
// workoutDomain surface (listGroups/listVariants/listExercises/listLibrary/
// createGroup/createVariant/createExercise/setLibraryBodyPart/
// updateLibraryItem), so the exercise-library dedupe rule documented in
// docs/features.md ("Exercise library by reference") is reused, not forked:
// createExercise already promotes the name into the library and links
// exercise_library_id.
//
// Wire shape (epic med-uo64, v1, nested, names not ids):
//   { v:1, plan:{ name, description?, is_rotating, days_of_week, scheduled_time,
//     training_goal?, days:[ { name, description?, rotation_order?,
//     exercises:[ { name, sets, reps_min, reps_max?, weight_kg?, order_index,
//     progression_rule?, training_goal? } ] } ],
//     library:[ { name, body_part?, notes? } ] } }
// Absent optionals are omitted so the JSON stays small (and QR-friendly).
// Dropped on purpose: every id, user_id, created_at/updated_at, active,
// notification_advance_minutes, exercise_library_id.

export const SHARE_FORMAT_VERSION = 1;

// Trust boundary: the payload is an untrusted token from a stranger's QR.
// Caps mirror the MAX_SCHEDULED_EXERCISES precedent in web/domain/workout.js.
const MAX_SHARE_DAYS = 20;
const MAX_SHARE_EXERCISES_PER_DAY = 50;
const MAX_NAME_LEN = 200;
// _ensureLogSets (sessions.js) materializes log.sets via Array.from({length})
// off target_sets when a session opens, and the log save validator + session
// editor both cap sets at 20 — an untrusted token with sets: 1e9 would freeze
// or OOM the recipient's tab, so bound it before the first write.
const MAX_TARGET_SETS = 20;

const VALID_PROGRESSION_TYPES = new Set(['none', 'linear', 'double']);

function invalid(message, status, code) {
  const err = new Error(message);
  err.code = code || 'invalid_request';
  if (status) err.status = status;
  return err;
}

function notFound(message) {
  return invalid(message, 404, 'not_found');
}

function hasValue(v) {
  return v !== null && v !== undefined;
}

function finiteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function checkName(value, what) {
  const name = String(value || '').trim();
  if (!name) throw invalid(`${what} is required`, 400);
  if (name.length > MAX_NAME_LEN) throw invalid(`${what} is too long`, 400);
  return name;
}

function checkFiniteField(value, what, { required } = {}) {
  if (!hasValue(value) || value === '') {
    if (required) throw invalid(`${what} is required`, 400);
    return undefined;
  }
  const n = finiteNumber(value);
  if (n === null) throw invalid(`${what} must be a finite number`, 400);
  return n;
}

// checkProgressionRule mirrors the workout domain's normalizeProgressionRule
// + anchorDoubleWindow constraints up front, so a hostile rule 400s BEFORE
// the first write: without this a rule the domain rejects mid-import (negative
// increment, negative/inverted rep window) would leave a partial active plan
// behind while reporting failure.
function checkProgressionRule(input, exercise, what) {
  if (!hasValue(input)) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('progression_rule must be an object', 400);
  }
  const type = input.type || 'none';
  if (!VALID_PROGRESSION_TYPES.has(type)) {
    throw invalid('progression type must be one of none, linear, double', 400);
  }
  if (type === 'none') return undefined;
  // Pass through; the workout domain normalizes + anchors on write.
  const increment = checkFiniteField(input.increment_kg, `${what}.progression_rule.increment_kg`);
  if ((increment === undefined ? 2.5 : increment) < 0 || (increment === undefined ? 2.5 : increment) > 1000) {
    throw invalid('increment_kg must be between 0 and 1000', 400);
  }
  let minReps = checkFiniteField(input.min_reps, `${what}.progression_rule.min_reps`);
  let maxReps = checkFiniteField(input.max_reps, `${what}.progression_rule.max_reps`);
  if (minReps !== undefined) {
    minReps = Math.trunc(minReps);
    if (minReps < 0) throw invalid('min_reps must be non-negative', 400);
  }
  if (maxReps !== undefined) {
    maxReps = Math.trunc(maxReps);
    if (maxReps < 0) throw invalid('max_reps must be non-negative', 400);
  }
  if (minReps !== undefined && maxReps !== undefined && minReps > maxReps) {
    throw invalid('min_reps must not exceed max_reps', 400);
  }
  // anchorDoubleWindow (double rules only — it returns other types untouched)
  // pins a rule without its own window onto the exercise's rep targets and
  // rejects an inverted window — emulate that check here, against the same
  // normalized targets the domain persists (reps_max is an INTEGER column, so
  // numOrNull truncates it while reps_min passes through verbatim).
  if (type === 'double') {
    const tMax = exercise.reps_max !== undefined ? Math.trunc(exercise.reps_max) : exercise.reps_min;
    const effMin = minReps !== undefined ? minReps : exercise.reps_min;
    const effMax = maxReps !== undefined ? maxReps : tMax;
    if (effMin > effMax) throw invalid('min_reps must not exceed max_reps', 400);
  }
  return input;
}

function normalizeLibraryEntries(library) {
  const byName = new Map();
  if (!hasValue(library)) return byName;
  if (!Array.isArray(library)) throw invalid('library must be an array', 400);
  for (const entry of library) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name || '').trim();
    if (!name || name.length > MAX_NAME_LEN) continue;
    if (byName.has(name.toLowerCase())) continue;
    const norm = { name };
    if (typeof entry.body_part === 'string' && entry.body_part.trim()) {
      norm.body_part = entry.body_part.trim();
    }
    if (typeof entry.notes === 'string' && entry.notes) norm.notes = entry.notes;
    byName.set(name.toLowerCase(), norm);
  }
  return byName;
}

// validateSharePayload parses + validates an untrusted share token payload,
// returning the normalized plan (unknown keys ignored). Throws 400s.
function validateSharePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw invalid('Share payload is required', 400);
  }
  if (payload.v !== SHARE_FORMAT_VERSION) throw invalid('Unsupported share version', 400);
  const plan = payload.plan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw invalid('Share payload is missing plan', 400);
  }
  const name = checkName(plan.name, 'plan.name');
  const days = plan.days;
  if (!Array.isArray(days)) throw invalid('plan.days must be an array', 400);
  if (days.length > MAX_SHARE_DAYS) {
    throw invalid(`plan may not exceed ${MAX_SHARE_DAYS} days`, 400);
  }
  const normDays = days.map((day, i) => {
    if (!day || typeof day !== 'object' || Array.isArray(day)) {
      throw invalid(`plan.days[${i}] must be an object`, 400);
    }
    const dayName = checkName(day.name, `plan.days[${i}].name`);
    const exercises = day.exercises;
    if (!Array.isArray(exercises)) {
      throw invalid(`plan.days[${i}].exercises must be an array`, 400);
    }
    if (exercises.length > MAX_SHARE_EXERCISES_PER_DAY) {
      throw invalid(`plan.days[${i}] may not exceed ${MAX_SHARE_EXERCISES_PER_DAY} exercises`, 400);
    }
    const rotationOrder = checkFiniteField(day.rotation_order, `plan.days[${i}].rotation_order`);
    const normExercises = exercises.map((ex, j) => {
      if (!ex || typeof ex !== 'object' || Array.isArray(ex)) {
        throw invalid(`plan.days[${i}].exercises[${j}] must be an object`, 400);
      }
      const what = `plan.days[${i}].exercises[${j}]`;
      const exName = checkName(ex.name, `${what}.name`);
      const sets = checkFiniteField(ex.sets, `${what}.sets`, { required: true });
      if (sets > MAX_TARGET_SETS) throw invalid(`${what}.sets may not exceed ${MAX_TARGET_SETS}`, 400);
      const repsMin = checkFiniteField(ex.reps_min, `${what}.reps_min`, { required: true });
      const repsMax = checkFiniteField(ex.reps_max, `${what}.reps_max`);
      const weightKg = checkFiniteField(ex.weight_kg, `${what}.weight_kg`);
      const orderIndex = checkFiniteField(ex.order_index, `${what}.order_index`);
      const progressionRule = checkProgressionRule(ex.progression_rule, {
        reps_min: repsMin,
        ...(repsMax !== undefined ? { reps_max: repsMax } : {}),
      }, what);
      const norm = {
        name: exName,
        sets,
        reps_min: repsMin,
        order_index: orderIndex === undefined ? j : Math.trunc(orderIndex),
      };
      if (repsMax !== undefined) norm.reps_max = repsMax;
      if (weightKg !== undefined) norm.weight_kg = weightKg;
      if (progressionRule !== undefined) norm.progression_rule = progressionRule;
      if (typeof ex.training_goal === 'string' && ex.training_goal) {
        norm.training_goal = ex.training_goal;
      }
      return norm;
    });
    const normDay = { name: dayName, exercises: normExercises };
    if (typeof day.description === 'string' && day.description) {
      normDay.description = day.description;
    }
    if (rotationOrder !== undefined) normDay.rotation_order = Math.trunc(rotationOrder);
    return normDay;
  });
  let daysOfWeek = '[]';
  if (hasValue(plan.days_of_week) && plan.days_of_week !== '') {
    if (typeof plan.days_of_week !== 'string') {
      throw invalid('plan.days_of_week must be a string', 400);
    }
    daysOfWeek = plan.days_of_week;
  }
  let scheduledTime = '';
  if (hasValue(plan.scheduled_time) && plan.scheduled_time !== '') {
    if (typeof plan.scheduled_time !== 'string') {
      throw invalid('plan.scheduled_time must be a string', 400);
    }
    scheduledTime = plan.scheduled_time;
  }
  return {
    name,
    description: typeof plan.description === 'string' ? plan.description : '',
    is_rotating: !!plan.is_rotating,
    days_of_week: daysOfWeek,
    scheduled_time: scheduledTime,
    training_goal: typeof plan.training_goal === 'string' && plan.training_goal
      ? plan.training_goal
      : undefined,
    days: normDays,
    libraryByName: normalizeLibraryEntries(plan.library !== undefined ? plan.library : payload.library),
  };
}

export function createWorkoutShareDomain({ workoutDomain }) {
  // exportPlan(groupId) → { v, plan }. Group by numeric id (404 when
  // unknown); variants in listVariants order, exercises in listExercises order
  // (already resolving the canonical library name on read — use that name).
  async function exportPlan(groupId) {
    const id = Math.trunc(Number(groupId));
    if (!Number.isFinite(id) || id <= 0) throw notFound('Workout plan not found');
    const group = (await workoutDomain.listGroups()).find((g) => g.id === id);
    if (!group) throw notFound('Workout plan not found');
    const libByName = new Map(
      (await workoutDomain.listLibrary()).map((row) => [row.name, row]),
    );
    const referenced = new Map();
    const days = [];
    for (const variant of await workoutDomain.listVariants(id)) {
      const exercises = [];
      for (const ex of await workoutDomain.listExercises(variant.id)) {
        const libRow = libByName.get(ex.exercise_name);
        if (libRow) referenced.set(libRow.name, libRow);
        const out = {
          name: ex.exercise_name,
          sets: ex.target_sets,
          reps_min: ex.target_reps_min,
          order_index: ex.order_index,
        };
        if (hasValue(ex.target_reps_max)) out.reps_max = ex.target_reps_max;
        if (hasValue(ex.target_weight_kg)) out.weight_kg = ex.target_weight_kg;
        if (ex.progression_rule) out.progression_rule = ex.progression_rule;
        if (ex.training_goal) out.training_goal = ex.training_goal;
        exercises.push(out);
      }
      const day = { name: variant.name, exercises };
      if (variant.description) day.description = variant.description;
      if (hasValue(variant.rotation_order)) day.rotation_order = variant.rotation_order;
      days.push(day);
    }
    const plan = {
      name: group.name,
      is_rotating: !!group.is_rotating,
      days_of_week: group.days_of_week,
      scheduled_time: group.scheduled_time,
      days,
      library: [...referenced.values()].map((row) => {
        const entry = { name: row.name };
        if (row.body_part) entry.body_part = row.body_part;
        if (row.notes) entry.notes = row.notes;
        return entry;
      }),
    };
    if (group.description) plan.description = group.description;
    if (group.training_goal) plan.training_goal = group.training_goal;
    return { v: SHARE_FORMAT_VERSION, plan };
  }

  // importPlan(payload) → { id, name, days, exercises, exercises_created,
  // exercises_matched }. ALWAYS creates a new group (never merges); a
  // case-insensitive name collision suffixes " (2)", " (3)", … Exercises are
  // matched to the recipient's library case-insensitively by trimmed name —
  // on a hit the recipient's canonical name wins (so createExercise's
  // exact-match dedupe lands on the existing row); on a miss createExercise
  // promotes a new row and the payload's body_part/notes are patched onto it.
  async function importPlan(payload) {
    const plan = validateSharePayload(payload);
    const taken = new Set(
      (await workoutDomain.listGroups()).map((g) => String(g.name || '').trim().toLowerCase()),
    );
    let name = plan.name;
    if (taken.has(name.toLowerCase())) {
      let n = 2;
      while (taken.has(`${name.toLowerCase()} (${n})`)) n += 1;
      name = `${name} (${n})`;
    }
    const groupInput = {
      name,
      description: plan.description,
      is_rotating: plan.is_rotating,
      days_of_week: plan.days_of_week,
      scheduled_time: plan.scheduled_time,
      notification_advance_minutes: 0,
    };
    if (plan.training_goal !== undefined) groupInput.training_goal = plan.training_goal;
    const group = await workoutDomain.createGroup(groupInput);
    // Snapshot BEFORE the import: only rows predating it count as matches,
    // and only those skip the body_part/notes patch.
    const knownNames = new Map(
      (await workoutDomain.listLibrary())
        .map((row) => [String(row.name || '').trim().toLowerCase(), row.name]),
    );
    let exercises = 0;
    let exercisesCreated = 0;
    let exercisesMatched = 0;
    for (const day of plan.days) {
      const variantInput = { group_id: group.id, name: day.name };
      if (day.description) variantInput.description = day.description;
      if (day.rotation_order !== undefined) variantInput.rotation_order = day.rotation_order;
      const variant = await workoutDomain.createVariant(variantInput);
      for (const ex of day.exercises) {
        const key = ex.name.toLowerCase();
        const hit = knownNames.get(key);
        const exerciseName = hit || ex.name;
        const input = {
          variant_id: variant.id,
          exercise_name: exerciseName,
          target_sets: ex.sets,
          target_reps_min: ex.reps_min,
          order_index: ex.order_index,
        };
        if (ex.reps_max !== undefined) input.target_reps_max = ex.reps_max;
        if (ex.weight_kg !== undefined) input.target_weight_kg = ex.weight_kg;
        if (ex.progression_rule !== undefined) input.progression_rule = ex.progression_rule;
        if (ex.training_goal !== undefined) input.training_goal = ex.training_goal;
        await workoutDomain.createExercise(input);
        exercises += 1;
        if (hit) {
          exercisesMatched += 1;
        } else {
          exercisesCreated += 1;
          // createExercise promoted the name — later repeats in this plan match.
          knownNames.set(key, exerciseName);
          const libEntry = plan.libraryByName.get(key);
          if (libEntry && (libEntry.body_part || libEntry.notes)) {
            if (libEntry.body_part) {
              await workoutDomain.setLibraryBodyPart(exerciseName, libEntry.body_part);
            }
            if (libEntry.notes) {
              // updateLibraryItem needs the full row — read it back first.
              const row = (await workoutDomain.listLibrary())
                .find((r) => r.name === exerciseName);
              if (row) {
                await workoutDomain.updateLibraryItem(row.id, {
                  name: row.name,
                  default_sets: row.default_sets,
                  default_reps_min: row.default_reps_min,
                  default_reps_max: row.default_reps_max,
                  default_weight_kg: row.default_weight_kg,
                  notes: libEntry.notes,
                  body_part: row.body_part || libEntry.body_part || '',
                });
              }
            }
          }
        }
      }
    }
    return {
      id: group.id,
      name,
      days: plan.days.length,
      exercises,
      exercises_created: exercisesCreated,
      exercises_matched: exercisesMatched,
    };
  }

  return { exportPlan, importPlan };
}
