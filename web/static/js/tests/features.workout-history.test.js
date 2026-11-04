// Focused integration tests for the extracted features/workout/history.js
// sub-file. Covers the WorkoutHistory public-API surface plus a smoke test
// that the loadWorkoutHistoryTab loader renders a known sessions/miband
// payload into the DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv, createMockResponse } from './helpers/frontend-harness.js';
import { loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';

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

  it('shows a "{n} PRs" / "1 PR" chip on rows with pr_count and none otherwise', async () => {
    const { window, document } = env;
    const row = (id, pr_count) => ({
      group_name: 'Upper', variant_name: 'Push', exercises_completed: 2, exercises_count: 2, pr_count,
      session: { id, group_id: 1, status: 'completed', started_at: `2026-07-2${id - 600}T10:00:00Z`, scheduled_date: `2026-07-2${id - 600}` },
    });
    window.apiCall = vi.fn(async (url) => {
      if (url.includes('/api/workout/sessions')) return [row(601, 2), row(602, 1), row(603, 0)];
      if (url.includes('/api/workout/miband')) return [];
      if (url.includes('/api/settings')) return { timezone: '' };
      return null;
    });

    await window.loadWorkoutHistoryTab();

    const chipText = (id) => {
      const chip = document.querySelector(`[data-session-id="${id}"] .wg-workouts-history-row__pr`);
      return chip && chip.textContent;
    };
    expect(chipText(601)).toBe('2 PRs');
    expect(chipText(602)).toBe('1 PR');
    expect(chipText(603)).toBeNull();
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

    const display = document.getElementById('workout-history-display');
    const nameEl = display.querySelector('.wg-workouts-history-row__name');
    expect(nameEl).toBeTruthy();
    expect(nameEl.textContent).toBe('walk');
    expect(display.querySelector('.wg-workouts-history-row__tag').textContent).toBe('Off plan');
    expect(display.textContent).not.toContain('AD-HOC');
  });

  it('names a bare ad-hoc session (no notes, no exercises) "Workout"', async () => {
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
    expect(nameEl.textContent).toBe('Workout');
  });

  it('names a planned session by its plan day, with no Off plan tag', async () => {
    const { window, document } = env;
    window.apiCall = vi.fn(async (url) => {
      if (url.includes('/api/workout/sessions')) {
        return [{
          group_name: 'Plan 3 — Daily Split',
          variant_name: 'Upper Back & Grip',
          exercises_completed: 3,
          exercises_count: 3,
          session: {
            id: 503,
            group_id: 3,
            variant_id: 7,
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

    const row = document.getElementById('workout-history-display');
    expect(row.querySelector('.wg-workouts-history-row__tag')).toBeNull();
    expect(row.querySelector('.wg-workouts-history-row__name').textContent).toBe('Upper Back & Grip');
  });

  it('labels a session with its gym snapshot; no gym, no label (med-8j5w.2)', async () => {
    const { window, document } = env;
    const row = (id, extra) => ({
      group_name: 'Plan', variant_name: `Day ${id}`, exercises_completed: 1, exercises_count: 1,
      session: {
        id, group_id: 3, variant_id: 7, status: 'completed',
        started_at: '2026-07-20T10:00:00Z', scheduled_date: '2026-07-20', ...extra,
      },
    });
    window.apiCall = vi.fn(async (url) => {
      if (url.includes('/api/workout/sessions')) {
        return [row(601, { location_id: 9, location_name: 'Gym A' }), row(602, { location_id: null, location_name: null })];
      }
      if (url.includes('/api/workout/miband')) return [];
      if (url.includes('/api/settings')) return { timezone: '' };
      return null;
    });

    await window.loadWorkoutHistoryTab();

    const display = document.getElementById('workout-history-display');
    const gyms = Array.from(display.querySelectorAll('.wg-workouts-history-row__gym')).map((el) => el.textContent);
    expect(gyms).toEqual(['@ Gym A']);
    expect(display.querySelector('[data-session-id="601"] .wg-workouts-history-row__gym')).not.toBeNull();
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

// bd med-egzd: Finish from the med-laj4 Unfinished row, served end-to-end by the
// cloud shim + web/domain/workout.js. completed_at used to be the tidy-up
// instant, so the row rendered a 20h+ "workout"; it is now the session's own
// last log instant.
describe('features/workout/history.js — late Finish of an Unfinished row (cloud shim)', () => {
  let env;

  // Session transitions best-effort POST /api/telegram/cancel-refire (med-r3dm).
  beforeEach(() => { globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }); });

  afterEach(() => {
    delete globalThis.fetch;
    env.cleanup();
    env = null;
  });

  it('renders a duration bounded by the session\'s own day, not the tidy-up gap', async () => {
    const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const startedAt = `${day}T10:00:00.000Z`;
    env = loadCloudShimFrontendEnv({
      withWorkout: true,
      wrapApiCallDirect: true,
      timeZone: 'UTC',
      seedRecords: {
        workoutgroup: [{
          recordId: 'group-1', clientTs: 1, deleted: false, id: 1, user_id: 1, name: 'Strength',
          is_rotating: false, days_of_week: '[]', scheduled_time: '09:00',
          notification_advance_minutes: 0, active: true
        }],
        workoutvariant: [{
          recordId: 'variant-1', clientTs: 1, deleted: false, id: 1, group_id: 1, name: 'A', rotation_order: 0
        }],
        workoutsession: [{
          recordId: `session-1-${day}`, clientTs: 1, deleted: false, id: 303, user_id: 1, group_id: 1,
          variant_id: 1, scheduled_date: `${day}T00:00:00Z`, scheduled_time: '09:00', status: 'in_progress',
          started_at: startedAt, completed_at: null, snoozed_until: null, snooze_count: 0,
          notification_message_id: null, notes: ''
        }],
        exerciselog: [{
          recordId: 'log-5', clientTs: 1, deleted: false, id: 5, session_id: 303, exercise_id: 0,
          exercise_name: 'Bench', sets_completed: 3, reps_completed: 8, weight_kg: 60, status: 'completed',
          notes: '', logged_at: `${day}T10:45:00.000Z`
        }]
      }
    });
    const { window, document } = env;
    window.loadWorkoutHistoryTab = vi.fn();
    const container = document.getElementById('workout-history-display');
    window._renderWorkoutHistory(container, await window.apiCall('/api/workout/sessions?limit=50'), [], 'UTC');

    const row = container.querySelector('.wg-workouts-history-row');
    expect(row.querySelector('.wg-workouts-history-row__unfinished')).not.toBeNull();
    row.click();
    await vi.waitFor(() => expect(document.getElementById('workout-session-finish-btn')).not.toBeNull());
    document.getElementById('workout-session-finish-btn').click();
    await vi.waitFor(() => expect(document.querySelector('.mt-confirm-modal__confirm')).not.toBeNull());
    document.querySelector('.mt-confirm-modal__confirm').click();
    await vi.waitFor(() => expect(window.WorkoutSessionsState.data).toBeNull());

    const session = (await env.records.list('workoutsession')).find((s) => s.id === 303);
    expect(session.status).toBe('completed');
    expect(session.completed_at).toBe(`${day}T10:45:00.000Z`);

    window._renderWorkoutHistory(container, await window.apiCall('/api/workout/sessions?limit=50'), [], 'UTC');
    expect(container.querySelector('.wg-workouts-history-row__duration').textContent).toBe('45 min');
  });
});
