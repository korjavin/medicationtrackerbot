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
