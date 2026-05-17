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

  it('closeWorkoutSessionModal clears the session data state', () => {
    const { window } = env;
    window.WorkoutSessionsState.data = { id: 7, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';

    window.closeWorkoutSessionModal();

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

  it('saveWorkoutSessionDetails settles optimistic handles on partial failure (status ok, log update fails)', async () => {
    const { window, document } = env;
    installApiCache(window, {
      workout_history: {
        sessions: [{
          session: { id: 42, status: 'in_progress' },
          group_name: 'Push',
          exercises_count: 1,
          exercises_completed: 1
        }],
        miband: []
      }
    });
    window.loadWorkoutHistoryTab = vi.fn();
    window.WorkoutSessionsState.data = { id: 42, status: 'in_progress' };
    window.WorkoutSessionsState.originalStatus = 'in_progress';
    window.WorkoutSessionsState.logs = [{
      id: 7,
      exercise_name: 'Bench',
      sets_completed: 3,
      reps_completed: 8,
      weight_kg: 80,
      notes: ''
    }];

    window.renderWorkoutSessionInfo(document.getElementById('workout-session-info'), {
      id: 42, status: 'in_progress', scheduled_date: '2026-04-22', scheduled_time: '09:00', variant_name: 'Push'
    });
    document.getElementById('session-status-select').value = 'completed';

    // Status PUT succeeds, but the subsequent log update returns null
    // (offline / 5xx). Without the partial-success commit, the optimistic
    // handles never settle and pendingOptimistic stays >0 forever — every
    // future fetchFresh for workout_history / workout_next would short-circuit.
    window.apiCall = vi.fn(async (endpoint) => {
      if (endpoint.startsWith('/api/workout/sessions/status')) return { ok: true };
      if (endpoint.startsWith('/api/workout/sessions/logs/update')) return null;
      return [];
    });

    await window.saveWorkoutSessionDetails();

    // Both optimistic keys must be free of a pending handle so future reads
    // can refresh. This is the property whose violation caused the bug.
    expect(window.DataStore.hasPendingOptimistic('workout_history')).toBe(false);
    expect(window.DataStore.hasPendingOptimistic('workout_next')).toBe(false);
  });
});
