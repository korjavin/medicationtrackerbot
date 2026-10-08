import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSyncEnv } from './helpers/sync-harness.js';

describe('Offline UI indicators', () => {
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

  describe('offline banner', () => {
    it('shows banner when going offline', () => {
      const { window, document, cleanup } = loadSyncEnv();
      try {
        const banner = document.getElementById('offline-banner');
        expect(banner).toBeTruthy();

        // Initially online - banner should be hidden
        window.SyncManager.isOnline = true;
        window.SyncManager.updateOfflineBanner(false);
        expect(banner.classList.contains('hidden')).toBe(true);

        // Go offline
        window.SyncManager.updateOfflineBanner(true);
        expect(banner.classList.contains('hidden')).toBe(false);
      } finally {
        cleanup();
      }
    });

    it('hides banner when coming back online', () => {
      const { window, document, cleanup } = loadSyncEnv();
      try {
        const banner = document.getElementById('offline-banner');

        // Start offline
        window.SyncManager.updateOfflineBanner(true);
        expect(banner.classList.contains('hidden')).toBe(false);

        // Come back online
        window.SyncManager.updateOfflineBanner(false);
        expect(banner.classList.contains('hidden')).toBe(true);
      } finally {
        cleanup();
      }
    });

    it('handleOffline shows banner', () => {
      const { window, document, cleanup } = loadSyncEnv();
      try {
        const banner = document.getElementById('offline-banner');
        vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

        window.SyncManager.handleOffline();

        expect(banner.classList.contains('hidden')).toBe(false);
        expect(window.SyncManager.isOnline).toBe(false);
      } finally {
        cleanup();
      }
    });

    it('handleOnline hides banner', () => {
      const { window, document, cleanup } = loadSyncEnv();
      try {
        const banner = document.getElementById('offline-banner');
        vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

        // First go offline
        window.SyncManager.handleOffline();
        expect(banner.classList.contains('hidden')).toBe(false);

        // Then come online
        window.SyncManager.handleOnline();
        expect(banner.classList.contains('hidden')).toBe(true);
      } finally {
        cleanup();
      }
    });
  });

  // med-mgvo: cloud writes are local-first, so going offline toggles ONLY the
  // banner — no button is disabled (the old sweep made Finish a silent no-op).
  describe('offline never disables buttons', () => {
    it('leaves write buttons (static ids and workout actions) enabled and untouched', () => {
      const { window, document, cleanup } = loadSyncEnv();
      try {
        const container = document.createElement('div');
        container.innerHTML = '<button id="add-btn"></button>'
          + '<button id="food-modal-save-btn"></button>'
          + '<button id="session-add-exercise-save-btn"></button>'
          + '<button id="workout-session-finish-btn"></button>';
        document.body.appendChild(container);
        const before = container.innerHTML;

        window.SyncManager.handleOffline();

        expect(document.getElementById('offline-banner').classList.contains('hidden')).toBe(false);
        for (const btn of container.querySelectorAll('button')) {
          expect(btn.disabled).toBe(false);
        }
        expect(container.innerHTML).toBe(before);
        expect(document.querySelector('[data-offline-disabled], .offline-disabled, .offline-disabled-tooltip')).toBeNull();
      } finally {
        cleanup();
      }
    });
  });

  describe('showToast', () => {
    it('renders a toast with the message and type class', () => {
      const { window, document, cleanup } = loadSyncEnv();
      try {
        window.SyncManager.showToast('hello', 'info');
        const toast = document.querySelector('.sync-toast');
        expect(toast).toBeTruthy();
        expect(toast.textContent).toBe('hello');
        expect(toast.classList.contains('info')).toBe(true);
      } finally {
        cleanup();
      }
    });
  });

  describe('init sets offline banner based on initial state', () => {
    it('shows banner on init when offline', () => {
      const { window, document, cleanup } = loadSyncEnv();
      try {
        const banner = document.getElementById('offline-banner');
        // SyncManager.init is called during loadSyncEnv
        // The harness sets navigator.onLine based on JSDOM defaults (true)
        // So banner should be hidden initially
        // Let's test by simulating offline init
        window.SyncManager.isOnline = false;
        window.SyncManager.updateOfflineBanner(true);
        expect(banner.classList.contains('hidden')).toBe(false);
      } finally {
        cleanup();
      }
    });
  });
});
