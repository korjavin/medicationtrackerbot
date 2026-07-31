// Focused integration tests for the extracted features/workout/sessions.js
// sub-file. Covers the WorkoutSessions public-API surface and the
// closure-private session state exposed via window.WorkoutSessionsState.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

// Wires a Map-backed ApiCache into the env so DataStore.applyOptimistic
// reads/writes are observable to the test. Returns the underlying Map and a
// helper for seeding cached payloads. Mirrors the pattern used by
// workout.invalidation.test.js.
function installApiCache(window, seed = {}) {
  const map = new Map(Object.entries(seed));
  window.MedTrackerDB = {
    ...(window.MedTrackerDB || {}),
    ApiCache: {
      async get(key) { return map.has(key) ? map.get(key) : null; },
      async set(key, value) { map.set(key, value); },
      async clear(key) { map.delete(key); },
      async keys(prefix) {
        const all = [...map.keys()];
        return typeof prefix === 'string' && prefix
          ? all.filter((k) => k.startsWith(prefix))
          : all;
      }
    },
    WorkoutStore: {
      saveCache: async () => undefined,
      getCache: async () => null,
      clearCache: vi.fn().mockResolvedValue(undefined)
    }
  };
  return map;
}

function deferred() {
  let resolveFn;
  let rejectFn;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

describe('features/workout/sessions.js — split-file integration', () => {
  let env;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    env = loadFrontendEnv({ withWorkout: true });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
    env.cleanup();
    env = null;
  });

  it('exposes the WorkoutSessions public-API namespace + WorkoutSessionsState accessors', () => {
    const { window } = env;
    expect(window.WorkoutSessions).toBeTypeOf('object');
    expect(window.WorkoutSessions.open).toBeTypeOf('function');
    expect(window.WorkoutSessions.close).toBeTypeOf('function');
    expect(window.WorkoutSessions.save).toBeTypeOf('function');
    expect(window.WorkoutSessions.delete).toBeTypeOf('function');
    expect(window.WorkoutSessions.finish).toBeTypeOf('function');
    expect(window.WorkoutSessions.updateLog).toBeTypeOf('function');
    expect(window.WorkoutSessions.deleteLog).toBeTypeOf('function');
    expect(window.WorkoutSessions.startAdHoc).toBeTypeOf('function');
    expect(window.WorkoutSessions.start).toBeTypeOf('function');
    expect(window.WorkoutSessions.complete).toBeTypeOf('function');
    expect(window.WorkoutSessions.preSkip).toBeTypeOf('function');
    expect(window.WorkoutSessions.cancelPreSkip).toBeTypeOf('function');

    expect('logs' in window.WorkoutSessionsState).toBe(true);
    expect('data' in window.WorkoutSessionsState).toBe(true);
    expect('originalStatus' in window.WorkoutSessionsState).toBe(true);
    expect(Array.isArray(window.WorkoutSessionsState.logs)).toBe(true);
    expect(window.WorkoutSessionsState.data).toBeNull();
  });

  it('updateLocalLog marks log as dirty and updates the field value', () => {
    const { window } = env;
    window.WorkoutSessionsState.logs = [
      { id: 0, exercise_name: 'Test', sets_completed: 0, reps_completed: 0, weight_kg: 0, _dirty: false }
    ];

    window.updateLocalLog(0, 'sets_completed', '5');
    expect(window.WorkoutSessionsState.logs[0].sets_completed).toBe(5);
    expect(window.WorkoutSessionsState.logs[0]._dirty).toBe(true);

    window.updateLocalLog(0, 'weight_kg', '50.5');
    expect(window.WorkoutSessionsState.logs[0].weight_kg).toBe(50.5);

    window.updateLocalLog(0, 'notes', 'felt good');
    expect(window.WorkoutSessionsState.logs[0].notes).toBe('felt good');
  });

  it('closeWorkoutSessionModal clears the session data state', async () => {
    const { window } = env;
    window.WorkoutSessionsState.data = { id: 7, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';

    await window.closeWorkoutSessionModal();

    expect(window.WorkoutSessionsState.data).toBeNull();
    expect(window.WorkoutSessionsState.originalStatus).toBeNull();
  });

  it('logs accessor coerces non-array values to empty array', () => {
    const { window } = env;
    window.WorkoutSessionsState.logs = null;
    expect(window.WorkoutSessionsState.logs).toEqual([]);

    window.WorkoutSessionsState.logs = 'not-an-array';
    expect(window.WorkoutSessionsState.logs).toEqual([]);

    window.WorkoutSessionsState.logs = [{ id: 1 }];
    expect(window.WorkoutSessionsState.logs).toEqual([{ id: 1 }]);
  });

  // ===========================================================================
  // Optimistic write conversion (Plan 2026-05-17 Task 2)
  //
  // These tests assert the user-visible promise of the conversion: the session
  // modal's logs array + the workout_history cache reflect the post-mutation
  // state BEFORE the network round-trip resolves, and roll back when the
  // POST fails.
  // ===========================================================================

  it('saveNewSessionExercise pushes the new log into state.logs before the network resolves', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.logs = [
      { id: 5, exercise_id: 1, exercise_name: 'Bench', sets_completed: 3, reps_completed: 8, weight_kg: 60 }
    ];
    // Render an initial logs container so the optimistic re-render has a
    // target — the same hook the production modal flow uses.
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    document.getElementById('session-add-exercise-name').value = 'Squat';
    document.getElementById('session-add-exercise-id').value = '99';
    document.getElementById('session-add-exercise-sets').value = '5';
    document.getElementById('session-add-exercise-reps').value = '5';
    document.getElementById('session-add-exercise-weight').value = '100';
    document.getElementById('session-add-exercise-notes').value = 'felt strong';

    // Block the POST behind a deferred — the optimistic state must be
    // observable while this promise is unresolved.
    const pending = deferred();
    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint === '/api/workout/sessions/logs/create') return pending.promise;
      if (endpoint.startsWith('/api/workout/sessions/details')) {
        return { session: { id: 42, status: 'in_progress' }, logs: window.WorkoutSessionsState.logs };
      }
      return [];
    });

    const handlerDone = window.saveNewSessionExercise();
    // Allow applyOptimistic's await chain (getCached → setCachedWithTags) to
    // settle without resolving the POST.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const logsBeforeResolve = window.WorkoutSessionsState.logs;
    expect(logsBeforeResolve.length).toBe(2);
    expect(logsBeforeResolve[1].exercise_name).toBe('Squat');
    expect(logsBeforeResolve[1]._optimistic).toBe(true);
    const cards = document.getElementById('workout-session-logs')
      .querySelectorAll('.wg-workouts-session-exercise');
    expect(cards.length).toBe(2);

    pending.resolve({ id: 999 });
    await handlerDone;
  });

  it('saveNewSessionExercise rejects sets over the 20-set cap before building the per-set array', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.safeAlert = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.logs = [];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));
    window.apiCall = vi.fn();

    // The modal's max="20" is only a hint — a pasted 21 (or a huge value that
    // would OOM the tab via Array.from) must be rejected in the handler.
    document.getElementById('session-add-exercise-name').value = 'Squat';
    document.getElementById('session-add-exercise-id').value = '99';
    document.getElementById('session-add-exercise-sets').value = '21';
    document.getElementById('session-add-exercise-reps').value = '5';

    await window.saveNewSessionExercise();

    expect(window.safeAlert).toHaveBeenCalledWith('Values exceed maximum allowed');
    expect(window.apiCall).not.toHaveBeenCalled();
    expect(window.WorkoutSessionsState.logs.length).toBe(0);
  });

  // med-prk.3 Task 5 — shared add-exercise picker. Creating a brand-new
  // exercise name mid-session is now allowed: it upserts into the library and
  // the session log references it by id. Real boundary: the name lands in the
  // library AND the session log carries the resolved library id.
  it('saveNewSessionExercise creates a brand-new name in the library and references it on the session log', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.showWorkoutSessionModal = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.logs = [];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    document.getElementById('session-add-exercise-name').value = 'Zercher Squat';
    document.getElementById('session-add-exercise-id').value = ''; // brand-new: no library id
    document.getElementById('session-add-exercise-sets').value = '4';
    document.getElementById('session-add-exercise-reps').value = '6';
    document.getElementById('session-add-exercise-weight').value = '70';

    // Mutable library the create handler appends to, so the "appears in the
    // library afterward" assertion reads a real post-create state.
    const library = [];
    let createdLogPayload = null;
    window.apiCall = vi.fn(async (endpoint, method, payload) => {
      if (endpoint === '/api/workout/exercise-library') return [...library];
      if (endpoint === '/api/workout/exercise-library/create') {
        const item = { id: 555, name: payload.name, default_sets: payload.default_sets };
        library.push(item);
        return item;
      }
      if (endpoint === '/api/workout/sessions/logs/create') {
        createdLogPayload = payload;
        return { id: 999 };
      }
      if (endpoint.startsWith('/api/workout/sessions/details')) {
        return { session: { id: 42, status: 'in_progress' }, logs: window.WorkoutSessionsState.logs };
      }
      return [];
    });

    await window.saveNewSessionExercise();

    // Saved to the session, referencing the newly-created library id.
    expect(createdLogPayload).not.toBeNull();
    expect(createdLogPayload.exercise_id).toBe(555);
    expect(createdLogPayload.exercise_name).toBe('Zercher Squat');
    // Appears in the library afterward.
    expect(library.map(i => i.name)).toContain('Zercher Squat');
  });

  it('saveNewSessionExercise recovers a UNIQUE-race create failure by refetching the library by name', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.showWorkoutSessionModal = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.logs = [];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    document.getElementById('session-add-exercise-name').value = 'Zercher Squat';
    document.getElementById('session-add-exercise-id').value = '';
    document.getElementById('session-add-exercise-sets').value = '4';
    document.getElementById('session-add-exercise-reps').value = '6';
    document.getElementById('session-add-exercise-weight').value = '70';

    // A concurrent tab created the exact name between our list read and POST:
    // the first list is empty, the create 500s (returns null on the UNIQUE
    // violation), and the refetch now surfaces the raced-in row.
    let listReads = 0;
    let createdLogPayload = null;
    window.apiCall = vi.fn(async (endpoint, method, payload) => {
      if (endpoint === '/api/workout/exercise-library') {
        listReads += 1;
        return listReads === 1 ? [] : [{ id: 777, name: 'Zercher Squat' }];
      }
      if (endpoint === '/api/workout/exercise-library/create') return null; // UNIQUE(user_id,name) 500
      if (endpoint === '/api/workout/sessions/logs/create') {
        createdLogPayload = payload;
        return { id: 999 };
      }
      if (endpoint.startsWith('/api/workout/sessions/details')) {
        return { session: { id: 42, status: 'in_progress' }, logs: window.WorkoutSessionsState.logs };
      }
      return [];
    });

    await window.saveNewSessionExercise();

    // Logged against the raced-in row instead of refusing with "Failed to add".
    expect(createdLogPayload).not.toBeNull();
    expect(createdLogPayload.exercise_id).toBe(777);
  });

  // med-prk.3 Task 5 — the shared picker now surfaces catalog-only names in
  // the session datalist. Those options carry no dataset.id; selecting one must
  // leave the hidden id empty so save-time resolution creates/matches a library
  // id, rather than posting exercise_id "undefined"/NaN.
  it('onSessionExerciseSelect leaves the hidden id empty for a catalog-only option', () => {
    const { window, document } = env;
    const datalist = document.getElementById('unique-exercises-list');
    datalist.replaceChildren();
    const opt = document.createElement('option');
    opt.value = 'Farmer Carry'; // catalog-only: no dataset.id
    datalist.appendChild(opt);

    document.getElementById('session-add-exercise-name').value = 'Farmer Carry';
    document.getElementById('session-add-exercise-id').value = 'stale';
    window.onSessionExerciseSelect();

    expect(document.getElementById('session-add-exercise-id').value).toBe('');
  });

  // med-3q8.1 / med-max — the session picker used to append all 1324 catalog
  // names AND dump the user's whole library, so the native suggestion popup
  // covered half the screen and buried the keyboard.
  function stubSessionPicker(window) {
    window.fetch = vi.fn(async (url) => (
      String(url).includes('exercises-catalog.json')
        ? {
            ok: true,
            status: 200,
            json: async () => ({ exercises: [{ name: 'Barbell bench press' }, { name: '3/4 sit-up' }] })
          }
        : { ok: true, status: 200, json: async () => ({}) }
    ));
    window.apiCall = vi.fn(async (endpoint) => (
      endpoint === '/api/workout/exercise-library'
        ? [{ id: 11, name: 'Overhead Press', default_sets: 3, default_reps_min: 8, default_weight_kg: 35 }]
        : []
    ));
    window.WorkoutSessionsState.data = { id: 77, status: 'in_progress', logs: [] };
  }

  it('the session picker opens with a ZERO-option datalist while the name field is empty', async () => {
    const { window, document } = env;
    stubSessionPicker(window);

    await window.showAddExerciseToSessionModal();

    // The exact screenshot case in med-max: empty field, "Start typing..."
    // placeholder — and therefore no native popup at all.
    expect(document.getElementById('session-add-exercise-name').value).toBe('');
    expect(Array.from(document.getElementById('unique-exercises-list').options)).toHaveLength(0);
  });

  it('the session picker filters library-then-catalog, capped, once the user types', async () => {
    const { window, document } = env;
    stubSessionPicker(window);

    const datalist = document.getElementById('unique-exercises-list');
    await window.showAddExerciseToSessionModal();

    const nameInput = document.getElementById('session-add-exercise-name');
    // One character: the library half only — the catalog stays gated at 2.
    nameInput.value = 'o';
    await nameInput.oninput();
    expect(Array.from(datalist.options).map((o) => o.value)).toEqual(['Overhead Press']);

    nameInput.value = 'bench';
    await nameInput.oninput();
    const values = Array.from(datalist.options).map((o) => o.value);
    expect(values).toEqual(['Barbell bench press']);
    expect(values).not.toContain('3/4 sit-up');

    // The picked catalog name is still findable when `change` fires, and stays
    // id-less so save routes it through resolveOrCreateLibraryId.
    nameInput.value = 'Barbell bench press';
    await nameInput.oninput();
    window.onSessionExerciseSelect();
    expect(document.getElementById('session-add-exercise-id').value).toBe('');
    expect(Array.from(datalist.options).map((o) => o.value)).toContain('Barbell bench press');
  });

  it('a library pick still autofills sets/reps/weight and resolves its id without a create round-trip', async () => {
    const { window, document } = env;
    stubSessionPicker(window);

    await window.showAddExerciseToSessionModal();

    const nameInput = document.getElementById('session-add-exercise-name');
    // Picking from the native popup fires `input` (our refresh) then `change`.
    nameInput.value = 'Overhead Press';
    await nameInput.oninput();
    window.onSessionExerciseSelect();

    expect(document.getElementById('session-add-exercise-id').value).toBe('11');
    expect(document.getElementById('session-add-exercise-sets').value).toBe('3');
    expect(document.getElementById('session-add-exercise-reps').value).toBe('8');
    expect(document.getElementById('session-add-exercise-weight').value).toBe('35');
    expect(window.apiCall.mock.calls.some((c) => c[0] === '/api/workout/exercise-library/create')).toBe(false);
  });

  it('saveNewSessionExercise rolls back the optimistic log when the POST returns null', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.logs = [
      { id: 5, exercise_id: 1, exercise_name: 'Bench', sets_completed: 3, reps_completed: 8, weight_kg: 60 }
    ];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    document.getElementById('session-add-exercise-name').value = 'Squat';
    document.getElementById('session-add-exercise-id').value = '99';
    document.getElementById('session-add-exercise-sets').value = '5';
    document.getElementById('session-add-exercise-reps').value = '5';
    document.getElementById('session-add-exercise-weight').value = '100';

    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint === '/api/workout/sessions/logs/create') return null;
      return [];
    });

    await window.saveNewSessionExercise();

    expect(window.WorkoutSessionsState.logs.length).toBe(1);
    expect(window.WorkoutSessionsState.logs[0].exercise_name).toBe('Bench');
    const cards = document.getElementById('workout-session-logs')
      .querySelectorAll('.wg-workouts-session-exercise');
    expect(cards.length).toBe(1);
  });

  it('deleteExerciseLog removes the row before the DELETE resolves', async () => {
    const { window, document } = env;
    installApiCache(window);
    // safeConfirm's in-page fallback modal isn't auto-dismissed in JSDOM;
    // shortcut it so the handler runs the "OK" branch synchronously.
    window.safeConfirm = (_msg, cb) => Promise.resolve(cb(true));
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.logs = [
      { id: 5, exercise_id: 1, exercise_name: 'Bench', sets_completed: 3, reps_completed: 8, weight_kg: 60 },
      { id: 6, exercise_id: 2, exercise_name: 'Overhead', sets_completed: 3, reps_completed: 10, weight_kg: 40 }
    ];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    const pending = deferred();
    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.startsWith('/api/workout/sessions/logs/delete')) return pending.promise;
      return [];
    });

    const handlerDone = window.deleteExerciseLog(0);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(window.WorkoutSessionsState.logs.length).toBe(1);
    expect(window.WorkoutSessionsState.logs[0].exercise_name).toBe('Overhead');
    const cards = document.getElementById('workout-session-logs')
      .querySelectorAll('.wg-workouts-session-exercise');
    expect(cards.length).toBe(1);

    pending.resolve(true);
    await handlerDone;
  });

  it('deleteExerciseLog restores the row when the DELETE returns null', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.safeConfirm = (_msg, cb) => Promise.resolve(cb(true));
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.logs = [
      { id: 5, exercise_id: 1, exercise_name: 'Bench', sets_completed: 3, reps_completed: 8, weight_kg: 60 },
      { id: 6, exercise_id: 2, exercise_name: 'Overhead', sets_completed: 3, reps_completed: 10, weight_kg: 40 }
    ];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.startsWith('/api/workout/sessions/logs/delete')) return null;
      return [];
    });

    await window.deleteExerciseLog(0);

    expect(window.WorkoutSessionsState.logs.length).toBe(2);
    expect(window.WorkoutSessionsState.logs[0].exercise_name).toBe('Bench');
    expect(window.WorkoutSessionsState.logs[1].exercise_name).toBe('Overhead');
  });

  // ===========================================================================
  // Phase 2 non-destructive history: the session modal prefers the completion
  // snapshot for un-logged planned rows and never hits the live variant.
  // ===========================================================================

  it('showWorkoutSessionModal prefills un-logged rows from exercise_snapshot without calling the live variant', async () => {
    const { window } = env;
    installApiCache(window);
    window.ModalManager.workoutSession.open = vi.fn();

    const calls = [];
    window.apiCall = vi.fn(async (endpoint) => {
      calls.push(endpoint);
      if (endpoint.startsWith('/api/workout/sessions/details')) {
        return {
          session: {
            id: 42, status: 'completed', variant_id: 7,
            exercise_snapshot: [
              { exercise_id: 1, exercise_name: 'Bench', target_sets: 5, target_reps_min: 5, target_weight_kg: 60, order_index: 0 },
              { exercise_id: 2, exercise_name: 'Squat', target_sets: 3, target_reps_min: 8, target_weight_kg: 100, order_index: 1 }
            ]
          },
          logs: [{ id: 5, exercise_id: 1, exercise_name: 'Bench', sets_completed: 5, reps_completed: 5, weight_kg: 60 }]
        };
      }
      return [];
    });

    await window.WorkoutSessions.open(42);

    // Live variant endpoint must not be consulted when a snapshot exists.
    expect(calls.some((c) => c.startsWith('/api/workout/exercises'))).toBe(false);

    const logs = window.WorkoutSessionsState.logs;
    // Bench already logged (matched by name) → only Squat prefilled from snapshot.
    const squat = logs.find((l) => l.exercise_name === 'Squat');
    expect(squat).toBeTruthy();
    expect(squat.sets_completed).toBe(3);
    expect(squat.weight_kg).toBe(100);
    expect(squat._dirty).toBe(false);
    // Snapshot rows carry their exercise_id so editing them can save.
    expect(squat.exercise_id).toBe(2);
    expect(logs.filter((l) => l.exercise_name === 'Bench').length).toBe(1);
  });

  // A plan can carry the same exercise name twice with different targets.
  // Logging one must not hide the other un-logged row — the snapshot path
  // dedupes by exercise_id, not name.
  it('keeps a duplicate-named un-logged snapshot row when its twin is logged', async () => {
    const { window } = env;
    installApiCache(window);
    window.ModalManager.workoutSession.open = vi.fn();

    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.startsWith('/api/workout/sessions/details')) {
        return {
          session: {
            id: 44, status: 'completed', variant_id: 7,
            exercise_snapshot: [
              { exercise_id: 1, exercise_name: 'Bench', target_sets: 5, target_reps_min: 5, target_weight_kg: 60, order_index: 0 },
              { exercise_id: 2, exercise_name: 'Bench', target_sets: 3, target_reps_min: 12, target_weight_kg: 40, order_index: 1 }
            ]
          },
          logs: [{ id: 5, exercise_id: 1, exercise_name: 'Bench', sets_completed: 5, reps_completed: 5, weight_kg: 60 }]
        };
      }
      return [];
    });

    await window.WorkoutSessions.open(44);

    const benches = window.WorkoutSessionsState.logs.filter((l) => l.exercise_name === 'Bench');
    // Logged id=1 row + still-un-logged id=2 row (the drop-set) = 2 rows.
    expect(benches.length).toBe(2);
    const unlogged = benches.find((l) => l.exercise_id === 2);
    expect(unlogged).toBeTruthy();
    expect(unlogged.reps_completed).toBe(12);
    expect(unlogged._dirty).toBe(false);
  });

  // Regression: editing an un-logged planned row of a completed (snapshotted)
  // session must save. Snapshot rows used to mint exercise_id 0, which
  // logs/create rejects ("SessionID and ExerciseID are required"), bricking the
  // whole save. The row must post the snapshot's real exercise_id.
  it('editing an un-logged snapshot row saves a logs/create with the real exercise_id', async () => {
    const { window } = env;
    installApiCache(window);
    window.ModalManager.workoutSession.open = vi.fn();

    let createdLogPayload = null;
    window.apiCall = vi.fn(async (endpoint, method, payload) => {
      if (endpoint.startsWith('/api/workout/sessions/details')) {
        return {
          session: {
            id: 42, status: 'completed', variant_id: 7,
            exercise_snapshot: [
              { exercise_id: 2, exercise_name: 'Squat', target_sets: 3, target_reps_min: 8, target_weight_kg: 100, order_index: 0 }
            ]
          },
          logs: []
        };
      }
      if (endpoint === '/api/workout/sessions/logs/create') {
        createdLogPayload = payload;
        return { id: 999 };
      }
      return [];
    });

    await window.WorkoutSessions.open(42);

    const squatIndex = window.WorkoutSessionsState.logs.findIndex((l) => l.exercise_name === 'Squat');
    expect(squatIndex).toBeGreaterThanOrEqual(0);
    // User edits the prefilled (un-logged) row → marks it dirty so it saves.
    window.WorkoutSessions.updateLog(squatIndex, 'reps_completed', '6');
    await window.WorkoutSessions.save();

    expect(createdLogPayload).not.toBeNull();
    expect(createdLogPayload.exercise_id).toBe(2);
  });

  it('showWorkoutSessionModal falls back to the live variant when the session has no snapshot', async () => {
    const { window } = env;
    installApiCache(window);
    window.ModalManager.workoutSession.open = vi.fn();

    const calls = [];
    window.apiCall = vi.fn(async (endpoint) => {
      calls.push(endpoint);
      if (endpoint.startsWith('/api/workout/sessions/details')) {
        return { session: { id: 43, status: 'completed', variant_id: 7 }, logs: [] };
      }
      if (endpoint.startsWith('/api/workout/exercises')) {
        return [{ id: 9, exercise_name: 'Deadlift', target_sets: 1, target_reps_min: 5, target_weight_kg: 140 }];
      }
      return [];
    });

    await window.WorkoutSessions.open(43);

    expect(calls.some((c) => c.startsWith('/api/workout/exercises'))).toBe(true);
    const deadlift = window.WorkoutSessionsState.logs.find((l) => l.exercise_name === 'Deadlift');
    expect(deadlift).toBeTruthy();
    expect(deadlift.exercise_id).toBe(9);
  });

  it('saveWorkoutSessionDetails flips workout_history.session.status optimistically when the status changes', async () => {
    const { window, document } = env;
    const cache = installApiCache(window, {
      workout_history: {
        sessions: [{
          session: { id: 42, status: 'in_progress' },
          group_name: 'Push',
          exercises_count: 3,
          exercises_completed: 3
        }],
        miband: []
      }
    });
    // loadWorkoutHistoryTab is fire-and-forget on the success path; stub it
    // so we don't leak async work past test cleanup.
    window.loadWorkoutHistoryTab = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    window.WorkoutSessionsState.logs = [];

    // Seed the status select the production code reads from.
    window.renderWorkoutSessionInfo(document.getElementById('workout-session-info'), {
      id: 42, status: 'in_progress', scheduled_date: '2026-04-22', scheduled_time: '09:00', variant_name: 'Push'
    });
    document.getElementById('session-status-select').value = 'completed';

    // Use the apiCall invocation as the timing fence: by the time the POST
    // fires, the optimistic cache writes have all settled. Yielding fixed
    // microtask counts is fragile because two sequential applyOptimistic
    // awaits each have multiple internal awaits.
    let apiCallSignal;
    const apiCalled = new Promise((r) => { apiCallSignal = r; });
    const pending = deferred();
    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.startsWith('/api/workout/sessions/status')) {
        apiCallSignal();
        return pending.promise;
      }
      return [];
    });

    const handlerDone = window.saveWorkoutSessionDetails();
    await apiCalled;

    const cached = cache.get('workout_history');
    expect(cached.sessions[0].session.status).toBe('completed');

    pending.resolve({ ok: true });
    await handlerDone;
  });

  it('finishWorkoutSession clears workout_next optimistically when finishing the current session', async () => {
    const { window, document } = env;
    const cache = installApiCache(window, {
      workout_next: { session: { id: 42, status: 'in_progress' } },
      workout_history: {
        sessions: [{ session: { id: 42, status: 'in_progress' }, group_name: 'Push' }],
        miband: []
      }
    });
    window.loadWorkoutHistoryTab = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    window.WorkoutSessionsState.logs = [];

    window.renderWorkoutSessionInfo(document.getElementById('workout-session-info'), {
      id: 42, status: 'in_progress', scheduled_date: '2026-04-22', scheduled_time: '09:00', variant_name: 'Push'
    });

    let apiCallSignal;
    const apiCalled = new Promise((r) => { apiCallSignal = r; });
    const pending = deferred();
    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.startsWith('/api/workout/sessions/status')) {
        apiCallSignal();
        return pending.promise;
      }
      return [];
    });

    const handlerDone = window.finishWorkoutSession();
    await apiCalled;

    // finishWorkoutSession flips status to 'completed' and routes through
    // saveWorkoutSessionDetails. The optimistic projection wipes the cached
    // workout_next entry (session ids match) and flips history status.
    expect(cache.get('workout_next')).toEqual({ session: null });
    expect(cache.get('workout_history').sessions[0].session.status).toBe('completed');

    pending.resolve({ ok: true });
    await handlerDone;
  });

  // ===========================================================================
  // Optimistic write conversion (Plan 2026-05-17 Task 3) — ad-hoc lifecycle
  //
  // completeWorkoutSession / preSkipWorkoutSession / cancelPreSkipWorkoutSession
  // / startAdHocWorkout / snoozeWorkout / skipWorkout flip the cached
  // workout_next + workout_history payloads BEFORE the network round-trip
  // resolves so the next-card swap is instant.
  // ===========================================================================

  it('completeWorkoutSession flips workout_history.status and clears workout_next optimistically', async () => {
    const { window } = env;
    const cache = installApiCache(window, {
      workout_next: { session: { id: 50, status: 'in_progress' } },
      workout_history: {
        sessions: [{ session: { id: 50, status: 'in_progress' }, group_name: 'Push' }],
        miband: []
      }
    });
    window.safeConfirm = (_msg, cb) => Promise.resolve(cb(true));
    window.loadNextWorkout = vi.fn();
    window.loadWorkoutHistoryTab = vi.fn();

    let apiCallSignal;
    const apiCalled = new Promise((r) => { apiCallSignal = r; });
    const pending = deferred();
    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.startsWith('/api/workout/sessions/status')) {
        apiCallSignal();
        return pending.promise;
      }
      return true;
    });

    const handlerDone = window.completeWorkoutSession(50);
    await apiCalled;

    expect(cache.get('workout_next')).toEqual({ session: null });
    expect(cache.get('workout_history').sessions[0].session.status).toBe('completed');

    pending.resolve({ ok: true });
    await handlerDone;
  });

  it('completeWorkoutSession rolls back workout_next + workout_history on POST failure', async () => {
    const { window } = env;
    const cache = installApiCache(window, {
      workout_next: { session: { id: 50, status: 'in_progress' } },
      workout_history: {
        sessions: [{ session: { id: 50, status: 'in_progress' }, group_name: 'Push' }],
        miband: []
      }
    });
    window.safeConfirm = (_msg, cb) => Promise.resolve(cb(true));
    window.loadNextWorkout = vi.fn();
    window.loadWorkoutHistoryTab = vi.fn();

    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.startsWith('/api/workout/sessions/status')) return null;
      return true;
    });

    await window.completeWorkoutSession(50);

    // After rollback prior state is restored (or invalidated). The contract
    // the test guards against is the optimistic null/completed values
    // surviving the failure.
    const nextCached = cache.get('workout_next');
    if (nextCached) expect(nextCached.session.status).toBe('in_progress');
    const histCached = cache.get('workout_history');
    if (histCached) expect(histCached.sessions[0].session.status).toBe('in_progress');
  });

  it('preSkipWorkoutSession flips workout_next.session.status to pre_skipped optimistically', async () => {
    const { window } = env;
    const cache = installApiCache(window, {
      workout_next: { session: { id: 60, status: 'pending' } }
    });
    window.safeConfirm = (_msg, cb) => Promise.resolve(cb(true));
    window.loadNextWorkout = vi.fn();

    let apiCallSignal;
    const apiCalled = new Promise((r) => { apiCallSignal = r; });
    const pending = deferred();
    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.endsWith('/preskip')) {
        apiCallSignal();
        return pending.promise;
      }
      return true;
    });

    const handlerDone = window.preSkipWorkoutSession(60);
    await apiCalled;

    expect(cache.get('workout_next').session.status).toBe('pre_skipped');

    pending.resolve({ ok: true });
    await handlerDone;
  });

  it('preSkipWorkoutSession rolls back workout_next.session.status on POST failure', async () => {
    const { window } = env;
    const cache = installApiCache(window, {
      workout_next: { session: { id: 60, status: 'pending' } }
    });
    window.safeConfirm = (_msg, cb) => Promise.resolve(cb(true));
    window.loadNextWorkout = vi.fn();

    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.endsWith('/preskip')) return null;
      return true;
    });

    await window.preSkipWorkoutSession(60);

    const cached = cache.get('workout_next');
    if (cached) expect(cached.session.status).toBe('pending');
  });

  it('cancelPreSkipWorkoutSession flips workout_next.session.status back to pending optimistically', async () => {
    const { window } = env;
    const cache = installApiCache(window, {
      workout_next: { session: { id: 61, status: 'pre_skipped' } }
    });
    window.loadNextWorkout = vi.fn();

    let apiCallSignal;
    const apiCalled = new Promise((r) => { apiCallSignal = r; });
    const pending = deferred();
    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.endsWith('/cancel-preskip')) {
        apiCallSignal();
        return pending.promise;
      }
      return true;
    });

    const handlerDone = window.cancelPreSkipWorkoutSession(61);
    await apiCalled;

    expect(cache.get('workout_next').session.status).toBe('pending');

    pending.resolve({ ok: true });
    await handlerDone;
  });

  it('cancelPreSkipWorkoutSession rolls back workout_next.session.status on POST failure', async () => {
    const { window } = env;
    const cache = installApiCache(window, {
      workout_next: { session: { id: 61, status: 'pre_skipped' } }
    });
    window.loadNextWorkout = vi.fn();

    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.endsWith('/cancel-preskip')) return null;
      return true;
    });

    await window.cancelPreSkipWorkoutSession(61);

    const cached = cache.get('workout_next');
    if (cached) expect(cached.session.status).toBe('pre_skipped');
  });

  it('startAdHocWorkout clears workout_next optimistically and commits the new session on success', async () => {
    const { window } = env;
    const cache = installApiCache(window, {
      workout_next: { session: null }
    });
    window.showWorkoutSessionModal = vi.fn();
    window.loadNextWorkout = vi.fn();

    let apiCallSignal;
    const apiCalled = new Promise((r) => { apiCallSignal = r; });
    const pending = deferred();
    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint === '/api/workout/sessions/adhoc') {
        apiCallSignal();
        return pending.promise;
      }
      return true;
    });

    const handlerDone = window.startAdHocWorkout();
    await apiCalled;

    // While the POST is in flight, workout_next is the placeholder.
    expect(cache.get('workout_next')).toEqual({ session: null });

    pending.resolve({ session: { id: 777, status: 'in_progress' } });
    await handlerDone;

    // After commit() the cache briefly holds the server session, then the
    // success path's invalidateWorkoutCache clears the entry so the next read
    // fetches authoritatively. We can't assert the post-commit cache state
    // directly; the success contract is encoded in the modal-open call.
    expect(window.showWorkoutSessionModal).toHaveBeenCalledWith(777);
  });

  it('startAdHocWorkout rolls back workout_next on POST failure', async () => {
    const { window } = env;
    const cache = installApiCache(window, {
      workout_next: { session: { id: 1, status: 'pending' } }
    });
    window.showWorkoutSessionModal = vi.fn();
    window.loadNextWorkout = vi.fn();
    window.safeAlert = vi.fn();

    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint === '/api/workout/sessions/adhoc') return null;
      return true;
    });

    await window.startAdHocWorkout();

    // Prior workout_next is restored from snapshot (rollback also invalidates
    // the tag, so a downstream read goes to network).
    const cached = cache.get('workout_next');
    if (cached) {
      expect(cached.session.id).toBe(1);
      expect(cached.session.status).toBe('pending');
    }
  });

  it('snoozeWorkout stamps snoozed_until on workout_next.session optimistically', async () => {
    const { window } = env;
    const cache = installApiCache(window, {
      workout_next: { session: { id: 80, status: 'pending' } }
    });
    window.PushModalState = {
      ...(window.PushModalState || {}),
      getWorkoutSessionId: () => 80
    };
    window.safeAlert = vi.fn();
    window.closeWorkoutStartModal = vi.fn();

    let apiCallSignal;
    const apiCalled = new Promise((r) => { apiCallSignal = r; });
    const pending = deferred();
    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.endsWith('/snooze')) {
        apiCallSignal();
        return pending.promise;
      }
      return true;
    });

    const handlerDone = window.snoozeWorkout(30);
    await apiCalled;

    const optimistic = cache.get('workout_next').session;
    expect(optimistic.is_snoozed).toBe(true);
    expect(typeof optimistic.snoozed_until).toBe('string');

    pending.resolve({ ok: true });
    await handlerDone;
  });

  it('snoozeWorkout rolls back workout_next.session on POST failure', async () => {
    const { window } = env;
    const cache = installApiCache(window, {
      workout_next: { session: { id: 80, status: 'pending' } }
    });
    window.PushModalState = {
      ...(window.PushModalState || {}),
      getWorkoutSessionId: () => 80
    };
    window.safeAlert = vi.fn();
    window.closeWorkoutStartModal = vi.fn();

    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.endsWith('/snooze')) return null;
      return true;
    });

    await window.snoozeWorkout(30);

    const cached = cache.get('workout_next');
    if (cached) {
      expect(cached.session.is_snoozed).toBeFalsy();
      expect(cached.session.snoozed_until).toBeFalsy();
    }
  });

  it('skipWorkout nulls workout_next.session optimistically', async () => {
    const { window } = env;
    const cache = installApiCache(window, {
      workout_next: { session: { id: 90, status: 'pending' } }
    });
    window.PushModalState = {
      ...(window.PushModalState || {}),
      getWorkoutSessionId: () => 90
    };
    window.safeAlert = vi.fn();
    window.closeWorkoutStartModal = vi.fn();
    window.loadWorkouts = vi.fn();
    window.safeConfirm = (_msg, cb) => Promise.resolve(cb(true));

    let apiCallSignal;
    const apiCalled = new Promise((r) => { apiCallSignal = r; });
    const pending = deferred();
    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.endsWith('/skip')) {
        apiCallSignal();
        return pending.promise;
      }
      return true;
    });

    const handlerDone = window.skipWorkout();
    await apiCalled;

    expect(cache.get('workout_next')).toEqual({ session: null });

    pending.resolve({ ok: true });
    await handlerDone;
  });

  it('skipWorkout rolls back workout_next on POST failure', async () => {
    const { window } = env;
    const cache = installApiCache(window, {
      workout_next: { session: { id: 90, status: 'pending' } }
    });
    window.PushModalState = {
      ...(window.PushModalState || {}),
      getWorkoutSessionId: () => 90
    };
    window.safeAlert = vi.fn();
    window.closeWorkoutStartModal = vi.fn();
    window.loadWorkouts = vi.fn();
    window.safeConfirm = (_msg, cb) => Promise.resolve(cb(true));

    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.endsWith('/skip')) return null;
      return true;
    });

    await window.skipWorkout();

    const cached = cache.get('workout_next');
    if (cached) {
      expect(cached.session.id).toBe(90);
      expect(cached.session.status).toBe('pending');
    }
  });

  it('saveWorkoutSessionDetails rolls back optimistic workout_history on POST failure', async () => {
    const { window, document } = env;
    const cache = installApiCache(window, {
      workout_history: {
        sessions: [{
          session: { id: 42, status: 'in_progress' },
          group_name: 'Push',
          exercises_count: 3
        }],
        miband: []
      }
    });
    window.loadWorkoutHistoryTab = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    window.WorkoutSessionsState.logs = [];

    window.renderWorkoutSessionInfo(document.getElementById('workout-session-info'), {
      id: 42, status: 'in_progress', scheduled_date: '2026-04-22', scheduled_time: '09:00', variant_name: 'Push'
    });
    document.getElementById('session-status-select').value = 'completed';

    // apiCall returns null on offline/5xx — same path the production code
    // hits without throwing.
    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.startsWith('/api/workout/sessions/status')) return null;
      return [];
    });

    await window.saveWorkoutSessionDetails();

    // Rollback path: prior session.status is restored, then invalidateTags
    // clears the entry so the next read goes to network. Either outcome
    // (entry absent or entry restored) is acceptable; the failure mode the
    // test guards against is the optimistic 'completed' value surviving.
    const cached = cache.get('workout_history');
    if (cached) {
      expect(cached.sessions[0].session.status).toBe('in_progress');
    } else {
      expect(cache.has('workout_history')).toBe(false);
    }
  });

  it('saveWorkoutSessionDetails settles optimistic handles on partial failure (first log ok, second fails)', async () => {
    const { window, document } = env;
    installApiCache(window, {
      workout_history: {
        sessions: [{
          session: { id: 42, status: 'in_progress' },
          group_name: 'Push',
          exercises_count: 2,
          exercises_completed: 2
        }],
        miband: []
      }
    });
    window.loadWorkoutHistoryTab = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    window.WorkoutSessionsState.logs = [
      { id: 7, exercise_name: 'Bench', sets_completed: 3, reps_completed: 8, weight_kg: 80, notes: '' },
      { id: 8, exercise_name: 'Row', sets_completed: 3, reps_completed: 8, weight_kg: 40, notes: '' }
    ];

    window.renderWorkoutSessionInfo(document.getElementById('workout-session-info'), {
      id: 42, status: 'in_progress', scheduled_date: '2026-04-22', scheduled_time: '09:00', variant_name: 'Push'
    });
    document.getElementById('session-status-select').value = 'completed';

    // Logs are saved BEFORE the terminal status flip (so progression can run
    // while the session is still active). The first log update succeeds, the
    // second returns null (offline / 5xx). Without settling the optimistic
    // handles on this partial failure, pendingOptimistic stays >0 forever —
    // every future fetchFresh for workout_history / workout_next would
    // short-circuit.
    window.apiCall = vi.fn(async (endpoint, method, payload) => {
      if (endpoint.startsWith('/api/workout/sessions/logs/update')) {
        return payload && payload.id === 8 ? null : { ok: true };
      }
      if (endpoint.startsWith('/api/workout/sessions/status')) return { ok: true };
      return [];
    });

    await window.saveWorkoutSessionDetails();

    // Both optimistic keys must be free of a pending handle so future reads
    // can refresh. This is the property whose violation caused the bug.
    expect(window.DataStore.hasPendingOptimistic('workout_history')).toBe(false);
    expect(window.DataStore.hasPendingOptimistic('workout_next')).toBe(false);
    // The status PUT is never reached once a log write fails.
    const statusCalls = window.apiCall.mock.calls.filter(([e]) => e.startsWith('/api/workout/sessions/status'));
    expect(statusCalls.length).toBe(0);
  });

  it('saveWorkoutSessionDetails saves log edits before the terminal status flip (progression can run while active)', async () => {
    const { window, document } = env;
    installApiCache(window, {
      workout_history: {
        sessions: [{ session: { id: 42, status: 'in_progress' }, group_name: 'Push', exercises_count: 1, exercises_completed: 1 }],
        miband: []
      }
    });
    window.loadWorkoutHistoryTab = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    window.WorkoutSessionsState.logs = [
      { id: 7, exercise_name: 'Bench', sets_completed: 3, reps_completed: 12, weight_kg: 60, notes: '' }
    ];

    window.renderWorkoutSessionInfo(document.getElementById('workout-session-info'), {
      id: 42, status: 'in_progress', scheduled_date: '2026-04-22', scheduled_time: '09:00', variant_name: 'Push'
    });
    document.getElementById('session-status-select').value = 'completed';

    const order = [];
    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.startsWith('/api/workout/sessions/logs/update')) order.push('log');
      else if (endpoint.startsWith('/api/workout/sessions/status')) order.push('status');
      return { ok: true };
    });

    await window.saveWorkoutSessionDetails();

    // The log write (which drives schedule propagation / opt-in progression,
    // gated on the session still being pending/notified/in_progress) must land
    // before the status is flipped to completed — otherwise the guard skips it.
    expect(order).toEqual(['log', 'status']);
  });

  it('saveWorkoutSessionDetails flips status to skipped BEFORE saving logs (no progression on skip)', async () => {
    const { window, document } = env;
    installApiCache(window, {
      workout_history: {
        sessions: [{ session: { id: 42, status: 'in_progress' }, group_name: 'Push', exercises_count: 1, exercises_completed: 1 }],
        miband: []
      }
    });
    window.loadWorkoutHistoryTab = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    window.WorkoutSessionsState.logs = [
      { id: 7, exercise_name: 'Bench', sets_completed: 3, reps_completed: 12, weight_kg: 60, notes: '' }
    ];

    window.renderWorkoutSessionInfo(document.getElementById('workout-session-info'), {
      id: 42, status: 'in_progress', scheduled_date: '2026-04-22', scheduled_time: '09:00', variant_name: 'Push'
    });
    document.getElementById('session-status-select').value = 'skipped';

    const order = [];
    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.startsWith('/api/workout/sessions/logs/update')) order.push('log');
      else if (endpoint.startsWith('/api/workout/sessions/status')) order.push('status');
      return { ok: true };
    });

    await window.saveWorkoutSessionDetails();

    // On skip the status flips FIRST so the log write below hits an already-
    // skipped session and its schedule propagation / progression no-ops — a
    // skipped session must not advance the plan (that's for completed sessions).
    expect(order).toEqual(['status', 'log']);
  });

  // ===========================================================================
  // Debounced autosave decoupled from close (med-eas.71, Task 2)
  //
  // Any edit arms an ~800ms timer that persists through the existing
  // saveWorkoutSessionDetails path WITHOUT closing the modal. Rapid edits
  // batch into a single save; changing the status select autosaves too.
  // ===========================================================================

  it('autosaves batched set/reps edits ~800ms after the last edit without closing the modal', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.loadWorkoutHistoryTab = vi.fn();
    const closeSpy = vi.spyOn(window.ModalManager.workoutSession, 'close');
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    window.WorkoutSessionsState.logs = [
      { id: 7, exercise_id: 1, exercise_name: 'Bench', sets_completed: 2, reps_completed: 8, weight_kg: 60, notes: '' }
    ];
    window.renderWorkoutSessionInfo(document.getElementById('workout-session-info'), {
      id: 42, status: 'in_progress', scheduled_date: '2026-04-22', scheduled_time: '09:00', variant_name: 'Push'
    });
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    const updateCalls = [];
    window.apiCall = vi.fn(async (endpoint, method, payload) => {
      if (endpoint.startsWith('/api/workout/sessions/logs/update')) { updateCalls.push(payload); return { ok: true }; }
      return [];
    });

    vi.useFakeTimers();
    try {
      // Two rapid edits inside the debounce window → one batched autosave.
      window.updateLocalSet(0, 0, 'weight_kg', '65');
      window.updateLocalSet(0, 1, 'reps', '10');
      // Not yet fired before the debounce elapses.
      await vi.advanceTimersByTimeAsync(400);
      expect(updateCalls.length).toBe(0);
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }

    // Exactly one save for the single edited log; the modal stays open.
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].id).toBe(7);
    expect(closeSpy).not.toHaveBeenCalled();
    expect(window.loadWorkoutHistoryTab).not.toHaveBeenCalled();
    expect(window.WorkoutSessionsState.data).not.toBeNull();
  });

  it('autosaves a notes edit through the existing apiCall path', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.loadWorkoutHistoryTab = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    window.WorkoutSessionsState.logs = [
      { id: 7, exercise_id: 1, exercise_name: 'Bench', sets_completed: 2, reps_completed: 8, weight_kg: 60, notes: '' }
    ];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    let notesSeen = null;
    window.apiCall = vi.fn(async (endpoint, method, payload) => {
      if (endpoint.startsWith('/api/workout/sessions/logs/update')) { notesSeen = payload.notes; return { ok: true }; }
      return [];
    });

    vi.useFakeTimers();
    try {
      window.updateLocalLog(0, 'notes', 'felt strong');
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }

    expect(notesSeen).toBe('felt strong');
  });

  it('autosaves when the status select changes (no modal close)', async () => {
    const { window, document } = env;
    installApiCache(window, {
      workout_next: { session: { id: 42, status: 'in_progress' } },
      workout_history: {
        sessions: [{ session: { id: 42, status: 'in_progress' }, group_name: 'Push' }],
        miband: []
      }
    });
    window.loadWorkoutHistoryTab = vi.fn();
    const closeSpy = vi.spyOn(window.ModalManager.workoutSession, 'close');
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    window.WorkoutSessionsState.logs = [];

    window.renderWorkoutSessionInfo(document.getElementById('workout-session-info'), {
      id: 42, status: 'in_progress', scheduled_date: '2026-04-22', scheduled_time: '09:00', variant_name: 'Push'
    });

    const statusCalls = [];
    window.apiCall = vi.fn(async (endpoint, method, payload) => {
      if (endpoint.startsWith('/api/workout/sessions/status')) { statusCalls.push(payload); return { ok: true }; }
      return [];
    });

    const select = document.getElementById('session-status-select');
    select.value = 'skipped';

    vi.useFakeTimers();
    try {
      select.dispatchEvent(new window.Event('change'));
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }

    expect(statusCalls.length).toBe(1);
    expect(statusCalls[0].status).toBe('skipped');
    expect(closeSpy).not.toHaveBeenCalled();
    expect(window.WorkoutSessionsState.data).not.toBeNull();
  });

  // Regression (med-eas.71): a planned exercise pre-fills as an id:0 log. The
  // first autosave after editing it must CREATE it and adopt the returned id;
  // a later autosave must then UPDATE (not re-create), or cloud createLog's
  // dedup guard throws 'conflict' — a blocking alert that aborts the batch and
  // bricks Finish.
  it('reconciles a created log id so a subsequent autosave updates instead of re-creating', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.loadWorkoutHistoryTab = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    // Pre-filled planned row: id 0, real exercise_id, untouched.
    window.WorkoutSessionsState.logs = [
      { id: 0, exercise_id: 3, exercise_name: 'Squat', sets_completed: 3, reps_completed: 5, weight_kg: 100, notes: '', _dirty: false }
    ];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    const createCalls = [];
    const updateCalls = [];
    window.apiCall = vi.fn(async (endpoint, method, payload) => {
      if (endpoint === '/api/workout/sessions/logs/create') { createCalls.push(payload); return { id: 88 }; }
      if (endpoint.startsWith('/api/workout/sessions/logs/update')) { updateCalls.push(payload); return { ok: true }; }
      return [];
    });

    vi.useFakeTimers();
    try {
      window.updateLocalSet(0, 0, 'weight_kg', '105');
      await vi.advanceTimersByTimeAsync(800);
      // Second edit → second autosave.
      window.updateLocalSet(0, 1, 'reps', '6');
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }

    // Exactly one create (first autosave), then an update (not a second create).
    expect(createCalls.length).toBe(1);
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].id).toBe(88);
    // Local log adopted the server id.
    expect(window.WorkoutSessionsState.logs[0].id).toBe(88);
  });

  it('re-sends a per-set edit made while an autosave is in flight (claim-before-await, not clobbered)', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.loadWorkoutHistoryTab = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    window.WorkoutSessionsState.logs = [
      { id: 7, exercise_id: 1, exercise_name: 'Bench', sets_completed: 2, reps_completed: 8, weight_kg: 60, notes: '',
        sets: [
          { set_index: 0, weight_kg: 60, reps: 8, set_type: 'normal' },
          { set_index: 1, weight_kg: 60, reps: 8, set_type: 'normal' }
        ] }
    ];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    const updateCalls = [];
    const firstUpdate = deferred();
    let n = 0;
    window.apiCall = vi.fn(async (endpoint, method, payload) => {
      if (endpoint.startsWith('/api/workout/sessions/logs/update')) {
        updateCalls.push(payload);
        n += 1;
        return n === 1 ? firstUpdate.promise : { ok: true };
      }
      return [];
    });

    vi.useFakeTimers();
    try {
      // Edit set 0 → autosave A fires and its update goes in flight (deferred).
      window.updateLocalSet(0, 0, 'weight_kg', '65');
      await vi.advanceTimersByTimeAsync(800);
      // While A is in flight, edit set 1 — this re-marks _setsDirty. The old
      // read-clear-after-await would have this cleared by A on resolve, dropping
      // the edit from the next save's sets array.
      window.updateLocalSet(0, 1, 'reps', '10');
      // Resolve A, then let autosave B fire.
      firstUpdate.resolve({ ok: true });
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }

    expect(updateCalls.length).toBe(2);
    // B must re-send the sets array carrying the mid-flight edit — not omit it.
    expect(Array.isArray(updateCalls[1].sets)).toBe(true);
    expect(updateCalls[1].sets[1].reps).toBe(10);
  });

  // ===========================================================================
  // Autosave failure handling (med-eas.71, Task 4)
  //
  // A failed autosave keeps the modal open, keeps the user's local edits in
  // state (never dropped), and surfaces an inline error; a subsequent
  // successful autosave clears it.
  // ===========================================================================

  it('a failed autosave keeps the modal open, preserves local edits, and shows an inline error that a later success clears', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.loadWorkoutHistoryTab = vi.fn();
    const closeSpy = vi.spyOn(window.ModalManager.workoutSession, 'close');
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    window.WorkoutSessionsState.logs = [
      { id: 7, exercise_id: 1, exercise_name: 'Bench', sets_completed: 2, reps_completed: 8, weight_kg: 60, notes: '' }
    ];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    const status = document.getElementById('workout-session-autosave-status');

    // First autosave fails (apiCall returns null → soft/network failure).
    let failNext = true;
    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.startsWith('/api/workout/sessions/logs/update')) return failNext ? null : { ok: true };
      return [];
    });

    vi.useFakeTimers();
    try {
      window.updateLocalSet(0, 0, 'weight_kg', '65');
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }

    // Modal stays open, the edit is still in state, and the error is inline.
    expect(closeSpy).not.toHaveBeenCalled();
    expect(window.WorkoutSessionsState.data).not.toBeNull();
    expect(window.WorkoutSessionsState.logs[0].sets[0].weight_kg).toBe(65);
    expect(status.classList.contains('is-error')).toBe(true);
    expect(status.textContent.length).toBeGreaterThan(0);

    // A subsequent successful autosave clears the inline error.
    failNext = false;
    vi.useFakeTimers();
    try {
      window.updateLocalSet(0, 1, 'reps', '10');
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }

    expect(status.classList.contains('is-error')).toBe(false);
    expect(status.textContent).toBe('');
  });

  // ===========================================================================
  // Save button removed, Cancel relabelled Close, close flushes pending edit
  // (med-eas.71, Task 3)
  // ===========================================================================

  it('has no Save button and a Close (not Cancel) header button in the session modal', () => {
    const { document } = env;
    expect(document.getElementById('workout-session-save-btn')).toBeNull();
    const closeBtn = document.getElementById('workout-session-cancel-btn');
    expect(closeBtn).not.toBeNull();
    expect(closeBtn.textContent).toBe('Close');
  });

  it('closing with a pending debounced edit flushes it before dismissing (edit not dropped)', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.loadWorkoutHistoryTab = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    window.WorkoutSessionsState.logs = [
      { id: 7, exercise_id: 1, exercise_name: 'Bench', sets_completed: 2, reps_completed: 8, weight_kg: 60, notes: '' }
    ];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    const updateCalls = [];
    window.apiCall = vi.fn(async (endpoint, method, payload) => {
      if (endpoint.startsWith('/api/workout/sessions/logs/update')) { updateCalls.push(payload); return { ok: true }; }
      return [];
    });

    // Arm a debounced edit but close before the ~800ms timer elapses — the
    // flush on close must still persist it.
    window.updateLocalSet(0, 0, 'weight_kg', '65');
    await window.closeWorkoutSessionModal();

    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].id).toBe(7);
    expect(window.WorkoutSessionsState.data).toBeNull();
  });

  it('closing while the pending flush fails keeps the modal open and preserves the edit (not dropped)', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.loadWorkoutHistoryTab = vi.fn();
    const closeSpy = vi.spyOn(window.ModalManager.workoutSession, 'close');
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    window.WorkoutSessionsState.logs = [
      { id: 7, exercise_id: 1, exercise_name: 'Bench', sets_completed: 2, reps_completed: 8, weight_kg: 60, notes: '' }
    ];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    // Soft (offline / 5xx) failure: the log update returns null.
    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.startsWith('/api/workout/sessions/logs/update')) return null;
      return [];
    });

    // Arm a debounced edit then Close before the timer elapses; the flush runs,
    // fails, and must keep the modal open so the unsaved edit isn't torn down.
    window.updateLocalSet(0, 0, 'weight_kg', '65');
    await window.closeWorkoutSessionModal();

    expect(closeSpy).not.toHaveBeenCalled();
    expect(window.WorkoutSessionsState.data).not.toBeNull();
    // Edit is still present and re-flagged dirty for a later retry.
    expect(window.WorkoutSessionsState.logs[0].sets[0].weight_kg).toBe(65);
    expect(window.WorkoutSessionsState.logs[0]._dirty).toBe(true);
    expect(document.getElementById('workout-session-autosave-status').classList.contains('is-error')).toBe(true);
  });

  it('adding an exercise while the pending flush fails bails and preserves the edit (not dropped by reload)', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.safeAlert = vi.fn();
    const reloadSpy = vi.spyOn(window, 'showWorkoutSessionModal');
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    window.WorkoutSessionsState.logs = [
      { id: 7, exercise_id: 1, exercise_name: 'Bench', sets_completed: 2, reps_completed: 8, weight_kg: 60, notes: '' }
    ];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    // Soft (offline / 5xx) failure on the pending edit's save; a create would
    // otherwise succeed (returns []), reload the session, and clobber the edit.
    const createSpy = vi.fn(async () => ({ id: 999 }));
    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.startsWith('/api/workout/sessions/logs/update')) return null;
      if (endpoint === '/api/workout/sessions/logs/create') return createSpy(endpoint);
      return [];
    });

    // Arm a debounced edit, then try to add an exercise before it flushes.
    window.updateLocalSet(0, 0, 'weight_kg', '65');
    document.getElementById('session-add-exercise-name').value = 'Squat';
    document.getElementById('session-add-exercise-id').value = '99';
    document.getElementById('session-add-exercise-sets').value = '5';
    document.getElementById('session-add-exercise-reps').value = '5';

    await window.saveNewSessionExercise();

    // Bailed: no create fired, no session reload, the edit survives + stays dirty.
    expect(createSpy).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(window.safeAlert).toHaveBeenCalled();
    expect(window.WorkoutSessionsState.logs.length).toBe(1);
    expect(window.WorkoutSessionsState.logs[0].sets[0].weight_kg).toBe(65);
    expect(window.WorkoutSessionsState.logs[0]._dirty).toBe(true);
  });

  // ===========================================================================
  // Per-set logging (workout Phase 1, epic med-qj4)
  //
  // The single Sets/Reps/Weight row is replaced by repeatable per-set rows
  // (weight × reps, optional RPE, set_type). The flat scalars are derived from
  // the sets and ride alongside `sets` on every write so bot mode + existing
  // consumers are unaffected.
  // ===========================================================================

  it('renders one per-set row per synthesized set and supports add/remove', () => {
    const { window, document } = env;
    installApiCache(window);
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.logs = [
      { id: 5, exercise_id: 1, exercise_name: 'Bench', sets_completed: 2, reps_completed: 8, weight_kg: 60 }
    ];
    const container = document.getElementById('workout-session-logs');
    window.renderWorkoutSessionLogs(container);

    // Existing flat-scalar log synthesizes sets_completed rows.
    let rows = container.querySelectorAll('.wg-workouts-session-exercise__set-row');
    expect(rows.length).toBe(2);

    window.addLocalSet(0);
    rows = container.querySelectorAll('.wg-workouts-session-exercise__set-row');
    expect(rows.length).toBe(3);
    expect(window.WorkoutSessionsState.logs[0].sets.length).toBe(3);
    expect(window.WorkoutSessionsState.logs[0]._dirty).toBe(true);

    window.removeLocalSet(0, 0);
    rows = container.querySelectorAll('.wg-workouts-session-exercise__set-row');
    expect(rows.length).toBe(2);
    expect(window.WorkoutSessionsState.logs[0].sets.length).toBe(2);
    // Guard: the last remaining row can't be removed (card must stay editable).
    window.removeLocalSet(0, 0);
    window.removeLocalSet(0, 0);
    expect(window.WorkoutSessionsState.logs[0].sets.length).toBe(1);
  });

  it('updateLocalSet captures set_type + rpe and re-derives the flat scalars', () => {
    const { window, document } = env;
    installApiCache(window);
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.logs = [
      { id: 5, exercise_id: 1, exercise_name: 'Bench', sets_completed: 1, reps_completed: 5, weight_kg: 40 }
    ];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));
    window.addLocalSet(0); // now 2 sets

    window.updateLocalSet(0, 0, 'set_type', 'warmup');
    window.updateLocalSet(0, 0, 'weight_kg', '20');
    window.updateLocalSet(0, 0, 'reps', '10');
    window.updateLocalSet(0, 0, 'rpe', '6');
    window.updateLocalSet(0, 1, 'weight_kg', '60');
    window.updateLocalSet(0, 1, 'reps', '8');

    const log = window.WorkoutSessionsState.logs[0];
    expect(log.sets[0].set_type).toBe('warmup');
    expect(log.sets[0].rpe).toBe(6);
    // Derived flat scalars: len / max(reps) / max(weight).
    expect(log.sets_completed).toBe(2);
    expect(log.reps_completed).toBe(10);
    expect(log.weight_kg).toBe(60);
    // Clearing RPE drops the key entirely (optional field).
    window.updateLocalSet(0, 0, 'rpe', '');
    expect('rpe' in log.sets[0]).toBe(false);

    // Over-max reps/weight are clamped to the input maxes so a single set row
    // can't push the derived scalars past the save validator and abort the
    // whole session save.
    window.updateLocalSet(0, 1, 'reps', '999');
    window.updateLocalSet(0, 1, 'weight_kg', '9000');
    expect(log.sets[1].reps).toBe(100);
    expect(log.sets[1].weight_kg).toBe(500);
  });

  it('saveWorkoutSessionDetails posts the per-set array plus derived scalars for an edited log', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.loadWorkoutHistoryTab = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    window.WorkoutSessionsState.logs = [
      { id: 7, exercise_id: 1, exercise_name: 'Bench', sets_completed: 1, reps_completed: 5, weight_kg: 40, notes: '' }
    ];
    window.renderWorkoutSessionInfo(document.getElementById('workout-session-info'), {
      id: 42, status: 'in_progress', scheduled_date: '2026-04-22', scheduled_time: '09:00', variant_name: 'Push'
    });
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    // Turn set 0 into a warm-up and add a heavier working set with an RPE.
    window.updateLocalSet(0, 0, 'set_type', 'warmup');
    window.updateLocalSet(0, 0, 'weight_kg', '20');
    window.updateLocalSet(0, 0, 'reps', '10');
    window.addLocalSet(0);
    window.updateLocalSet(0, 1, 'weight_kg', '60');
    window.updateLocalSet(0, 1, 'reps', '8');
    window.updateLocalSet(0, 1, 'rpe', '9');

    let updatePayload = null;
    window.apiCall = vi.fn(async (endpoint, method, payload) => {
      if (endpoint === '/api/workout/sessions/logs/update') { updatePayload = payload; return { ok: true }; }
      return [];
    });

    await window.saveWorkoutSessionDetails();

    expect(updatePayload).not.toBeNull();
    expect(Array.isArray(updatePayload.sets)).toBe(true);
    expect(updatePayload.sets.length).toBe(2);
    expect(updatePayload.sets[0].set_type).toBe('warmup');
    expect(updatePayload.sets[1].rpe).toBe(9);
    // Derived flat scalars ride alongside for bot compat.
    expect(updatePayload.sets_completed).toBe(2);
    expect(updatePayload.reps_completed).toBe(10);
    expect(updatePayload.weight_kg).toBe(60);
  });

  it('does not persist a fabricated sets array when saving an untouched flat-only log', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.loadWorkoutHistoryTab = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    // Pre-Phase-1 / bot-created log: flat scalars only, no sets.
    window.WorkoutSessionsState.logs = [
      { id: 7, exercise_id: 1, exercise_name: 'Bench', sets_completed: 3, reps_completed: 8, weight_kg: 60, notes: '' }
    ];
    window.renderWorkoutSessionInfo(document.getElementById('workout-session-info'), {
      id: 42, status: 'in_progress', scheduled_date: '2026-04-22', scheduled_time: '09:00', variant_name: 'Push'
    });
    // Render materializes log.sets via _ensureLogSets — but the user never edits.
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    let updatePayload = null;
    window.apiCall = vi.fn(async (endpoint, method, payload) => {
      if (endpoint === '/api/workout/sessions/logs/update') { updatePayload = payload; return { ok: true }; }
      return [];
    });

    await window.saveWorkoutSessionDetails();

    // Flat scalars still saved, but no fabricated per-set array is written — the
    // cloud domain preserves any real stored sets when the key is absent.
    expect(updatePayload).not.toBeNull();
    expect('sets' in updatePayload).toBe(false);
    expect(updatePayload.sets_completed).toBe(3);
  });

  it('does not fabricate a sets array on a notes-only edit of a flat-only log', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.loadWorkoutHistoryTab = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    // Pre-Phase-1 / bot-created log: flat scalars only, no sets.
    window.WorkoutSessionsState.logs = [
      { id: 7, exercise_id: 1, exercise_name: 'Bench', sets_completed: 3, reps_completed: 8, weight_kg: 60, notes: '' }
    ];
    window.renderWorkoutSessionInfo(document.getElementById('workout-session-info'), {
      id: 42, status: 'in_progress', scheduled_date: '2026-04-22', scheduled_time: '09:00', variant_name: 'Push'
    });
    // Render materializes log.sets via _ensureLogSets; the user edits ONLY notes.
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));
    window.updateLocalLog(0, 'notes', 'felt heavy today');

    let updatePayload = null;
    window.apiCall = vi.fn(async (endpoint, method, payload) => {
      if (endpoint === '/api/workout/sessions/logs/update') { updatePayload = payload; return { ok: true }; }
      return [];
    });

    await window.saveWorkoutSessionDetails();

    // Notes save via the flat fields, but the fabricated per-set array must NOT
    // ride along — a notes edit flips _dirty but not _setsDirty, so the cloud
    // domain keeps any real stored sets instead of overwriting with N clones.
    expect(updatePayload).not.toBeNull();
    expect(updatePayload.notes).toBe('felt heavy today');
    expect('sets' in updatePayload).toBe(false);
    expect(updatePayload.sets_completed).toBe(3);
  });

  it('saveNewSessionExercise posts a per-set array derived from the quick-add fields', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.showWorkoutSessionModal = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.logs = [];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    document.getElementById('session-add-exercise-name').value = 'Squat';
    document.getElementById('session-add-exercise-id').value = '99';
    document.getElementById('session-add-exercise-sets').value = '3';
    document.getElementById('session-add-exercise-reps').value = '5';
    document.getElementById('session-add-exercise-weight').value = '100';

    let createdPayload = null;
    window.apiCall = vi.fn(async (endpoint, method, payload) => {
      if (endpoint === '/api/workout/sessions/logs/create') { createdPayload = payload; return { id: 999 }; }
      if (endpoint.startsWith('/api/workout/sessions/details')) {
        return { session: { id: 42, status: 'in_progress' }, logs: [] };
      }
      return [];
    });

    await window.saveNewSessionExercise();

    expect(createdPayload).not.toBeNull();
    expect(Array.isArray(createdPayload.sets)).toBe(true);
    expect(createdPayload.sets.length).toBe(3);
    expect(createdPayload.sets.every((s) => s.reps === 5 && s.weight_kg === 100 && s.set_type === 'normal')).toBe(true);
    // Flat scalars retained for bot compat.
    expect(createdPayload.target_sets).toBe(3);
  });
});

