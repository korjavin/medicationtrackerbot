import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSyncEnv } from './helpers/sync-harness.js';

function makeFakeQueue(entries = []) {
  const store = [...entries];
  return {
    async toArray() { return [...store]; },
    async delete(id) {
      const idx = store.findIndex(e => e.id === id);
      if (idx !== -1) store.splice(idx, 1);
    },
    _store: store
  };
}

describe('SyncManager food and workout queue sync', () => {
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

  it('syncFoodLogQueue no-ops when db is not available', async () => {
    const { window, cleanup } = loadSyncEnv();
    try {
      // db not set on MedTrackerDB
      window.SyncManager.isOnline = true;
      await expect(window.SyncManager.syncFoodLogQueue()).resolves.toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('syncFoodLogQueue no-ops when offline', async () => {
    const { window, cleanup } = loadSyncEnv();
    try {
      window.SyncManager.isOnline = false;
      const apiSpy = vi.fn();
      window.apiCallDirect = apiSpy;
      await window.SyncManager.syncFoodLogQueue();
      expect(apiSpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('syncFoodLogQueue syncs a queued entry and deletes it on success', async () => {
    const { window, cleanup } = loadSyncEnv();
    try {
      const entry = { id: 1, url: '/api/food/log', method: 'POST', body: JSON.stringify({ name: 'Apple' }), timestamp: Date.now() };
      const fakeQueue = makeFakeQueue([entry]);
      window.MedTrackerDB.db = { food_log_queue: fakeQueue, workout_log_queue: makeFakeQueue() };

      window.apiCallDirect = vi.fn().mockResolvedValue({ id: 42 });
      const invalidateSpy = vi.fn().mockResolvedValue(undefined);
      window.DataStore = { invalidateKey: invalidateSpy };

      window.SyncManager.isOnline = true;
      vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      await window.SyncManager.syncFoodLogQueue();

      expect(window.apiCallDirect).toHaveBeenCalledWith('/api/food/log', 'POST', { name: 'Apple' });
      expect(fakeQueue._store).toHaveLength(0);
      expect(invalidateSpy).toHaveBeenCalledWith('food_log');
    } finally {
      cleanup();
    }
  });

  it('syncFoodLogQueue leaves entry in queue on failure', async () => {
    const { window, cleanup } = loadSyncEnv();
    try {
      const entry = { id: 2, url: '/api/food/log', method: 'POST', body: '{}', timestamp: Date.now() };
      const fakeQueue = makeFakeQueue([entry]);
      window.MedTrackerDB.db = { food_log_queue: fakeQueue, workout_log_queue: makeFakeQueue() };

      window.apiCallDirect = vi.fn().mockRejectedValue(new Error('network error'));
      const invalidateSpy = vi.fn();
      window.DataStore = { invalidateKey: invalidateSpy };

      window.SyncManager.isOnline = true;
      vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      await window.SyncManager.syncFoodLogQueue();

      expect(fakeQueue._store).toHaveLength(1);
      expect(invalidateSpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('syncWorkoutLogQueue syncs a queued entry and deletes it on success', async () => {
    const { window, cleanup } = loadSyncEnv();
    try {
      const entry = { id: 1, url: '/api/workout/sessions/log', method: 'POST', body: JSON.stringify({ exercise_id: 5, reps: 10 }), timestamp: Date.now() };
      const fakeQueue = makeFakeQueue([entry]);
      window.MedTrackerDB.db = { food_log_queue: makeFakeQueue(), workout_log_queue: fakeQueue };

      window.apiCallDirect = vi.fn().mockResolvedValue({ ok: true });
      const invalidateSpy = vi.fn().mockResolvedValue(undefined);
      window.DataStore = { invalidateKey: invalidateSpy };

      window.SyncManager.isOnline = true;
      vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      await window.SyncManager.syncWorkoutLogQueue();

      expect(window.apiCallDirect).toHaveBeenCalledWith('/api/workout/sessions/log', 'POST', { exercise_id: 5, reps: 10 });
      expect(fakeQueue._store).toHaveLength(0);
      expect(invalidateSpy).toHaveBeenCalledWith('workout_sessions');
    } finally {
      cleanup();
    }
  });

  it('syncWorkoutLogQueue leaves entry in queue on failure', async () => {
    const { window, cleanup } = loadSyncEnv();
    try {
      const entry = { id: 3, url: '/api/workout/sessions/log', method: 'POST', body: '{}', timestamp: Date.now() };
      const fakeQueue = makeFakeQueue([entry]);
      window.MedTrackerDB.db = { food_log_queue: makeFakeQueue(), workout_log_queue: fakeQueue };

      window.apiCallDirect = vi.fn().mockRejectedValue(new Error('timeout'));
      const invalidateSpy = vi.fn();
      window.DataStore = { invalidateKey: invalidateSpy };

      window.SyncManager.isOnline = true;
      vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      await window.SyncManager.syncWorkoutLogQueue();

      expect(fakeQueue._store).toHaveLength(1);
      expect(invalidateSpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('syncWorkoutLogQueue does not invalidate when no entries succeed', async () => {
    const { window, cleanup } = loadSyncEnv();
    try {
      // Server returns null (treated as failure)
      const entry = { id: 4, url: '/api/workout/sessions/log', method: 'POST', body: '{}', timestamp: Date.now() };
      const fakeQueue = makeFakeQueue([entry]);
      window.MedTrackerDB.db = { food_log_queue: makeFakeQueue(), workout_log_queue: fakeQueue };

      window.apiCallDirect = vi.fn().mockResolvedValue(null);
      const invalidateSpy = vi.fn();
      window.DataStore = { invalidateKey: invalidateSpy };

      window.SyncManager.isOnline = true;
      vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      await window.SyncManager.syncWorkoutLogQueue();

      expect(fakeQueue._store).toHaveLength(1);
      expect(invalidateSpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('syncFoodLogQueue handles object body (not string) without error', async () => {
    const { window, cleanup } = loadSyncEnv();
    try {
      const entry = { id: 5, url: '/api/food/log', method: 'POST', body: { name: 'Banana' }, timestamp: Date.now() };
      const fakeQueue = makeFakeQueue([entry]);
      window.MedTrackerDB.db = { food_log_queue: fakeQueue, workout_log_queue: makeFakeQueue() };

      window.apiCallDirect = vi.fn().mockResolvedValue({ id: 99 });
      window.DataStore = { invalidateKey: vi.fn().mockResolvedValue(undefined) };

      window.SyncManager.isOnline = true;
      vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      await window.SyncManager.syncFoodLogQueue();

      expect(window.apiCallDirect).toHaveBeenCalledWith('/api/food/log', 'POST', { name: 'Banana' });
      expect(fakeQueue._store).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
