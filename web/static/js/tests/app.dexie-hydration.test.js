import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockResponse, loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

const AUTH_CACHE_KEY = 'medtracker_auth_state';

function setAuthCache(window) {
  window.localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({
    authenticated: true,
    authMethod: 'cookie',
    timestamp: Date.now(),
    ttl: 30 * 24 * 60 * 60 * 1000
  }));
}

// Map-backed fake of MedTrackerDB.ApiCache that mirrors the {data, timestamp}
// row shape of the real Dexie api_cache table — same contract as the
// data-store-harness mock so DataStore.setCached / getCached / hydrateFromDexie
// all work end-to-end against an in-memory store.
function installFakeApiCache(window) {
  const map = new Map();
  const meta = new Map();
  window.MedTrackerDB = window.MedTrackerDB || {};
  window.MedTrackerDB.ApiCache = {
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async getWithMeta(key) {
      if (!map.has(key)) return null;
      return { data: map.get(key), timestamp: meta.has(key) ? meta.get(key) : null };
    },
    async set(key, value) { map.set(key, value); meta.set(key, Date.now()); },
    async setWithMeta(key, value, timestamp) {
      map.set(key, value);
      meta.set(key, Number.isFinite(timestamp) ? timestamp : Date.now());
    },
    async clear(key) { map.delete(key); meta.delete(key); }
  };
  return { cacheMap: map, metaMap: meta };
}

describe('app.js cold-start Dexie hydration', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  it('seeds DataStore.getCached("medications") from the Dexie cache before bootstrap returns', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      setAuthCache(window);
      const { cacheMap, metaMap } = installFakeApiCache(window);

      const meds = [
        { id: 1, name: 'Atorvastatin', schedule: '{}' },
        { id: 2, name: 'Metformin', schedule: '{}' }
      ];
      const dexieTs = Date.now() - (90 * 60 * 1000); // 90 min ago
      const loadCacheSpy = vi.fn().mockResolvedValue({ data: meds, timestamp: dexieTs });
      // checkAuth's offline-fallback branches call the legacy getCache() too;
      // stub it so the auth flow can complete without a TypeError.
      window.MedTrackerDB.MedicationStore = {
        loadCache: loadCacheSpy,
        getCache: vi.fn().mockResolvedValue(meds)
      };

      // Simulate offline: bootstrap fetch rejects, /auth/status rejects.
      window.fetch = vi.fn().mockRejectedValue(new Error('offline'));

      await window.checkAuth();

      expect(loadCacheSpy).toHaveBeenCalledTimes(1);
      const seeded = await window.DataStore.getCached('medications');
      expect(seeded).toEqual(meds);
      expect(cacheMap.get('medications')).toEqual(meds);
      // Dexie's original timestamp must survive into ApiCache so the stale
      // badge can render an honest "Offline · 1h ago" chip instead of "now".
      expect(metaMap.get('medications')).toBe(dexieTs);
    } finally {
      cleanup();
    }
  });

  it('skips hydration when there is no auth presence (no initData, no cached auth)', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      // Explicitly clear any prior auth cache.
      window.localStorage.removeItem(AUTH_CACHE_KEY);
      installFakeApiCache(window);

      const loadCacheSpy = vi.fn().mockResolvedValue({
        data: [{ id: 99, name: 'should-not-leak' }],
        timestamp: Date.now() - 60_000
      });
      window.MedTrackerDB.MedicationStore = { loadCache: loadCacheSpy };

      await window.hydrateMedicationsFromDexie();

      expect(loadCacheSpy).not.toHaveBeenCalled();
      const seeded = await window.DataStore.getCached('medications');
      expect(seeded).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('runs hydration when Telegram initData is present even without a cached auth state', async () => {
    const { window, cleanup } = loadFrontendEnv({ telegramInitData: 'tg_init_data_xyz' });
    try {
      window.localStorage.removeItem(AUTH_CACHE_KEY);
      installFakeApiCache(window);

      const meds = [{ id: 7, name: 'B12' }];
      const loadCacheSpy = vi.fn().mockResolvedValue({
        data: meds,
        timestamp: Date.now() - 30_000
      });
      window.MedTrackerDB.MedicationStore = { loadCache: loadCacheSpy };

      await window.hydrateMedicationsFromDexie();

      expect(loadCacheSpy).toHaveBeenCalledTimes(1);
      expect(await window.DataStore.getCached('medications')).toEqual(meds);
    } finally {
      cleanup();
    }
  });

  it('is a no-op when Dexie is empty (loader returns null)', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      setAuthCache(window);
      const { cacheMap } = installFakeApiCache(window);

      const loadCacheSpy = vi.fn().mockResolvedValue(null);
      window.MedTrackerDB.MedicationStore = { loadCache: loadCacheSpy };

      await window.hydrateMedicationsFromDexie();

      expect(loadCacheSpy).toHaveBeenCalledTimes(1);
      expect(cacheMap.has('medications')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('does not throw when the Dexie loader rejects — auth flow is never blocked', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      setAuthCache(window);
      installFakeApiCache(window);

      const loadCacheSpy = vi.fn().mockRejectedValue(new Error('IndexedDB unavailable'));
      window.MedTrackerDB.MedicationStore = { loadCache: loadCacheSpy };

      // Should not throw.
      await expect(window.hydrateMedicationsFromDexie()).resolves.toBeUndefined();
      expect(loadCacheSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });
});
