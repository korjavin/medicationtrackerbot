import { beforeEach, describe, expect, it } from 'vitest';
import { loadDataStoreEnv } from './helpers/data-store-harness.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowConsoleNoise } from './helpers/setup.js';

// Task 5 — features/food.js now writes the `food_<date>_v2` row with the
// `food` tag (via setCachedWithTags) and uses `CacheKeys.dayFoodKey(date)`
// as the cachedFetch key. Combined with the family-tag registration that
// boots in `CacheKeys.registerAll`, any `invalidateTags(['food'])` must
// evict every food_-prefixed concrete row — v2 backups included.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CACHE_KEYS_JS = path.join(REPO_ROOT, 'web/static/js/core/cache-keys.js');

function loadCacheKeys(window) {
  const src = fs.readFileSync(CACHE_KEYS_JS, 'utf8');
  window.eval(`${src}\n//# sourceURL=file://${CACHE_KEYS_JS}`);
}

describe('food cache keys + family-tag invalidation', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  it('CacheKeys.dayFoodKey(date) returns the `food_<date>_day` family key', () => {
    const { window, cleanup } = loadDataStoreEnv({});
    try {
      loadCacheKeys(window);
      expect(window.CacheKeys.dayFoodKey('2026-05-14')).toBe('food_2026-05-14_day');
      // Tag lookup for the dynamic family.
      expect(window.CacheKeys.tagFor('food_2026-05-14_day')).toBe('food');
    } finally {
      cleanup();
    }
  });

  it('invalidateTags([food]) evicts every food_-prefixed row including v2', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv({
      initialCache: {
        food_2026_05_14_day: { groups: [{ id: 1 }] },
        food_2026_05_14_v2: { groups: [{ id: 1 }], weekStats: { calories: 1800 } },
        food_2026_05_13_day: { groups: [{ id: 2 }] },
        food_2026_05_13_v2: { groups: [{ id: 2 }], weekStats: { calories: 1900 } },
        bp: { keep: true }
      }
    });

    try {
      loadCacheKeys(window);
      // Mirror bootstrap: wire registry families + static tags into DataStore.
      window.CacheKeys.registerAll(window.DataStore);

      await window.DataStore.invalidateTags(['food']);

      // Both shapes (the canonical `_day` and the legacy `_v2` SWR backup)
      // share the `food_` family prefix and must evict together.
      expect(cacheMap.has('food_2026_05_14_day')).toBe(false);
      expect(cacheMap.has('food_2026_05_14_v2')).toBe(false);
      expect(cacheMap.has('food_2026_05_13_day')).toBe(false);
      expect(cacheMap.has('food_2026_05_13_v2')).toBe(false);
      // Unrelated keys must stay.
      expect(cacheMap.has('bp')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('setCachedWithTags(food_<date>_v2, ..., [food]) lets the tag invalidate the row', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv({});

    try {
      loadCacheKeys(window);
      window.CacheKeys.registerAll(window.DataStore);

      const v2Key = 'food_2026-05-14_v2';
      const dayKey = window.CacheKeys.dayFoodKey('2026-05-14');

      await window.DataStore.setCachedWithTags(v2Key, { groups: [{ id: 1 }], weekStats: { calories: 1800 } }, ['food']);
      await window.DataStore.setCachedWithTags(dayKey, { groups: [{ id: 1 }] }, ['food']);
      expect(cacheMap.has(v2Key)).toBe(true);
      expect(cacheMap.has(dayKey)).toBe(true);

      await window.DataStore.invalidateTags(['food']);

      expect(cacheMap.has(v2Key)).toBe(false);
      expect(cacheMap.has(dayKey)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('clearCached(todayFoodKey(now)) still works alongside family-tag eviction', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv({
      initialCache: {
        'food_2026-05-14_day': { groups: [{ id: 1 }] },
        'food_2026-05-13_day': { groups: [{ id: 2 }] }
      }
    });

    try {
      loadCacheKeys(window);
      window.CacheKeys.registerAll(window.DataStore);

      // Direct clearCached path used by food.js saveFoodLog as a belt-and-
      // suspenders eviction (independent of tag-family invalidation).
      const todayKey = window.CacheKeys.dayFoodKey('2026-05-14');
      await window.DataStore.clearCached(todayKey);

      expect(cacheMap.has('food_2026-05-14_day')).toBe(false);
      expect(cacheMap.has('food_2026-05-13_day')).toBe(true);
    } finally {
      cleanup();
    }
  });
});
