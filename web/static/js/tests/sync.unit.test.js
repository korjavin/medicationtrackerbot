import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSyncEnv } from './helpers/sync-harness.js';

describe('sync.js SyncManager unit tests', () => {
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

  it('updateStatus aggregates pending counts and notifies status callbacks', async () => {
    const { window, document, cleanup } = loadSyncEnv({
      bpPending: 1,
      weightPending: 2,
      intakePending: 3
    });

    try {
      const callback = vi.fn();
      window.SyncManager.onStatusChange(callback);

      await window.SyncManager.updateStatus();

      expect(callback).toHaveBeenCalledTimes(1);
      const status = callback.mock.calls[0][0];
      expect(status.pendingCount).toBe(6);
      expect(status.bpPending).toBe(1);
      expect(status.weightPending).toBe(2);
      expect(document.getElementById('sync-status-bar').className).toContain('pending');
    } finally {
      cleanup();
    }
  });

  it('updateStatusBar renders offline/syncing/pending/synced states', () => {
    const { window, document, cleanup } = loadSyncEnv();

    try {
      const bar = document.getElementById('sync-status-bar');

      window.SyncManager.updateStatusBar({ isOnline: false, isSyncing: false, pendingCount: 0 });
      expect(bar.className).toContain('offline');

      window.SyncManager.updateStatusBar({ isOnline: true, isSyncing: true, pendingCount: 0 });
      expect(bar.className).toContain('syncing');

      window.SyncManager.updateStatusBar({ isOnline: true, isSyncing: false, pendingCount: 2 });
      expect(bar.className).toContain('pending');

      window.SyncManager.updateStatusBar({ isOnline: true, isSyncing: false, pendingCount: 0, rejectedCount: 0 });
      expect(bar.className).toContain('synced');
      expect(bar.classList.contains('wg-settings-hidden')).toBe(false);

      // Rejected-only state
      window.SyncManager.updateStatusBar({ isOnline: true, isSyncing: false, pendingCount: 0, rejectedCount: 1 });
      expect(bar.className).toContain('error');
      expect(bar.innerHTML).toContain('failed to sync');

      // Mixed pending + rejected state shows both counts
      window.SyncManager.updateStatusBar({ isOnline: true, isSyncing: false, pendingCount: 2, rejectedCount: 1 });
      expect(bar.className).toContain('error');
      expect(bar.innerHTML).toContain('1 failed');
      expect(bar.innerHTML).toContain('2 pending');
    } finally {
      cleanup();
    }
  });

  it('handleOnline sets online state, updates status, syncs and requests soft refresh', () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = false;
      const updateStatusSpy = vi.fn();
      const syncAllSpy = vi.fn();
      const requestRefreshSpy = vi.fn();

      window.SyncManager.updateStatus = updateStatusSpy;
      window.SyncManager.syncAll = syncAllSpy;
      window.requestTabRefresh = requestRefreshSpy;

      window.SyncManager.handleOnline();

      expect(window.SyncManager.isOnline).toBe(true);
      expect(updateStatusSpy).toHaveBeenCalledTimes(1);
      expect(syncAllSpy).toHaveBeenCalledTimes(1);
      expect(requestRefreshSpy).toHaveBeenCalledWith({ source: 'online' });
    } finally {
      cleanup();
    }
  });

  it('handleOnline falls back to reloadCurrentTab when requestTabRefresh is absent', () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.updateStatus = vi.fn();
      window.SyncManager.syncAll = vi.fn();
      window.requestTabRefresh = undefined;

      const reloadSpy = vi.fn();
      window.reloadCurrentTab = reloadSpy;

      window.SyncManager.handleOnline();

      expect(reloadSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('handleOffline sets offline state and updates status', () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = true;
      const updateStatusSpy = vi.fn();
      window.SyncManager.updateStatus = updateStatusSpy;

      window.SyncManager.handleOffline();

      expect(window.SyncManager.isOnline).toBe(false);
      expect(updateStatusSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('isPermanentSyncError treats 429 as transient (retriable)', () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      // Access the function via window eval scope
      const isPermanent = (status) => {
        const err = new Error('test');
        err.status = status;
        // The function is in the closure scope, but we can test via sync behavior
        // Instead, directly test the logic
        return window.eval(`isPermanentSyncError(Object.assign(new Error("test"), { status: ${status} }))`);
      };

      // 429 Too Many Requests should be transient
      expect(isPermanent(429)).toBe(false);
      // 401/403 should be transient
      expect(isPermanent(401)).toBe(false);
      expect(isPermanent(403)).toBe(false);
      // Other 4xx should be permanent
      expect(isPermanent(400)).toBe(true);
      expect(isPermanent(404)).toBe(true);
      expect(isPermanent(422)).toBe(true);
      // 5xx should be transient (no status match in 400-499 range)
      expect(isPermanent(500)).toBe(false);
      expect(isPermanent(502)).toBe(false);
      // No error should not be permanent
      expect(window.eval('isPermanentSyncError(null)')).toBe(false);
      // No status should not be permanent
      expect(window.eval('isPermanentSyncError(new Error("network"))')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('syncAll skips work when offline or already syncing', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      const bpSpy = vi.fn();
      const weightSpy = vi.fn();
      const intakeSpy = vi.fn();

      window.SyncManager.syncBPReadings = bpSpy;
      window.SyncManager.syncWeightLogs = weightSpy;
      window.SyncManager.syncIntakeLogs = intakeSpy;

      window.SyncManager.isOnline = false;
      await window.SyncManager.syncAll();

      window.SyncManager.isOnline = true;
      window.SyncManager.isSyncing = true;
      await window.SyncManager.syncAll();

      expect(bpSpy).not.toHaveBeenCalled();
      expect(weightSpy).not.toHaveBeenCalled();
      expect(intakeSpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
