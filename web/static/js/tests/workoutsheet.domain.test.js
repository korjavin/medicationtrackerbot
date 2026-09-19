// bd med-qj4.9 — printed-sheet scan-back domain unit. Pure ESM import off
// disk (same pattern as food.domain-eaten-at.test.js): QR text round-trip,
// model-output validation/mapping, and the parse→save domain halves with
// stubbed aiClient/workoutDomain ports. The provider HTTP call itself is
// covered at the fetch boundary in web/cloud/js/tests/
// aiclient.workout-sheet.test.js.
import { describe, expect, it, vi } from 'vitest';

import {
  buildSheetQrText,
  convertParsedSheet,
  createWorkoutSheetAIDomain,
  parseSheetQrText,
} from '../../../domain/workoutsheet.js';

const PLAN = {
  groupId: 5,
  groupName: 'Push / Pull',
  unit: 'kg',
  days: [
    {
      variant: { id: 21, name: 'Push day' },
      exercises: [
        { id: 1, exercise_name: 'Bench press' },
        { id: 2, exercise_name: 'Overhead press' },
      ],
    },
  ],
};

describe('workoutsheet QR anchor', () => {
  it('round-trips the group id', () => {
    expect(parseSheetQrText(buildSheetQrText(5))).toEqual({ groupId: 5 });
  });

  it('rejects blanks, foreign codes, wrong versions, and non-positive ids', () => {
    expect(parseSheetQrText('')).toBeNull();
    expect(parseSheetQrText(null)).toBeNull();
    expect(parseSheetQrText('workout-plan:2:5')).toBeNull();
    expect(parseSheetQrText('meal:1:5')).toBeNull();
    expect(parseSheetQrText('workout-plan:1:0')).toBeNull();
    expect(parseSheetQrText('  workout-plan:1:7  ')).toEqual({ groupId: 7 });
    expect(() => buildSheetQrText(0)).toThrow();
    expect(() => buildSheetQrText('x')).toThrow();
  });
});

describe('convertParsedSheet', () => {
  it('maps sets to plan exercises case-insensitively and keeps weights', () => {
    const { sets, skipped } = convertParsedSheet(
      {
        items: [
          { exercise: 'bench PRESS', set_index: 1, reps: 8, weight: 60, unit: 'kg' },
          { exercise: 'Overhead press', set_index: 2, reps: 6 },
        ],
      },
      PLAN,
    );
    expect(skipped).toEqual([]);
    expect(sets).toEqual([
      { variantId: 21, exerciseId: 1, exerciseName: 'Bench press', setIndex: 1, reps: 8, weightKg: 60 },
      { variantId: 21, exerciseId: 2, exerciseName: 'Overhead press', setIndex: 2, reps: 6, weightKg: null },
    ]);
  });

  it('converts lb to kg and drops unreadable rows, reporting unknown names', () => {
    const { sets, skipped } = convertParsedSheet(
      {
        items: [
          { exercise: 'Bench press', set_index: 1, reps: 5, weight: 132.3, unit: 'lb' },
          { exercise: 'Mystery lift', set_index: 1, reps: 5 },
          { exercise: 'Bench press', set_index: 99, reps: 5 },
          { exercise: 'Bench press', set_index: 1, reps: -3 },
          { exercise: 'Bench press', set_index: 1, reps: 5, weight: 10, unit: 'stones' },
        ],
      },
      PLAN,
    );
    expect(sets).toHaveLength(1);
    expect(sets[0].weightKg).toBeCloseTo(60, 0);
    expect(skipped).toEqual(['Mystery lift']);
  });

  it('a day-qualified item lands on that day\'s exercise; name-only falls back', () => {
    const rotating = {
      ...PLAN,
      days: [
        { variant: { id: 21, name: 'Day A' }, exercises: [{ id: 1, exercise_name: 'Squat' }] },
        { variant: { id: 22, name: 'Day B' }, exercises: [{ id: 7, exercise_name: 'Squat' }] },
      ],
    };
    const { sets } = convertParsedSheet(
      {
        items: [
          { day: 'Day B', exercise: 'Squat', set_index: 1, reps: 5, weight: null, unit: '' },
          { day: '', exercise: 'Squat', set_index: 1, reps: 5, weight: null, unit: '' },
        ],
      },
      rotating,
    );
    expect(sets.map((s) => [s.variantId, s.exerciseId])).toEqual([[22, 7], [21, 1]]);
  });

  it('throws on a missing items array', () => {
    expect(() => convertParsedSheet({}, PLAN)).toThrow(/no sheet items/);
    expect(() => convertParsedSheet(null, PLAN)).toThrow(/no sheet items/);
  });
});

