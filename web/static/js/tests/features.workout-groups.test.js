// Focused integration tests for the extracted features/workout/groups.js
// sub-file. Covers the open-edit / save / close flows that the orchestrator
// previously wired up via the monolithic features/workout.js. Verifies that
// the closure-private editing state is reachable via the
// window.WorkoutEdit getter/setter façade.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  achievableLoads, loadingFor, nearestLoads, equipmentForExercise, pickNearestLoad,
} from '../../../../web/domain/equipment.js';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('features/workout/groups.js — split-file integration', () => {
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

  it('exposes the WorkoutGroups public-API namespace + WorkoutEdit accessors', () => {
    const { window } = env;
    expect(window.WorkoutGroups).toBeTypeOf('object');
    for (const k of ['load', 'save', 'openAdd', 'openEdit', 'close', 'addDay', 'addFlatExercise', 'share', 'printOpen', 'scanOpen', 'deleteOpen']) {
      expect(window.WorkoutGroups[k]).toBeTypeOf('function');
    }
    expect(window.WorkoutEdit).toBeTypeOf('object');
    expect(window.WorkoutEdit.editingGroupId).toBeNull();
    expect(window.WorkoutEdit.planDraft).toBeNull();
  });

  // med-xso6.22 — Plan → Day → Exercise are nested WGPages. Done on a child
  // page only stages into the plan draft; the Plan page's Save is the one
  // write, through DataStore.applyOptimistic, with the routes and payloads the
  // three old modals sent.
  describe('plan editor pages (med-xso6.22)', () => {
    const PLAN = {
      id: 5, name: 'PPL', description: '', is_rotating: true, active: true,
      training_goal: 'hypertrophy', days_of_week: '[1,3]', scheduled_time: '18:00',
      notification_advance_minutes: 15,
    };
    const VARIANTS = [
      { id: 21, group_id: 5, name: 'Push', rotation_order: 0, description: '' },
      { id: 22, group_id: 5, name: 'Pull', rotation_order: 1, description: '' },
    ];
    const EXERCISES = [
      { id: 1, variant_id: 21, exercise_name: 'Bench', order_index: 0, target_sets: 3, target_reps_min: 8, target_reps_max: 12, target_weight_kg: 60 },
      { id: 2, variant_id: 21, exercise_name: 'Dips', order_index: 1, target_sets: 3, target_reps_min: 10, target_reps_max: null, target_weight_kg: null },
      { id: 3, variant_id: 22, exercise_name: 'Row', order_index: 0, target_sets: 4, target_reps_min: 8, target_reps_max: 10, target_weight_kg: 50 },
    ];

    // Stateful in-memory backend. Every non-GET call lands in `writes`;
    // `fail(url, method)` returning true makes that write fail (apiCall null).
    function backend(window, { groups = [], variants = [], exercises = [], fail = () => false } = {}) {
      let nextId = 100;
      const writes = [];
      const db = { groups: groups.map((g) => ({ ...g })), variants: variants.map((v) => ({ ...v })), exercises: exercises.map((e) => ({ ...e })) };
      window.apiCall = vi.fn(async (url, method = 'GET', body = null) => {
        if (method !== 'GET') {
          writes.push([url, method, body]);
          if (fail(url, method)) return null;
        }
        if (url === '/api/workout/groups') return db.groups;
        if (url.startsWith('/api/workout/variants?group_id=')) {
          const gid = Number(url.split('=')[1]);
          return db.variants.filter((v) => v.group_id === gid);
        }
        if (url.startsWith('/api/workout/exercises?variant_id=')) {
          const vid = Number(url.split('=')[1]);
          return db.exercises.filter((e) => e.variant_id === vid);
        }
        if (url === '/api/workout/groups/create') { const g = { id: nextId++, active: true, ...body }; db.groups.push(g); return g; }
        if (url === '/api/workout/variants/create') { const v = { id: nextId++, ...body }; db.variants.push(v); return v; }
        if (url === '/api/workout/exercises/create') { const e = { id: nextId++, ...body }; db.exercises.push(e); return e; }
        if (/\/(update|delete)\?id=/.test(url)) return true;
        return null;
      });
      window.apiCallDirect = vi.fn(async (url) => (url === '/api/workout/groups' ? db.groups : null));
      window.WorkoutLibrary = { bindExercisePicker: vi.fn(async () => {}) };
      window.safeToast = vi.fn();
      window.safeAlert = vi.fn();
      // The post-save list reload is fire-and-forget; its render is the
      // Plans-list test's business.
      window.loadWorkoutGroups = vi.fn(async () => {});
      return writes;
    }

    // Wraps applyOptimistic so the test sees the handle's commit/rollback.
    function spyOptimistic(window) {
      const handles = [];
      const real = window.DataStore.applyOptimistic.bind(window.DataStore);
      window.DataStore.applyOptimistic = vi.fn(async (...args) => {
        const h = await real(...args);
        const rec = { commit: vi.fn((...x) => h.commit(...x)), rollback: vi.fn((...x) => h.rollback(...x)) };
        handles.push(rec);
        return rec;
      });
      return handles;
    }

    const tick = () => new Promise((r) => setTimeout(r, 0));
    const topPage = (document) => {
      const pages = document.querySelectorAll('mt-modal.wg-page[id^="wg-page-"]');
      return pages[pages.length - 1] || null;
    };
    const rowsOf = (list) => Array.from(list.querySelectorAll(':scope > .wg-row')).map((r) => r.querySelector('.wg-row__title')?.textContent);
    const menuItem = (row, label) => Array.from(row.querySelectorAll('.wg-menu__item')).find((b) => b.textContent === label);
    const swipeAct = (row, label) => Array.from(row.querySelectorAll('.wg-swipe__act')).find((b) => b.textContent === label);

    async function openSaved(window, opts = {}) {
      const writes = backend(window, { groups: [PLAN], variants: VARIANTS, exercises: EXERCISES, ...opts });
      window.WorkoutEdit.cachedGroups = [PLAN];
      await window.openWorkoutPlanPage(5);
      return writes;
    }

    function fillExercise(document, { name, sets, repsMin }) {
      document.getElementById('workout-exercise-name').value = name;
      document.getElementById('workout-exercise-sets').value = String(sets);
      document.getElementById('workout-exercise-reps-min').value = String(repsMin);
    }

    it('the Plans tab lists kit rows with no action strip; a tap opens the Plan page', async () => {
      const { window, document } = env;
      backend(window, { groups: [PLAN], variants: VARIANTS, exercises: EXERCISES });
      const container = document.getElementById('workout-groups-list');
      window._renderWorkoutGroups(container, [PLAN, { ...PLAN, id: 6, name: 'Full body', active: false, is_rotating: false }]);

      const rows = container.querySelectorAll('.wg-workout-plan-row');
      expect(rows).toHaveLength(2);
      expect(container.querySelectorAll('button[aria-label="Print plan"], button[aria-label="Scan filled sheet"]')).toHaveLength(0);
      expect(rows[0].textContent).toContain('Rotating');
      expect(rows[1].textContent).toContain('Inactive');

      window.WorkoutEdit.cachedGroups = [PLAN];
      rows[0].click();
      await vi.waitFor(() => expect(window.WorkoutEdit.planDraft).not.toBeNull());
      expect(topPage(document).querySelector('.wg-pagebar__title').textContent).toBe('PPL');
      expect(topPage(document).querySelector('.wg-pagebar__crumb').textContent).toBe('Edit plan');
    });

    it('Add plan opens a fresh Plan page: Repeats on picks, flat exercise list, no tools rows', async () => {
      const { window, document } = env;
      backend(window);
      window.WorkoutEdit.editingGroupId = 999;

      await window.openWorkoutPlanPage(null);

      const page = topPage(document);
      expect(page.querySelector('.wg-pagebar__title').textContent).toBe('New plan');
      expect(page.querySelector('.wg-pagebar__crumb').textContent).toBe('Add plan');
      expect(window.WorkoutEdit.editingGroupId).toBeNull();
      expect(document.getElementById('workout-group-name').value).toBe('');
      expect(document.getElementById('workout-group-rotating').checked).toBe(false);
      expect(page.querySelector('.days-select')).toBeNull();
      const picks = page.querySelectorAll('.wg-picks > .wg-pick');
      expect(Array.from(picks).map((p) => p.dataset.day)).toEqual(['1', '2', '3', '4', '5', '6', '0']);
      picks.forEach((p) => expect(p.getAttribute('aria-pressed')).toBe('false'));
      expect(document.getElementById('workout-variants-section').hidden).toBe(true);
      expect(document.getElementById('workout-group-flat-exercises-section').hidden).toBe(false);
      expect(document.getElementById('workout-group-tools').hidden).toBe(true);
    });

    it('Save validates the name with no write and keeps the page open', async () => {
      const { window, document } = env;
      const writes = backend(window);
      await window.openWorkoutPlanPage(null);
      document.getElementById('workout-group-name').value = '';

      await window.saveWorkoutGroup();

      expect(writes).toHaveLength(0);
      expect(window.safeAlert).toHaveBeenCalledTimes(1);
      expect(window.WorkoutEdit.planDraft).not.toBeNull();
    });

    it('flat create: exercise Done stages with no write; one Save writes group → Main → exercise', async () => {
      const { window, document } = env;
      const writes = backend(window);
      const handles = spyOptimistic(window);
      await window.openWorkoutPlanPage(null);
      document.getElementById('workout-group-name').value = 'Legs';
      document.getElementById('workout-group-time').value = '09:00';

      await window.addWorkoutFlatExercise();
      expect(topPage(document).querySelector('.wg-pagebar__title').textContent).toBe('New exercise');
      fillExercise(document, { name: 'Squat', sets: 3, repsMin: 8 });
      window.stageExercise();

      expect(writes).toHaveLength(0);
      const flatText = document.getElementById('workout-group-flat-exercises-list').textContent;
      expect(flatText).toContain('Squat');
      expect(flatText).not.toMatch(/Variant|Main|\bDay\b/);

      await window.saveWorkoutGroup();

      expect(writes.map(([u, m]) => `${m} ${u}`)).toEqual([
        'POST /api/workout/groups/create',
        'POST /api/workout/variants/create',
        'POST /api/workout/exercises/create',
      ]);
      expect(writes[0][2]).toEqual({
        name: 'Legs', description: '', is_rotating: false, days_of_week: '[]',
        scheduled_time: '09:00', notification_advance_minutes: 15, training_goal: 'hypertrophy',
      });
      expect(writes[1][2]).toEqual({ group_id: 100, name: 'Main', rotation_order: null, description: '' });
      expect(writes[2][2]).toEqual({
        variant_id: 101, exercise_name: 'Squat', target_sets: 3, target_reps_min: 8, target_reps_max: 12,
        target_weight_kg: null, order_index: 0, progression_rule: { type: 'double', increment_kg: 2.5 }, training_goal: '',
      });
      expect(window.DataStore.applyOptimistic).toHaveBeenCalledWith('workout_groups', expect.any(Function), ['workout']);
      expect(handles[0].commit).toHaveBeenCalledTimes(1);
      expect(handles[0].rollback).not.toHaveBeenCalled();
      expect(window.WorkoutEdit.planDraft).toBeNull();
      expect(document.querySelectorAll('mt-modal.wg-page[id^="wg-page-"]')).toHaveLength(0);
      // The Plans list reloads with the new plan.
      expect(window.loadWorkoutGroups).toHaveBeenCalled();
    });

    it('rotating edit: Exercise Done then Day Done stage with no write; Save writes only what changed', async () => {
      const { window, document } = env;
      const writes = await openSaved(window);
      expect(rowsOf(document.getElementById('workout-variants-list'))).toEqual(['Push', 'Pull']);

      // Tap the Push row → Day page; tap Bench → Exercise page.
      document.querySelector('#workout-variants-list .wg-workout-day-row').click();
      expect(topPage(document).querySelector('.wg-pagebar__title').textContent).toBe('Push');
      expect(rowsOf(document.getElementById('workout-exercises-list'))).toEqual(['Bench', 'Dips']);
      document.querySelector('#workout-exercises-list .wg-workout-exercise-row').click();
      await vi.waitFor(() => expect(window.WorkoutEdit.exerciseTarget?.snapshot).toBeTruthy());
      expect(document.getElementById('workout-exercise-name').value).toBe('Bench');

      document.getElementById('workout-exercise-sets').value = '5';
      window.stageExercise();
      document.getElementById('workout-variant-name').value = 'Push A';
      window.stageWorkoutDay();

      expect(writes).toHaveLength(0);
      expect(rowsOf(document.getElementById('workout-variants-list'))).toEqual(['Push A', 'Pull']);

      await window.saveWorkoutGroup();

      expect(writes.map(([u, m]) => `${m} ${u}`)).toEqual([
        'PUT /api/workout/groups/update?id=5',
        'PUT /api/workout/variants/update?id=21',
        'PUT /api/workout/exercises/update?id=1',
      ]);
      expect(writes[0][2]).toMatchObject({ name: 'PPL', is_rotating: true, days_of_week: '[1,3]', active: true });
      expect(writes[1][2]).toEqual({ group_id: 5, name: 'Push A', rotation_order: 0, description: '' });
      expect(writes[2][2]).toMatchObject({ variant_id: 21, exercise_name: 'Bench', target_sets: 5, order_index: 0 });
    });

    it('Day rows reorder by overflow Move down and by grip drag; Save renumbers rotation_order', async () => {
      const { window, document } = env;
      const writes = await openSaved(window);
      const list = document.getElementById('workout-variants-list');

      const first = list.querySelector('.wg-workout-day-row');
      expect(menuItem(first, 'Move up')).toBeUndefined();
      menuItem(first, 'Move down').click();
      expect(rowsOf(list)).toEqual(['Pull', 'Push']);

      // Drag the first row's grip past the last row (jsdom rects are all 0).
      const grip = list.querySelector('.wg-workout-day-row .wg-grip');
      grip.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientY: 0 }));
      grip.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientY: 50 }));
      expect(rowsOf(list)).toEqual(['Push', 'Pull']);
      menuItem(list.querySelector('.wg-workout-day-row'), 'Move down').click();
      expect(rowsOf(list)).toEqual(['Pull', 'Push']);
      expect(writes).toHaveLength(0);

      await window.saveWorkoutGroup();

      const dayWrites = writes.filter(([u]) => u.startsWith('/api/workout/variants/update'));
      expect(dayWrites.map(([u, , b]) => [u, b.name, b.rotation_order])).toEqual([
        ['/api/workout/variants/update?id=22', 'Pull', 0],
        ['/api/workout/variants/update?id=21', 'Push', 1],
      ]);
      expect(writes.some(([u]) => u.includes('/exercises/'))).toBe(false);
    });

    it('exercise rows swipe to Copy / Remove (staged); Save deletes, creates and renumbers', async () => {
      const { window, document } = env;
      const writes = await openSaved(window);
      document.querySelector('#workout-variants-list .wg-workout-day-row').click();
      const list = document.getElementById('workout-exercises-list');

      const bench = list.querySelector('.wg-workout-exercise-row');
      expect(Array.from(bench.querySelectorAll('.wg-swipe__act')).map((b) => b.textContent)).toEqual(['Copy', 'Remove']);
      swipeAct(bench, 'Copy').click();
      expect(rowsOf(list)).toEqual(['Bench', 'Bench', 'Dips']);
      swipeAct(list.querySelectorAll('.wg-workout-exercise-row')[2], 'Remove').click();
      expect(rowsOf(list)).toEqual(['Bench', 'Bench']);
      window.stageWorkoutDay();
      expect(writes).toHaveLength(0);

      await window.saveWorkoutGroup();

      expect(writes.map(([u, m]) => `${m} ${u}`)).toEqual([
        'PUT /api/workout/groups/update?id=5',
        'DELETE /api/workout/exercises/delete?id=2',
        'POST /api/workout/exercises/create',
      ]);
      expect(writes[2][2]).toMatchObject({ variant_id: 21, exercise_name: 'Bench', target_sets: 3, target_weight_kg: 60, order_index: 1 });
    });

    it('rotation guard: >1 Day keeps "Rotate through days" on; 1 Day collapses to the flat list', async () => {
      const { window, document } = env;
      await openSaved(window);
      const cb = document.getElementById('workout-group-rotating');

      cb.checked = false;
      window.toggleRotatingFields();
      expect(cb.checked).toBe(true);
      expect(window.safeToast).toHaveBeenCalledTimes(1);
      expect(document.getElementById('workout-variants-section').hidden).toBe(false);

      // Remove Pull (staged), then the switch-off is allowed.
      window.safeConfirm = vi.fn(async () => true);
      await window.removeWorkoutPlanDay(window.WorkoutEdit.planDraft.days[1]);
      expect(window.WorkoutEdit.planDraft.removedDays).toEqual([22]);
      window.safeToast.mockClear();
      cb.checked = false;
      window.toggleRotatingFields();
      expect(cb.checked).toBe(false);
      expect(window.safeToast).not.toHaveBeenCalled();
      expect(document.getElementById('workout-group-flat-exercises-section').hidden).toBe(false);
      expect(rowsOf(document.getElementById('workout-group-flat-exercises-list'))).toEqual(['Bench', 'Dips']);
    });

    it('a failed write rolls back, keeps the page and draft open; the retry resumes without duplicating', async () => {
      const { window, document } = env;
      let failDays = true;
      const writes = backend(window, { fail: (url) => failDays && url === '/api/workout/variants/create' });
      const handles = spyOptimistic(window);
      await window.openWorkoutPlanPage(null);
      document.getElementById('workout-group-name').value = 'Legs';
      await window.addWorkoutFlatExercise();
      fillExercise(document, { name: 'Squat', sets: 3, repsMin: 8 });
      window.stageExercise();

      await window.saveWorkoutGroup();

      expect(handles[0].rollback).toHaveBeenCalledTimes(1);
      expect(handles[0].commit).not.toHaveBeenCalled();
      expect(window.safeToast).toHaveBeenCalledWith(expect.stringContaining('Couldn\'t save the plan'), 'error');
      expect(window.WorkoutEdit.planDraft).not.toBeNull();
      expect(topPage(document)).not.toBeNull();

      failDays = false;
      writes.length = 0;
      await window.saveWorkoutGroup();

      expect(writes.map(([u, m]) => `${m} ${u}`)).toEqual([
        'PUT /api/workout/groups/update?id=100',
        'POST /api/workout/variants/create',
        'POST /api/workout/exercises/create',
      ]);
      expect(handles[1].commit).toHaveBeenCalledTimes(1);
      expect(window.WorkoutEdit.planDraft).toBeNull();
      expect(window.loadWorkoutGroups).toHaveBeenCalled();
    });

    it('Back with unsaved changes asks first; Keep editing stays on the page', async () => {
      const { window, document } = env;
      await openSaved(window);
      window.safeConfirm = vi.fn(async () => false);
      document.getElementById('workout-group-name').value = 'Renamed';

      topPage(document).querySelector('.wg-back').click();
      await tick();

      expect(window.safeConfirm).toHaveBeenCalledTimes(1);
      expect(window.WorkoutEdit.planDraft).not.toBeNull();

      // Clean form: Back leaves at once.
      document.getElementById('workout-group-name').value = 'PPL';
      window.safeConfirm.mockClear();
      topPage(document).querySelector('.wg-back').click();
      await tick();
      expect(window.safeConfirm).not.toHaveBeenCalled();
      expect(window.WorkoutEdit.planDraft).toBeNull();
    });

    it('a saved plan carries Share / Print / Scan / Delete rows on its page', async () => {
      const { window, document } = env;
      await openSaved(window);
      expect(document.getElementById('workout-group-tools').hidden).toBe(false);

      const printSpy = vi.fn();
      window.WorkoutGroups.print = printSpy;
      document.getElementById('workout-group-print-btn').click();
      expect(printSpy).toHaveBeenCalledTimes(1);
      expect(printSpy.mock.calls[0][0].id).toBe(5);

      const scanSpy = vi.fn();
      window.WorkoutScan.scan = scanSpy;
      window.renderWorkoutPlanBody();
      expect(document.getElementById('workout-group-scan-btn').hidden).toBe(false);
      document.getElementById('workout-group-scan-btn').click();
      expect(scanSpy).toHaveBeenCalledTimes(1);
      expect(scanSpy.mock.calls[0][0].id).toBe(5);

      const shareSpy = vi.fn();
      window.WorkoutShare.share = shareSpy;
      document.getElementById('workout-group-share-btn').click();
      expect(shareSpy).toHaveBeenCalledTimes(1);
      expect(shareSpy.mock.calls[0][0].id).toBe(5);

      // Without the WorkoutScan seam the Scan row is hidden.
      const kept = window.WorkoutScan;
      delete window.WorkoutScan;
      try {
        window.renderWorkoutPlanBody();
        expect(document.getElementById('workout-group-scan-btn').hidden).toBe(true);
      } finally {
        window.WorkoutScan = kept;
      }

      window.safeConfirm = vi.fn(async () => true);
      const writes = window.apiCall.mock.calls;
      document.getElementById('workout-group-delete-btn').click();
      await vi.waitFor(() => expect(writes.some(([u, m]) => m === 'DELETE' && u.startsWith('/api/workout/groups/delete'))).toBe(true));
      expect(window.WorkoutEdit.planDraft).toBeNull();
    });
  });
});

