import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDbEnv } from './helpers/db-harness.js';
import { allowConsoleNoise, getGlobalSpies } from './helpers/setup.js';

describe('db.js store behavior', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('MedicationStore respects TTL and clears expired cache', async () => {
    const { window, cleanup } = loadDbEnv();

    try {
      const { MedicationStore } = window.MedTrackerDB;
      const nowSpy = vi.spyOn(window.Date, 'now').mockReturnValue(Date.parse('2026-01-01T00:00:00.000Z'));

      await MedicationStore.saveCache([{ id: 1, name: 'Aspirin' }]);
      expect(await MedicationStore.isCacheValid()).toBe(true);
      expect(await MedicationStore.getCache()).toEqual([{ id: 1, name: 'Aspirin' }]);

      nowSpy.mockReturnValue(Date.parse('2026-01-09T00:00:00.000Z'));
      expect(await MedicationStore.getCache()).toBeNull();
      expect(await MedicationStore.isCacheValid()).toBe(false);

      await MedicationStore.saveCache([{ id: 2, name: 'Magnesium' }]);
      await MedicationStore.clearCache();
      expect(await MedicationStore.getCache()).toBeNull();
      nowSpy.mockRestore();
    } finally {
      cleanup();
    }
  });

  it('IntakeHistoryStore and WorkoutStore expire stale cache entries', async () => {
    const { window, cleanup } = loadDbEnv();

    try {
      const { IntakeHistoryStore, WorkoutStore } = window.MedTrackerDB;
      const nowSpy = vi.spyOn(window.Date, 'now').mockReturnValue(Date.parse('2026-01-01T10:00:00.000Z'));

      await IntakeHistoryStore.saveCache('history_week', [{ id: 1 }]);
      await WorkoutStore.saveCache('workouts_week', [{ id: 'w1' }]);

      expect(await IntakeHistoryStore.getCache('history_week')).toEqual([{ id: 1 }]);
      expect(await WorkoutStore.getCache('workouts_week')).toEqual([{ id: 'w1' }]);

      nowSpy.mockReturnValue(Date.parse('2026-01-01T10:31:00.000Z'));
      expect(await IntakeHistoryStore.getCache('history_week')).toBeNull();
      expect(await WorkoutStore.getCache('workouts_week')).toBeNull();

      await IntakeHistoryStore.clearCache();
      await WorkoutStore.clearCache();
      nowSpy.mockRestore();
    } finally {
      cleanup();
    }
  });

  it('FoodProductsStore returns null for expired cache', async () => {
    const { window, cleanup } = loadDbEnv();

    try {
      const { FoodProductsStore } = window.MedTrackerDB;
      const nowSpy = vi.spyOn(window.Date, 'now').mockReturnValue(Date.parse('2026-01-01T00:00:00.000Z'));

      await FoodProductsStore.saveCache([{ id: 7, name: 'Apple' }]);
      expect(await FoodProductsStore.getCache()).toEqual([{ id: 7, name: 'Apple' }]);

      nowSpy.mockReturnValue(Date.parse('2026-01-10T00:00:00.000Z'));
      expect(await FoodProductsStore.getCache()).toBeNull();

      await FoodProductsStore.saveCache([{ id: 8, name: 'Orange' }]);
      await FoodProductsStore.clearCache();
      expect(await FoodProductsStore.getCache()).toBeNull();
      nowSpy.mockRestore();
    } finally {
      cleanup();
    }
  });

  it('ApiCache get/set/clear work and tolerate storage failures', async () => {
    const { window, cleanup } = loadDbEnv();

    try {
      const { ApiCache } = window.MedTrackerDB;

      await ApiCache.set('bp::week', { list: [1, 2] });
      expect(await ApiCache.get('bp::week')).toEqual({ list: [1, 2] });

      await ApiCache.clear('bp::week');
      expect(await ApiCache.get('bp::week')).toBeNull();

      await ApiCache.set('shared::one', { value: 1 });
      await ApiCache.set('shared::two', { value: 2 });
      await ApiCache.clear();
      expect(await ApiCache.get('shared::one')).toBeNull();
      expect(await ApiCache.get('shared::two')).toBeNull();

      const failingStore = {
        async get() { throw new Error('boom-get'); },
        async put() { throw new Error('boom-put'); },
        async delete() { throw new Error('boom-del'); },
        async clear() { throw new Error('boom-clear'); }
      };
      window.MedTrackerDB.db.api_cache = failingStore;

      await expect(ApiCache.get('x')).resolves.toBeNull();
      await expect(ApiCache.set('x', { ok: true })).resolves.toBeUndefined();
      await expect(ApiCache.clear('x')).resolves.toBeUndefined();
      await expect(ApiCache.clear()).resolves.toBeUndefined();
      expect(getGlobalSpies().warnSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
