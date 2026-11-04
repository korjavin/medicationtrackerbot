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

  // PL2 day page (med-jqrf.3, kit screens-plans PL2): read-only, opened from a
  // Plans-tab day row.
  describe('PL2 day page', () => {
    const day = (id, name, extra) => ({ id, name, exercises_count: 3, last_completed_date: null, last_duration_min: null, is_next: false, ...extra });
    const PLAN = {
      id: 1, name: 'Bench 100', active: true, is_rotating: true,
      next: { date: '2026-11-05', time: '18:00', variant_id: 11, session_id: 900, days_away: 1 },
      days: [
        day(11, 'Chest & Triceps', { is_next: true }), day(12, 'Back & Biceps'),
        day(13, 'Quads & Calves', { description: 'Quad-focused leg day with strength emphasis, plus calves.', last_completed_date: '2026-10-28', last_duration_min: 47 }),
        day(14, 'Upper Mix'), day(15, 'Glutes'), day(16, 'Bench Technique'), day(17, 'Upper Back'),
      ],
      exercises: [],
    };
    const EXERCISES = [
      { id: 3, exercise_name: 'Standing calf raise', target_sets: 4, target_reps_min: 12, target_weight_kg: 60, order_index: 2 },
      { id: 1, exercise_name: 'Back squat', target_sets: 4, target_reps_min: 5, target_weight_kg: 100, order_index: 0 },
      { id: 2, exercise_name: 'Leg press', target_sets: 3, target_reps_min: 10, target_weight_kg: 160, order_index: 1 },
    ];
    const HISTORY = {
      'Back squat': [{ date: '2026-10-28', sets: [{ set_type: 'warmup', reps: 8, weight_kg: 60 }, ...Array(4).fill({ reps: 5, weight_kg: 97.5 })] }],
      'Leg press': [{ date: '2026-10-28', sets: Array(3).fill({ reps: 10, weight_kg: 150 }) }],
      'Standing calf raise': [],
    };

    // apiCall over the local vault; `over` answers set-variant and anything else.
    function stubApi(window, { plans = { plans: [PLAN], active_session_id: null }, over } = {}) {
      window.apiCall = vi.fn((url, method, body, opts) => {
        if (url.startsWith('/api/workout/exercises?variant_id=')) return Promise.resolve(EXERCISES);
        if (url.startsWith('/api/workout/exercises/history?name=')) {
          return Promise.resolve(HISTORY[decodeURIComponent(url.split('name=')[1].split('&')[0])] || []);
        }
        if (url === '/api/workout/plans') return Promise.resolve(plans);
        return over ? over(url, method, body, opts) : Promise.resolve(null);
      });
    }
    const openDay = async (window, d) => {
      const page = window.openWorkoutPlanDayPage(PLAN, d || PLAN.days[2]);
      await vi.waitFor(() => expect(page.el.querySelector('.wg-section__head .wg-eyebrow').textContent).toMatch(/·/));
      return page.el;
    };
    const metas = (el) => Array.from(el.querySelectorAll('.wg-list .wg-row__meta')).map((m) => m.textContent);
    const startBtn = (el) => el.querySelector('[data-action="start-plan-day"]');
    const setVariantPosts = (window) => window.apiCall.mock.calls.filter(([u]) => u.includes('set-variant'));
    function fakeOptimistic(window) {
      const handle = { commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };
      window.DataStore.applyOptimistic = vi.fn(async () => handle);
      return handle;
    }

    it('renders crumb, description, "Exercises · n" with last done, and rows with target then last', async () => {
      const { window } = env;
      stubApi(window);
      const el = await openDay(window);
      expect(el.querySelector('.wg-pagebar__crumb').textContent).toBe('Bench 100 · day 3 of 7');
      expect(el.querySelector('.wg-pagebar__title').textContent).toBe('Quads & Calves');
      expect(el.querySelector('.wg-back').textContent).toContain('Plans');
      const edit = el.querySelector('.wg-pagebar .wg-btn');
      expect(edit.textContent).toBe('Edit');
      expect(edit.classList.contains('wg-btn--ghost')).toBe(true);
      expect(edit.classList.contains('wg-btn--primary')).toBe(false);
      expect(el.querySelector('.wg-pl__desc').textContent).toBe('Quad-focused leg day with strength emphasis, plus calves.');
      expect(el.querySelector('.wg-section__head .wg-eyebrow').textContent).toBe('Exercises · 3');
      expect(el.querySelector('.wg-section__head .wg-meta').textContent).toBe('last done Wed 28.10 · 47 min');
      expect(Array.from(el.querySelectorAll('.wg-list .wg-row__title')).map((t) => t.textContent)).toEqual(['Back squat', 'Leg press', 'Standing calf raise']);
      await vi.waitFor(() => expect(metas(el)).toEqual([
        '4 × 5 · 100 kg · last 4 × 5 · 97.5 kg',
        '3 × 10 · 160 kg · last 3 × 10 · 150 kg',
        '4 × 12 · 60 kg',
      ]));
      expect(startBtn(el).textContent).toBe('Start this day');
      expect(startBtn(el).closest('.wg-pagefoot')).not.toBeNull();
      // Only one sun on the page.
      expect(el.querySelectorAll('.wg-btn--primary')).toHaveLength(1);
    });

    it('a day with no description and never done shows neither', async () => {
      const { window } = env;
      stubApi(window);
      const el = await openDay(window, PLAN.days[1]);
      expect(el.querySelector('.wg-pl__desc')).toBeNull();
      expect(el.querySelector('.wg-section__head .wg-meta')).toBeNull();
    });

    it('an exercise tap opens its detail page', async () => {
      const { window } = env;
      stubApi(window);
      window.WorkoutExerciseDetail.open = vi.fn();
      const el = await openDay(window);
      el.querySelectorAll('.wg-list button.wg-row')[1].click();
      expect(window.WorkoutExerciseDetail.open).toHaveBeenCalledWith('Leg press');
    });

    it('Start this day posts set-variant once with the plan\'s own session id, then starts it', async () => {
      const { window } = env;
      const handle = fakeOptimistic(window);
      stubApi(window, { over: (url) => Promise.resolve(url.includes('set-variant') ? { ok: true } : null) });
      window.startWorkoutSession = vi.fn(async () => {});
      window.loadWorkoutGroups = vi.fn();
      window.loadNextWorkout = vi.fn();
      const el = await openDay(window);
      startBtn(el).click();
      await vi.waitFor(() => expect(window.startWorkoutSession).toHaveBeenCalledWith(900));
      expect(setVariantPosts(window)).toEqual([['/api/workout/sessions/900/set-variant', 'POST', { variant_id: 13 }, { suppressWriteAlert: true }]]);
      expect(handle.commit).toHaveBeenCalled();
      expect(handle.rollback).not.toHaveBeenCalled();
      // The optimistic state moves this plan's Next to the picked day.
      const [key, mutator] = window.DataStore.applyOptimistic.mock.calls[0];
      expect(key).toBe('workout_plans');
      const moved = mutator({ plans: [PLAN], active_session_id: null }).plans[0];
      expect(moved.days.filter((d) => d.is_next).map((d) => d.id)).toEqual([13]);
      expect(moved.next.variant_id).toBe(13);
      expect(window.loadNextWorkout).toHaveBeenCalled();
      expect(el.isConnected).toBe(false);
    });

    it('on the next day the sun reads "Start workout" and starts without a write', async () => {
      const { window } = env;
      fakeOptimistic(window);
      stubApi(window);
      window.startWorkoutSession = vi.fn(async () => {});
      const el = await openDay(window, PLAN.days[0]);
      expect(startBtn(el).textContent).toBe('Start workout');
      startBtn(el).click();
      await vi.waitFor(() => expect(window.startWorkoutSession).toHaveBeenCalledWith(900));
      expect(setVariantPosts(window)).toEqual([]);
      expect(window.DataStore.applyOptimistic).not.toHaveBeenCalled();
    });

    it('no sun while a session runs', async () => {
      const { window } = env;
      stubApi(window, { plans: { plans: [PLAN], active_session_id: 555 } });
      const el = await openDay(window);
      await vi.waitFor(() => expect(metas(el)[0]).toMatch(/last/));
      expect(startBtn(el)).toBeNull();
      expect(el.querySelector('.wg-pagefoot')).toBeNull();
    });

    it('a failed set-variant rolls back, toasts, and does not start', async () => {
      const { window } = env;
      const handle = fakeOptimistic(window);
      window.safeToast = vi.fn();
      stubApi(window, { over: (url) => (url.includes('set-variant') ? Promise.reject(new Error('boom')) : Promise.resolve(null)) });
      window.startWorkoutSession = vi.fn();
      const el = await openDay(window);
      startBtn(el).click();
      await vi.waitFor(() => expect(window.safeToast).toHaveBeenCalledWith("Couldn't switch the day. Please try again.", 'error'));
      expect(handle.rollback).toHaveBeenCalled();
      expect(handle.commit).not.toHaveBeenCalled();
      expect(window.startWorkoutSession).not.toHaveBeenCalled();
      expect(el.isConnected).toBe(true);
      await vi.waitFor(() => expect(startBtn(el).disabled).toBe(false));
    });

    it('overlapping taps send one write', async () => {
      const { window } = env;
      fakeOptimistic(window);
      let release;
      stubApi(window, { over: (url) => (url.includes('set-variant') ? new Promise((r) => { release = r; }) : Promise.resolve(null)) });
      window.startWorkoutSession = vi.fn(async () => {});
      window.loadWorkoutGroups = vi.fn();
      window.loadNextWorkout = vi.fn();
      const el = await openDay(window);
      const btn = startBtn(el);
      btn.click();
      btn.dispatchEvent(new window.Event('click'));
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      btn.dispatchEvent(new window.Event('click'));
      release({ ok: true });
      await vi.waitFor(() => expect(window.startWorkoutSession).toHaveBeenCalledTimes(1));
      expect(setVariantPosts(window)).toHaveLength(1);
    });

    it('Edit opens the plan editor on this day; Back returns to Plans with no editor draft', async () => {
      const { window } = env;
      stubApi(window, {
        over: (url) => {
          if (url === '/api/workout/groups') return Promise.resolve([{ id: 1, name: 'Bench 100', is_rotating: true, active: true }]);
          if (url.startsWith('/api/workout/variants?group_id=')) return Promise.resolve(PLAN.days.map((d, i) => ({ id: d.id, name: d.name, rotation_order: i })));
          return Promise.resolve(null);
        },
      });
      let el = await openDay(window);
      el.querySelector('.wg-back').click();
      expect(el.isConnected).toBe(false);
      expect(window.WorkoutEdit.planDraft).toBeNull();

      el = await openDay(window);
      el.querySelector('.wg-pagebar .wg-btn').click();
      await vi.waitFor(() => expect(window.WorkoutEdit.dayTarget).not.toBeNull());
      expect(el.isConnected).toBe(false);
      expect(window.WorkoutEdit.planDraft.groupId).toBe(1);
      expect(window.WorkoutEdit.dayTarget.day.id).toBe(13);
      expect(window.WorkoutEdit.dayTarget.page.el.querySelector('.wg-pagebar__title').textContent).toBe('Quads & Calves');
    });
  });
});
