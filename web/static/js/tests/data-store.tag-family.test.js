import { beforeEach, describe, expect, it } from 'vitest';
import { loadDataStoreEnv } from './helpers/data-store-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

describe('data-store.js tag-family invalidation', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  it('registerTagFamily lets invalidateByTag evict every prefix-matching key', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv({
      initialCache: {
        history_7_: { days: 7 },
        history_30_42: { days: 30, medId: 42 },
        history_30_99: { days: 30, medId: 99 },
        unrelated: { keep: true }
      }
    });

    try {
      window.DataStore.registerTagFamily('history_', 'history');

      await window.DataStore.invalidateTags(['history']);

      expect(cacheMap.has('history_7_')).toBe(false);
      expect(cacheMap.has('history_30_42')).toBe(false);
      expect(cacheMap.has('history_30_99')).toBe(false);
      expect(cacheMap.has('unrelated')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('food-day family invalidation evicts today + yesterday concrete keys', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv({
      initialCache: {
        food_2026_05_14_day: { groups: [{ id: 1 }] },
        food_2026_05_13_day: { groups: [{ id: 2 }] },
        food_products_cache: { products: ['unchanged'] },
        bp: { keep: true }
      }
    });

    try {
      window.DataStore.registerTagFamily('food_', 'food');
      window.DataStore.registerTags('food_products_cache', ['food']);
      window.DataStore.registerTags('bp', ['bp']);

      await window.DataStore.invalidateTags(['food']);

      expect(cacheMap.has('food_2026_05_14_day')).toBe(false);
      expect(cacheMap.has('food_2026_05_13_day')).toBe(false);
      expect(cacheMap.has('food_products_cache')).toBe(false);
      expect(cacheMap.has('bp')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('family invalidation bumps generation so in-flight fetches cannot re-cache', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv({
      initialCache: { history_7_: { stale: true } }
    });

    try {
      window.DataStore.registerTagFamily('history_', 'history');

      let resolveFetch;
      const pending = new Promise((resolve) => { resolveFetch = resolve; });
      const fetchPromise = window.DataStore.fetchFresh(
        'history_7_',
        () => pending,
        ['history']
      );

      // Invalidate the family while the fetch is still in flight.
      await window.DataStore.invalidateTags(['history']);
      expect(cacheMap.has('history_7_')).toBe(false);

      // Resolve the abandoned fetch. The cache must NOT be repopulated with
      // its payload — the generation counter bump signals "superseded".
      resolveFetch({ fromInFlight: 'should not survive' });
      const result = await fetchPromise;
      expect(result).toBeNull();
      expect(cacheMap.has('history_7_')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('CacheKeys.registerAll wires every registered family into invalidateByTag', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv({
      initialCache: {
        history_7_: { v: 1 },
        food_2026_05_14_day: { v: 2 },
        health_overview_Europe_Berlin: { v: 3 }
      }
    });

    try {
      // Mirror what bootstrap.js does at boot.
      const families = [
        { prefix: 'history_', tag: 'history' },
        { prefix: 'food_', tag: 'food' },
        { prefix: 'health_overview_', tag: 'health' }
      ];
      families.forEach(({ prefix, tag }) => {
        window.DataStore.registerTagFamily(prefix, tag);
      });

      await window.DataStore.invalidateTags(['health']);
      expect(cacheMap.has('history_7_')).toBe(true);
      expect(cacheMap.has('food_2026_05_14_day')).toBe(true);
      expect(cacheMap.has('health_overview_Europe_Berlin')).toBe(false);

      await window.DataStore.invalidateTags(['food']);
      expect(cacheMap.has('food_2026_05_14_day')).toBe(false);
      expect(cacheMap.has('history_7_')).toBe(true);

      await window.DataStore.invalidateTags(['history']);
      expect(cacheMap.has('history_7_')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('family-prefix sweep exempts static-registered keys whose tag differs', async () => {
    // food_targets shares the food_ family prefix but is registered with
    // tag=null because it's overwritten on save, not invalidated by the food
    // family. invalidateTags(['food']) must keep it intact while still
    // evicting the per-day food log keys.
    const { window, cacheMap, cleanup } = loadDataStoreEnv({
      initialCache: {
        food_2026_05_14_day: { groups: [{ id: 1 }] },
        food_targets: { calories: 2000, protein: 150 }
      }
    });

    try {
      window.CacheKeys = {
        static: {
          food_targets: { key: 'food_targets', tag: null },
          food_products_cache: { key: 'food_products_cache', tag: 'food' }
        }
      };
      window.DataStore.registerTagFamily('food_', 'food');

      await window.DataStore.invalidateTags(['food']);

      expect(cacheMap.has('food_2026_05_14_day')).toBe(false);
      expect(cacheMap.has('food_targets')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('registered-key + family invalidation bumps generation BEFORE the family-prefix scan await', async () => {
    // Regression: previously the generation bump for explicitly-registered
    // keys ran AFTER awaiting apiCache.keys(prefix). A fetchFresh whose
    // fetcher resolved during that await could see the un-bumped generation,
    // pass its supersede check, and re-cache stale data.
    //
    // Forcing the interleave requires apiCache.keys() to be genuinely
    // pending while we resolve the fetcher — otherwise JS microtask
    // ordering lets the buggy version's continuation run its gen-bump loop
    // synchronously after the (already-resolved) keys() await, so the bug
    // is masked and the test passes against both implementations.
    const { window, cacheMap, cleanup } = loadDataStoreEnv({
      initialCache: { food_2026_05_14_day: { v: 1 } }
    });

    try {
      window.DataStore.registerTags('food_products_cache', ['food']);
      window.DataStore.registerTagFamily('food_', 'food');

      let resolveFetch;
      const pending = new Promise((resolve) => { resolveFetch = resolve; });
      const fetchPromise = window.DataStore.fetchFresh(
        'food_products_cache',
        () => pending,
        ['food']
      );

      // Suspend the family-prefix scan: apiCache.keys() now blocks on a
      // gate we control. While suspended, the only way for fetchFresh's
      // resolution to detect the supersede is if Phase 1 (the synchronous
      // gen-bump for explicitly-registered keys) already ran before the
      // await on apiCache.keys().
      const apiCache = window.MedTrackerDB.ApiCache;
      const realKeys = apiCache.keys.bind(apiCache);
      let releaseKeys;
      const keysGate = new Promise((resolve) => { releaseKeys = resolve; });
      apiCache.keys = async (prefix) => {
        await keysGate;
        return realKeys(prefix);
      };

      const invalidationPromise = window.DataStore.invalidateTags(['food']);

      // Resolve the in-flight fetcher while the family-prefix scan is
      // still suspended on keysGate. With the fix in place, Phase 1 has
      // already bumped food_products_cache's generation, so fetchFresh
      // returns null and skips the cache write. Without the fix, the
      // gen-bump only happens after we release keysGate — so the fetcher
      // would observe the original generation and poison the cache.
      resolveFetch({ products: ['stale-from-inflight'] });

      const fetchResult = await fetchPromise;
      expect(fetchResult).toBeNull();
      expect(cacheMap.has('food_products_cache')).toBe(false);

      releaseKeys();
      await invalidationPromise;

      expect(cacheMap.has('food_products_cache')).toBe(false);
      expect(cacheMap.has('food_2026_05_14_day')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('invalidateByTag is a no-op when neither registered keys nor families exist', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv({
      initialCache: { lingering: { v: 1 } }
    });

    try {
      await window.DataStore.invalidateTags(['nonexistent']);
      expect(cacheMap.has('lingering')).toBe(true);
    } finally {
      cleanup();
    }
  });
});
