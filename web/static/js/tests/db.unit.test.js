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

  it('BPStore supports save/sync/range query/delete lifecycle', async () => {
    const { window, cleanup } = loadDbEnv();

    try {
      const { BPStore } = window.MedTrackerDB;

      const first = await BPStore.save({ systolic: 120, diastolic: 80, measured_at: '2026-01-01T10:00:00.000Z' });
      const second = await BPStore.save({ systolic: 135, diastolic: 85, measured_at: '2026-01-02T10:00:00.000Z' });

      expect(first.localId).toBe(1);
      expect(second.localId).toBe(2);
      expect(await BPStore.getPendingCount()).toBe(2);

      await BPStore.markSynced(first.localId, 5001);
      await BPStore.markError(second.localId, 'timeout');

      const pending = await BPStore.getPending();
      expect(pending).toHaveLength(0);

      const ranged = await BPStore.getByDateRange(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T23:59:59Z'));
      expect(ranged).toHaveLength(1);
      expect(ranged[0].systolic).toBe(120);

      const all = await BPStore.getAll();
      expect(all[0].systolic).toBe(135);
      expect(all[1].systolic).toBe(120);

      await BPStore.delete(first.localId);
      const deletedFlag = await window.MedTrackerDB.db.bp_readings.get(first.localId);
      expect(deletedFlag.syncStatus).toBe('deleted');

      await BPStore.confirmDelete(first.localId);
      expect(await window.MedTrackerDB.db.bp_readings.get(first.localId)).toBeUndefined();

      await BPStore.clear();
      expect(await BPStore.getAll()).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('BPStore syncFromServer adds only unknown server ids and pending delete removes local row', async () => {
    const { window, cleanup } = loadDbEnv();

    try {
      const { BPStore } = window.MedTrackerDB;

      const local = await BPStore.save({
        systolic: 110,
        diastolic: 70,
        measured_at: '2026-01-03T10:00:00.000Z'
      });
      await BPStore.markSynced(local.localId, 10);

      const pending = await BPStore.save({
        systolic: 118,
        diastolic: 78,
        measured_at: '2026-01-04T10:00:00.000Z'
      });

      await BPStore.syncFromServer([
        { id: 10, systolic: 111, diastolic: 71, measured_at: '2026-01-03T10:00:00.000Z' },
        { id: 20, systolic: 140, diastolic: 95, measured_at: '2026-01-05T10:00:00.000Z' }
      ]);

      const all = await BPStore.getAll();
      const serverIds = all.map((item) => item.serverId).filter((value) => value !== null).sort();
      expect(serverIds).toEqual([10, 20]);

      await BPStore.delete(pending.localId);
      expect(await window.MedTrackerDB.db.bp_readings.get(pending.localId)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('WeightStore supports sync helpers and last-weight lookup', async () => {
    const { window, cleanup } = loadDbEnv();

    try {
      const { WeightStore } = window.MedTrackerDB;

      expect(await WeightStore.getLastWeight()).toBeNull();

      const first = await WeightStore.save({ weight: 80.2, measured_at: '2026-01-01T08:00:00.000Z' });
      const second = await WeightStore.save({ weight: 79.8, measured_at: '2026-01-02T08:00:00.000Z' });
      expect(await WeightStore.getPendingCount()).toBe(2);
      expect(await WeightStore.getLastWeight()).toBe(79.8);

      await WeightStore.markSynced(first.localId, 9001);
      await WeightStore.markError(second.localId, 'network');

      await WeightStore.syncFromServer([
        { id: 9001, weight: 80.2, measured_at: '2026-01-01T08:00:00.000Z' },
        { id: 9002, weight: 79.4, measured_at: '2026-01-03T08:00:00.000Z' }
      ]);

      const all = await WeightStore.getAll();
      expect(all.some((entry) => entry.serverId === 9002)).toBe(true);

      await WeightStore.delete(second.localId);
      expect((await window.MedTrackerDB.db.weight_logs.get(second.localId)).syncStatus).toBe('deleted');

      await WeightStore.confirmDelete(second.localId);
      expect(await window.MedTrackerDB.db.weight_logs.get(second.localId)).toBeUndefined();

      await WeightStore.clear();
      expect(await WeightStore.getAll()).toHaveLength(0);
    } finally {
      cleanup();
    }
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

  it('IntakeQueueStore tracks pending, errors and synced removal', async () => {
    const { window, cleanup } = loadDbEnv();

    try {
      const { IntakeQueueStore } = window.MedTrackerDB;

      const queued = await IntakeQueueStore.save({ medication_ids: [1, 2], intake_time: '2026-01-02T10:00:00.000Z' });
      expect(queued.syncStatus).toBe('pending');
      expect(await IntakeQueueStore.getPendingCount()).toBe(1);

      await IntakeQueueStore.markError(queued.localId, 'offline');
      const errored = await window.MedTrackerDB.db.intake_queue.get(queued.localId);
      expect(errored.syncStatus).toBe('error');

      await IntakeQueueStore.markSynced(queued.localId);
      expect(await window.MedTrackerDB.db.intake_queue.get(queued.localId)).toBeUndefined();

      await IntakeQueueStore.clear();
      expect(await IntakeQueueStore.getPending()).toHaveLength(0);
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

  it('ApiCache getWithMeta returns data and cachedAt on hit, null on miss', async () => {
    const { window, cleanup } = loadDbEnv();

    try {
      const { ApiCache } = window.MedTrackerDB;
      const nowSpy = vi.spyOn(window.Date, 'now').mockReturnValue(1711000000000);

      await ApiCache.set('bp', { list: [1, 2] });
      const meta = await ApiCache.getWithMeta('bp');
      expect(meta).not.toBeNull();
      expect(meta.data).toEqual({ list: [1, 2] });
      expect(meta.cachedAt).toBe(1711000000000);

      const miss = await ApiCache.getWithMeta('nonexistent');
      expect(miss).toBeNull();

      nowSpy.mockRestore();
    } finally {
      cleanup();
    }
  });

  it('food_log_queue and workout_log_queue tables exist in the db', async () => {
    const { window, cleanup } = loadDbEnv();

    try {
      const { db } = window.MedTrackerDB;
      expect(db.food_log_queue).toBeDefined();
      expect(db.workout_log_queue).toBeDefined();

      // Verify they support basic operations
      const foodId = await db.food_log_queue.add({ url: '/api/food/log', method: 'POST', body: '{}', timestamp: Date.now() });
      expect(foodId).toBe(1);

      const workoutId = await db.workout_log_queue.add({ url: '/api/workout/log', method: 'POST', body: '{}', timestamp: Date.now() });
      expect(workoutId).toBe(1);
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
