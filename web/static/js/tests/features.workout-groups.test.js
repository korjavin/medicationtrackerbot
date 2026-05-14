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
    expect(document.getElementById('workout-group-modal-title').textContent).toBe('Add Workout Group');
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
});
