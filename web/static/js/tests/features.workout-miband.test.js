// Focused integration tests for the extracted features/workout/miband.js
// sub-file. Covers the WorkoutMiBand public-API surface and the
// closure-private current-entry state exposed via WorkoutMiBandState.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('features/workout/miband.js — split-file integration', () => {
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

  it('exposes the WorkoutMiBand public-API namespace + WorkoutMiBandState accessor', () => {
    const { window } = env;
    expect(window.WorkoutMiBand).toBeTypeOf('object');
    expect(window.WorkoutMiBand.open).toBeTypeOf('function');
    expect(window.WorkoutMiBand.close).toBeTypeOf('function');
    expect(window.WorkoutMiBand.save).toBeTypeOf('function');
    // Deletion moved out of the modal onto the Cardio history row's trash
    // icon, so the modal-bound `delete` entry (and its Delete button) are gone.
    expect(window.WorkoutMiBand.delete).toBeUndefined();
    expect(window.deleteMiBandWorkoutById).toBeTypeOf('function');

    expect('current' in window.WorkoutMiBandState).toBe(true);
    expect(window.WorkoutMiBandState.current).toBeNull();
  });

  it('the modal header carries Cancel + Save only — no Delete button', () => {
    const { document } = env;
    expect(document.getElementById('miband-workout-delete-btn')).toBeNull();
    expect(document.getElementById('miband-workout-cancel-btn')).not.toBeNull();
    expect(document.getElementById('miband-workout-save-btn')).not.toBeNull();
  });

  it('deleteMiBandWorkoutById deletes by id without needing the modal open', async () => {
    const { window } = env;
    window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });
    const apiCallSpy = vi.fn(async () => true);
    window.apiCall = apiCallSpy;
    window.loadWorkoutHistoryTab = vi.fn();
    window.WorkoutMiBandState.current = null;

    await window.deleteMiBandWorkoutById(42);

    expect(window.safeConfirm).toHaveBeenCalled();
    expect(apiCallSpy).toHaveBeenCalledWith('/api/workout/miband/42', 'DELETE');
    expect(window.loadWorkoutHistoryTab).toHaveBeenCalled();
  });

  it('deleteMiBandWorkoutById skips the API when the confirm is declined', async () => {
    const { window } = env;
    window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(false); });
    const apiCallSpy = vi.fn();
    window.apiCall = apiCallSpy;

    await window.deleteMiBandWorkoutById(42);

    expect(apiCallSpy).not.toHaveBeenCalled();
  });

  it('deleteMiBandWorkoutById alerts instead of throwing when the API rejects', async () => {
    const { window } = env;
    window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });
    window.apiCall = vi.fn(async () => { throw new Error('boom'); });
    window.safeAlert = vi.fn();
    window.loadWorkoutHistoryTab = vi.fn();

    await window.deleteMiBandWorkoutById(42);

    expect(window.safeAlert).toHaveBeenCalled();
    expect(window.loadWorkoutHistoryTab).not.toHaveBeenCalled();
  });

  it('showMiBandWorkoutModal stores the workout in closure-private state + fills form fields', () => {
    const { window, document } = env;
    const workout = {
      id: 42,
      steps: 1234,
      distance_m: 5000,
      duration_sec: 1800,
      calories: 250,
      heart_rate_avg: 120,
      spo2_avg: 97
    };

    window.showMiBandWorkoutModal(workout);

    expect(window.WorkoutMiBandState.current).toBe(workout);
    expect(document.getElementById('miband-workout-id').value).toBe('42');
    expect(document.getElementById('miband-workout-steps').value).toBe('1234');
    expect(document.getElementById('miband-workout-distance').value).toBe('5000');
    expect(document.getElementById('miband-workout-duration').value).toBe('1800');
    expect(document.getElementById('miband-workout-calories').value).toBe('250');
    expect(document.getElementById('miband-workout-hr').value).toBe('120');
    expect(document.getElementById('miband-workout-spo2').value).toBe('97');
  });

  it('closeMiBandWorkoutModal clears the closure-private current entry', () => {
    const { window } = env;
    window.WorkoutMiBandState.current = { id: 7, steps: 100 };

    window.closeMiBandWorkoutModal();

    expect(window.WorkoutMiBandState.current).toBeNull();
  });

  it('saveMiBandWorkout returns without calling API when no current entry is set', async () => {
    const { window } = env;
    const apiCallSpy = vi.fn();
    window.apiCall = apiCallSpy;
    window.WorkoutMiBandState.current = null;

    await window.saveMiBandWorkout();

    expect(apiCallSpy).not.toHaveBeenCalled();
  });
});
