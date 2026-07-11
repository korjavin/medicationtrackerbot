// Focused integration tests for the extracted features/workout/library.js
// sub-file. Covers the WorkoutLibrary public-API surface and the
// closure-private editingLibraryItemId accessor exposed on WorkoutEdit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('features/workout/library.js — split-file integration', () => {
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

  it('exposes the WorkoutLibrary public-API namespace + WorkoutEdit accessor', () => {
    const { window } = env;
    expect(window.WorkoutLibrary).toBeTypeOf('object');
    expect(window.WorkoutLibrary.load).toBeTypeOf('function');
    expect(window.WorkoutLibrary.save).toBeTypeOf('function');
    expect(window.WorkoutLibrary.openAdd).toBeTypeOf('function');
    expect(window.WorkoutLibrary.openEdit).toBeTypeOf('function');
    expect(window.WorkoutLibrary.close).toBeTypeOf('function');
    expect(window.WorkoutLibrary.delete).toBeTypeOf('function');

    expect('editingLibraryItemId' in window.WorkoutEdit).toBe(true);
    expect(window.WorkoutEdit.editingLibraryItemId).toBeNull();
  });

  it('showExerciseLibraryModal clears editingLibraryItemId and resets the form', () => {
    const { window, document } = env;
    window.WorkoutEdit.editingLibraryItemId = 999;
    document.getElementById('exercise-library-name').value = 'old';
    document.getElementById('exercise-library-sets').value = '5';

    window.showExerciseLibraryModal();

    expect(window.WorkoutEdit.editingLibraryItemId).toBeNull();
    expect(document.getElementById('exercise-library-modal-title').textContent).toBe('Add Exercise');
    expect(document.getElementById('exercise-library-name').value).toBe('');
    expect(document.getElementById('exercise-library-sets').value).toBe('');
  });

  it('saveExerciseLibraryItem validates the required name field without calling the API', async () => {
    const { window, document } = env;
    const apiCallSpy = vi.fn();
    window.apiCall = apiCallSpy;
    window.Telegram.WebApp.showAlert = vi.fn();

    document.getElementById('exercise-library-name').value = '';

    await window.saveExerciseLibraryItem();

    expect(apiCallSpy).not.toHaveBeenCalled();
    expect(window.Telegram.WebApp.showAlert).toHaveBeenCalledTimes(1);
  });

  it('closeExerciseLibraryModal clears the closure-private editingLibraryItemId', () => {
    const { window } = env;
    window.WorkoutEdit.editingLibraryItemId = 42;

    window.closeExerciseLibraryModal();

    expect(window.WorkoutEdit.editingLibraryItemId).toBeNull();
  });

  // med-s5m.2 — canonical exercise-name suggestions from the static catalog.
  describe('catalog autocomplete (med-s5m.2)', () => {
    const CATALOG = {
      exercises: [
        { name: 'Barbell bench press' },
        { name: '3/4 sit-up' },
        { name: '' }, // dropped (empty)
      ],
    };

    function stubCatalogFetch(window, response) {
      const fetchSpy = vi.fn(async (url) => {
        if (String(url).includes('/static/data/exercises-catalog.json')) return response;
        return { ok: true, status: 200, json: async () => ({}) };
      });
      window.fetch = fetchSpy;
      return fetchSpy;
    }

    it('opening the add-exercise modal fills the catalog datalist with canonical names', async () => {
      const { window, document } = env;
      const fetchSpy = stubCatalogFetch(window, { ok: true, status: 200, json: async () => CATALOG });

      window.showExerciseLibraryModal();
      await window.WorkoutLibrary.ensureCatalogSuggestions(document.getElementById('exercise-catalog-datalist'));

      const values = Array.from(document.getElementById('exercise-catalog-datalist').options).map((o) => o.value);
      expect(values).toContain('Barbell bench press');
      expect(values).toContain('3/4 sit-up');
      expect(values).not.toContain(''); // empty names filtered out
      expect(fetchSpy).toHaveBeenCalled();
    });

    it('fetches the 913 KB asset only once across repeated opens', async () => {
      const { window, document } = env;
      const fetchSpy = stubCatalogFetch(window, { ok: true, status: 200, json: async () => CATALOG });
      const datalist = document.getElementById('exercise-catalog-datalist');

      await window.WorkoutLibrary.ensureCatalogSuggestions(datalist);
      await window.WorkoutLibrary.ensureCatalogSuggestions(datalist);

      const catalogFetches = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('exercises-catalog.json'));
      expect(catalogFetches).toHaveLength(1);
    });

    it('does not add duplicate options when a name is already present', async () => {
      const { window, document } = env;
      stubCatalogFetch(window, { ok: true, status: 200, json: async () => CATALOG });
      const datalist = document.getElementById('exercise-catalog-datalist');
      const pre = document.createElement('option');
      pre.value = 'Barbell bench press';
      datalist.appendChild(pre);

      await window.WorkoutLibrary.ensureCatalogSuggestions(datalist);

      const count = Array.from(datalist.options).filter((o) => o.value === 'Barbell bench press').length;
      expect(count).toBe(1);
    });

    it('a failed catalog fetch is silent and leaves the name field freely typable', async () => {
      const { window, document } = env;
      stubCatalogFetch(window, { ok: false, status: 500, json: async () => ({}) });
      const datalist = document.getElementById('exercise-catalog-datalist');

      await window.WorkoutLibrary.ensureCatalogSuggestions(datalist);

      expect(Array.from(datalist.options)).toHaveLength(0);
      // Free typing is unaffected: the input is a plain text field, datalist is suggest-only.
      const input = document.getElementById('exercise-library-name');
      input.value = 'My totally custom lift';
      expect(input.value).toBe('My totally custom lift');
    });
  });
});
