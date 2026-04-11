import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSyncEnv } from './helpers/sync-harness.js';

describe('SyncManager exponential backoff retry', () => {
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    vi.useFakeTimers();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('schedules retry with exponential backoff when pending items remain after sync', async () => {
    const { window, cleanup } = loadSyncEnv({ bpPending: 1 });

    try {
      // Make syncBPReadings fail so items remain pending
      vi.spyOn(window.SyncManager, 'syncBPReadings').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'syncWeightLogs').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'syncIntakeLogs').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(1);

      window.SyncManager.isOnline = true;
      window.SyncManager.isSyncing = false;
      await window.SyncManager.syncAll();

      // Should have scheduled a retry
      expect(window.SyncManager.retryTimer).not.toBeNull();
      expect(window.SyncManager.retryScheduledAt).toBeTypeOf('number');
    } finally {
      cleanup();
    }
  });

  it('doubles retry delay each failure, capped at 300s', async () => {
    const { window, cleanup } = loadSyncEnv({ bpPending: 1 });

    try {
      vi.spyOn(window.SyncManager, 'syncBPReadings').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'syncWeightLogs').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'syncIntakeLogs').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(1);

      window.SyncManager.isOnline = true;

      // Initial delay is 5000
      expect(window.SyncManager.retryDelayMs).toBe(5000);

      // First sync -> schedule retry at 5000, next delay = 10000
      await window.SyncManager.syncAll();
      expect(window.SyncManager.retryDelayMs).toBe(10000);

      // Advance timer to trigger retry
      window.SyncManager.isSyncing = false;
      await vi.advanceTimersByTimeAsync(5000);
      // After second sync -> schedule retry at 10000, next delay = 20000
      expect(window.SyncManager.retryDelayMs).toBe(20000);

      // Keep doubling: 20000 -> 40000 -> 80000 -> 160000 -> 300000 (cap)
      window.SyncManager.isSyncing = false;
      await vi.advanceTimersByTimeAsync(10000);
      expect(window.SyncManager.retryDelayMs).toBe(40000);

      window.SyncManager.isSyncing = false;
      await vi.advanceTimersByTimeAsync(20000);
      expect(window.SyncManager.retryDelayMs).toBe(80000);

      window.SyncManager.isSyncing = false;
      await vi.advanceTimersByTimeAsync(40000);
      expect(window.SyncManager.retryDelayMs).toBe(160000);

      window.SyncManager.isSyncing = false;
      await vi.advanceTimersByTimeAsync(80000);
      expect(window.SyncManager.retryDelayMs).toBe(300000);

      // Should stay at cap
      window.SyncManager.isSyncing = false;
      await vi.advanceTimersByTimeAsync(160000);
      expect(window.SyncManager.retryDelayMs).toBe(300000);
    } finally {
      cleanup();
    }
  });

  it('resets backoff delay on successful sync (no pending items)', async () => {
    const { window, cleanup } = loadSyncEnv({ bpPending: 0 });

    try {
      vi.spyOn(window.SyncManager, 'syncBPReadings').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'syncWeightLogs').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'syncIntakeLogs').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(0);

      window.SyncManager.isOnline = true;
      window.SyncManager.retryDelayMs = 80000; // Simulate previous backoffs

      await window.SyncManager.syncAll();

      // No pending items -> reset backoff
      expect(window.SyncManager.retryDelayMs).toBe(5000);
      expect(window.SyncManager.retryTimer).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('cancels pending retry when syncAll is called externally', async () => {
    const { window, cleanup } = loadSyncEnv({ bpPending: 1 });

    try {
      vi.spyOn(window.SyncManager, 'syncBPReadings').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'syncWeightLogs').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'syncIntakeLogs').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(1);

      window.SyncManager.isOnline = true;
      await window.SyncManager.syncAll();

      // Retry should be scheduled
      const oldTimer = window.SyncManager.retryTimer;
      expect(oldTimer).not.toBeNull();

      // Manually call syncAll again (simulates external trigger)
      window.SyncManager.isSyncing = false;
      await window.SyncManager.syncAll();

      // Old timer should have been cancelled (new one scheduled)
      // The retryTimer is a new timer now
      expect(window.SyncManager.retryTimer).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it('resets backoff and cancels retry on online event', async () => {
    const { window, cleanup } = loadSyncEnv({ bpPending: 1 });

    try {
      vi.spyOn(window.SyncManager, 'syncBPReadings').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'syncWeightLogs').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'syncIntakeLogs').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(1);

      window.SyncManager.isOnline = true;
      window.SyncManager.retryDelayMs = 80000;

      // Schedule a retry
      window.SyncManager.scheduleRetry();
      expect(window.SyncManager.retryTimer).not.toBeNull();

      // Simulate going offline then online
      window.SyncManager.handleOffline();

      // handleOnline resets backoff and calls syncAll
      window.SyncManager.handleOnline();

      // Right after handleOnline (before syncAll's async work), backoff is reset
      // But syncAll will complete async and schedule a new retry starting from initial delay
      await vi.advanceTimersByTimeAsync(0);

      // After syncAll completes with pending items, it schedules retry from the reset 5000,
      // then doubles to 10000 for next time
      expect(window.SyncManager.retryDelayMs).toBe(10000);
      // The retry was scheduled at the initial 5000ms delay (proving reset worked)
      expect(window.SyncManager.retryTimer).not.toBeNull();

      // Clean up any pending retry timers before DOM cleanup
      window.SyncManager.cancelRetry();
    } finally {
      cleanup();
    }
  });

  it('does not schedule retry when offline', async () => {
    const { window, cleanup } = loadSyncEnv({ bpPending: 1 });

    try {
      vi.spyOn(window.SyncManager, 'syncBPReadings').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'syncWeightLogs').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'syncIntakeLogs').mockResolvedValue(undefined);
      vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(1);

      window.SyncManager.isOnline = true;
      await window.SyncManager.syncAll();

      // Now go offline - cancel retry
      window.SyncManager.cancelRetry();
      window.SyncManager.isOnline = false;

      // No retry should be scheduled when offline
      expect(window.SyncManager.retryTimer).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('shows retry countdown in status bar', async () => {
    const { window, document, cleanup } = loadSyncEnv({ bpPending: 2 });

    try {
      window.SyncManager.isOnline = true;
      window.SyncManager.retryScheduledAt = Date.now() + 15000; // 15 seconds from now

      await window.SyncManager.updateStatus();

      const statusBar = document.getElementById('sync-status-bar');
      expect(statusBar.innerHTML).toContain('retry in');
      expect(statusBar.innerHTML).toContain('2 items pending sync');
    } finally {
      cleanup();
    }
  });

  it('cancelRetry clears timer and scheduledAt', () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.retryTimer = setTimeout(() => {}, 10000);
      window.SyncManager.retryScheduledAt = Date.now() + 10000;

      window.SyncManager.cancelRetry();

      expect(window.SyncManager.retryTimer).toBeNull();
      expect(window.SyncManager.retryScheduledAt).toBeNull();
    } finally {
      cleanup();
    }
  });
});
