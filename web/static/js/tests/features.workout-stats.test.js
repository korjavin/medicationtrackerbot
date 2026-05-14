// Focused integration tests for the extracted features/workout/stats.js
// sub-file. Covers the WorkoutStats public-API surface and the localStorage-
// persisted range selector.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('features/workout/stats.js — split-file integration', () => {
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

  it('exposes the WorkoutStats public-API namespace', () => {
    const { window } = env;
    expect(window.WorkoutStats).toBeTypeOf('object');
    expect(window.WorkoutStats.load).toBeTypeOf('function');
    expect(window.WorkoutStats.getRange).toBeTypeOf('function');
    expect(window.WorkoutStats.setRange).toBeTypeOf('function');
  });

  it('getRange defaults to "all" when no value is stored', () => {
    const { window } = env;
    expect(window.WorkoutStats.getRange()).toBe('all');
  });

  it('setRange persists a valid value and getRange returns it', () => {
    const { window } = env;
    window.WorkoutStats.setRange('30d');
    expect(window.WorkoutStats.getRange()).toBe('30d');
    expect(window.localStorage.getItem('mt-workouts-stats-range')).toBe('30d');
  });

  it('setRange rejects invalid range values', () => {
    const { window } = env;
    window.WorkoutStats.setRange('7d');
    expect(window.WorkoutStats.getRange()).toBe('7d');

    window.WorkoutStats.setRange('nope');
    // Unchanged
    expect(window.WorkoutStats.getRange()).toBe('7d');
  });
});
