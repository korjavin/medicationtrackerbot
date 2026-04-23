import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

function sessionDetailsFixture() {
  return {
    session: {
      id: 701,
      variant_id: 0,
      status: 'in_progress',
      scheduled_date: '2026-03-01',
      scheduled_time: '10:00',
      started_at: null
    },
    logs: []
  };
}

describe('workout.js SWR and modal edge branches', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  it('loadWorkouts delegates to history tab; next-workout loader handles error and edit-modal guard branches', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const switchSpy = vi.spyOn(window, 'switchWorkoutTab').mockImplementation(() => {});
      window.loadWorkouts();
      expect(switchSpy).toHaveBeenCalledWith('history');

      const nextCard = document.getElementById('next-workout-card');
      nextCard.innerHTML = 'stale';
      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onError(new Error('next failed'), null);
      });
      await window.loadNextWorkout();
      expect(nextCard.innerHTML).toBe('');

      const today = new Date().toISOString();
      window._renderNextWorkout(nextCard, {
        session: { id: 1, status: 'notified', is_snoozed: true, scheduled_date: today, scheduled_time: '09:00' },
        group_name: 'Push',
        variant_name: 'A',
        exercises_count: 5,
        variant_id: 11,
        group_id: 22
      });
      expect(nextCard.innerHTML).toContain('Snoozed');

      window._renderNextWorkout(nextCard, {
        session: { id: 2, status: 'scheduled', scheduled_date: today, scheduled_time: '09:30', is_today: true },
        group_name: 'Legs',
        variant_name: 'B',
        exercises_count: 6,
        variant_id: 12,
        group_id: 23
      });
      expect(nextCard.innerHTML).toContain('Today');

      window.showEditVariantModal = vi.fn().mockResolvedValue(undefined);
      await window.openNextWorkoutEditModal(0, 0);
      expect(window.showEditVariantModal).not.toHaveBeenCalled();
      await window.openNextWorkoutEditModal(33, 44);
      expect(window.showEditVariantModal).toHaveBeenCalledWith(33);
    } finally {
      cleanup();
    }
  });

  it('workout groups SWR renders fresh/empty/error states and deleteWorkoutGroup confirm branch', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const groups = [{
        id: 1,
        name: 'Strength',
        description: 'Compound day',
        is_rotating: true,
        days_of_week: JSON.stringify([1, 3]),
        scheduled_time: '07:00',
        notification_advance_minutes: 15,
        active: true
      }];

      const saveCacheSpy = vi.fn().mockResolvedValue(undefined);
      window.MedTrackerDB = { WorkoutStore: { saveCache: saveCacheSpy } };
      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh(groups);
      });
      await window.loadWorkoutGroups();
      expect(document.getElementById('workout-groups-list').innerHTML).toContain('Strength');
      expect(saveCacheSpy).toHaveBeenCalledWith('groups', groups);

      // Verify malformed days_of_week is handled gracefully (silent catch;
      // the row still renders with an empty days cluster).
      window._renderWorkoutGroups(document.getElementById('workout-groups-list'), [{
        id: 2,
        name: 'Broken Days',
        days_of_week: 'invalid-json',
      }]);
      expect(document.getElementById('workout-groups-list').innerHTML).toContain('Broken Days');

      window._renderWorkoutGroups(document.getElementById('workout-groups-list'), []);
      expect(document.getElementById('workout-groups-list').innerHTML).toContain('No workout groups yet');

      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onError(new Error('groups failed'), null);
      });
      await window.loadWorkoutGroups();
      expect(document.getElementById('workout-groups-list').innerHTML).toContain('No cached data');

      window.confirm = vi.fn().mockReturnValue(true);
      window.apiCall = vi.fn().mockResolvedValue(true);
      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh([]);
      });
      await window.deleteWorkoutGroup(1, { stopPropagation() {} });
      expect(window.apiCall).toHaveBeenCalledWith('/api/workout/groups/delete?id=1', 'DELETE');
    } finally {
      cleanup();
    }
  });

  it('variants/exercises render populated lists and update/edit branches', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      window._renderWorkoutGroups(document.getElementById('workout-groups-list'), [{
        id: 5,
        name: 'Upper',
        description: '',
        is_rotating: true,
        days_of_week: '[]',
        scheduled_time: '08:00',
        notification_advance_minutes: 10,
        active: true
      }]);

      window.apiCall = vi.fn().mockResolvedValue([
        { id: 10, name: 'Main', description: 'primary', rotation_order: 1 }
      ]);
      await window.loadVariantsForGroup(5);
      expect(document.getElementById('workout-variants-list').innerHTML).toContain('primary');

      const realLoadExercisesForVariant = window.loadExercisesForVariant;
      window.loadExercisesForVariant = vi.fn().mockResolvedValue(undefined);
      await window.showEditVariantModal(10);
      document.getElementById('workout-variant-name').value = 'Main Updated';
      window.apiCall = vi.fn().mockResolvedValue({ ok: true });
      window.closeVariantModal = vi.fn();
      window.loadVariantsForGroup = vi.fn();
      await window.saveVariant();
      expect(window.apiCall).toHaveBeenCalledWith('/api/workout/variants/update?id=10', 'PUT', expect.objectContaining({
        name: 'Main Updated'
      }));
      window.loadExercisesForVariant = realLoadExercisesForVariant;

      const exercises = [
        { id: 2, exercise_name: 'Row', target_sets: 4, target_reps_min: 8, target_reps_max: 10, target_weight_kg: 50, order_index: 1 },
        { id: 1, exercise_name: 'Bench', target_sets: 3, target_reps_min: 5, target_reps_max: null, target_weight_kg: null, order_index: 0 }
      ];
      window.apiCall = vi.fn().mockResolvedValue(exercises);
      await window.loadExercisesForVariant(55);
      expect(document.getElementById('workout-exercises-list').innerHTML).toContain('1. Bench');

      await window.showEditExerciseModal(2);
      expect(document.getElementById('workout-exercise-modal-title').textContent).toContain('Edit Exercise');
      expect(document.getElementById('workout-exercise-name').value).toBe('Row');

      window.closeExerciseModal();
      expect(document.getElementById('workout-exercise-modal').classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('exercise library renderer binds edit/delete handlers without inline onclick', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const items = [
        {
          id: 111,
          name: 'Bench <press>',
          default_sets: 4,
          default_reps_min: 8,
          default_reps_max: 10,
          default_weight_kg: 90,
          notes: 'Pause @ chest'
        }
      ];

      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh(items);
      });

      const editSpy = vi.spyOn(window, 'showEditExerciseLibraryModal').mockResolvedValue(undefined);
      const deleteSpy = vi.spyOn(window, 'deleteExerciseLibraryItem');
      window.Telegram.WebApp.showConfirm = vi.fn((_msg, cb) => cb(false));
      window.confirm = vi.fn().mockReturnValue(false);

      await window.loadExerciseLibrary();

      const container = document.getElementById('exercise-library-list');
      const card = container.querySelector('.exercise-library-item');
      const deleteButton = container.querySelector('.exercise-library-item .btn-secondary');

      expect(card).toBeTruthy();
      expect(deleteButton).toBeTruthy();
      expect(container.textContent).toContain('Bench <press>');
      expect(container.textContent).toContain('4 sets x 8-10 reps @ 90kg');

      deleteButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      expect(deleteSpy).toHaveBeenCalledWith(111, expect.any(Object));
      expect(editSpy).not.toHaveBeenCalled();

      card.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      expect(editSpy).toHaveBeenCalledWith(111);
    } finally {
      cleanup();
    }
  });

  it('history/stats SWR wrappers and session-detail error/add-exercise modal branches', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onError(new Error('history failed'), null);
      });
      await window.loadWorkoutHistoryTab();
      expect(document.getElementById('workout-history-display').innerHTML).toContain('Error loading history');

      window._renderWorkoutHistory(document.getElementById('workout-history-display'), [{
        session: { id: 9, status: 'in_progress', scheduled_date: '2026-03-01', scheduled_time: '10:00', started_at: null },
        group_name: 'Group',
        variant_name: 'A',
        total_volume: 0,
        exercises_completed: 0,
        exercises_count: 0
      }]);
      expect(document.getElementById('workout-history-display').innerHTML).toContain('No workout history yet');

      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onError(new Error('stats failed'), null);
      });
      await window.loadWorkoutStatsTab();
      expect(document.getElementById('workout-stats-display').innerHTML).toContain('No cached data');

      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh({
          active_weeks: 2,
          completion_rate: 80,
          completed_sessions: 8,
          skipped_sessions: 2,
          total_sessions: 10,
          top_exercises: [],
          weekly_activity: []
        });
      });
      await window.loadWorkoutStatsTab();
      expect(document.getElementById('workout-stats-display').innerHTML).toContain('Active Weeks');

      window.apiCall = vi.fn().mockRejectedValue(new Error('details failed'));
      window.safeAlert = vi.fn();
      await window.showWorkoutSessionModal(701);
      expect(window.safeAlert).toHaveBeenCalledWith('Error loading session details');

      window.apiCall = vi.fn(async (endpoint) => {
        if (endpoint.startsWith('/api/workout/sessions/details')) return sessionDetailsFixture();
        if (endpoint === '/api/workout/exercise-library') {
          return [
            { id: 101, name: 'Pull-up', default_sets: 3, default_reps_min: 8, default_weight_kg: 0 },
            { id: 102, name: 'Dip', default_sets: 3, default_reps_min: 10, default_weight_kg: 0 }
          ];
        }
        return [];
      });
      await window.showWorkoutSessionModal(701);
      await window.showAddExerciseToSessionModal();
      expect(document.getElementById('unique-exercises-list').querySelectorAll('option')).toHaveLength(2);

      const overlay = document.getElementById('modal-overlay');
      overlay.onclick({ target: overlay });
      expect(document.getElementById('workout-add-exercise-to-session-modal').classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });
});
