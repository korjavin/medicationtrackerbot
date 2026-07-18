// Focused integration tests for the extracted features/workout/stats.js
// sub-file. Covers the WorkoutStats public-API surface and the localStorage-
// persisted range selector.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import * as WorkoutAnalysis from '../../../../web/domain/workout-analysis.js';

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

  // Phase 3 (epic med-qj4) — per-exercise detail view + PR cue.
  describe('per-exercise detail view (Phase 3)', () => {
    it('exposes the WorkoutExerciseDetail public-API surface', () => {
      const { window } = env;
      expect(window.WorkoutExerciseDetail).toBeTypeOf('object');
      expect(window.WorkoutExerciseDetail.open).toBeTypeOf('function');
      expect(window.WorkoutExerciseDetail.renderDetail).toBeTypeOf('function');
      expect(window.WorkoutExerciseDetail.isPRLog).toBeTypeOf('function');
    });

    it('renderDetail paints the records summary + est-1RM/top-weight graphs', () => {
      const { window, document } = env;
      const root = document.createElement('div');
      const prs = {
        heaviest_weight: 100,
        best_est_1rm: 116.67,
        best_set_volume: 500,
        best_session_volume: 1500,
        most_reps: 8,
        set_records: {},
      };
      const series = [
        { date: '2026-01-01', est_1rm: 100, top_weight: 90, volume: 900 },
        { date: '2026-01-08', est_1rm: 116.67, top_weight: 100, volume: 1500 },
      ];
      window.WorkoutExerciseDetail.renderDetail(root, 'Bench Press', prs, series);

      // Records summary present with the folded values.
      const recordNames = Array.from(root.querySelectorAll('.wg-workouts-exercise-detail__record .wg-workouts-stats__top-row-name'))
        .map((n) => n.textContent);
      expect(recordNames).toContain('Heaviest weight');
      expect(recordNames).toContain('Best est. 1RM');
      expect(root.textContent).toContain('116.7 kg'); // _fmtWeight renders 1dp

      // Two progress graphs rendered (est-1RM + top-weight).
      expect(root.querySelectorAll('.wg-workouts-exercise-detail__chart').length).toBe(2);
      expect(root.querySelectorAll('.wg-workout-chart').length).toBe(2);
    });

    it('open() fetches history, folds via workout-analysis, and mounts the detail view', async () => {
      const { window, document } = env;
      window.WorkoutAnalysis = WorkoutAnalysis; // inject the real pure module
      const history = [
        { date: '2026-01-01', session_id: 1, sets: [{ set_index: 0, weight_kg: 80, reps: 5, set_type: 'normal' }] },
        { date: '2026-01-08', session_id: 2, sets: [{ set_index: 0, weight_kg: 100, reps: 5, set_type: 'normal' }] },
      ];
      window.apiCall = vi.fn(async (url) => {
        if (String(url).includes('/api/workout/exercises/history')) return history;
        return null;
      });

      await window.WorkoutExerciseDetail.open('Bench Press');

      const container = document.getElementById('workout-stats-display');
      expect(container.querySelector('.wg-workouts-exercise-detail')).toBeTruthy();
      expect(container.textContent).toContain('Bench Press');
      // Heaviest weight across history is 100 kg.
      expect(container.textContent).toContain('100 kg');
      expect(container.querySelectorAll('.wg-workout-chart').length).toBe(2);
    });

    it('isPRLog reports a record only when a set beats the prior baseline', () => {
      const { window } = env;
      const priorPRs = WorkoutAnalysis.exercisePRs([
        { sets: [{ weight_kg: 90, reps: 5, set_type: 'normal' }] },
      ]);
      const beats = { sets: [{ weight_kg: 100, reps: 5, set_type: 'normal' }] };
      const ties = { sets: [{ weight_kg: 90, reps: 5, set_type: 'normal' }] };
      expect(window.WorkoutExerciseDetail.isPRLog(beats, priorPRs, WorkoutAnalysis)).toBe(true);
      expect(window.WorkoutExerciseDetail.isPRLog(ties, priorPRs, WorkoutAnalysis)).toBe(false);
    });

    it('isPRLog fires on set-volume / most-reps / rep-max records, not just heaviest+1RM', () => {
      const { window } = env;
      // Prior best: a heavy low-rep set (100 kg × 5). New: lighter but higher-rep
      // (80 kg × 12) — not heavier and lower est-1RM (112 < 116.67), but a new best
      // set volume (960 > 500), most reps (12 > 5), and a fresh 12-rep record.
      const priorPRs = WorkoutAnalysis.exercisePRs([
        { sets: [{ weight_kg: 100, reps: 5, set_type: 'normal' }] },
      ]);
      const volumePR = { sets: [{ weight_kg: 80, reps: 12, set_type: 'normal' }] };
      expect(window.WorkoutExerciseDetail.isPRLog(volumePR, priorPRs, WorkoutAnalysis)).toBe(true);
    });

    it('renderDetail surfaces per-rep-count set-records', () => {
      const { window, document } = env;
      const root = document.createElement('div');
      const prs = {
        heaviest_weight: 100,
        best_est_1rm: 116.67,
        best_set_volume: 960,
        best_session_volume: 1500,
        most_reps: 12,
        set_records: { 5: 100, 12: 80 },
      };
      window.WorkoutExerciseDetail.renderDetail(root, 'Bench Press', prs, []);
      expect(root.textContent).toContain('Rep-max records');
      const repNames = Array.from(root.querySelectorAll('.wg-workouts-exercise-detail__record .wg-workouts-stats__top-row-name'))
        .map((n) => n.textContent);
      expect(repNames).toContain('5 reps');
      expect(repNames).toContain('12 reps');
    });
  });

  // Phase 3 — PR badge on the session log card.
  describe('session log-card PR badge (Phase 3)', () => {
    it('appends a PR badge when a saved log beats the exercise history baseline', async () => {
      const { window, document } = env;
      window.WorkoutAnalysis = WorkoutAnalysis;
      window.WorkoutSessionsState.data = { id: 2 };
      window.WorkoutSessionsState.logs = [{
        id: 42,
        exercise_name: 'Bench Press',
        sets_completed: 1,
        reps_completed: 5,
        weight_kg: 100,
        sets: [{ set_index: 0, weight_kg: 100, reps: 5, set_type: 'normal' }],
      }];
      // History: an older session at 90 kg (baseline) + this session at 100 kg (PR).
      window.apiCall = vi.fn(async (url) => {
        if (String(url).includes('/api/workout/exercises/history')) {
          return [
            { date: '2026-01-01', session_id: 1, sets: [{ weight_kg: 90, reps: 5, set_type: 'normal' }] },
            { date: '2026-01-08', session_id: 2, sets: [{ weight_kg: 100, reps: 5, set_type: 'normal' }] },
          ];
        }
        return null;
      });

      const container = document.getElementById('workout-session-logs');
      window.WorkoutSessions.renderLogs(container);

      await vi.waitFor(() => {
        expect(container.querySelector('.wg-workouts-session-exercise__pr-badge')).toBeTruthy();
      });
    });

    it('does not badge a saved log that only ties the baseline', async () => {
      const { window, document } = env;
      window.WorkoutAnalysis = WorkoutAnalysis;
      window.WorkoutSessionsState.data = { id: 2 };
      window.WorkoutSessionsState.logs = [{
        id: 43,
        exercise_name: 'Squat',
        sets_completed: 1,
        reps_completed: 5,
        weight_kg: 90,
        sets: [{ set_index: 0, weight_kg: 90, reps: 5, set_type: 'normal' }],
      }];
      window.apiCall = vi.fn(async (url) => {
        if (String(url).includes('/api/workout/exercises/history')) {
          return [
            { date: '2026-01-01', session_id: 1, sets: [{ weight_kg: 90, reps: 5, set_type: 'normal' }] },
            { date: '2026-01-08', session_id: 2, sets: [{ weight_kg: 90, reps: 5, set_type: 'normal' }] },
          ];
        }
        return null;
      });

      const container = document.getElementById('workout-session-logs');
      window.WorkoutSessions.renderLogs(container);

      await new Promise((r) => setTimeout(r, 10));
      expect(container.querySelector('.wg-workouts-session-exercise__pr-badge')).toBeNull();
    });
  });
});
