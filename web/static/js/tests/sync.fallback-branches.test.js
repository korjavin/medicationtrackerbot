import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSyncEnv } from './helpers/sync-harness.js';

describe('sync.js fallback branch coverage', () => {
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

  it('offlineAwareApiCall returns empty history list when cache is missing', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = true;
      window.apiCallDirect = vi.fn().mockRejectedValue(new Error('Network request failed'));
      window.MedTrackerDB.IntakeHistoryStore = {
        getCache: vi.fn().mockResolvedValue(null)
      };

      const result = await window.offlineAwareApiCall('/api/history', 'GET');

      expect(window.MedTrackerDB.IntakeHistoryStore.getCache).toHaveBeenCalledWith('history_7_');
      expect(result).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('offlineAwareApiCall serves workout sessions cache on network failure and null when absent', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = true;
      window.apiCallDirect = vi.fn().mockRejectedValue(new window.TypeError('fetch failed'));
      window.MedTrackerDB.WorkoutStore = {
        getCache: vi
          .fn()
          .mockResolvedValueOnce([{ id: 'sess_1' }])
          .mockResolvedValueOnce(null)
      };

      const first = await window.offlineAwareApiCall('/api/workout/sessions', 'GET');
      const second = await window.offlineAwareApiCall('/api/workout/sessions', 'GET');

      expect(first).toEqual([{ id: 'sess_1' }]);
      expect(second).toBeNull();
      expect(window.MedTrackerDB.WorkoutStore.getCache).toHaveBeenNthCalledWith(1, 'sessions');
      expect(window.MedTrackerDB.WorkoutStore.getCache).toHaveBeenNthCalledWith(2, 'sessions');
    } finally {
      cleanup();
    }
  });

  it('offlineAwareApiCall treats reverse-proxy 5xx as network failure and falls back to local BP data', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = true;
      window.apiCallDirect = vi.fn().mockRejectedValue(new Error('502 Bad Gateway'));
      window.MedTrackerDB.BPStore.getAll = vi.fn().mockResolvedValue([
        { localId: 3, serverId: null, systolic: 150, syncStatus: 'pending' }
      ]);

      const result = await window.offlineAwareApiCall('/api/bp?days=7', 'GET');

      expect(window.MedTrackerDB.BPStore.getAll).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        {
          id: 'local_3',
          localId: 3,
          serverId: null,
          systolic: 150,
          syncStatus: 'pending',
          isLocal: true
        }
      ]);
    } finally {
      cleanup();
    }
  });

  it('offlineAwareApiCall rethrows non-network write errors', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = true;
      window.apiCallDirect = vi.fn().mockRejectedValue(new Error('Validation failed'));

      await expect(window.offlineAwareApiCall('/api/bp', 'POST', { systolic: 140 }))
        .rejects
        .toThrow('Validation failed');
    } finally {
      cleanup();
    }
  });

  it('registerBackgroundSync swallows registration errors and no-ops when unsupported', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      Object.defineProperty(window.navigator, 'serviceWorker', {
        configurable: true,
        value: {
          ready: Promise.resolve({
            sync: {
              register: vi.fn().mockRejectedValue(new Error('sync unavailable'))
            }
          })
        }
      });

      await expect(window.SyncManager.registerBackgroundSync('sync-weight-logs')).resolves.toBeUndefined();
      expect(consoleLogSpy).toHaveBeenCalledWith('[Sync] Background sync not available:', expect.any(Error));

      Object.defineProperty(window.navigator, 'serviceWorker', {
        configurable: true,
        value: undefined
      });

      await expect(window.SyncManager.registerBackgroundSync('sync-bp-readings')).resolves.toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
