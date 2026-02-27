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
});
