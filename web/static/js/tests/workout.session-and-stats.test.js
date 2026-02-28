import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function sessionDetailsFixture() {
  return {
    session: {
      id: 77,
      variant_id: 501,
      status: 'in_progress',
      scheduled_date: '2026-01-15',
      scheduled_time: '10:00',
      started_at: null
    },
    logs: [
      {
        id: 9001,
        exercise_id: 10,
        exercise_name: 'Squat',
        sets_completed: 3,
        reps_completed: 5,
        weight_kg: 100,
        notes: '',
        status: 'completed'
      }
    ]
  };
}

function plannedExercisesFixture() {
  return [
    { id: 10, exercise_name: 'Squat', target_sets: 3, target_reps_min: 5, target_weight_kg: 100 },
    { id: 20, exercise_name: 'Bench Press', target_sets: 4, target_reps_min: 8, target_weight_kg: 60 }
  ];
}

describe('workout.js session and stats flows', () => {
  let consoleErrorSpy;
  let consoleLogSpy;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it('showWorkoutSessionModal renders logs, pre-fills missing exercises and closes via overlay click', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      window.apiCall = vi.fn(async (endpoint) => {
        if (endpoint.startsWith('/api/workout/sessions/details')) return sessionDetailsFixture();
        if (endpoint.startsWith('/api/workout/exercises?variant_id=')) return plannedExercisesFixture();
        return null;
      });

      await window.showWorkoutSessionModal(77);

      const modal = document.getElementById('workout-session-modal');
      const overlay = document.getElementById('modal-overlay');
      const logsMarkup = document.getElementById('workout-session-logs').innerHTML;

      expect(modal.classList.contains('hidden')).toBe(false);
      expect(overlay.classList.contains('hidden')).toBe(false);
      expect(logsMarkup).toContain('Squat');
      expect(logsMarkup).toContain('Bench Press');
      expect(logsMarkup).toContain('Not yet logged');

      overlay.onclick({ target: overlay });
      expect(modal.classList.contains('hidden')).toBe(true);
      expect(overlay.classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('saveWorkoutSessionDetails updates status and persists existing and dirty new logs', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const apiCallSpy = vi.fn(async (endpoint) => {
        if (endpoint.startsWith('/api/workout/sessions/details')) return sessionDetailsFixture();
        if (endpoint.startsWith('/api/workout/exercises?variant_id=')) return plannedExercisesFixture();
        return { ok: true };
      });
      window.apiCall = apiCallSpy;
      window.loadWorkoutHistoryTab = vi.fn();

      await window.showWorkoutSessionModal(77);
      document.getElementById('session-status-select').value = 'completed';
      window.updateLocalLog(1, 'sets_completed', '6');
      window.updateLocalLog(1, 'reps_completed', '10');
      window.updateLocalLog(1, 'weight_kg', '65');

      await window.saveWorkoutSessionDetails();

      expect(apiCallSpy).toHaveBeenCalledWith('/api/workout/sessions/status?id=77', 'PUT', { status: 'completed' });
      expect(apiCallSpy).toHaveBeenCalledWith('/api/workout/sessions/logs/update', 'POST', expect.objectContaining({
        id: 9001,
        sets_completed: 3,
        reps_completed: 5
      }));
      expect(apiCallSpy).toHaveBeenCalledWith('/api/workout/sessions/logs/create', 'POST', expect.objectContaining({
        session_id: 77,
        exercise_id: 20,
        target_sets: 6,
        target_reps_min: 10
      }));
      expect(window.loadWorkoutHistoryTab).toHaveBeenCalledTimes(1);
      expect(document.getElementById('workout-session-modal').classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('saveWorkoutSessionDetails rejects invalid values and shows alert', async () => {
    const { window, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      window.apiCall = vi.fn(async (endpoint) => {
        if (endpoint.startsWith('/api/workout/sessions/details')) return sessionDetailsFixture();
        if (endpoint.startsWith('/api/workout/exercises?variant_id=')) return plannedExercisesFixture();
        return { ok: true };
      });
      const safeAlertSpy = vi.fn();
      window.safeAlert = safeAlertSpy;

      await window.showWorkoutSessionModal(77);
      window.updateLocalLog(0, 'reps_completed', '101');

      await window.saveWorkoutSessionDetails();

      expect(safeAlertSpy).toHaveBeenCalled();
      expect(safeAlertSpy.mock.calls[0][0]).toContain('Values exceed maximum allowed');
    } finally {
      cleanup();
    }
  });

  it('history and stats renderers support empty and populated states', () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const historyContainer = document.getElementById('workout-history-display');
      const statsContainer = document.getElementById('workout-stats-display');

      window._renderWorkoutHistory(historyContainer, []);
      expect(historyContainer.textContent).toContain('No workout history yet');

      window._renderWorkoutHistory(historyContainer, [
        {
          session: {
            id: 1,
            status: 'in_progress',
            scheduled_date: '2026-01-10',
            scheduled_time: '09:00',
            started_at: null
          },
          group_name: 'Push',
          variant_name: 'A',
          total_volume: 0,
          exercises_completed: 0,
          exercises_count: 0
        },
        {
          session: {
            id: 2,
            status: 'completed',
            scheduled_date: '2026-01-11',
            scheduled_time: '10:00',
            started_at: '2026-01-11T10:10:00Z'
          },
          group_name: 'Leg Day',
          variant_name: 'B',
          total_volume: 5400,
          exercises_completed: 4,
          exercises_count: 5
        }
      ]);
      expect(historyContainer.innerHTML).toContain('Leg Day');
      expect(historyContainer.innerHTML).toContain('kg total');

      window._renderWorkoutStats(statsContainer, null);
      expect(statsContainer.textContent).toContain('No statistics available yet');

      window._renderWorkoutStats(statsContainer, {
        current_streak: 5,
        longest_streak: 12,
        completion_rate: 72.4,
        completed_sessions: 30,
        skipped_sessions: 8,
        total_volume_kg: 12450,
        top_exercises: [
          { exercise_name: 'Squat', total_volume_kg: 8000, max_weight_kg: 140 },
          { exercise_name: 'Bench', total_volume_kg: 5000, max_weight_kg: 100 }
        ],
        weekly_activity: [
          { week: '2026-01-01', completed: 3, skipped: 0 },
          { week: '2026-01-08', completed: 1, skipped: 2 }
        ]
      });

      expect(statsContainer.innerHTML).toContain('Top Exercises');
      expect(statsContainer.innerHTML).toContain('12-Week Activity');
      expect(statsContainer.innerHTML).toContain('t');
    } finally {
      cleanup();
    }
  });

  it('session management actions call API endpoints and respect confirm guards', async () => {
    const { window, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const apiCallSpy = vi.fn(async (endpoint, method) => {
        if (endpoint === '/api/workout/sessions/adhoc' && method === 'POST') return { session: { id: 999 } };
        return { ok: true };
      });

      window.apiCall = apiCallSpy;
      window.showWorkoutSessionModal = vi.fn();
      window.loadNextWorkout = vi.fn();
      window.loadWorkoutHistoryTab = vi.fn();
      window.safeAlert = vi.fn();

      await window.startAdHocWorkout();
      expect(apiCallSpy).toHaveBeenCalledWith('/api/workout/sessions/adhoc', 'POST');
      expect(window.showWorkoutSessionModal).toHaveBeenCalledWith(999);
      expect(window.loadNextWorkout).toHaveBeenCalled();

      window.confirm = vi.fn().mockReturnValue(false);
      await window.startWorkoutSession(10);
      expect(apiCallSpy).not.toHaveBeenCalledWith('/api/workout/sessions/10/start', 'POST');

      window.confirm = vi.fn().mockReturnValue(true);
      await window.startWorkoutSession(10);
      expect(apiCallSpy).toHaveBeenCalledWith('/api/workout/sessions/10/start', 'POST');
      expect(window.safeAlert).toHaveBeenCalledWith('✅ Workout started! You can now log exercises.');

      window.confirm = vi.fn().mockReturnValue(true);
      await window.cancelWorkoutSession(10);
      expect(apiCallSpy).toHaveBeenCalledWith('/api/workout/sessions/status?id=10', 'PUT', { status: 'completed' });
      expect(window.loadWorkoutHistoryTab).toHaveBeenCalled();

      window.confirm = vi.fn().mockReturnValue(false);
      await window.preSkipWorkoutSession(15);
      expect(apiCallSpy).not.toHaveBeenCalledWith('/api/workout/sessions/15/preskip', 'POST');

      window.confirm = vi.fn().mockReturnValue(true);
      await window.preSkipWorkoutSession(15);
      expect(apiCallSpy).toHaveBeenCalledWith('/api/workout/sessions/15/preskip', 'POST');

      await window.cancelPreSkipWorkoutSession(15);
      expect(apiCallSpy).toHaveBeenCalledWith('/api/workout/sessions/15/cancel-preskip', 'POST');
    } finally {
      cleanup();
    }
  });

  it('add exercise to session modal fills suggestions and creates new session log', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const apiCallSpy = vi.fn(async (endpoint, method, payload) => {
        if (endpoint.startsWith('/api/workout/sessions/details')) return sessionDetailsFixture();
        if (endpoint.startsWith('/api/workout/exercises?variant_id=')) return plannedExercisesFixture();
        if (endpoint === '/api/workout/exercise-library') {
          return [
            { id: 111, name: 'Overhead Press', default_sets: 3, default_reps_min: 8, default_weight_kg: 35 }
          ];
        }
        if (endpoint === '/api/workout/sessions/logs/create' && method === 'POST') {
          return { id: 333, ...payload };
        }
        return { ok: true };
      });
      window.apiCall = apiCallSpy;
      window.safeAlert = vi.fn();

      await window.showWorkoutSessionModal(77);
      window.showWorkoutSessionModal = vi.fn();

      await window.showAddExerciseToSessionModal();
      expect(document.getElementById('workout-add-exercise-to-session-modal').classList.contains('hidden')).toBe(false);
      expect(document.getElementById('unique-exercises-list').querySelectorAll('option')).toHaveLength(1);

      document.getElementById('session-add-exercise-name').value = 'Overhead Press';
      window.onSessionExerciseSelect();
      expect(document.getElementById('session-add-exercise-id').value).toBe('111');
      expect(document.getElementById('session-add-exercise-sets').value).toBe('3');
      expect(document.getElementById('session-add-exercise-reps').value).toBe('8');

      document.getElementById('session-add-exercise-name').value = '';
      await window.saveNewSessionExercise();
      expect(window.safeAlert).toHaveBeenCalledWith('Name, sets, and reps are required');

      document.getElementById('session-add-exercise-name').value = 'Unknown Move';
      document.getElementById('session-add-exercise-id').value = '';
      document.getElementById('session-add-exercise-sets').value = '4';
      document.getElementById('session-add-exercise-reps').value = '10';
      await window.saveNewSessionExercise();
      expect(window.safeAlert).toHaveBeenCalledWith(
        'Please select an existing exercise from the list. Adding new unknown exercises to a session is not supported yet.'
      );

      document.getElementById('session-add-exercise-name').value = 'Overhead Press';
      document.getElementById('session-add-exercise-id').value = '111';
      document.getElementById('session-add-exercise-sets').value = '5';
      document.getElementById('session-add-exercise-reps').value = '6';
      document.getElementById('session-add-exercise-weight').value = '40';
      document.getElementById('session-add-exercise-notes').value = 'Felt strong';

      await window.saveNewSessionExercise();

      expect(apiCallSpy).toHaveBeenCalledWith('/api/workout/sessions/logs/create', 'POST', expect.objectContaining({
        session_id: 77,
        exercise_id: 111,
        exercise_name: 'Overhead Press',
        target_sets: 5,
        target_reps_min: 6
      }));
      expect(window.showWorkoutSessionModal).toHaveBeenCalledWith(77);
    } finally {
      cleanup();
    }
  });

  it('saveNewSessionExercise resolves id from datalist and shows error when create fails', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const apiCallSpy = vi.fn(async (endpoint) => {
        if (endpoint.startsWith('/api/workout/sessions/details')) return sessionDetailsFixture();
        if (endpoint.startsWith('/api/workout/exercises?variant_id=')) return plannedExercisesFixture();
        if (endpoint === '/api/workout/exercise-library') {
          return [{ id: 222, name: 'Lat Pulldown', default_sets: 4, default_reps_min: 10, default_weight_kg: 50 }];
        }
        if (endpoint === '/api/workout/sessions/logs/create') {
          throw new Error('create failed');
        }
        return { ok: true };
      });
      window.apiCall = apiCallSpy;
      window.safeAlert = vi.fn();

      await window.showWorkoutSessionModal(77);
      await window.showAddExerciseToSessionModal();

      document.getElementById('session-add-exercise-name').value = 'Lat Pulldown';
      document.getElementById('session-add-exercise-id').value = '';
      document.getElementById('session-add-exercise-sets').value = '4';
      document.getElementById('session-add-exercise-reps').value = '10';
      document.getElementById('session-add-exercise-weight').value = '50';

      await window.saveNewSessionExercise();

      expect(apiCallSpy).toHaveBeenCalledWith('/api/workout/sessions/logs/create', 'POST', expect.objectContaining({
        exercise_id: 222,
        exercise_name: 'Lat Pulldown'
      }));
      expect(window.safeAlert).toHaveBeenCalledWith('Failed to add exercise');
    } finally {
      cleanup();
    }
  });

  it('closeAddExerciseToSessionModal restores overlay handler and selection fallback clears hidden id', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      window.apiCall = vi.fn(async (endpoint) => {
        if (endpoint.startsWith('/api/workout/sessions/details')) return sessionDetailsFixture();
        if (endpoint.startsWith('/api/workout/exercises?variant_id=')) return plannedExercisesFixture();
        if (endpoint === '/api/workout/exercise-library') {
          return [{ id: 123, name: 'Cable Row', default_sets: 3, default_reps_min: 10, default_weight_kg: 45 }];
        }
        return { ok: true };
      });

      await window.showWorkoutSessionModal(77);
      const closeSessionSpy = vi.spyOn(window, 'closeWorkoutSessionModal');
      await window.showAddExerciseToSessionModal();

      document.getElementById('session-add-exercise-name').value = 'Nonexistent Exercise';
      document.getElementById('session-add-exercise-id').value = '999';
      window.onSessionExerciseSelect();
      expect(document.getElementById('session-add-exercise-id').value).toBe('');

      window.closeAddExerciseToSessionModal();
      const overlay = document.getElementById('modal-overlay');
      overlay.onclick({ target: overlay });
      expect(closeSessionSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
