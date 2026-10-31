// Focused integration tests for the extracted features/workout/library.js
// sub-file. Covers the WorkoutLibrary public-API surface and the
// closure-private editingLibraryItemId accessor exposed on WorkoutEdit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { installApiCache, loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const CSS_PATH = path.resolve(__dirname_, '../../../../web/static/css/styles.css');

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
    window.safeAlert = vi.fn();

    document.getElementById('exercise-library-name').value = '';

    await window.saveExerciseLibraryItem();

    expect(apiCallSpy).not.toHaveBeenCalled();
    expect(window.safeAlert).toHaveBeenCalledTimes(1);
  });

  // A new row saved with the "Auto" muscle group that the static catalog
  // cannot classify gets one LLM pass over its name (cloud only); a catalog
  // hit or a manual tag skips the call.
  it('saveExerciseLibraryItem auto-tags a catalog-unresolved name on create, in cloud mode only', async () => {
    const { window, document } = env;
    window.__MEDTRACKER_CLOUD__ = true;
    window.loadExerciseLibrary = vi.fn();
    window.WorkoutExerciseCatalog.getBodyPart = vi.fn(async (name) => (name === 'Bench Press' ? 'chest' : null));
    const calls = [];
    window.apiCall = vi.fn(async (url, method, body) => {
      calls.push([url, body]);
      if (url.endsWith('/auto-tag')) return { tagged: [{ name: body.names[0], body_part: 'back' }], skipped: [] };
      return { id: 7 };
    });
    window.WorkoutEdit.editingLibraryItemId = null;

    document.getElementById('exercise-library-name').value = 'Тяга блока';
    document.getElementById('exercise-library-body-part').value = '';
    await window.saveExerciseLibraryItem();
    await vi.waitFor(() => {
      expect(calls.map(([u]) => u)).toEqual(['/api/workout/exercise-library/create', '/api/workout/exercise-library/auto-tag']);
    });
    expect(calls[1][1]).toEqual({ names: ['Тяга блока'] });

    // Catalog resolves the name -> no LLM call.
    calls.length = 0;
    document.getElementById('exercise-library-name').value = 'Bench Press';
    await window.saveExerciseLibraryItem();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.map(([u]) => u)).toEqual(['/api/workout/exercise-library/create']);

    // Edit path never auto-tags, even for an unresolved name.
    calls.length = 0;
    window.WorkoutEdit.editingLibraryItemId = 7;
    document.getElementById('exercise-library-name').value = 'Присед';
    await window.saveExerciseLibraryItem();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.map(([u]) => u)).toEqual(['/api/workout/exercise-library/update?id=7']);
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

        const esc = new env.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
        input.onkeydown(esc);
        // The open list eats the Esc so ModalManager does not also close the modal.
        expect(esc.defaultPrevented).toBe(true);
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

      // Regression (med-hzx): the row's hover/focus affordance used --wg-ink-08
      // and --wg-ink-15 — dark-teal ink tokens meant for light/paper surfaces —
      // on a dropdown that sits on a dark card, so it rendered at effectively
      // zero contrast. `outline: none` then removed the UA focus ring too,
      // leaving keyboard nav with no visible target at all. jsdom computes
      // neither cascade nor contrast, so the honest assertions are which tokens
      // the rules reference and that focus still draws a ring.
      it('hover/focus affordance uses light-on-dark tokens and keeps a focus ring', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        const rules = css.slice(css.indexOf('.wg-exercise-suggest__row:hover'));

        // The light-surface ink tokens must not come back on this component.
        const suggestRules = rules.slice(0, rules.indexOf('.wg-workouts-log-set-modal'));
        expect(suggestRules).not.toMatch(/var\(--wg-ink-08\)/);
        expect(suggestRules).not.toMatch(/var\(--wg-ink-15\)/);
        expect(suggestRules).toMatch(/var\(--wg-border-strong\)/);

        // Focus keeps a real ring, and it is inset so the `overflow-y: auto`
        // scroller cannot clip it on the first and last rows. `lastIndexOf`
        // because the selector also appears as the tail of the hover rule's
        // selector list above — the dedicated rule is the later one.
        const focusRule = suggestRules.slice(
          suggestRules.lastIndexOf('.wg-exercise-suggest__row:focus-visible {'),
        );
        const focusBlock = focusRule.slice(0, focusRule.indexOf('}'));
        expect(focusBlock).toMatch(/outline:\s*2px solid/);
        expect(focusBlock).not.toMatch(/outline:\s*none/);
        expect(focusBlock).toMatch(/outline-offset:\s*-/);
      });
    });
  });

  // Library screen: search box + Mine/All source toggle. "Mine" is the user's
  // own rows; "All" also lists the vendored static catalog, so the imported
  // exercises are browsable and not only reachable by typing a name.
  describe('search + Mine/All source toggle', () => {
    const CATALOG = {
      exercises: [
        { name: 'Barbell bench press', equipment: 'barbell', target: 'pectorals' },
        { name: 'Deadlift', equipment: 'barbell', target: 'glutes' },
        { name: 'Bench dip', equipment: 'body weight', target: 'triceps' },
      ],
    };
    const LIBRARY = [
      { id: 1, name: 'Deadlift', default_sets: 3, default_reps_min: 5 },
      { id: 2, name: 'Overhead press', default_sets: 4, default_reps_min: 8 },
    ];

    async function loadLibrary(env, { library = LIBRARY } = {}) {
      const { window } = env;
      window.fetch = vi.fn(async (url) => (String(url).includes('exercises-catalog.json')
        ? { ok: true, status: 200, json: async () => CATALOG }
        : { ok: true, status: 200, json: async () => ({}) }));
      window.apiCall = vi.fn(async () => library);
      await window.loadExerciseLibrary();
      return env.document.getElementById('exercise-library-list');
    }

    function namesIn(container) {
      return Array.from(container.querySelectorAll('.wg-workouts-exercises-row__name'))
        .map((n) => n.textContent);
    }

    it('filters the list as the user types, and says so when nothing matches', async () => {
      const { window } = env;
      const container = await loadLibrary(env);
      expect(namesIn(container)).toEqual(['Deadlift', 'Overhead press']);

      await window.WorkoutLibrary.setQuery('over');
      expect(namesIn(container)).toEqual(['Overhead press']);

      await window.WorkoutLibrary.setQuery('zzz');
      expect(namesIn(container)).toEqual([]);
      expect(container.querySelector('.wg-workouts-exercises__empty').textContent)
        .toMatch(/No exercises match/);
    });

    it('"All" appends the catalog after the user\'s rows, minus names they already have', async () => {
      const { window } = env;
      const container = await loadLibrary(env);

      await window.WorkoutLibrary.setSource('all');

      // Own rows first; the catalog's own "Deadlift" is shadowed by the
      // library row that carries the user's defaults.
      expect(namesIn(container)).toEqual([
        'Deadlift', 'Overhead press', 'Barbell bench press', 'Bench dip',
      ]);

      // Search spans both halves.
      await window.WorkoutLibrary.setQuery('bench');
      expect(namesIn(container)).toEqual(['Barbell bench press', 'Bench dip']);

      // ...and back to Mine hides the catalog again.
      await window.WorkoutLibrary.setQuery('');
      await window.WorkoutLibrary.setSource('mine');
      expect(namesIn(container)).toEqual(['Deadlift', 'Overhead press']);
    });

    it('a catalog row offers "add to my library" instead of edit/delete, and pre-fills the modal', async () => {
      const { window, document } = env;
      const container = await loadLibrary(env);
      await window.WorkoutLibrary.setSource('all');

      const catalogRow = Array.from(container.querySelectorAll('.wg-workouts-exercises-row'))
        .find((row) => row.textContent.includes('Bench dip'));
      expect(catalogRow.querySelector('.wg-workouts-exercises-row__edit')).toBeNull();
      expect(catalogRow.querySelector('.wg-workouts-exercises-row__delete')).toBeNull();
      const addBtn = catalogRow.querySelector('.wg-workouts-exercises-row__add');
      expect(addBtn.getAttribute('aria-label')).toBe('Add to my library');
      // equipment/target ride the notes meta slot.
      expect(catalogRow.querySelector('.wg-workouts-exercises-row__notes').textContent)
        .toBe('body weight · triceps');

      addBtn.click();
      expect(document.getElementById('exercise-library-modal-title').textContent).toBe('Add Exercise');
      expect(document.getElementById('exercise-library-name').value).toBe('Bench dip');
      expect(window.WorkoutEdit.editingLibraryItemId).toBeNull();
    });

    // The first "All" repaint awaits the 913 KB asset. Switching back to Mine
    // while it is in flight must win — the stale continuation cannot paint
    // catalog rows over the newer view.
    it('drops an in-flight catalog repaint once the source has switched back to Mine', async () => {
      const { window } = env;
      const container = await loadLibrary(env);

      let releaseCatalog;
      window.fetch = vi.fn(async (url) => {
        if (!String(url).includes('exercises-catalog.json')) return { ok: true, status: 200, json: async () => ({}) };
        await new Promise((resolve) => { releaseCatalog = resolve; });
        return { ok: true, status: 200, json: async () => CATALOG };
      });

      const allRepaint = window.WorkoutLibrary.setSource('all');
      await window.WorkoutLibrary.setSource('mine');
      releaseCatalog();
      await allRepaint;

      expect(namesIn(container)).toEqual(['Deadlift', 'Overhead press']);
    });

    it('toggling the source flips aria-pressed on the segmented control', async () => {
      const { window, document } = env;
      await loadLibrary(env);
      const [mine, all] = Array.from(document.querySelectorAll('#exercise-library-source [data-source]'));

      await window.WorkoutLibrary.setSource('all');
      expect(all.getAttribute('aria-pressed')).toBe('true');
      expect(mine.getAttribute('aria-pressed')).toBe('false');

      await window.WorkoutLibrary.setSource('mine');
      expect(mine.getAttribute('aria-pressed')).toBe('true');
      expect(all.getAttribute('aria-pressed')).toBe('false');
    });
  });

  // med-niix.5: optional library-level equipment binding. The editor modal
  // carries an Equipment <select> (None + inventory names) that writes
  // equipment_id in the same save payload — no second write.
  describe('equipment binding select (med-niix.5)', () => {
    const INVENTORY = [
      { id: 50, name: 'Ohio bar', kind: 'plated', min_step_kg: 2.5, max_kg: 200 },
      { id: 51, name: 'Hex DBs', kind: 'fixed', min_step_kg: 2, max_kg: 14 },
    ];

    function stubInventory(window, items = INVENTORY) {
      window.WorkoutEquipment.list = vi.fn(async () => items);
    }

    function optionsOf(select) {
      return Array.from(select.options).map((o) => [o.value, o.textContent]);
    }

    it('openAdd offers None + inventory names, defaulting to None', async () => {
      const { window, document } = env;
      stubInventory(window);

      await window.showExerciseLibraryModal();

      const select = document.getElementById('exercise-library-equipment');
      expect(select.tagName).toBe('SELECT');
      expect(optionsOf(select)).toEqual([['', 'None'], ['50', 'Ohio bar'], ['51', 'Hex DBs']]);
      expect(select.value).toBe('');
    });

    it('with gyms, options group per gym + Portable and every item stays selectable (med-8j5w.2)', async () => {
      const { window, document } = env;
      stubInventory(window, [
        { ...INVENTORY[0], location_id: 2 },
        { ...INVENTORY[1] },
        { id: 52, name: 'Home bar', kind: 'plated', location_id: 1 },
      ]);
      window.WorkoutEquipment.locations = vi.fn(async () => ({
        locations: [{ id: 1, name: 'Home' }, { id: 2, name: 'Gym A' }], activeId: 1,
      }));

      await window.showExerciseLibraryModal();

      const select = document.getElementById('exercise-library-equipment');
      const groups = Array.from(select.querySelectorAll('optgroup')).map((g) => [
        g.label, Array.from(g.querySelectorAll('option')).map((o) => o.textContent),
      ]);
      expect(groups).toEqual([
        ['Home', ['Home bar']],
        ['Gym A', ['Ohio bar']],
        ['Portable / everywhere', ['Hex DBs']],
      ]);
      expect(select.options[0].textContent).toBe('None');
      expect(select.options).toHaveLength(4);
    });

    it('openEdit selects the stored binding, and falls back to None when it dangles', async () => {
      const { window, document } = env;
      stubInventory(window);
      window.apiCall = vi.fn(async () => ([
        { id: 7, name: 'Bench Press', default_sets: 3, default_reps_min: 8, equipment_id: 50 },
      ]));

      await window.showEditExerciseLibraryModal(7);

      expect(document.getElementById('exercise-library-equipment').value).toBe('50');

      // The bound equipment was deleted (no cascade write): the editor shows
      // None rather than a phantom option.
      window.apiCall = vi.fn(async () => ([
        { id: 7, name: 'Bench Press', default_sets: 3, default_reps_min: 8, equipment_id: 999 },
      ]));
      await window.showEditExerciseLibraryModal(7);

      expect(document.getElementById('exercise-library-equipment').value).toBe('');
    });

    it('save writes equipment_id in the same payload; None unbinds to null', async () => {
      const { window, document } = env;
      stubInventory(window);
      window.loadExerciseLibrary = vi.fn();
      const calls = [];
      window.apiCall = vi.fn(async (url, method, body) => {
        // The select fill also reads the gyms (med-8j5w.2): not a write.
        if (String(url).startsWith('/api/workout/locations')) return [];
        // The create's background auto-tag pass is not the library write.
        if (String(url).endsWith('/auto-tag')) return { tagged: [] };
        calls.push([url, body]);
        return { id: 7 };
      });
      window.WorkoutEdit.editingLibraryItemId = null;

      await window.showExerciseLibraryModal();
      document.getElementById('exercise-library-name').value = 'Bench Press';
      document.getElementById('exercise-library-equipment').value = '50';
      await window.saveExerciseLibraryItem();

      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe('/api/workout/exercise-library/create');
      expect(calls[0][1]).toMatchObject({ name: 'Bench Press', equipment_id: 50 });

      // Back to None unbinds in the same single update write.
      calls.length = 0;
      window.WorkoutEdit.editingLibraryItemId = 7;
      document.getElementById('exercise-library-equipment').value = '';
      await window.saveExerciseLibraryItem();

      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe('/api/workout/exercise-library/update?id=7');
      expect(calls[0][1]).toMatchObject({ equipment_id: null });
    });

    it('an empty inventory leaves None alone and the save still works', async () => {
      const { window, document } = env;
      stubInventory(window, []);
      window.loadExerciseLibrary = vi.fn();
      window.apiCall = vi.fn(async () => ({ id: 9 }));
      window.WorkoutEdit.editingLibraryItemId = null;

      await window.showExerciseLibraryModal();

      const select = document.getElementById('exercise-library-equipment');
      expect(optionsOf(select)).toEqual([['', 'None']]);

      document.getElementById('exercise-library-name').value = 'Push-Up';
      await window.saveExerciseLibraryItem();

      expect(window.apiCall).toHaveBeenCalledWith(
        '/api/workout/exercise-library/create',
        'POST',
        expect.objectContaining({ equipment_id: null }),
        expect.anything()
      );
    });

    it('a failed inventory read leaves None alone and the save omits the key (no silent unbind)', async () => {
      const { window, document } = env;
      window.WorkoutEquipment.list = vi.fn(async () => { throw new Error('offline'); });
      window.loadExerciseLibrary = vi.fn();
      const calls = [];
      window.apiCall = vi.fn(async (url, method, body) => {
        calls.push([url, body]);
        return { id: 7 };
      });

      // Edit a bound row while the inventory fails: the select cannot offer
      // the binding, so it shows None — but the save must not clear it.
      window.apiCall = vi.fn(async (url, method, body) => {
        if (String(url) === '/api/workout/exercise-library') {
          return [{ id: 7, name: 'Bench Press', default_sets: 3, default_reps_min: 8, equipment_id: 50 }];
        }
        if (String(url) === '/api/workout/exercises/names') return [];
        calls.push([url, body]);
        return { id: 7 };
      });
      await window.showEditExerciseLibraryModal(7);

      const select = document.getElementById('exercise-library-equipment');
      expect(select.value).toBe('');
      expect(select.dataset.loaded).toBe('false');

      await window.saveExerciseLibraryItem();

      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe('/api/workout/exercise-library/update?id=7');
      expect('equipment_id' in calls[0][1]).toBe(false);
    });

    it('Add resets the select synchronously, before the inventory read lands', async () => {
      const { window, document } = env;
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      window.WorkoutEquipment.list = vi.fn(async () => {
        await gate;
        return INVENTORY;
      });
      window.apiCall = vi.fn(async () => ([
        { id: 7, name: 'Bench Press', default_sets: 3, default_reps_min: 8, equipment_id: 50 },
      ]));

      const editing = window.showEditExerciseLibraryModal(7);
      release();
      await editing;
      expect(document.getElementById('exercise-library-equipment').value).toBe('50');

      // A second open for Add: the stale '50' must be gone synchronously,
      // even though the new inventory read has not resolved.
      const pending = window.showExerciseLibraryModal();
      const select = document.getElementById('exercise-library-equipment');
      expect(select.value).toBe('');
      expect(Array.from(select.options).map((o) => o.value)).toEqual(['']);
      await pending;
      expect(select.value).toBe('');
    });

    // med-niix.8: the plan-exercise modal fills its Equipment select through
    // this same shared helper — one implementation, no duplicate fill.
    it('the shared fill also drives the plan-modal select and returns the inventory', async () => {
      const { window, document } = env;
      stubInventory(window);

      const items = await window._syncEquipmentSelect(50, 'workout-exercise-equipment');

      expect(items).toEqual(INVENTORY);
      const select = document.getElementById('workout-exercise-equipment');
      expect(Array.from(select.options).map((o) => [o.value, o.textContent]))
        .toEqual([['', 'None'], ['50', 'Ohio bar'], ['51', 'Hex DBs']]);
      expect(select.value).toBe('50');
      expect(select.dataset.loaded).toBe('true');
    });
  });

});