// bd med-ac5h — the printable Plan sheet. Same machinery as the doctor brief:
// a pure string builder plus a handoff to web/cloud/js/print-doc.js, so the
// assertions here are about what reaches paper, never about a print dialog.
describe('features/workout/groups.js — printable plan sheet (med-ac5h)', () => {
  let env;
  let consoleErrorSpy;

  const GROUP = {
    id: 5,
    name: 'Push / Pull / Legs',
    is_rotating: true,
    active: true,
    training_goal: 'hypertrophy',
    days_of_week: '[1,3,5]',
    scheduled_time: '18:00',
  };

  const VARIANTS = [
    { id: 22, group_id: 5, name: 'Pull day', rotation_order: 2 },
    { id: 21, group_id: 5, name: 'Push day', rotation_order: 1, description: 'Chest + shoulders' },
  ];

  const EXERCISES = {
    21: [
      { id: 2, exercise_name: 'Overhead press', order_index: 1, target_sets: 3, target_reps_min: 6 },
      { id: 1, exercise_name: 'Bench press', order_index: 0, target_sets: 4, target_reps_min: 8, target_reps_max: 12, target_weight_kg: 60 },
    ],
    22: [
      { id: 3, exercise_name: 'Barbell row', order_index: 0, target_sets: 3, target_reps_min: 10 },
    ],
  };

  function stubApi(window, { variants = VARIANTS, exercises = EXERCISES } = {}) {
    window.apiCall = vi.fn(async (url) => {
      if (url.startsWith('/api/workout/variants?group_id=')) return variants;
      const m = /\/api\/workout\/exercises\?variant_id=(\d+)/.exec(url);
      if (m) return exercises[m[1]] || [];
      return null;
    });
  }

  // Captures the printDoc(document, html, className, css) handoff.
  function stubPrintDoc(window) {
    const printed = [];
    window.WorkoutGroups.loadPrintDoc = async () => ({
      printDoc: (d, html, cls, css) => printed.push({ html, cls, css }),
    });
    return printed;
  }

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    env = loadFrontendEnv({ withWorkout: true });
    env.window.safeAlert = vi.fn();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    env.cleanup();
    env = null;
  });


  it('printing a rotating plan hands print-doc.js the whole sheet in rotation order', async () => {
    const { window } = env;
    stubApi(window);
    const printed = stubPrintDoc(window);

    await window.WorkoutGroups.print(GROUP);

    expect(printed.length).toBe(1);
    const { html, cls, css } = printed[0];
    expect(cls).toBe('wg-print-frame');

    // Header: name, goal, schedule.
    expect(html).toContain('Push / Pull / Legs');
    expect(html).toContain('Hypertrophy');
    expect(html).toContain('Repeats on Mon, Wed, Fri · 18:00');
    expect(html).toContain('Rotates through 2 days');

    // Day headings in rotation_order, not fetch order.
    expect(html.indexOf('Push day')).toBeLessThan(html.indexOf('Pull day'));
    expect(html).toContain('Chest + shoulders');

    // Exercises in order_index, with sets × reps[-range][ @ weight].
    expect(html.indexOf('Bench press')).toBeLessThan(html.indexOf('Overhead press'));
    expect(html).toContain('4 × 8–12 @ 60 kg');
    expect(html).toContain('3 × 6');

    // Hand-logging cells: one per target set, floored at 3.
    const cells = (html.match(/class="cell"/g) || []).length;
    expect(cells).toBe(4 + 3 + 3);

    // Dark theme is irrelevant by construction — the document owns its colors.
    expect(css).not.toContain('var(--wg-');
    expect(html).toContain('nothing was sent to a server');
  });

  it('a flat plan prints its exercises with no Day heading', async () => {
    const { window } = env;
    stubApi(window, {
      variants: [{ id: 30, group_id: 7, name: 'Main' }],
      exercises: { 30: [{ id: 9, exercise_name: 'Squat', order_index: 0, target_sets: 3, target_reps_min: 5 }] },
    });
    const printed = stubPrintDoc(window);

    await window.WorkoutGroups.print({
      id: 7, name: 'Full body', is_rotating: false, active: false, days_of_week: '[]',
    });

    const { html } = printed[0];
    expect(html).toContain('Squat');
    expect(html).not.toContain('Main');
    expect(html).not.toContain('<h2>');
    expect(html).not.toContain('Rotates through');
    expect(html).toContain('Inactive');
  });

  it('weights print in the user preference unit', async () => {
    const { window } = env;
    window.weightUnitPreference = 'lb';
    stubApi(window, {
      variants: [{ id: 30, name: 'Main' }],
      exercises: { 30: [{ id: 9, exercise_name: 'Bench press', order_index: 0, target_sets: 3, target_reps_min: 5, target_weight_kg: 60 }] },
    });
    const printed = stubPrintDoc(window);

    await window.WorkoutGroups.print({ id: 7, name: 'Strength', is_rotating: false, active: true, days_of_week: '[]' });

    // 60 kg → 132.3 lb (utils.js formatWeight), never a bare kg number.
    expect(printed[0].html).toContain('@ 132.3 lb');
    expect(printed[0].html).not.toContain('60 kg');
    expect(printed[0].html).toContain('lb × reps');
  });

  it('a failed read prints nothing and says so', async () => {
    const { window } = env;
    // apiCall returns null offline/5xx; a half-loaded plan must never print.
    window.apiCall = vi.fn(async (url) => (url.includes('/variants?') ? [{ id: 30, name: 'Main' }] : null));
    const printed = stubPrintDoc(window);

    await window.WorkoutGroups.print(GROUP);

    expect(printed.length).toBe(0);
    expect(window.safeAlert).toHaveBeenCalledTimes(1);
  });
});

