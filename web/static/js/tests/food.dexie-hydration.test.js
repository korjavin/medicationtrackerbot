// Task 5 of the offline-sections-sweep plan — the Food daily-log + products
// picker must paint hydrated cache as the synchronous first paint when Dexie
// pre-populated the api_cache rows. After `hydrateSectionsFromDexie` runs at
// cold start, opening the Food screen offline should render the cached meal
// groups + "Offline · …" stale chip, and the products picker should return
// the cached product list. Conversely, a cold start with neither a hydration
// nor a Dexie row must show the explicit "No cached food data" empty state
// (daily log) and an empty product cache (picker).
//
// The Food section already routes /api/food/log through `cachedFetch` which
// reads ApiCache (Dexie) directly, so the gap closed here is the seed:
// `hydrateSectionsFromDexie` now adds today's `food_<date>_day` entry so any
// caller using `DataStore.getCached(...)` (or anything reading the in-memory
// cache before `loadFoodLogs()` runs) sees the warmed row.

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

const AUTH_CACHE_KEY = 'medtracker_auth_state';

function setAuthCache(window) {
    window.localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({
        authenticated: true,
        authMethod: 'cookie',
        timestamp: Date.now(),
        ttl: 30 * 24 * 60 * 60 * 1000
    }));
}

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
        async setWithMeta(key, data, timestamp) {
            map.set(key, { id: key, timestamp, data });
        },
        async clear(key) {
            if (key) map.delete(key);
            else map.clear();
        }
    };
    window.cacheApiSnapshot = async (key, value) => {
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

function todaysFoodKey(window) {
    return window.todayFoodKey(new Date());
}

describe('Food cold-start Dexie hydration (Task 5)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('seeds DataStore.getCached(`food_<today>_day`) from the Dexie api_cache row', async () => {
        const { window } = env;
        setAuthCache(window);
        const key = todaysFoodKey(window);
        const cachedAt = Date.now() - 30 * 60 * 1000; // 30 min ago
        const cachedPayload = {
            groups: [{
                name: 'Breakfast',
                time: '08:00',
                calories: 320,
                carbs: 50,
                protein: 12,
                fat: 6,
                logs: [{ id: 1, name: 'Oatmeal', weight: 200, calories: 320, carbs: 50, protein: 12, fat: 6 }]
            }]
        };
        installApiCacheMap(window, {
            [key]: { data: cachedPayload, timestamp: cachedAt }
        });

        await window.hydrateSectionsFromDexie();

        const seeded = await window.DataStore.getCached(key);
        expect(seeded).toEqual(cachedPayload);
    });

    it('renders cached meal groups + offline stale chip on cold-start-offline relaunch', async () => {
        const { window, document } = env;
        setAuthCache(window);
        installCachedFetch(window);

        const key = todaysFoodKey(window);
        const dateStr = key.replace(/^food_/, '').replace(/_day$/, '');
        const cachedAt = Date.now() - 90 * 60 * 1000; // 90 min ago
        const cachedGroups = [{
            name: 'Lunch',
            time: '12:30',
            calories: 540,
            carbs: 60,
            protein: 28,
            fat: 18,
            logs: [{ id: 9, name: 'Soup', weight: 300, calories: 540, carbs: 60, protein: 28, fat: 18 }]
        }];
        installApiCacheMap(window, {
            [key]: { data: { groups: cachedGroups }, timestamp: cachedAt }
        });

        await window.hydrateSectionsFromDexie();

        // Hydration seeded the in-memory cache — verify before the loader runs.
        const seeded = await window.DataStore.getCached(key);
        expect(seeded).toEqual({ groups: cachedGroups });

        // Now simulate the Food screen mount while offline.
        const dateFilter = document.getElementById('food-date-filter');
        dateFilter.value = dateStr;
        setOnline(window, false);
        window.loadFoodTargets = async () => {};
        // Bypass the legacy v2 cache so the cachedFetch path is the only thing
        // producing the rendered groups (mirrors food.offline-cached-fetch.test.js).
        window.DataStore.getCached = async () => null;
        window.DataStore.setCached = async () => {};
        window.apiCall = vi.fn();
        window.apiCallDirect = vi.fn();

        await window.loadFoodLogs();

        // No live network was attempted while offline.
        expect(window.apiCallDirect).not.toHaveBeenCalled();

        const list = document.getElementById('food-list');
        const groupHeader = list.querySelector('.wg-food-meal-group__title');
        expect(groupHeader).not.toBeNull();
        expect(groupHeader.textContent).toContain('Lunch');

        // Offline stale chip surfaces the original write timestamp, not now.
        const slot = document.getElementById('food-stale-badge');
        expect(slot).not.toBeNull();
        expect(slot.classList.contains('hidden')).toBe(false);
        const badge = slot.querySelector('.wg-stale-badge');
        expect(badge).not.toBeNull();
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
        // 90m old → "Offline · 1h old" (formatAge truncates hours).
        expect(badge.textContent).toMatch(/^Offline · 1h old$/);
    });

    it('shows the "No cached food data" empty state when Dexie is empty and offline', async () => {
        allowConsoleNoise();
        const { window, document } = env;
        setAuthCache(window);
        installCachedFetch(window);
        installApiCacheMap(window, {});

        await window.hydrateSectionsFromDexie();

        // Pre-set the date so loadFoodLogs takes the deterministic branch.
        const dateFilter = document.getElementById('food-date-filter');
        const key = todaysFoodKey(window);
        dateFilter.value = key.replace(/^food_/, '').replace(/_day$/, '');
        setOnline(window, false);
        window.loadFoodTargets = async () => {};
        window.DataStore.getCached = async () => null;
        window.DataStore.setCached = async () => {};
        window.apiCall = vi.fn();
        window.apiCallDirect = vi.fn();

        await window.loadFoodLogs();

        const list = document.getElementById('food-list');
        expect(list.textContent).toBe('No cached food data — connect to load.');
        expect(list.querySelector('.wg-food-meal-group')).toBeNull();
    });

    it('hydration is a no-op when no Dexie row exists for the today-food key', async () => {
        const { window } = env;
        setAuthCache(window);
        installApiCacheMap(window, {});

        await window.hydrateSectionsFromDexie();

        const key = todaysFoodKey(window);
        expect(await window.DataStore.getCached(key)).toBeNull();
    });

    it('initFoodProductsCache resolves cached products via cachedFetch on cold-start-offline', async () => {
        const { window } = env;
        setAuthCache(window);
        installCachedFetch(window);

        const cachedAt = Date.now() - 60 * 60 * 1000; // 1h ago
        installApiCacheMap(window, {
            food_products_cache: {
                data: [{ id: 1, name: 'Apple' }, { id: 2, name: 'Banana' }],
                timestamp: cachedAt
            }
        });

        // FoodProductsStore short-circuit cleared so the cachedFetch path runs.
        const saveCache = vi.fn().mockResolvedValue(undefined);
        window.MedTrackerDB.FoodProductsStore = {
            getCache: vi.fn().mockResolvedValue(null),
            saveCache,
            clearCache: vi.fn().mockResolvedValue(undefined),
            CACHE_TTL: 7 * 24 * 60 * 60 * 1000
        };

        await window.hydrateSectionsFromDexie();

        setOnline(window, false);
        window.apiCall = vi.fn();
        window.apiCallDirect = vi.fn();

        await window.initFoodProductsCache();

        // No live network was attempted (we are offline); cachedFetch resolved
        // from the warm api_cache entry.
        expect(window.apiCallDirect).not.toHaveBeenCalled();
        expect(saveCache).toHaveBeenCalledTimes(1);
        const persisted = saveCache.mock.calls[0][0];
        expect(Array.isArray(persisted)).toBe(true);
        const names = persisted.map((p) => p.name).sort();
        expect(names).toEqual(['Apple', 'Banana']);
    });

    it('initFoodProductsCache falls back to an empty list when offline + no cache (OfflineNoCacheError swallowed)', async () => {
        const { window } = env;
        setAuthCache(window);
        installCachedFetch(window);
        installApiCacheMap(window, {});

        const saveCache = vi.fn().mockResolvedValue(undefined);
        window.MedTrackerDB.FoodProductsStore = {
            getCache: vi.fn().mockResolvedValue(null),
            saveCache,
            clearCache: vi.fn().mockResolvedValue(undefined),
            CACHE_TTL: 7 * 24 * 60 * 60 * 1000
        };

        await window.hydrateSectionsFromDexie();

        setOnline(window, false);
        window.apiCall = vi.fn();
        window.apiCallDirect = vi.fn();

        // Must not throw OfflineNoCacheError out to the caller.
        await expect(window.initFoodProductsCache()).resolves.toBeUndefined();

        // No products to persist when the picker has no cache.
        expect(saveCache).not.toHaveBeenCalled();
    });

    it('skips hydration when no auth presence — Dexie loader is never called for the food key', async () => {
        const { window } = env;
        // Explicit clear of any prior auth cache.
        window.localStorage.removeItem(AUTH_CACHE_KEY);
        const key = todaysFoodKey(window);
        installApiCacheMap(window, {
            [key]: { data: { groups: [] }, timestamp: Date.now() - 60_000 }
        });
        const getMetaSpy = vi.spyOn(window.MedTrackerDB.ApiCache, 'getWithMeta');

        await window.hydrateSectionsFromDexie();

        expect(getMetaSpy).not.toHaveBeenCalled();
    });

    it('does not throw when ApiCache.getWithMeta rejects for the food key', async () => {
        allowConsoleNoise();
        const { window } = env;
        setAuthCache(window);
        window.MedTrackerDB = window.MedTrackerDB || {};
        window.MedTrackerDB.ApiCache = {
            async getWithMeta() { throw new Error('IndexedDB unavailable'); },
            async get() { return null; },
            async set() {},
            async setWithMeta() {},
            async clear() {}
        };

        await expect(window.hydrateSectionsFromDexie()).resolves.toBeUndefined();
    });
});
