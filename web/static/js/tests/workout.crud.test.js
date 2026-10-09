// Plan editor CRUD (med-xso6.22): the Plan → Day → Exercise pages stage every
// change into the plan draft; the Plan page's Save sends the same group /
// variant / exercise routes and payloads the old modals did.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clickRowAction, loadFrontendEnv } from './helpers/frontend-harness.js';

const GROUP = {
  id: 5,
  name: 'Old',
  description: '',
  is_rotating: true,
  days_of_week: JSON.stringify([1]),
  scheduled_time: '09:00',
  notification_advance_minutes: 15,
  active: true
};

describe('workout.js CRUD flows', () => {
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  // Reads answer from fixtures; writes succeed (creates hand back an id).
  function stubApi(window, { variants = [], exercises = {} } = {}) {
    let nextId = 200;
    window.apiCall = vi.fn(async (url, method = 'GET') => {
      if (method === 'GET') {
        if (url.startsWith('/api/workout/variants?')) return variants;
        const m = /exercises\?variant_id=(\d+)/.exec(url);
        if (m) return exercises[m[1]] || [];
        return [];
      }
      if (url.endsWith('/create')) return { id: nextId++ };
      return true;
    });
    window.loadWorkoutGroups = vi.fn();
    window.WorkoutLibrary = { bindExercisePicker: vi.fn(async () => {}) };
    return () => window.apiCall.mock.calls.filter(([, m]) => m && m !== 'GET');
  }

  it('saveWorkoutGroup validates required fields', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const writes = stubApi(window);
      const alertSpy = vi.fn();
      window.safeAlert = alertSpy;
      await window.openWorkoutPlanPage(null);

      document.getElementById('workout-group-name').value = '';
      document.getElementById('workout-group-time').value = '';

      await window.saveWorkoutGroup();

      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(alertSpy.mock.calls[0][0]).toContain('Plan name is required');
      expect(writes()).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('saveWorkoutGroup creates new group, closes the page and refreshes list', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const writes = stubApi(window);
      await window.openWorkoutPlanPage(null);
      document.getElementById('workout-group-name').value = 'Morning';
      document.getElementById('workout-group-description').value = 'Cardio';
      document.getElementById('workout-group-time').value = '08:30';
      document.getElementById('workout-group-notification').value = '20';
      document.querySelector('[data-workout-page="plan"] .wg-pick[data-day="1"]').click();
      document.querySelector('[data-workout-page="plan"] .wg-pick[data-day="3"]').click();

      await window.saveWorkoutGroup();

      // No exercises staged: the implicit "Main" Day is not created.
      expect(writes()).toEqual([['/api/workout/groups/create', 'POST', {
        name: 'Morning',
        description: 'Cardio',
        is_rotating: false,
        days_of_week: JSON.stringify([1, 3]),
        scheduled_time: '08:30',
        notification_advance_minutes: 20,
        training_goal: 'hypertrophy'
      }]]);
      expect(window.WorkoutEdit.planDraft).toBeNull();
      expect(window.loadWorkoutGroups).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('saveWorkoutGroup updates existing group via PUT and includes active flag', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const writes = stubApi(window);
      window.WorkoutEdit.cachedGroups = [GROUP];
      await window.openWorkoutPlanPage(5);
      document.getElementById('workout-group-name').value = 'Updated';
      document.getElementById('workout-group-time').value = '07:45';
      document.getElementById('workout-group-active').checked = false;

      await window.saveWorkoutGroup();

      expect(writes()).toEqual([['/api/workout/groups/update?id=5', 'PUT', expect.objectContaining({
        name: 'Updated',
        scheduled_time: '07:45',
        active: false
      })]]);
    } finally {
      cleanup();
    }
  });

  it('Plan day rows: overflow menu Edit opens the Day page; Delete stages the removal', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const writes = stubApi(window, { variants: [{ id: 31, group_id: 5, name: 'Day A', rotation_order: 1 }] });
      window.WorkoutEdit.cachedGroups = [GROUP];
      await window.openWorkoutPlanPage(5);

      const row = document.querySelector('#workout-variants-list .wg-workout-day-row');
      expect(row.classList.contains('wg-swipe')).toBe(true);
      expect(row.querySelector('.icon-action-btn')).toBeNull();

      clickRowAction(row, 'Edit');
      expect(window.WorkoutEdit.dayTarget.day.id).toBe(31);
      expect(document.getElementById('workout-variant-name').value).toBe('Day A');
      window.WorkoutEdit.dayTarget.page.close();

      window.safeConfirm = vi.fn(async () => true);
      clickRowAction(document.querySelector('#workout-variants-list .wg-workout-day-row'), 'Delete');
      await vi.waitFor(() => expect(window.WorkoutEdit.planDraft.removedDays).toEqual([31]));
      expect(document.getElementById('workout-variants-list').textContent).toContain('No days yet');
      expect(writes()).toHaveLength(0);

      await window.saveWorkoutGroup();
      expect(writes().map(([u, m]) => `${m} ${u}`)).toEqual([
        'PUT /api/workout/groups/update?id=5',
        'DELETE /api/workout/variants/delete?id=31',
      ]);
    } finally {
      cleanup();
    }
  });

  it('Day page validates its name; Done stages a new Day that Save creates', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const writes = stubApi(window);
      window.WorkoutEdit.cachedGroups = [GROUP];
      await window.openWorkoutPlanPage(5);
      window.addWorkoutPlanDay();

      const alertSpy = vi.fn();
      window.safeAlert = alertSpy;
      document.getElementById('workout-variant-name').value = '';
      expect(window.stageWorkoutDay()).toBe(false);
      expect(alertSpy).toHaveBeenCalled();

      document.getElementById('workout-variant-name').value = 'Day A';
      document.getElementById('workout-variant-description').value = 'Push';
      expect(window.stageWorkoutDay()).toBe(true);
      expect(writes()).toHaveLength(0);

      await window.saveWorkoutGroup();

      expect(writes()[1]).toEqual(['/api/workout/variants/create', 'POST', {
        group_id: 5,
        name: 'Day A',
        rotation_order: 0,
        description: 'Push'
      }]);
    } finally {
      cleanup();
    }
  });

  it('Exercise page validates required fields; Done stages, Save creates the exercise', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const writes = stubApi(window, { variants: [{ id: 33, group_id: 5, name: 'Day A', rotation_order: 0 }] });
      window.WorkoutEdit.cachedGroups = [GROUP];
      await window.openWorkoutPlanPage(5);
      window.openWorkoutDayPage(window.WorkoutEdit.planDraft.days[0], window.renderWorkoutPlanBody);
      // Await the open: its tail (picker prefetch, equipment-select fill)
      // issues reads that must settle before the Done.
      await window.addExerciseToWorkoutDay();

      const alertSpy = vi.fn();
      window.safeAlert = alertSpy;
      document.getElementById('workout-exercise-name').value = '';
      document.getElementById('workout-exercise-sets').value = '3';
      document.getElementById('workout-exercise-reps-min').value = '8';
      expect(window.stageExercise()).toBeNull();
      expect(alertSpy).toHaveBeenCalled();

      document.getElementById('workout-exercise-name').value = 'Squat';
      document.getElementById('workout-exercise-sets').value = '4';
      document.getElementById('workout-exercise-reps-min').value = '6';
      document.getElementById('workout-exercise-reps-max').value = '8';
      document.getElementById('workout-exercise-weight').value = '80';
      window.stageExercise();
      window.stageWorkoutDay();
      expect(writes()).toHaveLength(0);

      await window.saveWorkoutGroup();

      expect(writes()[1]).toEqual(['/api/workout/exercises/create', 'POST', {
        variant_id: 33,
        exercise_name: 'Squat',
        target_sets: 4,
        target_reps_min: 6,
        target_reps_max: 8,
        target_weight_kg: 80,
        order_index: 0,
        // Phase 4: the editor always sends progression_rule so selecting "None"
        // reliably clears a stored rule on the update path (cloud's OMIT-key ==
        // preserve semantics). med-qj4.6.1: opening Add runs the goal cascade
        // (plan goal unset here → hypertrophy → double).
        progression_rule: { type: 'double', increment_kg: 2.5 },
        // med-qj4.6.1: goal override; "" (From plan) is the default.
        training_goal: ''
      }]);
    } finally {
      cleanup();
    }
  });

  it('Back on a dirty Day page asks first; declining keeps the page, the draft untouched', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      stubApi(window, { variants: [{ id: 31, group_id: 5, name: 'Day A', rotation_order: 0 }] });
      window.WorkoutEdit.cachedGroups = [GROUP];
      await window.openWorkoutPlanPage(5);
      window.openWorkoutDayPage(window.WorkoutEdit.planDraft.days[0], window.renderWorkoutPlanBody);
      document.getElementById('workout-variant-name').value = 'Renamed';

      window.safeConfirm = vi.fn(async () => false);
      window.WorkoutEdit.dayTarget.page.el.querySelector('.wg-back').click();
      await Promise.resolve();
      expect(window.safeConfirm).toHaveBeenCalledTimes(1);
      expect(window.WorkoutEdit.dayTarget).not.toBeNull();

      window.safeConfirm = vi.fn(async () => true);
      window.WorkoutEdit.dayTarget.page.el.querySelector('.wg-back').click();
      await vi.waitFor(() => expect(window.WorkoutEdit.dayTarget).toBeNull());
      expect(window.WorkoutEdit.planDraft.days[0].name).toBe('Day A');
    } finally {
      cleanup();
    }
  });
});
