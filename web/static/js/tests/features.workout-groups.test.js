// Focused integration tests for the extracted features/workout/groups.js
// sub-file. Covers the open-edit / save / close flows that the orchestrator
// previously wired up via the monolithic features/workout.js. Verifies that
// the closure-private editing state is reachable via the
// window.WorkoutEdit getter/setter façade.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('exposes the WorkoutGroups public-API namespace + WorkoutEdit editingGroupId accessor', () => {
    const { window } = env;
    expect(window.WorkoutGroups).toBeTypeOf('object');
    expect(window.WorkoutGroups.load).toBeTypeOf('function');
    expect(window.WorkoutGroups.save).toBeTypeOf('function');
    expect(window.WorkoutGroups.openAdd).toBeTypeOf('function');
    expect(window.WorkoutGroups.openEdit).toBeTypeOf('function');
    expect(window.WorkoutGroups.close).toBeTypeOf('function');

    expect(window.WorkoutEdit).toBeTypeOf('object');
    expect('editingGroupId' in window.WorkoutEdit).toBe(true);
    expect(window.WorkoutEdit.editingGroupId).toBeNull();
  });

  it('showAddWorkoutGroupModal clears editingGroupId and resets the form', () => {
    const { window, document } = env;
    // Pre-seed editing state to confirm reset.
    window.WorkoutEdit.editingGroupId = 999;

    window.showAddWorkoutGroupModal();

    expect(window.WorkoutEdit.editingGroupId).toBeNull();
    expect(document.getElementById('workout-group-modal-title').textContent).toBe('Add Plan');
    expect(document.getElementById('workout-group-name').value).toBe('');
    expect(document.getElementById('workout-group-rotating').checked).toBe(false);
  });

  it('saveWorkoutGroup validates required fields without calling the API', async () => {
    const { window, document } = env;
    const apiCallSpy = vi.fn();
    window.apiCall = apiCallSpy;
    window.Telegram.WebApp.showAlert = vi.fn();

    window.showAddWorkoutGroupModal();
    document.getElementById('workout-group-name').value = '';

    await window.saveWorkoutGroup();

    expect(apiCallSpy).not.toHaveBeenCalled();
    expect(window.Telegram.WebApp.showAlert).toHaveBeenCalledTimes(1);
  });

  it('closeWorkoutGroupModal resets the cross-file editing state on WorkoutEdit', () => {
    const { window } = env;
    window.WorkoutEdit.editingGroupId = 42;
    window.WorkoutEdit.groupForVariant = 42;
    window.WorkoutEdit.variantForExercise = 7;

    window.closeWorkoutGroupModal();

    expect(window.WorkoutEdit.editingGroupId).toBeNull();
    expect(window.WorkoutEdit.groupForVariant).toBeNull();
    expect(window.WorkoutEdit.variantForExercise).toBeNull();
  });

  // med-prk.3 Task 3 — simple-default create flow. A new Plan defaults to
  // non-rotating: no Day/Variant editor is surfaced, the auto-created "Main"
  // variant stays a hidden implementation detail, and an exercise can be
  // added to the flat list without any Day/Variant/Main label appearing.
  it('simple-default plan create: no Day/Variant/Main UI, exercise adds and lists flat', async () => {
    const { window, document } = env;

    // Stateful in-memory backend so the create → edit → add-exercise journey
    // reads back its own writes.
    const groups = [];
    const variants = [];
    const exercises = [];
    let nextId = 1;

    window.apiCall = vi.fn(async (url, method = 'GET', body = null) => {
      if (url === '/api/workout/groups/create' && method === 'POST') {
        const g = { id: nextId++, active: true, exercises_count: 0, ...body };
        groups.push(g);
        return g;
      }
      if (url.startsWith('/api/workout/variants?group_id=')) {
        const gid = Number(url.split('=')[1]);
        return variants.filter((v) => v.group_id === gid);
      }
      if (url === '/api/workout/variants/create' && method === 'POST') {
        const v = { id: nextId++, ...body };
        variants.push(v);
        return v;
      }
      if (url === '/api/workout/exercise-library') return [];
      if (url.startsWith('/api/workout/exercises?variant_id=')) {
        const vid = Number(url.split('=')[1]);
        return exercises.filter((e) => e.variant_id === vid);
      }
      if (url === '/api/workout/exercises/create' && method === 'POST') {
        const e = { id: nextId++, ...body };
        exercises.push(e);
        return e;
      }
      return null;
    });
    window.apiCallDirect = vi.fn(async (url) => (url === '/api/workout/groups' ? groups : null));

    // 1) The default create modal is the simple flat flow: rotation off, the
    //    Days/variants editor hidden, the flat exercise section shown.
    window.showAddWorkoutGroupModal();
    expect(document.getElementById('workout-group-modal-title').textContent).toBe('Add Plan');
    expect(document.getElementById('workout-group-rotating').checked).toBe(false);
    expect(document.getElementById('workout-variants-section').style.display).toBe('none');
    expect(document.getElementById('workout-group-flat-exercises-section').style.display).toBe('block');

    document.getElementById('workout-group-name').value = 'Legs';
    document.getElementById('workout-group-time').value = '09:00';
    await window.saveWorkoutGroup();
    await window.loadWorkoutGroups();

    // Created non-rotating; the rendered plan row carries no Variant/Main word.
    const createCall = window.apiCall.mock.calls.find((c) => c[0] === '/api/workout/groups/create');
    expect(createCall[2].is_rotating).toBe(false);
    const rowText = document.getElementById('workout-groups-list').textContent;
    expect(rowText).toContain('Legs');
    expect(rowText).not.toMatch(/Variant|Main/);

    // 2) Opening the plan keeps the Days editor hidden and silently creates the
    //    single "Main" variant — never labeled in the flat view.
    await window.showEditWorkoutGroupModal(groups[0].id);
    expect(document.getElementById('workout-variants-section').style.display).toBe('none');
    expect(document.getElementById('workout-group-flat-exercises-section').style.display).toBe('block');
    expect(variants).toHaveLength(1);
    expect(variants[0].name).toBe('Main');

    // 3) Add an exercise through the flat picker; it lists without Day/Variant/Main.
    await window.showAddExerciseModal();
    document.getElementById('workout-exercise-name').value = 'Squat';
    document.getElementById('workout-exercise-sets').value = '3';
    document.getElementById('workout-exercise-reps-min').value = '8';
    document.getElementById('workout-exercise-order').value = '0';
    await window.saveExercise();
    // saveExercise re-renders via a fire-and-forget loadExercisesForVariant;
    // await it directly so the assertion sees the persisted row.
    await window.loadExercisesForVariant(window.WorkoutEdit.variantForExercise, 'workout-group-flat-exercises-list');

    const flatText = document.getElementById('workout-group-flat-exercises-list').textContent;
    expect(flatText).toContain('Squat');
    expect(flatText).not.toMatch(/Variant|Main|\bDay\b/);
  });

  // med-prk.3 Task 4 — rotation off-switch guard. Turning "Rotate through days"
  // off is only safe when the plan has at most one Day; with more, collapsing
  // to a flat list would strand the extra Days' exercises.
  it('rotation off-guard: >1 Day blocks the toggle, 1 Day allows collapse', async () => {
    const { window, document } = env;
    let variantList = [];
    window.apiCall = vi.fn(async (url) => {
      if (url.startsWith('/api/workout/variants?group_id=')) return variantList;
      if (url === '/api/workout/exercise-library') return [];
      if (url.startsWith('/api/workout/exercises?variant_id=')) return [];
      return null;
    });
    window.Telegram.WebApp.showAlert = vi.fn();
    window.WorkoutEdit.editingGroupId = 5;

    // Two Days: unchecking rotation must be reverted with an alert.
    variantList = [{ id: 1, group_id: 5, name: 'A' }, { id: 2, group_id: 5, name: 'B' }];
    document.getElementById('workout-group-rotating').checked = false;
    await window.toggleRotatingFields();
    expect(document.getElementById('workout-group-rotating').checked).toBe(true);
    expect(document.getElementById('workout-variants-section').style.display).toBe('block');
    expect(window.Telegram.WebApp.showAlert).toHaveBeenCalledTimes(1);

    // One Day: collapse is allowed — no alert, flat section shown.
    window.Telegram.WebApp.showAlert.mockClear();
    variantList = [{ id: 1, group_id: 5, name: 'Main' }];
    document.getElementById('workout-group-rotating').checked = false;
    await window.toggleRotatingFields();
    expect(document.getElementById('workout-group-rotating').checked).toBe(false);
    expect(document.getElementById('workout-group-flat-exercises-section').style.display).toBe('block');
    expect(window.Telegram.WebApp.showAlert).not.toHaveBeenCalled();
  });

  // A failed Day read (offline/5xx → apiCall null) must not fall open and
  // collapse a possibly-multi-Day plan.
  it('rotation off-guard: failed Day read keeps rotation on and bails', async () => {
    const { window, document } = env;
    window.apiCall = vi.fn(async () => null); // simulate offline/5xx everywhere
    window.Telegram.WebApp.showAlert = vi.fn();
    window.WorkoutEdit.editingGroupId = 7;

    document.getElementById('workout-group-rotating').checked = false;
    await window.toggleRotatingFields();

    expect(document.getElementById('workout-group-rotating').checked).toBe(true);
    expect(document.getElementById('workout-variants-section').style.display).toBe('block');
    expect(window.Telegram.WebApp.showAlert).toHaveBeenCalledTimes(1);
    // Must not have attempted to create a "Main" variant.
    expect(window.apiCall.mock.calls.some((c) => c[0] === '/api/workout/variants/create')).toBe(false);
  });

  // Race backstop for the off-guard: a Save click landing while the async Day
  // count is still in flight must not post the still-unchecked box and slip
  // is_rotating:false past the guard.
  it('rotation off-guard: Save is refused while the Day-count check is pending', async () => {
    const { window, document } = env;
    let releaseVariants;
    const variantsGate = new Promise((resolve) => { releaseVariants = resolve; });
    window.apiCall = vi.fn(async (url) => {
      if (url.startsWith('/api/workout/variants?group_id=')) return variantsGate;
      return null;
    });
    window.Telegram.WebApp.showAlert = vi.fn();
    window.WorkoutEdit.editingGroupId = 9;
    document.getElementById('workout-group-name').value = 'Legs';
    document.getElementById('workout-group-time').value = '08:00';

    // User unchecks and the guard starts fetching (do NOT await it).
    document.getElementById('workout-group-rotating').checked = false;
    const togglePromise = window.toggleRotatingFields();

    // A Save click during that window must bail without an update POST.
    await window.saveWorkoutGroup();
    expect(window.apiCall.mock.calls.some((c) => c[0].startsWith('/api/workout/groups/update'))).toBe(false);
    expect(window.Telegram.WebApp.showAlert).toHaveBeenCalledTimes(1);

    // Guard resolves to a multi-Day plan → checkbox re-checked, no longer pending.
    releaseVariants([{ id: 1 }, { id: 2 }]);
    await togglePromise;
    expect(document.getElementById('workout-group-rotating').checked).toBe(true);
    expect(window.WorkoutEdit.rotatingGuardPending).toBe(0);
  });

  // Overlapping handlers: a rapid off/on/off leaves an earlier handler finishing
  // first. A bool guard would open on that finish while the last off-check is
  // still pending; the counter keeps it closed until every handler settles.
  it('rotation off-guard: overlapping toggles keep the guard closed until all settle', async () => {
    const { window, document } = env;
    const gates = [];
    window.apiCall = vi.fn(async (url) => {
      if (url.startsWith('/api/workout/variants?group_id=')) {
        return new Promise((resolve) => { gates.push(resolve); });
      }
      return null;
    });
    window.Telegram.WebApp.showAlert = vi.fn();
    window.WorkoutEdit.editingGroupId = 9;
    document.getElementById('workout-group-name').value = 'Legs';
    document.getElementById('workout-group-time').value = '08:00';

    const cb = document.getElementById('workout-group-rotating');
    // off, on, off: three overlapping handlers, each gated on its variants fetch.
    // Gates are pushed in call order → gates[1] is the "on" handler's fetch.
    cb.checked = false;
    const p1 = window.toggleRotatingFields();
    cb.checked = true;
    const p2 = window.toggleRotatingFields();
    cb.checked = false;
    const p3 = window.toggleRotatingFields();

    // Let the middle "on" handler finish first (a bool guard would open here).
    gates[1]([{ id: 1 }, { id: 2 }]);
    await p2;

    // Save must still be refused: two off-checks remain in flight.
    await window.saveWorkoutGroup();
    expect(window.apiCall.mock.calls.some((c) => c[0].startsWith('/api/workout/groups/update'))).toBe(false);

    // Release both off-check fetches as multi-Day → box re-checked, guard clear.
    gates[0]([{ id: 1 }, { id: 2 }]);
    gates[2]([{ id: 1 }, { id: 2 }]);
    await Promise.all([p1, p3]);
    expect(window.WorkoutEdit.rotatingGuardPending).toBe(0);
  });
});
