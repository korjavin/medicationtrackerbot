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

  it('updateStatus reports zero pending and notifies status callbacks', async () => {
    const { window, document, cleanup } = loadSyncEnv();

    try {
      const callback = vi.fn();
      window.SyncManager.onStatusChange(callback);

      const total = await window.SyncManager.updateStatus();

      expect(total).toBe(0);
      expect(callback).toHaveBeenCalledTimes(1);
      const status = callback.mock.calls[0][0];
      expect(status.pendingCount).toBe(0);
      expect(status.rejectedCount).toBe(0);
      expect(document.getElementById('sync-status-bar').className).toContain('synced');
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

  it('handleOnline sets online state, updates status and requests soft refresh', () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.isOnline = false;
      const updateStatusSpy = vi.fn();
      const requestRefreshSpy = vi.fn();

      window.SyncManager.updateStatus = updateStatusSpy;
      window.requestTabRefresh = requestRefreshSpy;

      window.SyncManager.handleOnline();

      expect(window.SyncManager.isOnline).toBe(true);
      expect(updateStatusSpy).toHaveBeenCalledTimes(1);
      expect(requestRefreshSpy).toHaveBeenCalledWith({ source: 'online' });
    } finally {
      cleanup();
    }
  });

  it('handleOnline falls back to reloadCurrentTab when requestTabRefresh is absent', () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.updateStatus = vi.fn();
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

  it('isServerError detects 5xx by status code or proxy message', () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      expect(typeof window.isServerError).toBe('function');
      const err = (status) => Object.assign(new Error('x'), { status });
      expect(window.isServerError(err(500))).toBe(true);
      expect(window.isServerError(err(502))).toBe(true);
      expect(window.isServerError(err(404))).toBe(false);
      expect(window.isServerError(new Error('Bad Gateway'))).toBe(true);
      expect(window.isServerError(new Error('Service Unavailable'))).toBe(true);
      expect(window.isServerError(new Error('Failed to fetch'))).toBe(false);
    } finally {
      cleanup();
    }
  });
});
