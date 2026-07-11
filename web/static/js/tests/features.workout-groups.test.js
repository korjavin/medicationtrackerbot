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
});
