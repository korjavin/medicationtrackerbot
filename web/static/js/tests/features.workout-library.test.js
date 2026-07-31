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

  // med-s5m.2 (catalog suggestions) -> med-3q8.1 (type-ahead filtering) ->
  // med-max (drop <datalist> for our own in-flow list). A native datalist popup
  // can be neither height-capped nor styled, so on a phone it covered half the
  // screen and buried the keyboard whatever the option count.
  describe('exercise name picker (med-s5m.2, med-3q8.1, med-max)', () => {
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

    function rowsOf(mount) {
      return Array.from(mount.querySelectorAll('.wg-exercise-suggest__row')).map((b) => b.textContent);
    }

    // Binds the shared picker to the library modal's field. `library` defaults
    // to undefined => catalog-only, which is what that modal uses in prod.
    async function mountPicker(env, { library, onPick } = {}) {
      const { window, document } = env;
      if (library) window.apiCall = vi.fn(async () => library);
      const input = document.getElementById('exercise-library-name');
      const mount = document.getElementById('exercise-library-suggest');
      await window.WorkoutLibrary.bindExercisePicker({
        input, mount, withLibrary: Boolean(library), onPick,
      });
      return { input, mount };
    }

    it('renders no list at all while the field is empty', async () => {
      const { mount } = await mountPicker(env, { library: [{ id: 1, name: 'Deadlift' }] });

      // The exact screenshot case in med-max.
      expect(mount.hidden).toBe(true);
      expect(rowsOf(mount)).toEqual([]);
    });

    it('shows library matches from ONE character without fetching the 913 KB catalog', async () => {
      const fetchSpy = stubCatalogFetch(env.window, { ok: true, status: 200, json: async () => CATALOG });
      const { input, mount } = await mountPicker(env, {
        library: [{ id: 1, name: 'Deadlift' }, { id: 2, name: 'Barbell row' }],
      });

      input.value = 'd';
      await input.oninput();

      expect(mount.hidden).toBe(false);
      expect(rowsOf(mount)).toEqual(['Deadlift']);
      expect(catalogFetchCount(fetchSpy)).toBe(0);
    });

    it('emits nothing (and does not even fetch) under 2 characters with no library half', async () => {
      const fetchSpy = stubCatalogFetch(env.window, { ok: true, status: 200, json: async () => CATALOG });
      const { input, mount } = await mountPicker(env);

      input.value = 'b';
      await input.oninput();

      expect(mount.hidden).toBe(true);
      expect(catalogFetchCount(fetchSpy)).toBe(0);
    });

    it('matches the catalog case-insensitively on a substring once 2 characters are typed', async () => {
      stubCatalogFetch(env.window, { ok: true, status: 200, json: async () => CATALOG });
      const { input, mount } = await mountPicker(env);

      input.value = 'BE';
      await input.oninput();

      expect(rowsOf(mount)).toEqual(['Barbell bench press']); // '' and '3/4 sit-up' excluded
    });

    // Matching is two-tier (med-max addendum). Tier 1: every query token is a
    // prefix of some word in the name, order-independent. Tier 2: the whole
    // query is a substring. Tier 1 outranks tier 2.
    describe('multi-token word-prefix matching', () => {
      const WORDY = {
        exercises: [
          { name: 'lateral rows' },
          { name: 'barbell bench press' },
          { name: '3/4 sit-up' },
        ],
      };

      it("finds 'lateral rows' for the query 'lat ro'", async () => {
        stubCatalogFetch(env.window, { ok: true, status: 200, json: async () => WORDY });
        const { input, mount } = await mountPicker(env);

        input.value = 'lat ro';
        await input.oninput();

        expect(rowsOf(mount)).toContain('lateral rows');
      });

      it('ignores token order — "ro lat" finds it too', async () => {
        stubCatalogFetch(env.window, { ok: true, status: 200, json: async () => WORDY });
        const { input, mount } = await mountPicker(env);

        input.value = 'ro lat';
        await input.oninput();

        expect(rowsOf(mount)).toContain('lateral rows');
      });

      it("still finds 'barbell bench press' mid-word via the tier-2 substring fallback", async () => {
        stubCatalogFetch(env.window, { ok: true, status: 200, json: async () => WORDY });
        const { input, mount } = await mountPicker(env);

        input.value = 'ench';
        await input.oninput();

        expect(rowsOf(mount)).toEqual(['barbell bench press']);
      });

      it('ranks a word-prefix match above a substring-only match', async () => {
        stubCatalogFetch(env.window, {
          ok: true,
          status: 200,
          // 'preacher curl' only contains "row" mid-word; 'rows' starts with it.
          json: async () => ({ exercises: [{ name: 'narrow pulldown' }, { name: 'rows' }] }),
        });
        const { input, mount } = await mountPicker(env);

        input.value = 'row';
        await input.oninput();

        expect(rowsOf(mount)).toEqual(['rows', 'narrow pulldown']);
      });

      it('splits names on / and - so "sit up" finds "3/4 sit-up"', async () => {
        stubCatalogFetch(env.window, { ok: true, status: 200, json: async () => WORDY });
        const { input, mount } = await mountPicker(env);

        input.value = 'sit up';
        await input.oninput();

        expect(rowsOf(mount)).toEqual(['3/4 sit-up']);
      });
    });

    it('ranks library matches above catalog matches', async () => {
      stubCatalogFetch(env.window, { ok: true, status: 200, json: async () => CATALOG });
      const { input, mount } = await mountPicker(env, { library: [{ id: 1, name: 'Bench day special' }] });

      input.value = 'bench';
      await input.oninput();

      expect(rowsOf(mount)).toEqual(['Bench day special', 'Barbell bench press']);
    });

    it('a library name shadows the identically-named catalog suggestion, case-insensitively', async () => {
      stubCatalogFetch(env.window, { ok: true, status: 200, json: async () => CATALOG });
      const picked = [];
      const { input, mount } = await mountPicker(env, {
        library: [{ id: 7, name: 'Barbell Bench Press', default_sets: 5 }],
        onPick: (item) => picked.push(item),
      });

      input.value = 'bench';
      await input.oninput();

      expect(rowsOf(mount)).toEqual(['Barbell Bench Press']);
      mount.querySelector('.wg-exercise-suggest__row').click();
      expect(picked[0].id).toBe(7); // the autofill-carrying row won
    });

    it('caps the list at 6 rows, and skips the catalog fetch when the library already fills it', async () => {
      const wide = { exercises: Array.from({ length: 40 }, (_, i) => ({ name: `catalog press ${i}` })) };
      const fetchSpy = stubCatalogFetch(env.window, { ok: true, status: 200, json: async () => wide });
      const { input, mount } = await mountPicker(env, {
        library: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Library press ${i}` })),
      });

      input.value = 'press';
      await input.oninput();

      const rows = rowsOf(mount);
      expect(rows).toHaveLength(6);
      expect(rows.every((r) => r.startsWith('Library press'))).toBe(true);
      expect(catalogFetchCount(fetchSpy)).toBe(0);
    });

    it('hoists an exact match past the cap so finishing a name by hand keeps its own row', async () => {
      // The exact name sits last — a naive slice would drop it.
      const wide = {
        exercises: [
          ...Array.from({ length: 40 }, (_, i) => ({ name: `Press variant ${i}` })),
          { name: 'Press' },
        ],
      };
      stubCatalogFetch(env.window, { ok: true, status: 200, json: async () => wide });
      const { input, mount } = await mountPicker(env);

      input.value = 'Press';
      await input.oninput();

      const rows = rowsOf(mount);
      expect(rows).toHaveLength(6);
      expect(rows[0]).toBe('Press');
    });

    it('rebuilds the whole list on every keystroke, with no accumulation across queries', async () => {
      stubCatalogFetch(env.window, { ok: true, status: 200, json: async () => CATALOG });
      const { input, mount } = await mountPicker(env, { library: [{ id: 7, name: 'My custom bench' }] });

      input.value = 'be';
      await input.oninput();
      expect(rowsOf(mount)).toEqual(['My custom bench', 'Barbell bench press']);

      input.value = 'sit';
      await input.oninput();
      // The previous query's rows are gone — the library half included.
      expect(rowsOf(mount)).toEqual(['3/4 sit-up']);
    });

    // The library half is a local vault read; it must not wait on the 913 KB
    // catalog asset, or the list keeps offering rows the user typed past.
    it('paints the library half before awaiting the catalog fetch', async () => {
      const { window } = env;
      let releaseCatalog;
      const gate = new Promise((resolve) => { releaseCatalog = resolve; });
      window.fetch = vi.fn(async (url) => {
        if (!String(url).includes('exercises-catalog.json')) return { ok: true, status: 200, json: async () => ({}) };
        await gate;
        return { ok: true, status: 200, json: async () => CATALOG };
      });
      const { input, mount } = await mountPicker(env, {
        library: [{ id: 7, name: 'My custom bench' }, { id: 8, name: 'Bar dip' }],
      });

      input.value = 'b';
      await input.oninput();
      expect(rowsOf(mount)).toEqual(['My custom bench', 'Bar dip']);

      // Second character: the catalog fetch is now in flight...
      input.value = 'be';
      const pending = input.oninput();
      // ...and the library half has already narrowed, synchronously.
      expect(rowsOf(mount)).toEqual(['My custom bench']);

      releaseCatalog();
      await pending;
      expect(rowsOf(mount)).toEqual(['My custom bench', 'Barbell bench press']);
    });

    it('drops an in-flight refresh once a shorter query has repainted the list', async () => {
      const { window } = env;
      let releaseCatalog;
      const gate = new Promise((resolve) => { releaseCatalog = resolve; });
      window.fetch = vi.fn(async (url) => {
        if (!String(url).includes('exercises-catalog.json')) return { ok: true, status: 200, json: async () => ({}) };
        await gate;
        return { ok: true, status: 200, json: async () => CATALOG };
      });
      const { input, mount } = await mountPicker(env);

      // "be" starts the one-and-only catalog fetch...
      input.value = 'be';
      const pending = input.oninput();
      // ...the user deletes back to one character before it resolves.
      input.value = 'b';
      await input.oninput();
      releaseCatalog();
      await pending;

      expect(mount.hidden).toBe(true);
      expect(rowsOf(mount)).toEqual([]);
    });

    it('fetches the 913 KB asset only once across repeated refreshes', async () => {
      const fetchSpy = stubCatalogFetch(env.window, { ok: true, status: 200, json: async () => CATALOG });
      const { input } = await mountPicker(env);

      input.value = 'be';
      await input.oninput();
      input.value = 'ben';
      await input.oninput();

      expect(catalogFetchCount(fetchSpy)).toBe(1);
    });

    it('a failed catalog fetch is silent, retryable, and leaves the name field freely typable', async () => {
      const fetchSpy = stubCatalogFetch(env.window, { ok: false, status: 500, json: async () => ({}) });
      const { input, mount } = await mountPicker(env);

      input.value = 'bench';
      await input.oninput();
      expect(mount.hidden).toBe(true);

      // Retryable: the single-flight cache is cleared on failure.
      await input.oninput();
      expect(catalogFetchCount(fetchSpy)).toBe(2);

      // Free typing is unaffected: the input is a plain text field.
      input.value = 'My totally custom lift';
      expect(input.value).toBe('My totally custom lift');
    });

    it('the add-exercise modal opens with the list closed even after a previous query', async () => {
      stubCatalogFetch(env.window, { ok: true, status: 200, json: async () => CATALOG });
      const { input, mount } = await mountPicker(env);
      input.value = 'bench';
      await input.oninput();
      expect(mount.hidden).toBe(false);

      env.window.showExerciseLibraryModal();

      expect(mount.hidden).toBe(true);
      expect(rowsOf(mount)).toEqual([]);
    });

    describe('picking a row', () => {
      it('a library row hands back its id and defaults; a catalog row hands back only a name', async () => {
        stubCatalogFetch(env.window, { ok: true, status: 200, json: async () => CATALOG });
        const picked = [];
        const { input, mount } = await mountPicker(env, {
          library: [{
            id: 3, name: 'Bench day special',
            default_sets: 4, default_reps_min: 8, default_reps_max: 10, default_weight_kg: 60,
          }],
          onPick: (item) => picked.push(item),
        });

        input.value = 'bench';
        await input.oninput();
        const rows = mount.querySelectorAll('.wg-exercise-suggest__row');

        rows[0].click();
        expect(input.value).toBe('Bench day special');
        expect(picked[0]).toMatchObject({
          id: 3, default_sets: 4, default_reps_min: 8, default_reps_max: 10, default_weight_kg: 60,
        });
        // Picking closes the list.
        expect(mount.hidden).toBe(true);

        input.value = 'bench';
        await input.oninput();
        // Catalog-only rows carry no id, so callers must route them through
        // resolveOrCreateLibraryId on save.
        const catalogRow = Array.from(mount.querySelectorAll('.wg-exercise-suggest__row'))
          .find((b) => b.textContent === 'Barbell bench press');
        catalogRow.click();
        expect(input.value).toBe('Barbell bench press');
        expect(picked[1].id).toBeUndefined();
      });

      // The classic hand-rolled-autocomplete failure: hide on blur alone and
      // the row is gone before the click fires, so nothing is ever picked.
      it('keeps focus on the input on mousedown so a tap can still land on the row', async () => {
        stubCatalogFetch(env.window, { ok: true, status: 200, json: async () => CATALOG });
        const picked = [];
        const { input, mount } = await mountPicker(env, {
          library: [{ id: 3, name: 'Bench day special' }],
          onPick: (item) => picked.push(item),
        });

        input.value = 'bench';
        await input.oninput();
        const row = mount.querySelector('.wg-exercise-suggest__row');

        const down = new env.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
        row.dispatchEvent(down);
        expect(down.defaultPrevented).toBe(true); // focus stays put => no blur => row survives
        expect(mount.hidden).toBe(false);

        row.click();
        expect(picked).toHaveLength(1);
        expect(input.value).toBe('Bench day special');
      });

      // The rows are real buttons precisely so keyboard users can reach them;
      // hiding on any blur would make that impossible.
      it('stays open while focus moves into the list, and returns focus on pick', async () => {
        stubCatalogFetch(env.window, { ok: true, status: 200, json: async () => CATALOG });
        const { document } = env;
        const { input, mount } = await mountPicker(env, { library: [{ id: 3, name: 'Bench day special' }] });

        input.value = 'bench';
        await input.oninput();
        const row = mount.querySelector('.wg-exercise-suggest__row');

        // Tabbing from the input onto a row.
        input.onblur({ relatedTarget: row });
        expect(mount.hidden).toBe(false);

        row.click();
        expect(input.value).toBe('Bench day special');
        expect(document.activeElement).toBe(input);
      });

      it('blur closes the list, and Escape closes it too', async () => {
        stubCatalogFetch(env.window, { ok: true, status: 200, json: async () => CATALOG });
        const { input, mount } = await mountPicker(env, { library: [{ id: 3, name: 'Bench day special' }] });

        input.value = 'bench';
        await input.oninput();
        expect(mount.hidden).toBe(false);

        input.onkeydown({ key: 'Escape' });
        expect(mount.hidden).toBe(true);

        await input.oninput();
        expect(mount.hidden).toBe(false);
        input.onblur();
        expect(mount.hidden).toBe(true);
      });

      it('renders rows as real buttons in the document flow, never an inline-styled overlay', async () => {
        stubCatalogFetch(env.window, { ok: true, status: 200, json: async () => CATALOG });
        const { input, mount } = await mountPicker(env, { library: [{ id: 3, name: 'Bench day special' }] });

        input.value = 'bench';
        await input.oninput();

        const row = mount.querySelector('.wg-exercise-suggest__row');
        expect(row.tagName).toBe('BUTTON');
        expect(row.getAttribute('type')).toBe('button');
        expect(row.closest('ul')).not.toBeNull();
        // Visibility is the `hidden` attribute + CSS tokens, never inline style.
        expect(mount.getAttribute('style')).toBeNull();
        expect(row.getAttribute('style')).toBeNull();
      });
    });
  });

});
