import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

describe('workout.js loaders and next-card behavior', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  it('loadNextWorkout drives SWR callbacks and next workout card renders by status', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const nextCard = document.getElementById('next-workout-card');
      const nextData = {
        session: {
          id: 91,
          status: 'in_progress',
          scheduled_date: new Date().toISOString(),
          scheduled_time: '09:00'
        },
        group_name: 'Push',
        variant_name: 'A',
        exercises_count: 6,
        is_rotating: true,
        variant_id: 5,
        group_id: 2
      };

      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onCached(null);
        await options.onFresh(nextData);
      });

      await window.loadNextWorkout();
      expect(window.DataStore.loadSWR).toHaveBeenCalled();
      expect(nextCard.innerHTML).toContain('In Progress');
      expect(nextCard.innerHTML).toContain('View');

      window._renderNextWorkout(nextCard, {
        ...nextData,
        session: { ...nextData.session, status: 'pre_skipped' }
      });
      expect(nextCard.innerHTML).toContain('To Be Skipped');
      expect(nextCard.innerHTML).toContain('Cancel Skip');

      window._renderNextWorkout(nextCard, {
        ...nextData,
        session: { ...nextData.session, status: 'notified' }
      });
      expect(nextCard.innerHTML).toContain('Ready to Start');
      expect(nextCard.innerHTML).toContain('>Start<');

      // med-2fc: no session no longer empties the container — the card
      // survives carrying the Ad hoc action alone, because it is the
      // only ad-hoc entry point on the Workouts screen.
      window._renderNextWorkout(nextCard, null);
      expect(nextCard.querySelector('.wg-workouts-next-card')).not.toBeNull();
      expect(nextCard.innerHTML).toContain('Ad hoc');
      expect(nextCard.innerHTML).not.toContain('>Start<');
      expect(nextCard.innerHTML).not.toContain('Ready to Start');
    } finally {
      cleanup();
    }
  });

  // med-2fc: the ad-hoc CTA used to be static markup in index.html, so an
  // empty next-workout container was harmless. Now Ad hoc is rendered
  // only by _renderNextWorkout, and a read failure with nothing cached would
  // otherwise strip the screen's only way to start a workout.
  it('loadNextWorkout keeps the Ad hoc card when the read fails with no cache', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const nextCard = document.getElementById('next-workout-card');
      nextCard.innerHTML = '<div>stale</div>';

      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onError(new Error('offline'), null);
      });

      await window.loadNextWorkout();

      expect(nextCard.querySelector('.wg-workouts-next-card')).not.toBeNull();
      expect(nextCard.innerHTML).toContain('Ad hoc');
      expect(nextCard.innerHTML).not.toContain('stale');
    } finally {
      cleanup();
    }
  });

  it('nextWorkoutVariant handles success and failure paths', async () => {
    const { window, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const loadNextSpy = vi.spyOn(window, 'loadNextWorkout').mockResolvedValue(undefined);
      const toastSpy = vi.fn();
      window.safeToast = toastSpy;

      window.apiCall = vi.fn().mockResolvedValue({ ok: true });
      await window.nextWorkoutVariant(33);
      expect(window.apiCall).toHaveBeenCalledWith('/api/workout/sessions/33/next-variant', 'POST');
      expect(loadNextSpy).toHaveBeenCalled();

      window.apiCall = vi.fn().mockRejectedValue(new Error('nope'));
      await window.nextWorkoutVariant(34);
      expect(toastSpy).toHaveBeenCalledWith('Failed to switch day. Please try again.', 'error');
    } finally {
      cleanup();
    }
  });

  it('opening a flat plan with no Day only reads — the "Main" Day is created on Save, not on open', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      window.WorkoutEdit.cachedGroups = [{
        id: 7,
        name: 'Strength',
        description: '',
        is_rotating: false,
        days_of_week: JSON.stringify([1, 3, 5]),
        scheduled_time: '08:30',
        notification_advance_minutes: 15,
        active: true
      }];
      window.apiCall = vi.fn().mockResolvedValueOnce([]);

      await window.openWorkoutPlanPage(7);

      expect(window.apiCall).toHaveBeenCalledTimes(1);
      expect(window.apiCall).toHaveBeenCalledWith('/api/workout/variants?group_id=7');
      expect(document.getElementById('workout-group-flat-exercises-section').hidden).toBe(false);
      expect(document.getElementById('workout-group-flat-exercises-list').textContent).toContain('No exercises yet');
      expect(window.WorkoutEdit.planDraft.days).toHaveLength(1);
      expect(window.WorkoutEdit.planDraft.days[0]).toMatchObject({ id: null, name: 'Main', implicit: true });
    } finally {
      cleanup();
    }
  });

  it('the Plan and Day pages show empty states; a failed read opens nothing and says so', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      window.WorkoutEdit.cachedGroups = [{ id: 9, name: 'Split', is_rotating: true, active: true }, { id: 10, name: 'Gone', is_rotating: true }];
      window.apiCall = vi.fn().mockResolvedValueOnce([]);
      await window.openWorkoutPlanPage(9);
      expect(document.getElementById('workout-variants-list').textContent).toContain('No days yet');

      window.addWorkoutPlanDay();
      expect(document.getElementById('workout-exercises-list').textContent).toContain('No exercises yet');
      window.WorkoutEdit.dayTarget.page.close();
      window.closeWorkoutPlanPage();

      const toastSpy = vi.fn();
      window.safeToast = toastSpy;
      window.apiCall = vi.fn().mockResolvedValueOnce(null); // offline / 5xx
      expect(await window.openWorkoutPlanPage(10)).toBeNull();
      expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('Couldn\'t load'), 'error');
      expect(window.WorkoutEdit.planDraft).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('bindWorkoutControls wires workout buttons and day/session selectors', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      expect(window.WorkoutEdit.planDraft).toBeNull();

      document.getElementById('add-workout-group-btn').click();
      await vi.waitFor(() => expect(window.WorkoutEdit.planDraft).not.toBeNull());

      const monday = document.querySelector('[data-workout-page="plan"] .wg-picks > .wg-pick[data-day="1"]');
      monday.click();
      expect(monday.getAttribute('aria-pressed')).toBe('true');
      monday.click();
      expect(monday.getAttribute('aria-pressed')).toBe('false');

      // A goal seg tap writes the hidden input.
      document.querySelector('[data-seg-for="workout-group-goal"] [data-value="strength"]').click();
      expect(document.getElementById('workout-group-goal').value).toBe('strength');

      window.safeConfirm = vi.fn(async () => true);
      Array.from(document.querySelectorAll('mt-modal.wg-page[id^="wg-page-"] .wg-back')).pop().click();
      await vi.waitFor(() => expect(window.WorkoutEdit.planDraft).toBeNull());

      const onSelectSpy = vi.spyOn(window, 'onSessionExerciseSelect').mockImplementation(() => {});
      const input = document.getElementById('session-add-exercise-name');
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
      expect(onSelectSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
