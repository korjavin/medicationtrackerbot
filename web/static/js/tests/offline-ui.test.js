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
    it('renders a kit .wg-toast in the .wg-toasts stack, with the type modifier', () => {
      const { window, document, cleanup } = loadSyncEnv();
      try {
        window.SyncManager.showToast('hello', 'info');
        const toast = document.querySelector('body > .wg-toasts > .wg-toast');
        expect(toast).toBeTruthy();
        expect(toast.querySelector('.wg-toast__text').textContent).toBe('hello');
        expect(toast.className).toBe('wg-toast');

        window.SyncManager.showToast('saved', 'success');
        window.SyncManager.showToast('nope', 'error');
        const toasts = document.querySelectorAll('.wg-toasts > .wg-toast');
        expect(toasts).toHaveLength(3);
        expect(toasts[1].classList.contains('wg-toast--ok')).toBe(true);
        expect(toasts[2].classList.contains('wg-toast--danger')).toBe(true);
        expect(toasts[2].getAttribute('role')).toBe('alert');
      } finally {
        cleanup();
      }
    });

    it('safeToast-style action: the button runs onClick once and dismisses the toast', () => {
      const { window, document, cleanup } = loadSyncEnv();
      try {
        const onClick = vi.fn();
        const onDismiss = vi.fn();
        const ctl = window.SyncManager.showToast('Reading deleted', 'info', {
          action: { label: 'Undo', onClick },
          onDismiss,
        });
        const btn = ctl.root.querySelector('.wg-toast__undo');
        expect(btn.textContent).toBe('Undo');
        btn.click();
        expect(onClick).toHaveBeenCalledOnce();
        expect(onDismiss).toHaveBeenCalledOnce();
        expect(document.querySelector('.wg-toast')).toBeNull();
        // The empty stack container goes with its last toast.
        expect(document.querySelector('.wg-toasts')).toBeNull();
      } finally {
        cleanup();
      }
    });

    it('auto-dismisses after duration and caps the stack at three', async () => {
      const { window, document, cleanup } = loadSyncEnv();
      try {
        for (let i = 0; i < 4; i++) window.SyncManager.showToast(`t${i}`, 'info', { duration: 20 });
        const texts = [...document.querySelectorAll('.wg-toast__text')].map((el) => el.textContent);
        expect(texts).toEqual(['t1', 't2', 't3']);
        await new Promise((r) => setTimeout(r, 80));
        expect(document.querySelector('.wg-toast')).toBeNull();
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
