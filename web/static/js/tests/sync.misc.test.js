import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSyncEnv } from './helpers/sync-harness.js';

describe('sync.js misc helpers', () => {
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

  it('registerBackgroundSync registers sync tag when API is available', async () => {
    const { window, cleanup } = loadSyncEnv();

    try {
      const registerSpy = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(window.navigator, 'serviceWorker', {
        configurable: true,
        value: {
          ready: Promise.resolve({
            sync: {
              register: registerSpy
            }
          })
        }
      });

      await window.SyncManager.registerBackgroundSync('sync-bp-readings');

      expect(registerSpy).toHaveBeenCalledWith('sync-bp-readings');
    } finally {
      cleanup();
    }
  });

  it('showToast renders and auto-removes toast after timeout', async () => {
    const { window, document, cleanup } = loadSyncEnv();

    try {
      window.SyncManager.showToast('Saved offline', 'info');

      let toast = document.querySelector('.sync-toast');
      expect(toast).toBeTruthy();
      expect(toast.textContent).toBe('Saved offline');

      await vi.advanceTimersByTimeAsync(20);
      toast = document.querySelector('.sync-toast');
      expect(toast.classList.contains('show')).toBe(true);

      await vi.advanceTimersByTimeAsync(3400);
      expect(document.querySelector('.sync-toast')).toBeNull();
    } finally {
      cleanup();
    }
  });
});
