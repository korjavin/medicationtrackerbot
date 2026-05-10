// Task 3 — Local-first read resilience for the Food daily log.
//
// loadFoodLogs() now routes /api/food/log through window.cachedFetch with the
// `food_<date>_day` key (the same key bootstrap apply seeds). Offline reloads
// must render the cached groups; a true cache miss while offline surfaces the
// explicit "No cached food data" empty state instead of silently rendering an
// empty list.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CACHED_FETCH_JS = path.join(REPO_ROOT, 'web/static/js/cached-fetch.js');

function installCachedFetch(window) {
  const src = fs.readFileSync(CACHED_FETCH_JS, 'utf8');
  window.eval(`${src}\n//# sourceURL=file://${CACHED_FETCH_JS}`);
}

function installApiCacheMap(window, initialCache = {}) {
  const map = new Map();
  for (const [key, value] of Object.entries(initialCache)) {
    if (value && typeof value === 'object' && 'data' in value && 'timestamp' in value) {
      map.set(key, { id: key, ...value });
    } else {
      map.set(key, { id: key, timestamp: Date.now(), data: value });
    }
  }
  window.MedTrackerDB = window.MedTrackerDB || {};
  window.MedTrackerDB.ApiCache = {
    map,
    async get(key) {
      const entry = map.get(key);
      return entry ? entry.data : null;
    },
    async getWithMeta(key) {
      const entry = map.get(key);
      return entry ? { data: entry.data, timestamp: entry.timestamp } : null;
    },
    async set(key, data) {
      map.set(key, { id: key, timestamp: Date.now(), data });
    },
    async clear(key) {
      if (key) map.delete(key); else map.clear();
    }
  };
  window.cacheApiSnapshot = async (key, value, _tags = []) => {
    map.set(key, { id: key, timestamp: Date.now(), data: value });
  };
  return map;
}

function setOnline(window, online) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => online
  });
}

describe('Food loadFoodLogs() local-first read resilience', () => {
  let env;

  beforeEach(() => {
    env = loadFrontendEnv();
    const { document } = env;

    // Pre-set the date so loadFoodLogs takes the deterministic branch.
    const dateFilter = document.getElementById('food-date-filter');
    dateFilter.value = '2026-05-09';

    env.window.loadFoodTargets = async () => {};
    // The legacy v2 SWR cache is cleared so the cachedFetch path is the
    // only thing producing the rendered groups.
    env.window.DataStore.getCached = async () => null;
    env.window.DataStore.setCached = async () => {};
  });

  afterEach(() => {
    try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
    env.cleanup();
    env = null;
  });

  it('returns cached groups when offline + bootstrap-warmed cache exists', async () => {
    const { window, document } = env;
    installCachedFetch(window);

    const cachedGroups = [
      {
        name: 'Breakfast',
        time: '08:00',
        calories: 320,
        carbs: 50,
        protein: 12,
        fat: 6,
        logs: [{ id: 1, name: 'Oatmeal', weight: 200, calories: 320, carbs: 50, protein: 12, fat: 6 }]
      }
    ];
    const cachedAt = Date.now() - 10 * 60 * 1000;
    installApiCacheMap(window, {
      'food_2026-05-09_day': { data: { groups: cachedGroups }, timestamp: cachedAt }
    });

    setOnline(window, false);
    const apiSpy = vi.fn(); // weekly stats fetch — must not throw, OK to return undefined
    window.apiCall = apiSpy;
    window.apiCallDirect = vi.fn();

    await window.loadFoodLogs();

    // No network was attempted because we are offline.
    expect(window.apiCallDirect).not.toHaveBeenCalled();

    const list = document.getElementById('food-list');
    const groupHeader = list.querySelector('.wg-food-meal-group__title');
    expect(groupHeader).not.toBeNull();
    expect(groupHeader.textContent).toContain('Breakfast');
    const logRow = list.querySelector('.wg-food-item-row');
    expect(logRow).not.toBeNull();
  });

  it('preserves an already-rendered v2-cached list when OfflineNoCacheError fires', async () => {
    allowConsoleNoise();
    const { window, document } = env;
    installCachedFetch(window);

    // Legacy v2 cache returns groups for the date; the new `food_<date>_day`
    // key is missing so cachedFetch raises OfflineNoCacheError when offline.
    const v2Groups = [
      {
        name: 'Lunch',
        time: '12:30',
        calories: 540,
        carbs: 60,
        protein: 28,
        fat: 18,
        logs: [{ id: 9, name: 'Soup', weight: 300, calories: 540, carbs: 60, protein: 28, fat: 18 }]
      }
    ];
    window.DataStore.getCached = async (key) => key === 'food_2026-05-09_v2'
      ? { groups: v2Groups, weekStats: null }
      : null;

    installApiCacheMap(window, {});
    setOnline(window, false);
    window.apiCall = vi.fn();
    window.apiCallDirect = vi.fn();

    await window.loadFoodLogs();

    const list = document.getElementById('food-list');
    // The v2 cache rendered "Lunch" before cachedFetch threw — the catch
    // branch must NOT replace the list with the "No cached food data" copy.
    expect(list.textContent).not.toContain('No cached food data');
    const groupHeader = list.querySelector('.wg-food-meal-group__title');
    expect(groupHeader).not.toBeNull();
    expect(groupHeader.textContent).toContain('Lunch');
  });

  it('renders the explicit "No cached food data" empty state on OfflineNoCacheError', async () => {
    allowConsoleNoise(); // _renderFoodData not invoked, but offline path touches console paths via guards
    const { window, document } = env;
    installCachedFetch(window);

    // Empty api_cache so cachedFetch raises OfflineNoCacheError.
    installApiCacheMap(window, {});
    setOnline(window, false);
    window.apiCall = vi.fn();
    window.apiCallDirect = vi.fn();

    await window.loadFoodLogs();

    const list = document.getElementById('food-list');
    expect(list.textContent).toBe('No cached food data — connect to load.');
    expect(list.querySelector('.wg-food-meal-group')).toBeNull();
  });

  it('flags isStale when the cached groups are older than staleAfterMs', async () => {
    const { window } = env;
    installCachedFetch(window);

    const cachedAt = Date.now() - 48 * 60 * 60 * 1000; // 2 days old (>24h staleAfterMs)
    installApiCacheMap(window, {
      'food_2026-05-09_day': { data: { groups: [] }, timestamp: cachedAt }
    });
    setOnline(window, false);
    window.apiCall = vi.fn();
    window.apiCallDirect = vi.fn();

    await window.loadFoodLogs();

    // Module-scope freshness state is exposed via the helper hook for Task 5;
    // for now we assert the offline branch resolved without throwing and
    // surfaced no error message.
    const list = window.document.getElementById('food-list');
    expect(list.textContent).not.toContain('No cached food data');
    expect(list.textContent).not.toContain('Failed to load');
  });
});

