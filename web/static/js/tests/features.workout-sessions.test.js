// Focused integration tests for the extracted features/workout/sessions.js
// sub-file. Covers the WorkoutSessions public-API surface and the
// closure-private session state exposed via window.WorkoutSessionsState.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';
import {
  achievableLoads, loadingFor, nearestLoads, equipmentForExercise, pickNearestLoad,
} from '../../../../web/domain/equipment.js';
import * as WeightSanity from '../../../../web/domain/weight-sanity.js';

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
    // bd med-ci6: no `delete` — the modal's Delete button is gone; deleting a
    // session is the History row's trash icon.
    expect(window.WorkoutSessions.delete).toBeUndefined();
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

    const handlerDone = window.saveNewSessionExercise({ id: 99, name: 'Squat', default_reps_min: 5, default_weight_kg: 100 });
    // Allow applyOptimistic's await chain (getCached → setCachedWithTags) to
    // settle without resolving the POST.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const logsBeforeResolve = window.WorkoutSessionsState.logs;
    expect(logsBeforeResolve.length).toBe(2);
    expect(logsBeforeResolve[1].exercise_name).toBe('Squat');
    expect(logsBeforeResolve[1]._optimistic).toBe(true);
    // The takeover jumps to the exercise just added (one exercise on screen).
    const cards = document.getElementById('workout-session-logs')
      .querySelectorAll('.wg-workouts-session-exercise');
    expect(cards.length).toBe(1);
    expect(cards[0].querySelector('.wg-ex__name').textContent).toBe('Squat');
    expect(document.querySelectorAll('#workout-session-prog .wg-session-prog__seg').length).toBe(2);

    pending.resolve({ id: 999 });
    await handlerDone;
  });

  it('saveNewSessionExercise clamps an oversized library default to the reps/weight ceilings', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.showWorkoutSessionModal = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.logs = [];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));
    let createdPayload = null;
    window.apiCall = vi.fn(async (endpoint, method, payload) => {
      if (endpoint === '/api/workout/sessions/logs/create') { createdPayload = payload; return { id: 999 }; }
      return [];
    });

    await window.saveNewSessionExercise({ id: 99, name: 'Squat', default_reps_min: 250, default_weight_kg: 900 });

    expect(createdPayload).toEqual(expect.objectContaining({ target_sets: 0, target_reps_min: 100, target_weight_kg: 500 }));
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

    await window.saveNewSessionExercise({ name: 'Zercher Squat' }); // brand-new: no library id

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

    await window.saveNewSessionExercise({ name: 'Zercher Squat' });

    // Logged against the raced-in row instead of refusing with "Failed to add".
    expect(createdLogPayload).not.toBeNull();
    expect(createdLogPayload.exercise_id).toBe(777);
  });

  // med-3q8.1 / med-max — the session picker used to dump the user's whole
  // library plus all 1324 catalog names into a native <datalist>, so the popup
  // covered half the phone screen and buried the keyboard. It is now our own
  // inline list under the field.
  // med-okwf.3 (kit WA3/WA3b): the sheet is search + kit rows; a tap adds.
  describe('session add-exercise picker (med-3q8.1, med-max, med-okwf.3)', () => {
    function stubSessionPicker(window) {
      window.fetch = vi.fn(async (url) => (
        String(url).includes('exercises-catalog.json')
          ? {
              ok: true,
              status: 200,
              json: async () => ({ exercises: [
                { name: 'Barbell bench press', body_part: 'chest' }, { name: '3/4 sit-up' }, { name: 'Face pull, band', body_part: 'shoulders' }
              ] })
            }
          : { ok: true, status: 200, json: async () => ({}) }
      ));
      window.apiCall = vi.fn(async (endpoint, method, payload) => {
        if (endpoint === '/api/workout/exercise-library') {
          return [
            { id: 11, name: 'Overhead Press', default_sets: 3, default_reps_min: 8, default_weight_kg: 35 },
            { id: 12, name: 'Face pull', default_reps_min: 12 }
          ];
        }
        // Face pull was logged in an earlier session; Overhead Press never.
        if (endpoint.startsWith('/api/workout/exercises/history?name=Face%20pull&')) {
          return [{ session_id: 5, date: '2026-01-01', sets: [
            { reps: 15, weight_kg: 18 }, { reps: 15, weight_kg: 20 }, { reps: 12, weight_kg: 20 }
          ] }];
        }
        if (endpoint === '/api/workout/exercise-library/create') return { id: 555, name: payload.name };
        if (endpoint === '/api/workout/sessions/logs/create') return { id: 999 };
        return [];
      });
      window.showWorkoutSessionModal = vi.fn();
      window.WorkoutSessionsState.data = { id: 77, status: 'in_progress', logs: [] };
    }

    function rowsOf(mount) {
      return Array.from(mount.querySelectorAll('.wg-row')).map((b) => [
        b.querySelector('.wg-row__title').textContent, b.querySelector('.wg-row__meta').textContent
      ]);
    }

    async function type(window, value) {
      const input = window.document.getElementById('session-add-exercise-name');
      input.value = value;
      await input.oninput();
      // Let the async "last …" meta lines land.
      await new Promise((r) => setTimeout(r, 0));
    }

    function createCall(window) {
      return window.apiCall.mock.calls.find((c) => c[0] === '/api/workout/sessions/logs/create');
    }

    // med-xso6.31: closing the session with Add-exercise open left the
    // sub-modal floating, overlay-less, over the next tab.
    const isHidden = (document, id) => document.getElementById(id).classList.contains('hidden');

    it('closing the session (×) with Add exercise open hides the sub-modal and the overlay', async () => {
      const { window, document } = env;
      stubSessionPicker(window);
      window.ModalManager.workoutSession.open();
      await window.showAddExerciseToSessionModal();
      expect(isHidden(document, 'workout-add-exercise-to-session-modal')).toBe(false);

      // The header × is bound to closeWorkoutSessionModal (workout/index.js).
      await window.closeWorkoutSessionModal();

      expect(window.WorkoutSessionsState.data).toBeNull();
      expect(isHidden(document, 'workout-add-exercise-to-session-modal')).toBe(true);
      expect(isHidden(document, 'workout-session-modal')).toBe(true);
      expect(isHidden(document, 'modal-overlay')).toBe(true);
    });

    it('Finish with Add exercise open hides the sub-modal and the overlay', async () => {
      const { window, document } = env;
      installApiCache(window);
      stubSessionPicker(window);
      window.loadWorkoutHistoryTab = vi.fn();
      window.WorkoutSessionsState.originalStatus = 'in_progress';
      window.WorkoutSessionsState.logs = [];
      window.ModalManager.workoutSession.open();
      await window.showAddExerciseToSessionModal();
      const pickerApi = window.apiCall;
      window.apiCall = vi.fn(async (endpoint, ...rest) => (
        endpoint.startsWith('/api/workout/sessions/status') ? { ok: true } : pickerApi(endpoint, ...rest)
      ));

      const finishing = window.finishWorkoutSession();
      await vi.waitFor(() => expect(document.querySelector('.mt-confirm-modal__confirm')).not.toBeNull());
      document.querySelector('.mt-confirm-modal__confirm').click();
      await finishing;

      await vi.waitFor(() => expect(window.WorkoutSessionsState.data).toBeNull());
      expect(isHidden(document, 'workout-add-exercise-to-session-modal')).toBe(true);
      expect(isHidden(document, 'modal-overlay')).toBe(true);
    });

    it('never opens the sub-modal when the session closes while the picker is loading', async () => {
      const { window, document } = env;
      stubSessionPicker(window);
      const picker = deferred();
      window.WorkoutLibrary.bindExerciseAddList = vi.fn(() => picker.promise);
      window.ModalManager.workoutSession.open();

      const opening = window.showAddExerciseToSessionModal();
      await window.closeWorkoutSessionModal();
      picker.resolve();
      await opening;

      expect(isHidden(document, 'workout-add-exercise-to-session-modal')).toBe(true);
      expect(isHidden(document, 'modal-overlay')).toBe(true);
    });

    it('opens with NO suggestion list at all while the name field is empty', async () => {
      const { window, document } = env;
      stubSessionPicker(window);

      await window.showAddExerciseToSessionModal();

      // The exact screenshot case in med-max: empty field, "Start typing..."
      // placeholder, and nothing covering the keyboard.
      expect(document.getElementById('session-add-exercise-name').value).toBe('');
      expect(document.getElementById('session-add-exercise-suggest').hidden).toBe(true);
    });

    // Kit WA3 (med-okwf.4): at rest the sheet shows the ranked "Up next" rows
    // after the current exercise; typing replaces them with matches.
    it('at rest lists up to three "Up next" rows after the current exercise, never one in the session', async () => {
      const { window, document } = env;
      stubSessionPicker(window);
      const base = window.apiCall;
      window.apiCall = vi.fn(async (endpoint, ...rest) => (
        endpoint.startsWith('/api/workout/sessions/suggest-next?')
          ? [{ id: 12, name: 'Face pull', default_reps_min: 12 }, { name: 'bench' }, { id: 11, name: 'Overhead Press', body_part: 'shoulders' }]
          : base(endpoint, ...rest)
      ));
      window.WorkoutSessionsState.logs = [
        { id: 5, exercise_id: 1, exercise_name: 'Bench', status: 'completed', sets_completed: 3, reps_completed: 8, weight_kg: 60 }
      ];
      await window.showAddExerciseToSessionModal();
      const mount = document.getElementById('session-add-exercise-suggest');
      await vi.waitFor(() => expect(rowsOf(mount)).toEqual([
        ['Face pull', 'last 3 × 15 · 20 kg'],
        ['Overhead Press', 'Library · Shoulders'],
      ]));
      expect(mount.hidden).toBe(false);
      expect(mount.querySelector('.wg-section__head .wg-eyebrow').textContent).toBe('Up next');
      expect(window.apiCall.mock.calls.some((c) => c[0] === '/api/workout/sessions/suggest-next?session_id=77&after=Bench')).toBe(true);

      await type(window, 'face pu');
      expect(mount.querySelector('.wg-section__head .wg-eyebrow').textContent).toBe('Matches');
      await type(window, '');
      expect(mount.querySelector('.wg-section__head .wg-eyebrow').textContent).toBe('Up next');
    });

    // Argus on #1463: a library log keeps its old name after a rename; the
    // renamed library row must not be offered (same (session, id, library)).
    it('never offers a library row the session already logged under an older name', async () => {
      const { window, document } = env;
      stubSessionPicker(window);
      window.WorkoutSessionsState.logs = [
        { id: 5, exercise_id: 11, exercise_name: 'Old press', source: 'library', status: '', sets_completed: 0 }
      ];
      await window.showAddExerciseToSessionModal();
      const mount = document.getElementById('session-add-exercise-suggest');
      await type(window, 'o');
      // Overhead Press is library id 11: gone; only the typed add row is left.
      expect(rowsOf(mount)).toEqual([['Add “o”', 'New exercise']]);
      // Its full current name offers nothing at all — no add row that would
      // resolve back to id 11 — so no tap can post a duplicate create.
      await type(window, 'Overhead Press');
      expect(rowsOf(mount)).toEqual([]);
      expect(mount.hidden).toBe(true);
      expect(createCall(window)).toBeUndefined();
    });

    it('offers no row at all while the library read is pending, even when the catalog is fast', async () => {
      const { window, document } = env;
      stubSessionPicker(window);
      window.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ exercises: [{ name: 'Overhead Press' }] }) }));
      const base = window.apiCall;
      const lib = deferred();
      window.apiCall = vi.fn((endpoint, ...rest) => (
        endpoint === '/api/workout/exercise-library' ? lib.promise.then(() => base(endpoint, ...rest)) : base(endpoint, ...rest)
      ));
      window.WorkoutSessionsState.logs = [
        { id: 5, exercise_id: 11, exercise_name: 'Old press', source: 'library', status: '', sets_completed: 0 }
      ];
      const opening = window.showAddExerciseToSessionModal();
      const mount = document.getElementById('session-add-exercise-suggest');
      await type(window, 'Overhead Press');
      await new Promise((r) => setTimeout(r, 10));
      expect(rowsOf(mount)).toEqual([]);
      lib.resolve();
      await opening;
      await new Promise((r) => setTimeout(r, 10));
      expect(rowsOf(mount)).toEqual([]);
      expect(createCall(window)).toBeUndefined();
    });

    it('typing lists own rows (last numbers), then library rows, then an add row (kit WA3b)', async () => {
      const { window, document } = env;
      stubSessionPicker(window);
      await window.showAddExerciseToSessionModal();
      const mount = document.getElementById('session-add-exercise-suggest');

      // One character: the library half only — the catalog stays gated at 2.
      await type(window, 'o');
      expect(rowsOf(mount)).toEqual([['Overhead Press', 'Library'], ['Add “o”', 'New exercise']]);

      await type(window, 'face pu');
      expect(mount.querySelector('.wg-section__head .wg-eyebrow').textContent).toBe('Matches');
      expect(rowsOf(mount)).toEqual([
        ['Face pull', 'last 3 × 15 · 20 kg'],
        ['Face pull, band', 'Library · Shoulders'],
        ['Add “face pu”', 'New exercise'],
      ]);

      // A typed name already in the list gets no add row.
      await type(window, 'overhead press');
      expect(rowsOf(mount)).toEqual([['Overhead Press', 'Library']]);
    });

    it('tapping a library row adds it at once: one pending set labelled "default", sheet closed', async () => {
      const { window, document } = env;
      installApiCache(window);
      stubSessionPicker(window);
      window.WorkoutSessionsState.logs = [
        { id: 5, exercise_id: 1, exercise_name: 'Bench', status: 'completed', sets_completed: 3, reps_completed: 8, weight_kg: 60 }
      ];
      window.ModalManager.workoutSession.open();
      await window.showAddExerciseToSessionModal();
      await type(window, 'over');
      document.querySelector('#session-add-exercise-suggest .wg-row').click();

      await vi.waitFor(() => expect(window.showWorkoutSessionModal).toHaveBeenCalledWith(77));
      expect(createCall(window)[2]).toEqual(expect.objectContaining({
        exercise_id: 11, exercise_name: 'Overhead Press', target_sets: 0, target_reps_min: 8, target_weight_kg: 35, status: ''
      }));
      expect(window.apiCall.mock.calls.some((c) => c[0] === '/api/workout/exercise-library/create')).toBe(false);
      expect(isHidden(document, 'workout-add-exercise-to-session-modal')).toBe(true);

      // The takeover jumped to it: last, current, one pending set, not done.
      expect(window.WorkoutSessionsState.ui.current).toBe(1);
      const card = document.getElementById('workout-session-logs');
      expect(card.querySelector('.wg-ex__name').textContent).toBe('Overhead Press');
      const rows = card.querySelectorAll('.wg-set');
      expect(rows.length).toBe(1);
      expect(rows[0].classList.contains('wg-set--done')).toBe(false);
      const w = rows[0].querySelector('[data-field="weight_kg"]');
      expect(w.classList.contains('wg-set__cell--ghost')).toBe(true);
      expect(w.textContent).toBe('35default');
      expect(rows[0].querySelector('[data-field="reps"]').textContent).toBe('8default');
    });

    // Argus on #1460: the post-add reload put persisted logs ahead of the
    // plan's untouched rows, so the added exercise jumped to the front.
    it('in a planned session the added exercise stays last and current through the real reload', async () => {
      const { window, document } = env;
      installApiCache(window);
      window.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ exercises: [] }) }));
      const persisted = [];
      window.apiCall = vi.fn(async (endpoint, method, payload) => {
        if (endpoint.startsWith('/api/workout/sessions/details')) {
          return {
            session: { id: 77, variant_id: 3, status: 'in_progress', exercise_snapshot: [
              { exercise_id: 1, exercise_name: 'Bench', target_sets: 3, target_reps_min: 8, target_weight_kg: 60 },
              { exercise_id: 2, exercise_name: 'Squat', target_sets: 3, target_reps_min: 5, target_weight_kg: 100 },
            ] },
            group_name: 'Plan 3',
            variant_name: 'Day A',
            logs: persisted.map((l) => ({ ...l })),
          };
        }
        if (endpoint === '/api/workout/exercise-library') return [{ id: 12, name: 'Face pull', default_reps_min: 12 }];
        if (endpoint === '/api/workout/sessions/logs/create') {
          const log = { ...payload, id: 999, sets: [], sets_completed: 0, reps_completed: payload.target_reps_min, weight_kg: 0 };
          persisted.push(log);
          return log;
        }
        return [];
      });

      await window.showWorkoutSessionModal(77);
      expect(window.WorkoutSessionsState.logs.map((l) => l.exercise_name)).toEqual(['Bench', 'Squat']);
      // An untouched planned exercise keeps its plan target line (kit W1).
      const mono = () => document.querySelector('#workout-session-logs .wg-workouts-session-exercise__mono');
      expect(mono().hidden).toBe(false);
      expect(mono().textContent).toBe('3 × 8 · 60 kg');
      await window.showAddExerciseToSessionModal();
      expect(document.getElementById('workout-add-exercise-to-session-eyebrow').textContent).toBe('Plan 3 · Day A');
      await type(window, 'face');
      document.querySelector('#session-add-exercise-suggest .wg-row').click();

      await vi.waitFor(() => expect(window.WorkoutSessionsState.logs.find((l) => l.id === 999)).toBeTruthy());
      expect(window.WorkoutSessionsState.logs.map((l) => l.exercise_name)).toEqual(['Bench', 'Squat', 'Face pull']);
      expect(window.WorkoutSessionsState.ui.current).toBe(2);
      expect(document.querySelector('#workout-session-logs .wg-ex__name').textContent).toBe('Face pull');
      // Nothing logged yet: no "0 × 0 · bodyweight" target line (Iris).
      expect(document.querySelector('#workout-session-logs .wg-workouts-session-exercise__mono').hidden).toBe(true);

      // Then the plan's rows get logged (higher log ids than the add, and the
      // details read sorts by id) and the session reopens: still plan, then add.
      persisted.push(
        { id: 1000, exercise_id: 1, exercise_name: 'Bench', source: 'schedule', status: 'completed', sets_completed: 1, reps_completed: 8, weight_kg: 60, sets: [{ set_index: 0, reps: 8, weight_kg: 60 }] },
        { id: 1001, exercise_id: 2, exercise_name: 'Squat', source: 'schedule', status: 'completed', sets_completed: 1, reps_completed: 5, weight_kg: 100, sets: [{ set_index: 0, reps: 5, weight_kg: 100 }] },
      );
      await window.showWorkoutSessionModal(77);
      expect(window.WorkoutSessionsState.logs.map((l) => l.exercise_name)).toEqual(['Bench', 'Squat', 'Face pull']);
    });

    it('a row logged before lands with last time\'s set as the ghost, labelled "last"', async () => {
      const { window, document } = env;
      installApiCache(window);
      stubSessionPicker(window);
      await window.showAddExerciseToSessionModal();
      await type(window, 'face pull');
      document.querySelector('#session-add-exercise-suggest .wg-row').click();

      await vi.waitFor(() => expect(createCall(window)).toBeTruthy());
      expect(createCall(window)[2]).toEqual(expect.objectContaining({ exercise_id: 12, target_reps_min: 12, target_weight_kg: null }));
      const cells = () => document.querySelectorAll('#workout-session-logs .wg-set [data-field]');
      await vi.waitFor(() => expect(Array.from(cells()).map((c) => c.textContent)).toEqual(['18last', '15last']));
    });

    it('a catalog-only row resolves by name and lands with empty cells', async () => {
      const { window, document } = env;
      installApiCache(window);
      stubSessionPicker(window);
      await window.showAddExerciseToSessionModal();
      await type(window, 'bench');
      expect(rowsOf(document.getElementById('session-add-exercise-suggest'))[0])
        .toEqual(['Barbell bench press', 'Library · Chest']);
      document.querySelector('#session-add-exercise-suggest .wg-row').click();

      await vi.waitFor(() => expect(createCall(window)).toBeTruthy());
      expect(window.apiCall).toHaveBeenCalledWith('/api/workout/exercise-library/create', 'POST',
        expect.objectContaining({ name: 'Barbell bench press', default_reps_min: 0, default_weight_kg: null }));
      expect(createCall(window)[2]).toEqual(expect.objectContaining({ exercise_id: 555, target_reps_min: 0, target_weight_kg: null }));
      const cells = document.querySelectorAll('#workout-session-logs .wg-set [data-field]');
      expect(Array.from(cells).map((c) => c.textContent)).toEqual(['—', '—']);
    });

    it('the add row logs the typed name as a new exercise', async () => {
      const { window, document } = env;
      installApiCache(window);
      stubSessionPicker(window);
      await window.showAddExerciseToSessionModal();
      await type(window, 'Zercher squat');
      const rows = document.querySelectorAll('#session-add-exercise-suggest .wg-row');
      rows[rows.length - 1].click();

      await vi.waitFor(() => expect(createCall(window)).toBeTruthy());
      expect(createCall(window)[2]).toEqual(expect.objectContaining({ exercise_id: 555, exercise_name: 'Zercher squat' }));
    });

    it('never offers an exercise already in the session', async () => {
      const { window, document } = env;
      stubSessionPicker(window);
      window.WorkoutSessionsState.logs = [
        { id: 5, exercise_id: 11, exercise_name: 'Overhead Press', status: '', sets_completed: 0 }
      ];
      await window.showAddExerciseToSessionModal();
      const mount = document.getElementById('session-add-exercise-suggest');

      await type(window, 'overhead press');
      expect(rowsOf(mount)).toEqual([]);
      expect(mount.hidden).toBe(true);
    });

    // The owner's library holds hand-cased variants of catalog names ("Barbell
    // rows" vs "barbell rows"). With only 6 rows, burning two on the same
    // exercise is a real defect.
    it('dedupes a library name against its lowercase catalog twin, library winning', async () => {
      const { window, document } = env;
      window.fetch = vi.fn(async (url) => (
        String(url).includes('exercises-catalog.json')
          ? { ok: true, status: 200, json: async () => ({ exercises: [{ name: 'barbell rows' }] }) }
          : { ok: true, status: 200, json: async () => ({}) }
      ));
      window.apiCall = vi.fn(async (endpoint) => (
        endpoint === '/api/workout/exercise-library'
          ? [{ id: 12, name: 'Barbell rows', default_sets: 4, default_reps_min: 10, default_weight_kg: 50 }]
          : []
      ));
      window.WorkoutSessionsState.data = { id: 77, status: 'in_progress', logs: [] };
      await window.showAddExerciseToSessionModal();

      const mount = document.getElementById('session-add-exercise-suggest');
      await type(window, 'barbell ro');

      // One row, in the user's own casing (plus the add row for the typed text).
      expect(rowsOf(mount).map((r) => r[0])).toEqual(['Barbell rows', 'Add “barbell ro”']);
    });
  });

  it('saveNewSessionExercise rolls back the optimistic log when the POST returns null', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.logs = [
      { id: 5, exercise_id: 1, exercise_name: 'Bench', sets_completed: 3, reps_completed: 8, weight_kg: 60 }
    ];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint === '/api/workout/sessions/logs/create') return null;
      return [];
    });

    await window.saveNewSessionExercise({ id: 99, name: 'Squat', default_reps_min: 5, default_weight_kg: 100 });

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

  // bd med-plg: on a plan-backed session the local splice is not enough — the
  // modal re-materializes the plan on every open, so the removal also has to be
  // recorded on the session snapshot.
  function planBackedDeleteEnv(window, document) {
    installApiCache(window);
    window.safeConfirm = (_msg, cb) => Promise.resolve(cb(true));
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress', variant_id: 7 };
    window.WorkoutSessionsState.logs = [
      // Un-logged planned row: synthesized by the prefill, id 0, no backend log.
      { id: 0, exercise_id: 1, exercise_name: 'Bench', sets_completed: 3, reps_completed: 8, weight_kg: 60, _dirty: false },
      { id: 6, exercise_id: 2, exercise_name: 'Overhead', sets_completed: 3, reps_completed: 10, weight_kg: 40 }
    ];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));
  }

  it('deleteExerciseLog persists the removal of an un-logged planned row on a plan-backed session', async () => {
    const { window, document } = env;
    planBackedDeleteEnv(window, document);

    const calls = [];
    window.apiCall = vi.fn(async (endpoint, method, body) => {
      calls.push({ endpoint, method, body });
      return true;
    });

    await window.deleteExerciseLog(0);

    // No log to delete (id 0) — only the session-scoped plan removal.
    expect(calls.filter((c) => c.endpoint.startsWith('/api/workout/sessions/logs/delete'))).toHaveLength(0);
    const removal = calls.find((c) => c.endpoint === '/api/workout/sessions/planned-exercise/delete');
    expect(removal).toBeTruthy();
    expect(removal.method).toBe('POST');
    expect(removal.body).toEqual({ session_id: 42, exercise_id: 1, exercise_name: 'Bench' });
    expect(window.WorkoutSessionsState.logs.map((l) => l.exercise_name)).toEqual(['Overhead']);
  });

  it('deleteExerciseLog deletes both the log and the plan row for a saved plan-backed exercise', async () => {
    const { window, document } = env;
    planBackedDeleteEnv(window, document);

    const calls = [];
    window.apiCall = vi.fn(async (endpoint, method, body) => {
      calls.push({ endpoint, method, body });
      return true;
    });

    await window.deleteExerciseLog(1);

    expect(calls.some((c) => c.endpoint === '/api/workout/sessions/logs/delete?id=6')).toBe(true);
    const removal = calls.find((c) => c.endpoint === '/api/workout/sessions/planned-exercise/delete');
    expect(removal.body).toEqual({ session_id: 42, exercise_id: 2, exercise_name: 'Overhead' });
    expect(window.WorkoutSessionsState.logs.map((l) => l.exercise_name)).toEqual(['Bench']);
  });

  // med-okwf.5: only a completed log counts toward exercises_completed.
  it('deleteExerciseLog decrements exercises_completed only for a completed log', async () => {
    const { window, document } = env;
    const cache = installApiCache(window, {
      workout_history: {
        sessions: [{ session: { id: 42, status: 'in_progress' }, exercises_count: 2, exercises_completed: 1 }],
        miband: []
      }
    });
    window.safeConfirm = (_msg, cb) => Promise.resolve(cb(true));
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress', variant_id: -1 };
    window.WorkoutSessionsState.logs = [
      { id: 5, exercise_id: 1, exercise_name: 'Bench', status: 'completed', sets_completed: 3, reps_completed: 8, weight_kg: 60 },
      { id: 6, exercise_id: 2, exercise_name: 'Squat', status: '', sets_completed: 0 }
    ];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));
    let atPost = null;
    window.apiCall = vi.fn(async () => {
      atPost = cache.get('workout_history').sessions[0];
      return true;
    });

    await window.deleteExerciseLog(1);
    expect(atPost.exercises_count).toBe(1);
    expect(atPost.exercises_completed).toBe(1);

  });

  it('deleteExerciseLog decrements exercises_completed for a completed log', async () => {
    const { window, document } = env;
    const cache = installApiCache(window, {
      workout_history: {
        sessions: [{ session: { id: 42, status: 'in_progress' }, exercises_count: 2, exercises_completed: 1 }],
        miband: []
      }
    });
    window.safeConfirm = (_msg, cb) => Promise.resolve(cb(true));
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress', variant_id: -1 };
    window.WorkoutSessionsState.logs = [
      { id: 5, exercise_id: 1, exercise_name: 'Bench', status: 'completed', sets_completed: 3, reps_completed: 8, weight_kg: 60 },
      { id: 6, exercise_id: 2, exercise_name: 'Squat', status: '', sets_completed: 0 }
    ];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));
    let atPost = null;
    window.apiCall = vi.fn(async () => {
      atPost = cache.get('workout_history').sessions[0];
      return true;
    });

    await window.deleteExerciseLog(0);
    expect(atPost.exercises_count).toBe(1);
    expect(atPost.exercises_completed).toBe(0);
  });

  it('deleteExerciseLog counts a placeholder promoted by a saved first set (tick, autosave, delete)', async () => {
    const { window, document } = env;
    const cache = installApiCache(window, {
      workout_history: {
        sessions: [{ session: { id: 42, status: 'in_progress' }, exercises_count: 2, exercises_completed: 2 }],
        miband: []
      }
    });
    window.loadWorkoutHistoryTab = vi.fn();
    window.safeConfirm = (_msg, cb) => Promise.resolve(cb(true));
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress', variant_id: -1 };
    window.WorkoutSessionsState.logs = [
      { id: 5, exercise_id: 1, exercise_name: 'Bench', status: 'completed', sets_completed: 3, reps_completed: 8, weight_kg: 60 },
      { id: 6, exercise_id: 2, exercise_name: 'Squat', status: '', sets_completed: 1, reps_completed: 5, weight_kg: 100,
        sets: [{ set_index: 0, weight_kg: 100, reps: 5 }], _dirty: true, _setsDirty: true }
    ];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));
    let atDelete = null;
    window.apiCall = vi.fn(async () => ({ ok: true }));

    await window.saveWorkoutSessionDetails({ fromAutosave: true });
    expect(window.WorkoutSessionsState.logs[1].status).toBe('completed');

    cache.set('workout_history', {
      sessions: [{ session: { id: 42, status: 'in_progress' }, exercises_count: 2, exercises_completed: 2 }],
      miband: []
    });
    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.startsWith('/api/workout/sessions/logs/delete')) {
        atDelete = cache.get('workout_history').sessions[0];
      }
      return { ok: true };
    });

    await window.deleteExerciseLog(1);
    expect(atDelete.exercises_completed).toBe(1);
    expect(atDelete.exercises_count).toBe(1);
  });

  it('deleteExerciseLog restores the un-logged planned row when the plan removal returns null', async () => {
    const { window, document } = env;
    planBackedDeleteEnv(window, document);

    window.apiCall = vi.fn(async (endpoint) => (
      endpoint === '/api/workout/sessions/planned-exercise/delete' ? null : true
    ));

    await window.deleteExerciseLog(0);

    expect(window.WorkoutSessionsState.logs.map((l) => l.exercise_name)).toEqual(['Bench', 'Overhead']);
    expect(document.querySelectorAll('#workout-session-prog .wg-session-prog__seg').length).toBe(2);
  });

  it('deleteExerciseLog on an ad-hoc session still splices locally with no network call', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.safeConfirm = (_msg, cb) => Promise.resolve(cb(true));
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress', variant_id: -1 };
    window.WorkoutSessionsState.logs = [
      { id: 0, exercise_id: 1, exercise_name: 'Bench', sets_completed: 3, reps_completed: 8, weight_kg: 60 }
    ];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    window.apiCall = vi.fn(async () => true);

    await window.deleteExerciseLog(0);

    // No write: the now-empty session only reads its add step's rows (kit WA6).
    expect(window.apiCall.mock.calls.filter((c) => c[1])).toEqual([]);
    expect(window.WorkoutSessionsState.logs).toEqual([]);
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
    expect(calls.some((c) => c.startsWith('/api/workout/exercises?'))).toBe(false);

    const logs = window.WorkoutSessionsState.logs;
    // Bench already logged (matched by name) → only Squat prefilled from snapshot.
    const squat = logs.find((l) => l.exercise_name === 'Squat');
    expect(squat).toBeTruthy();
    // Zero done sets; the plan target becomes the pending (ghost) rows.
    expect(squat.sets_completed).toBe(0);
    expect(squat.sets).toEqual([]);
    expect(squat._targetSets).toBe(3);
    expect(squat._target).toEqual({ reps: 8, weight_kg: 100 });
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
    expect(unlogged._target.reps).toBe(12);
    expect(unlogged._dirty).toBe(false);
  });

  // Regression: editing an un-logged planned row of a completed (snapshotted)
  // session must save. Snapshot rows used to mint exercise_id 0, which
  // logs/create rejects ("SessionID and ExerciseID are required"), bricking the
  // whole save. The row must post the snapshot's real exercise_id.
  it('ticking a set on an un-logged snapshot row saves a logs/create with the real exercise_id', async () => {
    const { window, document } = env;
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
    // The un-logged row is on screen with ghost targets; ticking its first set
    // marks it dirty so it saves.
    document.querySelector('#workout-session-logs .wg-set .wg-set__done').click();
    await window.WorkoutSessions.save();

    expect(createdLogPayload).not.toBeNull();
    expect(createdLogPayload.exercise_id).toBe(2);
    expect(createdLogPayload.target_sets).toBe(1);
    expect(createdLogPayload.sets).toEqual([{ set_index: 0, weight_kg: 100, reps: 8, set_type: 'normal' }]);
  });

  it('an un-logged planned row that was never ticked (or un-ticked again) is not created', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.ModalManager.workoutSession.open = vi.fn();
    window.loadWorkoutHistoryTab = vi.fn();
    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.startsWith('/api/workout/sessions/details')) {
        return {
          session: { id: 42, status: 'completed', variant_id: 7, exercise_snapshot: [
            { exercise_id: 2, exercise_name: 'Squat', target_sets: 3, target_reps_min: 8, target_weight_kg: 100 }
          ] },
          logs: []
        };
      }
      return [];
    });
    await window.WorkoutSessions.open(42);

    document.querySelector('#workout-session-logs .wg-set .wg-set__done').click(); // tick
    document.querySelector('#workout-session-logs .wg-set .wg-set__done').click(); // un-tick
    await window.WorkoutSessions.save({ fromAutosave: true });

    expect(window.apiCall).not.toHaveBeenCalledWith('/api/workout/sessions/logs/create', 'POST', expect.anything(), expect.anything());
    expect(window.WorkoutSessionsState.logs[0]._dirty).toBe(false);
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
    // Finish / the overview's Status row set the status the save persists.
    window.WorkoutSessionsState.targetStatus = 'completed';

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
    // Finish asks first (kit dialog, sun primary).
    await vi.waitFor(() => expect(document.querySelector('.mt-confirm-modal__confirm')).not.toBeNull());
    document.querySelector('.mt-confirm-modal__confirm').click();
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

  // bd med-bp6t: starting a scheduled session opens the session modal for
  // that id with no success alert, and refreshes the next card.
  it('startWorkoutSession opens the session modal with no success alert', async () => {
    const { window } = env;
    installApiCache(window, {
      workout_next: { session: { id: 42, status: 'pending' } }
    });
    window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });
    window.showWorkoutSessionModal = vi.fn();
    window.loadNextWorkout = vi.fn();
    window.safeAlert = vi.fn();
    window.apiCall = vi.fn(async () => true);

    await window.startWorkoutSession(42);

    expect(window.apiCall).toHaveBeenCalledWith('/api/workout/sessions/42/start', 'POST');
    expect(window.showWorkoutSessionModal).toHaveBeenCalledWith(42);
    expect(window.safeAlert).not.toHaveBeenCalled();
    expect(window.loadNextWorkout).toHaveBeenCalled();
  });

  // med-rggu: starting an upcoming session re-keys it onto today's slot, so
  // the modal opens the session the start route names, not the tapped id.
  it('startWorkoutSession on an upcoming session opens the re-keyed running session', async () => {
    const { window } = env;
    installApiCache(window, {
      workout_next: { session: { id: 42, status: 'pending' } }
    });
    window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });
    window.showWorkoutSessionModal = vi.fn();
    window.loadNextWorkout = vi.fn();
    window.apiCall = vi.fn(async () => ({ session_id: 77 }));

    await window.startWorkoutSession(42);

    expect(window.apiCall).toHaveBeenCalledWith('/api/workout/sessions/42/start', 'POST');
    expect(window.showWorkoutSessionModal).toHaveBeenCalledWith(77);
  });

  // bd med-bp6t: a swallowed start failure rolls back workout_next and
  // surfaces a guarded error toast — no modal, no alert, no refresh.
  it('startWorkoutSession rolls back and toasts on POST failure', async () => {
    const { window } = env;
    const cache = installApiCache(window, {
      workout_next: { session: { id: 42, status: 'pending' } }
    });
    window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });
    window.showWorkoutSessionModal = vi.fn();
    window.loadNextWorkout = vi.fn();
    window.safeAlert = vi.fn();
    const toastSpy = vi.fn();
    window.SyncManager = { ...(window.SyncManager || {}), showToast: toastSpy };
    window.apiCall = vi.fn(async () => null);

    await window.startWorkoutSession(42);

    expect(window.showWorkoutSessionModal).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith('Failed to start workout', 'error');
    expect(window.safeAlert).not.toHaveBeenCalled();
    expect(window.loadNextWorkout).not.toHaveBeenCalled();
    const cached = cache.get('workout_next');
    if (cached) {
      expect(cached.session.id).toBe(42);
      expect(cached.session.status).toBe('pending');
    }
  });

  // bd med-bp6t: a throwing start rolls back and toasts the error, and the
  // toast stays silent (not a crash) when SyncManager has no showToast.
  it('startWorkoutSession rolls back and toasts on POST throw, silently without SyncManager', async () => {
    const { window } = env;
    const cache = installApiCache(window, {
      workout_next: { session: { id: 42, status: 'pending' } }
    });
    window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });
    window.showWorkoutSessionModal = vi.fn();
    window.loadNextWorkout = vi.fn();
    window.safeAlert = vi.fn();
    const toastSpy = vi.fn();
    window.SyncManager = { showToast: toastSpy };
    window.apiCall = vi.fn(async () => { throw new Error('boom'); });

    await window.startWorkoutSession(42);

    expect(window.showWorkoutSessionModal).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith('Error starting workout: boom', 'error');
    expect(window.safeAlert).not.toHaveBeenCalled();
    const cached = cache.get('workout_next');
    if (cached) {
      expect(cached.session.id).toBe(42);
      expect(cached.session.status).toBe('pending');
    }

    window.SyncManager = {};
    await window.startWorkoutSession(42);
    expect(toastSpy).toHaveBeenCalledTimes(1);
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

    // Finish / the overview's Status row set the status the save persists.
    window.WorkoutSessionsState.targetStatus = 'completed';

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

    // Finish / the overview's Status row set the status the save persists.
    window.WorkoutSessionsState.targetStatus = 'completed';

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

    // Finish / the overview's Status row set the status the save persists.
    window.WorkoutSessionsState.targetStatus = 'completed';

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

    window.WorkoutSessionsState.targetStatus = 'skipped';

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

  it('autosaves a status change (no modal close)', async () => {
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
    window.WorkoutSessionsState.data = { id: 42, status: 'completed' };
    window.WorkoutSessionsState.originalStatus = 'completed';
    window.WorkoutSessionsState.logs = [];

    const statusCalls = [];
    window.apiCall = vi.fn(async (endpoint, method, payload) => {
      if (endpoint.startsWith('/api/workout/sessions/status')) { statusCalls.push(payload); return { ok: true }; }
      return [];
    });

    // A finished session's overview Status row.
    window.WorkoutSessions.renderLogs(document.getElementById('workout-session-logs'));
    document.getElementById('workout-session-prog').click();
    vi.useFakeTimers();
    try {
      document.getElementById('workout-session-status-row').click();
      await vi.advanceTimersByTimeAsync(50);
      Array.from(document.querySelectorAll('.mt-confirm-modal__choice'))
        .find((b) => b.textContent.includes('Skipped')).click();
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
  // (med-eas.71, Task 3). The Close label later became an icon-only button:
  // the labelled one spanned the header and pushed the exercise list down.
  // ===========================================================================

  it('has no Save button and an icon-only Minimise in the session top bar', () => {
    const { document } = env;
    expect(document.getElementById('workout-session-save-btn')).toBeNull();
    const closeBtn = document.getElementById('workout-session-cancel-btn');
    expect(closeBtn).not.toBeNull();
    expect(closeBtn.getAttribute('aria-label')).toBe('Minimise');
    expect(closeBtn.classList.contains('wg-btn--icon')).toBe(true);
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

    await window.saveNewSessionExercise({ id: 99, name: 'Squat', default_reps_min: 5 });

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

  it('renders one done .wg-set row per synthesized set; Add set adds a pending row; un-tick removes a done set', () => {
    const { window, document } = env;
    installApiCache(window);
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.logs = [
      { id: 5, exercise_id: 1, exercise_name: 'Bench', sets_completed: 2, reps_completed: 8, weight_kg: 60 }
    ];
    const container = document.getElementById('workout-session-logs');
    window.renderWorkoutSessionLogs(container);

    // Existing flat-scalar log synthesizes sets_completed done rows.
    let rows = container.querySelectorAll('.wg-set');
    expect(rows.length).toBe(2);
    expect(container.querySelectorAll('.wg-set--done').length).toBe(2);

    // Add set = one more PENDING row; nothing to save until it is ticked.
    container.querySelector('.wg-workouts-session-exercise__add-set').click();
    rows = container.querySelectorAll('.wg-set');
    expect(rows.length).toBe(3);
    expect(rows[2].classList.contains('wg-set--done')).toBe(false);
    expect(window.WorkoutSessionsState.logs[0].sets.length).toBe(2);
    expect(window.WorkoutSessionsState.logs[0]._dirty).toBeFalsy();

    // Un-ticking a done set removes it from the saved sets (it goes back to pending).
    rows[0].querySelector('.wg-set__done').click();
    expect(window.WorkoutSessionsState.logs[0].sets.length).toBe(1);
    expect(window.WorkoutSessionsState.logs[0]._setsDirty).toBe(true);
    expect(container.querySelectorAll('.wg-set').length).toBe(3);

    // The 20-set ceiling (save validator) disables Add set.
    window.WorkoutSessionsState.logs[0]._targetSets = 20;
    window.renderWorkoutSessionLogs(container);
    expect(container.querySelector('.wg-workouts-session-exercise__add-set').disabled).toBe(true);
  });

  it('updateLocalSet captures set_type + rpe and re-derives the flat scalars', () => {
    const { window, document } = env;
    installApiCache(window);
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.logs = [
      { id: 5, exercise_id: 1, exercise_name: 'Bench', sets_completed: 2, reps_completed: 5, weight_kg: 40 }
    ];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

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

  it('one-tap RPE chips rate the just-ticked set and the active pending set (med-5wgd)', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.loadWorkoutHistoryTab = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    window.WorkoutSessionsState.logs = [
      { id: 5, exercise_id: 1, exercise_name: 'Bench', sets_completed: 1, reps_completed: 5, weight_kg: 40, notes: '', _targetSets: 3 }
    ];
    const container = document.getElementById('workout-session-logs');
    window.renderWorkoutSessionLogs(container);
    const log = window.WorkoutSessionsState.logs[0];
    const row = (r) => container.querySelector(`.wg-set[data-row="${r}"]`);
    const chip = (r, n) => row(r).querySelector(`.wg-set__rpe-picks [aria-label="RPE ${n}"]`);
    const repsSmall = (r) => row(r).querySelector('[data-field="reps"] small');

    // The unrated latest done row and the active pending row both carry chips 6–10.
    expect(row(0).querySelectorAll('.wg-set__rpe-picks .wg-pick').length).toBe(5);
    expect(row(1).querySelector('.wg-set__rpe-picks')).not.toBeNull();
    expect(row(2).querySelector('.wg-set__rpe-picks')).toBeNull();
    expect(repsSmall(0)).toBeNull();

    // Rate the ticked set: one tap; chips vanish and the row shows "RPE 8".
    chip(0, 8).click();
    expect(log.sets[0].rpe).toBe(8);
    expect(log._setsDirty).toBe(true);
    expect(row(0).querySelector('.wg-set__rpe-picks')).toBeNull();
    expect(repsSmall(0).textContent).toBe('RPE 8');

    // Rate the active pending row before ticking; tapping the pressed chip clears it.
    chip(1, 9).click();
    expect(chip(1, 9).getAttribute('aria-pressed')).toBe('true');
    chip(1, 9).click();
    expect(chip(1, 9).getAttribute('aria-pressed')).toBe('false');
    expect(log._drafts[0] && 'rpe' in log._drafts[0]).toBeFalsy();
    chip(1, 9).click();
    row(1).querySelector('.wg-set__done').click();
    expect(log.sets[1].rpe).toBe(9);
    // Rated on tick: no chip row on it, the next set is now the active one.
    expect(row(1).querySelector('.wg-set__rpe-picks')).toBeNull();
    expect(repsSmall(1).textContent).toBe('RPE 9');
    expect(row(2).querySelector('.wg-set__rpe-picks')).not.toBeNull();
    expect(container.textContent).not.toMatch(/RPE (null|—)/);

    let updatePayload = null;
    window.apiCall = vi.fn(async (endpoint, method, payload) => {
      if (endpoint === '/api/workout/sessions/logs/update') { updatePayload = payload; return { ok: true }; }
      return [];
    });
    await window.saveWorkoutSessionDetails();
    expect(updatePayload.sets.map((s) => s.rpe)).toEqual([8, 9]);
  });

  it('saveWorkoutSessionDetails posts the per-set array plus derived scalars for an edited log', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.loadWorkoutHistoryTab = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    window.WorkoutSessionsState.logs = [
      { id: 7, exercise_id: 1, exercise_name: 'Bench', sets_completed: 2, reps_completed: 5, weight_kg: 40, notes: '' }
    ];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    // Turn set 0 into a warm-up and make set 1 a heavier working set with an RPE.
    window.updateLocalSet(0, 0, 'set_type', 'warmup');
    window.updateLocalSet(0, 0, 'weight_kg', '20');
    window.updateLocalSet(0, 0, 'reps', '10');
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

  // med-okwf.1: an added exercise is NOT done — a placeholder log (status '',
  // no done sets) whose quick-add reps/weight pre-fill one pending set row.
  it('saveNewSessionExercise adds the exercise not done: one pre-filled pending set, completed count unchanged', async () => {
    const { window, document } = env;
    const cache = installApiCache(window, {
      workout_history: {
        sessions: [{ session: { id: 42, status: 'in_progress' }, group_name: 'Ad-hoc', exercises_count: 1, exercises_completed: 1 }],
        miband: []
      }
    });
    window.showWorkoutSessionModal = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.logs = [
      { id: 5, exercise_id: 1, exercise_name: 'Bench', status: 'completed', sets_completed: 3, reps_completed: 8, weight_kg: 60 }
    ];
    window.renderWorkoutSessionLogs(document.getElementById('workout-session-logs'));

    let createdPayload = null;
    let historyAtPost = null;
    window.apiCall = vi.fn(async (endpoint, method, payload) => {
      if (endpoint === '/api/workout/sessions/logs/create') {
        createdPayload = payload;
        historyAtPost = cache.get('workout_history');
        return { id: 999 };
      }
      if (endpoint.startsWith('/api/workout/sessions/details')) {
        return { session: { id: 42, status: 'in_progress' }, logs: [] };
      }
      return [];
    });

    await window.saveNewSessionExercise({ id: 99, name: 'Squat', default_sets: 3, default_reps_min: 5, default_weight_kg: 100 });

    // Persisted as a placeholder: no done sets (target_sets 0 — createLog
    // stores target_* as the done scalars when `sets` is absent), status ''.
    expect(createdPayload).not.toBeNull();
    expect(createdPayload.status).toBe('');
    expect(createdPayload.target_sets).toBe(0);
    expect('sets' in createdPayload).toBe(false);
    expect(createdPayload.target_reps_min).toBe(5);
    expect(createdPayload.target_weight_kg).toBe(100);

    // History: N+1 exercises, completed count unchanged.
    expect(historyAtPost.sessions[0].exercises_count).toBe(2);
    expect(historyAtPost.sessions[0].exercises_completed).toBe(1);

    // On screen: one pending set pre-filled 100 × 5, not done; the progress
    // segment for the new exercise is not done.
    const log = window.WorkoutSessionsState.logs[1];
    expect(log.status).toBe('');
    expect(log.sets).toEqual([]);
    expect(log._dirty).toBeFalsy();
    const card = document.getElementById('workout-session-logs');
    expect(card.querySelector('.wg-ex__name').textContent).toBe('Squat');
    const rows = card.querySelectorAll('.wg-set');
    expect(rows.length).toBe(1);
    expect(rows[0].classList.contains('wg-set--done')).toBe(false);
    expect(rows[0].querySelector('[data-field="weight_kg"]').getAttribute('aria-label')).toBe('Weight 100');
    expect(rows[0].querySelector('[data-field="reps"]').getAttribute('aria-label')).toBe('Reps 5');
    let segs = document.querySelectorAll('#workout-session-prog .wg-session-prog__seg');
    expect(segs[1].classList.contains('wg-session-prog__seg--done')).toBe(false);

    // Ticking it completes the exercise like a planned one: the pre-fill
    // becomes the real done set the autosave persists.
    rows[0].querySelector('.wg-set__done').click();
    expect(log.sets).toEqual([expect.objectContaining({ set_index: 0, weight_kg: 100, reps: 5 })]);
    expect(log._setsDirty).toBe(true);
    segs = document.querySelectorAll('#workout-session-prog .wg-session-prog__seg');
    expect(segs[1].classList.contains('wg-session-prog__seg--done')).toBe(true);
    window.cancelAutosave?.();
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

// med-v75c.2 — active-workout plate-loading chip: one glyph + text per
// exercise card, solved from the bound equipment for the working weight,
// with a nearest-achievable fallback and its delta. The real domain math
// (loadingFor / nearestLoads) is injected through the same namespace seam
// production uses, so the harness never resolves the module URL.
describe('features/workout/sessions.js — plate-loading chip (med-v75c.2)', () => {
  let env;
  let consoleErrorSpy;

  const BAR8 = {
    id: 3, kind: 'plated', name: 'Short bar', bar_kg: 8, sides: 2, pair: false,
    plates: [{ kg: 15, count: 2 }, { kg: 10, count: 2 }, { kg: 5, count: 2 }, { kg: 2, count: 2 }, { kg: 1.25, count: 2 }],
  };
  BAR8.loads_kg = achievableLoads(BAR8);
  const KB4 = {
    id: 4, kind: 'plated', name: 'Loadable KB', bar_kg: 4, sides: 1, pair: false,
    plates: [{ kg: 2, count: 3 }, { kg: 1, count: 2 }],
  };
  KB4.loads_kg = achievableLoads(KB4);
  const FIXED_KBS = { id: 5, kind: 'fixed', name: 'KBs', loads_kg: [8, 16, 24] };

  const ROWS = [{ id: 101, exercise_name: 'Bench press', exercise_library_id: 11, target_sets: 3, target_reps_min: 5, target_weight_kg: 72 }];
  const libFor = (equipmentId) => [{ id: 11, name: 'Bench press', equipment_id: equipmentId }];

  const chipSession = (over) => ({
    id: 77, variant_id: 30, variant_name: 'Push Day', group_name: 'PPL',
    status: 'in_progress', scheduled_date: '2026-04-22', scheduled_time: '09:00',
    started_at: '2026-04-22T09:05:00Z', completed_at: null, duration_minutes: 42,
    ...over,
  });
  const chipLog = (over) => ({
    id: 1, exercise_id: 101, exercise_name: 'Bench press',
    sets_completed: 3, reps_completed: 5, weight_kg: 72, notes: '', status: 'completed',
    ...over,
  });

  async function openChipSession(window, { logs, session, rows, lib, inventory, equipmentFallback } = {}) {
    const sess = session || chipSession();
    window.apiCall = vi.fn(async (endpoint) => {
      if (String(endpoint).startsWith('/api/workout/sessions/details')) return { session: sess, logs: logs || [chipLog()] };
      if (String(endpoint).includes('/api/workout/exercises?variant_id=')) return rows || ROWS;
      if (endpoint === '/api/workout/exercise-library') return lib || libFor(3);
      if (endpoint === '/api/workout/equipment') return equipmentFallback === undefined ? (inventory || [BAR8]) : equipmentFallback;
      return [];
    });
    window.WorkoutEquipment.list = async () => (inventory || [BAR8]);
    window.WorkoutGroups.loadEquipmentDomain = async () => ({
      loadingFor, nearestLoads, equipmentForExercise, pickNearestLoad,
    });
    await window.showWorkoutSessionModal(sess.id);
    // The chip attaches fire-and-forget; drain the stubbed hops.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  function firstCard(document) {
    return document.getElementById('workout-session-logs')
      .querySelector('.wg-workouts-session-exercise');
  }

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

  it('an exact 72 on the 8kg bar shows the glyph plus "8 + 15 · 10 · 5 · 2 / side"', async () => {
    const { window, document } = env;
    await openChipSession(window, {});

    const card = firstCard(document);
    const chip = card.querySelector('.wg-workouts-session-exercise__plates');
    expect(chip).not.toBeNull();
    // Mounted directly after the mono row.
    expect(card.querySelector('.wg-workouts-session-exercise__mono').nextElementSibling).toBe(chip);

    const svg = chip.querySelector('svg.wg-plates__glyph');
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('role')).toBe('img');
    // 4 plate rects per side; the sleeve is a line, never a rect.
    expect(svg.querySelectorAll('rect').length).toBe(8);
    expect(svg.querySelectorAll('rect.wg-plates__plate').length).toBe(8);
    expect(svg.querySelectorAll('line.wg-plates__sleeve').length).toBe(1);
    expect(svg.querySelectorAll('text.wg-plates__label').length).toBe(8);
    expect(chip.querySelector('.wg-plates__text').textContent).toBe('8 + 15 · 10 · 5 · 2 / side');
    expect(chip.querySelector('.wg-plates__delta')).toBeNull();
    // Library-bound: no auto-match label (med-x295).
    expect(chip.querySelector('.wg-plates__auto')).toBeNull();
    // Rule 3: geometry attributes only — no paint in the emitted markup.
    // (The swap button's kit icon is a separate svg, outside the glyph.)
    expect(svg.outerHTML).not.toMatch(/fill=|stroke=|style=/);
    expect(chip.outerHTML).not.toMatch(/style=/);
  });

  it('an unreachable 73 shows the 72 loading plus a "-1 kg" delta', async () => {
    const { window, document } = env;
    await openChipSession(window, { logs: [chipLog({ weight_kg: 73, reps_completed: 5 })] });

    const chip = firstCard(document).querySelector('.wg-workouts-session-exercise__plates');
    expect(chip).not.toBeNull();
    expect(chip.querySelector('svg.wg-plates__glyph')).not.toBeNull();
    expect(chip.querySelectorAll('rect').length).toBe(8);
    expect(chip.querySelector('.wg-plates__text').textContent).toBe('8 + 15 · 10 · 5 · 2 / side');
    expect(chip.querySelector('.wg-plates__delta').textContent).toBe('72 kg (-1 kg)');
  });

  it('a below-bar 5 renders no svg and no crash', async () => {
    const { window, document } = env;
    await openChipSession(window, { logs: [chipLog({ weight_kg: 5 })] });

    const card = firstCard(document);
    const chip = card.querySelector('.wg-workouts-session-exercise__plates');
    expect(chip).not.toBeNull();
    expect(chip.querySelector('svg.wg-plates__glyph')).toBeNull();
    expect(chip.querySelector('.wg-plates__text').textContent).toBe('below bar (8 kg)');
    expect(card.querySelector('.wg-workouts-session-exercise__mono').textContent).toBe('3 × 5 · 5 kg');
  });

  it('a plate-loaded kettlebell draws one stack with no "/ side"', async () => {
    const { window, document } = env;
    await openChipSession(window, {
      logs: [chipLog({ exercise_name: 'KB press', weight_kg: 9 })],
      lib: libFor(4),
      inventory: [KB4],
    });

    const chip = firstCard(document).querySelector('.wg-workouts-session-exercise__plates');
    expect(chip).not.toBeNull();
    const svg = chip.querySelector('svg.wg-plates__glyph');
    expect(svg).not.toBeNull();
    expect(svg.querySelectorAll('rect').length).toBe(3);
    expect(chip.querySelector('.wg-plates__text').textContent).toBe('4 + 2 · 2 · 1');
    expect(chip.textContent).not.toContain('/ side');
  });

  it('fixed gear shows a text-only nearest one-liner off-rung, nothing on-rung', async () => {
    const { window, document } = env;
    await openChipSession(window, {
      logs: [chipLog({ exercise_name: 'KB swing', weight_kg: 20 })],
      lib: libFor(5),
      inventory: [FIXED_KBS],
    });

    const chip = firstCard(document).querySelector('.wg-workouts-session-exercise__plates');
    expect(chip).not.toBeNull();
    expect(chip.querySelector('svg.wg-plates__glyph')).toBeNull();
    // 20 sits halfway between 16 and 24 — the tie goes below.
    expect(chip.querySelector('.wg-plates__text').textContent).toBe('nearest: 16 kg');

    // A stocked load needs no chip at all.
    await openChipSession(window, {
      logs: [chipLog({ exercise_name: 'KB swing', weight_kg: 16 })],
      lib: libFor(5),
      inventory: [FIXED_KBS],
    });
    expect(firstCard(document).querySelector('.wg-workouts-session-exercise__plates')).toBeNull();
  });

  it('an unbound exercise gets no chip node at all', async () => {
    const { window, document } = env;
    await openChipSession(window, { lib: libFor(null) });

    const card = firstCard(document);
    expect(card.querySelector('.wg-workouts-session-exercise__plates')).toBeNull();
    expect(card.querySelector('.wg-workouts-session-exercise__mono').textContent).toBe('3 × 5 · 72 kg');
  });

  it('an unbound barbell-named exercise auto-matches the inventory bar and labels it (med-x295)', async () => {
    const { window, document } = env;
    await openChipSession(window, {
      logs: [chipLog({ exercise_name: 'Barbell squat' })],
      rows: [{ ...ROWS[0], exercise_name: 'Barbell squat' }],
      lib: [{ id: 11, name: 'Barbell squat', equipment_id: null }],
      inventory: [FIXED_KBS, BAR8],
    });

    const chip = firstCard(document).querySelector('.wg-workouts-session-exercise__plates');
    expect(chip).not.toBeNull();
    expect(chip.querySelector('.wg-plates__auto').textContent).toBe('auto: Short bar');
    expect(chip.querySelector('svg.wg-plates__glyph')).not.toBeNull();
    expect(chip.querySelector('.wg-plates__text').textContent).toBe('8 + 15 · 10 · 5 · 2 / side');
  });

  it('a plan-row override wins over the library binding (med-3gln)', async () => {
    const { window, document } = env;
    // The library binds the 8kg bar, but the plan row overrides to the
    // loadable kettlebell: the chip draws the KB stack for the 9kg log.
    await openChipSession(window, {
      logs: [chipLog({ exercise_name: 'KB press', weight_kg: 9 })],
      rows: [{ ...ROWS[0], equipment_id: 4 }],
      lib: libFor(3),
      inventory: [BAR8, KB4],
    });

    const chip = firstCard(document).querySelector('.wg-workouts-session-exercise__plates');
    expect(chip).not.toBeNull();
    expect(chip.querySelector('svg.wg-plates__glyph')).not.toBeNull();
    expect(chip.querySelector('.wg-plates__text').textContent).toBe('4 + 2 · 2 · 1');
    expect(chip.textContent).not.toContain('/ side');
  });

  it('a row override with no library link still shows the chip (med-3gln)', async () => {
    const { window, document } = env;
    const rowNoLib = { ...ROWS[0], equipment_id: 3 };
    delete rowNoLib.exercise_library_id;
    await openChipSession(window, {
      rows: [rowNoLib],
      lib: libFor(null),
      inventory: [BAR8],
    });

    const chip = firstCard(document).querySelector('.wg-workouts-session-exercise__plates');
    expect(chip).not.toBeNull();
    expect(chip.querySelector('.wg-plates__text').textContent).toBe('8 + 15 · 10 · 5 · 2 / side');
    expect(chip.querySelector('.wg-plates__delta')).toBeNull();
  });

  it('a rejected equipment read leaves the cards exactly as today', async () => {
    const { window, document } = env;
    const sess = chipSession();
    const logs = [chipLog(), chipLog({ id: 2, exercise_id: 101, exercise_name: 'Bench press (2)' })];
    window.apiCall = vi.fn(async (endpoint) => {
      if (String(endpoint).startsWith('/api/workout/sessions/details')) return { session: sess, logs };
      if (String(endpoint).includes('/api/workout/exercises?variant_id=')) return ROWS;
      if (endpoint === '/api/workout/exercise-library') return libFor(3);
      return null;
    });
    window.WorkoutEquipment.list = async () => { throw new Error('offline'); };
    window.WorkoutGroups.loadEquipmentDomain = async () => ({
      loadingFor, nearestLoads, equipmentForExercise, pickNearestLoad,
    });
    await window.showWorkoutSessionModal(sess.id);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // One exercise on screen at a time: check both via Next.
    const cardAt = () => {
      const cards = document.getElementById('workout-session-logs')
        .querySelectorAll('.wg-workouts-session-exercise');
      expect(cards.length).toBe(1);
      return cards[0];
    };
    const first = cardAt();
    expect(first.querySelector('.wg-workouts-session-exercise__plates')).toBeNull();
    expect(first.querySelector('.wg-workouts-session-exercise__mono').textContent).toBe('3 × 5 · 72 kg');
    document.querySelector('.wg-workouts-session-actions__next').click();
    const second = cardAt();
    expect(second.querySelector('.wg-ex__name').textContent).toBe('Bench press (2)');
    expect(second.querySelector('.wg-workouts-session-exercise__plates')).toBeNull();
  });

  it('editing a set weight re-solves the chip', async () => {
    const { window, document } = env;
    await openChipSession(window, {});

    let card = firstCard(document);
    expect(card.querySelector('.wg-plates__delta')).toBeNull();

    // The cached gear re-solves synchronously with the mono line.
    window.updateLocalSet(0, 0, 'weight_kg', '73');

    card = firstCard(document);
    expect(card.querySelector('.wg-workouts-session-exercise__mono').textContent).toBe('3 × 5 · 73 kg');
    const chips = card.querySelectorAll('.wg-workouts-session-exercise__plates');
    expect(chips.length).toBe(1);
    expect(chips[0].querySelector('.wg-plates__text').textContent).toBe('8 + 15 · 10 · 5 · 2 / side');
    expect(chips[0].querySelector('.wg-plates__delta').textContent).toBe('72 kg (-1 kg)');
  });

  // A completion snapshot freezes the plan as performed: the live variant
  // is never consulted (med-qj4.2.1 contract), so plan-row cards stay
  // chipless — the snapshot carries no library id to resolve them by.
  it('a snapshot session never consults the live variant and stays chipless', async () => {
    const { window, document } = env;
    const calls = [];
    const sess = chipSession({ variant_id: 7, status: 'completed',
      exercise_snapshot: [{ exercise_id: 101, exercise_name: 'Bench press', target_sets: 3, target_reps_min: 5, target_weight_kg: 72, order_index: 0 }] });
    window.apiCall = vi.fn(async (endpoint) => {
      calls.push(endpoint);
      if (String(endpoint).startsWith('/api/workout/sessions/details')) return { session: sess, logs: [chipLog()] };
      if (String(endpoint).includes('/api/workout/exercises?variant_id=')) return ROWS;
      if (endpoint === '/api/workout/exercise-library') return libFor(3);
      if (endpoint === '/api/workout/equipment') return [BAR8];
      return [];
    });
    window.WorkoutEquipment.list = async () => [BAR8];
    window.WorkoutGroups.loadEquipmentDomain = async () => ({
      loadingFor, nearestLoads, equipmentForExercise, pickNearestLoad,
    });
    await window.showWorkoutSessionModal(sess.id);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.some((c) => c.startsWith('/api/workout/exercises?'))).toBe(false);
    expect(firstCard(document).querySelector('.wg-workouts-session-exercise__plates')).toBeNull();
  });

  // An in-progress session may carry a snapshot (mid-workout plan edits
  // materialize one) without being frozen: the live variant stays readable
  // for the library link, so the chip still shows.
  it('an in-progress session with a snapshot still shows the chip', async () => {
    const { window, document } = env;
    const calls = [];
    const sess = chipSession({ variant_id: 7, status: 'in_progress',
      exercise_snapshot: [{ exercise_id: 101, exercise_name: 'Bench press', target_sets: 3, target_reps_min: 5, target_weight_kg: 72, order_index: 0 }] });
    window.apiCall = vi.fn(async (endpoint) => {
      calls.push(endpoint);
      if (String(endpoint).startsWith('/api/workout/sessions/details')) return { session: sess, logs: [chipLog()] };
      if (String(endpoint).includes('/api/workout/exercises?variant_id=')) return ROWS;
      if (endpoint === '/api/workout/exercise-library') return libFor(3);
      if (endpoint === '/api/workout/equipment') return [BAR8];
      return [];
    });
    window.WorkoutEquipment.list = async () => [BAR8];
    window.WorkoutGroups.loadEquipmentDomain = async () => ({
      loadingFor, nearestLoads, equipmentForExercise, pickNearestLoad,
    });
    await window.showWorkoutSessionModal(sess.id);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.some((c) => c.startsWith('/api/workout/exercises'))).toBe(true);
    const chip = firstCard(document).querySelector('.wg-workouts-session-exercise__plates');
    expect(chip).not.toBeNull();
    expect(chip.querySelector('.wg-plates__text').textContent).toBe('8 + 15 · 10 · 5 · 2 / side');
  });

  it('a flat weight edit via updateLocalLog re-solves the chip', async () => {
    const { window, document } = env;
    await openChipSession(window, {});

    window.updateLocalLog(0, 'weight_kg', '73');

    const card = firstCard(document);
    const chips = card.querySelectorAll('.wg-workouts-session-exercise__plates');
    expect(chips.length).toBe(1);
    expect(chips[0].querySelector('.wg-plates__text').textContent).toBe('8 + 15 · 10 · 5 · 2 / side');
    expect(chips[0].querySelector('.wg-plates__delta').textContent).toBe('72 kg (-1 kg)');
  });

  it('an lb preference labels the plate line as kg', async () => {
    const { window, document } = env;
    window.weightUnitPreference = 'lb';
    await openChipSession(window, {});

    const chip = firstCard(document).querySelector('.wg-workouts-session-exercise__plates');
    expect(chip).not.toBeNull();
    expect(chip.querySelector('.wg-plates__text').textContent).toBe('8 + 15 · 10 · 5 · 2 / side (kg)');
  });

  // med-j6pn (kit W4/W4b): swap the equipment from the strip mid-workout.
  describe('equipment swap', () => {
    // A stateful fake: PUTs land in `world`, so the post-write rebuild reads
    // the truth back like the vault would.
    async function openSwapSession(window, { logs, session, rows, lib, inventory, failWrites } = {}) {
      const world = { rows: rows || [{ ...ROWS[0], order_index: 2 }], lib: lib || libFor(3), puts: [] };
      // Production shape: the plan names ride on the details envelope only.
      const sess = session || chipSession({ group_name: undefined, variant_name: undefined });
      window.apiCall = vi.fn(async (endpoint, method, body) => {
        const url = String(endpoint);
        if (method === 'PUT') {
          world.puts.push({ url, body });
          if (failWrites) return null;
          const id = Number(url.split('id=')[1]);
          if (url.startsWith('/api/workout/exercises/update')) {
            world.rows = world.rows.map((r) => (r.id === id ? { ...r, equipment_id: body.equipment_id } : r));
          } else if (url.startsWith('/api/workout/exercise-library/update')) {
            world.lib = world.lib.map((r) => (r.id === id ? { ...r, equipment_id: body.equipment_id } : r));
          }
          return true;
        }
        if (url.startsWith('/api/workout/sessions/details')) {
          return { session: sess, logs: logs || [chipLog()], group_name: 'PPL', variant_name: 'Push Day' };
        }
        if (url.includes('/api/workout/exercises?variant_id=')) return world.rows;
        if (url === '/api/workout/exercise-library') return world.lib;
        if (url === '/api/workout/equipment') return inventory || [BAR8, KB4];
        return [];
      });
      window.WorkoutEquipment.list = async () => (inventory || [BAR8, KB4]);
      window.WorkoutGroups.loadEquipmentDomain = async () => ({
        loadingFor, nearestLoads, equipmentForExercise, pickNearestLoad,
      });
      window.SyncManager = { ...(window.SyncManager || {}), showToast: vi.fn(() => ({ dismiss() {} })) };
      await window.showWorkoutSessionModal(sess.id);
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
      return world;
    }

    async function drainSwap() {
      for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
    }

    const sheetOf = (document) => document.getElementById('workout-session-equip-sheet');
    const choices = (document) => Array.from(sheetOf(document).querySelectorAll('.wg-choice'));
    const choiceNamed = (document, name) => choices(document)
      .find((b) => b.firstChild.nextSibling.firstChild.textContent === name);

    it('a plan-backed strip names its gear, picks a new item into the plan row, re-solves and undoes', async () => {
      const { window, document } = env;
      const world = await openSwapSession(window, { logs: [chipLog({ exercise_name: 'Bench press', weight_kg: 9 })] });

      let chip = firstCard(document).querySelector('.wg-workouts-session-exercise__plates');
      expect(chip.querySelector('.wg-plates__src').textContent).toBe('Short bar');
      expect(chip.querySelector('.wg-plates__auto')).toBeNull();
      chip.querySelector('.wg-plates__swap').click();
      await drainSwap();

      const sheet = sheetOf(document);
      expect(sheet.classList.contains('hidden')).toBe(false);
      expect(sheet.querySelector('.wg-sheethead .wg-eyebrow').textContent).toBe('Saves to PPL · Push Day');
      expect(sheet.querySelector('.wg-sheethead__title').textContent).toBe('Equipment');
      // Auto on top (the row has no override: it inherits the library bar).
      const auto = choices(document)[0];
      expect(auto.textContent).toContain('Auto');
      expect(auto.querySelector('.wg-choice__sub').textContent).toBe('From library · now Short bar');
      expect(auto.getAttribute('aria-pressed')).toBe('true');
      expect(choiceNamed(document, 'Short bar').querySelector('.wg-choice__sub').textContent)
        .toBe('bar 8 · plates to 15');
      expect(choiceNamed(document, 'Loadable KB').querySelector('.wg-choice__sub').textContent)
        .toBe('handle 4 · plates to 2');

      choiceNamed(document, 'Loadable KB').click();
      // Optimistic: the strip re-solves before the write settles.
      expect(firstCard(document).querySelector('.wg-plates__src').textContent).toBe('Loadable KB');
      await drainSwap();

      expect(sheet.classList.contains('hidden')).toBe(true);
      expect(world.puts).toHaveLength(1);
      expect(world.puts[0].url).toBe('/api/workout/exercises/update?id=101');
      // The row is sent back verbatim (full-replace endpoint); the
      // progression rule / goal keys are omitted so they survive.
      expect(world.puts[0].body).toEqual({
        exercise_name: 'Bench press', target_sets: 3, target_reps_min: 5, target_reps_max: null,
        target_weight_kg: 72, order_index: 2, equipment_id: 4,
      });
      chip = firstCard(document).querySelector('.wg-workouts-session-exercise__plates');
      expect(chip.querySelector('.wg-plates__src').textContent).toBe('Loadable KB');
      expect(chip.querySelector('.wg-plates__text').textContent).toBe('4 + 2 · 2 · 1');

      const toast = window.SyncManager.showToast;
      expect(toast).toHaveBeenCalledWith('Equipment: Loadable KB', 'success', expect.objectContaining({
        detail: 'Saved to PPL · Push Day',
      }));
      toast.mock.calls[0][2].action.onClick();
      await drainSwap();

      expect(world.puts).toHaveLength(2);
      expect(world.puts[1].body.equipment_id).toBe(null);
      expect(firstCard(document).querySelector('.wg-plates__src').textContent).toBe('Short bar');
    });

    it('Undo still writes the previous id back after the session view closed', async () => {
      const { window, document } = env;
      const world = await openSwapSession(window, {});
      firstCard(document).querySelector('.wg-plates__swap').click();
      await drainSwap();
      choiceNamed(document, 'Loadable KB').click();
      await drainSwap();

      await window.closeWorkoutSessionModal();
      await drainSwap();
      const toast = window.SyncManager.showToast.mock.calls.find((c) => c[0] === 'Equipment: Loadable KB');
      toast[2].action.onClick();
      await drainSwap();

      const undo = world.puts[world.puts.length - 1];
      expect(undo.url).toBe('/api/workout/exercises/update?id=101');
      expect(undo.body).toMatchObject({ exercise_name: 'Bench press', order_index: 2, equipment_id: null });
    });

    it('nothing to load still shows the dashed no-equipment line with the swap button', async () => {
      const { window, document } = env;
      await openSwapSession(window, {
        logs: [chipLog({ exercise_name: 'Pull-up', weight_kg: 0 })],
        rows: [{ ...ROWS[0], exercise_name: 'Pull-up' }],
        lib: [{ id: 11, name: 'Pull-up', equipment_id: null }],
      });

      const card = firstCard(document);
      expect(card.querySelector('.wg-workouts-session-exercise__plates')).toBeNull();
      const none = card.querySelector('.wg-plates--none');
      expect(none).not.toBeNull();
      expect(none.querySelector('.wg-plates__src').textContent).toBe('No equipment');
      expect(none.querySelector('.wg-plates__line').textContent).toBe('Bodyweight · nothing to load');
      expect(none.querySelector('.wg-plates__swap')).not.toBeNull();
    });

    it('a library-sourced log saves to the library binding', async () => {
      const { window, document } = env;
      const world = await openSwapSession(window, {
        // No plan rows: a planned row named like the log would take its card.
        rows: [],
        logs: [chipLog({ exercise_id: 11, source: 'library', weight_kg: 72 })],
        lib: [{ id: 11, name: 'Bench press', equipment_id: 3, default_sets: 3, default_reps_min: 5, notes: 'n', body_part: 'Chest' }],
      });

      firstCard(document).querySelector('.wg-plates__swap').click();
      await drainSwap();
      expect(sheetOf(document).querySelector('.wg-sheethead .wg-eyebrow').textContent).toBe('Saves to library');
      expect(choiceNamed(document, 'Short bar').getAttribute('aria-pressed')).toBe('true');

      choices(document)[0].click(); // Auto clears the binding
      await drainSwap();
      expect(world.puts[0].url).toBe('/api/workout/exercise-library/update?id=11');
      expect(world.puts[0].body).toEqual({
        name: 'Bench press', default_sets: 3, default_reps_min: 5, default_reps_max: null,
        default_weight_kg: null, notes: 'n', body_part: 'Chest', equipment_id: null,
      });
      expect(window.SyncManager.showToast).toHaveBeenCalledWith('Equipment: Auto', 'success',
        expect.objectContaining({ detail: 'Saved to library' }));
    });

    it('a failed write rolls the strip back and toasts the error', async () => {
      const { window, document } = env;
      const world = await openSwapSession(window, { failWrites: true });

      firstCard(document).querySelector('.wg-plates__swap').click();
      await drainSwap();
      choiceNamed(document, 'Loadable KB').click();
      await drainSwap();

      expect(world.puts).toHaveLength(1);
      expect(firstCard(document).querySelector('.wg-plates__src').textContent).toBe('Short bar');
      expect(window.SyncManager.showToast).toHaveBeenCalledWith("Couldn't change the equipment — try again.", 'error');
    });

    it('a completed session is frozen: no swap button', async () => {
      const { window, document } = env;
      await openSwapSession(window, { session: chipSession({ status: 'completed' }) });
      expect(firstCard(document).querySelector('.wg-plates__swap')).toBeNull();
    });

    // med-i7kw (kit W4b): Manage equipment / Add equipment open the shared
    // Equipment editor over the live session; the picker and strip re-solve.
    describe('manage / add equipment from the picker', () => {
      // A stateful inventory fake: the editor's POST/PUT land in `world.inv`
      // and every read (editor list, strip gear) reads it back.
      async function openManageSession(window, { inventory, logs, lib }) {
        installApiCache(window);
        const world = { inv: structuredClone(inventory), writes: [] };
        const sess = chipSession();
        const api = vi.fn(async (endpoint, method, body) => {
          const url = String(endpoint);
          if (url.startsWith('/api/workout/equipment')) {
            if (method === 'POST') {
              const item = { ...body, id: 50 };
              item.loads_kg = item.kind === 'plated' ? achievableLoads(item) : item.loads_kg;
              world.inv.push(item);
              world.writes.push({ url, method, body });
              return structuredClone(item);
            }
            if (method === 'PUT') {
              const id = Number(url.split('/').pop());
              world.inv = world.inv.map((e) => {
                if (e.id !== id) return e;
                const next = { ...e, ...body };
                if (next.kind === 'plated') next.loads_kg = achievableLoads(next);
                return next;
              });
              world.writes.push({ url, method, body });
              return true;
            }
            return structuredClone(world.inv);
          }
          if (url.startsWith('/api/workout/sessions/details')) return { session: sess, logs };
          if (url.includes('/api/workout/exercises?variant_id=')) return ROWS;
          if (url === '/api/workout/exercise-library') return lib;
          return [];
        });
        window.apiCall = api;
        window.apiCallDirect = api;
        window.WorkoutEquipment.list = async () => structuredClone(world.inv);
        window.WorkoutGroups.loadEquipmentDomain = async () => ({
          loadingFor, nearestLoads, equipmentForExercise, pickNearestLoad,
        });
        await window.showWorkoutSessionModal(sess.id);
        await drainSwap();
        return world;
      }

      const shown = (document, id) => !document.getElementById(id).classList.contains('hidden');

      it('Manage equipment → edit an item over the session → back: the strip re-solves with the new plates', async () => {
        const { window, document } = env;
        // 98 kg needs 45/side; the 8kg bar tops out at 33.25/side without a 20.
        const world = await openManageSession(window, {
          inventory: [BAR8], logs: [chipLog({ weight_kg: 98 })], lib: libFor(3),
        });
        expect(firstCard(document).querySelector('.wg-plates__delta')).not.toBeNull();

        firstCard(document).querySelector('.wg-plates__swap').click();
        await drainSwap();
        const link = sheetOf(document).querySelector('.wg-equip-foot .wg-link');
        expect(link.textContent).toBe('Manage equipment');
        link.click();
        await drainSwap();

        expect(shown(document, 'workout-session-equip-manage-sheet')).toBe(true);
        const list = document.getElementById('workout-session-equip-manage-list');
        await vi.waitFor(() => expect(list.querySelectorAll('.wg-equipment-row')).toHaveLength(1));
        list.querySelector('.wg-equipment-row__edit').click();
        await drainSwap();

        // The shared editor stacks over the session (later in the DOM at the same z).
        const modal = document.getElementById('workout-equipment-modal');
        const session = document.getElementById('workout-session-modal');
        expect(shown(document, 'workout-equipment-modal')).toBe(true);
        expect(document.getElementById('workout-equipment-modal-title').textContent).toBe('Edit Equipment');
        expect(session.compareDocumentPosition(modal) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        document.getElementById('workout-equipment-plate-add').click();
        const rows = document.querySelectorAll('#workout-equipment-plates [data-plate-row]');
        rows[rows.length - 1].querySelector('[data-plate-kg]').value = '20';
        rows[rows.length - 1].querySelector('[data-plate-count]').value = '2';
        document.getElementById('workout-equipment-save-btn').click();

        await vi.waitFor(() => expect(shown(document, 'workout-equipment-modal')).toBe(false));
        expect(world.writes).toHaveLength(1);
        expect(world.writes[0].url).toBe('/api/workout/equipment/3');
        expect(world.writes[0].body.plates).toContainEqual({ kg: 20, count: 2 });

        // Back closes the Manage sheet onto the picker; the session stays open.
        window.ModalManager.closeTop();
        expect(shown(document, 'workout-session-equip-manage-sheet')).toBe(false);
        expect(shown(document, 'workout-session-equip-sheet')).toBe(true);
        expect(shown(document, 'workout-session-modal')).toBe(true);
        await vi.waitFor(() => {
          const chip = firstCard(document).querySelector('.wg-workouts-session-exercise__plates');
          expect(chip.querySelector('.wg-plates__delta')).toBeNull();
          expect(chip.querySelector('.wg-plates__text').textContent).toContain('20');
        });
        expect(firstCard(document).querySelector('.wg-ex__name').textContent).toBe('Bench press');

        // Minimising the session takes its equipment sheets with it.
        sheetOf(document).querySelector('.wg-equip-foot .wg-link').click();
        await drainSwap();
        expect(shown(document, 'workout-session-equip-manage-sheet')).toBe(true);
        await window.closeWorkoutSessionModal();
        expect(shown(document, 'workout-session-equip-manage-sheet')).toBe(false);
        expect(shown(document, 'workout-session-equip-sheet')).toBe(false);
      });

      it('empty inventory: Add equipment → save → the picker lists the new item', async () => {
        const { window, document } = env;
        const world = await openManageSession(window, {
          inventory: [], logs: [chipLog()], lib: libFor(null),
        });

        firstCard(document).querySelector('.wg-plates__swap').click();
        await drainSwap();
        expect(sheetOf(document).querySelector('.wg-empty__title').textContent).toBe('No equipment yet');
        expect(sheetOf(document).querySelector('.wg-equip-foot')).toBeNull();
        const add = sheetOf(document).querySelector('.wg-empty__acts .wg-btn');
        expect(add.textContent).toBe('Add equipment');
        add.click();
        await drainSwap();

        expect(shown(document, 'workout-equipment-modal')).toBe(true);
        expect(document.getElementById('workout-equipment-modal-title').textContent).toBe('Add Equipment');
        document.getElementById('workout-equipment-name').value = 'Hex DBs';
        document.getElementById('workout-equipment-loads').value = '10, 12';
        document.getElementById('workout-equipment-save-btn').click();

        await vi.waitFor(() => expect(choiceNamed(document, 'Hex DBs')).toBeTruthy());
        expect(world.writes[0].method).toBe('POST');
        expect(shown(document, 'workout-equipment-modal')).toBe(false);
        expect(shown(document, 'workout-session-equip-sheet')).toBe(true);
        expect(shown(document, 'workout-session-modal')).toBe(true);
        expect(choiceNamed(document, 'Hex DBs').querySelector('.wg-choice__sub').textContent).toBe('fixed · 10–12 kg');
      });
    });
  });
});

describe('features/workout/sessions.js — session gym (med-8j5w.2)', () => {
  let env;
  let consoleErrorSpy;

  const HOME = { id: 41, name: 'Home' };
  const GYM_A = { id: 42, name: 'Gym A' };
  // Two auto-matchable barbells, one per gym. Both hit 72 exactly; across the
  // whole inventory the lower id (the short bar) wins the tie.
  const BAR8 = {
    id: 3, kind: 'plated', name: 'Short bar', bar_kg: 8, sides: 2, pair: false, location_id: HOME.id,
    plates: [{ kg: 15, count: 2 }, { kg: 10, count: 2 }, { kg: 5, count: 2 }, { kg: 2, count: 2 }],
  };
  BAR8.loads_kg = achievableLoads(BAR8);
  const OLY = {
    id: 6, kind: 'plated', name: 'Olympic bar', bar_kg: 20, sides: 2, pair: false, location_id: GYM_A.id,
    plates: [{ kg: 20, count: 4 }, { kg: 5, count: 2 }, { kg: 1, count: 2 }],
  };
  OLY.loads_kg = achievableLoads(OLY);

  const ROWS = [{ id: 101, exercise_name: 'Barbell squat', exercise_library_id: 11, target_sets: 3, target_reps_min: 5, target_weight_kg: 72 }];
  const LIB = [{ id: 11, name: 'Barbell squat', equipment_id: null }];
  const session = (over) => ({
    id: 77, variant_id: 30, variant_name: 'Legs', group_name: 'PPL',
    status: 'in_progress', scheduled_date: '2026-04-22', scheduled_time: '09:00',
    started_at: '2026-04-22T09:05:00Z', completed_at: null, duration_minutes: 42,
    ...over,
  });
  const LOG = {
    id: 1, exercise_id: 101, exercise_name: 'Barbell squat',
    sets_completed: 3, reps_completed: 5, weight_kg: 72, notes: '', status: 'completed',
  };

  // `world` is mutable: tests flip the gyms / active gym / session to model a
  // remote write, then fire the sync layer's datastore:changed signal.
  async function openGymSession(window, world) {
    window.apiCall = vi.fn(async (endpoint, method, body) => {
      const url = String(endpoint);
      if (url.startsWith('/api/workout/sessions/details')) return { session: world.session, logs: [LOG] };
      if (url.startsWith('/api/workout/sessions/location') && method === 'PUT') {
        const loc = world.locations.find((l) => l.id === body.location_id) || null;
        world.session = { ...world.session, location_id: loc ? loc.id : null, location_name: loc ? loc.name : null };
        return world.session;
      }
      if (url.includes('/api/workout/exercises?variant_id=')) return ROWS;
      if (url === '/api/workout/exercise-library') return LIB;
      if (url === '/api/workout/equipment') return [BAR8, OLY];
      if (url === '/api/workout/locations') return world.locations;
      if (url === '/api/workout/locations/active') return { location_id: world.activeId, location: null };
      return [];
    });
    window.WorkoutEquipment.list = async () => [BAR8, OLY];
    window.WorkoutGroups.loadEquipmentDomain = async () => ({
      loadingFor, nearestLoads, equipmentForExercise, pickNearestLoad,
    });
    await window.showWorkoutSessionModal(world.session.id);
    await drain();
  }

  async function drain() {
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
  }

  function overviewOpen(document) {
    return document.getElementById('workout-session-prog').getAttribute('aria-expanded') === 'true';
  }

  // Plate chips live on the exercise card, so close the overview first.
  function autoLabel(document) {
    if (overviewOpen(document)) document.getElementById('workout-session-prog').click();
    const chip = document.getElementById('workout-session-logs')
      .querySelector('.wg-workouts-session-exercise__plates');
    const auto = chip && chip.querySelector('.wg-plates__auto');
    return auto ? auto.textContent : null;
  }

  // The gym switch moved from the old sticky header into the overview
  // (tap the progress bar); it attaches asynchronously.
  async function gymChip(document) {
    if (!overviewOpen(document)) document.getElementById('workout-session-prog').click();
    await drain();
    return document.querySelector('#workout-session-gym .wg-workouts-gym-switch');
  }

  async function gymLabel(document) {
    return (await gymChip(document)).querySelector('.wg-workouts-gym-switch__name').textContent;
  }

  // Opens the overview's gym picker and taps the option named `label`.
  async function pickGym(document, label) {
    (await gymChip(document)).click();
    const option = Array.from(document.querySelectorAll('.mt-confirm-modal__choice'))
      .find((o) => o.textContent === label);
    option.click();
  }

  function remoteChange(window) {
    window.dispatchEvent(new window.CustomEvent('datastore:changed', {
      detail: { changedTags: ['workout'], source: 'cloud-write' },
    }));
  }

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

  it('no gyms: no overview gym control, chips as before', async () => {
    const { window, document } = env;
    await openGymSession(window, { locations: [], activeId: null, session: session() });
    expect(await gymChip(document)).toBeNull();
    expect(autoLabel(document)).toBe('auto: Short bar');
  });

  it('the overview shows the stamped gym; switching it PUTs and re-renders the chips at the new gym', async () => {
    const { window, document } = env;
    const world = { locations: [GYM_A, HOME], activeId: HOME.id, session: session({ location_id: HOME.id, location_name: 'Home' }) };
    await openGymSession(window, world);

    expect(await gymChip(document)).not.toBeNull();
    expect(await gymLabel(document)).toBe('Home');
    expect(autoLabel(document)).toBe('auto: Short bar');

    await pickGym(document, 'Gym A');
    await drain();

    expect(window.apiCall).toHaveBeenCalledWith('/api/workout/sessions/location?id=77', 'PUT',
      { location_id: GYM_A.id }, expect.anything());
    expect(window.WorkoutSessionsState.data.location_id).toBe(GYM_A.id);
    await vi.waitFor(() => expect(autoLabel(document)).toBe('auto: Olympic bar'));
  });

  it('Back with the gym picker open cancels the picker, not the session', async () => {
    const { window, document } = env;
    const world = { locations: [GYM_A, HOME], activeId: HOME.id, session: session({ location_id: HOME.id, location_name: 'Home' }) };
    await openGymSession(window, world);
    const sessionModal = document.getElementById('workout-session-modal');
    expect(sessionModal.classList.contains('hidden')).toBe(false);

    (await gymChip(document)).click();
    expect(document.querySelector('mt-modal.mt-confirm-modal')).not.toBeNull();
    expect(window.ModalManager.closeTopMostVisibleModal()).toBe(true);
    await drain();

    expect(document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
    expect(sessionModal.classList.contains('hidden')).toBe(false);
    expect(await gymLabel(document)).toBe('Home');
    expect(window.apiCall).not.toHaveBeenCalledWith('/api/workout/sessions/location?id=77', 'PUT',
      expect.anything(), expect.anything());
  });

  it('a remote active-gym switch while an unstamped session is open re-renders the chips', async () => {
    const { window, document } = env;
    const world = { locations: [GYM_A, HOME], activeId: HOME.id, session: session() };
    await openGymSession(window, world);
    expect(autoLabel(document)).toBe('auto: Short bar');

    world.activeId = GYM_A.id; // e.g. switched over MCP or on another device
    remoteChange(window);
    await drain();

    await vi.waitFor(() => expect(autoLabel(document)).toBe('auto: Olympic bar'));
  });

  it('a remote delete of the session gym while open shows it as deleted and resolves over the whole inventory', async () => {
    const { window, document } = env;
    const world = { locations: [GYM_A, HOME], activeId: HOME.id, session: session({ location_id: GYM_A.id, location_name: 'Gym A' }) };
    await openGymSession(window, world);
    expect(autoLabel(document)).toBe('auto: Olympic bar');

    world.locations = [HOME];
    remoteChange(window);
    await drain();

    await vi.waitFor(() => expect(autoLabel(document)).toBe('auto: Short bar'));
    expect(await gymLabel(document)).toBe('Gym A (deleted)');
  });

  it('our own (non-remote) workout writes do not rebuild the chips', async () => {
    const { window, document } = env;
    const world = { locations: [GYM_A, HOME], activeId: HOME.id, session: session() };
    await openGymSession(window, world);
    const before = window.apiCall.mock.calls.length;

    world.activeId = GYM_A.id;
    window.dispatchEvent(new window.CustomEvent('datastore:changed', {
      detail: { changedTags: ['workout'], source: 'optimistic' },
    }));
    await drain();

    expect(window.apiCall.mock.calls.length).toBe(before);
    expect(autoLabel(document)).toBe('auto: Short bar');
  });
});

describe('features/workout/sessions.js — in-session weight suggestion (med-h5u3)', () => {
  let env;
  let consoleErrorSpy;

  const SUGGESTION = {
    target_weight_kg: 42.5, training_goal: 'strength', equipment: null,
    snap: { raw_kg: 42.5, snapped_kg: 42.5, reason: null },
    last: { weight_kg: 40, reps: 5, effort: 'RPE 8 · 2 RIR', logged_at: '2026-04-20T09:00:00Z' },
  };

  // One done set (40 × 5 from the scalars) + pending rows ghosting 40.
  function mount(window, document, { suggest = SUGGESTION, targetSets = 3 } = {}) {
    installApiCache(window);
    window.loadWorkoutHistoryTab = vi.fn();
    window.apiCall = vi.fn(async (endpoint) => {
      if (String(endpoint).startsWith('/api/workout/exercises/suggest-target')) {
        if (suggest instanceof Error) throw suggest;
        return suggest;
      }
      return [];
    });
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    window.WorkoutSessionsState.logs = [
      { id: 5, exercise_id: 1, exercise_name: 'Bench', sets_completed: 1, reps_completed: 5, weight_kg: 40, notes: '', _targetSets: targetSets },
    ];
    const container = document.getElementById('workout-session-logs');
    window.renderWorkoutSessionLogs(container);
    return container;
  }
  const drain = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };
  const chipOf = (c) => c.querySelector('.wg-workouts-session-exercise__suggest-chip');
  const cardOf = (c) => c.querySelector('.wg-workouts-session-exercise__suggest');
  const weightOf = (c, r) => c.querySelector(`.wg-set[data-row="${r}"] [data-field="weight_kg"]`).getAttribute('aria-label');
  const writes = (window) => window.apiCall.mock.calls.filter(([, method]) => method && method !== 'GET');

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

  it('shows a collapsed Try <kg> chip, asked by plan row', async () => {
    const { window, document } = env;
    const c = mount(window, document);
    await drain();
    const chip = chipOf(c);
    expect(chip).not.toBeNull();
    expect(chip.textContent).toBe('Try 42.5 kg');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(cardOf(c)).toBeNull();
    const url = window.apiCall.mock.calls.map(([e]) => e).find((e) => e.includes('suggest-target'));
    expect(url).toBe('/api/workout/exercises/suggest-target?name=Bench&exercise_id=1&session_id=42');
  });

  it('renders nothing for a null answer or a 404 (bot mode)', async () => {
    const { window, document } = env;
    let c = mount(window, document, { suggest: null });
    await drain();
    expect(chipOf(c)).toBeNull();
    window.WorkoutSessionsState.ui = null;
    c = mount(window, document, { suggest: new Error('404') });
    await drain();
    expect(chipOf(c)).toBeNull();
  });

  it('hides the chip when the first pending row already shows the suggestion, or nothing is pending', async () => {
    const { window, document } = env;
    let c = mount(window, document, { suggest: { ...SUGGESTION, target_weight_kg: 40 } });
    await drain();
    expect(chipOf(c)).toBeNull();
    window.WorkoutSessionsState.ui = null;
    c = mount(window, document, { targetSets: 1 });
    await drain();
    expect(chipOf(c)).toBeNull();
  });

  it('expands to the card (survives a set tick); Apply drafts the pending rows only and writes nothing', async () => {
    const { window, document } = env;
    const c = mount(window, document);
    await drain();
    chipOf(c).click();
    await drain();
    expect(chipOf(c).getAttribute('aria-expanded')).toBe('true');
    expect(cardOf(c).querySelector('.wg-row__title').textContent).toBe('Try 42.5 kg');
    expect(cardOf(c).querySelector('.wg-hint').textContent).toBe('Last: 40 kg × 5 · RPE 8 · 2 RIR');

    // Ticking row 1 at its ghost 40 re-renders every card; the card stays open.
    c.querySelector('.wg-set[data-row="1"] .wg-set__done').click();
    await drain();
    expect(cardOf(c)).not.toBeNull();

    const before = writes(window).length;
    cardOf(c).querySelector('.wg-workouts-session-exercise__suggest-apply').click();
    await drain();
    expect(weightOf(c, 0)).toBe('Weight 40');
    expect(weightOf(c, 1)).toBe('Weight 40');
    expect(weightOf(c, 2)).toBe('Weight 42.5');
    expect(chipOf(c)).toBeNull();
    expect(cardOf(c)).toBeNull();
    // Session only: no log write and no plan (exercises update) write.
    expect(writes(window).length).toBe(before);
    expect(window.apiCall.mock.calls.some(([e]) => String(e).startsWith('/api/workout/exercises/update'))).toBe(false);
  });

  it('Apply covers every pending row; the effort clause is omitted when unrated', async () => {
    const { window, document } = env;
    const c = mount(window, document, { suggest: { ...SUGGESTION, last: { ...SUGGESTION.last, effort: null } } });
    await drain();
    chipOf(c).click();
    await drain();
    expect(cardOf(c).querySelector('.wg-hint').textContent).toBe('Last: 40 kg × 5');
    cardOf(c).querySelector('.wg-workouts-session-exercise__suggest-apply').click();
    await drain();
    expect(weightOf(c, 0)).toBe('Weight 40');
    expect(weightOf(c, 1)).toBe('Weight 42.5');
    expect(weightOf(c, 2)).toBe('Weight 42.5');
    expect(window.apiCall.mock.calls.filter(([e]) => String(e).includes('suggest-target')).length).toBe(1);
  });
});

describe('features/workout/sessions.js — weight check (med-l5yr.5, kit WS1–WS3)', () => {
  let env;
  let consoleErrorSpy;

  // A session (live or opened from History) whose Goblet Squat log holds
  // `sets`; the weight-check route answers `baseline`. The rule itself is the
  // real domain module.
  function mount(window, document, { name = 'Goblet Squat', sets, baseline }) {
    installApiCache(window);
    window.loadWorkoutHistoryTab = vi.fn();
    window.WeightSanity = WeightSanity;
    window.apiCall = vi.fn(async (endpoint) => {
      if (String(endpoint).startsWith('/api/workout/exercises/weight-check')) return baseline;
      if (String(endpoint).startsWith('/api/workout/sessions/logs/update')) return { id: 5 };
      return [];
    });
    window.WorkoutSessionsState.data = { id: 42, status: 'completed' };
    window.WorkoutSessionsState.originalStatus = 'completed';
    window.WorkoutSessionsState.logs = [
      { id: 5, exercise_id: 1, exercise_name: name, status: 'completed', sets: sets.map((weight_kg, i) => ({ set_index: i, weight_kg, reps: 8, set_type: 'normal' })), notes: '' },
    ];
    _syncScalars(window.WorkoutSessionsState.logs[0]);
    const container = document.getElementById('workout-session-logs');
    window.renderWorkoutSessionLogs(container);
    return container;
  }
  function _syncScalars(log) {
    log.sets_completed = log.sets.length;
    log.reps_completed = 8;
    log.weight_kg = Math.max(...log.sets.map((s) => s.weight_kg));
  }
  const drain = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };
  const notes = (c) => [...c.querySelectorAll('.wg-note--warn')];
  const updates = (window) => window.apiCall.mock.calls.filter(([e]) => e === '/api/workout/sessions/logs/update');
  const HEAVIEST_50 = { prior_logs: 5, heaviest_kg: 50, unweighted: false };

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

  it('notes the jump under the flagged set with the reference; the kg cell says check', async () => {
    const { window, document } = env;
    const c = mount(window, document, { sets: [50, 255, 50], baseline: HEAVIEST_50 });
    await drain();
    expect(window.apiCall.mock.calls.map(([e]) => e))
      .toContain('/api/workout/exercises/weight-check?name=Goblet%20Squat&session_id=42&log_id=5');
    expect(notes(c)).toHaveLength(1);
    expect(notes(c)[0].textContent).toContain('255 kg is 5× your heaviest 50 kg. A typo?');
    // The note sits right under set 2.
    expect(notes(c)[0].previousElementSibling.dataset.row).toBe('1');
    expect(c.querySelector('.wg-set[data-row="1"] [data-field="weight_kg"] small').textContent).toBe('check');
    expect(c.querySelector('.wg-set[data-row="0"] [data-field="weight_kg"] small')).toBeNull();
  });

  it("It's right stores confirmed on the set and clears the note for good", async () => {
    const { window, document } = env;
    const c = mount(window, document, { sets: [50, 255, 50], baseline: HEAVIEST_50 });
    await drain();
    [...notes(c)[0].querySelectorAll('button')].find((b) => b.textContent === "It's right").click();
    expect(notes(c)).toHaveLength(0);
    await window.saveWorkoutSessionDetails({ fromAutosave: true });
    const sent = updates(window).at(-1)[2].sets;
    expect(sent.map((s) => s.confirmed === true)).toEqual([false, true, false]);
    expect(sent[1].weight_kg).toBe(255);
  });

  it('a flagged set is saved as logged (never blocked); editing the weight re-judges it', async () => {
    const { window, document } = env;
    const c = mount(window, document, { sets: [50, 50], baseline: HEAVIEST_50 });
    await drain();
    window.updateLocalSet(0, 1, 'weight_kg', 255);
    expect(notes(c)).toHaveLength(1);
    await window.saveWorkoutSessionDetails({ fromAutosave: true });
    expect(updates(window).at(-1)[2].sets.map((s) => s.weight_kg)).toEqual([50, 255]);
    window.updateLocalSet(0, 1, 'weight_kg', 25.5);
    expect(notes(c)).toHaveLength(0);
  });

  it('a saved edit to an earlier log re-reads a later log\'s baseline; a read started before it never writes back', async () => {
    const { window, document } = env;
    installApiCache(window);
    window.loadWorkoutHistoryTab = vi.fn();
    window.WeightSanity = WeightSanity;
    // Log B (id 5, 110 kg) is judged after log A (id 4) of the same exercise.
    let heaviest = 60;
    const stale = deferred();
    let first = true;
    window.apiCall = vi.fn(async (endpoint) => {
      const e = String(endpoint);
      if (e.startsWith('/api/workout/exercises/weight-check')) {
        if (!e.endsWith('log_id=5')) return { prior_logs: 3, heaviest_kg: 50, unweighted: false };
        if (first) { first = false; return stale.promise; }
        return { prior_logs: 4, heaviest_kg: heaviest, unweighted: false };
      }
      if (e === '/api/workout/sessions/logs/update') return { id: 4 };
      return [];
    });
    const set = (kg) => [{ set_index: 0, weight_kg: kg, reps: 8, set_type: 'normal' }];
    window.WorkoutSessionsState.data = { id: 42, status: 'completed' };
    window.WorkoutSessionsState.originalStatus = 'completed';
    window.WorkoutSessionsState.logs = [
      { id: 4, exercise_id: 1, exercise_name: 'Goblet Squat', status: 'completed', sets: set(60), sets_completed: 1, reps_completed: 8, weight_kg: 60, notes: '' },
      { id: 5, exercise_id: 2, exercise_name: 'goblet squat', status: 'completed', sets: set(110), sets_completed: 1, reps_completed: 8, weight_kg: 110, notes: '' },
    ];
    const c = document.getElementById('workout-session-logs');
    const show = (i) => { window.WorkoutSessionsState.ui.current = i; window.renderWorkoutSessionLogs(c); };
    window.renderWorkoutSessionLogs(c);
    show(1); // B's first read is in flight (it will answer the old 60)
    await drain();

    // Edit A to 50 and save: B is re-read against the new history.
    show(0);
    window.updateLocalSet(0, 0, 'weight_kg', 50);
    heaviest = 50;
    await window.saveWorkoutSessionDetails({ fromAutosave: true });
    show(1);
    await drain();
    expect(notes(c)).toHaveLength(1);
    expect(notes(c)[0].textContent).toContain('your heaviest 50 kg');

    // The read from before the edit lands late: ignored.
    stale.resolve({ prior_logs: 4, heaviest_kg: 60, unweighted: false });
    await drain();
    show(1);
    expect(notes(c)).toHaveLength(1);
  });

  it('no note before three earlier logs', async () => {
    const { window, document } = env;
    const c = mount(window, document, { sets: [50, 255], baseline: { ...HEAVIEST_50, prior_logs: 2 } });
    await drain();
    expect(notes(c)).toHaveLength(0);
  });

  it('kg on a band: Clear kg sets 0, Keep 75 kg confirms', async () => {
    const { window, document } = env;
    const band = { prior_logs: 0, heaviest_kg: 0, unweighted: true };
    let c = mount(window, document, { name: 'Band pull-apart', sets: [75], baseline: band });
    await drain();
    expect(notes(c)[0].textContent).toContain('A band has no weight in kg. Log reps only?');
    [...notes(c)[0].querySelectorAll('button')].find((b) => b.textContent === 'Clear kg').click();
    expect(window.WorkoutSessionsState.logs[0].sets[0].weight_kg).toBe(0);
    expect(notes(c)).toHaveLength(0);

    window.WorkoutSessionsState.ui = null;
    c = mount(window, document, { name: 'Band pull-apart', sets: [75], baseline: band });
    await drain();
    [...notes(c)[0].querySelectorAll('button')].find((b) => b.textContent === 'Keep 75 kg').click();
    expect(window.WorkoutSessionsState.logs[0].sets[0].confirmed).toBe(true);
    expect(notes(c)).toHaveLength(0);
  });
});
