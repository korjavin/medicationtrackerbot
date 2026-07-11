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
  if (Number.isNaN(n)) return null;
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
      .map(toExerciseResponse);
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
  async function createAdHocSession() {
    const nowMs = now();
    const record = {
      recordId: genRecordId('session', nowMs),
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
      notes: '',
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
    await records.put(WORKOUT_RECORD_TYPES.SESSION, {
      ...session,
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

  async function completeSession(id) {
    const session = await findSession(id);
    if (!session) return;
    const nowMs = now();
    await records.put(WORKOUT_RECORD_TYPES.SESSION, {
      ...session, status: 'completed', completed_at: new Date(nowMs).toISOString(), clientTs: nowMs,
    });
    await tryAdvanceRotation(session);
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

  // propagateExerciseToSchedule ports PropagateExerciseToSchedule (repo.go:1330):
  // best-effort write-back of non-null sets/reps/weight onto the scheduled
  // exercise definition, guarded by the exact same three conditions the SQL
  // WHERE clause encodes (exercise id+name match, and the session is still
  // pending/notified/in_progress with that exercise's variant) — a mismatch
  // on any of them is a silent no-op, matching the SQL affecting zero rows.
  async function propagateExerciseToSchedule(sessionId, exerciseId, exerciseName, sets, reps, weight) {
    const session = await findSession(sessionId);
    if (!session || !['pending', 'notified', 'in_progress'].includes(session.status)) return;
    const exercise = await findByNumericId(records, WORKOUT_RECORD_TYPES.EXERCISE, exerciseId);
    if (!exercise || exercise.exercise_name !== exerciseName || exercise.variant_id !== session.variant_id) return;

    const targetRepsMax = (hasValue(reps) && hasValue(exercise.target_reps_max) && reps > exercise.target_reps_max)
      ? null : exercise.target_reps_max;
    await records.put(WORKOUT_RECORD_TYPES.EXERCISE, {
      ...exercise,
      target_sets: hasValue(sets) ? sets : exercise.target_sets,
      target_reps_min: hasValue(reps) ? reps : exercise.target_reps_min,
      target_reps_max: targetRepsMax,
      target_weight_kg: hasValue(weight) ? weight : exercise.target_weight_kg,
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
      sets_completed: targetSets,
      reps_completed: targetRepsMin,
      weight_kg: targetWeightKg,
      status: (input && input.status) || '',
      notes: (input && input.notes) || '',
      logged_at: new Date(nowMs).toISOString(),
      source,
    };
    await records.put(WORKOUT_RECORD_TYPES.LOG, record);

    if (source !== 'library') {
      const propagateSets = targetSets === 0 ? null : targetSets;
      const propagateReps = targetRepsMin === 0 ? null : targetRepsMin;
      await propagateExerciseToSchedule(sessionId, exerciseId, exerciseName, propagateSets, propagateReps, targetWeightKg);
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
    const sets = numOrNull(input && input.sets_completed, true);
    const reps = numOrNull(input && input.reps_completed, true);
    const weight = numOrNull(input && input.weight_kg, false);
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

    const nowMs = now();
    await records.put(WORKOUT_RECORD_TYPES.LOG, {
      ...log,
      sets_completed: hasValue(sets) ? sets : log.sets_completed,
      reps_completed: hasValue(reps) ? reps : log.reps_completed,
      weight_kg: hasValue(weight) ? weight : log.weight_kg,
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
      await propagateExerciseToSchedule(log.session_id, log.exercise_id, log.exercise_name, propagateSets, propagateReps, weight);
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
    const exercises = await listExercises(session.variant_id);

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

    // PRIORITY 0: active sessions today (notified/in_progress/pre_skipped).
    const activeToday = (await activeRecords(WORKOUT_RECORD_TYPES.SESSION))
      .filter((s) => (s.status === 'notified' || s.status === 'in_progress' || s.status === 'pre_skipped')
        && localDateStr(new Date(s.scheduled_date).getTime(), timeZone) === todayStr)
      .sort((a, b) => (a.scheduled_time < b.scheduled_time ? -1 : a.scheduled_time > b.scheduled_time ? 1 : 0));
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
        if (scheduledMs < nowMs) continue;

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
        clientTs: nowMs2,
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
      const exercises = await listExercises(session.variant_id);

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

  // getStats ports GetStats (stats.go:44): 30-day session counts +
  // completion rate, a 12-week completed/skipped heatmap bucketed by ISO
  // Monday, and top exercises by aggregate volume. weekly_activity and
  // top_exercises both stay `null` (never `[]`) when nothing falls in their
  // window — the Go source declares both with `var` and only appends, so an
  // empty result marshals to JSON null; that's a real frontend contract
  // (stats.js reads `Array.isArray(...)` / truthiness), not an oversight.
  async function getStats() {
    // The 500-cap mirrors Go's ListHistory(userID, 500) and covers the 30-day +
    // 12-week windows only. top_exercises below aggregates over the full session
    // set, matching ListExerciseStats' unbounded JOIN (repo.go:1479).
    const allSessions = sortSessions(await activeRecords(WORKOUT_RECORD_TYPES.SESSION));
    const sessions = allSessions.slice(0, 500);
    const nowMs = now();
    const since30 = nowMs - 30 * 24 * 60 * 60 * 1000;
    const cutoff12w = nowMs - 84 * 24 * 60 * 60 * 1000;

    let totalSessions = 0;
    let completedSessions = 0;
    let skippedSessions = 0;
    const weekMap = new Map();

    for (const session of sessions) {
      const schedMs = new Date(session.scheduled_date).getTime();
      if (schedMs >= since30) {
        if (session.status === 'completed') { completedSessions++; totalSessions++; }
        else if (session.status === 'skipped') { skippedSessions++; totalSessions++; }
      }
      if (schedMs >= cutoff12w) {
        const week = mondayOf(String(session.scheduled_date).slice(0, 10));
        if (!weekMap.has(week)) weekMap.set(week, { week, completed: 0, skipped: 0 });
        const entry = weekMap.get(week);
        if (session.status === 'completed') entry.completed++;
        else if (session.status === 'skipped') entry.skipped++;
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

    const sessionIds = new Set(allSessions.map((s) => s.id));
    const agg = new Map();
    for (const log of await activeRecords(WORKOUT_RECORD_TYPES.LOG)) {
      if (log.status !== 'completed' || !sessionIds.has(log.session_id)) continue;
      let entry = agg.get(log.exercise_name);
      if (!entry) {
        entry = { exercise_name: log.exercise_name, sessionIds: new Set(), total_volume_kg: 0, max_weight_kg: 0 };
        agg.set(log.exercise_name, entry);
      }
      entry.sessionIds.add(log.session_id);
      if (hasValue(log.sets_completed) && hasValue(log.reps_completed) && hasValue(log.weight_kg)) {
        entry.total_volume_kg += log.sets_completed * log.reps_completed * log.weight_kg;
      }
      if (hasValue(log.weight_kg) && log.weight_kg > entry.max_weight_kg) entry.max_weight_kg = log.weight_kg;
    }
    let topExercises = Array.from(agg.values())
      .map((entry) => ({
        exercise_name: entry.exercise_name,
        session_count: entry.sessionIds.size,
        total_volume_kg: entry.total_volume_kg,
        max_weight_kg: entry.max_weight_kg,
      }))
      .sort((a, b) => b.total_volume_kg - a.total_volume_kg)
      .slice(0, 8);
    if (topExercises.length === 0) topExercises = null;

    return {
      total_sessions: totalSessions,
      completed_sessions: completedSessions,
      skipped_sessions: skippedSessions,
      completion_rate: totalSessions > 0 ? (completedSessions / totalSessions) * 100 : 0,
      active_weeks: activeWeeks,
      top_exercises: topExercises,
      weekly_activity: weeklyActivity,
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
    preSkipSession,
    cancelPreSkipSession,
    deleteSession,
    setSessionStatus,
    nextVariant,
    createLog,
    updateLog,
    deleteLog,
    listSessions,
    getSessionDetails,
    getStats,
    listMiBand,
    updateMiBand,
    deleteMiBand,
  };
}
