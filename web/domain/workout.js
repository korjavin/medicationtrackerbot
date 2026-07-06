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

export const WORKOUT_RECORD_TYPES = {
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
export const ADHOC_ID = -1;

// mintNumericId ports the nextId technique used by medications.js/notes.js:
// stamp from the millisecond clock (time-ordered) plus low-order random
// digits for cross-device entropy, falling back to localMax+1 so a stalled
// clock or same-ms collision never reuses an id already present in
// `existing` (a list of records of any workout type — callers pass whatever
// scope collisions must be avoided within, e.g. all groups, or all variants
// across all groups).
// ponytail: nowMs*1000 stays under Number.MAX_SAFE_INTEGER until ~year 2255.
export function mintNumericId(existing, nowMs) {
  const localMax = existing.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
  const stamped = nowMs * 1000 + Math.floor(Math.random() * 1000);
  return Math.max(stamped, localMax + 1);
}

// genRecordId mints an opaque recordId for record types with no natural
// dedup slot (groups, variants, exercises, library entries, logs, ad-hoc
// sessions). Same shape as food.js/notes.js's genId.
export function genRecordId(prefix, nowMs) {
  return `${prefix}_${nowMs}_${Math.random().toString(36).slice(2, 10)}`;
}

// sessionRecordId is the deterministic slot a schedule-materialized session
// occupies: N devices resolving "next" for the same group on the same local
// date all write to this same recordId, so LWW converges on one session
// rather than creating duplicates. `date` is a "YYYY-MM-DD" local-date
// string. Ad-hoc sessions (group_id/variant_id == -1) have no such slot and
// get a random recordId via genRecordId instead.
export function sessionRecordId(groupId, date) {
  return `session-${groupId}-${date}`;
}

// rotationRecordId is the deterministic one-row-per-group slot for rotation
// cursor state, mirroring the server's one-row-per-group table.
export function rotationRecordId(groupId) {
  return `rotation-${groupId}`;
}

// findByNumericId resolves "record of type T whose body.id == n" through the
// records port — the id-self-heal lookup: always re-reads the live list
// rather than caching a recordId, so a foreign key pointing at a losing
// LWW write's id simply misses (caller treats as not-found) instead of
// resolving to stale data.
export async function findByNumericId(records, recordType, id) {
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

function toExerciseResponse(record) {
  const resp = {
    id: record.id,
    variant_id: record.variant_id,
    exercise_name: record.exercise_name,
    target_sets: record.target_sets,
    target_reps_min: record.target_reps_min,
    order_index: record.order_index,
  };
  if (hasValue(record.target_reps_max)) resp.target_reps_max = record.target_reps_max;
  if (hasValue(record.target_weight_kg)) resp.target_weight_kg = record.target_weight_kg;
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

  function localMidnightUtcMs(parts, tz) {
    return localWallToUtcMs(Date.UTC(parts.year, parts.month - 1, parts.day), tz);
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
      exercise_name: (input && input.exercise_name) || '',
      target_sets: Number(input && input.target_sets) || 0,
      target_reps_min: Number(input && input.target_reps_min) || 0,
      target_reps_max: numOrNull(input && input.target_reps_max, true),
      target_weight_kg: numOrNull(input && input.target_weight_kg),
      order_index: Number(input && input.order_index) || 0,
    };
    await records.put(WORKOUT_RECORD_TYPES.EXERCISE, record);
    return toExerciseResponse(record);
  }

  async function listExercises(variantId) {
    const all = (await activeRecords(WORKOUT_RECORD_TYPES.EXERCISE)).filter((e) => e.variant_id === variantId);
    all.sort((a, b) => a.order_index - b.order_index);
    return all.map(toExerciseResponse);
  }

  async function updateExercise(id, input) {
    const exercise = await findByNumericId(records, WORKOUT_RECORD_TYPES.EXERCISE, id);
    if (!exercise) return;
    await records.put(WORKOUT_RECORD_TYPES.EXERCISE, {
      ...exercise,
      exercise_name: (input && input.exercise_name) || '',
      target_sets: Number(input && input.target_sets) || 0,
      target_reps_min: Number(input && input.target_reps_min) || 0,
      target_reps_max: numOrNull(input && input.target_reps_max, true),
      target_weight_kg: numOrNull(input && input.target_weight_kg),
      order_index: Number(input && input.order_index) || 0,
      clientTs: now(),
    });
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
    if (item) await records.del(WORKOUT_RECORD_TYPES.LIBRARY, item.recordId);
  }

  // -- Rotation state --

  async function getRotationState(groupId) {
    const all = await activeRecords(WORKOUT_RECORD_TYPES.ROTATION);
    const rec = all.find((r) => r.recordId === rotationRecordId(groupId));
    return rec ? toRotationResponse(rec) : null;
  }

  async function initializeRotation(groupId, startingVariantId) {
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
      scheduled_date: new Date(nowMs).toISOString(),
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
    await records.del(WORKOUT_RECORD_TYPES.SESSION, session.recordId);
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
        scheduled_date: new Date(localMidnightUtcMs(
          { year: +best.dateStr.slice(0, 4), month: +best.dateStr.slice(5, 7), day: +best.dateStr.slice(8, 10) },
          timeZone,
        )).toISOString(),
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
        scheduled_date: new Date(best.scheduledMs).toISOString(),
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
    getRotationState,
    initializeRotation,
    getNext,
    createAdHocSession,
    startSession,
    snoozeSession,
    skipSession,
    completeSession,
    preSkipSession,
    cancelPreSkipSession,
    setSessionStatus,
    nextVariant,
  };
}