// ===========================================================================
// Workout start modal extraction (Plan 2026-06-10 finish-app-js-split, Task 4)
//
// showWorkoutStartModal / closeWorkoutStartModal / startWorkoutFromModal /
// snoozeWorkout / skipWorkout / skipWorkoutFromModal moved from app.js into
// features/workout/modals.js. These tests pin the extracted module's public
// surface and the success-path side effects (commit + invalidate + alert +
// loadWorkouts + modal close) that the optimistic-stage tests above stop
// short of asserting.
// ===========================================================================
describe('features/workout/modals.js — workout start modal flow', () => {
  let env;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    env = loadFrontendEnv({ withWorkout: true });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
    env.cleanup();
    env = null;
  });

  it('exposes the WorkoutModals public-API namespace', () => {
    const { window } = env;
    expect(window.WorkoutModals).toBeTypeOf('object');
    expect(window.WorkoutModals.show).toBe(window.showWorkoutStartModal);
    expect(window.WorkoutModals.close).toBe(window.closeWorkoutStartModal);
    expect(window.WorkoutModals.start).toBe(window.startWorkoutFromModal);
    expect(window.WorkoutModals.snooze).toBe(window.snoozeWorkout);
    expect(window.WorkoutModals.skip).toBe(window.skipWorkout);
    expect(window.WorkoutModals.skipFromModal).toBe(window.skipWorkoutFromModal);
  });

  it('showWorkoutStartModal stores the session on PushModalState and opens the modal', () => {
    const { window, document } = env;
    window.showWorkoutStartModal(77);
    expect(window.PushModalState.getWorkoutSessionId()).toBe(77);
    expect(document.getElementById('workout-start-modal').classList.contains('hidden')).toBe(false);
  });

  it('startWorkoutFromModal closes the modal and switches to the workouts tab', () => {
    const { window, document } = env;
    window.switchTab = vi.fn();
    window.showWorkoutStartModal(77);
    window.startWorkoutFromModal();
    expect(window.switchTab).toHaveBeenCalledWith('workouts');
    expect(document.getElementById('workout-start-modal').classList.contains('hidden')).toBe(true);
  });

  it('snoozeWorkout posts to the snooze endpoint, commits, invalidates, alerts and closes', async () => {
    const { window, document } = env;
    installApiCache(window, { workout_next: { session: { id: 80, status: 'pending' } } });
    window.PushModalState.openWorkoutStart({ sessionId: 80 });
    window.safeAlert = vi.fn();
    window.apiCall = vi.fn().mockResolvedValue({ ok: true });
    const invalidateSpy = vi.spyOn(window.DataStore, 'invalidateTags').mockResolvedValue(undefined);

    window.ModalManager.workoutStart.open();
    await window.snoozeWorkout(60);

    expect(window.apiCall).toHaveBeenCalledWith('/api/workout/sessions/80/snooze', 'POST', { minutes: 60 });
    expect(window.safeAlert).toHaveBeenCalledWith('Snoozed for 60 minutes');
    expect(invalidateSpy).toHaveBeenCalledWith(['workout']);
    expect(document.getElementById('workout-start-modal').classList.contains('hidden')).toBe(true);
  });

  it('snoozeWorkout is a no-op when no session is pending', async () => {
    const { window } = env;
    window.PushModalState.openWorkoutStart({ sessionId: null });
    window.apiCall = vi.fn().mockResolvedValue({ ok: true });
    await window.snoozeWorkout(60);
    expect(window.apiCall).not.toHaveBeenCalled();
  });

  it('snoozeWorkout rolls back the optimistic stamp on POST failure', async () => {
    const { window } = env;
    const cache = installApiCache(window, { workout_next: { session: { id: 80, status: 'pending' } } });
    window.PushModalState.openWorkoutStart({ sessionId: 80 });
    window.safeAlert = vi.fn();
    window.apiCall = vi.fn().mockResolvedValue(null);

    await window.snoozeWorkout(60);

    expect(window.safeAlert).not.toHaveBeenCalled();
    const cached = cache.get('workout_next');
    if (cached) {
      expect(cached.session.is_snoozed).toBeFalsy();
      expect(cached.session.snoozed_until).toBeFalsy();
    }
  });

  it('skipWorkout posts to the skip endpoint, commits, alerts, reloads and closes', async () => {
    const { window, document } = env;
    installApiCache(window, { workout_next: { session: { id: 90, status: 'pending' } } });
    window.PushModalState.openWorkoutStart({ sessionId: 90 });
    window.safeAlert = vi.fn();
    window.loadWorkouts = vi.fn();
    window.safeConfirm = (_msg, cb) => Promise.resolve(cb(true));
    window.apiCall = vi.fn().mockResolvedValue({ ok: true });

    window.ModalManager.workoutStart.open();
    await window.skipWorkoutFromModal();

    expect(window.apiCall).toHaveBeenCalledWith('/api/workout/sessions/90/skip', 'POST');
    expect(window.safeAlert).toHaveBeenCalledWith('Workout skipped');
    expect(window.loadWorkouts).toHaveBeenCalled();
    expect(document.getElementById('workout-start-modal').classList.contains('hidden')).toBe(true);
  });

  it('skipWorkout does not call the API when the confirm is declined', async () => {
    const { window } = env;
    installApiCache(window, { workout_next: { session: { id: 90, status: 'pending' } } });
    window.PushModalState.openWorkoutStart({ sessionId: 90 });
    window.loadWorkouts = vi.fn();
    window.safeConfirm = (_msg, cb) => Promise.resolve(cb(false));
    window.apiCall = vi.fn().mockResolvedValue({ ok: true });

    await window.skipWorkout();

    expect(window.apiCall).not.toHaveBeenCalled();
    expect(window.loadWorkouts).not.toHaveBeenCalled();
  });

  it('skipWorkout rolls back workout_next on POST failure', async () => {
    const { window } = env;
    const cache = installApiCache(window, { workout_next: { session: { id: 90, status: 'pending' } } });
    window.PushModalState.openWorkoutStart({ sessionId: 90 });
    window.safeAlert = vi.fn();
    window.loadWorkouts = vi.fn();
    window.safeConfirm = (_msg, cb) => Promise.resolve(cb(true));
    window.apiCall = vi.fn().mockResolvedValue(null);

    await window.skipWorkout();

    expect(window.safeAlert).not.toHaveBeenCalled();
    expect(window.loadWorkouts).not.toHaveBeenCalled();
    const cached = cache.get('workout_next');
    if (cached) {
      expect(cached.session.id).toBe(90);
      expect(cached.session.status).toBe('pending');
    }
  });
});