// Exercise identity in the library UI (med-l5yr.4, kit EI1–EI6), driven from
// the Edit sheet against the real cloud domain through the shim.
describe('features/workout/library.js — other names, rename and merge (med-l5yr.4)', () => {
  let env;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true, withWorkout: true });
    env.window.loadExerciseLibrary = vi.fn();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    env.cleanup();
    env = null;
  });

  const $ = (id) => env.document.getElementById(id);
  const lib = (name, body = {}) => env.window.apiCallDirect('/api/workout/exercise-library/create', 'POST', { ...body, name });
  const library = () => env.window.apiCallDirect('/api/workout/exercise-library');
  const names = () => env.window.apiCallDirect('/api/workout/exercises/names');
  async function logAs(name, scheduledDate) {
    const { window } = env;
    const session = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
    await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
      session_id: session.id, exercise_id: 999, exercise_name: name,
      source: 'library', status: 'completed', sets: [{ weight_kg: 16, reps: 10 }],
    });
    await window.apiCall(`/api/workout/sessions/status?id=${session.id}`, 'PUT', { status: 'completed' });
    if (scheduledDate !== undefined) {
      // Imported/synced sessions retain their original offset-carrying date.
      const record = (await env.records.list('workoutsession')).find((r) => r.id === session.id);
      await env.records.put('workoutsession', { ...record, scheduled_date: scheduledDate });
    }
  }
  const type = (value) => {
    $('exercise-library-name').value = value;
    $('exercise-library-name').dispatchEvent(new env.window.Event('input', { bubbles: true }));
  };
  const rows = (container) => [...container.querySelectorAll('.wg-row')].map((r) => [
    r.querySelector('.wg-row__title').textContent, r.querySelector('.wg-row__meta').textContent,
  ]);
  const dialog = () => env.document.querySelector('mt-modal.mt-confirm-modal');
  const pickerSections = () => [...$('exercise-library-picker-list').querySelectorAll('.wg-section')].map((s) => [
    s.querySelector('.wg-eyebrow').textContent, [...s.querySelectorAll('.wg-row__title')].map((t) => t.textContent),
  ]);

  it('Add hides the Edit-only controls for real: [hidden] wins over the kit display rules', async () => {
    // The real stylesheets: .wg-btn / .wg-section / .wg-error set display,
    // which beats the UA [hidden] rule unless the sheet guards it.
    const style = env.document.createElement('style');
    style.textContent = ['components.css', 'styles.css']
      .map((f) => fs.readFileSync(path.resolve(path.dirname(CSS_PATH), f), 'utf8')).join('\n');
    env.document.head.appendChild(style);
    const display = (id) => env.window.getComputedStyle($(id)).display;

    await env.window.showExerciseLibraryModal();
    for (const id of ['exercise-library-names', 'exercise-library-merge-btn', 'exercise-library-name-merge',
      'exercise-library-name-error', 'exercise-library-rename-hint']) {
      expect(display(id), id).toBe('none');
    }

    // Edit with a free name: the identity section and Merge show, the
    // taken-name offer does not.
    const row = await lib('Kettlebell Swings');
    await env.window.WorkoutLibrary.openEdit(row.id);
    expect(display('exercise-library-names')).not.toBe('none');
    expect(display('exercise-library-merge-btn')).not.toBe('none');
    expect(display('exercise-library-name-merge')).toBe('none');
    expect(display('exercise-library-name-error')).toBe('none');
  });

  it('picking a suggestion re-checks the name: a free pick clears the taken state', async () => {
    env.window.fetch = vi.fn(async (url) => (String(url).includes('exercises-catalog.json')
      ? { ok: true, status: 200, json: async () => ({ exercises: [{ name: 'Barbell squat' }] }) }
      : { ok: true, status: 200, json: async () => ({}) }));
    await lib('Squat');
    const dup = await lib('Goblet Squats');
    await env.window.WorkoutLibrary.openEdit(dup.id);

    type('Squat');
    expect($('exercise-library-save-btn').disabled).toBe(true);
    expect($('exercise-library-name-error').textContent).toBe('You already have Squat.');

    let pick = null;
    await vi.waitFor(() => {
      pick = [...$('exercise-library-suggest').querySelectorAll('.wg-exercise-suggest__row')]
        .find((b) => b.textContent === 'Barbell squat');
      expect(pick).toBeTruthy();
    });
    pick.click();
    expect($('exercise-library-name').value).toBe('Barbell squat');
    expect($('exercise-library-save-btn').disabled).toBe(false);
    expect($('exercise-library-name-error').hidden).toBe(true);
    expect($('exercise-library-name-merge').hidden).toBe(true);
  });

  it('resets equipment before names load and finishes opening after an alias write replaces the row', async () => {
    const { window } = env;
    const equipment = await window.apiCallDirect('/api/workout/equipment', 'POST', {
      kind: 'fixed', name: 'Hex DBs', loads_kg: [10, 12],
    });
    const bound = await lib('Dumbbell Curl', { equipment_id: equipment.id });
    const unbound = await lib('Kettlebell Swings', { aliases: ['Swings', 'KB Swings'] });
    await window.WorkoutLibrary.openEdit(bound.id);
    expect($('exercise-library-equipment').value).toBe(String(equipment.id));
    window.closeExerciseLibraryModal();

    let releaseNames;
    const namesGate = new Promise((resolve) => { releaseNames = resolve; });
    const api = window.apiCall;
    window.apiCall = vi.fn(async (url, ...args) => {
      if (url === '/api/workout/exercises/names') await namesGate;
      return api(url, ...args);
    });
    let releaseEquipment;
    const equipmentGate = new Promise((resolve) => { releaseEquipment = resolve; });
    const list = window.WorkoutEquipment.list;
    window.WorkoutEquipment.list = vi.fn(async () => {
      await equipmentGate;
      return list();
    });

    const opening = window.WorkoutLibrary.openEdit(unbound.id);
    await vi.waitFor(() => expect($('exercise-library-name').value).toBe('Kettlebell Swings'));
    // The interactive sheet must never carry the preceding row's binding,
    // even while both its names and equipment reads are outstanding.
    expect($('exercise-library-equipment').value).toBe('');
    expect($('exercise-library-equipment').dataset.loaded).toBe('false');
    const removed = window.WorkoutLibrary.removeAlias('Swings');
    await vi.waitFor(async () => expect((await library()).find((r) => r.id === unbound.id).aliases)
      .toEqual(['KB Swings']));
    releaseNames();
    await removed;
    releaseEquipment();
    await opening;

    // Alias removal replaced the in-sheet row, but this is still the same
    // sheet: its inventory must finish loading and Save must keep it unbound.
    expect($('exercise-library-equipment').dataset.loaded).toBe('true');
    expect($('exercise-library-equipment').value).toBe('');
    await window.saveExerciseLibraryItem();
    const saved = (await library()).find((r) => r.id === unbound.id);
    expect(saved.aliases).toEqual(['KB Swings']);
    expect(saved.equipment_id ?? null).toBeNull();
  });

  it('merges Swings into Kettlebell Swings from the Edit sheet; stats then show one row', async () => {
    const ks = await lib('Kettlebell Swings', { body_part: 'upper legs' });
    const swings = await lib('Swings');
    await lib('Goblet Squat');
    await logAs('Swings');
    await logAs('Swings');
    await logAs('Kettlebell Swings');

    await env.window.WorkoutLibrary.openEdit(swings.id);
    expect($('exercise-library-merge-btn').hidden).toBe(false);
    $('exercise-library-merge-btn').click();

    // EI4: the row being merged is never offered; its closest name leads.
    expect($('exercise-library-picker').classList.contains('hidden')).toBe(false);
    expect($('exercise-library-picker-eyebrow').textContent).toBe('Merge Swings into');
    expect(pickerSections()).toEqual([
      ['Closest names', ['Kettlebell Swings']],
      ['All your exercises', ['Goblet Squat', 'Kettlebell Swings']],
    ]);
    expect(rows($('exercise-library-picker-list'))[0]).toEqual(['Kettlebell Swings', 'Legs · 1 log']);

    $('exercise-library-picker-list').querySelector('button.wg-row').click();
    // EI5: names both rows and what moves; Merge is primary, not danger.
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    expect(dialog().querySelector('.wg-dialog__title').textContent).toBe('Merge Swings into Kettlebell Swings?');
    expect(dialog().textContent).toContain('Its 2 logs count as Kettlebell Swings in history, stats and records.');
    expect(dialog().textContent).toContain('Remove the name under "Also logged as" to separate its history again.');
    expect(dialog().textContent).not.toContain('To undo');
    const confirm = dialog().querySelector('.mt-confirm-modal__confirm');
    expect(confirm.textContent).toBe('Merge');
    expect(confirm.classList.contains('wg-btn--primary')).toBe(true);
    expect(confirm.classList.contains('wg-btn--danger')).toBe(false);
    expect(dialog().querySelector('.wg-dialog__icon--warn svg[data-wg-icon="link"]')).not.toBeNull();
    expect(env.document.activeElement).toBe(dialog().querySelector('.mt-confirm-modal__cancel'));
    confirm.click();

    await vi.waitFor(async () => expect((await library()).map((r) => [r.name, r.aliases])).toEqual([
      ['Goblet Squat', undefined], ['Kettlebell Swings', ['Swings']],
    ]));
    expect($('exercise-library-modal').classList.contains('hidden')).toBe(true);
    expect($('exercise-library-picker').classList.contains('hidden')).toBe(true);
    const stats = await env.window.apiCallDirect('/api/workout/stats');
    expect(stats.top_exercises.map((e) => [e.exercise_name, e.session_count])).toEqual([['Kettlebell Swings', 3]]);
    expect(ks.id).toBeGreaterThan(0);
  });

  it('Cancel on the merge confirm changes nothing', async () => {
    const swings = await lib('Swings');
    await lib('Kettlebell Swings');
    await env.window.WorkoutLibrary.openEdit(swings.id);
    $('exercise-library-merge-btn').click();
    $('exercise-library-picker-list').querySelector('button.wg-row').click();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    const merge = vi.spyOn(env.window, 'apiCall');
    expect(env.document.activeElement).toBe(dialog().querySelector('.mt-confirm-modal__cancel'));
    env.document.activeElement.click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(merge.mock.calls.some(([url]) => String(url).includes('/exercise-library/merge'))).toBe(false);
    expect((await library()).map((r) => r.name)).toEqual(['Kettlebell Swings', 'Swings']);
  });

  it('adds a history-only name with + (EI6); it shows under "Also logged as" and leaves the list', async () => {
    const ks = await lib('Kettlebell Swings');
    for (let i = 0; i < 3; i++) await logAs('Swings');
    await logAs('Lateral Raises');

    await env.window.WorkoutLibrary.openEdit(ks.id);
    expect($('exercise-library-aliases-empty').hidden).toBe(false);
    $('exercise-library-add-name-btn').click();
    expect($('exercise-library-picker-title').textContent).toBe('Add a name from history');
    expect($('exercise-library-picker-hint').textContent).toBe("Names in your logs that aren't in your library.");
    const listed = rows($('exercise-library-picker-list'));
    expect(listed.map(([t]) => t)).toEqual(['Swings', 'Lateral Raises']);
    expect(listed[0][1]).toMatch(/^3 logs · last \d{1,2} \w{3}$/);

    $('exercise-library-picker-list').querySelector('[aria-label="Add Swings"]').click();
    await vi.waitFor(() => expect(rows($('exercise-library-aliases')).map(([t]) => t)).toEqual(['Swings']));
    expect(rows($('exercise-library-aliases'))[0][1]).toMatch(/^3 logs · last /);
    expect(rows($('exercise-library-picker-list')).map(([t]) => t)).toEqual(['Lateral Raises']);
    expect((await library())[0].aliases).toEqual(['Swings']);
    expect((await names()).map((e) => [e.name, e.log_count])).toEqual([['Kettlebell Swings', 3], ['Lateral Raises', 1]]);
  });

  it.each([
    ['America/Los_Angeles', '2026-10-30T00:00:00+10:00'],
    ['Pacific/Auckland', '2026-10-30T23:30:00-10:00'],
  ])('keeps the recorded day in history-name and alias metadata viewed in %s', async (viewerZone, scheduledDate) => {
    // Model the browser's default viewing zone; explicit formatter zones still
    // take precedence. The assertions below drive the real domain + Edit UI.
    const format = env.window.Date.prototype.toLocaleDateString;
    const viewerFormat = vi.spyOn(env.window.Date.prototype, 'toLocaleDateString')
      .mockImplementation(function (locale, options) {
        return format.call(this, locale, { timeZone: viewerZone, ...options });
      });
    try {
      const ks = await lib('Kettlebell Swings', { aliases: ['Unused spelling'] });
      await logAs('Swings', scheduledDate);
      await env.window.WorkoutLibrary.openEdit(ks.id);
      expect(rows($('exercise-library-aliases'))).toEqual([['Unused spelling', 'No logs yet']]);
      $('exercise-library-add-name-btn').click();
      expect(rows($('exercise-library-picker-list'))).toEqual([['Swings', '1 log · last 30 Oct']]);

      $('exercise-library-picker-list').querySelector('[aria-label="Add Swings"]').click();
      await vi.waitFor(() => expect(rows($('exercise-library-aliases'))).toEqual([
        ['Unused spelling', 'No logs yet'], ['Swings', '1 log · last 30 Oct'],
      ]));
      expect(rows($('exercise-library-picker-list'))).toEqual([]);

      // Removing an alias exposes that same recorded date in history again.
      $('exercise-library-aliases').querySelector('[aria-label="Remove Swings"]').click();
      await vi.waitFor(() => expect(rows($('exercise-library-picker-list')))
        .toEqual([['Swings', '1 log · last 30 Oct']]));
    } finally {
      viewerFormat.mockRestore();
    }
  });

  it.each(['', 'not-a-date', '2026-10-30Tinvalid'])('omits missing or invalid last dates (%s) without losing log counts', async (scheduledDate) => {
    const ks = await lib('Kettlebell Swings');
    await logAs('Swings', scheduledDate);
    await env.window.WorkoutLibrary.openEdit(ks.id);
    $('exercise-library-add-name-btn').click();
    expect(rows($('exercise-library-picker-list'))).toEqual([['Swings', '1 log']]);
    $('exercise-library-picker-list').querySelector('[aria-label="Add Swings"]').click();
    await vi.waitFor(() => expect(rows($('exercise-library-aliases'))).toEqual([['Swings', '1 log']]));
  });

  it('two quick + taps both land: the sheet\'s identity writes run one at a time', async () => {
    const ks = await lib('Kettlebell Swings');
    await logAs('Swings');
    await logAs('KB Swings');
    await env.window.WorkoutLibrary.openEdit(ks.id);
    $('exercise-library-add-name-btn').click();

    await Promise.all([
      env.window.WorkoutLibrary.addNameFromHistory('Swings'),
      env.window.WorkoutLibrary.addNameFromHistory('KB Swings'),
      env.window.WorkoutLibrary.removeAlias('Swings'),
    ]);
    expect((await library())[0].aliases).toEqual(['KB Swings']);
    expect(rows($('exercise-library-aliases'))).toEqual([['KB Swings', expect.stringMatching(/^1 log · last /)]]);
    expect(rows($('exercise-library-picker-list')).map(([t]) => t)).toEqual(['Swings']);
  });

  it('a queued write stays with the sheet it came from when another sheet opens before its turn', async () => {
    const ks = await lib('Kettlebell Swings');
    const hc = await lib('Hammer Curls');
    await logAs('Swings');
    await env.window.WorkoutLibrary.openEdit(ks.id);

    // Save reads the form at the tap; the + after it is queued behind it.
    type('KB Hip Swings');
    const saved = env.window.saveExerciseLibraryItem();
    const added = env.window.WorkoutLibrary.addNameFromHistory('Swings');
    env.window.closeExerciseLibraryModal();
    const reopened = env.window.WorkoutLibrary.openEdit(hc.id);
    await Promise.all([saved, added, reopened]);

    // Save landed on its own row with its own values; the + was dropped with
    // its sheet; the newly opened sheet is untouched and still open.
    expect((await library()).map((r) => [r.name, r.aliases])).toEqual([
      ['Hammer Curls', undefined], ['KB Hip Swings', ['Kettlebell Swings']],
    ]);
    expect($('exercise-library-modal').classList.contains('hidden')).toBe(false);
    expect($('exercise-library-name').value).toBe('Hammer Curls');
    expect(rows($('exercise-library-aliases'))).toEqual([]);
  });

  it('a rename keeps the history and shows the old name as an alias (EI2)', async () => {
    const row = await lib('Hammer Curls');
    await logAs('Hammer Curls');
    await env.window.WorkoutLibrary.openEdit(row.id);
    expect($('exercise-library-rename-hint').textContent).toBe('Renaming keeps the history. The old name moves to "Also logged as".');
    expect($('exercise-library-aliases-empty').textContent).toBe('No other names yet.');

    type('Dumbbell Hammer Curl');
    expect($('exercise-library-rename-hint').textContent).toBe('History stays. "Hammer Curls" will be kept under "Also logged as".');
    await env.window.saveExerciseLibraryItem();

    expect((await library()).map((r) => [r.name, r.aliases])).toEqual([['Dumbbell Hammer Curl', ['Hammer Curls']]]);
    expect((await names()).map((e) => [e.name, e.log_count])).toEqual([['Dumbbell Hammer Curl', 1]]);
    await env.window.WorkoutLibrary.openEdit(row.id);
    expect(rows($('exercise-library-aliases'))).toEqual([['Hammer Curls', expect.stringMatching(/^1 log · last /)]]);
  });

  it('× removes a name at once, no confirm; its logs go back under that name', async () => {
    // Logs keep their historical spelling; aliases group those names on read.
    await logAs('Swings');
    const ks = await lib('Kettlebell Swings');
    await env.window.apiCallDirect(`/api/workout/exercise-library/update?id=${ks.id}`, 'PUT', {
      name: 'Kettlebell Swings', aliases: ['Swings', 'KB Swings'],
    });
    await env.window.WorkoutLibrary.openEdit(ks.id);
    expect(rows($('exercise-library-aliases'))[0]).toEqual(['Swings', expect.stringMatching(/^1 log · last /)]);
    expect(rows($('exercise-library-aliases')).map(([t]) => t)).toEqual(['Swings', 'KB Swings']);

    $('exercise-library-aliases').querySelector('[aria-label="Remove Swings"]').click();
    expect(dialog()).toBeNull();
    await vi.waitFor(() => expect(rows($('exercise-library-aliases')).map(([t]) => t)).toEqual(['KB Swings']));
    await vi.waitFor(async () => expect((await library())[0].aliases).toEqual(['KB Swings']));
    expect((await names()).map((e) => [e.name, e.library_id])).toEqual([['Swings', null]]);
  });

  it('× preserves a newer local rename, aliases and defaults that arrived after the sheet opened', async () => {
    installApiCache(env.window);
    const equipment = await env.window.apiCallDirect('/api/workout/equipment', 'POST', {
      kind: 'fixed', name: 'New kettlebells', loads_kg: [20, 24],
    });
    const row = await lib('Kettlebell Swings', { aliases: ['Swings'], notes: 'Before sync' });
    await env.window.WorkoutLibrary.openEdit(row.id);
    // The edit form may still contain an older snapshot when sync or an MCP
    // operation has already updated the stored row on this device.
    await env.window.apiCallDirect(`/api/workout/exercise-library/update?id=${row.id}`, 'PUT', {
      name: 'KB Hip Swings', aliases: ['Swings', 'KB Swings'], notes: 'After sync',
      default_sets: 4, default_reps_min: 12, default_reps_max: 15,
      default_weight_kg: 24, body_part: 'upper legs', equipment_id: equipment.id,
    });
    await env.window.DataStore.setCached('exercise_library', await library());
    type('My unsaved name');
    $('exercise-library-notes').value = 'My unsaved notes';
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const api = env.window.apiCall;
    env.window.apiCall = vi.fn(async (url, ...args) => {
      if (String(url).startsWith('/api/workout/exercise-library/remove-alias')) await gate;
      return api(url, ...args);
    });

    $('exercise-library-aliases').querySelector('[aria-label="Remove Swings"]').click();
    // Optimistic removal uses each current cached row too: a pending write
    // must not project the sheet's older alias list over a newly merged one.
    await vi.waitFor(async () => {
      const cached = await env.window.DataStore.getCached('exercise_library');
      expect(cached.find((r) => r.id === row.id)).toMatchObject({
        name: 'KB Hip Swings', notes: 'After sync', aliases: ['KB Swings', 'Kettlebell Swings'],
      });
    });
    release();
    await vi.waitFor(async () => {
      const saved = (await library()).find((r) => r.id === row.id);
      expect(saved).toMatchObject({
        name: 'KB Hip Swings', notes: 'After sync', aliases: ['KB Swings', 'Kettlebell Swings'],
        default_sets: 4, default_reps_min: 12, default_reps_max: 15,
        default_weight_kg: 24, body_part: 'upper legs', equipment_id: equipment.id,
      });
    });
    expect(dialog()).toBeNull();
    await vi.waitFor(() => expect(rows($('exercise-library-aliases')).map(([name]) => name))
      .toEqual(['KB Swings', 'Kettlebell Swings']));
    expect($('exercise-library-name').value).toBe('My unsaved name');
    expect($('exercise-library-notes').value).toBe('My unsaved notes');
  });

  it('a refused alias removal rolls back its cache without repainting a newly opened sheet', async () => {
    installApiCache(env.window);
    const row = await lib('Kettlebell Swings', { aliases: ['Swings'] });
    const other = await lib('Hammer Curls');
    await env.window.WorkoutLibrary.openEdit(row.id);
    const before = await library();
    await env.window.DataStore.setCached('exercise_library', before);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const api = env.window.apiCall;
    env.window.apiCall = vi.fn(async (url, ...args) => {
      if (String(url).startsWith('/api/workout/exercise-library/remove-alias')) await gate;
      return api(url, ...args);
    });
    $('exercise-library-aliases').querySelector('[aria-label="Remove Swings"]').click();
    await vi.waitFor(async () => expect((await env.window.DataStore.getCached('exercise_library'))
      .find((r) => r.id === row.id).aliases).toEqual([]));
    await env.window.apiCallDirect(`/api/workout/exercise-library/delete?id=${row.id}`, 'DELETE');
    env.window.closeExerciseLibraryModal();
    await env.window.WorkoutLibrary.openEdit(other.id);
    release();

    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Couldn't remove the name"));
    expect(await env.window.DataStore.getCached('exercise_library')).toEqual(before);
    expect($('exercise-library-name').value).toBe('Hammer Curls');
    expect(rows($('exercise-library-aliases'))).toEqual([]);
    expect((await library()).map((r) => r.name)).toEqual(['Hammer Curls']);
  });

  it('a taken name blocks Save and offers the merge into that row (EI3)', async () => {
    await lib('Goblet Squat');
    await lib('Kettlebell Swings', { aliases: ['Swings'] });
    const dup = await lib('Goblet Squats');
    await env.window.WorkoutLibrary.openEdit(dup.id);

    type('Swings');
    expect($('exercise-library-name-error').textContent).toBe('"Swings" is already an alias of Kettlebell Swings.');
    type('goblet squat');
    expect($('exercise-library-name-error').textContent).toBe('You already have Goblet Squat.');
    expect($('exercise-library-name-field').classList.contains('wg-workouts-library-modal__field--error')).toBe(true);
    expect($('exercise-library-save-btn').disabled).toBe(true);
    expect($('exercise-library-rename-hint').hidden).toBe(true);
    const offer = $('exercise-library-name-merge');
    expect(offer.hidden).toBe(false);
    expect(offer.textContent).toBe('Merge into Goblet Squat');

    offer.click();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    expect(dialog().querySelector('.wg-dialog__title').textContent).toBe('Merge Goblet Squats into Goblet Squat?');
    dialog().querySelector('.mt-confirm-modal__confirm').click();
    await vi.waitFor(async () => expect((await library()).map((r) => [r.name, r.aliases])).toEqual([
      ['Goblet Squat', ['Goblet Squats']], ['Kettlebell Swings', ['Swings']],
    ]));

    // Its own name again (any case) is free: Save comes back on.
    const ks = (await library()).find((r) => r.name === 'Kettlebell Swings');
    await env.window.WorkoutLibrary.openEdit(ks.id);
    type('kettlebell swings');
    expect($('exercise-library-name-error').hidden).toBe(true);
    expect($('exercise-library-save-btn').disabled).toBe(false);
  });

  it('a duplicate 409 on Save (a name taken since the sheet opened) shows the merge offer, not a dead end', async () => {
    const row = await lib('Lateral Raises');
    await env.window.WorkoutLibrary.openEdit(row.id);
    await lib('Dumbbell Lateral Raise'); // another device, after the sheet opened
    type('Dumbbell Lateral Raise');
    expect($('exercise-library-name-error').hidden).toBe(true);

    await env.window.saveExerciseLibraryItem();
    expect(dialog()).toBeNull();
    expect($('exercise-library-name-error').textContent).toBe('You already have Dumbbell Lateral Raise.');
    expect($('exercise-library-name-merge').textContent).toBe('Merge into Dumbbell Lateral Raise');
    expect((await library()).map((r) => r.name)).toEqual(['Dumbbell Lateral Raise', 'Lateral Raises']);
  });

  it('tells the user which names stayed with another row (skipped_aliases)', async () => {
    const squat = await lib('Squat');
    // A case twin the old case-sensitive guard let in: it answers to "Squat".
    const twin = await lib('squat (twin)');
    const rec = (await env.records.list('exerciselibrary')).find((r) => r.id === twin.id);
    await env.records.put('exerciselibrary', { ...rec, name: 'squat' });
    await lib('Back Squat');

    await env.window.WorkoutLibrary.openEdit(squat.id);
    $('exercise-library-merge-btn').click();
    const target = [...$('exercise-library-picker-list').querySelectorAll('button.wg-row')]
      .find((b) => b.querySelector('.wg-row__title').textContent === 'Back Squat');
    target.click();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    dialog().querySelector('.mt-confirm-modal__confirm').click();

    await vi.waitFor(() => expect(dialog() && dialog().querySelector('.wg-dialog__title').textContent).toBe('Some names stayed put'));
    expect(dialog().textContent).toContain('"Squat" stays with squat');
    expect((await library()).map((r) => r.name)).toEqual(['Back Squat', 'squat']);
  });
});
