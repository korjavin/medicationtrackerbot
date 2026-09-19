// bd med-qj4.9 — sheet scan-back UI flow. The vision call itself is faked at
// the aiClient boundary (aiclient.workout-sheet.test.js) and validation in
// the domain suite (workoutsheet.domain.test.js); these cover what scan.js
// owns: cloud gating, the picker→parse→review handoff, review editing, and
// the confirm write.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const GROUP = { id: 5, name: 'Push / Pull', is_rotating: true, active: true };

const VARIANTS = [{ id: 21, group_id: 5, name: 'Push day', rotation_order: 1 }];

const EXERCISES = {
  21: [
    { id: 1, exercise_name: 'Bench press', order_index: 0, target_sets: 2, target_reps_min: 8 },
    { id: 2, exercise_name: 'Overhead press', order_index: 1, target_sets: 1, target_reps_min: 6 },
  ],
};

const SETS = [
  { variantId: 21, exerciseId: 1, exerciseName: 'Bench press', setIndex: 1, reps: 8, weightKg: 60 },
  { variantId: 21, exerciseId: 1, exerciseName: 'Bench press', setIndex: 2, reps: 6, weightKg: 60 },
  { variantId: 21, exerciseId: 2, exerciseName: 'Overhead press', setIndex: 1, reps: 10, weightKg: null },
];

function stubApi(window) {
  window.apiCall = vi.fn(async (url) => {
    if (url.startsWith('/api/workout/variants?group_id=')) return VARIANTS;
    const m = /\/api\/workout\/exercises\?variant_id=(\d+)/.exec(url);
    if (m) return EXERCISES[m[1]] || [];
    return null;
  });
}