// bd med-qj4.9 — scan-back sheet anchors: numbered set boxes, the QR figure,
// and the cloud-only Scan row button.
describe('features/workout/groups.js — scan-back anchors (med-qj4.9)', () => {
  let env;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    env = loadFrontendEnv({ withWorkout: true });
    env.window.safeAlert = vi.fn();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    env.cleanup();
    env = null;
  });

  const GROUP = {
    id: 5,
    name: 'Push / Pull',
    is_rotating: false,
    active: true,
    days_of_week: '[]',
  };

  const DAYS = [{
    variant: { id: 30, name: 'Main' },
    exercises: [{ id: 9, exercise_name: 'Squat', order_index: 0, target_sets: 2, target_reps_min: 5 }],
  }];

  it('each cell carries its 1-based set number for box→set mapping', () => {
    const { window } = env;
    const html = window.WorkoutGroups.buildDocument(GROUP, DAYS, { unit: 'kg' });
    expect(html).toContain('<span class="setno">1</span> kg × reps');
    expect(html).toContain('<span class="setno">2</span> kg × reps');
    // Floor-3 rule still holds: a 2-set entry prints 3 boxes.
    expect((html.match(/class="setno"/g) || []).length).toBe(3);
  });

  it('an injected QR svg renders as a Scan-to-log figure with the plan id', () => {
    const { window } = env;
    const withQr = window.WorkoutGroups.buildDocument(GROUP, DAYS, { unit: 'kg', qrSvg: '<svg>code</svg>' });
    expect(withQr).toContain('<figure class="qr"><svg>code</svg>');
    expect(withQr).toContain('Scan to log · Plan #5');

    const withoutQr = window.WorkoutGroups.buildDocument(GROUP, DAYS, { unit: 'kg' });
    expect(withoutQr).not.toContain('<figure class="qr">');
    expect(withoutQr).toContain('Squat');
  });

  it('print() feeds makePlanQr svg into the handed-off document', async () => {
    const { window } = env;
    window.apiCall = vi.fn(async (url) => {
      if (url.startsWith('/api/workout/variants?group_id=')) return [{ id: 30, name: 'Main' }];
      return [{ id: 9, exercise_name: 'Squat', order_index: 0, target_sets: 1, target_reps_min: 5 }];
    });
    const printed = [];
    window.WorkoutGroups.loadPrintDoc = async () => ({
      printDoc: (d, html, cls, css) => printed.push({ html, cls, css }),
    });
    window.WorkoutGroups.makePlanQr = vi.fn(async (id) => `<svg>plan-${id}</svg>`);

    await window.WorkoutGroups.print(GROUP);

    expect(window.WorkoutGroups.makePlanQr).toHaveBeenCalledWith(5);
    expect(printed).toHaveLength(1);
    expect(printed[0].html).toContain('<svg>plan-5</svg>');
  });

  it('a QR failure still prints the sheet, without the figure', async () => {
    const { window } = env;
    window.apiCall = vi.fn(async (url) => {
      if (url.startsWith('/api/workout/variants?group_id=')) return [{ id: 30, name: 'Main' }];
      return [{ id: 9, exercise_name: 'Squat', order_index: 0, target_sets: 1, target_reps_min: 5 }];
    });
    const printed = [];
    window.WorkoutGroups.loadPrintDoc = async () => ({
      printDoc: (d, html) => printed.push(html),
    });
    window.WorkoutGroups.makePlanQr = vi.fn(async () => { throw new Error('offline'); });

    await window.WorkoutGroups.print(GROUP);

    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('Squat');
    expect(printed[0]).not.toContain('<figure class="qr">');
  });

});

