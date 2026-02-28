import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSyncEnv } from './helpers/sync-harness.js';

describe('sync.js manager flow coverage', () => {
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

  it('init creates debug panel, subscribes to SW messages and routes sync message types', () => {
    const { window, document, cleanup } = loadSyncEnv();

    try {
      let messageHandler = null;
      const addMessageListenerSpy = vi.fn((eventName, handler) => {
        if (eventName === 'message') messageHandler = handler;
      });

      Object.defineProperty(window.navigator, 'serviceWorker', {
        configurable: true,
        value: {
          controller: {},
          addEventListener: addMessageListenerSpy
        }
      });

      const syncAllSpy = vi.spyOn(window.SyncManager, 'syncAll').mockImplementation(() => {});
      const updateStatusSpy = vi.spyOn(window.SyncManager, 'updateStatus').mockImplementation(() => {});
      const syncBPSpy = vi.spyOn(window.SyncManager, 'syncBPReadings').mockResolvedValue(undefined);
      const syncWeightSpy = vi.spyOn(window.SyncManager, 'syncWeightLogs').mockResolvedValue(undefined);
      const syncIntakeSpy = vi.spyOn(window.SyncManager, 'syncIntakeLogs').mockResolvedValue(undefined);

      window.SyncManager.isOnline = true;
      window.SyncManager.init();

      expect(document.getElementById('sync-debug-panel')).toBeTruthy();
      expect(addMessageListenerSpy).toHaveBeenCalledWith('message', expect.any(Function));
      expect(syncAllSpy).toHaveBeenCalledTimes(1);
      expect(updateStatusSpy).toHaveBeenCalledTimes(1);

      messageHandler({ data: { type: 'SYNC_BP_READINGS' } });
      messageHandler({ data: { type: 'SYNC_WEIGHT_LOGS' } });
      messageHandler({ data: { type: 'SYNC_INTAKE_LOGS' } });

      expect(syncBPSpy).toHaveBeenCalledTimes(1);
      expect(syncWeightSpy).toHaveBeenCalledTimes(1);
      expect(syncIntakeSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('syncAll calls all sync pipelines and clears syncing state on success', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      const bpSpy = vi.spyOn(window.SyncManager, 'syncBPReadings').mockResolvedValue(undefined);
      const weightSpy = vi.spyOn(window.SyncManager, 'syncWeightLogs').mockResolvedValue(undefined);
      const intakeSpy = vi.spyOn(window.SyncManager, 'syncIntakeLogs').mockResolvedValue(undefined);
      const updateStatusSpy = vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      window.SyncManager.isOnline = true;
      window.SyncManager.isSyncing = false;
      await window.SyncManager.syncAll();

      expect(bpSpy).toHaveBeenCalledTimes(1);
      expect(weightSpy).toHaveBeenCalledTimes(1);
      expect(intakeSpy).toHaveBeenCalledTimes(1);
      expect(window.SyncManager.isSyncing).toBe(false);
      expect(updateStatusSpy).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
    }
  });

  it('syncAll catches sync errors and still clears syncing flag', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      vi.spyOn(window.SyncManager, 'syncBPReadings').mockRejectedValue(new Error('bp failed'));
      vi.spyOn(window.SyncManager, 'syncWeightLogs').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'syncIntakeLogs').mockResolvedValue(undefined);
      const updateStatusSpy = vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      window.SyncManager.isOnline = true;
      await window.SyncManager.syncAll();

      expect(window.SyncManager.isSyncing).toBe(false);
      expect(updateStatusSpy).toHaveBeenCalledTimes(2);
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('syncBPReadings confirms successful rows and marks failed rows as error', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      const pending = [
        { localId: 1, measured_at: '2026-01-01T00:00:00Z', systolic: 120, diastolic: 80 },
        { localId: 2, measured_at: '2026-01-02T00:00:00Z', systolic: 130, diastolic: 85 }
      ];

      window.MedTrackerDB.BPStore.getPending = vi.fn().mockResolvedValue(pending);
      const confirmDeleteSpy = vi.fn().mockResolvedValue(undefined);
      const markErrorSpy = vi.fn().mockResolvedValue(undefined);
      window.MedTrackerDB.BPStore.confirmDelete = confirmDeleteSpy;
      window.MedTrackerDB.BPStore.markError = markErrorSpy;
      window.apiCallDirect = vi
        .fn()
        .mockResolvedValueOnce({ id: 500 })
        .mockResolvedValueOnce({});
      const updateStatusSpy = vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      window.SyncManager.isOnline = true;
      await window.SyncManager.syncBPReadings();

      expect(confirmDeleteSpy).toHaveBeenCalledWith(1);
      expect(markErrorSpy).toHaveBeenCalledWith(2, 'No ID returned from server');
      expect(updateStatusSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('syncWeightLogs marks failed sync rows with error state', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      const pending = [{ localId: 9, measured_at: '2026-01-01T00:00:00Z', weight: 80.5 }];
      window.MedTrackerDB.WeightStore.getPending = vi.fn().mockResolvedValue(pending);
      window.MedTrackerDB.WeightStore.markError = vi.fn().mockResolvedValue(undefined);
      window.apiCallDirect = vi.fn().mockRejectedValue(new Error('weight timeout'));
      const updateStatusSpy = vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      window.SyncManager.isOnline = true;
      await window.SyncManager.syncWeightLogs();

      expect(window.MedTrackerDB.WeightStore.markError).toHaveBeenCalledWith(9, 'weight timeout');
      expect(updateStatusSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('syncIntakeLogs no-ops without queue store and processes pending entries when available', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = true;

      const noStoreRef = window.MedTrackerDB.IntakeQueueStore;
      delete window.MedTrackerDB.IntakeQueueStore;
      await window.SyncManager.syncIntakeLogs();
      window.MedTrackerDB.IntakeQueueStore = noStoreRef;

      const pending = [
        { localId: 1, scheduled_at: '2026-01-01T00:00:00Z', medication_ids: [1] },
        { localId: 2, scheduled_at: '2026-01-02T00:00:00Z', medication_ids: [2] }
      ];

      window.MedTrackerDB.IntakeQueueStore.getPending = vi.fn().mockResolvedValue(pending);
      const markSyncedSpy = vi.fn().mockResolvedValue(undefined);
      const markErrorSpy = vi.fn().mockResolvedValue(undefined);
      window.MedTrackerDB.IntakeQueueStore.markSynced = markSyncedSpy;
      window.MedTrackerDB.IntakeQueueStore.markError = markErrorSpy;
      window.apiCallDirect = vi
        .fn()
        .mockResolvedValueOnce({ ok: true })
        .mockRejectedValueOnce(new Error('intake failed'));
      const updateStatusSpy = vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

      await window.SyncManager.syncIntakeLogs();

      expect(markSyncedSpy).toHaveBeenCalledWith(1);
      expect(markErrorSpy).toHaveBeenCalledWith(2, 'intake failed');
      expect(updateStatusSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });
});
