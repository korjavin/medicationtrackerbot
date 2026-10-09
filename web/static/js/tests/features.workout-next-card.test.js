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

  it('no gyms: the card has no gym switch', async () => {
    const container = await renderWithGyms(env.window, [], null);
    expect(container.querySelector('.wg-workouts-gym-switch')).toBeNull();
    expect(container.querySelector('.wg-workouts-next-card__actions')).not.toBeNull();
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
