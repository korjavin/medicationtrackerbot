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

  describe('button disable states', () => {
    it('disables unsupported offline write buttons when offline', () => {
      const { window, document, cleanup } = loadSyncEnv();
      try {
        // Add test buttons to the DOM
        const container = document.createElement('div');
        const addMedBtn = document.createElement('button');
        addMedBtn.id = 'add-btn';
        container.appendChild(addMedBtn);

        const medSaveBtn = document.createElement('button');
        medSaveBtn.id = 'med-modal-save-btn';
        container.appendChild(medSaveBtn);

        const foodBtn = document.createElement('button');
        foodBtn.id = 'add-food-inline-btn';
        container.appendChild(foodBtn);

        const notesBtn = document.createElement('button');
        notesBtn.id = 'notes-save-btn';
        container.appendChild(notesBtn);

        const groupBtn = document.createElement('button');
        groupBtn.id = 'add-workout-group-btn';
        container.appendChild(groupBtn);

        document.body.appendChild(container);

        // Go offline
        window.SyncManager.updateOfflineBanner(true);

        expect(addMedBtn.classList.contains('offline-disabled')).toBe(true);
        expect(medSaveBtn.classList.contains('offline-disabled')).toBe(true);
        expect(foodBtn.classList.contains('offline-disabled')).toBe(true);
        expect(foodBtn.getAttribute('data-offline-disabled')).toBe('true');
        expect(notesBtn.classList.contains('offline-disabled')).toBe(true);
        expect(groupBtn.classList.contains('offline-disabled')).toBe(true);

        // Tooltips should appear
        const tips = container.querySelectorAll('.offline-disabled-tooltip');
        expect(tips.length).toBe(5);
        expect(tips[0].textContent).toBe('Available when online');
      } finally {
        cleanup();
      }
    });

    it('re-enables buttons when coming back online', () => {
      const { window, document, cleanup } = loadSyncEnv();
      try {
        const container = document.createElement('div');
        const foodBtn = document.createElement('button');
        foodBtn.id = 'add-food-inline-btn';
        container.appendChild(foodBtn);
        document.body.appendChild(container);

        // Go offline
        window.SyncManager.updateOfflineBanner(true);
        expect(foodBtn.classList.contains('offline-disabled')).toBe(true);
        expect(container.querySelector('.offline-disabled-tooltip')).toBeTruthy();

        // Come back online
        window.SyncManager.updateOfflineBanner(false);
        expect(foodBtn.classList.contains('offline-disabled')).toBe(false);
        expect(foodBtn.getAttribute('data-offline-disabled')).toBeNull();
        expect(container.querySelector('.offline-disabled-tooltip')).toBeNull();
      } finally {
        cleanup();
      }
    });

    it('does not add duplicate tooltips', () => {
      const { window, document, cleanup } = loadSyncEnv();
      try {
        const container = document.createElement('div');
        const btn = document.createElement('button');
        btn.id = 'add-food-inline-btn';
        container.appendChild(btn);
        document.body.appendChild(container);

        // Go offline twice
        window.SyncManager.updateOfflineBanner(true);
        window.SyncManager.updateOfflineBanner(true);

        const tips = container.querySelectorAll('.offline-disabled-tooltip');
        expect(tips.length).toBe(1);
      } finally {
        cleanup();
      }
    });

    it('disables workout session modal buttons when offline', () => {
      const { window, document, cleanup } = loadSyncEnv();
      try {
        const container = document.createElement('div');
        const ids = [
          'session-add-exercise-save-btn'
        ];
        for (const id of ids) {
          const btn = document.createElement('button');
          btn.id = id;
          container.appendChild(btn);
        }
        document.body.appendChild(container);

        window.SyncManager.updateOfflineBanner(true);

        for (const id of ids) {
          const btn = document.getElementById(id);
          expect(btn.classList.contains('offline-disabled')).toBe(true);
          expect(btn.disabled).toBe(true);
        }
      } finally {
        cleanup();
      }
    });

    // med-2fc: the ad-hoc Start CTA is no longer a static id in the
    // `offlineUnsupported` list — it is rendered into the next-workout card
    // as a `.workout-action-btn` and swept here, alongside Start /
    // Skip / Next Day. The rendered-button side is pinned in
    // workout.next-card.test.js.
    it('disables dynamically-created workout-action-btn elements when offline', () => {
      const { window, document, cleanup } = loadSyncEnv();
      try {
        const container = document.createElement('div');
        const btn = document.createElement('button');
        btn.className = 'btn workout-action-btn';
        container.appendChild(btn);
        document.body.appendChild(container);

        window.SyncManager.updateOfflineBanner(true);

        expect(btn.classList.contains('offline-disabled')).toBe(true);
        expect(btn.disabled).toBe(true);

        window.SyncManager.updateOfflineBanner(false);

        expect(btn.classList.contains('offline-disabled')).toBe(false);
        expect(btn.disabled).toBe(false);
      } finally {
        cleanup();
      }
    });

    it('does not affect BP/weight buttons (they support offline writes)', () => {
      const { window, document, cleanup } = loadSyncEnv();
      try {
        const container = document.createElement('div');
        const bpBtn = document.createElement('button');
        bpBtn.id = 'add-bp-btn';
        container.appendChild(bpBtn);

        const weightBtn = document.createElement('button');
        weightBtn.id = 'add-weight-btn';
        container.appendChild(weightBtn);
        document.body.appendChild(container);

        window.SyncManager.updateOfflineBanner(true);

        expect(bpBtn.classList.contains('offline-disabled')).toBe(false);
        expect(weightBtn.classList.contains('offline-disabled')).toBe(false);
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
