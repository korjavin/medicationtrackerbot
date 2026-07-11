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

  // med-s5m.3 — body-part split derived from top_exercises matched against the
  // static catalog, client-side.
  describe('body-part split (med-s5m.3)', () => {
    const CATALOG = {
      exercises: [
        { name: 'Barbell Squat', body_part: 'upper legs' },
        { name: 'Bench Press', body_part: 'chest' },
      ],
    };

    function stubCatalog(window, response) {
      window.fetch = vi.fn(async (url) => {
        if (String(url).includes('/static/data/exercises-catalog.json')) return response;
        return { ok: true, status: 200, json: async () => ({}) };
      });
    }

    it('buckets logged exercises by catalog body_part, case-insensitively, with an uncategorized fallback', async () => {
      const { window, document } = env;
      stubCatalog(window, { ok: true, status: 200, json: async () => CATALOG });

      const container = document.getElementById('workout-stats-display');
      window._renderWorkoutStats(container, {
        total_sessions: 6,
        top_exercises: [
          { exercise_name: 'barbell squat', session_count: 3, total_volume_kg: 1000 }, // lower-cased -> upper legs
          { exercise_name: 'Bench Press', session_count: 2, total_volume_kg: 800 },     // chest
          { exercise_name: 'Mystery Move', session_count: 1, total_volume_kg: 50 },     // no match -> uncategorized
        ],
      });

      await vi.waitFor(() => {
        expect(container.querySelector('.wg-workouts-stats__body-split')).toBeTruthy();
      });
      const labels = Array.from(
        container.querySelectorAll('.wg-workouts-stats__body-split .wg-workouts-stats__top-row-name')
      ).map((n) => n.textContent);
      expect(labels).toEqual(['Upper legs', 'Chest', 'Uncategorized']); // sorted by session_count desc
    });

    it('renders no split section when there are no top_exercises (and does not fetch the catalog)', async () => {
      const { window, document } = env;
      stubCatalog(window, { ok: true, status: 200, json: async () => CATALOG });

      const container = document.getElementById('workout-stats-display');
      window._renderWorkoutStats(container, { total_sessions: 0, top_exercises: [] });

      await new Promise((r) => setTimeout(r, 0));
      expect(container.querySelector('.wg-workouts-stats__body-split')).toBeNull();
      const catalogFetches = window.fetch.mock.calls.filter((c) => String(c[0]).includes('exercises-catalog.json'));
      expect(catalogFetches).toHaveLength(0);
    });

    it('a failed catalog fetch is silent — stats still render, no split section', async () => {
      const { window, document } = env;
      stubCatalog(window, { ok: false, status: 500, json: async () => ({}) });

      const container = document.getElementById('workout-stats-display');
      window._renderWorkoutStats(container, {
        total_sessions: 1,
        top_exercises: [{ exercise_name: 'Bench Press', session_count: 1, total_volume_kg: 100 }],
      });

      await new Promise((r) => setTimeout(r, 0));
      expect(container.querySelector('.wg-workouts-stats')).toBeTruthy(); // base stats rendered
      expect(container.querySelector('.wg-workouts-stats__body-split')).toBeNull();
    });
  });
});
