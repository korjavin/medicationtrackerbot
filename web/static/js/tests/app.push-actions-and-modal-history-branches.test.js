import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function flushMutations() {
  return vi.advanceTimersByTimeAsync(0);
}

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
    logs: []
  };
}

describe('app.js push actions and modal history branch coverage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handlePushAction schedules medication and workout modal handlers', async () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      const medsSpy = vi.spyOn(window, 'showMedicationConfirmModal').mockImplementation(() => {});
      const workoutSpy = vi.spyOn(window, 'showWorkoutStartModal').mockImplementation(() => {});

      const medParams = new URLSearchParams({
        ids: '1,2',
        names: 'Aspirin,Magnesium',
        scheduled: '2026-02-28T10:00:00Z'
      });
      window.handlePushAction('medication_confirm', medParams);

      const workoutParams = new URLSearchParams({ session_id: '88' });
      window.handlePushAction('workout_start', workoutParams);

      await vi.advanceTimersByTimeAsync(600);

      expect(medsSpy).toHaveBeenCalledWith(['1', '2'], ['Aspirin', 'Magnesium'], '2026-02-28T10:00:00Z');
      expect(workoutSpy).toHaveBeenCalledWith('88');
    } finally {
      cleanup();
    }
  });

  it('popstate closes sub-modal first and re-pushes modal history while parent modal remains open', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      window.apiCall = vi.fn(async (endpoint) => {
        if (endpoint.startsWith('/api/workout/sessions/details')) return sessionDetailsFixture();
        if (endpoint.startsWith('/api/workout/exercises?variant_id=')) return [];
        if (endpoint === '/api/workout/exercise-library') return [];
        return [];
      });

      const pushStateSpy = vi.spyOn(window.history, 'pushState');
      await window.showWorkoutSessionModal(77);
      await window.showAddExerciseToSessionModal();
      await flushMutations();

      expect(document.getElementById('workout-session-modal').classList.contains('hidden')).toBe(false);
      expect(document.getElementById('workout-add-exercise-to-session-modal').classList.contains('hidden')).toBe(false);

      window.dispatchEvent(new window.PopStateEvent('popstate'));
      await flushMutations();

      expect(document.getElementById('workout-add-exercise-to-session-modal').classList.contains('hidden')).toBe(true);
      expect(document.getElementById('workout-session-modal').classList.contains('hidden')).toBe(false);
      expect(document.getElementById('modal-overlay').classList.contains('hidden')).toBe(false);
      expect(pushStateSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      cleanup();
    }
  });
});
