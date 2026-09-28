// Focused integration tests for the extracted features/workout/exercises.js
// sub-file. Verifies that the closure-private editing state is reachable via
// the window.WorkoutEdit accessors, and that open-edit / save / close flows
// behave as the orchestrator expects.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import * as equipmentDomain from '../../../../web/domain/equipment.js';

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
    window.alert = vi.fn();

    // Set variant context but leave name/sets/reps empty
    window.WorkoutEdit.variantForExercise = 1;
    document.getElementById('workout-exercise-name').value = '';
    document.getElementById('workout-exercise-sets').value = '';
    document.getElementById('workout-exercise-reps-min').value = '';

    await window.saveExercise();

    expect(apiCallSpy).not.toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalledTimes(1);
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

  // med-3gln: per-plan-row Equipment override in the plan-exercise modal.
  // The select binds the row's own equipment_id (preselected when set); blank
  // means "no override" and falls back to the library row's binding, shown as
  // the blank option's label ('from library: <name>', else 'None'). Saving
  // writes the exercise row only — the library row is never touched. The
  // helper shows the effective gear's step/max from the API verbatim.
  describe('equipment select — plan-row override (med-3gln)', () => {
    const OHIO_BAR = { id: 50, name: 'Ohio bar', kind: 'plated', min_step_kg: 2.5, max_kg: 200 };
    const HEX_DB = { id: 51, name: 'Hex DB', kind: 'fixed', min_step_kg: null, max_kg: 10 };

    function boundExercise(libraryId = 40, overrides = {}) {
      return [{
        id: 7, exercise_name: 'Bench Press', target_sets: 3, target_reps_min: 8,
        target_reps_max: 10, target_weight_kg: 60, order_index: 0,
        progression_rule: { type: 'none' }, exercise_library_id: libraryId,
        ...overrides,
      }];
    }

    function libraryRow(overrides = {}) {
      return { id: 40, name: 'Bench Press', default_sets: 3, default_reps_min: 8, equipment_id: 50, ...overrides };
    }

    // Stubs the variant-exercise read, the library list, the inventory, and
    // the exercise write endpoints; returns the apiCall traffic log.
    function stubPlan(window, { exercises, library, equipment = [OHIO_BAR, HEX_DB] } = {}) {
      window.WorkoutEdit.variantForExercise = 1;
      window.WorkoutLibrary = { bindExercisePicker: vi.fn(async () => {}) };
      window.WorkoutEquipment.list = vi.fn(async () => equipment);
      window.loadExerciseLibrary = vi.fn(async () => {});
      window.invalidateWorkoutCache = vi.fn(async () => {});
      window.loadExercisesForVariant = vi.fn();
      window.WorkoutGroups.loadEquipmentDomain = async () => equipmentDomain;
      const calls = [];
      window.apiCall = vi.fn(async (url, method, body) => {
        calls.push([url, method, body]);
        if (String(url).startsWith('/api/workout/exercises?')) return exercises;
        if (String(url) === '/api/workout/exercise-library') return library;
        if (String(url) === '/api/workout/exercises/create') return { id: 7, exercise_library_id: 40 };
        if (String(url).startsWith('/api/workout/exercises/update')) return true;
        if (String(url).startsWith('/api/workout/equipment')) return equipment;
        return [];
      });
      return calls;
    }

    const planSelectOf = (document) => document.getElementById('workout-exercise-equipment');
    const planHintOf = (document) => document.getElementById('workout-exercise-equipment-hint');
    const planScopeOf = (document) => document.getElementById('workout-exercise-equipment-scope');
    const blankLabelOf = (document) => planSelectOf(document).options[0].textContent;
    const libraryPuts = (calls) => calls.filter(([url]) => String(url).startsWith('/api/workout/exercise-library/update'));
    const exerciseWrites = (calls) => calls.filter(([url]) => String(url) === '/api/workout/exercises/create'
      || String(url).startsWith('/api/workout/exercises/update'));

    it('renders the Equipment select (blank + inventory) with the plan-row scope line', async () => {
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
      expect(planScopeOf(document).textContent).toBe('Applies to this plan row only.');
    });

    it('showEditExerciseModal preselects the row override and labels blank with the inherited binding', async () => {
      const { window, document } = env;
      stubPlan(window, {
        exercises: boundExercise(40, { equipment_id: 51 }),
        library: [libraryRow()],
      });

      await window.showEditExerciseModal(7);

      expect(planSelectOf(document).value).toBe('51');
      expect(blankLabelOf(document)).toBe('from library: Ohio bar');
      expect(planHintOf(document).hidden).toBe(false);
      expect(planHintOf(document).textContent).toBe('max 10 kg');
    });

    it('no override + bound library: blank inherits, helper shows the inherited step/max', async () => {
      const { window, document } = env;
      stubPlan(window, { exercises: boundExercise(40), library: [libraryRow()] });

      await window.showEditExerciseModal(7);

      expect(planSelectOf(document).value).toBe('');
      expect(blankLabelOf(document)).toBe('from library: Ohio bar');
      expect(planHintOf(document).hidden).toBe(false);
      expect(planHintOf(document).textContent).toBe('step 2.5 kg · max 200 kg');
    });

    it('unbound everywhere: blank None + hidden helper', async () => {
      const { window, document } = env;
      const unbound = libraryRow();
      delete unbound.equipment_id;
      stubPlan(window, { exercises: boundExercise(40), library: [unbound] });

      await window.showEditExerciseModal(7);

      expect(planSelectOf(document).value).toBe('');
      expect(blankLabelOf(document)).toBe('None');
      expect(planHintOf(document).hidden).toBe(true);
      expect(planHintOf(document).textContent).toBe('');
    });

    it('a dangling override (equipment deleted, no cascade) shows blank with no helper', async () => {
      const { window, document } = env;
      const unbound = libraryRow();
      delete unbound.equipment_id;
      stubPlan(window, {
        exercises: boundExercise(40, { equipment_id: 999 }),
        library: [unbound],
      });

      await window.showEditExerciseModal(7);

      expect(planSelectOf(document).value).toBe('');
      expect(blankLabelOf(document)).toBe('None');
      expect(planHintOf(document).hidden).toBe(true);
    });

    it('a row without a library link binds its override (enabled select, save writes the row)', async () => {
      const { window, document } = env;
      const ex = boundExercise();
      delete ex[0].exercise_library_id;
      ex[0].equipment_id = 50;
      const calls = stubPlan(window, { exercises: ex, library: [] });

      await window.showEditExerciseModal(7);

      const select = planSelectOf(document);
      expect(select.disabled).toBe(false);
      expect(select.value).toBe('50');
      expect(blankLabelOf(document)).toBe('None');
      expect(planHintOf(document).textContent).toBe('step 2.5 kg · max 200 kg');
      expect(planScopeOf(document).hidden).toBe(false);

      select.value = '51';
      await window.saveExercise();

      const writes = exerciseWrites(calls);
      expect(writes).toHaveLength(1);
      expect(writes[0][2]).toMatchObject({ exercise_name: 'Bench Press', equipment_id: 51 });
      expect(libraryPuts(calls)).toHaveLength(0);
    });

    it('changing the select re-renders the helper; blank shows the inherited helper', async () => {
      const { window, document } = env;
      stubPlan(window, {
        exercises: boundExercise(40, { equipment_id: 51 }),
        library: [libraryRow()],
      });

      await window.showEditExerciseModal(7);
      expect(planHintOf(document).textContent).toBe('max 10 kg');

      const select = planSelectOf(document);
      select.value = '50';
      await select.onchange();
      await vi.waitFor(() => {
        expect(planHintOf(document).textContent).toBe('step 2.5 kg · max 200 kg');
      });

      // Blank falls back to the inherited gear's helper, not an empty line.
      select.value = '';
      await select.onchange();
      await vi.waitFor(() => {
        expect(planHintOf(document).textContent).toBe('step 2.5 kg · max 200 kg');
      });
      expect(planHintOf(document).hidden).toBe(false);
    });

    it("a library pick re-resolves the inherited label; a catalog-only pick labels blank None", async () => {
      const { window, document } = env;
      stubPlan(window, { exercises: [], library: [libraryRow()] });

      await window.onPlanExercisePicked({ id: 40, name: 'Bench Press' });
      await vi.waitFor(() => {
        expect(blankLabelOf(document)).toBe('from library: Ohio bar');
      });
      expect(planSelectOf(document).value).toBe('');
      await vi.waitFor(() => {
        expect(planHintOf(document).textContent).toBe('step 2.5 kg · max 200 kg');
      });

      await window.onPlanExercisePicked({ name: 'Zercher squat' });
      await vi.waitFor(() => {
        expect(blankLabelOf(document)).toBe('None');
      });
      expect(planSelectOf(document).value).toBe('');
      expect(planHintOf(document).hidden).toBe(true);
      // Unknown name still offers the inventory for an explicit pick.
      expect(Array.from(planSelectOf(document).options).map((o) => o.value)).toEqual(['', '50', '51']);
    });

    it('a hand-typed rename re-resolves the inherited label and keeps the override', async () => {
      const { window, document } = env;
      stubPlan(window, {
        exercises: boundExercise(40, { equipment_id: 51 }),
        library: [libraryRow(), { id: 41, name: 'Curl' }],
      });
      await window.showEditExerciseModal(7);
      expect(planSelectOf(document).value).toBe('51');
      expect(blankLabelOf(document)).toBe('from library: Ohio bar');

      // Renaming to an unbound library name relabels blank (no picker
      // pick, so this goes through the name-change path) without touching
      // the override selection.
      const nameEl = document.getElementById('workout-exercise-name');
      nameEl.value = 'Curl';
      await nameEl.onchange();
      await vi.waitFor(() => {
        expect(blankLabelOf(document)).toBe('None');
      });
      expect(planSelectOf(document).value).toBe('51');

      // ...and back to the bound name restores the label.
      nameEl.value = 'Bench Press';
      await nameEl.onchange();
      await vi.waitFor(() => {
        expect(blankLabelOf(document)).toBe('from library: Ohio bar');
      });
      expect(planSelectOf(document).value).toBe('51');
    });

    it('a rename keeps an unsaved equipment pick (codex med-3gln review)', async () => {
      const { window, document } = env;
      const calls = stubPlan(window, {
        exercises: boundExercise(40, { equipment_id: 50 }),
        library: [libraryRow(), { id: 41, name: 'Curl' }],
      });
      await window.showEditExerciseModal(7);
      expect(planSelectOf(document).value).toBe('50');

      // Pick new gear, THEN rename: the refill must keep the live pick, not
      // restore the open-time override.
      planSelectOf(document).value = '51';
      const nameEl = document.getElementById('workout-exercise-name');
      nameEl.value = 'Curl';
      await nameEl.onchange();
      await vi.waitFor(() => {
        expect(blankLabelOf(document)).toBe('None');
      });
      expect(planSelectOf(document).value).toBe('51');

      await window.saveExercise();

      const writes = exerciseWrites(calls);
      expect(writes).toHaveLength(1);
      expect(writes[0][2]).toMatchObject({ equipment_id: 51 });
    });

    it('a picker pick keeps an unsaved equipment pick', async () => {
      const { window, document } = env;
      stubPlan(window, { exercises: [], library: [libraryRow()] });

      await window.showAddExerciseModal();
      planSelectOf(document).value = '51';

      await window.onPlanExercisePicked({ id: 40, name: 'Bench Press' });
      await vi.waitFor(() => {
        expect(blankLabelOf(document)).toBe('from library: Ohio bar');
      });
      expect(planSelectOf(document).value).toBe('51');
    });

    it('opening Edit clears the previous select synchronously', async () => {
      const { window, document } = env;
      stubPlan(window, {
        exercises: boundExercise(40, { equipment_id: 51 }),
        library: [libraryRow()],
      });

      await window.showEditExerciseModal(7);
      expect(planSelectOf(document).value).toBe('51');

      // The second open targets a row with no override and an unbound
      // library: the stale '51' must already be gone before the first
      // await resolves.
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
      expect(blankLabelOf(document)).toBe('None');
      expect(planHintOf(document).hidden).toBe(true);
    });

    it('a superseded pick cannot paint its label after a newer pick cleared it', async () => {
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
      expect(blankLabelOf(document)).toBe('None');
      expect(planHintOf(document).hidden).toBe(true);
    });

    it('picking another gear and saving sends the override in the exercise payload (no library write)', async () => {
      const { window, document } = env;
      const calls = stubPlan(window, {
        exercises: boundExercise(40, { equipment_id: 50 }),
        library: [libraryRow()],
      });

      await window.showEditExerciseModal(7);
      expect(planSelectOf(document).value).toBe('50');

      planSelectOf(document).value = '51';
      await window.saveExercise();

      const writes = exerciseWrites(calls);
      expect(writes).toHaveLength(1);
      expect(writes[0][0]).toBe('/api/workout/exercises/update?id=7');
      expect(writes[0][2]).toMatchObject({ exercise_name: 'Bench Press', equipment_id: 51 });
      // The library row is never touched, and its list never repainted.
      expect(libraryPuts(calls)).toHaveLength(0);
      expect(window.loadExerciseLibrary).not.toHaveBeenCalled();
    });

    it('saving without touching the select sends the stored override back (no library write)', async () => {
      const { window, document } = env;
      const calls = stubPlan(window, {
        exercises: boundExercise(40, { equipment_id: 50 }),
        library: [libraryRow()],
      });

      await window.showEditExerciseModal(7);
      await window.saveExercise();

      const writes = exerciseWrites(calls);
      expect(writes).toHaveLength(1);
      expect(writes[0][2]).toMatchObject({ equipment_id: 50 });
      expect(libraryPuts(calls)).toHaveLength(0);
      expect(window.loadExerciseLibrary).not.toHaveBeenCalled();
    });

    it('picking blank and saving clears the override to null', async () => {
      const { window, document } = env;
      const calls = stubPlan(window, {
        exercises: boundExercise(40, { equipment_id: 50 }),
        library: [libraryRow()],
      });

      await window.showEditExerciseModal(7);
      planSelectOf(document).value = '';
      await window.saveExercise();

      const writes = exerciseWrites(calls);
      expect(writes).toHaveLength(1);
      expect(writes[0][2]).toMatchObject({ exercise_name: 'Bench Press', equipment_id: null });
      expect(libraryPuts(calls)).toHaveLength(0);
    });

    it('adding a new exercise carries the pick in the create payload (blank omits the key)', async () => {
      const { window, document } = env;
      const calls = stubPlan(window, { exercises: [], library: [libraryRow()] });

      await window.showAddExerciseModal();
      document.getElementById('workout-exercise-name').value = 'Bench Press';
      document.getElementById('workout-exercise-sets').value = '3';
      document.getElementById('workout-exercise-reps-min').value = '8';
      planSelectOf(document).value = '51';
      await window.saveExercise();

      let writes = exerciseWrites(calls);
      expect(writes).toHaveLength(1);
      expect(writes[0][0]).toBe('/api/workout/exercises/create');
      expect(writes[0][2]).toMatchObject({ exercise_name: 'Bench Press', equipment_id: 51 });
      expect(libraryPuts(calls)).toHaveLength(0);

      // Blank on Add omits the key (nothing stored to clear — the row
      // inherits), and still never touches the library row the name
      // promotes to.
      await window.showAddExerciseModal();
      document.getElementById('workout-exercise-name').value = 'Bench Press';
      document.getElementById('workout-exercise-sets').value = '3';
      document.getElementById('workout-exercise-reps-min').value = '8';
      expect(planSelectOf(document).value).toBe('');
      await window.saveExercise();

      writes = exerciseWrites(calls);
      expect(writes).toHaveLength(2);
      expect(writes[1][2]).toMatchObject({ exercise_name: 'Bench Press' });
      expect('equipment_id' in writes[1][2]).toBe(false);
      expect(libraryPuts(calls)).toHaveLength(0);
    });

    it('a failed inventory read on open leaves the select unloaded, so save preserves the override', async () => {
      const { window, document } = env;
      window.WorkoutEdit.variantForExercise = 1;
      window.WorkoutLibrary = { bindExercisePicker: vi.fn(async () => {}) };
      window.WorkoutEquipment.list = vi.fn(async () => { throw new Error('offline'); });
      window.loadExerciseLibrary = vi.fn(async () => {});
      window.invalidateWorkoutCache = vi.fn(async () => {});
      window.loadExercisesForVariant = vi.fn();
      const calls = [];
      window.apiCall = vi.fn(async (url, method, body) => {
        calls.push([url, method, body]);
        if (String(url).startsWith('/api/workout/exercises?')) {
          return boundExercise(40, { equipment_id: 50 });
        }
        if (String(url) === '/api/workout/exercise-library') return [libraryRow()];
        if (String(url).startsWith('/api/workout/exercises/update')) return true;
        return null;
      });

      await window.showEditExerciseModal(7);

      const select = planSelectOf(document);
      expect(select.value).toBe('');
      expect(select.dataset.loaded).toBe('false');
      expect(planHintOf(document).hidden).toBe(true);

      await window.saveExercise();

      const writes = exerciseWrites(calls);
      expect(writes).toHaveLength(1);
      expect('equipment_id' in writes[0][2]).toBe(false);
      expect(libraryPuts(calls)).toHaveLength(0);
    });

    it('a stale inventory missing the override gear never clears on save, but an explicit pick still writes', async () => {
      const { window, document } = env;
      // Inventory without Ohio bar (id 50): the row overrides to gear the
      // select cannot offer, so it reads as blank.
      const calls = stubPlan(window, {
        exercises: boundExercise(40, { equipment_id: 50 }),
        library: [libraryRow()],
        equipment: [HEX_DB],
      });

      await window.showEditExerciseModal(7);

      const select = planSelectOf(document);
      expect(select.value).toBe('');
      expect(select.dataset.loaded).toBe('true');

      await window.saveExercise();

      let writes = exerciseWrites(calls);
      expect(writes).toHaveLength(1);
      expect('equipment_id' in writes[0][2]).toBe(false);
      expect(libraryPuts(calls)).toHaveLength(0);

      // An explicit pick of a visible option still writes.
      select.value = '51';
      await window.saveExercise();

      writes = exerciseWrites(calls);
      expect(writes).toHaveLength(2);
      expect(writes[1][2]).toMatchObject({ equipment_id: 51 });
    });

    it('a failed library read on open keeps the override usable (blank labeled None)', async () => {
      const { window, document } = env;
      window.WorkoutEdit.variantForExercise = 1;
      window.WorkoutLibrary = { bindExercisePicker: vi.fn(async () => {}) };
      window.WorkoutEquipment.list = vi.fn(async () => [OHIO_BAR, HEX_DB]);
      window.loadExerciseLibrary = vi.fn(async () => {});
      window.invalidateWorkoutCache = vi.fn(async () => {});
      window.loadExercisesForVariant = vi.fn();
      const calls = [];
      window.apiCall = vi.fn(async (url, method, body) => {
        calls.push([url, method, body]);
        if (String(url).startsWith('/api/workout/exercises?')) {
          return boundExercise(40, { equipment_id: 50 });
        }
        // The library GET fails (apiCall resolves null, not a throw) — only
        // the inherited label is lost.
        if (String(url) === '/api/workout/exercise-library') return null;
        if (String(url).startsWith('/api/workout/exercises/update')) return true;
        if (String(url).startsWith('/api/workout/equipment')) return [OHIO_BAR, HEX_DB];
        return [];
      });

      await window.showEditExerciseModal(7);

      const select = planSelectOf(document);
      expect(select.value).toBe('50');
      expect(select.dataset.loaded).toBe('true');
      expect(blankLabelOf(document)).toBe('None');
      expect(planHintOf(document).textContent).toBe('step 2.5 kg · max 200 kg');

      await window.saveExercise();

      const writes = exerciseWrites(calls);
      expect(writes).toHaveLength(1);
      expect(writes[0][2]).toMatchObject({ equipment_id: 50 });
      expect(libraryPuts(calls)).toHaveLength(0);
    });
    describe('auto-match label for an unbound row (med-ni2j)', () => {
      const OLY_BAR = { id: 60, name: 'Olympic bar', kind: 'plated', implement: 'barbell',
        loads_kg: [20, 40, 60, 80], min_step_kg: 20, max_kg: 80 };
      const EZ_BAR = { id: 61, name: 'EZ bar', kind: 'plated', implement: 'barbell',
        loads_kg: [10, 15, 25, 35], min_step_kg: 5, max_kg: 35 };
      const unboundLib = () => { const r = libraryRow({ name: 'Barbell Bench Press' }); delete r.equipment_id; return r; };
      const unboundRow = (overrides = {}) => boundExercise(40, { exercise_name: 'Barbell Bench Press', ...overrides });
      const writesOf = (calls) => calls.filter(([, method]) => method && method !== 'GET');

      it('labels blank auto: <item> with its step/max, follows the target weight, and never writes', async () => {
        const { window, document } = env;
        const calls = stubPlan(window, {
          exercises: unboundRow(), library: [unboundLib()], equipment: [OLY_BAR, EZ_BAR],
        });

        await window.showEditExerciseModal(7);

        expect(planSelectOf(document).value).toBe('');
        expect(blankLabelOf(document)).toBe('auto: Olympic bar');
        expect(planHintOf(document).hidden).toBe(false);
        expect(planHintOf(document).textContent).toBe('step 20 kg · max 80 kg');

        const weightEl = document.getElementById('workout-exercise-weight');
        weightEl.value = '25';
        await weightEl.onchange();

        expect(blankLabelOf(document)).toBe('auto: EZ bar');
        expect(planHintOf(document).textContent).toBe('step 5 kg · max 35 kg');
        expect(writesOf(calls)).toHaveLength(0);

        // Blank still saves the row unbound: auto is never persisted.
        await window.saveExercise();
        const writes = exerciseWrites(calls);
        expect(writes).toHaveLength(1);
        expect(writes[0][2]).not.toHaveProperty('equipment_id');
        expect(libraryPuts(calls)).toHaveLength(0);
      });

      it('picking a real item saves the row override as before', async () => {
        const { window, document } = env;
        const calls = stubPlan(window, {
          exercises: unboundRow(), library: [unboundLib()], equipment: [OLY_BAR, EZ_BAR],
        });

        await window.showEditExerciseModal(7);
        planSelectOf(document).value = '61';
        await window.saveExercise();

        const writes = exerciseWrites(calls);
        expect(writes).toHaveLength(1);
        expect(writes[0][2]).toMatchObject({ equipment_id: 61 });
        expect(libraryPuts(calls)).toHaveLength(0);
      });

      it('explicit row or library binding keeps the labels with no auto text', async () => {
        const { window, document } = env;
        stubPlan(window, {
          exercises: unboundRow({ equipment_id: 61 }), library: [unboundLib()], equipment: [OLY_BAR, EZ_BAR],
        });
        await window.showEditExerciseModal(7);
        expect(planSelectOf(document).value).toBe('61');
        expect(blankLabelOf(document)).toBe('None');

        stubPlan(window, {
          exercises: unboundRow(), library: [libraryRow({ name: 'Barbell Bench Press', equipment_id: 61 })],
          equipment: [OLY_BAR, EZ_BAR],
        });
        await window.showEditExerciseModal(7);
        expect(blankLabelOf(document)).toBe('from library: EZ bar');
      });

      it('empty inventory or a name with no implement word labels blank None', async () => {
        const { window, document } = env;
        stubPlan(window, { exercises: unboundRow(), library: [unboundLib()], equipment: [] });
        await window.showEditExerciseModal(7);
        expect(blankLabelOf(document)).toBe('None');

        const plain = unboundLib();
        plain.name = 'Bench Press';
        stubPlan(window, {
          exercises: boundExercise(40), library: [plain], equipment: [OLY_BAR, EZ_BAR],
        });
        await window.showEditExerciseModal(7);
        expect(blankLabelOf(document)).toBe('None');
        expect(planHintOf(document).hidden).toBe(true);
      });
    });
  });

});
