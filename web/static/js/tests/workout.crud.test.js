import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('workout.js CRUD flows', () => {
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('saveWorkoutGroup validates required fields', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const alertSpy = vi.fn();
      window.Telegram.WebApp.showAlert = alertSpy;
      window.showAddWorkoutGroupModal();

      document.getElementById('workout-group-name').value = '';
      document.getElementById('workout-group-time').value = '';

      await window.saveWorkoutGroup();

      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(alertSpy.mock.calls[0][0]).toContain('Group name is required');
    } finally {
      cleanup();
    }
  });

  it('saveWorkoutGroup creates new group and refreshes list', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const apiCallSpy = vi.fn().mockResolvedValue({ id: 10 });
      const closeSpy = vi.fn();
      const reloadSpy = vi.fn();

      window.apiCall = apiCallSpy;
      window.closeWorkoutGroupModal = closeSpy;
      window.loadWorkoutGroups = reloadSpy;

      window.showAddWorkoutGroupModal();
      document.getElementById('workout-group-name').value = 'Morning';
      document.getElementById('workout-group-description').value = 'Cardio';
      document.getElementById('workout-group-time').value = '08:30';
      document.getElementById('workout-group-notification').value = '20';
      document.querySelector('#workout-group-modal .days-select span[data-day="1"]').classList.add('selected');
      document.querySelector('#workout-group-modal .days-select span[data-day="3"]').classList.add('selected');

      await window.saveWorkoutGroup();

      expect(apiCallSpy).toHaveBeenCalledWith('/api/workout/groups/create', 'POST', {
        name: 'Morning',
        description: 'Cardio',
        is_rotating: false,
        days_of_week: JSON.stringify([1, 3]),
        scheduled_time: '08:30',
        notification_advance_minutes: 20
      });
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('saveWorkoutGroup updates existing group via PUT and includes active flag', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const apiCallSpy = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce({ ok: true });
      window.apiCall = apiCallSpy;
      window._renderWorkoutGroups(document.getElementById('workout-groups-list'), [{
        id: 5,
        name: 'Old',
        description: '',
        is_rotating: true,
        days_of_week: JSON.stringify([1]),
        scheduled_time: '09:00',
        notification_advance_minutes: 15,
        active: true
      }]);

      await window.showEditWorkoutGroupModal(5);
      document.getElementById('workout-group-name').value = 'Updated';
      document.getElementById('workout-group-time').value = '07:45';
      document.getElementById('workout-group-active').checked = false;

      await window.saveWorkoutGroup();

      expect(apiCallSpy).toHaveBeenCalledWith('/api/workout/groups/update?id=5', 'PUT', expect.objectContaining({
        name: 'Updated',
        scheduled_time: '07:45',
        active: false
      }));
    } finally {
      cleanup();
    }
  });

  it('saveVariant validates name and creates variant', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const apiCallSpy = vi.fn().mockResolvedValue([]);
      window.apiCall = apiCallSpy;

      await window.loadVariantsForGroup(11);
      window.showAddVariantModal();

      const alertSpy = vi.fn();
      window.Telegram.WebApp.showAlert = alertSpy;
      document.getElementById('workout-variant-name').value = '';
      await window.saveVariant();
      expect(alertSpy).toHaveBeenCalled();

      apiCallSpy.mockResolvedValueOnce({ id: 21 });
      const closeSpy = vi.fn();
      const reloadSpy = vi.fn();
      window.closeVariantModal = closeSpy;
      window.loadVariantsForGroup = reloadSpy;

      document.getElementById('workout-variant-name').value = 'Day A';
      document.getElementById('workout-variant-description').value = 'Push';
      document.getElementById('workout-variant-rotation').value = '1';

      await window.saveVariant();

      expect(apiCallSpy).toHaveBeenLastCalledWith('/api/workout/variants/create', 'POST', {
        group_id: 11,
        name: 'Day A',
        rotation_order: 1,
        description: 'Push'
      });
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(reloadSpy).toHaveBeenCalledWith(11);
    } finally {
      cleanup();
    }
  });

  it('saveExercise validates required fields and creates exercise', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const apiCallSpy = vi.fn().mockResolvedValue([]);
      window.apiCall = apiCallSpy;

      await window.loadExercisesForVariant(33);
      window.showAddExerciseModal();

      const alertSpy = vi.fn();
      window.Telegram.WebApp.showAlert = alertSpy;
      document.getElementById('workout-exercise-name').value = '';
      document.getElementById('workout-exercise-sets').value = '3';
      document.getElementById('workout-exercise-reps-min').value = '8';
      await window.saveExercise();
      expect(alertSpy).toHaveBeenCalled();

      const closeSpy = vi.fn();
      const reloadSpy = vi.fn();
      window.closeExerciseModal = closeSpy;
      window.loadExercisesForVariant = reloadSpy;

      apiCallSpy.mockResolvedValueOnce({ id: 100 });
      document.getElementById('workout-exercise-name').value = 'Squat';
      document.getElementById('workout-exercise-sets').value = '4';
      document.getElementById('workout-exercise-reps-min').value = '6';
      document.getElementById('workout-exercise-reps-max').value = '8';
      document.getElementById('workout-exercise-weight').value = '80';
      document.getElementById('workout-exercise-order').value = '2';

      await window.saveExercise();

      expect(apiCallSpy).toHaveBeenLastCalledWith('/api/workout/exercises/create', 'POST', {
        variant_id: 33,
        exercise_name: 'Squat',
        target_sets: 4,
        target_reps_min: 6,
        target_reps_max: 8,
        target_weight_kg: 80,
        order_index: 2
      });
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(reloadSpy).toHaveBeenCalledWith(33, 'workout-exercises-list');
    } finally {
      cleanup();
    }
  });

  it('deleteVariant/deleteExercise respect confirm guard and trigger reload on success', async () => {
    const { window, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const apiCallSpy = vi.fn().mockResolvedValue(true);
      const loadVariantsSpy = vi.fn();
      const loadExercisesSpy = vi.fn();

      window.apiCall = apiCallSpy;
      window.loadVariantsForGroup = loadVariantsSpy;
      window.loadExercisesForVariant = loadExercisesSpy;

      await window.loadVariantsForGroup(55);
      await window.loadExercisesForVariant(66);

      const confirmFalseSpy = vi.spyOn(window, 'safeConfirm').mockImplementation(async (_msg, cb) => { if (cb) await cb(false); return false; });
      await window.deleteVariant(7, { stopPropagation() {} });
      await window.deleteExercise(8, { stopPropagation() {} });
      expect(apiCallSpy).not.toHaveBeenCalled();
      confirmFalseSpy.mockRestore();

      vi.spyOn(window, 'safeConfirm').mockImplementation(async (_msg, cb) => { if (cb) await cb(true); return true; });
      await window.deleteVariant(7, { stopPropagation() {} });
      await window.deleteExercise(8, { stopPropagation() {} });

      expect(apiCallSpy).toHaveBeenCalledWith('/api/workout/variants/delete?id=7', 'DELETE');
      expect(apiCallSpy).toHaveBeenCalledWith('/api/workout/exercises/delete?id=8', 'DELETE');
      expect(loadVariantsSpy).toHaveBeenCalled();
      expect(loadExercisesSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
