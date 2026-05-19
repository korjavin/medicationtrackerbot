import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

describe('app.js refresh dispatch behavior', () => {
  beforeEach(() => {
    allowConsoleNoise();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reloadCurrentTab dispatches to loader based on active tab and med subtab', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const loadMedsSpy = vi.fn();
      const loadHistorySpy = vi.fn();
      const loadWeightSpy = vi.fn();

      window.loadMeds = loadMedsSpy;
      window.loadHistory = loadHistorySpy;
      window.loadWeightLogs = loadWeightSpy;

      window.AppStore.set('currentTab', 'meds');
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      document.getElementById('meds-view').classList.add('active');

      document.querySelectorAll('.med-tab').forEach((t) => t.classList.remove('active'));
      document.querySelector('.med-tab[data-tab="schedule"]').classList.add('active');

      window.reloadCurrentTab();
      expect(loadMedsSpy).toHaveBeenCalledTimes(1);
      expect(loadHistorySpy).toHaveBeenCalledTimes(0);

      document.querySelectorAll('.med-tab').forEach((t) => t.classList.remove('active'));
      document.querySelector('.med-tab[data-tab="history"]').classList.add('active');
      window.reloadCurrentTab();
      expect(loadHistorySpy).toHaveBeenCalledTimes(1);

      window.AppStore.set('currentTab', 'weight');
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      document.getElementById('weight-view').classList.add('active');
      window.reloadCurrentTab();
      expect(loadWeightSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('requestTabRefresh defers reload while user is editing and applies on demand', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const reloadSpy = vi.fn();
      window.reloadCurrentTab = reloadSpy;

      const medName = document.getElementById('med-name');
      medName.focus();

      window.requestTabRefresh({ source: 'changes' });
      const banner = document.getElementById('data-refresh-banner');
      expect(banner).toBeTruthy();
      expect(banner.classList.contains('hidden')).toBe(false);
      expect(reloadSpy).toHaveBeenCalledTimes(0);

      medName.blur();
      window.applyPendingTabRefresh();
      expect(reloadSpy).toHaveBeenCalledTimes(1);
      expect(banner.classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('requestTabRefresh source=self-echo never surfaces the banner, even with a modal open', () => {
    // Regression: when the SSE/poll handler tags a change-stream payload as
    // an echo of one of our own recent writes (DataStore.applyChangesPayload
    // with recordOwnWrite in flight), the banner must NOT appear — the user
    // already saw their action take effect via the optimistic commit. A
    // modal-open or focused-input state should silently skip the reload,
    // not surface a "New data is available" prompt.
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const reloadSpy = vi.fn();
      window.reloadCurrentTab = reloadSpy;

      window.showBPRecordModal();
      window.requestTabRefresh({ changedTags: ['bp'], source: 'self-echo' });

      const banner = document.getElementById('data-refresh-banner');
      expect(banner == null || banner.classList.contains('hidden')).toBe(true);
      expect(reloadSpy).toHaveBeenCalledTimes(0);

      window.closeBPRecordModal();
    } finally {
      cleanup();
    }
  });

  it('requestTabRefresh defers while modal is open until pending refresh is applied', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const loadBPSpy = vi.fn();
      window.loadBPReadings = loadBPSpy;

      window.AppStore.set('currentTab', 'bp');
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      document.getElementById('bp-view').classList.add('active');

      window.showBPRecordModal();
      window.requestTabRefresh({ source: 'changes' });
      expect(loadBPSpy).toHaveBeenCalledTimes(0);

      await vi.advanceTimersByTimeAsync(1000);
      expect(loadBPSpy).toHaveBeenCalledTimes(0);

      window.closeBPRecordModal();
      window.applyPendingTabRefresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(loadBPSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });
});
