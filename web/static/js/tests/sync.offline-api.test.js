import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSyncEnv } from './helpers/sync-harness.js';

describe('sync.js offlineAwareApiCall behavior', () => {
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

  it('uses offline BP write flow when offline', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = false;
      const saveSpy = vi.fn().mockResolvedValue({ localId: 42 });
      window.MedTrackerDB.BPStore.save = saveSpy;

      const registerSpy = vi.spyOn(window.SyncManager, 'registerBackgroundSync').mockResolvedValue(undefined);
      const toastSpy = vi.spyOn(window.SyncManager, 'showToast').mockImplementation(() => {});
      const updateSpy = vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      const payload = {
        measured_at: '2026-02-27T10:00:00Z',
        systolic: 125,
        diastolic: 82
      };

      const result = await window.offlineAwareApiCall('/api/bp', 'POST', payload);

      expect(saveSpy).toHaveBeenCalledWith(payload);
      expect(registerSpy).toHaveBeenCalledWith('sync-bp-readings');
      expect(toastSpy).toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalled();
      expect(result).toMatchObject({ id: 'local_42', localId: 42, isLocal: true, systolic: 125 });
    } finally {
      cleanup();
    }
  });

  it('returns null for unsupported offline write endpoints', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = false;
      const result = await window.offlineAwareApiCall('/api/unknown', 'POST', { a: 1 });
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('falls back to offline history cache on network error for GET /api/history', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = true;
      window.apiCallDirect = vi.fn().mockRejectedValue(new window.TypeError('fetch failed'));
      const history = [{ id: 1 }, { id: 2 }];
      const getCacheSpy = vi.fn().mockResolvedValue(history);
      window.MedTrackerDB.IntakeHistoryStore = { getCache: getCacheSpy };

      const result = await window.offlineAwareApiCall('/api/history?days=3&med_id=9', 'GET');

      expect(getCacheSpy).toHaveBeenCalledWith('history_3_9');
      expect(result).toEqual(history);
    } finally {
      cleanup();
    }
  });

  it('falls back to offline workout cache on network error for workout endpoints', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = true;
      window.apiCallDirect = vi.fn().mockRejectedValue(new Error('Network request failed'));
      const getCacheSpy = vi.fn().mockResolvedValue([{ id: 11 }]);
      window.MedTrackerDB.WorkoutStore = { getCache: getCacheSpy };

      const result = await window.offlineAwareApiCall('/api/workout/groups', 'GET');

      expect(getCacheSpy).toHaveBeenCalledWith('groups');
      expect(result).toEqual([{ id: 11 }]);
    } finally {
      cleanup();
    }
  });

  it('returns null for unsupported GET endpoint on network error', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = true;
      window.apiCallDirect = vi.fn().mockRejectedValue(new window.TypeError('fetch failed'));

      const result = await window.offlineAwareApiCall('/api/health/overview', 'GET');
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('falls back to offline intake write on network error for confirm-schedule', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = true;
      window.apiCallDirect = vi.fn().mockRejectedValue(new Error('Network request failed'));

      const saveSpy = vi.fn().mockResolvedValue({ localId: 77 });
      window.MedTrackerDB.IntakeQueueStore.save = saveSpy;

      const registerSpy = vi.spyOn(window.SyncManager, 'registerBackgroundSync').mockResolvedValue(undefined);
      const updateSpy = vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      const payload = {
        scheduled_at: '2026-02-27T12:00:00Z',
        medication_ids: [1, 2],
        intake_ids: [10, 20]
      };

      const result = await window.offlineAwareApiCall('/api/medications/confirm-schedule', 'POST', payload);

      expect(saveSpy).toHaveBeenCalled();
      expect(registerSpy).toHaveBeenCalledWith('sync-intake-logs');
      expect(updateSpy).toHaveBeenCalled();
      expect(result).toMatchObject({ id: 'local_77', localId: 77, isLocal: true });
    } finally {
      cleanup();
    }
  });

  it('uses offline weight write flow when offline', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = false;
      const saveSpy = vi.fn().mockResolvedValue({ localId: 9 });
      window.MedTrackerDB.WeightStore.save = saveSpy;

      const registerSpy = vi.spyOn(window.SyncManager, 'registerBackgroundSync').mockResolvedValue(undefined);
      const toastSpy = vi.spyOn(window.SyncManager, 'showToast').mockImplementation(() => {});
      const updateSpy = vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      const payload = {
        measured_at: '2026-02-27T11:00:00Z',
        weight: 79.8,
        notes: 'offline'
      };

      const result = await window.offlineAwareApiCall('/api/weight', 'POST', payload);

      expect(saveSpy).toHaveBeenCalledWith(payload);
      expect(registerSpy).toHaveBeenCalledWith('sync-weight-logs');
      expect(toastSpy).toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalled();
      expect(result).toMatchObject({ id: 'local_9', localId: 9, isLocal: true, weight: 79.8 });
    } finally {
      cleanup();
    }
  });

  it('falls back to offline BP/weight writes on network errors while online', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = true;
      window.apiCallDirect = vi.fn()
        .mockRejectedValueOnce(new Error('Network request failed'))
        .mockRejectedValueOnce(new Error('Failed to fetch'));

      window.MedTrackerDB.BPStore.save = vi.fn().mockResolvedValue({ localId: 31 });
      window.MedTrackerDB.WeightStore.save = vi.fn().mockResolvedValue({ localId: 32 });
      const registerSpy = vi.spyOn(window.SyncManager, 'registerBackgroundSync').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      const bpRes = await window.offlineAwareApiCall('/api/bp', 'POST', { systolic: 140, diastolic: 90 });
      const weightRes = await window.offlineAwareApiCall('/api/weight', 'POST', { weight: 80.4 });

      expect(bpRes).toMatchObject({ localId: 31, isLocal: true });
      expect(weightRes).toMatchObject({ localId: 32, isLocal: true });
      expect(registerSpy).toHaveBeenCalledWith('sync-bp-readings');
      expect(registerSpy).toHaveBeenCalledWith('sync-weight-logs');
    } finally {
      cleanup();
    }
  });

  it('falls back to offline weight reads on network error for GET /api/weight', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = true;
      window.apiCallDirect = vi.fn().mockRejectedValue(new Error('503 Service Unavailable'));
      window.MedTrackerDB.WeightStore.getAll = vi.fn().mockResolvedValue([
        { localId: 3, serverId: null, weight: 77.7, syncStatus: 'pending' },
        { localId: 4, serverId: 44, weight: 76.9, syncStatus: 'synced' }
      ]);

      const result = await window.offlineAwareApiCall('/api/weight?days=35', 'GET');

      expect(result).toEqual([
        { id: 'local_3', localId: 3, serverId: null, weight: 77.7, syncStatus: 'pending', isLocal: true },
        { id: 44, localId: 4, serverId: 44, weight: 76.9, syncStatus: 'synced', isLocal: false }
      ]);
    } finally {
      cleanup();
    }
  });

  it('returns network result directly when request succeeds', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = true;
      window.apiCallDirect = vi.fn().mockResolvedValue({ ok: true, value: 1 });

      const result = await window.offlineAwareApiCall('/api/something', 'GET');

      expect(window.apiCallDirect).toHaveBeenCalledWith('/api/something', 'GET', null);
      expect(result).toEqual({ ok: true, value: 1 });
    } finally {
      cleanup();
    }
  });

  it('queues food log POST to food_log_queue when offline', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = false;

      const addedEntries = [];
      window.MedTrackerDB.db = {
        food_log_queue: {
          async add(entry) { addedEntries.push(entry); return addedEntries.length; }
        }
      };

      const registerSpy = vi.spyOn(window.SyncManager, 'registerBackgroundSync').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'showToast').mockImplementation(() => {});
      vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      const payload = { name: 'Apple', calories: 52 };
      const result = await window.offlineAwareApiCall('/api/food/log', 'POST', payload);

      expect(addedEntries).toHaveLength(1);
      expect(addedEntries[0].url).toBe('/api/food/log');
      expect(addedEntries[0].method).toBe('POST');
      expect(JSON.parse(addedEntries[0].body)).toEqual(payload);
      expect(registerSpy).toHaveBeenCalledWith('sync-food-logs');
      expect(result).toMatchObject({ isLocal: true, queued: true });
    } finally {
      cleanup();
    }
  });

  it('queues food log DELETE to food_log_queue when offline', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = false;

      const addedEntries = [];
      window.MedTrackerDB.db = {
        food_log_queue: {
          async add(entry) { addedEntries.push(entry); return addedEntries.length; }
        }
      };

      vi.spyOn(window.SyncManager, 'registerBackgroundSync').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'showToast').mockImplementation(() => {});
      vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      const result = await window.offlineAwareApiCall('/api/food/log/5', 'DELETE', null);

      expect(addedEntries).toHaveLength(1);
      expect(addedEntries[0].url).toBe('/api/food/log/5');
      expect(addedEntries[0].method).toBe('DELETE');
      expect(result).toMatchObject({ isLocal: true, queued: true });
    } finally {
      cleanup();
    }
  });

  it('queues food log POST to food_log_queue on network error (online but connection fails)', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = true;
      window.apiCallDirect = vi.fn().mockRejectedValue(new window.TypeError('fetch failed'));

      const addedEntries = [];
      window.MedTrackerDB.db = {
        food_log_queue: {
          async add(entry) { addedEntries.push(entry); return addedEntries.length; }
        }
      };

      vi.spyOn(window.SyncManager, 'registerBackgroundSync').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'showToast').mockImplementation(() => {});
      vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      const payload = { name: 'Banana', calories: 89 };
      const result = await window.offlineAwareApiCall('/api/food/log', 'POST', payload);

      expect(addedEntries).toHaveLength(1);
      expect(result).toMatchObject({ isLocal: true, queued: true });
    } finally {
      cleanup();
    }
  });

  it('queues workout exercise log POST to workout_log_queue when offline', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = false;

      const addedEntries = [];
      window.MedTrackerDB.db = {
        workout_log_queue: {
          async add(entry) { addedEntries.push(entry); return addedEntries.length; }
        }
      };

      vi.spyOn(window.SyncManager, 'registerBackgroundSync').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'showToast').mockImplementation(() => {});
      vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      const payload = { session_id: 1, exercise_id: 5, target_sets: 3, target_reps_min: 10, status: 'completed' };
      const result = await window.offlineAwareApiCall('/api/workout/sessions/logs/create', 'POST', payload);

      expect(addedEntries).toHaveLength(1);
      expect(addedEntries[0].url).toBe('/api/workout/sessions/logs/create');
      expect(addedEntries[0].method).toBe('POST');
      expect(JSON.parse(addedEntries[0].body)).toEqual(payload);
      expect(result).toMatchObject({ isLocal: true, queued: true });
    } finally {
      cleanup();
    }
  });

  it('queues workout exercise log to workout_log_queue on network error', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = true;
      window.apiCallDirect = vi.fn().mockRejectedValue(new window.TypeError('fetch failed'));

      const addedEntries = [];
      window.MedTrackerDB.db = {
        workout_log_queue: {
          async add(entry) { addedEntries.push(entry); return addedEntries.length; }
        }
      };

      vi.spyOn(window.SyncManager, 'registerBackgroundSync').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'showToast').mockImplementation(() => {});
      vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      const payload = { id: 7, sets_completed: 3, reps_completed: 10, weight_kg: 50 };
      const result = await window.offlineAwareApiCall('/api/workout/sessions/logs/update', 'POST', payload);

      expect(addedEntries).toHaveLength(1);
      expect(result).toMatchObject({ isLocal: true, queued: true });
    } finally {
      cleanup();
    }
  });

  it('queues preskip to workout_log_queue when offline', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = false;

      const addedEntries = [];
      window.MedTrackerDB.db = {
        workout_log_queue: {
          async add(entry) { addedEntries.push(entry); return addedEntries.length; }
        }
      };

      vi.spyOn(window.SyncManager, 'registerBackgroundSync').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'showToast').mockImplementation(() => {});
      vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      const result = await window.offlineAwareApiCall('/api/workout/sessions/42/preskip', 'POST', null);

      expect(addedEntries).toHaveLength(1);
      expect(addedEntries[0].url).toBe('/api/workout/sessions/42/preskip');
      expect(result).toMatchObject({ isLocal: true, queued: true });
    } finally {
      cleanup();
    }
  });
});
