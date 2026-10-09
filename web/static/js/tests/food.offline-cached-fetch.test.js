// Food daily-log + product-cache reads are vault-served through apiCall.
//
// loadFoodLogs() routes /api/food/log through apiCall, which the cloud shim
// answers from the local vault — authoritative whether online or offline.
// initFoodProductsCache() likewise serves /api/food/products via apiCall and
// persists the result into FoodProductsStore for the fast path.
//
// Pins:
//   - offline renders the apiCall-served groups (no network needed);
//   - the authoritative apiCall payload wins over a stale v2 render;
//   - an apiCall failure renders the empty state without throwing;
//   - initFoodProductsCache persists apiCall products, and falls back to an
//     empty list when apiCall returns null.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

function setOnline(window, online) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => online
  });
}

const GROUPS = [
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

describe('Food loadFoodLogs() vault-served reads', () => {
  let env;

  beforeEach(() => {
    env = loadFrontendEnv();
    const { document } = env;

    // Pre-set the date so loadFoodLogs takes the deterministic branch.
    const dateFilter = document.getElementById('food-date-filter');
    dateFilter.value = '2026-05-09';

    env.window.loadFoodTargets = async () => {};
    env.window.DataStore.getCached = async () => null;
    env.window.DataStore.setCached = async () => {};
  });

  afterEach(() => {
    try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
    env.cleanup();
    env = null;
  });

  it('renders apiCall-served groups when offline (vault read, no network)', async () => {
    const { window, document } = env;

    setOnline(window, false);
    const apiSpy = vi.fn(async (url) => {
      if (url.startsWith('/api/food/log?')) return GROUPS;
      return null; // weekly stats fetch — OK to return undefined
    });
    window.apiCall = apiSpy;

    await window.loadFoodLogs();

    expect(apiSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/food/log?date=2026-05-09'), 'GET');

    const list = document.getElementById('food-list');
    const groupHeader = list.querySelector('.wg-food-meal-group__title');
    expect(groupHeader).not.toBeNull();
    expect(groupHeader.textContent).toContain('Breakfast');
    const logRow = list.querySelector('.wg-food-item-row');
    expect(logRow).not.toBeNull();
  });

  it('replaces a stale v2 render with the authoritative apiCall payload', async () => {
    const { window, document } = env;

    // Legacy v2 cache renders first (stale-while-revalidate); the apiCall
    // payload then wins.
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

    setOnline(window, true);
    window.apiCall = vi.fn(async (url) => {
      if (url.startsWith('/api/food/log?')) return GROUPS;
      return null;
    });

    await window.loadFoodLogs();

    const list = document.getElementById('food-list');
    // The v2 "Lunch" render was replaced by the authoritative "Breakfast".
    expect(list.textContent).toContain('Breakfast');
    expect(list.textContent).not.toContain('Lunch');
    const groupHeader = list.querySelector('.wg-food-meal-group__title');
    expect(groupHeader).not.toBeNull();
    expect(groupHeader.textContent).toContain('Breakfast');
  });

  it('renders the empty state when apiCall returns null (no throw)', async () => {
    const { window, document } = env;

    setOnline(window, false);
    window.apiCall = vi.fn(async () => null);

    await window.loadFoodLogs();

    const list = document.getElementById('food-list');
    expect(list.textContent).toBe('No food logs for this day.');
    expect(list.querySelector('.wg-food-meal-group')).toBeNull();
  });

  it('renders the error state when apiCall throws and no cache was rendered', async () => {
    allowConsoleNoise(); // the catch logs via console.error by design
    const { window, document } = env;

    setOnline(window, true);
    window.apiCall = vi.fn(async () => { throw new Error('boom'); });

    await window.loadFoodLogs();

    const list = document.getElementById('food-list');
    const err = list.querySelector('.wg-error');
    expect(err).not.toBeNull();
    expect(err.textContent).toContain('Failed to load food logs.');
    expect(err.querySelector('button').textContent).toBe('Retry');
  });
});

describe('Food initFoodProductsCache() vault-served reads', () => {
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

  it('populates products via apiCall and persists them to FoodProductsStore', async () => {
    const { window } = env;

    window.apiCall = vi.fn(async () => ({
      products: [{ id: 1, name: 'Apple' }, { id: 2, name: 'Banana' }]
    }));

    // Force the slow path by clearing the FoodProductsStore short-circuit.
    const store = installFoodProductsStore(window, { initial: null });

    await window.initFoodProductsCache();

    expect(window.apiCall).toHaveBeenCalledWith('/api/food/products', 'GET');
    expect(store.saveCache).toHaveBeenCalledTimes(1);
    const persisted = store.saveCache.mock.calls[0][0];
    expect(Array.isArray(persisted)).toBe(true);
    const names = persisted.map((p) => p.name).sort();
    expect(names).toEqual(['Apple', 'Banana']);
    expect(window.FoodProducts.cache.map((p) => p.name).sort()).toEqual(['Apple', 'Banana']);
  });

  it('falls back to an empty list when apiCall returns null', async () => {
    const { window } = env;

    window.apiCall = vi.fn(async () => null);

    const store = installFoodProductsStore(window, { initial: null });

    // Must not throw.
    await expect(window.initFoodProductsCache()).resolves.toBeUndefined();

    // No products to persist, so saveCache is not invoked.
    expect(store.saveCache).not.toHaveBeenCalled();
    expect(window.FoodProducts.cache).toEqual([]);
  });
});