describe('features/workout/scan.js (med-qj4.9)', () => {
  let env;

  beforeEach(() => {
    env = loadFrontendEnv({ withWorkout: true });
    env.window.Telegram.WebApp.showAlert = vi.fn();
    env.window.WorkoutScan._pending = null;
  });

  afterEach(() => {
    env.cleanup();
    env = null;
  });

  it('buildContext assembles the plan the sheet printed from', () => {
    const { window } = env;
    expect(window.WorkoutScan.buildContext(GROUP, [{ variant: VARIANTS[0], exercises: EXERCISES[21] }], 'lb')).toEqual({
      groupId: 5,
      groupName: 'Push / Pull',
      unit: 'lb',
      days: [{
        variant: { id: 21, name: 'Push day' },
        exercises: [
          { id: 1, exercise_name: 'Bench press' },
          { id: 2, exercise_name: 'Overhead press' },
        ],
      }],
    });
  });

  it('outside cloud mode it alerts and never opens the picker', async () => {
    const { window } = env;
    delete window.__MEDTRACKER_CLOUD__;
    window.MediaCapture.pickPhoto = vi.fn();
    stubApi(window);

    await window.WorkoutScan.scan(GROUP);

    expect(window.Telegram.WebApp.showAlert).toHaveBeenCalledTimes(1);
    expect(window.MediaCapture.pickPhoto).not.toHaveBeenCalled();
    expect(window.WorkoutScan._pending).toBeNull();
  });

  it('picker → parse → review: pending state lands and the modal opens', async () => {
    const { window, document } = env;
    window.__MEDTRACKER_CLOUD__ = true;
    stubApi(window);
    const file = new window.File([new window.Blob(['x'])], 'sheet.jpg', { type: 'image/jpeg' });
    window.MediaCapture.pickPhoto = vi.fn(async () => file);
    window.CloudWorkoutSheetAI = {
      parseSheetFromPhoto: vi.fn(async () => ({ sets: SETS, skipped: ['Mystery lift'] })),
    };

    await window.WorkoutScan.scan(GROUP);

    expect(window.CloudWorkoutSheetAI.parseSheetFromPhoto).toHaveBeenCalledTimes(1);
    const [gotFile, ctx] = window.CloudWorkoutSheetAI.parseSheetFromPhoto.mock.calls[0];
    expect(gotFile).toBe(file);
    expect(ctx.groupId).toBe(5);
    expect(ctx.days[0].exercises).toHaveLength(2);
    expect(window.WorkoutScan._pending.sets).toHaveLength(3);
    expect(document.getElementById('workout-scan-modal-title').textContent).toContain('Push / Pull');
    expect(document.getElementById('workout-scan-modal').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('workout-scan-skipped').textContent).toContain('Mystery lift');
    expect(document.querySelectorAll('[data-scan-set]')).toHaveLength(3);
    delete window.__MEDTRACKER_CLOUD__;
    delete window.CloudWorkoutSheetAI;
  });

  it('a cancelled picker resolves to no-op', async () => {
    const { window } = env;
    window.__MEDTRACKER_CLOUD__ = true;
    stubApi(window);
    window.MediaCapture.pickPhoto = vi.fn(async () => null);
    window.CloudWorkoutSheetAI = { parseSheetFromPhoto: vi.fn() };

    await window.WorkoutScan.scan(GROUP);

    expect(window.CloudWorkoutSheetAI.parseSheetFromPhoto).not.toHaveBeenCalled();
    expect(window.WorkoutScan._pending).toBeNull();
    delete window.__MEDTRACKER_CLOUD__;
    delete window.CloudWorkoutSheetAI;
  });

  it('readList converts lb rows to kg and drops emptied rows', () => {
    const { window, document } = env;
    window.WorkoutScan._pending = { sets: SETS, skipped: [], unit: 'lb' };
    window.WorkoutScan.renderReview();
    const list = document.getElementById('workout-scan-list');

    // Empty the overhead-press reps; halve the first bench weight.
    const rows = [...list.querySelectorAll('[data-scan-set]')];
    rows[0].querySelector('[data-scan-weight]').value = '30';
    rows[2].querySelector('[data-scan-reps]').value = '';

    const sets = window.WorkoutScan.readList(list, 'lb');
    expect(sets).toHaveLength(2);
    expect(sets[0].weightKg).toBeCloseTo(13.61, 1);
    expect(sets[0].reps).toBe(8);
    expect(sets.map((s) => s.exerciseId)).toEqual([1, 1]);
  });

  it('confirm logs the edited review and closes with a summary', async () => {
    const { window, document } = env;
    window.__MEDTRACKER_CLOUD__ = true;
    window.WorkoutScan._pending = { group: GROUP, planContext: { groupId: 5 }, sets: SETS, skipped: [], unit: 'kg' };
    window.WorkoutScan.renderReview();
    window.CloudWorkoutSheetAI = {
      logSheetAsSession: vi.fn(async () => ({ sessionId: 9, logged: 2, failed: 0 })),
    };
    window.loadWorkoutGroups = vi.fn();

    await window.WorkoutScan.confirm();

    expect(window.CloudWorkoutSheetAI.logSheetAsSession).toHaveBeenCalledTimes(1);
    const arg = window.CloudWorkoutSheetAI.logSheetAsSession.mock.calls[0][0];
    expect(arg.planContext).toEqual({ groupId: 5 });
    expect(arg.sets).toHaveLength(3);
    expect(window.WorkoutScan._pending).toBeNull();
    expect(document.getElementById('workout-scan-modal').classList.contains('hidden')).toBe(true);
    expect(window.Telegram.WebApp.showAlert).toHaveBeenCalledTimes(1);
    expect(window.Telegram.WebApp.showAlert.mock.calls[0][0]).toContain('Logged 2 exercises');
    delete window.__MEDTRACKER_CLOUD__;
    delete window.CloudWorkoutSheetAI;
  });

  it('confirm with every row emptied alerts instead of writing', async () => {
    const { window, document } = env;
    window.WorkoutScan._pending = { group: GROUP, planContext: { groupId: 5 }, sets: SETS, skipped: [], unit: 'kg' };
    window.WorkoutScan.renderReview();
    const log = vi.fn();
    window.CloudWorkoutSheetAI = { logSheetAsSession: log };
    for (const row of document.querySelectorAll('[data-scan-set]')) {
      row.querySelector('[data-scan-reps]').value = '';
    }

    await window.WorkoutScan.confirm();

    expect(log).not.toHaveBeenCalled();
    expect(window.Telegram.WebApp.showAlert).toHaveBeenCalledTimes(1);
    expect(window.WorkoutScan._pending).not.toBeNull();
    delete window.CloudWorkoutSheetAI;
  });
});
