import { describe, expect, it, vi } from 'vitest';
import { loadDataStoreEnv } from './helpers/data-store-harness.js';

describe('data-store.js maintenance and auth probes', () => {
  it('pruneStaleClientCache deletes stale rows by key age strategy', async () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      const now = Date.now();
      const deletedIds = [];

      window.MedTrackerDB.db = {
        api_cache: {
          async toArray() {
            return [
              { id: 'history_3_0', timestamp: now - (8 * 24 * 60 * 60 * 1000) }, // stale for history (7d)
              { id: 'bp', timestamp: now - (4 * 24 * 60 * 60 * 1000) }, // stale for high freq (3d)
              { id: 'settings_bundle', timestamp: now - (2 * 24 * 60 * 60 * 1000) } // fresh for default (14d)
            ];
          },
          async delete(id) {
            deletedIds.push(id);
          }
        }
      };

      window.localStorage.removeItem('medtracker_cache_pruned_at');
      await window.DataStore.pruneStaleClientCache();

      expect(deletedIds).toContain('history_3_0');
      expect(deletedIds).toContain('bp');
      expect(deletedIds).not.toContain('settings_bundle');
      expect(window.localStorage.getItem('medtracker_cache_pruned_at')).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it('pruneStaleClientCache skips work when prune interval has not elapsed', async () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      const toArraySpy = vi.fn().mockResolvedValue([]);
      window.MedTrackerDB.db = { api_cache: { toArray: toArraySpy, delete: vi.fn() } };
      window.localStorage.setItem('medtracker_cache_pruned_at', String(Date.now()));

      await window.DataStore.pruneStaleClientCache();

      expect(toArraySpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('verifyAuthSession probes changes endpoint with current cursor', async () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      window.DataStore.setChangeCursor(77);
      const apiSpy = vi.fn().mockResolvedValue({});
      window.apiCallDirect = apiSpy;

      await window.DataStore.verifyAuthSession();

      expect(apiSpy).toHaveBeenCalledWith('/api/changes?since=77', 'GET');
    } finally {
      cleanup();
    }
  });

  it('verifyAuthSession triggers unauthorized handler on Unauthorized errors', async () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      window.apiCallDirect = vi.fn().mockRejectedValue(new Error('Unauthorized'));
      const handleSpy = vi.spyOn(window.DataStore, 'handleUnauthorized').mockImplementation(() => {});

      await window.DataStore.verifyAuthSession();

      expect(handleSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('handleUnauthorized stops polling and invokes callback only once', () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      const stopSpy = vi.spyOn(window.DataStore, 'stopChangePolling').mockImplementation(() => {});
      const unauthorizedSpy = vi.fn();
      window.onDataStoreUnauthorized = unauthorizedSpy;

      window.DataStore.handleUnauthorized();
      window.DataStore.handleUnauthorized();

      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(unauthorizedSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });
});
