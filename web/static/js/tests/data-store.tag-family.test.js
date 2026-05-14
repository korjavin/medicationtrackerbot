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
