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

      await window.WorkoutLibrary.refreshSuggestions(datalist, 'b');

      expect(Array.from(datalist.options)).toHaveLength(0);
      expect(catalogFetchCount(fetchSpy)).toBe(0);
    });

    it('matches case-insensitively on a substring once 2 characters are typed', async () => {
      const { window, document } = env;
      stubCatalogFetch(window, { ok: true, status: 200, json: async () => CATALOG });
      const datalist = document.getElementById('exercise-catalog-datalist');

      await window.WorkoutLibrary.refreshSuggestions(datalist, 'BE');

      const values = Array.from(datalist.options).map((o) => o.value);
      expect(values).toContain('Barbell bench press');
      expect(values).not.toContain('3/4 sit-up');
      expect(values).not.toContain(''); // empty names filtered out
    });

    it('caps the suggestion list at 6 so the dropdown stays a short list', async () => {
      const { window, document } = env;
      const wide = { exercises: Array.from({ length: 40 }, (_, i) => ({ name: `Press variant ${i}` })) };
      stubCatalogFetch(window, { ok: true, status: 200, json: async () => wide });
      const datalist = document.getElementById('exercise-catalog-datalist');

      await window.WorkoutLibrary.refreshSuggestions(datalist, 'press');

      expect(Array.from(datalist.options)).toHaveLength(6);
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

      await window.WorkoutLibrary.refreshSuggestions(datalist, 'Press');

      const values = Array.from(datalist.options).map((o) => o.value);
      expect(values).toHaveLength(6);
      expect(values[0]).toBe('Press');
    });

    // med-max — #739 rebuilt only the catalog half, so the user's own library
    // (dumped in full by populatePickerOptions) still covered half the screen.
    it('rebuilds BOTH halves on every keystroke, with no accumulation across queries', async () => {
      const { window, document } = env;
      stubCatalogFetch(window, { ok: true, status: 200, json: async () => CATALOG });
      window.apiCall = vi.fn(async () => ([{ id: 7, name: 'My custom bench' }]));
      const datalist = document.getElementById('exercise-catalog-datalist');
      const input = document.getElementById('exercise-library-name');
      input.value = 'be';

      await window.WorkoutLibrary.populatePickerOptions(datalist, input);
      expect(Array.from(datalist.options).map((o) => o.value))
        .toEqual(['My custom bench', 'Barbell bench press']);

      await window.WorkoutLibrary.refreshSuggestions(datalist, 'sit');

      // The previous query's rows are gone — the library half included.
      expect(Array.from(datalist.options).map((o) => o.value)).toEqual(['3/4 sit-up']);
    });

    it('drops an in-flight refresh once a shorter query has repainted the datalist', async () => {
      const { window, document } = env;
      let releaseCatalog;
      const gate = new Promise((resolve) => { releaseCatalog = resolve; });
      window.fetch = vi.fn(async (url) => {
        if (!String(url).includes('exercises-catalog.json')) return { ok: true, status: 200, json: async () => ({}) };
        await gate;
        return { ok: true, status: 200, json: async () => CATALOG };
      });
      const datalist = document.getElementById('exercise-catalog-datalist');

      // "be" starts the one-and-only catalog fetch...
      const pending = window.WorkoutLibrary.refreshSuggestions(datalist, 'be');
      // ...the user deletes back to one character before it resolves.
      await window.WorkoutLibrary.refreshSuggestions(datalist, 'b');
      releaseCatalog();
      await pending;

      expect(Array.from(datalist.options)).toHaveLength(0);
    });

    // The library half is a local vault read; it must not wait on the 913 KB
    // catalog asset, or the popup keeps offering rows the user typed past.
    it('paints the library half before awaiting the catalog fetch', async () => {
      const { window, document } = env;
      let releaseCatalog;
      const gate = new Promise((resolve) => { releaseCatalog = resolve; });
      window.fetch = vi.fn(async (url) => {
        if (!String(url).includes('exercises-catalog.json')) return { ok: true, status: 200, json: async () => ({}) };
        await gate;
        return { ok: true, status: 200, json: async () => CATALOG };
      });
      window.apiCall = vi.fn(async () => ([
        { id: 7, name: 'My custom bench' },
        { id: 8, name: 'Bar dip' },
      ]));
      const datalist = document.getElementById('exercise-catalog-datalist');
      const input = document.getElementById('exercise-library-name');
      input.value = 'b';

      await window.WorkoutLibrary.populatePickerOptions(datalist, input);
      expect(Array.from(datalist.options).map((o) => o.value)).toEqual(['My custom bench', 'Bar dip']);

      // Second character: the catalog fetch is now in flight...
      input.value = 'be';
      const pending = input.oninput();

      // ...and the library half has already narrowed, synchronously.
      expect(Array.from(datalist.options).map((o) => o.value)).toEqual(['My custom bench']);

      releaseCatalog();
      await pending;
      expect(Array.from(datalist.options).map((o) => o.value))
        .toEqual(['My custom bench', 'Barbell bench press']);
    });

    it('fetches the 913 KB asset only once across repeated refreshes', async () => {
      const { window, document } = env;
      const fetchSpy = stubCatalogFetch(window, { ok: true, status: 200, json: async () => CATALOG });
      const datalist = document.getElementById('exercise-catalog-datalist');

      await window.WorkoutLibrary.refreshSuggestions(datalist, 'be');
      await window.WorkoutLibrary.refreshSuggestions(datalist, 'ben');

      expect(catalogFetchCount(fetchSpy)).toBe(1);
    });

    it('a library name shadows the identically-named catalog suggestion, case-insensitively', async () => {
      const { window, document } = env;
      stubCatalogFetch(window, { ok: true, status: 200, json: async () => CATALOG });
      window.apiCall = vi.fn(async () => ([{ id: 7, name: 'Barbell Bench Press', default_sets: 5 }]));
      const datalist = document.getElementById('exercise-catalog-datalist');
      const input = document.getElementById('exercise-library-name');
      input.value = 'bench';

      await window.WorkoutLibrary.populatePickerOptions(datalist, input);

      // One row, and it is the autofill-carrying library one.
      const options = Array.from(datalist.options);
      expect(options).toHaveLength(1);
      expect(options[0].value).toBe('Barbell Bench Press');
      expect(options[0].dataset.id).toBe('7');
    });

    it('a failed catalog fetch is silent, retryable, and leaves the name field freely typable', async () => {
      const { window, document } = env;
      const fetchSpy = stubCatalogFetch(window, { ok: false, status: 500, json: async () => ({}) });
      const datalist = document.getElementById('exercise-catalog-datalist');

      await window.WorkoutLibrary.refreshSuggestions(datalist, 'bench');
      expect(Array.from(datalist.options)).toHaveLength(0);

      // Retryable: the single-flight cache is cleared on failure.
      await window.WorkoutLibrary.refreshSuggestions(datalist, 'bench');
      expect(catalogFetchCount(fetchSpy)).toBe(2);

      // Free typing is unaffected: the input is a plain text field, datalist is suggest-only.
      const input = document.getElementById('exercise-library-name');
      input.value = 'My totally custom lift';
      expect(input.value).toBe('My totally custom lift');
    });

    it('bindTypeahead wires the input event and clears stale options on open', async () => {
      const { window, document } = env;
      stubCatalogFetch(window, { ok: true, status: 200, json: async () => CATALOG });
      const datalist = document.getElementById('exercise-catalog-datalist');
      const input = document.getElementById('exercise-library-name');

      // Leftover catalog options from a previous open.
      await window.WorkoutLibrary.refreshSuggestions(datalist, 'bench');
      expect(Array.from(datalist.options).length).toBeGreaterThan(0);

      input.value = '';
      await window.WorkoutLibrary.bindTypeahead(input, datalist);
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
      await window.WorkoutLibrary.refreshSuggestions(datalist, 'bench');

      window.showExerciseLibraryModal();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(Array.from(datalist.options)).toHaveLength(0);
    });

    describe('shared picker (populatePickerOptions)', () => {
      it('renders nothing until the user types, then library matches before catalog matches', async () => {
        const { window, document } = env;
        stubCatalogFetch(window, { ok: true, status: 200, json: async () => CATALOG });
        window.apiCall = vi.fn(async () => ([
          { id: 3, name: 'My custom bench', default_sets: 4, default_reps_min: 8, default_reps_max: 10, default_weight_kg: 60 },
        ]));
        const datalist = document.getElementById('exercise-catalog-datalist');
        const input = document.getElementById('exercise-library-name');
        input.value = '';

        await window.WorkoutLibrary.populatePickerOptions(datalist, input);

        // med-max: an empty field means an empty popup, not the whole library.
        expect(Array.from(datalist.options)).toHaveLength(0);

        // One character opens the library half; the catalog stays gated at 2 so
        // the 913 KB asset is not fetched on the first keystroke.
        input.value = 'b';
        await input.oninput();
        expect(Array.from(datalist.options).map((o) => o.value)).toEqual(['My custom bench']);

        input.value = 'bench';
        await input.oninput();
        expect(Array.from(datalist.options).map((o) => o.value))
          .toEqual(['My custom bench', 'Barbell bench press']);
      });

      it('a library option keeps its autofill dataset; a catalog-only match carries no id', async () => {
        const { window, document } = env;
        stubCatalogFetch(window, { ok: true, status: 200, json: async () => CATALOG });
        window.apiCall = vi.fn(async () => ([
          { id: 3, name: 'Bench day special', default_sets: 4, default_reps_min: 8, default_reps_max: 10, default_weight_kg: 60 },
        ]));
        const datalist = document.getElementById('exercise-catalog-datalist');
        const input = document.getElementById('exercise-library-name');
        input.value = 'bench';

        await window.WorkoutLibrary.populatePickerOptions(datalist, input);

        const options = Array.from(datalist.options);
        expect(options.map((o) => o.value)).toEqual(['Bench day special', 'Barbell bench press']);
        expect(options[0].dataset.id).toBe('3');
        expect(options[0].dataset.sets).toBe('4');
        expect(options[0].dataset.repsMin).toBe('8');
        expect(options[0].dataset.repsMax).toBe('10');
        expect(options[0].dataset.weight).toBe('60');

        // Catalog-only picks stay id-less so callers route them through
        // resolveOrCreateLibraryId instead of posting a bogus exercise_id.
        expect(options[1].dataset.id).toBeUndefined();
      });

      it('caps the TOTAL at 6 across both halves, and skips the catalog fetch when the library fills it', async () => {
        const { window, document } = env;
        const wide = { exercises: Array.from({ length: 20 }, (_, i) => ({ name: `catalog press ${i}` })) };
        const fetchSpy = stubCatalogFetch(window, { ok: true, status: 200, json: async () => wide });
        window.apiCall = vi.fn(async () => (
          Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Library press ${i}` }))
        ));
        const datalist = document.getElementById('exercise-catalog-datalist');
        const input = document.getElementById('exercise-library-name');
        input.value = 'press';

        await window.WorkoutLibrary.populatePickerOptions(datalist, input);

        const values = Array.from(datalist.options).map((o) => o.value);
        expect(values).toHaveLength(6);
        expect(values.every((v) => v.startsWith('Library press'))).toBe(true);
        expect(catalogFetchCount(fetchSpy)).toBe(0);
      });

      it('hoists an exact library match past the cap so a picked name is re-findable at `change`', async () => {
        const { window, document } = env;
        stubCatalogFetch(window, { ok: true, status: 200, json: async () => ({ exercises: [] }) });
        window.apiCall = vi.fn(async () => ([
          ...Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `Press variant ${i}` })),
          { id: 99, name: 'Press', default_sets: 3 },
        ]));
        const datalist = document.getElementById('exercise-catalog-datalist');
        const input = document.getElementById('exercise-library-name');
        // Picking from the native popup fires `input` with the full name...
        input.value = 'Press';

        await window.WorkoutLibrary.populatePickerOptions(datalist, input);

        // ...so the `change` handlers' datalist.options lookup still finds it.
        const options = Array.from(datalist.options);
        expect(options).toHaveLength(6);
        expect(options[0].value).toBe('Press');
        expect(options[0].dataset.id).toBe('99');
      });
    });
  });
});