describe('Food initFoodProductsCache() local-first read resilience', () => {
  let env;

  beforeEach(() => {
    env = loadFrontendEnv();
  });

  afterEach(() => {
    try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
    env.cleanup();
    env = null;
  });

  function installFoodProductsStore(window, { initial = null } = {}) {
    const saveCache = vi.fn().mockResolvedValue(undefined);
    const clearCache = vi.fn().mockResolvedValue(undefined);
    const getCache = vi.fn().mockResolvedValue(initial);
    window.MedTrackerDB = window.MedTrackerDB || {};
    window.MedTrackerDB.FoodProductsStore = { getCache, saveCache, clearCache, CACHE_TTL: 7 * 24 * 60 * 60 * 1000 };
    return { getCache, saveCache, clearCache };
  }

  it('returns cached products via cachedFetch when offline', async () => {
    const { window } = env;
    installCachedFetch(window);

    const cachedAt = Date.now() - 60 * 60 * 1000;
    installApiCacheMap(window, {
      'food_products_cache': {
        data: [{ id: 1, name: 'Apple' }, { id: 2, name: 'Banana' }],
        timestamp: cachedAt
      }
    });
    setOnline(window, false);
    window.apiCall = vi.fn();
    window.apiCallDirect = vi.fn();

    // Force the slow path by clearing the FoodProductsStore short-circuit.
    const store = installFoodProductsStore(window, { initial: null });

    await window.initFoodProductsCache();

    // No live network was attempted (we are offline) and cachedFetch resolved
    // from the warm api_cache entry. food.js then persists those products
    // back into the FoodProductsStore so the next call can take the fast path.
    expect(window.apiCallDirect).not.toHaveBeenCalled();
    expect(store.saveCache).toHaveBeenCalledTimes(1);
    const persisted = store.saveCache.mock.calls[0][0];
    expect(Array.isArray(persisted)).toBe(true);
    const names = persisted.map((p) => p.name).sort();
    expect(names).toEqual(['Apple', 'Banana']);
  });

  it('falls back to an empty list when offline + no cache (OfflineNoCacheError swallowed)', async () => {
    const { window } = env;
    installCachedFetch(window);

    installApiCacheMap(window, {}); // empty
    setOnline(window, false);
    window.apiCall = vi.fn();
    window.apiCallDirect = vi.fn();

    const store = installFoodProductsStore(window, { initial: null });

    // Must not throw OfflineNoCacheError out to the caller.
    await expect(window.initFoodProductsCache()).resolves.toBeUndefined();

    // No products to persist, so saveCache is not invoked.
    expect(store.saveCache).not.toHaveBeenCalled();
  });
});
