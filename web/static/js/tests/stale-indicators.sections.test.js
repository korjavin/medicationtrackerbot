import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

describe('stale indicators across sections', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  // ===== BP section =====

  it('loadBPReadings onCached calls showStaleIndicator with cachedAt', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const list = document.getElementById('bp-list');
      const container = list.parentElement;
      const cachedAt = Date.now() - 3600000;
      const cachedData = {
        readingsRes: [],
        goalRes: {},
        statsRes: {}
      };

      const showStaleSpy = vi.fn();
      window.showStaleIndicator = showStaleSpy;
      window._renderBPData = vi.fn().mockResolvedValue(undefined);

      window.DataStore.loadSWR = vi.fn(async (options) => {
        window.DataStore.getCachedMeta = vi.fn().mockResolvedValue({ cachedAt });
        await options.onCached(cachedData);
      });

      await window.loadBPReadings();

      expect(showStaleSpy).toHaveBeenCalledWith(container, cachedAt);
    } finally {
      cleanup();
    }
  });

  it('loadBPReadings onFresh calls hideStaleIndicator', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const list = document.getElementById('bp-list');
      const container = list.parentElement;
      const freshData = {
        readingsRes: [],
        goalRes: {},
        statsRes: {}
      };

      const hideStaleSpy = vi.fn();
      window.hideStaleIndicator = hideStaleSpy;
      window._renderBPData = vi.fn().mockResolvedValue(undefined);

      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh(freshData);
      });

      await window.loadBPReadings();

      expect(hideStaleSpy).toHaveBeenCalledWith(container);
    } finally {
      cleanup();
    }
  });

  // ===== Weight section =====

  it('loadWeightLogs onCached calls showStaleIndicator with cachedAt', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const list = document.getElementById('weight-list');
      const container = list.parentElement;
      const cachedAt = Date.now() - 7200000;
      const cachedData = { logsRes: [], goalRes: {} };

      const showStaleSpy = vi.fn();
      window.showStaleIndicator = showStaleSpy;
      window._renderWeightData = vi.fn().mockResolvedValue(undefined);

      window.DataStore.loadSWR = vi.fn(async (options) => {
        window.DataStore.getCachedMeta = vi.fn().mockResolvedValue({ cachedAt });
        await options.onCached(cachedData);
      });

      await window.loadWeightLogs();

      expect(showStaleSpy).toHaveBeenCalledWith(container, cachedAt);
    } finally {
      cleanup();
    }
  });

  it('loadWeightLogs onFresh calls hideStaleIndicator', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const list = document.getElementById('weight-list');
      const container = list.parentElement;
      const freshData = { logsRes: [], goalRes: {} };

      const hideStaleSpy = vi.fn();
      window.hideStaleIndicator = hideStaleSpy;
      window._renderWeightData = vi.fn().mockResolvedValue(undefined);

      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh(freshData);
      });

      await window.loadWeightLogs();

      expect(hideStaleSpy).toHaveBeenCalledWith(container);
    } finally {
      cleanup();
    }
  });

  // ===== Meds section (app.js loadMeds) =====

  it('loadMeds onCached calls showStaleIndicator with cachedAt', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const container = document.getElementById('med-list');
      const cachedAt = Date.now() - 1800000;

      const showStaleSpy = vi.fn();
      window.showStaleIndicator = showStaleSpy;
      window.renderMeds = vi.fn();
      window.populateMedFilter = vi.fn();

      window.DataStore.loadSWR = vi.fn(async (options) => {
        window.DataStore.getCachedMeta = vi.fn().mockResolvedValue({ cachedAt });
        await options.onCached([]);
      });

      await window.loadMeds();

      expect(showStaleSpy).toHaveBeenCalledWith(container, cachedAt);
    } finally {
      cleanup();
    }
  });

  it('loadMeds onFresh calls hideStaleIndicator', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const container = document.getElementById('med-list');

      const hideStaleSpy = vi.fn();
      window.hideStaleIndicator = hideStaleSpy;
      window.renderMeds = vi.fn();
      window.populateMedFilter = vi.fn();

      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh([]);
      });

      await window.loadMeds();

      expect(hideStaleSpy).toHaveBeenCalledWith(container);
    } finally {
      cleanup();
    }
  });
});
