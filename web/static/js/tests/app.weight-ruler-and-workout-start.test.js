import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('app.js weight ruler and workout start modal flows', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('weight ruler supports mouse/touch dragging and updates value', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const container = document.getElementById('weight-ruler-container');
      Object.defineProperty(container, 'clientWidth', { configurable: true, value: 320 });

      window.showWeightModal();
      const weightInput = document.getElementById('weight-value');
      const initial = parseFloat(weightInput.value);

      window.handleDragStart({ type: 'mousedown', clientX: 200 });
      window.handleDragMove({ type: 'mousemove', clientX: 160 });
      window.handleDragEnd({});
      const afterMouse = parseFloat(weightInput.value);
      expect(afterMouse).toBeGreaterThan(initial);

      const preventStart = vi.fn();
      const preventMove = vi.fn();
      window.handleDragStart({ type: 'touchstart', touches: [{ clientX: 200 }], preventDefault: preventStart });
      window.handleDragMove({ type: 'touchmove', touches: [{ clientX: 240 }], preventDefault: preventMove });
      window.handleDragEnd({});
      const afterTouch = parseFloat(weightInput.value);
      expect(afterTouch).toBeLessThan(afterMouse);
      expect(preventStart).toHaveBeenCalled();
      expect(preventMove).toHaveBeenCalled();

      window.setWeightValue(999);
      expect(parseFloat(weightInput.value)).toBe(300);
      window.setWeightValue(1);
      expect(parseFloat(weightInput.value)).toBe(30);
    } finally {
      cleanup();
    }
  });

  it('workout start modal supports start, snooze and skip actions', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const alertSpy = vi.fn();
      window.Telegram.WebApp.showAlert = alertSpy;
      window.loadWorkouts = vi.fn();
      window.switchTab = vi.fn();

      window.showWorkoutStartModal(55);
      expect(document.getElementById('workout-start-modal').classList.contains('hidden')).toBe(false);

      window.startWorkoutFromModal();
      expect(window.switchTab).toHaveBeenCalledWith('workouts');
      expect(document.getElementById('workout-start-modal').classList.contains('hidden')).toBe(true);

      window.showWorkoutStartModal(55);
      window.apiCall = vi.fn().mockResolvedValue({ ok: true });
      await window.snoozeWorkout(15);
      expect(window.apiCall).toHaveBeenCalledWith('/api/workout/sessions/55/snooze', 'POST', { minutes: 15 });
      expect(alertSpy).toHaveBeenCalledWith('Snoozed for 15 minutes');

      window.showWorkoutStartModal(55);
      window.confirm = vi.fn().mockReturnValue(false);
      await window.skipWorkoutFromModal();
      expect(window.apiCall).toHaveBeenCalledTimes(1);

      window.confirm = vi.fn().mockReturnValue(true);
      window.apiCall = vi.fn().mockResolvedValue({ ok: true });
      await window.skipWorkoutFromModal();
      expect(window.apiCall).toHaveBeenCalledWith('/api/workout/sessions/55/skip', 'POST');
      expect(alertSpy).toHaveBeenCalledWith('Workout skipped');
      expect(window.loadWorkouts).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('weight delete API handles local and remote ids with cache invalidation', async () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      const confirmDeleteSpy = vi.fn().mockResolvedValue(undefined);
      const updateStatusSpy = vi.fn();
      const loadWeightSpy = vi.fn();
      const invalidateSpy = vi.fn().mockResolvedValue(undefined);

      window.MedTrackerDB = { WeightStore: { confirmDelete: confirmDeleteSpy } };
      window.SyncManager = { updateStatus: updateStatusSpy };
      window.loadWeightLogs = loadWeightSpy;
      window.DataStore.invalidateTags = invalidateSpy;
      window.DataStore.invalidateKey = vi.fn().mockResolvedValue(undefined);
      window.apiCall = vi.fn().mockResolvedValue({ ok: true });

      await window._deleteWeightApi('local_12');
      expect(confirmDeleteSpy).toHaveBeenCalledWith(12);
      expect(updateStatusSpy).toHaveBeenCalled();
      expect(loadWeightSpy).toHaveBeenCalled();

      await window._deleteWeightApi(42);
      expect(window.apiCall).toHaveBeenCalledWith('/api/weight/42', 'DELETE');
      expect(invalidateSpy).toHaveBeenCalledWith(['weight']);
    } finally {
      cleanup();
    }
  });

  it('deleteWeightLog respects confirm path and falls back from Telegram confirm errors', async () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      const deleteSpy = vi.spyOn(window, '_deleteWeightApi').mockResolvedValue(undefined);
      window.confirm = vi.fn().mockReturnValue(false);
      window.deleteWeightLog(1);
      expect(deleteSpy).not.toHaveBeenCalled();

      window.confirm = vi.fn().mockReturnValue(true);
      window.deleteWeightLog(2);
      expect(deleteSpy).toHaveBeenCalledWith(2);

      window.Telegram.WebApp.showConfirm = vi.fn(() => {
        throw new Error('unsupported');
      });
      window.deleteWeightLog(3);
      expect(window.confirm).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
