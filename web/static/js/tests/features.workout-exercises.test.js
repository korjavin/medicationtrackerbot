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

  describe('progression-rule selector (Phase 4, med-qj4.4.1)', () => {
    it('renders the progression select + increment input in the exercise modal', () => {
      const { document } = env;
      const select = document.getElementById('workout-exercise-progression');
      expect(select).not.toBeNull();
      expect(select.tagName).toBe('SELECT');
      expect(Array.from(select.options).map(o => o.value)).toEqual(['none', 'linear', 'double']);

      const increment = document.getElementById('workout-exercise-progression-increment');
      expect(increment).not.toBeNull();
      expect(increment.type).toBe('number');
    });

    it('saveExercise includes a linear progression_rule with the increment in the payload', async () => {
      const { window, document } = env;
      const apiSpy = vi.fn(async () => ({ ok: true }));
      window.apiCall = apiSpy;
      window.invalidateWorkoutCache = vi.fn(async () => {});
      window.loadExercisesForVariant = vi.fn();
      window.WorkoutEdit.variantForExercise = 3;

      document.getElementById('workout-exercise-name').value = 'Squat';
      document.getElementById('workout-exercise-sets').value = '4';
      document.getElementById('workout-exercise-reps-min').value = '8';
      document.getElementById('workout-exercise-progression').value = 'linear';
      document.getElementById('workout-exercise-progression-increment').value = '5';

      await window.saveExercise();

      expect(apiSpy).toHaveBeenCalledWith(
        '/api/workout/exercises/create',
        'POST',
        expect.objectContaining({
          progression_rule: { type: 'linear', increment_kg: 5 }
        })
      );
    });

    it('saveExercise sends {type:none} when progression is None', async () => {
      const { window, document } = env;
      const apiSpy = vi.fn(async () => ({ ok: true }));
      window.apiCall = apiSpy;
      window.invalidateWorkoutCache = vi.fn(async () => {});
      window.loadExercisesForVariant = vi.fn();
      window.WorkoutEdit.variantForExercise = 3;

      document.getElementById('workout-exercise-name').value = 'Squat';
      document.getElementById('workout-exercise-sets').value = '4';
      document.getElementById('workout-exercise-reps-min').value = '8';
      document.getElementById('workout-exercise-progression').value = 'none';

      await window.saveExercise();

      expect(apiSpy.mock.calls[0][2].progression_rule).toEqual({ type: 'none' });
    });

    it('showAddExerciseModal clears the progression selector back to None', async () => {
      const { window, document } = env;
      window.WorkoutEdit.variantForExercise = 1;
      window.apiCall = vi.fn(async () => []);
      window.WorkoutLibrary = { populatePickerOptions: vi.fn(async () => {}) };

      document.getElementById('workout-exercise-progression').value = 'double';
      document.getElementById('workout-exercise-progression-increment').value = '10';

      await window.showAddExerciseModal();

      expect(document.getElementById('workout-exercise-progression').value).toBe('none');
      expect(document.getElementById('workout-exercise-progression-increment').value).toBe('');
    });

    it('showEditExerciseModal populates the selector from the exercise progression_rule', async () => {
      const { window, document } = env;
      window.WorkoutEdit.variantForExercise = 1;
      window.apiCall = vi.fn(async () => [{
        id: 7,
        exercise_name: 'Bench',
        target_sets: 3,
        target_reps_min: 8,
        target_reps_max: 10,
        target_weight_kg: 40,
        order_index: 0,
        progression_rule: { type: 'linear', increment_kg: 2.5 }
      }]);

      await window.showEditExerciseModal(7);

      expect(document.getElementById('workout-exercise-progression').value).toBe('linear');
      expect(document.getElementById('workout-exercise-progression-increment').value).toBe('2.5');
    });
  });
});
