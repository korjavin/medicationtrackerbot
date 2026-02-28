import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function sessionDetailsWithTwoLogs() {
  return {
    session: {
      id: 42,
      variant_id: 300,
      status: 'in_progress',
      scheduled_date: '2026-02-20',
      scheduled_time: '09:00',
      started_at: null
    },
    logs: [
      {
        id: 5001,
        exercise_id: 11,
        exercise_name: 'Squat',
        sets_completed: 3,
        reps_completed: 5,
        weight_kg: 100,
        notes: '',
        status: 'completed'
      },
      {
        id: 0,
        exercise_id: 12,
        exercise_name: 'Bench Press',
        sets_completed: 4,
        reps_completed: 8,
        weight_kg: 60,
        notes: '',
        status: 'completed',
        _dirty: false
      }
    ]
  };
}

describe('workout.js guard and error branches', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('toggleRotatingFields supports new-group placeholder and existing-group variant bootstrap', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      window.showAddWorkoutGroupModal();
      document.getElementById('workout-group-rotating').checked = false;
      await window.toggleRotatingFields();
      expect(document.getElementById('workout-group-flat-exercises-list').innerHTML).toContain('Save this group first');

      window._renderWorkoutGroups(document.getElementById('workout-groups-list'), [{
        id: 9,
        name: 'Mixed',
        description: '',
        is_rotating: true,
        days_of_week: JSON.stringify([1, 3]),
        scheduled_time: '08:00',
        notification_advance_minutes: 15,
        active: true
      }]);
      window.loadVariantsForGroup = vi.fn().mockResolvedValue(undefined);
      await window.showEditWorkoutGroupModal(9);

      document.getElementById('workout-group-rotating').checked = true;
      await window.toggleRotatingFields();
      expect(window.loadVariantsForGroup).toHaveBeenCalledWith(9);

      window.apiCall = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce({ id: 901 });
      window.loadExercisesForVariant = vi.fn().mockResolvedValue(undefined);
      document.getElementById('workout-group-rotating').checked = false;
      await window.toggleRotatingFields();

      expect(window.apiCall).toHaveBeenCalledWith('/api/workout/variants?group_id=9');
      expect(window.apiCall).toHaveBeenCalledWith('/api/workout/variants/create', 'POST', {
        group_id: 9,
        name: 'Main',
        rotation_order: null,
        description: ''
      });
      expect(window.loadExercisesForVariant).toHaveBeenCalledWith(901, 'workout-group-flat-exercises-list');
    } finally {
      cleanup();
    }
  });

  it('variant and exercise modals handle guard returns and edit rendering', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const variantModal = document.getElementById('workout-variant-modal');
      const exerciseModal = document.getElementById('workout-exercise-modal');
      window.safeAlert = vi.fn();

      window.showAddVariantModal();
      expect(variantModal.classList.contains('hidden')).toBe(true);
      expect(window.safeAlert).toHaveBeenCalledWith('Save this workout group first to add variants.');

      window._renderWorkoutGroups(document.getElementById('workout-groups-list'), [{
        id: 2,
        name: 'Upper',
        description: '',
        is_rotating: false,
        days_of_week: '[]',
        scheduled_time: '10:00',
        notification_advance_minutes: 10,
        active: true
      }]);
      window.apiCall = vi.fn().mockResolvedValue([]);
      await window.loadVariantsForGroup(2);
      window.showAddVariantModal();
      expect(document.getElementById('workout-variant-rotation-field').style.display).toBe('none');
      expect(document.getElementById('workout-exercises-section').style.display).toBe('none');
      window.closeVariantModal();

      window.apiCall = vi.fn().mockResolvedValue([]);
      await window.showEditVariantModal(99);
      expect(variantModal.classList.contains('hidden')).toBe(true);

      window.apiCall = vi.fn().mockResolvedValue([{ id: 4, name: 'Main', description: 'd', rotation_order: null }]);
      const realLoadExercisesForVariant = window.loadExercisesForVariant;
      const loadExercisesSpy = vi.fn().mockResolvedValue(undefined);
      window.loadExercisesForVariant = loadExercisesSpy;
      await window.showEditVariantModal(4);
      expect(variantModal.classList.contains('hidden')).toBe(false);
      expect(document.getElementById('workout-exercises-section').style.display).toBe('block');
      expect(loadExercisesSpy).toHaveBeenCalledWith(4);
      window.loadExercisesForVariant = realLoadExercisesForVariant;

      window.showAddExerciseModal();
      expect(exerciseModal.classList.contains('hidden')).toBe(true);

      window.apiCall = vi.fn().mockResolvedValue([]);
      await window.loadExercisesForVariant(77);
      window.showAddExerciseModalFromGroup();
      expect(exerciseModal.classList.contains('hidden')).toBe(false);
      expect(document.getElementById('workout-exercise-order').value).toBe('0');

      window.apiCall = vi.fn().mockResolvedValue([]);
      await window.showEditExerciseModal(12345);
      expect(document.getElementById('workout-exercise-modal-title').textContent).toContain('Add Exercise');

      window.apiCall = vi.fn().mockResolvedValue([{
        id: 88,
        exercise_name: 'Row',
        target_sets: 4,
        target_reps_min: 10,
        target_reps_max: 12,
        target_weight_kg: 45,
        order_index: 2
      }]);
      await window.showEditExerciseModal(88);
      expect(document.getElementById('workout-exercise-modal-title').textContent).toContain('Edit Exercise');
      expect(document.getElementById('workout-exercise-name').value).toBe('Row');
      expect(document.getElementById('workout-exercise-order').value).toBe('2');
    } finally {
      cleanup();
    }
  });

  it('deleteExerciseLog handles missing/guard/error/success paths and rerenders list', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      window.apiCall = vi.fn(async (endpoint) => {
        if (endpoint.startsWith('/api/workout/sessions/details')) return sessionDetailsWithTwoLogs();
        if (endpoint.startsWith('/api/workout/exercises?variant_id=')) return [];
        return { ok: true };
      });
      window.safeAlert = vi.fn();
      await window.showWorkoutSessionModal(42);

      await window.deleteExerciseLog(1000);
      expect(window.safeAlert).not.toHaveBeenCalled();

      window.confirm = vi.fn().mockReturnValue(false);
      await window.deleteExerciseLog(0);
      expect(window.apiCall).not.toHaveBeenCalledWith('/api/workout/sessions/logs/delete?id=5001', 'DELETE');

      window.confirm = vi.fn().mockReturnValue(true);
      window.apiCall = vi.fn(async (endpoint) => {
        if (endpoint.startsWith('/api/workout/sessions/details')) return sessionDetailsWithTwoLogs();
        if (endpoint.startsWith('/api/workout/exercises?variant_id=')) return [];
        if (endpoint.startsWith('/api/workout/sessions/logs/delete')) throw new Error('delete failed');
        return { ok: true };
      });
      await window.showWorkoutSessionModal(42);
      await window.deleteExerciseLog(0);
      expect(window.safeAlert).toHaveBeenCalledWith('Failed to delete exercise log');
      expect(document.getElementById('workout-session-logs').innerHTML).toContain('Squat');

      window.apiCall = vi.fn(async (endpoint, method) => {
        if (endpoint.startsWith('/api/workout/sessions/logs/delete') && method === 'DELETE') return { ok: true };
        return { ok: true };
      });
      await window.deleteExerciseLog(0);
      await window.deleteExerciseLog(0);
      expect(document.getElementById('workout-session-logs').innerHTML).toContain('No exercises logged');
    } finally {
      cleanup();
    }
  });

  it('session start/skip helpers surface API failures', async () => {
    const { window, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      window.safeAlert = vi.fn();

      window.apiCall = vi.fn().mockResolvedValue({});
      await window.startAdHocWorkout();
      expect(window.safeAlert).toHaveBeenCalledWith('Failed to start ad-hoc workout');

      window.apiCall = vi.fn().mockRejectedValue(new Error('offline'));
      await window.startAdHocWorkout();
      expect(window.safeAlert).toHaveBeenCalledWith('Error starting ad-hoc workout: offline');

      window.confirm = vi.fn().mockReturnValue(true);
      window.apiCall = vi.fn().mockRejectedValue(new Error('no start'));
      await window.startWorkoutSession(17);
      expect(window.safeAlert).toHaveBeenCalledWith('❌ Failed to start workout. Please try again.');

      window.apiCall = vi.fn().mockRejectedValue(new Error('no finish'));
      await window.cancelWorkoutSession(17);
      expect(window.safeAlert).toHaveBeenCalledWith('Failed to finish workout');

      window.apiCall = vi.fn().mockRejectedValue(new Error('preskip fail'));
      await window.preSkipWorkoutSession(17);
      expect(window.safeAlert).toHaveBeenCalledWith('❌ Failed to mark workout as skipped. Please try again.');

      window.apiCall = vi.fn().mockRejectedValue(new Error('cancel fail'));
      await window.cancelPreSkipWorkoutSession(17);
      expect(window.safeAlert).toHaveBeenCalledWith('❌ Failed to cancel skip. Please try again.');
    } finally {
      cleanup();
    }
  });
});
