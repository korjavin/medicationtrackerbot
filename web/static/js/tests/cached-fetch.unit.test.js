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

  it('SWR for stale (online) cache hits: returns cached immediately and refreshes in background', async () => {
    const now = Date.now();
    const cachedAt = now - (5 * 60 * 1000); // 5 min old — older than freshAfterMs
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
        freshAfterMs: 60_000, // 1 min — cache is older
        staleAfterMs: 60 * 60 * 1000, // 1h — cache is younger, isStale should be false
        now
      });

      // Stale cache returned immediately (no waiting for network).
      expect(result.data).toEqual([{ id: 1 }]);
      expect(result.isFromCache).toBe(true);
      expect(result.isStale).toBe(false);

      for (let i = 0; i < 5 && window.apiCallDirect.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }
      expect(window.apiCallDirect).toHaveBeenCalledTimes(1);

      // Background revalidation lands and updates the cache.
      resolveFetch([{ id: 1 }, { id: 2 }]);
      for (let i = 0; i < 20 && cacheMap.get('meds').data.length === 1; i++) {
        await Promise.resolve();
      }
      expect(cacheMap.get('meds').data).toEqual([{ id: 1 }, { id: 2 }]);
    } finally {
      cleanup();
    }
  });

  it('drops the cache write when DataStore generation changes mid-flight (race guard)', async () => {
    const now = Date.now();
    const cachedAt = now - (10 * 60 * 1000); // 10 min old → triggers background fetch path
    const { window, cacheMap, cleanup } = loadCachedFetchEnv({
      initialCache: { meds: { data: [{ id: 1 }], timestamp: cachedAt } }
    });

    try {
      // Stub a DataStore.peekGeneration that simulates a mutation/invalidation
      // bumping the counter while our fetch is in flight.
      let gen = 0;
      window.DataStore = {
        peekGeneration: () => gen
      };

      let resolveFetch;
      window.apiCallDirect = vi.fn(() => new Promise((resolve) => {
        resolveFetch = resolve;
      }));

      const result = await window.cachedFetch('meds', '/api/medications', {
        tags: ['medications'],
        freshAfterMs: 60_000,
        now
      });

      // Cache returned immediately.
      expect(result.data).toEqual([{ id: 1 }]);

      // Drain microtasks so the background fetch starts (and captures gen=0).
      for (let i = 0; i < 5 && window.apiCallDirect.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }

      // Simulate a mutation/invalidation: bump generation BEFORE the fetch resolves.
      gen = 1;

      // The (now-superseded) network request finally returns. Its write must
      // be dropped — otherwise it would resurrect the stale payload.
      resolveFetch([{ id: 999 }]);
      for (let i = 0; i < 20; i++) await Promise.resolve();

      // Cache still holds the original cached value, NOT the stale fetch payload.
      expect(cacheMap.get('meds').data).toEqual([{ id: 1 }]);
    } finally {
      cleanup();
    }
  });

  it('drops the cache write when pending was active at fetch start, even if commit(null) clears it before the GET resolves', async () => {
    // Regression: cachedFetch checks pending state at BOTH start and end of
    // the fetch. Without the start-time guard, a GET launched during the
    // optimistic window could resolve after `handle.commit(null)` has run —
    // commit(null) decrements `pendingOptimistic` but does NOT bump
    // generation (no setCachedWithTags call), so a pending-at-end-only check
    // would write the stale pre-write payload into the optimistic cache.
    const now = Date.now();
    const cachedAt = now - (10 * 60 * 1000); // 10 min old → triggers SWR fetch
    const { window, cacheMap, cleanup } = loadCachedFetchEnv({
      initialCache: { next_intake: { data: { scheduled_at: null, medication_ids: [] }, timestamp: cachedAt } }
    });

    try {
      let pending = true;
      window.DataStore = {
        // Generation never moves — simulates the commit(null) path where the
        // server returns no body so setCachedWithTags is not invoked.
        peekGeneration: () => 5,
        hasPendingOptimistic: () => pending
      };

      let resolveFetch;
      window.apiCallDirect = vi.fn(() => new Promise((resolve) => {
        resolveFetch = resolve;
      }));

      const result = await window.cachedFetch('next_intake', '/api/medications/next-intake', {
        tags: ['history', 'medications'],
        freshAfterMs: 60_000,
        now
      });

      expect(result.data).toEqual({ scheduled_at: null, medication_ids: [] });

      // Drain microtasks so the background fetch captures startPending=true.
      for (let i = 0; i < 5 && window.apiCallDirect.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }

      // Simulate handle.commit(null): pending flips to false, but the cache
      // entry is unchanged (server returned no body) and generation is not
      // bumped.
      pending = false;

      // The (now-resolved) network request returns pre-write server state.
      // Because pending was active at the start of the fetch, the write
      // must drop even though pending is now false and gen is unchanged.
      resolveFetch({
        scheduled_at: '2026-05-17T10:00:00Z',
        medication_ids: [7],
        medication_names: ['Aspirin']
      });
      for (let i = 0; i < 20; i++) await Promise.resolve();

      expect(cacheMap.get('next_intake').data).toEqual({
        scheduled_at: null,
        medication_ids: []
      });
    } finally {
      cleanup();
    }
  });

  it('drops the cache write when a caller optimistic write is pending (no flicker)', async () => {
    // Regression: cachedFetch background revalidation must not overwrite the
    // optimistic cache with pre-write server state while the caller's POST is
    // still in flight. Generation-only guard misses this case because the
    // optimistic write bumps generation BEFORE cachedFetch starts (so startGen
    // == endGen).
    const now = Date.now();
    const cachedAt = now - (10 * 60 * 1000); // 10 min old → triggers SWR fetch
    const { window, cacheMap, cleanup } = loadCachedFetchEnv({
      initialCache: { next_intake: { data: { scheduled_at: null, medication_ids: [] }, timestamp: cachedAt } }
    });

    try {
      let pending = true;
      window.DataStore = {
        peekGeneration: () => 5,
        hasPendingOptimistic: () => pending
      };

      let resolveFetch;
      window.apiCallDirect = vi.fn(() => new Promise((resolve) => {
        resolveFetch = resolve;
      }));

      const result = await window.cachedFetch('next_intake', '/api/medications/next-intake', {
        tags: ['history', 'medications'],
        freshAfterMs: 60_000,
        now
      });

      // Cache (optimistic) returned immediately.
      expect(result.data).toEqual({ scheduled_at: null, medication_ids: [] });

      // Drain microtasks so the background fetch starts.
      for (let i = 0; i < 5 && window.apiCallDirect.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }

      // Pre-write server payload resolves while pendingOptimistic is still
      // truthy (caller's POST hasn't reached the server). Write must drop.
      resolveFetch({
        scheduled_at: '2026-05-17T10:00:00Z',
        medication_ids: [7],
        medication_names: ['Aspirin']
      });
      for (let i = 0; i < 20; i++) await Promise.resolve();

      expect(cacheMap.get('next_intake').data).toEqual({
        scheduled_at: null,
        medication_ids: []
      });
    } finally {
      cleanup();
    }
  });

  it('registers the key→tags mapping with DataStore before fetching so a mid-flight invalidation can find this key', async () => {
    // Cold-start scenario: cache is empty, no bootstrap has registered tags.
    // A mutation/invalidation racing with our GET must be able to bump the
    // generation for this key — otherwise the gen guard sees the same value
    // at start and end, and the (now-superseded) response gets cached.
    const { window, cleanup } = loadCachedFetchEnv();

    try {
      const registerSpy = vi.fn();
      const peekSpy = vi.fn().mockReturnValue(0);
      window.DataStore = {
        registerTags: registerSpy,
        peekGeneration: peekSpy
      };

      window.apiCallDirect = vi.fn().mockResolvedValue({ groups: [] });

      await window.cachedFetch('food_2026-05-09_day', '/api/food/log?date=2026-05-09', {
        tags: ['food']
      });

      // registerTags must have been called before the fetch resolved.
      expect(registerSpy).toHaveBeenCalledWith('food_2026-05-09_day', ['food']);
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
