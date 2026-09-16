// Focused integration tests for the extracted features/workout/next-card.js
// sub-file. Covers the WorkoutNextCard public-API surface plus the
// shared slot-tag helper consumed by sibling files.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('features/workout/next-card.js — split-file integration', () => {
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

  it('exposes the WorkoutNextCard public-API namespace', () => {
    const { window } = env;
    expect(window.WorkoutNextCard).toBeTypeOf('object');
    expect(window.WorkoutNextCard.load).toBeTypeOf('function');
    expect(window.WorkoutNextCard.openEdit).toBeTypeOf('function');
    expect(window.WorkoutNextCard.nextVariant).toBeTypeOf('function');
  });

  it('workoutSlotTag reads AD-HOC for ad-hoc sessions and the plan name otherwise', () => {
    const { window, document } = env;
    const adhoc = window.workoutSlotTag(document, { group_id: -1 }, 'Ad-hoc', 'x');
    expect(adhoc.textContent).toBe('AD-HOC');
    expect(adhoc.classList.contains('wg-workouts-slot-tag--adhoc')).toBe(true);
    expect(adhoc.classList.contains('x')).toBe(true);
    const plan = window.workoutSlotTag(document, { group_id: 3 }, 'Plan 3 — Daily Split');
    expect(plan.textContent).toBe('Plan 3 — Daily Split');
    expect(plan.classList.contains('wg-workouts-slot-tag--plan')).toBe(true);
  });
});
