// Focused integration tests for features/workout/variants.js — the Day page
// of the plan editor (med-xso6.22). A Day page edits a working copy of one
// draft Day; Done folds it back into the plan draft with no network write.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('features/workout/variants.js — Day page', () => {
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

  it('exposes the WorkoutVariants page API + the WorkoutEdit dayTarget accessor', () => {
    const { window } = env;
    expect(window.WorkoutVariants).toBeTypeOf('object');
    for (const k of ['openAdd', 'openEdit', 'done', 'remove', 'addExercise']) {
      expect(window.WorkoutVariants[k]).toBeTypeOf('function');
    }
    expect('dayTarget' in window.WorkoutEdit).toBe(true);
    expect(window.WorkoutEdit.dayTarget).toBeNull();
  });

  it('a Day page opens only on top of an open Plan page', () => {
    const { window } = env;
    expect(window.openWorkoutDayPage(null, () => {})).toBeNull();
    expect(window.WorkoutEdit.dayTarget).toBeNull();
  });

  it('Add day opens "New day" crumbed by the plan; Done stages it and edits stay on a copy until then', async () => {
    const { window, document } = env;
    window.apiCall = vi.fn(async () => []);
    window.WorkoutEdit.cachedGroups = [{ id: 7, name: 'PPL', is_rotating: true, active: true }];
    await window.openWorkoutPlanPage(7);
    const draft = window.WorkoutEdit.planDraft;

    window.addWorkoutPlanDay();
    const page = window.WorkoutEdit.dayTarget.page.el;
    expect(page.querySelector('.wg-pagebar__title').textContent).toBe('New day');
    expect(page.querySelector('.wg-pagebar__crumb').textContent).toBe('PPL');
    expect(page.querySelector('.wg-back').textContent).toContain('PPL');
    expect(document.getElementById('workout-variant-name').value).toBe('');

    document.getElementById('workout-variant-name').value = 'Legs';
    window.stageWorkoutDay();
    expect(draft.days.map((d) => d.name)).toEqual(['Legs']);
    expect(window.apiCall.mock.calls.some(([, m]) => m && m !== 'GET')).toBe(false);

    // Re-open and edit, then leave via the page's own close (no Done): the
    // draft Day is untouched.
    window.openWorkoutDayPage(draft.days[0], window.renderWorkoutPlanBody);
    document.getElementById('workout-variant-name').value = 'Changed';
    window.WorkoutEdit.dayTarget.work.exercises.push({ id: null, rec: null, payload: { exercise_name: 'X' } });
    window.WorkoutEdit.dayTarget.page.close();
    expect(draft.days[0].name).toBe('Legs');
    expect(draft.days[0].exercises).toHaveLength(0);
  });
});
