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

  // med-s5m.2 — canonical exercise-name suggestions from the static catalog,
  // type-ahead filtered since med-3q8.1 (a bulk dump of all 1324 names made
  // mobile render a full-screen suggestion sheet instead of a short list).
  describe('catalog type-ahead (med-s5m.2, med-3q8.1)', () => {
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

    function catalogFetchCount(fetchSpy) {
      return fetchSpy.mock.calls.filter((c) => String(c[0]).includes('exercises-catalog.json')).length;
    }

    it('emits no catalog options (and does not even fetch) under 2 typed characters', async () => {
      const { window, document } = env;
      const fetchSpy = stubCatalogFetch(window, { ok: true, status: 200, json: async () => CATALOG });
      const datalist = document.getElementById('exercise-catalog-datalist');

      await window.WorkoutLibrary.refreshCatalogSuggestions(datalist, 'b');

      expect(Array.from(datalist.options)).toHaveLength(0);
      expect(catalogFetchCount(fetchSpy)).toBe(0);
    });

    it('matches case-insensitively on a substring once 2 characters are typed', async () => {
      const { window, document } = env;
      stubCatalogFetch(window, { ok: true, status: 200, json: async () => CATALOG });
      const datalist = document.getElementById('exercise-catalog-datalist');

      await window.WorkoutLibrary.refreshCatalogSuggestions(datalist, 'BE');

      const values = Array.from(datalist.options).map((o) => o.value);
      expect(values).toContain('Barbell bench press');
      expect(values).not.toContain('3/4 sit-up');
      expect(values).not.toContain(''); // empty names filtered out
    });

    it('caps the suggestion list at 15 so the dropdown stays a short list', async () => {
      const { window, document } = env;
      const wide = { exercises: Array.from({ length: 40 }, (_, i) => ({ name: `Press variant ${i}` })) };
      stubCatalogFetch(window, { ok: true, status: 200, json: async () => wide });
      const datalist = document.getElementById('exercise-catalog-datalist');

      await window.WorkoutLibrary.refreshCatalogSuggestions(datalist, 'press');

      expect(Array.from(datalist.options)).toHaveLength(15);
    });

    it('keeps an exact match inside the cap so a picked name is still re-findable', async () => {
      const { window, document } = env;
      // The exact name sits last in catalog order — a naive slice would drop it,
      // and the pickers re-look-up the picked value in datalist.options.
      const wide = {
        exercises: [
          ...Array.from({ length: 40 }, (_, i) => ({ name: `Press variant ${i}` })),
          { name: 'Press' },
        ],
      };
      stubCatalogFetch(window, { ok: true, status: 200, json: async () => wide });
      const datalist = document.getElementById('exercise-catalog-datalist');

      await window.WorkoutLibrary.refreshCatalogSuggestions(datalist, 'Press');

      const values = Array.from(datalist.options).map((o) => o.value);
      expect(values).toHaveLength(15);
      expect(values[0]).toBe('Press');
    });

    it('rebuilds only the catalog half, leaving user-library options in place', async () => {
      const { window, document } = env;
      stubCatalogFetch(window, { ok: true, status: 200, json: async () => CATALOG });
      const datalist = document.getElementById('exercise-catalog-datalist');
      const libraryOption = document.createElement('option');
      libraryOption.value = 'My custom lift';
      libraryOption.dataset.id = '7';
      datalist.appendChild(libraryOption);

      await window.WorkoutLibrary.refreshCatalogSuggestions(datalist, 'BE');
      await window.WorkoutLibrary.refreshCatalogSuggestions(datalist, 'sit');

      const values = Array.from(datalist.options).map((o) => o.value);
      expect(values).toContain('My custom lift');
      expect(values).toContain('3/4 sit-up');
      // Previous query's catalog options are gone — no accumulation across keystrokes.
      expect(values).not.toContain('Barbell bench press');
    });

    it('fetches the 913 KB asset only once across repeated refreshes', async () => {
      const { window, document } = env;
      const fetchSpy = stubCatalogFetch(window, { ok: true, status: 200, json: async () => CATALOG });
      const datalist = document.getElementById('exercise-catalog-datalist');

      await window.WorkoutLibrary.refreshCatalogSuggestions(datalist, 'be');
      await window.WorkoutLibrary.refreshCatalogSuggestions(datalist, 'ben');

      expect(catalogFetchCount(fetchSpy)).toBe(1);
    });

    it('does not add duplicate options when a name is already present', async () => {
      const { window, document } = env;
      stubCatalogFetch(window, { ok: true, status: 200, json: async () => CATALOG });
      const datalist = document.getElementById('exercise-catalog-datalist');
      const pre = document.createElement('option');
      pre.value = 'Barbell bench press';
      datalist.appendChild(pre);

      await window.WorkoutLibrary.refreshCatalogSuggestions(datalist, 'bench');

      const count = Array.from(datalist.options).filter((o) => o.value === 'Barbell bench press').length;
      expect(count).toBe(1);
    });

    it('a failed catalog fetch is silent, retryable, and leaves the name field freely typable', async () => {
      const { window, document } = env;
      const fetchSpy = stubCatalogFetch(window, { ok: false, status: 500, json: async () => ({}) });
      const datalist = document.getElementById('exercise-catalog-datalist');

      await window.WorkoutLibrary.refreshCatalogSuggestions(datalist, 'bench');
      expect(Array.from(datalist.options)).toHaveLength(0);

      // Retryable: the single-flight cache is cleared on failure.
      await window.WorkoutLibrary.refreshCatalogSuggestions(datalist, 'bench');
      expect(catalogFetchCount(fetchSpy)).toBe(2);

      // Free typing is unaffected: the input is a plain text field, datalist is suggest-only.
      const input = document.getElementById('exercise-library-name');
      input.value = 'My totally custom lift';
      expect(input.value).toBe('My totally custom lift');
    });

    it('bindCatalogTypeahead wires the input event and clears stale options on open', async () => {
      const { window, document } = env;
      stubCatalogFetch(window, { ok: true, status: 200, json: async () => CATALOG });
      const datalist = document.getElementById('exercise-catalog-datalist');
      const input = document.getElementById('exercise-library-name');

      // Leftover catalog options from a previous open.
      await window.WorkoutLibrary.refreshCatalogSuggestions(datalist, 'bench');
      expect(Array.from(datalist.options).length).toBeGreaterThan(0);

      input.value = '';
      await window.WorkoutLibrary.bindCatalogTypeahead(input, datalist);
      expect(Array.from(datalist.options)).toHaveLength(0);

      input.value = 'sit';
      input.dispatchEvent(new window.Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(Array.from(datalist.options).map((o) => o.value)).toContain('3/4 sit-up');
    });

    it('the add-exercise modal opens with an empty datalist until the user types', async () => {
      const { window, document } = env;
      stubCatalogFetch(window, { ok: true, status: 200, json: async () => CATALOG });
      const datalist = document.getElementById('exercise-catalog-datalist');
      await window.WorkoutLibrary.refreshCatalogSuggestions(datalist, 'bench');

      window.showExerciseLibraryModal();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(Array.from(datalist.options)).toHaveLength(0);
    });

    describe('shared picker (populatePickerOptions)', () => {
      it('shows only library entries until 2 characters are typed, then adds matches', async () => {
        const { window, document } = env;
        stubCatalogFetch(window, { ok: true, status: 200, json: async () => CATALOG });
        window.apiCall = vi.fn(async () => ([
          { id: 3, name: 'My custom lift', default_sets: 4, default_reps_min: 8, default_reps_max: 10, default_weight_kg: 60 },
        ]));
        const datalist = document.getElementById('exercise-catalog-datalist');
        const input = document.getElementById('exercise-library-name');
        input.value = '';

        await window.WorkoutLibrary.populatePickerOptions(datalist, input);

        expect(Array.from(datalist.options).map((o) => o.value)).toEqual(['My custom lift']);

        input.value = 'bench';
        await input.oninput();

        const values = Array.from(datalist.options).map((o) => o.value);
        expect(values).toContain('My custom lift');
        expect(values).toContain('Barbell bench press');
      });

      it('a library option keeps its autofill dataset; a catalog-only match carries no id', async () => {
        const { window, document } = env;
        stubCatalogFetch(window, { ok: true, status: 200, json: async () => CATALOG });
        window.apiCall = vi.fn(async () => ([
          { id: 3, name: 'Barbell bench press', default_sets: 4, default_reps_min: 8, default_reps_max: 10, default_weight_kg: 60 },
        ]));
        const datalist = document.getElementById('exercise-catalog-datalist');
        const input = document.getElementById('exercise-library-name');
        input.value = 'sit';

        await window.WorkoutLibrary.populatePickerOptions(datalist, input);

        const options = Array.from(datalist.options);
        // The library entry shadows the identically-named catalog suggestion.
        const library = options.filter((o) => o.value === 'Barbell bench press');
        expect(library).toHaveLength(1);
        expect(library[0].dataset.id).toBe('3');
        expect(library[0].dataset.sets).toBe('4');

        // Catalog-only picks stay id-less so callers route them through
        // resolveOrCreateLibraryId instead of posting a bogus exercise_id.
        const catalogOnly = options.find((o) => o.value === '3/4 sit-up');
        expect(catalogOnly).toBeDefined();
        expect(catalogOnly.dataset.id).toBeUndefined();
      });
    });
  });
});
