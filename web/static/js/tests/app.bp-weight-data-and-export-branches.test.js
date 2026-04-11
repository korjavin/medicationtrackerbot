import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function isoWithOffsetHours(offsetHours = 0) {
  return new Date(Date.now() + offsetHours * 60 * 60 * 1000).toISOString();
}

describe('app.js BP/weight data and export branch coverage', () => {
  let consoleErrorSpy;
  let consoleLogSpy;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it('loadBPReadings handles null fetch result, error fallback, and cached/fresh rendering callbacks', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.apiCall = vi.fn(async (endpoint) => {
        if (endpoint === '/api/bp?days=60') return null;
        if (endpoint === '/api/bp/goal') return {};
        if (endpoint === '/api/bp/stats') return {};
        return null;
      });
      window.DataStore.loadSWR = vi.fn(async (options) => {
        const fetched = await options.fetcher();
        expect(fetched).toBeNull();
        await options.onError(new Error('bp load failed'), null);
      });

      await window.loadBPReadings();
      expect(document.getElementById('bp-list').innerHTML).toContain('No cached data');

      const renderSpy = vi.spyOn(window, '_renderBPData').mockResolvedValue(undefined);
      window.apiCall = vi.fn(async (endpoint) => {
        if (endpoint === '/api/bp?days=60') {
          return [{ id: 1, measured_at: isoWithOffsetHours(-1), systolic: 120, diastolic: 80, pulse: 62 }];
        }
        if (endpoint === '/api/bp/goal') return { systolic_target: 130, diastolic_target: 85 };
        if (endpoint === '/api/bp/stats') return { stats_14: { days: 3, systolic: 121, diastolic: 79 } };
        return null;
      });
      window.DataStore.loadSWR = vi.fn(async (options) => {
        const fetched = await options.fetcher();
        await options.onCached(fetched);
        await options.onFresh(fetched);
      });

      await window.loadBPReadings();
      expect(renderSpy).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
    }
  });

  it('deleteBPReading uses Telegram confirm when init data exists and falls back to window confirm', () => {
    const { window, cleanup } = loadFrontendEnv({ telegramInitData: 'token=abc' });

    try {
      const deleteSpy = vi.spyOn(window, '_deleteBPApi').mockResolvedValue(undefined);

      window.Telegram.WebApp.showConfirm = vi.fn((_msg, cb) => cb(true));
      window.deleteBPReading(15);
      expect(window.Telegram.WebApp.showConfirm).toHaveBeenCalled();
      expect(deleteSpy).toHaveBeenCalledWith(15);

      window.Telegram.WebApp.showConfirm = vi.fn(() => {
        throw new Error('unsupported');
      });
      window.confirm = vi.fn().mockReturnValue(true);
      window.deleteBPReading(16);
      expect(window.confirm).toHaveBeenCalledWith('Delete this blood pressure reading?');
      expect(deleteSpy).toHaveBeenCalledWith(16);

      window.Telegram.WebApp.showConfirm = undefined;
      window.confirm = vi.fn().mockReturnValue(false);
      window.deleteBPReading(17);
      expect(deleteSpy).not.toHaveBeenCalledWith(17);
    } finally {
      cleanup();
    }
  });

  it('_deleteBPApi and _deleteWeightApi handle local/remote cleanup including local DB failures', async () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      const bpConfirmDeleteSpy = vi.fn().mockResolvedValue(undefined);
      const weightConfirmDeleteSpy = vi.fn().mockResolvedValue(undefined);
      const syncStatusSpy = vi.fn();
      const loadBPSpy = vi.fn();
      const loadWeightSpy = vi.fn();
      const invalidateSpy = vi.fn().mockResolvedValue(undefined);

      window.MedTrackerDB = {
        BPStore: {
          confirmDelete: bpConfirmDeleteSpy,
          getAll: vi.fn().mockResolvedValue([{ localId: 7, serverId: 77 }])
        },
        WeightStore: {
          confirmDelete: weightConfirmDeleteSpy,
          getAll: vi.fn().mockResolvedValue([{ localId: 9, serverId: 99 }])
        }
      };
      window.SyncManager = { updateStatus: syncStatusSpy };
      window.loadBPReadings = loadBPSpy;
      window.loadWeightLogs = loadWeightSpy;
      window.DataStore.invalidateTags = invalidateSpy;
      window.apiCall = vi.fn().mockResolvedValue({ ok: true });

      await window._deleteBPApi('local_5');
      expect(bpConfirmDeleteSpy).toHaveBeenCalledWith(5);
      expect(loadBPSpy).toHaveBeenCalled();

      await window._deleteBPApi(77);
      expect(window.apiCall).toHaveBeenCalledWith('/api/bp/77', 'DELETE');
      expect(invalidateSpy).toHaveBeenCalledWith(['bp']);
      expect(bpConfirmDeleteSpy).toHaveBeenCalledWith(7);

      await window._deleteWeightApi(99);
      expect(window.apiCall).toHaveBeenCalledWith('/api/weight/99', 'DELETE');
      expect(invalidateSpy).toHaveBeenCalledWith(['weight']);
      expect(weightConfirmDeleteSpy).toHaveBeenCalledWith(9);

      window.MedTrackerDB.BPStore.getAll = vi.fn().mockRejectedValue(new Error('bp db fail'));
      window.MedTrackerDB.WeightStore.getAll = vi.fn().mockRejectedValue(new Error('weight db fail'));
      await window._deleteBPApi(78);
      await window._deleteWeightApi(100);
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to delete from local DB:', expect.any(Error));
    } finally {
      cleanup();
    }
  });

  it('loadWeightLogs and weight renderers cover fetch/error/merge and list truncation branches', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.apiCall = vi.fn(async (endpoint) => {
        if (endpoint === '/api/weight?days=35') return null;
        if (endpoint === '/api/weight/goal') return {};
        return null;
      });
      window.DataStore.loadSWR = vi.fn(async (options) => {
        const fetched = await options.fetcher();
        expect(fetched).toBeNull();
        await options.onError(new Error('weight load failed'), null);
      });

      await window.loadWeightLogs();
      expect(document.getElementById('weight-list').innerHTML).toContain('No cached data');

      const renderWeightSpy = vi.spyOn(window, '_renderWeightData').mockResolvedValue(undefined);
      window.apiCall = vi.fn(async (endpoint) => {
        if (endpoint === '/api/weight?days=35') return [{ id: 1, measured_at: isoWithOffsetHours(-1), weight: 80.1, weight_trend: 80 }];
        if (endpoint === '/api/weight/goal') return { goal: 75 };
        return null;
      });
      window.DataStore.loadSWR = vi.fn(async (options) => {
        const fetched = await options.fetcher();
        await options.onCached(fetched);
        await options.onFresh(fetched);
      });
      await window.loadWeightLogs();
      expect(renderWeightSpy).toHaveBeenCalledTimes(2);
      renderWeightSpy.mockRestore();

      window.renderWeightChart = vi.fn();
      window.MedTrackerDB = {
        WeightStore: {
          getPending: vi.fn().mockResolvedValue([
            { localId: 55, measured_at: isoWithOffsetHours(-2), weight: 81.2, notes: 'pending note' }
          ]),
          getRejected: vi.fn().mockResolvedValue([])
        }
      };
      await window._renderWeightData(
        [{ id: 10, measured_at: isoWithOffsetHours(-1), weight: 80.5, weight_trend: 80.7 }],
        { goal: 76 }
      );
      expect(document.getElementById('weight-list').innerHTML).toContain('Pending');
      expect(window.renderWeightChart).toHaveBeenCalled();

      window.MedTrackerDB = null;
      await window._renderWeightData(null, {});
      expect(document.getElementById('weight-list').innerHTML).toContain('No cached data');

      const manyLogs = Array.from({ length: 31 }, (_, i) => ({
        id: i + 1,
        measured_at: isoWithOffsetHours(-i),
        weight: 78 + (i * 0.1),
        weight_trend: 78
      }));
      window.renderWeightLogs(manyLogs);
      expect(document.querySelectorAll('#weight-list .weight-item').length).toBe(30);
    } finally {
      cleanup();
    }
  });

  it('exportBPCSV and exportWeightCSV cover success, non-ok and exception branches', async () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      const alertSpy = vi.fn();
      const clickSpy = vi.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      const createObjectURLSpy = vi.fn().mockReturnValue('blob:unit-test');
      const revokeObjectURLSpy = vi.fn();

      window.Telegram.WebApp.showAlert = alertSpy;
      window.URL.createObjectURL = createObjectURLSpy;
      window.URL.revokeObjectURL = revokeObjectURLSpy;

      window.fetch = vi.fn().mockResolvedValue({
        ok: true,
        blob: async () => new window.Blob(['csv'])
      });
      await window.exportBPCSV();
      await window.exportWeightCSV();
      expect(window.fetch).toHaveBeenCalledWith('/api/bp/export', expect.any(Object));
      expect(window.fetch).toHaveBeenCalledWith('/api/weight/export', expect.any(Object));
      expect(createObjectURLSpy).toHaveBeenCalled();
      expect(revokeObjectURLSpy).toHaveBeenCalled();

      window.fetch = vi.fn().mockResolvedValue({ ok: false });
      await window.exportBPCSV();
      expect(alertSpy).toHaveBeenCalledWith('Failed to generate export');

      window.fetch = vi.fn().mockRejectedValue(new Error('offline'));
      await window.exportWeightCSV();
      expect(alertSpy).toHaveBeenCalledWith('Failed to export data');

      clickSpy.mockRestore();
    } finally {
      cleanup();
    }
  });
});
