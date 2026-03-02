import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

describe('workout.js loaders and next-card behavior', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  it('loadNextWorkout drives SWR callbacks and next workout card renders by status', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const nextCard = document.getElementById('next-workout-card');
      const nextData = {
        session: {
          id: 91,
          status: 'in_progress',
          scheduled_date: new Date().toISOString(),
          scheduled_time: '09:00'
        },
        group_name: 'Push',
        variant_name: 'A',
        exercises_count: 6,
        is_rotating: true,
        variant_id: 5,
        group_id: 2
      };

      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onCached(null);
        await options.onFresh(nextData);
      });

      await window.loadNextWorkout();
      expect(window.DataStore.loadSWR).toHaveBeenCalled();
      expect(nextCard.innerHTML).toContain('In Progress');
      expect(nextCard.innerHTML).toContain('Continue');

      window._renderNextWorkout(nextCard, {
        ...nextData,
        session: { ...nextData.session, status: 'pre_skipped' }
      });
      expect(nextCard.innerHTML).toContain('To Be Skipped');
      expect(nextCard.innerHTML).toContain('Cancel Skip');

      window._renderNextWorkout(nextCard, {
        ...nextData,
        session: { ...nextData.session, status: 'notified' }
      });
      expect(nextCard.innerHTML).toContain('Ready to Start');
      expect(nextCard.innerHTML).toContain('Start Workout');

      window._renderNextWorkout(nextCard, null);
      expect(nextCard.innerHTML).toBe('');
    } finally {
      cleanup();
    }
  });

  it('nextWorkoutVariant handles success and failure paths', async () => {
    const { window, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const loadNextSpy = vi.spyOn(window, 'loadNextWorkout').mockResolvedValue(undefined);
      const alertSpy = vi.fn();
      window.alert = alertSpy;

      window.apiCall = vi.fn().mockResolvedValue({ ok: true });
      await window.nextWorkoutVariant(33);
      expect(window.apiCall).toHaveBeenCalledWith('/api/workout/sessions/33/next-variant', 'POST');
      expect(loadNextSpy).toHaveBeenCalled();

      window.apiCall = vi.fn().mockRejectedValue(new Error('nope'));
      await window.nextWorkoutVariant(34);
      expect(alertSpy).toHaveBeenCalledWith('Failed to switch variant. Please try again.');
    } finally {
      cleanup();
    }
  });

  it('showEditWorkoutGroupModal non-rotating group creates default variant and loads exercises', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      window._renderWorkoutGroups(document.getElementById('workout-groups-list'), [
        {
          id: 7,
          name: 'Strength',
          description: '',
          is_rotating: false,
          days_of_week: JSON.stringify([1, 3, 5]),
          scheduled_time: '08:30',
          notification_advance_minutes: 15,
          active: true
        }
      ]);

      window.apiCall = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce({ id: 700 })
        .mockResolvedValueOnce([]);

      await window.showEditWorkoutGroupModal(7);

      expect(window.apiCall).toHaveBeenCalledWith('/api/workout/variants?group_id=7');
      expect(window.apiCall).toHaveBeenCalledWith('/api/workout/variants/create', 'POST', {
        group_id: 7,
        name: 'Main',
        rotation_order: null,
        description: ''
      });
      expect(window.apiCall).toHaveBeenCalledWith('/api/workout/exercises?variant_id=700');
      expect(document.getElementById('workout-group-flat-exercises-section').style.display).toBe('block');
    } finally {
      cleanup();
    }
  });

  it('loadVariantsForGroup and loadExercisesForVariant handle empty and error states', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      window.apiCall = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await window.loadVariantsForGroup(9);
      expect(document.getElementById('workout-variants-list').innerHTML).toContain('No variants yet');

      await window.loadExercisesForVariant(1);
      expect(document.getElementById('workout-exercises-list').innerHTML).toContain('No exercises yet');

      window.apiCall = vi.fn().mockRejectedValueOnce(new Error('variants fail')).mockRejectedValueOnce(new Error('ex fail'));
      await window.loadVariantsForGroup(10);
      expect(document.getElementById('workout-variants-list').innerHTML).toContain('Error loading variants');

      await window.loadExercisesForVariant(2);
      expect(document.getElementById('workout-exercises-list').innerHTML).toContain('Error loading exercises');
    } finally {
      cleanup();
    }
  });

  it('bindWorkoutControls wires workout buttons and day/session selectors', () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const groupModal = document.getElementById('workout-group-modal');
      expect(groupModal.classList.contains('hidden')).toBe(true);

      document.getElementById('add-workout-group-btn').click();
      expect(groupModal.classList.contains('hidden')).toBe(false);

      const monday = document.querySelector('#workout-group-modal .days-select span[data-day="1"]');
      monday.click();
      expect(monday.classList.contains('selected')).toBe(true);
      monday.click();
      expect(monday.classList.contains('selected')).toBe(false);

      document.getElementById('workout-group-cancel-btn').click();
      expect(groupModal.classList.contains('hidden')).toBe(true);

      const onSelectSpy = vi.spyOn(window, 'onSessionExerciseSelect').mockImplementation(() => {});
      const input = document.getElementById('session-add-exercise-name');
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
      expect(onSelectSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
