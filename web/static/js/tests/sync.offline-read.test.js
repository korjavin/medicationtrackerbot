import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSyncEnv } from './helpers/sync-harness.js';

// Verifies that the refactored handleOfflineBPRead / handleOfflineWeightRead
// (now thin forwarders to BPSync.handleOfflineRead() / WeightSync.handleOfflineRead())
// produce the same payload shape that the pre-factory implementations did:
// { id: serverId || `local_${localId}`, ...row, isLocal: !serverId }.

describe('sync.js offline-read handlers (factory-backed)', () => {
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

  it('handleOfflineBPRead returns mapped rows with id/isLocal flags', async () => {
    const { window, cleanup } = loadSyncEnv();
    try {
      window.SyncManager.isOnline = true;
      window.apiCallDirect = vi.fn().mockRejectedValue(new Error('Network request failed'));
      window.MedTrackerDB.BPStore.getAll = vi.fn().mockResolvedValue([
        { localId: 1, serverId: null, systolic: 120, diastolic: 80, syncStatus: 'pending' },
        { localId: 2, serverId: 555, systolic: 130, diastolic: 85, syncStatus: 'synced' }
      ]);

      const result = await window.offlineAwareApiCall('/api/bp?days=7', 'GET');

      expect(result).toEqual([
        { id: 'local_1', localId: 1, serverId: null, systolic: 120, diastolic: 80, syncStatus: 'pending', isLocal: true },
        { id: 555, localId: 2, serverId: 555, systolic: 130, diastolic: 85, syncStatus: 'synced', isLocal: false }
      ]);
    } finally {
      cleanup();
    }
  });

  it('handleOfflineWeightRead returns mapped rows with id/isLocal flags', async () => {
    const { window, cleanup } = loadSyncEnv();
    try {
      window.SyncManager.isOnline = true;
      window.apiCallDirect = vi.fn().mockRejectedValue(new Error('Network request failed'));
      window.MedTrackerDB.WeightStore.getAll = vi.fn().mockResolvedValue([
        { localId: 3, serverId: null, weight: 77.7, syncStatus: 'pending' },
        { localId: 4, serverId: 44, weight: 76.9, syncStatus: 'synced' }
      ]);

      const result = await window.offlineAwareApiCall('/api/weight?days=30', 'GET');

      expect(result).toEqual([
        { id: 'local_3', localId: 3, serverId: null, weight: 77.7, syncStatus: 'pending', isLocal: true },
        { id: 44, localId: 4, serverId: 44, weight: 76.9, syncStatus: 'synced', isLocal: false }
      ]);
    } finally {
      cleanup();
    }
  });

  it('handleOfflineBPRead returns empty array when store has no rows', async () => {
    const { window, cleanup } = loadSyncEnv();
    try {
      window.SyncManager.isOnline = true;
      window.apiCallDirect = vi.fn().mockRejectedValue(new Error('Network request failed'));
      window.MedTrackerDB.BPStore.getAll = vi.fn().mockResolvedValue([]);

      const result = await window.offlineAwareApiCall('/api/bp', 'GET');

      expect(result).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('handleOfflineWeightRead returns empty array when store has no rows', async () => {
    const { window, cleanup } = loadSyncEnv();
    try {
      window.SyncManager.isOnline = true;
      window.apiCallDirect = vi.fn().mockRejectedValue(new Error('Network request failed'));
      window.MedTrackerDB.WeightStore.getAll = vi.fn().mockResolvedValue([]);

      const result = await window.offlineAwareApiCall('/api/weight', 'GET');

      expect(result).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('history reads are NOT routed through the factory (still hit IntakeHistoryStore.getCache)', async () => {
    const { window, cleanup } = loadSyncEnv();
    try {
      window.SyncManager.isOnline = true;
      window.apiCallDirect = vi.fn().mockRejectedValue(new window.TypeError('fetch failed'));
      const historyRows = [{ id: 1 }, { id: 2 }];
      const getCacheSpy = vi.fn().mockResolvedValue(historyRows);
      window.MedTrackerDB.IntakeHistoryStore = { getCache: getCacheSpy };
      // Should NOT touch any pending-write store.
      const bpGetAllSpy = vi.spyOn(window.MedTrackerDB.BPStore, 'getAll');

      const result = await window.offlineAwareApiCall('/api/history?days=3&med_id=9', 'GET');

      expect(getCacheSpy).toHaveBeenCalledWith('history_3_9');
      expect(bpGetAllSpy).not.toHaveBeenCalled();
      expect(result).toEqual(historyRows);
    } finally {
      cleanup();
    }
  });

  it('workout reads are NOT routed through the factory (still hit WorkoutStore.getCache)', async () => {
    const { window, cleanup } = loadSyncEnv();
    try {
      window.SyncManager.isOnline = true;
      window.apiCallDirect = vi.fn().mockRejectedValue(new Error('Network request failed'));
      const getCacheSpy = vi.fn().mockResolvedValue([{ id: 22, name: 'pull' }]);
      window.MedTrackerDB.WorkoutStore = { getCache: getCacheSpy };

      const result = await window.offlineAwareApiCall('/api/workout/sessions', 'GET');

      expect(getCacheSpy).toHaveBeenCalledWith('sessions');
      expect(result).toEqual([{ id: 22, name: 'pull' }]);
    } finally {
      cleanup();
    }
  });
});
