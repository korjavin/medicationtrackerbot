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
      window.WorkoutLibrary = { bindExercisePicker: vi.fn(async () => {}) };

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
      window.WorkoutLibrary = { bindExercisePicker: vi.fn(async () => {}) };

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
      window.WorkoutLibrary = { bindExercisePicker: vi.fn(async () => {}) };
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
      window.WorkoutLibrary = { bindExercisePicker: vi.fn(async () => {}) };
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
      window.WorkoutLibrary = { bindExercisePicker: vi.fn(async () => {}) };

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
      // Open Add once so the picker gets bound to the shared name input; it
      // stays wired into the Edit open below.
      window.apiCall = vi.fn(async (endpoint) => (
        endpoint === '/api/workout/exercise-library'
          ? [{ id: 4, name: 'Curl', default_reps_min: 12, default_reps_max: 15 }]
          : []
      ));
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

      // User renames to a library match — the leaked picker must NOT overwrite
      // the stored reps in Edit mode.
      const nameInput = document.getElementById('workout-exercise-name');
      const mount = document.getElementById('workout-exercise-suggest');
      nameInput.value = 'Curl';
      await nameInput.oninput();
      mount.querySelector('.wg-exercise-suggest__row').click();

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

  // med-3q8.1 / med-max — the plan add-exercise picker used to dump the whole
  // library plus all 1324 catalog names into a native <datalist>, which mobile
  // renders as a half-screen sheet over the keyboard. It is now our own inline
  // list under the field.
  describe('add-exercise picker (med-3q8.1, med-max)', () => {
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

    function rowsOf(mount) {
      return Array.from(mount.querySelectorAll('.wg-exercise-suggest__row')).map((b) => b.textContent);
    }

    it('opens with NO suggestion list, then filters library-then-catalog as the user types', async () => {
      const { window, document } = env;
      stubEnv(window);

      await window.showAddExerciseModal();

      const mount = document.getElementById('workout-exercise-suggest');
      expect(mount.hidden).toBe(true);

      const nameInput = document.getElementById('workout-exercise-name');
      // One character: the library half only — the catalog stays gated at 2.
      nameInput.value = 'l';
      await nameInput.oninput();
      expect(rowsOf(mount)).toEqual(['My custom lift']);

      nameInput.value = 'bench';
      await nameInput.oninput();
      expect(rowsOf(mount)).toEqual(['Barbell bench press', 'Dumbbell bench press']);
    });

    it('a catalog-only pick fills the name and pre-fills nothing (no library id)', async () => {
      const { window, document } = env;
      stubEnv(window);
      await window.showAddExerciseModal();

      const mount = document.getElementById('workout-exercise-suggest');
      const nameInput = document.getElementById('workout-exercise-name');
      nameInput.value = 'bench';
      await nameInput.oninput();
      mount.querySelector('.wg-exercise-suggest__row').click();

      expect(nameInput.value).toBe('Barbell bench press');
      expect(mount.hidden).toBe(true);
      // No id and no defaults, so save routes it through resolveOrCreateLibraryId.
      expect(document.getElementById('workout-exercise-sets').value).toBe('');
      expect(document.getElementById('workout-exercise-weight').value).toBe('');
    });

    it('a library pick fills the name and autofills sets/reps/weight', async () => {
      const { window, document } = env;
      stubEnv(window);
      await window.showAddExerciseModal();

      const mount = document.getElementById('workout-exercise-suggest');
      const nameInput = document.getElementById('workout-exercise-name');
      nameInput.value = 'custom';
      await nameInput.oninput();
      mount.querySelector('.wg-exercise-suggest__row').click();

      expect(nameInput.value).toBe('My custom lift');
      expect(document.getElementById('workout-exercise-sets').value).toBe('4');
      expect(document.getElementById('workout-exercise-reps-min').value).toBe('8');
      expect(document.getElementById('workout-exercise-weight').value).toBe('60');
    });

    it('a free-typed brand-new name (never picked) still saves', async () => {
      const { window, document } = env;
      stubEnv(window);
      await window.showAddExerciseModal();
      window.invalidateWorkoutCache = vi.fn(async () => {});
      window.loadExercisesForVariant = vi.fn();

      const nameInput = document.getElementById('workout-exercise-name');
      nameInput.value = 'Zercher squat';
      await nameInput.oninput();
      document.getElementById('workout-exercise-sets').value = '3';
      document.getElementById('workout-exercise-reps-min').value = '8';

      await window.saveExercise();

      expect(window.apiCall).toHaveBeenCalledWith(
        '/api/workout/exercises/create',
        'POST',
        expect.objectContaining({ exercise_name: 'Zercher squat' })
      );
    });
  });

  // med-73o. The goal cascade can seed every target on this form except the one
  // that is not a preference — the weight. That number comes from the user's own
  // logged history via GET /api/workout/exercises/suggest-target, and it is
  // fill-only in exactly the sense the rep range already is.
  describe('weight suggestion from history (med-73o)', () => {
    const RATED = {
      target_weight_kg: 102.5,
      training_goal: 'strength',
      last: { weight_kg: 100, reps: 6, effort: 'RPE 8 · 2 RIR', logged_at: '2026-07-30T10:00:00Z' },
    };

    function stubSuggest(window, suggestion, exercises = []) {
      window.WorkoutEdit.variantForExercise = 1;
      window.WorkoutLibrary = { bindExercisePicker: vi.fn(async () => {}) };
      window.apiCall = vi.fn(async (url) => {
        if (String(url).startsWith('/api/workout/exercises/suggest-target')) return suggestion;
        if (String(url).startsWith('/api/workout/exercises?')) return exercises;
        return [];
      });
    }

    const hintOf = (document) => document.getElementById('workout-exercise-weight-hint');

    async function typeName(document, name) {
      const nameEl = document.getElementById('workout-exercise-name');
      nameEl.value = name;
      await nameEl.onchange();
    }

    it('fills the empty weight field and shows the source set, RPE included', async () => {
      const { window, document } = env;
      stubSuggest(window, RATED);
      await window.showAddExerciseModal();

      await typeName(document, 'Squat');

      expect(document.getElementById('workout-exercise-weight').value).toBe('102.5');
      expect(hintOf(document).hidden).toBe(false);
      expect(hintOf(document).textContent).toBe('Last: 100 kg × 6 · RPE 8 · 2 RIR');
      // The read carries the name AND the effective goal — the suggestion is
      // goal-differentiated, so asking without one would answer for hypertrophy.
      expect(window.apiCall).toHaveBeenCalledWith(
        '/api/workout/exercises/suggest-target?name=Squat&goal=hypertrophy');
    });

    it('ignores a slow response for a name the user has already changed away from', async () => {
      const { window, document } = env;
      stubSuggest(window, RATED);
      await window.showAddExerciseModal();

      // Squat's read resolves only after Bench's has already landed — the
      // interleave a plain `await` would let write Squat's weight into a form
      // that now says Bench.
      const gate = {};
      gate.release = () => {};
      const pending = new Promise((resolve) => { gate.release = resolve; });
      window.apiCall = vi.fn(async (url) => {
        const u = String(url);
        if (u.includes('suggest-target') && u.includes('Squat')) {
          await pending;
          return RATED;
        }
        if (u.includes('suggest-target') && u.includes('Bench')) {
          return {
            target_weight_kg: 60,
            training_goal: 'hypertrophy',
            last: { weight_kg: 57.5, reps: 8, effort: null, logged_at: '2026-07-31T10:00:00Z' },
          };
        }
        return [];
      });

      const nameEl = document.getElementById('workout-exercise-name');
      nameEl.value = 'Squat';
      const stale = nameEl.onchange();
      await typeName(document, 'Bench Press');
      gate.release();
      await stale;

      expect(document.getElementById('workout-exercise-weight').value).toBe('60');
      expect(hintOf(document).textContent).toBe('Last: 57.5 kg × 8');
    });

    it('leaves the field blank and shows no hint for an exercise with no history', async () => {
      const { window, document } = env;
      stubSuggest(window, null);
      await window.showAddExerciseModal();

      await typeName(document, 'Zercher squat');

      expect(document.getElementById('workout-exercise-weight').value).toBe('');
      expect(hintOf(document).hidden).toBe(true);
      expect(hintOf(document).textContent).toBe('');
    });

    it('never overwrites a weight the user typed, but still shows the evidence', async () => {
      const { window, document } = env;
      stubSuggest(window, RATED);
      await window.showAddExerciseModal();
      document.getElementById('workout-exercise-weight').value = '85';

      await typeName(document, 'Squat');

      expect(document.getElementById('workout-exercise-weight').value).toBe('85');
      expect(hintOf(document).textContent).toBe('Last: 100 kg × 6 · RPE 8 · 2 RIR');
    });

    it('omits the effort clause entirely when nothing was rated', async () => {
      const { window, document } = env;
      // The common case: RPE is optional and most vaults have none. The gate is
      // open, so the suggestion still lands — with no effort clause at all,
      // never "RPE null", never a dangling separator.
      stubSuggest(window, {
        target_weight_kg: 102.5,
        last: { weight_kg: 100, reps: 6, effort: null, logged_at: '2026-07-30T10:00:00Z' },
      });
      await window.showAddExerciseModal();

      await typeName(document, 'Squat');

      expect(document.getElementById('workout-exercise-weight').value).toBe('102.5');
      expect(hintOf(document).textContent).toBe('Last: 100 kg × 6');
      expect(hintOf(document).textContent).not.toContain('·');
    });

    it('does not ask at all while the name is still empty (modal just opened)', async () => {
      const { window, document } = env;
      stubSuggest(window, RATED);

      await window.showAddExerciseModal();

      expect(document.getElementById('workout-exercise-weight').value).toBe('');
      expect(hintOf(document).hidden).toBe(true);
      expect(window.apiCall.mock.calls.map((c) => String(c[0]))
        .some((u) => u.startsWith('/api/workout/exercises/suggest-target'))).toBe(false);
    });

    it('never overwrites the stored target when editing an existing exercise', async () => {
      const { window, document } = env;
      stubSuggest(window, RATED, [{
        id: 9, exercise_name: 'Squat', target_sets: 3, target_reps_min: 3, target_reps_max: 6,
        target_weight_kg: 90, order_index: 0, progression_rule: { type: 'linear', increment_kg: 2.5 },
      }]);

      await window.showEditExerciseModal(9);

      expect(document.getElementById('workout-exercise-weight').value).toBe('90');
      // …and the evidence still renders, so Edit explains the plan too.
      expect(hintOf(document).textContent).toBe('Last: 100 kg × 6 · RPE 8 · 2 RIR');
    });

    it('re-asks after a suggestion-list pick, which assigns the name with no change event', async () => {
      const { window, document } = env;
      stubSuggest(window, RATED);
      await window.showAddExerciseModal();

      document.getElementById('workout-exercise-name').value = 'Squat';
      await window.onPlanExercisePicked({ name: 'Squat' }); // catalog-only row: no id

      expect(document.getElementById('workout-exercise-weight').value).toBe('102.5');
      expect(hintOf(document).textContent).toBe('Last: 100 kg × 6 · RPE 8 · 2 RIR');
    });

    it('leaves the field blank when the route is unavailable (bot mode 404s it)', async () => {
      const { window, document } = env;
      stubSuggest(window, null);
      window.apiCall = vi.fn(async () => { throw new Error('Not found'); });
      await window.showAddExerciseModal();

      await typeName(document, 'Squat');

      expect(document.getElementById('workout-exercise-weight').value).toBe('');
      expect(hintOf(document).hidden).toBe(true);
    });
  });

  // med-niix.8: editable Equipment select in the plan-exercise modal. The
  // select mirrors the library row's equipment_id (None = unbound); saving
  // writes the row only when the pick differs — a full-replacement PUT
  // through DataStore.applyOptimistic — so the gear applies to the exercise
  // in every plan. The helper shows the picked gear's step/max from the API
  // verbatim, never recomputed client-side.
  describe('equipment select (med-niix.8)', () => {
    const OHIO_BAR = { id: 50, name: 'Ohio bar', kind: 'plated', min_step_kg: 2.5, max_kg: 200 };
    const HEX_DB = { id: 51, name: 'Hex DB', kind: 'fixed', min_step_kg: null, max_kg: 10 };

    function boundExercise(libraryId = 40) {
      return [{
        id: 7, exercise_name: 'Bench Press', target_sets: 3, target_reps_min: 8,
        target_reps_max: 10, target_weight_kg: 60, order_index: 0,
        progression_rule: { type: 'none' }, exercise_library_id: libraryId,
      }];
    }

    function libraryRow(overrides = {}) {
      return { id: 40, name: 'Bench Press', default_sets: 3, default_reps_min: 8, equipment_id: 50, ...overrides };
    }

    // Stubs the variant-exercise read, the library list, the inventory, and
    // the write endpoints; returns the apiCall traffic log.
    function stubPlan(window, { exercises, library, equipment = [OHIO_BAR, HEX_DB], updateResult = true } = {}) {
      window.WorkoutEdit.variantForExercise = 1;
      window.WorkoutLibrary = { bindExercisePicker: vi.fn(async () => {}) };
      window.WorkoutEquipment.list = vi.fn(async () => equipment);
      window.loadExerciseLibrary = vi.fn(async () => {});
      window.invalidateWorkoutCache = vi.fn(async () => {});
      window.loadExercisesForVariant = vi.fn();
      const calls = [];
      window.apiCall = vi.fn(async (url, method, body) => {
        calls.push([url, method, body]);
        if (String(url).startsWith('/api/workout/exercises?')) return exercises;
        if (String(url) === '/api/workout/exercise-library') return library;
        if (String(url).startsWith('/api/workout/exercise-library/update')) return updateResult;
        if (String(url) === '/api/workout/exercises/create') return { id: 7, exercise_library_id: 40 };
        if (String(url).startsWith('/api/workout/exercises/update')) return true;
        if (String(url).startsWith('/api/workout/equipment')) return equipment;
        return [];
      });
      return calls;
    }

    // Map-backed ApiCache so DataStore.applyOptimistic reads/writes are
    // observable (mirrors features.workout-sessions.test.js).
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
            return typeof prefix === 'string' && prefix ? all.filter((k) => k.startsWith(prefix)) : all;
          }
        }
      };
      return map;
    }

    const planSelectOf = (document) => document.getElementById('workout-exercise-equipment');
    const planHintOf = (document) => document.getElementById('workout-exercise-equipment-hint');
    const planScopeOf = (document) => document.getElementById('workout-exercise-equipment-scope');
    const libraryPuts = (calls) => calls.filter(([url]) => String(url).startsWith('/api/workout/exercise-library/update'));

    it('renders the Equipment select (None + inventory) with the every-plan scope line', async () => {
      const { window, document } = env;
      stubPlan(window, { exercises: [], library: [] });

      await window.showAddExerciseModal();

      const select = planSelectOf(document);
      expect(select).not.toBeNull();
      expect(select.tagName).toBe('SELECT');
      expect(Array.from(select.options).map((o) => [o.value, o.textContent]))
        .toEqual([['', 'None'], ['50', 'Ohio bar'], ['51', 'Hex DB']]);
      expect(select.value).toBe('');
      expect(select.disabled).toBe(false);
      expect(planHintOf(document).hidden).toBe(true);
      expect(planScopeOf(document).hidden).toBe(false);
      expect(planScopeOf(document).textContent).toBe('Applies to this exercise in every plan.');
    });

    it('showEditExerciseModal preselects the bound gear with the step/max helper from the API', async () => {
      const { window, document } = env;
      stubPlan(window, { exercises: boundExercise(40), library: [libraryRow()] });

      await window.showEditExerciseModal(7);

      expect(planSelectOf(document).value).toBe('50');
      expect(planHintOf(document).hidden).toBe(false);
      expect(planHintOf(document).textContent).toBe('step 2.5 kg · max 200 kg');
    });

    it('omits null step/max clauses, and hides the helper when unbound', async () => {
      const { window, document } = env;
      stubPlan(window, { exercises: boundExercise(40), library: [libraryRow({ equipment_id: 51 })] });

      await window.showEditExerciseModal(7);

      // Hex DB reports min_step_kg null — only the max clause renders.
      expect(planSelectOf(document).value).toBe('51');
      expect(planHintOf(document).textContent).toBe('max 10 kg');

      // The row itself unbound: None + hidden helper.
      const unbound = libraryRow();
      delete unbound.equipment_id;
      window.apiCall = vi.fn(async (url) => {
        if (String(url).startsWith('/api/workout/exercises?')) return boundExercise(40);
        if (String(url) === '/api/workout/exercise-library') return [unbound];
        return [];
      });
      await window.showEditExerciseModal(7);

      expect(planSelectOf(document).value).toBe('');
      expect(planHintOf(document).hidden).toBe(true);
      expect(planHintOf(document).textContent).toBe('');
    });

    it('a dangling binding (equipment deleted, no cascade) preselects None with no helper', async () => {
      const { window, document } = env;
      stubPlan(window, { exercises: boundExercise(40), library: [libraryRow({ equipment_id: 999 })] });

      await window.showEditExerciseModal(7);

      expect(planSelectOf(document).value).toBe('');
      expect(planHintOf(document).hidden).toBe(true);
    });

    it('a legacy row without a library link shows a disabled select and no helper', async () => {
      const { window, document } = env;
      const ex = boundExercise();
      delete ex[0].exercise_library_id;
      stubPlan(window, { exercises: ex, library: [] });

      await window.showEditExerciseModal(7);

      const select = planSelectOf(document);
      expect(select.disabled).toBe(true);
      expect(select.value).toBe('');
      expect(planHintOf(document).hidden).toBe(true);
      expect(planHintOf(document).textContent).toBe('');
      expect(planScopeOf(document).hidden).toBe(true);
    });

    it('changing the select re-renders the helper; None clears it', async () => {
      const { window, document } = env;
      stubPlan(window, { exercises: boundExercise(40), library: [libraryRow()] });

      await window.showEditExerciseModal(7);
      expect(planHintOf(document).textContent).toBe('step 2.5 kg · max 200 kg');

      const select = planSelectOf(document);
      select.value = '51';
      await select.onchange();
      await vi.waitFor(() => {
        expect(planHintOf(document).textContent).toBe('max 10 kg');
      });

      select.value = '';
      await select.onchange();
      await vi.waitFor(() => {
        expect(planHintOf(document).hidden).toBe(true);
      });
      expect(planHintOf(document).textContent).toBe('');
    });

    it("a library pick preselects that row's gear; a catalog-only pick fills None + inventory", async () => {
      const { window, document } = env;
      stubPlan(window, { exercises: [], library: [libraryRow()] });

      await window.onPlanExercisePicked({ id: 40, name: 'Bench Press' });
      await vi.waitFor(() => {
        expect(planSelectOf(document).value).toBe('50');
      });
      await vi.waitFor(() => {
        expect(planHintOf(document).textContent).toBe('step 2.5 kg · max 200 kg');
      });

      await window.onPlanExercisePicked({ name: 'Zercher squat' });
      await vi.waitFor(() => {
        expect(planSelectOf(document).value).toBe('');
      });
      expect(planHintOf(document).hidden).toBe(true);
      // Unknown name still offers the inventory for an explicit pick.
      expect(Array.from(planSelectOf(document).options).map((o) => o.value)).toEqual(['', '50', '51']);
    });

    it('a hand-typed rename re-resolves the select against the new name', async () => {
      const { window, document } = env;
      stubPlan(window, {
        exercises: boundExercise(40),
        library: [libraryRow(), { id: 41, name: 'Curl' }],
      });
      await window.showEditExerciseModal(7);
      expect(planSelectOf(document).value).toBe('50');

      // Renaming to an unbound library name clears the select (no picker
      // pick, so this goes through the name-change path).
      const nameEl = document.getElementById('workout-exercise-name');
      nameEl.value = 'Curl';
      await nameEl.onchange();
      await vi.waitFor(() => {
        expect(planSelectOf(document).value).toBe('');
      });
      expect(planHintOf(document).hidden).toBe(true);

      // ...and back to the bound name restores it.
      nameEl.value = 'Bench Press';
      await nameEl.onchange();
      await vi.waitFor(() => {
        expect(planSelectOf(document).value).toBe('50');
      });
      await vi.waitFor(() => {
        expect(planHintOf(document).hidden).toBe(false);
      });
    });

    it('opening Edit clears the previous select synchronously', async () => {
      const { window, document } = env;
      stubPlan(window, { exercises: boundExercise(40), library: [libraryRow()] });

      await window.showEditExerciseModal(7);
      expect(planSelectOf(document).value).toBe('50');

      // The second open targets an unbound row: the stale '50' must already
      // be gone before the first await resolves.
      window.apiCall = vi.fn(async (url) => {
        if (String(url).startsWith('/api/workout/exercises?')) return boundExercise(41);
        if (String(url) === '/api/workout/exercise-library') return [{ id: 41, name: 'Curl' }];
        return [];
      });
      const pending = window.showEditExerciseModal(7);
      const select = planSelectOf(document);
      expect(select.value).toBe('');
      expect(Array.from(select.options).map((o) => o.value)).toEqual(['']);
      await pending;
      expect(select.value).toBe('');
      expect(planHintOf(document).hidden).toBe(true);
    });

    it('a superseded pick cannot paint its binding after a newer pick cleared it', async () => {
      const { window, document } = env;
      stubPlan(window, { exercises: [], library: [libraryRow()] });
      // Gate the FIRST library read so the bound pick's fetch lands after
      // the catalog-only pick has already reset the select.
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let first = true;
      const inner = window.apiCall;
      window.apiCall = vi.fn(async (url, ...rest) => {
        if (first && String(url) === '/api/workout/exercise-library') {
          first = false;
          await gate;
        }
        return inner(url, ...rest);
      });

      window.onPlanExercisePicked({ id: 40, name: 'Bench Press' });
      await window.onPlanExercisePicked({ name: 'Zercher squat' });
      expect(planSelectOf(document).value).toBe('');
      release();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(planSelectOf(document).value).toBe('');
      expect(planHintOf(document).hidden).toBe(true);
    });

    it('picking another gear and saving writes the library row (full replacement, optimistic)', async () => {
      const { window, document } = env;
      const cache = installApiCache(window, { exercise_library: [libraryRow()] });
      const optimisticSpy = vi.spyOn(window.DataStore, 'applyOptimistic');
      const calls = stubPlan(window, { exercises: boundExercise(40), library: [libraryRow()] });

      await window.showEditExerciseModal(7);
      expect(planSelectOf(document).value).toBe('50');

      planSelectOf(document).value = '51';
      await window.saveExercise();

      // The exercise write itself is unchanged.
      expect(calls.some(([url]) => String(url).startsWith('/api/workout/exercises/update?id=7'))).toBe(true);
      // Exactly one library write, as a full replacement carrying the new
      // binding alongside every other field explicitly (body_part rides
      // along even though the read shape omits it when unset — the update
      // overwrites rather than preserves it).
      const puts = libraryPuts(calls);
      expect(puts).toHaveLength(1);
      expect(puts[0][0]).toBe('/api/workout/exercise-library/update?id=40');
      expect(puts[0][2]).toMatchObject({
        name: 'Bench Press', default_sets: 3, default_reps_min: 8, body_part: '', equipment_id: 51,
      });
      // Optimistic projection on the library cache, then the library repaint
      // exactly as the library editor's own save.
      expect(optimisticSpy).toHaveBeenCalledWith('exercise_library', expect.any(Function), ['exercise_library']);
      expect(window.loadExerciseLibrary).toHaveBeenCalled();
      // Committed against the authoritative list read.
      expect(await cache.get('exercise_library')).toEqual([libraryRow()]);
      optimisticSpy.mockRestore();
    });

    it('saving without touching the select issues no library write', async () => {
      const { window, document } = env;
      installApiCache(window, { exercise_library: [libraryRow()] });
      const optimisticSpy = vi.spyOn(window.DataStore, 'applyOptimistic');
      const calls = stubPlan(window, { exercises: boundExercise(40), library: [libraryRow()] });

      await window.showEditExerciseModal(7);
      await window.saveExercise();

      expect(calls.some(([url]) => String(url).startsWith('/api/workout/exercises/update?id=7'))).toBe(true);
      expect(libraryPuts(calls)).toHaveLength(0);
      expect(optimisticSpy).not.toHaveBeenCalled();
      expect(window.loadExerciseLibrary).not.toHaveBeenCalled();
      optimisticSpy.mockRestore();
    });

    it('picking None and saving unbinds the row to null', async () => {
      const { window, document } = env;
      installApiCache(window);
      const calls = stubPlan(window, { exercises: boundExercise(40), library: [libraryRow()] });

      await window.showEditExerciseModal(7);
      planSelectOf(document).value = '';
      await window.saveExercise();

      const puts = libraryPuts(calls);
      expect(puts).toHaveLength(1);
      expect(puts[0][2]).toMatchObject({ name: 'Bench Press', equipment_id: null });
    });

    it('a failed library write rolls the cache back and repaints nothing', async () => {
      const { window, document } = env;
      const seed = [libraryRow()];
      const cache = installApiCache(window, { exercise_library: seed.map((r) => ({ ...r })) });
      window.Telegram.WebApp.showAlert = vi.fn();
      const calls = stubPlan(window, {
        exercises: boundExercise(40), library: [libraryRow()], updateResult: null,
      });

      await window.showEditExerciseModal(7);
      planSelectOf(document).value = '51';
      await window.saveExercise();

      // The write was attempted, then rolled back: the cache still holds the
      // pre-save rows and the library list was not repainted from them.
      expect(libraryPuts(calls)).toHaveLength(1);
      expect(await cache.get('exercise_library')).toEqual(seed);
      expect(window.loadExerciseLibrary).not.toHaveBeenCalled();
      expect(window.Telegram.WebApp.showAlert).toHaveBeenCalled();
    });

    it('adding a new exercise with gear picked binds its promoted library row', async () => {
      const { window, document } = env;
      installApiCache(window);
      const calls = stubPlan(window, { exercises: [], library: [libraryRow()] });

      await window.showAddExerciseModal();
      document.getElementById('workout-exercise-name').value = 'Bench Press';
      document.getElementById('workout-exercise-sets').value = '3';
      document.getElementById('workout-exercise-reps-min').value = '8';
      planSelectOf(document).value = '51';
      await window.saveExercise();

      expect(calls.some(([url]) => String(url) === '/api/workout/exercises/create')).toBe(true);
      const puts = libraryPuts(calls);
      expect(puts).toHaveLength(1);
      expect(puts[0][0]).toBe('/api/workout/exercise-library/update?id=40');
      expect(puts[0][2]).toMatchObject({ name: 'Bench Press', equipment_id: 51 });
    });

    it('adding a new exercise with None picked leaves the promoted row alone', async () => {
      const { window, document } = env;
      installApiCache(window);
      const calls = stubPlan(window, { exercises: [], library: [libraryRow()] });

      await window.showAddExerciseModal();
      document.getElementById('workout-exercise-name').value = 'Bench Press';
      document.getElementById('workout-exercise-sets').value = '3';
      document.getElementById('workout-exercise-reps-min').value = '8';
      expect(planSelectOf(document).value).toBe('');
      await window.saveExercise();

      expect(calls.some(([url]) => String(url) === '/api/workout/exercises/create')).toBe(true);
      // The name matches an already-bound row — None must not unbind it.
      expect(libraryPuts(calls)).toHaveLength(0);
    });

    it('saving a legacy row issues no library write', async () => {
      const { window, document } = env;
      installApiCache(window);
      const ex = boundExercise();
      delete ex[0].exercise_library_id;
      const calls = stubPlan(window, { exercises: ex, library: [] });

      await window.showEditExerciseModal(7);
      expect(planSelectOf(document).disabled).toBe(true);
      await window.saveExercise();

      expect(calls.some(([url]) => String(url).startsWith('/api/workout/exercises/update?id=7'))).toBe(true);
      expect(libraryPuts(calls)).toHaveLength(0);
    });
  });

});

