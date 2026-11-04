// Focused integration tests for the extracted features/workout/next-card.js
// sub-file. Covers the WorkoutNextCard public-API surface plus the
// shared slot-tag helper consumed by sibling files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

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

  it('workoutSlotTag reads Off plan for ad-hoc sessions and the plan name otherwise', () => {
    const { window, document } = env;
    const adhoc = window.workoutSlotTag(document, { group_id: -1 }, 'Ad-hoc', 'x');
    expect(adhoc.textContent).toBe('Off plan');
    expect(adhoc.classList.contains('wg-workouts-slot-tag--adhoc')).toBe(true);
    expect(adhoc.classList.contains('x')).toBe(true);
    const plan = window.workoutSlotTag(document, { group_id: 3 }, 'Plan 3 — Daily Split');
    expect(plan.textContent).toBe('Plan 3 — Daily Split');
    expect(plan.classList.contains('wg-workouts-slot-tag--plan')).toBe(true);
  });

  // med-8j5w.2: the active-gym switch on the card.
  const NEXT = {
    session: { id: 42, status: 'notified', scheduled_date: '2026-04-24', scheduled_time: '09:00', is_today: true },
    group_name: 'Morning', variant_name: 'Legs', exercises_count: 2, variant_id: 7, group_id: 3, is_rotating: false,
  };

  async function renderWithGyms(window, gyms, activeId, putResult = { location_id: null }) {
    window.apiCall = vi.fn(async (url, method, body) => {
      if (url === '/api/workout/locations') return gyms;
      if (url === '/api/workout/locations/active' && method === 'PUT') {
        return putResult === null ? null : { ...putResult, location_id: body.location_id };
      }
      if (url === '/api/workout/locations/active') return { location_id: activeId, location: null };
      return null;
    });
    const container = window.document.getElementById('next-workout-card');
    window._renderNextWorkout(container, NEXT);
    await vi.waitFor(() => {
      expect(window.apiCall).toHaveBeenCalledWith('/api/workout/locations', 'GET');
    });
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
    return container;
  }

  it('a set skip hides the gym switch even with gyms', async () => {
    const { window } = env;
    window.apiCall = vi.fn(async (url) => {
      if (url === '/api/workout/locations') return [{ id: 1, name: 'Home' }];
      if (url === '/api/workout/locations/active') return { location_id: 1, location: null };
      return null;
    });
    const container = window.document.getElementById('next-workout-card');
    window._renderNextWorkout(container, { ...NEXT, session: { ...NEXT.session, status: 'pre_skipped' } });
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('[data-action="undo-skip"]')).not.toBeNull();
    expect(container.querySelector('.wg-workouts-gym-switch')).toBeNull();
  });

  it('no gyms: the card has no gym switch', async () => {
    const container = await renderWithGyms(env.window, [], null);
    expect(container.querySelector('.wg-workouts-gym-switch')).toBeNull();
    expect(container.querySelector('.wg-wn .wg-card__foot')).not.toBeNull();
  });

  it('with gyms: "At:" switch preselects the active gym and PUTs a switch', async () => {
    const { window } = env;
    const container = await renderWithGyms(window, [{ id: 1, name: 'Home' }, { id: 2, name: 'Gym A' }], 1);
    const control = container.querySelector('.wg-workouts-gym-switch');
    expect(control).not.toBeNull();
    expect(control.tagName).toBe('BUTTON');
    expect(container.querySelector('select')).toBeNull();
    expect(control.textContent).toContain('At:');
    expect(control.querySelector('.wg-workouts-gym-switch__name').textContent).toBe('Home');

    control.click();
    const picker = window.document.querySelector('mt-modal.mt-confirm-modal');
    expect(picker).not.toBeNull();
    expect(picker.querySelector('.mt-confirm-modal__message').textContent).toMatch(/every workout until you change it/);
    const options = Array.from(picker.querySelectorAll('.mt-confirm-modal__choice'));
    expect(options.map((o) => o.textContent)).toEqual(['Home', 'Gym A', 'No gym']);
    expect(options[0].getAttribute('aria-pressed')).toBe('true');

    options[1].click();
    await vi.waitFor(() => {
      expect(window.apiCall).toHaveBeenCalledWith('/api/workout/locations/active', 'PUT', { location_id: 2 }, expect.anything());
    });
    await vi.waitFor(() => expect(control.querySelector('.wg-workouts-gym-switch__name').textContent).toBe('Gym A'));
    expect(window.document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
  });

  it('a failed switch keeps the chip on the previous gym', async () => {
    const { window } = env;
    window.safeToast = vi.fn();
    const container = await renderWithGyms(window, [{ id: 1, name: 'Home' }, { id: 2, name: 'Gym A' }], 1, null);
    const control = container.querySelector('.wg-workouts-gym-switch');
    control.click();
    window.document.querySelectorAll('.mt-confirm-modal__choice')[1].click();
    await vi.waitFor(() => {
      expect(window.apiCall).toHaveBeenCalledWith('/api/workout/locations/active', 'PUT', { location_id: 2 }, expect.anything());
    });
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(control.querySelector('.wg-workouts-gym-switch__name').textContent).toBe('Home');
  });
});

