// Focused integration tests for the extracted features/workout/history.js
// sub-file. Covers the WorkoutHistory public-API surface plus a smoke test
// that the loadWorkoutHistoryTab loader renders a known sessions/miband
// payload into the DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv, createMockResponse } from './helpers/frontend-harness.js';

describe('features/workout/history.js — split-file integration', () => {
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

  it('exposes the WorkoutHistory public-API namespace', () => {
    const { window } = env;
    expect(window.WorkoutHistory).toBeTypeOf('object');
    expect(window.WorkoutHistory.load).toBeTypeOf('function');
    expect(window.WorkoutHistory.deleteSession).toBeTypeOf('function');
  });

  it('renders an empty-state message when both sessions and miband return []', async () => {
    const { window, document } = env;
    // Stub apiCall to feed loadWorkoutHistoryTab two empty arrays.
    window.apiCall = vi.fn(async (url) => {
      if (url.includes('/api/workout/sessions')) return [];
      if (url.includes('/api/workout/miband')) return [];
      if (url.includes('/api/settings')) return { timezone: '' };
      return null;
    });

    await window.loadWorkoutHistoryTab();

    const container = document.getElementById('workout-history-display');
    expect(container).toBeTruthy();
    expect(container.textContent).toContain('No workout history yet');
  });

  it('renders an ad-hoc session notes label as the row name (e.g. /workout walk)', async () => {
    const { window, document } = env;
    window.apiCall = vi.fn(async (url) => {
      if (url.includes('/api/workout/sessions')) {
        return [{
          group_name: 'Ad-hoc Workout',
          variant_name: '',
          exercises_completed: 0,
          exercises_count: 0,
          session: {
            id: 501,
            group_id: -1,
            status: 'completed',
            started_at: '2026-07-20T10:00:00Z',
            scheduled_date: '2026-07-20',
            notes: 'walk',
          },
        }];
      }
      if (url.includes('/api/workout/miband')) return [];
      if (url.includes('/api/settings')) return { timezone: '' };
      return null;
    });

    await window.loadWorkoutHistoryTab();

    const nameEl = document
      .getElementById('workout-history-display')
      .querySelector('.wg-workouts-history-row__name');
    expect(nameEl).toBeTruthy();
    expect(nameEl.textContent).toBe('walk');
  });

  it('falls back to the group name for a bare ad-hoc session (no notes)', async () => {
    const { window, document } = env;
    window.apiCall = vi.fn(async (url) => {
      if (url.includes('/api/workout/sessions')) {
        return [{
          group_name: 'Ad-hoc Workout',
          variant_name: '',
          exercises_completed: 0,
          exercises_count: 0,
          session: {
            id: 502,
            group_id: -1,
            status: 'completed',
            started_at: '2026-07-20T10:00:00Z',
            scheduled_date: '2026-07-20',
          },
        }];
      }
      if (url.includes('/api/workout/miband')) return [];
      if (url.includes('/api/settings')) return { timezone: '' };
      return null;
    });

    await window.loadWorkoutHistoryTab();

    const nameEl = document
      .getElementById('workout-history-display')
      .querySelector('.wg-workouts-history-row__name');
    expect(nameEl).toBeTruthy();
    expect(nameEl.textContent).toBe('Ad-hoc Workout');
  });

  it('deleteSession short-circuits when sessionId is falsy', async () => {
    const { window } = env;
    const apiCallSpy = vi.fn();
    window.apiCall = apiCallSpy;

    await window.WorkoutHistory.deleteSession(null);
    await window.WorkoutHistory.deleteSession(undefined);
    await window.WorkoutHistory.deleteSession(0);

    expect(apiCallSpy).not.toHaveBeenCalled();
  });
});
