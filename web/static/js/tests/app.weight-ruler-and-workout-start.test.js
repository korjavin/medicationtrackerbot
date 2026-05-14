import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

describe('app.js weight modal helpers and workout start modal flows', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  it('setWeightValue clamps weight input within [30, 300] kg bounds', () => {
    // The Wandergeek Phase 6 edit-weight modal replaced the paper-era drag
    // ruler with a simple number input plus kg/lb unit toggle. The clamp
    // helper is still used for the initial default value; verify bounds.
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.showWeightModal();
      const weightInput = document.getElementById('weight-value');

      window.setWeightValue(999);
      expect(parseFloat(weightInput.value)).toBe(300);
      window.setWeightValue(1);
      expect(parseFloat(weightInput.value)).toBe(30);
      window.setWeightValue(82.5);
      expect(parseFloat(weightInput.value)).toBe(82.5);
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

      document.getElementById('workout-start-now-btn').click();
      expect(window.switchTab).toHaveBeenCalledWith('workouts');
      expect(document.getElementById('workout-start-modal').classList.contains('hidden')).toBe(true);

      window.showWorkoutStartModal(55);
      document.getElementById('workout-start-dismiss-btn').click();
      expect(document.getElementById('workout-start-modal').classList.contains('hidden')).toBe(true);

      window.showWorkoutStartModal(55);
      window.apiCall = vi.fn().mockResolvedValue({ ok: true });
      await window.snoozeWorkout(15);
      expect(window.apiCall).toHaveBeenCalledWith('/api/workout/sessions/55/snooze', 'POST', { minutes: 15 });
      expect(alertSpy).toHaveBeenCalledWith('Snoozed for 15 minutes');

      window.showWorkoutStartModal(55);
      const skipFalseSpy = vi.spyOn(window, 'safeConfirm').mockImplementation(async (_msg, cb) => { if (cb) await cb(false); return false; });
      await window.skipWorkoutFromModal();
      expect(window.apiCall).toHaveBeenCalledTimes(1);
      skipFalseSpy.mockRestore();

      vi.spyOn(window, 'safeConfirm').mockImplementation(async (_msg, cb) => { if (cb) await cb(true); return true; });
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
      const confirmFalseSpy = vi.spyOn(window, 'safeConfirm').mockImplementation(async (_msg, cb) => { if (cb) await cb(false); return false; });
      await window.deleteWeightLog(1);
      expect(deleteSpy).not.toHaveBeenCalled();
      confirmFalseSpy.mockRestore();

      const confirmTrueSpy = vi.spyOn(window, 'safeConfirm').mockImplementation(async (_msg, cb) => { if (cb) await cb(true); return true; });
      await window.deleteWeightLog(2);
      expect(deleteSpy).toHaveBeenCalledWith(2);

      // When Telegram.showConfirm throws, the fallback now uses the in-page
      // <mt-modal>; safeConfirm is the only public surface, so we keep
      // asserting that callers go through it.
      window.Telegram.WebApp.showConfirm = vi.fn(() => {
        throw new Error('unsupported');
      });
      await window.deleteWeightLog(3);
      expect(confirmTrueSpy).toHaveBeenCalled();
      confirmTrueSpy.mockRestore();
    } finally {
      cleanup();
    }
  });
});