// med-soo0.2: the Up next card, kit WN1/WN3/WN4/WN5/WN6
// (docs/design/claude-design/ui_kits/app-v2/screens-train-timeline.html).
describe('Up next card (kit WN1-WN6)', () => {
  let env;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    env = loadFrontendEnv({ withWorkout: true });
    env.window.apiCall = vi.fn(async () => null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    env.cleanup();
    env = null;
  });

  const today = (overrides = {}) => ({
    group_name: 'Bench 100', variant_name: 'Chest & Triceps', exercises_count: 3, variant_id: 7, group_id: 3,
    is_rotating: true, exercise_names: ['Bench press', 'Dips', 'Cable fly'],
    plan: { position: 1, total: 7, next_variant_name: 'Back & Biceps', days: [] },
    ...overrides,
    session: { id: 42, status: 'notified', scheduled_date: '2026-11-04', scheduled_time: '18:00', is_today: true, ...(overrides.session || {}) },
  });
  const render = (data) => {
    const container = env.document.getElementById('next-workout-card');
    env.window._renderNextWorkout(container, data);
    return container;
  };
  const card = (c) => c.querySelector('.wg-wn');
  const footLabels = (c) => Array.from(card(c).querySelectorAll('.wg-card__foot .wg-btn')).map((b) => b.textContent);
  const action = (c, name) => c.querySelector(`[data-action="${name}"]`);
  const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0)); };

  it('WN1 today: date eyebrow with the sun dot, the day as title, exercise names, plan line, Skip today + Start workout, Start empty workout row', () => {
    const c = render(today());
    const el = card(c);
    expect(el.classList.contains('wg-card--accent')).toBe(true);
    const eyebrow = el.querySelector('.wg-eyebrow');
    expect(eyebrow.textContent).toBe('Today · 18:00');
    expect(eyebrow.classList.contains('wg-eyebrow--dot')).toBe(true);
    expect(el.querySelector('.wg-hstack .wg-meta').textContent).toBe('Bench 100');
    expect(el.querySelector('.wg-card__title').textContent).toBe('Chest & Triceps');
    expect(el.querySelector('.wg-wn__info .wg-meta').textContent).toBe('3 exercises · Bench press, Dips, Cable fly');
    expect(el.querySelector('.wg-wn-day .wg-meta').textContent).toBe('Day 1 of 7 · then Back & Biceps');
    expect(footLabels(c)).toEqual(['Skip today', 'Start workout']);
    expect(action(c, 'start').classList.contains('wg-btn--primary')).toBe(true);
    expect(action(c, 'skip').classList.contains('wg-btn--primary')).toBe(false);
    const row = c.querySelector('#workout-start-empty-row');
    expect(row.textContent).toBe('Start empty workout' + 'Add exercises as you go');
    // The row sits under the card, not in it.
    expect(el.contains(row)).toBe(false);
  });

  it('WN3 future day: plain date eyebrow (no dot), +N names, Skip <weekday> + Start now', () => {
    const c = render(today({
      session: { scheduled_date: '2026-11-06', is_today: false },
      group_name: 'Upper/Lower', variant_name: 'Lower A', exercises_count: 5,
      exercise_names: ['Squat', 'Romanian deadlift', 'Leg press'],
      plan: { position: 2, total: 4, next_variant_name: 'Upper B', days: [] },
    }));
    const eyebrow = card(c).querySelector('.wg-eyebrow');
    expect(eyebrow.textContent).toBe('Fri 06.11 · 18:00');
    expect(eyebrow.classList.contains('wg-eyebrow--dot')).toBe(false);
    expect(card(c).querySelector('.wg-wn__info .wg-meta').textContent).toBe('5 exercises · Squat, Romanian deadlift +3');
    expect(card(c).querySelector('.wg-wn-day .wg-meta').textContent).toBe('Day 2 of 4 · then Upper B');
    expect(footLabels(c)).toEqual(['Skip Fri', 'Start now']);
  });

  it('flat plan: no plan line', () => {
    const c = render(today({ is_rotating: false, plan: null }));
    expect(card(c).querySelector('.wg-wn-day')).toBeNull();
  });

  it('"Other plan day" appears only once the WN7 sheet registers, and never while skipping or running', () => {
    expect(action(render(today()), 'other-plan-day')).toBeNull();
    const pick = vi.fn();
    env.window.WorkoutNextCard.otherPlanDay = pick;
    const data = today();
    action(render(data), 'other-plan-day').click();
    expect(pick).toHaveBeenCalledWith(data);
    expect(action(render(today({ session: { status: 'pre_skipped' } })), 'other-plan-day')).toBeNull();
    expect(action(render(today({ session: { status: 'in_progress' } })), 'other-plan-day')).toBeNull();
  });

  it('snoozed: "Snoozed to HH:MM" from snoozed_until', () => {
    const until = new Date(2026, 10, 4, 18, 30);
    const c = render(today({ session: { is_snoozed: true, snoozed_until: until.toISOString() } }));
    expect(card(c).querySelector('.wg-eyebrow').textContent).toBe('Snoozed to 18:30');
  });

  it('WN4 skipping: no accent, a Skipping tag, only a plain Undo skip, no plan line; Undo skip calls cancelPreSkipWorkoutSession', () => {
    const { window } = env;
    window.cancelPreSkipWorkoutSession = vi.fn();
    const c = render(today({ session: { status: 'pre_skipped', scheduled_date: '2026-11-06', is_today: false } }));
    const el = card(c);
    expect(el.classList.contains('wg-card--accent')).toBe(false);
    expect(el.querySelector('.wg-eyebrow').classList.contains('wg-eyebrow--dot')).toBe(false);
    expect(el.querySelector('.wg-hstack .wg-tag').textContent).toBe('Skipping');
    expect(el.querySelector('.wg-wn__info .wg-meta').textContent).toBe('3 exercises · Bench press, Dips, Cable fly');
    expect(el.querySelector('.wg-wn-day')).toBeNull();
    expect(footLabels(c)).toEqual(['Undo skip']);
    expect(action(c, 'undo-skip').className).toBe('wg-btn');
    action(c, 'undo-skip').click();
    expect(window.cancelPreSkipWorkoutSession).toHaveBeenCalledWith(42);
  });

  it('WN5 in progress: "In progress · N min", Finish + Continue (primary), no Start empty workout row', () => {
    const { window } = env;
    window.showWorkoutSessionModal = vi.fn();
    const started = new Date(Date.now() - 24 * 60000 - 5000).toISOString();
    const c = render(today({ session: { id: 101, status: 'in_progress', started_at: started } }));
    expect(card(c).querySelector('.wg-eyebrow').textContent).toBe('In progress · 24 min');
    expect(footLabels(c)).toEqual(['Finish', 'Continue']);
    expect(action(c, 'continue').classList.contains('wg-btn--primary')).toBe(true);
    expect(c.querySelector('#workout-start-empty-row')).toBeNull();
    action(c, 'continue').click();
    expect(window.showWorkoutSessionModal).toHaveBeenCalledWith(101);
  });

  // The label and the handler once disagreed ("Stop" → a cancel-named
  // function); Finish must drive the completion path.
  it('WN5: Finish calls the completion API', async () => {
    const { window } = env;
    window.safeConfirm = (_msg, cb) => cb(true);
    window.loadNextWorkout = vi.fn();
    window.loadWorkoutHistoryTab = vi.fn();
    const c = render(today({ session: { id: 101, status: 'in_progress' } }));
    window.apiCall = vi.fn().mockResolvedValue({});
    action(c, 'finish').click();
    await flush();
    expect(window.apiCall).toHaveBeenCalledWith('/api/workout/sessions/status?id=101', 'PUT', { status: 'completed' });
  });

  it('an empty workout in progress shows its note (or "Workout") and an Off plan tag', () => {
    const adhoc = { group_id: -1, variant_id: -1, group_name: 'Unknown', variant_name: 'Unknown', plan: null, exercise_names: [], exercises_count: 2 };
    let c = render(today({ ...adhoc, session: { status: 'in_progress', notes: 'Gym' } }));
    expect(card(c).querySelector('.wg-card__title').textContent).toBe('Gym');
    expect(card(c).querySelector('.wg-hstack .wg-tag').textContent).toBe('Off plan');
    c = render(today({ ...adhoc, session: { status: 'in_progress' } }));
    expect(card(c).querySelector('.wg-card__title').textContent).toBe('Workout');
  });

  it('Start and Skip call the existing session handlers; the title tap opens the plan day', () => {
    const { window } = env;
    window.startWorkoutSession = vi.fn();
    window.preSkipWorkoutSession = vi.fn();
    window.openNextWorkoutEditModal = vi.fn();
    const c = render(today());
    action(c, 'start').click();
    action(c, 'skip').click();
    card(c).querySelector('.wg-wn__info').click();
    expect(window.startWorkoutSession).toHaveBeenCalledWith(42);
    expect(window.preSkipWorkoutSession).toHaveBeenCalledWith(42);
    expect(window.openNextWorkoutEditModal).toHaveBeenCalledWith(7, 3);
  });

  it('WN6 no plan: Log a workout with Make a plan + Start empty workout (primary); a saved plan drops the offer', async () => {
    const { window } = env;
    window.apiCall = vi.fn(async () => []);
    let c = render(null);
    await flush();
    const el = card(c);
    expect(el.querySelector('.wg-eyebrow').textContent).toBe('No plan yet');
    expect(el.querySelector('.wg-card__title').textContent).toBe('Log a workout');
    expect(el.querySelector('.wg-wn__info .wg-meta').textContent).toBe('Add exercises as you go. Make a plan to get reminders.');
    expect(footLabels(c)).toEqual(['Make a plan', 'Start empty workout']);
    expect(action(c, 'start-empty').classList.contains('wg-btn--primary')).toBe(true);
    expect(c.querySelector('#workout-start-empty-row')).toBeNull();

    window.apiCall = vi.fn(async (url) => (url === '/api/workout/groups' ? [{ id: 3, name: 'Push/Pull' }] : null));
    c = render({ session: null });
    await flush();
    expect(footLabels(c)).toEqual(['Start empty workout']);
    expect(card(c).querySelector('.wg-eyebrow').textContent).toBe('Nothing scheduled');
  });

  it('Make a plan switches to Plans and opens the new-plan page', () => {
    const { window } = env;
    window.switchWorkoutTab = vi.fn();
    window.openWorkoutPlanPage = vi.fn();
    action(render(null), 'make-plan').click();
    expect(window.switchWorkoutTab).toHaveBeenCalledWith('groups');
    expect(window.openWorkoutPlanPage).toHaveBeenCalledWith(null);
  });

  it('Start empty workout (row and no-plan button) starts a plain ad-hoc session, offline too', () => {
    const { window } = env;
    window.SyncManager = { isOnline: false };
    window.startAdHocWorkout = vi.fn();
    const row = render(today()).querySelector('#workout-start-empty-row');
    expect(row.disabled).toBe(false);
    row.click();
    action(render(null), 'start-empty').click();
    expect(window.startAdHocWorkout.mock.calls).toEqual([[], []]);
  });

  it('no legacy status words or labels remain in next-card.js', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'web/static/js/features/workout/next-card.js'), 'utf8');
    for (const word of ['Upcoming', 'Ready to Start', 'To Be Skipped', 'Next Day', 'Ad hoc']) {
      expect(src).not.toContain(word);
    }
  });
});