function stubWorkoutDomain() {
  return {
    createAdHocSession: vi.fn(async () => ({ id: 9 })),
    createLog: vi.fn(async () => ({ id: 1 })),
    setSessionStatus: vi.fn(async () => ({})),
  };
}

describe('createWorkoutSheetAIDomain', () => {
  it('parseSheetFromPhoto validates the model output against the plan', async () => {
    const aiClient = {
      parseWorkoutSheetImage: vi.fn(async () => ({
        items: [{ exercise: 'Bench press', set_index: 1, reps: 8, weight: 60, unit: 'kg' }],
      })),
    };
    const domain = createWorkoutSheetAIDomain({ aiClient, workoutDomain: stubWorkoutDomain() });
    const res = await domain.parseSheetFromPhoto(new Blob(['x']), PLAN);
    expect(aiClient.parseWorkoutSheetImage).toHaveBeenCalledTimes(1);
    expect(res.sets).toHaveLength(1);
    expect(res.sets[0].exerciseId).toBe(1);
  });

  it('logSheetAsSession groups sets per exercise with per-set arrays and completes', async () => {
    const workoutDomain = stubWorkoutDomain();
    const domain = createWorkoutSheetAIDomain({ aiClient: {}, workoutDomain, now: () => 1700000000000 });
    const res = await domain.logSheetAsSession({
      planContext: PLAN,
      sets: [
        { variantId: 21, exerciseId: 1, exerciseName: 'Bench press', setIndex: 1, reps: 8, weightKg: 60 },
        { variantId: 21, exerciseId: 1, exerciseName: 'Bench press', setIndex: 2, reps: 6, weightKg: 60 },
        { variantId: 21, exerciseId: 2, exerciseName: 'Overhead press', setIndex: 1, reps: 10, weightKg: null },
      ],
    });
    expect(res).toEqual({ sessionId: 9, logged: 2, failed: 0 });
    expect(workoutDomain.createAdHocSession).toHaveBeenCalledTimes(1);
    // Own recordId so the adopt-today's-in-progress guard is bypassed: a scan
    // must never complete a workout the user is mid-way through.
    expect(workoutDomain.createAdHocSession.mock.calls[0][0].recordId).toMatch(/^scan-5-\d+$/);
    expect(workoutDomain.createLog).toHaveBeenCalledTimes(2);
    const bench = workoutDomain.createLog.mock.calls[0][0];
    expect(bench.session_id).toBe(9);
    expect(bench.exercise_id).toBe(1);
    expect(bench.status).toBe('completed');
    expect(bench.sets).toHaveLength(2);
    expect(bench.sets[0]).toMatchObject({ set_index: 1, reps: 8, weight_kg: 60 });
    expect(workoutDomain.setSessionStatus).toHaveBeenCalledWith(9, 'completed');
  });

  it('counts a re-scan conflict as failed instead of duplicating', async () => {
    const workoutDomain = stubWorkoutDomain();
    workoutDomain.createLog.mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 'conflict' }));
    const domain = createWorkoutSheetAIDomain({ aiClient: {}, workoutDomain });
    const res = await domain.logSheetAsSession({
      planContext: PLAN,
      sets: [
        { variantId: 21, exerciseId: 1, exerciseName: 'Bench press', setIndex: 1, reps: 8, weightKg: 60 },
        { variantId: 21, exerciseId: 2, exerciseName: 'Overhead press', setIndex: 1, reps: 10, weightKg: null },
      ],
    });
    expect(res).toEqual({ sessionId: 9, logged: 1, failed: 1 });
  });

  it('throws when there is nothing to save', async () => {
    const domain = createWorkoutSheetAIDomain({ aiClient: {}, workoutDomain: stubWorkoutDomain() });
    await expect(domain.logSheetAsSession({ planContext: PLAN, sets: [] })).rejects.toThrow(/sets is required/);
  });
});