// bd med-niix.6 — printed sheet plate-loading diagrams: the builder only
// DRAWS the precomputed loading it is handed (domain loadingFor stays the
// single source of the plate math); the caller threads it in.
describe('features/workout/groups.js — plate loading diagrams (med-niix.6)', () => {
  let env;
  let consoleErrorSpy;

  const BAR = {
    id: 3, kind: 'plated', name: 'Ohio bar', bar_kg: 20, sides: 2, pair: false,
    plates: [{ kg: 20, count: 2 }, { kg: 1.25, count: 2 }],
  };
  const LIB = [{ id: 11, name: 'Bench press', equipment_id: 3 }];
  const GROUP = { id: 5, name: 'Push', is_rotating: false, active: true, days_of_week: '[]' };

  const ex = (over) => ({
    id: 1, exercise_name: 'Bench press', order_index: 0,
    target_sets: 3, target_reps_min: 5, exercise_library_id: 11, ...over,
  });
  const days = (exercises) => [{ variant: { id: 30, name: 'Main' }, exercises }];
  const loading62 = { 1: { bar_kg: 20, per_side: [20, 1.25], sides: 2 } };

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    env = loadFrontendEnv({ withWorkout: true });
    env.window.safeAlert = vi.fn();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    env.cleanup();
    env = null;
  });

  it('a handed 62.5 loading prints the per-side text and 2 plate rects per side', () => {
    const { window } = env;
    const html = window.WorkoutGroups.buildDocument(
      GROUP, days([ex({ target_weight_kg: 62.5 })]),
      { unit: 'kg', loadingByExerciseId: loading62 },
    );
    expect(html).toContain('20 + 20 \u00b7 1.25 / side');
    expect(html).toContain('<svg');
    // One rect per plate per side; the sleeve is a line, never a rect.
    expect((html.match(/<rect/g) || []).length).toBe(4);
    expect(html).not.toContain('--wg-');
  });

  it('a null entry prints the weight with no glyph', () => {
    const { window } = env;
    const html = window.WorkoutGroups.buildDocument(
      GROUP, days([ex({ target_weight_kg: 61 })]),
      { unit: 'kg', loadingByExerciseId: { 1: null } },
    );
    expect(html).toContain('@ 61 kg');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('/ side');
  });

  it('no loadings render byte-identical to today', () => {
    const { window } = env;
    const plain = window.WorkoutGroups.buildDocument(
      GROUP, days([ex({ target_weight_kg: 60 })]), { unit: 'kg' },
    );
    const empty = window.WorkoutGroups.buildDocument(
      GROUP, days([ex({ target_weight_kg: 60 })]),
      { unit: 'kg', loadingByExerciseId: {} },
    );
    expect(empty).toBe(plain);
    expect(plain).toContain('@ 60 kg');
    expect(plain).not.toContain('<svg');
  });

  it('a sides:1 loading draws one sleeve with no / side suffix', () => {
    const { window } = env;
    const html = window.WorkoutGroups.buildDocument(
      GROUP, days([ex({ target_weight_kg: 16 })]),
      { unit: 'kg', loadingByExerciseId: { 1: { bar_kg: 6, per_side: [10], sides: 1 } } },
    );
    expect(html).toContain('6 + 10');
    expect(html).not.toContain('/ side');
    expect((html.match(/<rect/g) || []).length).toBe(1);
  });

  it('a sheet resolved at a gym names it in the meta line; none without (med-8j5w.2)', () => {
    const { window } = env;
    const withGym = window.WorkoutGroups.buildDocument(
      GROUP, days([ex({ target_weight_kg: 62.5 })]),
      { unit: 'kg', loadingByExerciseId: loading62, locationName: 'Gym <A>' },
    );
    expect(withGym).toContain('Gym: Gym &lt;A&gt;');
    const plain = window.WorkoutGroups.buildDocument(
      GROUP, days([ex({ target_weight_kg: 62.5 })]),
      { unit: 'kg', loadingByExerciseId: loading62 },
    );
    expect(plain).not.toContain('Gym:');
  });

  it('an lb sheet labels the plate line as kg', () => {
    const { window } = env;
    const html = window.WorkoutGroups.buildDocument(
      GROUP, days([ex({ target_weight_kg: 62.5 })]),
      { unit: 'lb', loadingByExerciseId: loading62 },
    );
    expect(html).toContain('20 + 20 \u00b7 1.25 / side (kg)');
    expect(html).not.toContain('62.5 kg');
  });

  it('print() precomputes loadings with the domain module; failed reads/imports print without glyphs', async () => {
    const { window } = env;
    const stubPlan = () => {
      window.apiCall = vi.fn(async (url) => {
        if (url.startsWith('/api/workout/variants?group_id=')) return [{ id: 30, name: 'Main' }];
        if (url.includes('/api/workout/exercises?variant_id=')) return [ex({ target_weight_kg: 62.5 })];
        if (url === '/api/workout/exercise-library') return LIB;
        return null;
      });
    };
    const printed = [];
    window.WorkoutGroups.loadPrintDoc = async () => ({
      printDoc: (d, html, cls, css) => printed.push({ html, cls, css }),
    });
    window.WorkoutGroups.makePlanQr = async () => { throw new Error('no qr in test'); };
    // The domain module itself, injected through the namespace seam exactly
    // as production does — the harness never resolves the URL.
    window.WorkoutGroups.loadEquipmentDomain = async () => ({
      loadingFor, nearestLoads, equipmentForExercise, pickNearestLoad,
    });

    stubPlan();
    window.WorkoutEquipment.list = async () => [BAR];

    await window.WorkoutGroups.print(GROUP);

    expect(printed).toHaveLength(1);
    expect(printed[0].html).toContain('20 + 20 \u00b7 1.25 / side');
    expect(printed[0].html).toContain('<svg');
    // Explicit (library) binding: no auto-match label (med-x295).
    expect(printed[0].html).not.toContain('auto:');
    // The adopted print-frame stylesheet (the only CSS that lands under CSP)
    // carries the glyph rules exactly when a glyph rendered.
    expect(printed[0].css).toContain('.plates');
    expect(printed[0].css).not.toContain('var(--wg-');

    // Failed inventory read → the sheet still prints, without glyphs.
    window.WorkoutEquipment.list = async () => { throw new Error('offline'); };
    stubPlan();
    printed.length = 0;

    await window.WorkoutGroups.print(GROUP);

    expect(printed).toHaveLength(1);
    expect(printed[0].html).not.toContain('<svg');
    expect(printed[0].html).toContain('Bench press');
    expect(printed[0].css).not.toContain('.plates');

    // Failed domain import → same fallback, with a healthy inventory.
    window.WorkoutEquipment.list = async () => [BAR];
    window.WorkoutGroups.loadEquipmentDomain = async () => { throw new Error('no module in test'); };
    stubPlan();
    printed.length = 0;

    await window.WorkoutGroups.print(GROUP);

    expect(printed).toHaveLength(1);
    expect(printed[0].html).not.toContain('<svg');
    expect(printed[0].html).toContain('Bench press');
  });

  it('a note entry prints the delta line under the glyph', () => {
    const { window } = env;
    const html = window.WorkoutGroups.buildDocument(
      GROUP, days([ex({ target_weight_kg: 63 })]),
      { unit: 'kg', loadingByExerciseId: { 1: { ...loading62[1], note: '62.5 kg (-0.5 kg)' } } },
    );
    expect(html).toContain('20 + 20 \u00b7 1.25 / side');
    expect(html).toContain('62.5 kg (-0.5 kg)');
    expect((html.match(/<rect/g) || []).length).toBe(4);
    expect((html.match(/<span class="platestxt"/g) || []).length).toBe(2);
  });

  it('a note-only entry prints text with no glyph (but keeps the plate stylesheet)', () => {
    const { window } = env;
    const html = window.WorkoutGroups.buildDocument(
      GROUP, days([ex({ target_weight_kg: 15 })]),
      { unit: 'kg', loadingByExerciseId: { 1: { note: 'below bar (20 kg)' } } },
    );
    expect(html).toContain('below bar (20 kg)');
    expect(html).not.toContain('<svg');
    expect(html).toContain('.plates');
  });

  it('print() resolves the row override and falls back to nearest + delta when unreachable', async () => {
    const { window } = env;
    // The library binds the Ohio bar (id 3); the plan row overrides to the
    // short bar (id 4, 8kg + 15/10/5/2/1.25 pairs). Target 73 is unreachable
    // on the short bar: nearest below is 72 (tie-break irrelevant here —
    // 72 is strictly closer than the 74.5 above).
    const SHORT = {
      id: 4, kind: 'plated', name: 'Short bar', bar_kg: 8, sides: 2, pair: false,
      plates: [{ kg: 15, count: 2 }, { kg: 10, count: 2 }, { kg: 5, count: 2 }, { kg: 2, count: 2 }, { kg: 1.25, count: 2 }],
    };
    SHORT.loads_kg = achievableLoads(SHORT);
    window.apiCall = vi.fn(async (url) => {
      if (url.startsWith('/api/workout/variants?group_id=')) return [{ id: 30, name: 'Main' }];
      if (url.includes('/api/workout/exercises?variant_id=')) {
        return [ex({ target_weight_kg: 73, equipment_id: 4 })];
      }
      if (url === '/api/workout/exercise-library') return LIB;
      return null;
    });
    const printed = [];
    window.WorkoutGroups.loadPrintDoc = async () => ({
      printDoc: (d, html, cls, css) => printed.push({ html, css }),
    });
    window.WorkoutGroups.makePlanQr = async () => { throw new Error('no qr in test'); };
    window.WorkoutGroups.loadEquipmentDomain = async () => ({
      loadingFor, nearestLoads, equipmentForExercise, pickNearestLoad,
    });
    window.WorkoutEquipment.list = async () => [BAR, SHORT];

    await window.WorkoutGroups.print(GROUP);

    expect(printed).toHaveLength(1);
    // Glyph from the OVERRIDE gear (short bar), not the library's Ohio bar.
    expect(printed[0].html).toContain('8 + 15 \u00b7 10 \u00b7 5 \u00b7 2 / side');
    expect(printed[0].html).not.toContain('20 + 20');
    expect(printed[0].html).toContain('72 kg (-1 kg)');
    expect(printed[0].css).toContain('.plates');
  });

  it('print() resolves a row override with no library link, and prints fixed/below-bar notes', async () => {
    const { window } = env;
    const FIXED = { id: 5, kind: 'fixed', name: 'Hex DBs', loads_kg: [10, 12, 14, 16] };
    const rowNoLib = ex({ id: 2, target_weight_kg: 13, equipment_id: 5 });
    delete rowNoLib.exercise_library_id;
    window.apiCall = vi.fn(async (url) => {
      if (url.startsWith('/api/workout/variants?group_id=')) return [{ id: 30, name: 'Main' }];
      if (url.includes('/api/workout/exercises?variant_id=')) {
        return [
          rowNoLib,
          ex({ id: 3, target_weight_kg: 15 }), // below the Ohio bar → text only
        ];
      }
      if (url === '/api/workout/exercise-library') return LIB;
      return null;
    });
    const printed = [];
    window.WorkoutGroups.loadPrintDoc = async () => ({
      printDoc: (d, html, cls, css) => printed.push({ html, css }),
    });
    window.WorkoutGroups.makePlanQr = async () => { throw new Error('no qr in test'); };
    window.WorkoutGroups.loadEquipmentDomain = async () => ({
      loadingFor, nearestLoads, equipmentForExercise, pickNearestLoad,
    });
    window.WorkoutEquipment.list = async () => [BAR, FIXED];

    await window.WorkoutGroups.print(GROUP);

    expect(printed).toHaveLength(1);
    // 13 on [10,12,14,16]: tie between 12 and 14 → below.
    expect(printed[0].html).toContain('nearest: 12 kg');
    expect(printed[0].html).toContain('below bar (20 kg)');
    expect(printed[0].html).not.toContain('<svg');
    expect(printed[0].css).toContain('.plates');
  });

  it('print() auto-matches an unbound barbell-named row to the inventory barbell and labels it (med-x295)', async () => {
    const { window } = env;
    const OHIO = { ...BAR, loads_kg: achievableLoads(BAR) };
    const DBS = { id: 5, kind: 'fixed', name: 'Hex DBs', implement: 'dumbbell', loads_kg: [10, 12, 14, 16] };
    window.apiCall = vi.fn(async (url) => {
      if (url.startsWith('/api/workout/variants?group_id=')) return [{ id: 30, name: 'Main' }];
      if (url.includes('/api/workout/exercises?variant_id=')) {
        return [ex({ id: 7, exercise_name: 'Barbell squat', exercise_library_id: 12, target_weight_kg: 62.5 })];
      }
      if (url === '/api/workout/exercise-library') return [...LIB, { id: 12, name: 'Barbell squat' }];
      return null;
    });
    const printed = [];
    window.WorkoutGroups.loadPrintDoc = async () => ({
      printDoc: (d, html, cls, css) => printed.push({ html, css }),
    });
    window.WorkoutGroups.makePlanQr = async () => { throw new Error('no qr in test'); };
    window.WorkoutGroups.loadEquipmentDomain = async () => ({
      loadingFor, nearestLoads, equipmentForExercise, pickNearestLoad,
    });
    window.WorkoutEquipment.list = async () => [DBS, OHIO];

    await window.WorkoutGroups.print(GROUP);

    expect(printed).toHaveLength(1);
    expect(printed[0].html).toContain('auto: Ohio bar \u2014 20 + 20 \u00b7 1.25 / side');
    expect(printed[0].html).toContain('<svg');
    expect((printed[0].html.match(/<rect/g) || []).length).toBe(4);
  });
});
