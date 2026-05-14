// Focused integration tests for the extracted features/workout/sessions.js
// sub-file. Covers the WorkoutSessions public-API surface and the
// closure-private session state exposed via window.WorkoutSessionsState.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

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
});
