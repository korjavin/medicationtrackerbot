import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCachedFetchEnv } from './helpers/cached-fetch-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

describe('cachedFetch — read-through helper', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  it('fresh-hit: returns cached data without waiting for the network round-trip', async () => {
    const now = Date.now();
    const cachedAt = now - 5_000;
    const { window, cleanup } = loadCachedFetchEnv({
      initialCache: { meds: { data: [{ id: 1 }], timestamp: cachedAt } }
    });

    try {
      // Hanging fetch — if the helper synchronously awaited it, this test
      // would deadlock instead of returning the cached payload.
      window.apiCallDirect = vi.fn(() => new Promise(() => {}));

      const result = await window.cachedFetch('meds', '/api/medications', {
        tags: ['medications'],
        freshAfterMs: 60_000,
        now
      });

      expect(result.data).toEqual([{ id: 1 }]);
      expect(result.isFromCache).toBe(true);
      expect(result.isStale).toBe(false);
      expect(result.fetchedAt).toBe(cachedAt);
    } finally {
      cleanup();
    }
  });

  it('SWR: fresh cache returns instantly and background fetch updates the store', async () => {
    const now = Date.now();
    const cachedAt = now - 1_000;
    const { window, cacheMap, cleanup } = loadCachedFetchEnv({
      initialCache: { meds: { data: [{ id: 1 }], timestamp: cachedAt } }
    });

    try {
      let resolveFetch;
      window.apiCallDirect = vi.fn(() => new Promise((resolve) => {
        resolveFetch = resolve;
      }));

      const result = await window.cachedFetch('meds', '/api/medications', {
        tags: ['medications'],
        freshAfterMs: 60_000,
        now
      });

      // Cached value returned immediately even though the network request
      // (kicked off in the background) is still pending.
      expect(result.data).toEqual([{ id: 1 }]);
      expect(result.isFromCache).toBe(true);

      // Drain any queued microtasks so the SWR worker reaches the network.
      for (let i = 0; i < 5 && window.apiCallDirect.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }
      expect(window.apiCallDirect).toHaveBeenCalledTimes(1);

      resolveFetch([{ id: 1 }, { id: 2 }]);
      // Drain microtasks until the cache reflects the new payload.
      for (let i = 0; i < 20 && cacheMap.get('meds').data.length === 1; i++) {
        await Promise.resolve();
      }

      expect(cacheMap.get('meds').data).toEqual([{ id: 1 }, { id: 2 }]);
    } finally {
      cleanup();
    }
  });

  it('cache miss + online: fetches, caches and returns fresh', async () => {
    const { window, cacheMap, cleanup } = loadCachedFetchEnv();

    try {
      window.apiCallDirect = vi.fn().mockResolvedValue({ groups: [{ name: 'lunch' }] });

      const result = await window.cachedFetch('food_2026-05-09_day', '/api/food/log?date=2026-05-09', {
        tags: ['food']
      });

      expect(window.apiCallDirect).toHaveBeenCalledWith('/api/food/log?date=2026-05-09', 'GET', null);
      expect(result.data).toEqual({ groups: [{ name: 'lunch' }] });
      expect(result.isFromCache).toBe(false);
      expect(result.isStale).toBe(false);
      expect(typeof result.fetchedAt).toBe('number');
      expect(cacheMap.get('food_2026-05-09_day').data).toEqual({ groups: [{ name: 'lunch' }] });
    } finally {
      cleanup();
    }
  });

  it('offline + cache hit: returns stale cache with isStale flag past staleAfterMs', async () => {
    const now = Date.now();
    const cachedAt = now - (2 * 60 * 60 * 1000); // 2h old
    const { window, cleanup } = loadCachedFetchEnv({
      online: false,
      initialCache: { bp: { data: { readingsRes: [{ systolic: 120 }] }, timestamp: cachedAt } }
    });

    try {
      const apiSpy = vi.fn();
      window.apiCallDirect = apiSpy;

      const result = await window.cachedFetch('bp', '/api/bp?days=30', {
        tags: ['bp'],
        freshAfterMs: 60_000,
        staleAfterMs: 60 * 60 * 1000, // 1h
        now
      });

      expect(apiSpy).not.toHaveBeenCalled();
      expect(result.data).toEqual({ readingsRes: [{ systolic: 120 }] });
      expect(result.isFromCache).toBe(true);
      expect(result.isStale).toBe(true);
      expect(result.fetchedAt).toBe(cachedAt);
    } finally {
      cleanup();
    }
  });

  it('offline + no cache: throws OfflineNoCacheError', async () => {
    const { window, cleanup } = loadCachedFetchEnv({ online: false });

    try {
      window.apiCallDirect = vi.fn();

      await expect(
        window.cachedFetch('food_2026-05-09_day', '/api/food/log?date=2026-05-09', {
          tags: ['food']
        })
      ).rejects.toBeInstanceOf(window.OfflineNoCacheError);

      // Confirm error metadata.
      try {
        await window.cachedFetch('food_2026-05-09_day', '/api/food/log?date=2026-05-09');
      } catch (err) {
        expect(err.name).toBe('OfflineNoCacheError');
        expect(err.key).toBe('food_2026-05-09_day');
      }
    } finally {
      cleanup();
    }
  });

  it('online but apiCall throws 5xx and no cache: throws OfflineNoCacheError', async () => {
    const { window, cleanup } = loadCachedFetchEnv();

    try {
      const err = new Error('Bad Gateway');
      err.status = 502;
      window.apiCallDirect = vi.fn().mockRejectedValue(err);

      await expect(
        window.cachedFetch('weight', '/api/weight?days=30', { tags: ['weight'] })
      ).rejects.toBeInstanceOf(window.OfflineNoCacheError);
    } finally {
      cleanup();
    }
  });

  it('online but apiCall throws 5xx with cache: returns cached + isStale based on age', async () => {
    const now = Date.now();
    const cachedAt = now - (30 * 60 * 1000); // 30 min old
    const { window, cleanup } = loadCachedFetchEnv({
      initialCache: { weight: { data: { logsRes: [{ weight: 70 }] }, timestamp: cachedAt } }
    });

    try {
      const err = new Error('Service Unavailable');
      err.status = 503;
      window.apiCallDirect = vi.fn().mockRejectedValue(err);

      const result = await window.cachedFetch('weight', '/api/weight?days=30', {
        tags: ['weight'],
        freshAfterMs: 60_000,
        staleAfterMs: 60 * 60 * 1000, // 1h — cache is younger so isStale stays false
        now
      });

      expect(result.data).toEqual({ logsRes: [{ weight: 70 }] });
      expect(result.isFromCache).toBe(true);
      expect(result.isStale).toBe(false);
      expect(result.fetchedAt).toBe(cachedAt);
    } finally {
      cleanup();
    }
  });

  it('online but apiCall throws TypeError (network failure): falls back to cache', async () => {
    const now = Date.now();
    const cachedAt = now - 10_000;
    const { window, cleanup } = loadCachedFetchEnv({
      initialCache: { meds: { data: [{ id: 9 }], timestamp: cachedAt } }
    });

    try {
      window.apiCallDirect = vi.fn().mockRejectedValue(new window.TypeError('Failed to fetch'));

      const result = await window.cachedFetch('meds', '/api/medications', {
        tags: ['medications'],
        freshAfterMs: 1, // force network attempt
        now
      });

      expect(result.data).toEqual([{ id: 9 }]);
      expect(result.isFromCache).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('non-network errors propagate to the caller', async () => {
    const { window, cleanup } = loadCachedFetchEnv();

    try {
      const err = new Error('Unauthorized');
      err.status = 401;
      window.apiCallDirect = vi.fn().mockRejectedValue(err);

      await expect(
        window.cachedFetch('settings_bundle', '/api/settings', { tags: ['settings'] })
      ).rejects.toThrow('Unauthorized');
    } finally {
      cleanup();
    }
  });

  it('uses cacheApiSnapshot when available so tag tracking is preserved', async () => {
    const { window, cleanup } = loadCachedFetchEnv();

    try {
      window.apiCallDirect = vi.fn().mockResolvedValue({ groups: [] });
      const snapshotSpy = vi.fn().mockResolvedValue(undefined);
      window.cacheApiSnapshot = snapshotSpy;

      await window.cachedFetch('food_2026-05-09_day', '/api/food/log?date=2026-05-09', {
        tags: ['food']
      });

      expect(snapshotSpy).toHaveBeenCalledWith('food_2026-05-09_day', { groups: [] }, ['food']);
    } finally {
      cleanup();
    }
  });

  it('applies the optional transform to the network response before caching', async () => {
    const { window, cacheMap, cleanup } = loadCachedFetchEnv();

    try {
      window.apiCallDirect = vi.fn().mockResolvedValue({ items: [1, 2, 3] });

      const result = await window.cachedFetch('items', '/api/items', {
        transform: (raw) => ({ count: raw.items.length })
      });

      expect(result.data).toEqual({ count: 3 });
      expect(cacheMap.get('items').data).toEqual({ count: 3 });
    } finally {
      cleanup();
    }
  });
});
