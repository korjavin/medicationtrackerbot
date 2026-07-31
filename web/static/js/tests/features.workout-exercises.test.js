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

    it('showAddExerciseModal clears the increment and seeds progression from the routine goal', async () => {
      const { window, document } = env;
      window.WorkoutEdit.variantForExercise = 1;
      window.apiCall = vi.fn(async () => []);
      window.WorkoutLibrary = { populatePickerOptions: vi.fn(async () => {}) };

      document.getElementById('workout-exercise-progression').value = 'linear';
      document.getElementById('workout-exercise-progression-increment').value = '10';

      await window.showAddExerciseModal();

      // No cached routine → the cascade defaults to hypertrophy (double); the
      // stale increment is still cleared by the reset.
      expect(document.getElementById('workout-exercise-progression').value).toBe('double');
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

  describe('training-goal override + cascade (med-qj4.6.1)', () => {
    function seedRoutine(goal) {
      env.window.WorkoutEdit.cachedGroups = [{ id: 5, training_goal: goal }];
      env.window.WorkoutEdit.groupForVariant = 5;
      env.window.WorkoutEdit.variantForExercise = 1;
    }

    it('renders the goal selector with Inherit + the four goals', () => {
      const { document } = env;
      const sel = document.getElementById('workout-exercise-goal');
      expect(sel).not.toBeNull();
      expect(sel.tagName).toBe('SELECT');
      expect(Array.from(sel.options).map(o => o.value)).toEqual(['', 'strength', 'hypertrophy', 'endurance', 'general']);
    });

    it('showAddExerciseModal inherits the routine goal and pre-fills its defaults', async () => {
      const { window, document } = env;
      seedRoutine('strength');
      window.apiCall = vi.fn(async () => []);
      window.WorkoutLibrary = { populatePickerOptions: vi.fn(async () => {}) };

      await window.showAddExerciseModal();

      expect(document.getElementById('workout-exercise-goal').value).toBe('');
      expect(document.getElementById('workout-exercise-reps-min').value).toBe('3');
      expect(document.getElementById('workout-exercise-reps-max').value).toBe('6');
      expect(document.getElementById('workout-exercise-progression').value).toBe('linear');
    });

    it('changing the goal pre-fills the rep-range + progression preset', async () => {
      const { window, document } = env;
      seedRoutine('strength');
      window.apiCall = vi.fn(async () => []);
      window.WorkoutLibrary = { populatePickerOptions: vi.fn(async () => {}) };
      await window.showAddExerciseModal();

      const sel = document.getElementById('workout-exercise-goal');
      sel.value = 'endurance';
      sel.dispatchEvent(new window.Event('change'));

      expect(document.getElementById('workout-exercise-reps-min').value).toBe('15');
      expect(document.getElementById('workout-exercise-reps-max').value).toBe('25');
      expect(document.getElementById('workout-exercise-progression').value).toBe('double');
    });

    it('selecting Inherit resolves to the routine goal', async () => {
      const { window, document } = env;
      seedRoutine('strength');
      window.apiCall = vi.fn(async () => []);
      window.WorkoutLibrary = { populatePickerOptions: vi.fn(async () => {}) };
      await window.showAddExerciseModal();

      const sel = document.getElementById('workout-exercise-goal');
      sel.value = '';
      sel.dispatchEvent(new window.Event('change'));

      expect(document.getElementById('workout-exercise-reps-min').value).toBe('3');
      expect(document.getElementById('workout-exercise-reps-max').value).toBe('6');
    });

    it('an unsaved live goal change (group modal open) wins over stale cachedGroups', async () => {
      const { window, document } = env;
      // Saved goal is hypertrophy; user opened the plan editor and switched the
      // goal to strength but has NOT saved yet, so cachedGroups is still stale.
      seedRoutine('hypertrophy');
      const groupModal = document.getElementById('workout-group-modal');
      groupModal.classList.remove('hidden');
      document.getElementById('workout-group-goal').value = 'strength';
      window.apiCall = vi.fn(async () => []);
      window.WorkoutLibrary = { populatePickerOptions: vi.fn(async () => {}) };

      await window.showAddExerciseModal();

      // Cascade seeds strength defaults (3/6, linear), not the stale hypertrophy.
      expect(document.getElementById('workout-exercise-reps-min').value).toBe('3');
      expect(document.getElementById('workout-exercise-reps-max').value).toBe('6');
      expect(document.getElementById('workout-exercise-progression').value).toBe('linear');
    });

    it('showEditExerciseModal shows the stored override without clobbering stored fields', async () => {
      const { window, document } = env;
      seedRoutine('strength');
      window.apiCall = vi.fn(async () => [{
        id: 9,
        exercise_name: 'Curl',
        target_sets: 3,
        target_reps_min: 8,
        target_reps_max: 10,
        order_index: 0,
        progression_rule: { type: 'linear', increment_kg: 2.5 },
        training_goal: 'endurance'
      }]);

      await window.showEditExerciseModal(9);

      expect(document.getElementById('workout-exercise-goal').value).toBe('endurance');
      // Stored values kept — the cascade only fires on a change, not on open.
      expect(document.getElementById('workout-exercise-reps-min').value).toBe('8');
      expect(document.getElementById('workout-exercise-reps-max').value).toBe('10');
      expect(document.getElementById('workout-exercise-progression').value).toBe('linear');
    });

    it('a library pick during Edit does not clobber stored reps (Add handler leak)', async () => {
      const { window, document } = env;
      seedRoutine('strength');
      // Open Add once so its name-input onchange handler + datalist get bound;
      // that handler persists on the shared name input into the Edit open below.
      window.apiCall = vi.fn(async () => []);
      window.WorkoutLibrary = {
        populatePickerOptions: vi.fn(async (dl) => {
          const opt = document.createElement('option');
          opt.value = 'Curl';
          opt.dataset.repsMin = '12';
          opt.dataset.repsMax = '15';
          dl.appendChild(opt);
        })
      };
      await window.showAddExerciseModal();

      // Now edit an existing exercise with the user's own 5–8 rep targets.
      window.apiCall = vi.fn(async () => [{
        id: 9,
        exercise_name: 'Row',
        target_sets: 3,
        target_reps_min: 5,
        target_reps_max: 8,
        order_index: 0,
        progression_rule: { type: 'linear', increment_kg: 2.5 },
        training_goal: ''
      }]);
      await window.showEditExerciseModal(9);

      // User renames to a library match — the leaked handler must NOT overwrite
      // the stored reps in Edit mode.
      const nameInput = document.getElementById('workout-exercise-name');
      nameInput.value = 'Curl';
      nameInput.dispatchEvent(new window.Event('change'));

      expect(document.getElementById('workout-exercise-reps-min').value).toBe('5');
      expect(document.getElementById('workout-exercise-reps-max').value).toBe('8');
    });

    it('saveExercise includes the training_goal override in the payload', async () => {
      const { window, document } = env;
      const apiSpy = vi.fn(async () => ({ ok: true }));
      window.apiCall = apiSpy;
      window.invalidateWorkoutCache = vi.fn(async () => {});
      window.loadExercisesForVariant = vi.fn();
      window.WorkoutEdit.variantForExercise = 3;

      document.getElementById('workout-exercise-name').value = 'Squat';
      document.getElementById('workout-exercise-sets').value = '4';
      document.getElementById('workout-exercise-reps-min').value = '8';
      document.getElementById('workout-exercise-goal').value = 'strength';

      await window.saveExercise();

      expect(apiSpy.mock.calls[0][2].training_goal).toBe('strength');
    });
  });

  // med-3q8.1 — the plan add-exercise picker used to dump all 1324 catalog
  // names into #exercise-library-datalist, which mobile renders as a
  // full-screen suggestion sheet instead of a short list above the keyboard.
  describe('add-exercise picker type-ahead (med-3q8.1)', () => {
    const CATALOG = {
      exercises: [
        { name: 'Barbell bench press' },
        { name: 'Dumbbell bench press' },
        { name: '3/4 sit-up' },
      ],
    };

    function stubEnv(window) {
      window.fetch = vi.fn(async (url) => (
        String(url).includes('exercises-catalog.json')
          ? { ok: true, status: 200, json: async () => CATALOG }
          : { ok: true, status: 200, json: async () => ({}) }
      ));
      window.apiCall = vi.fn(async (endpoint) => (
        endpoint === '/api/workout/exercise-library'
          ? [{ id: 3, name: 'My custom lift', default_sets: 4, default_reps_min: 8, default_weight_kg: 60 }]
          : []
      ));
      window.WorkoutEdit.variantForExercise = 1;
    }

    // med-max — the library half is type-ahead filtered too now, so the plan
    // modal opens with an empty popup instead of the whole library.
    it('opens with an EMPTY datalist, then filters library-then-catalog as the user types', async () => {
      const { window, document } = env;
      stubEnv(window);

      await window.showAddExerciseModal();

      const datalist = document.getElementById('exercise-library-datalist');
      expect(Array.from(datalist.options)).toHaveLength(0);

      const nameInput = document.getElementById('workout-exercise-name');
      // One character: the library half only — the catalog stays gated at 2.
      nameInput.value = 'l';
      await nameInput.oninput();
      expect(Array.from(datalist.options).map((o) => o.value)).toEqual(['My custom lift']);

      nameInput.value = 'bench';
      await nameInput.oninput();
      const values = Array.from(datalist.options).map((o) => o.value);
      expect(values).toEqual(['Barbell bench press', 'Dumbbell bench press']);
      expect(values).not.toContain('3/4 sit-up');
    });

    it('a catalog-only pick stays re-findable in the datalist and carries no library id', async () => {
      const { window, document } = env;
      stubEnv(window);
      await window.showAddExerciseModal();

      const datalist = document.getElementById('exercise-library-datalist');
      const nameInput = document.getElementById('workout-exercise-name');
      // Picking from the native dropdown fires `input` then `change`.
      nameInput.value = 'Barbell bench press';
      await nameInput.oninput();
      nameInput.dispatchEvent(new window.Event('change'));

      const picked = Array.from(datalist.options).find((o) => o.value === 'Barbell bench press');
      expect(picked).toBeDefined();
      expect(picked.dataset.id).toBeUndefined(); // → routed through resolveOrCreateLibraryId on save
    });

    it('a library pick still autofills sets/reps/weight after filtering', async () => {
      const { window, document } = env;
      stubEnv(window);
      await window.showAddExerciseModal();

      const nameInput = document.getElementById('workout-exercise-name');
      nameInput.value = 'My custom lift';
      await nameInput.oninput();
      nameInput.dispatchEvent(new window.Event('change'));

      expect(document.getElementById('workout-exercise-sets').value).toBe('4');
      expect(document.getElementById('workout-exercise-reps-min').value).toBe('8');
      expect(document.getElementById('workout-exercise-weight').value).toBe('60');
    });
  });
});
