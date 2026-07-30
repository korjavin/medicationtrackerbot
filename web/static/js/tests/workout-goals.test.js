import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  GOAL_DEFAULTS,
  DEFAULT_GOAL,
  TRAINING_GOALS,
  defaultsForGoal,
  normalizeGoal,
  rirFromRpe,
  rpeFromRir,
  formatEffort,
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

// med-qj4.6.2: `rpe` stays the single STORED effort field; RIR is a view of it.
// These are the only place `10 - x` may live, so pin both directions + the
// absent-effort contract the progression gate and the later graph/insight code
// depend on.
describe('workout-goals effort conversion (RIR ⇄ RPE)', () => {
  it('converts both directions, including halves', () => {
    expect(rirFromRpe(10)).toBe(0);
    expect(rirFromRpe(8)).toBe(2);
    expect(rirFromRpe(7.5)).toBe(2.5);
    expect(rpeFromRir(0)).toBe(10);
    expect(rpeFromRir(2)).toBe(8);
    // Round-trips: the goal table's target_rir read back as an RPE cue.
    expect(rirFromRpe(rpeFromRir(GOAL_DEFAULTS.strength.target_rir))).toBe(2);
  });

  it('treats absent/blank/non-finite effort as null, never 10', () => {
    for (const v of [null, undefined, '', 'hard', NaN, Infinity]) {
      expect(rirFromRpe(v)).toBeNull();
      expect(rpeFromRir(v)).toBeNull();
      expect(formatEffort(v)).toBeNull();
    }
  });

  it('formatEffort spells out both ends', () => {
    expect(formatEffort(8)).toBe('RPE 8 · 2 RIR');
    expect(formatEffort(10)).toBe('RPE 10 · 0 RIR');
  });
});

// The exercise editor is a plain <script> and cannot import this ES module, so
// it keeps a hand-copy of the goal table (see the comment above
// WORKOUT_GOAL_DEFAULTS in features/workout/exercises.js). That copy shipped
// with no guard — a table edit here would silently leave the editor cascading
// stale rep ranges. This pins the copy against the source of truth; if the seam
// is ever fixed properly (feature layer importing web/domain/), delete this test
// along with the duplicate.
describe('WORKOUT_GOAL_DEFAULTS duplicate in the exercise editor', () => {
  const EXERCISES_JS = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../features/workout/exercises.js',
  );

  it('matches GOAL_DEFAULTS for every goal', () => {
    const src = fs.readFileSync(EXERCISES_JS, 'utf8');
    const block = /const WORKOUT_GOAL_DEFAULTS = \{([\s\S]*?)\n\};/.exec(src);
    expect(block, 'WORKOUT_GOAL_DEFAULTS literal not found — did it move or get renamed?').toBeTruthy();

    for (const goal of TRAINING_GOALS) {
      const row = new RegExp(`\\b${goal}:\\s*\\{([^}]*)\\}`).exec(block[1]);
      expect(row, `no ${goal} row in the duplicated table`).toBeTruthy();
      const num = (key) => Number((new RegExp(`${key}:\\s*(\\d+)`).exec(row[1]) || [])[1]);
      const str = (key) => (new RegExp(`${key}:\\s*'([^']*)'`).exec(row[1]) || [])[1];
      expect({
        reps_min: num('reps_min'),
        reps_max: num('reps_max'),
        progression: str('progression'),
      }).toEqual({
        reps_min: GOAL_DEFAULTS[goal].reps_min,
        reps_max: GOAL_DEFAULTS[goal].reps_max,
        progression: GOAL_DEFAULTS[goal].progression,
      });
      // target_rir is deliberately absent from the copy — the editor has no
      // target-RIR field. Pin that so it isn't half-copied later.
      expect(row[1]).not.toMatch(/target_rir/);
    }
  });
});
