import { describe, it, expect } from 'vitest';
import {
  GOAL_DEFAULTS,
  DEFAULT_GOAL,
  TRAINING_GOALS,
  defaultsForGoal,
  normalizeGoal,
} from '../../../domain/workout-goals.js';

describe('workout-goals defaults', () => {
  it('matches the science-basis table', () => {
    expect(GOAL_DEFAULTS.strength).toEqual({ reps_min: 3, reps_max: 6, target_rir: 2, progression: 'linear' });
    expect(GOAL_DEFAULTS.hypertrophy).toEqual({ reps_min: 8, reps_max: 12, target_rir: 1, progression: 'double' });
    expect(GOAL_DEFAULTS.endurance).toEqual({ reps_min: 15, reps_max: 25, target_rir: 1, progression: 'double' });
    expect(GOAL_DEFAULTS.general).toEqual({ reps_min: 8, reps_max: 12, target_rir: null, progression: 'none' });
  });

  it('defaults to hypertrophy', () => {
    expect(DEFAULT_GOAL).toBe('hypertrophy');
    expect(TRAINING_GOALS).toEqual(['strength', 'hypertrophy', 'endurance', 'general']);
  });

  it('defaultsForGoal falls back to hypertrophy for unknown/empty', () => {
    expect(defaultsForGoal('strength')).toBe(GOAL_DEFAULTS.strength);
    expect(defaultsForGoal('')).toBe(GOAL_DEFAULTS.hypertrophy);
    expect(defaultsForGoal('bogus')).toBe(GOAL_DEFAULTS.hypertrophy);
    expect(defaultsForGoal(undefined)).toBe(GOAL_DEFAULTS.hypertrophy);
  });

  it('normalizeGoal validates against the enum', () => {
    expect(normalizeGoal('endurance')).toBe('endurance');
    expect(normalizeGoal('nope')).toBe('hypertrophy');
    expect(normalizeGoal('')).toBe('hypertrophy');
  });
});
