// Focused integration tests for the extracted features/workout/exercises.js
// sub-file. Verifies that the closure-private editing state is reachable via
// the window.WorkoutEdit accessors, and that open-edit / save / close flows
// behave as the orchestrator expects.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('features/workout/exercises.js — split-file integration', () => {
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

  it('exposes the WorkoutExercises public-API namespace + WorkoutEdit accessors', () => {
    const { window } = env;
    expect(window.WorkoutExercises).toBeTypeOf('object');
    expect(window.WorkoutExercises.load).toBeTypeOf('function');
    expect(window.WorkoutExercises.save).toBeTypeOf('function');
    expect(window.WorkoutExercises.openAdd).toBeTypeOf('function');
    expect(window.WorkoutExercises.openEdit).toBeTypeOf('function');
    expect(window.WorkoutExercises.close).toBeTypeOf('function');
    expect(window.WorkoutExercises.delete).toBeTypeOf('function');

    expect('editingExerciseId' in window.WorkoutEdit).toBe(true);
    expect('variantForExercise' in window.WorkoutEdit).toBe(true);
    expect('exercisesContainerId' in window.WorkoutEdit).toBe(true);
    expect(window.WorkoutEdit.editingExerciseId).toBeNull();
    expect(window.WorkoutEdit.variantForExercise).toBeNull();
    expect(window.WorkoutEdit.exercisesContainerId).toBe('workout-exercises-list');
  });

  it('saveExercise validates required fields without calling the API', async () => {
    const { window, document } = env;
    const apiCallSpy = vi.fn();
    window.apiCall = apiCallSpy;
    window.Telegram.WebApp.showAlert = vi.fn();

    // Set variant context but leave name/sets/reps empty
    window.WorkoutEdit.variantForExercise = 1;
    document.getElementById('workout-exercise-name').value = '';
    document.getElementById('workout-exercise-sets').value = '';
    document.getElementById('workout-exercise-reps-min').value = '';

    await window.saveExercise();

    expect(apiCallSpy).not.toHaveBeenCalled();
    expect(window.Telegram.WebApp.showAlert).toHaveBeenCalledTimes(1);
  });

  it('closeExerciseModal clears the closure-private editingExerciseId', () => {
    const { window } = env;
    window.WorkoutEdit.editingExerciseId = 77;

    window.closeExerciseModal();

    expect(window.WorkoutEdit.editingExerciseId).toBeNull();
  });

  it('exercisesContainerId setter defaults to workout-exercises-list when set to falsy', () => {
    const { window } = env;
    window.WorkoutEdit.exercisesContainerId = 'workout-group-flat-exercises-list';
    expect(window.WorkoutEdit.exercisesContainerId).toBe('workout-group-flat-exercises-list');

    window.WorkoutEdit.exercisesContainerId = '';
    expect(window.WorkoutEdit.exercisesContainerId).toBe('workout-exercises-list');
  });
});
