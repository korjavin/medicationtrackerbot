// Task 5 of the offline-sections-sweep plan — cold-start Dexie hydration.
//
// `hydrateSectionsFromDexie` seeds today's `food_<date>_day` entry into the
// in-memory cache at cold start so any caller using `DataStore.getCached(...)`
// sees the warmed row. The Food screen itself reads vault-served data through
// apiCall: opening it offline renders the served meal groups + "Offline · …"
// stale chip, and the products picker resolves through the same seam.
// Conversely, a cold start where apiCall answers null shows the empty state
// (daily log) and an empty product cache (picker).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
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

    it('renders apiCall-served meal groups + offline chip on cold-start-offline relaunch', async () => {
        const { window, document } = env;
        setAuthCache(window);

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

        // Now simulate the Food screen mount while offline. The loader reads
        // vault-served data through apiCall (a local read, not network).
        const dateFilter = document.getElementById('food-date-filter');
        dateFilter.value = dateStr;
        setOnline(window, false);
        window.loadFoodTargets = async () => {};
        window.DataStore.getCached = async () => null;
        window.DataStore.setCached = async () => {};
        const apiSpy = vi.fn(async (url) => {
            if (url.startsWith('/api/food/log?')) return cachedGroups;
            return null;
        });
        window.apiCall = apiSpy;

        await window.loadFoodLogs();

        expect(apiSpy).toHaveBeenCalledWith(
            expect.stringContaining(`/api/food/log?date=${dateStr}`), 'GET');

        const list = document.getElementById('food-list');
        const groupHeader = list.querySelector('.wg-food-meal-group__title');
        expect(groupHeader).not.toBeNull();
        expect(groupHeader.textContent).toContain('Lunch');

        // Offline chip with the fresh read timestamp.
        const slot = document.getElementById('food-stale-badge');
        expect(slot).not.toBeNull();
        expect(slot.classList.contains('hidden')).toBe(false);
        const badge = slot.querySelector('.wg-stale-badge');
        expect(badge).not.toBeNull();
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
        expect(badge.textContent).toMatch(/^Offline · (just now|\d+m old)$/);
    });

    it('shows the empty state when Dexie is empty, offline, and apiCall returns null', async () => {
        const { window, document } = env;
        setAuthCache(window);
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
        window.apiCall = vi.fn(async () => null);

        await window.loadFoodLogs();

        const list = document.getElementById('food-list');
        expect(list.textContent).toBe('No food logs for this day.');
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

    it('initFoodProductsCache resolves products via apiCall on cold-start-offline', async () => {
        const { window } = env;
        setAuthCache(window);

        installApiCacheMap(window, {});

        // FoodProductsStore short-circuit cleared so the apiCall path runs.
        const saveCache = vi.fn().mockResolvedValue(undefined);
        window.MedTrackerDB.FoodProductsStore = {
            getCache: vi.fn().mockResolvedValue(null),
            saveCache,
            clearCache: vi.fn().mockResolvedValue(undefined),
            CACHE_TTL: 7 * 24 * 60 * 60 * 1000
        };

        await window.hydrateSectionsFromDexie();

        setOnline(window, false);
        // Vault-served read (local, not network) even while offline.
        window.apiCall = vi.fn(async () => ({
            products: [{ id: 1, name: 'Apple' }, { id: 2, name: 'Banana' }]
        }));

        await window.initFoodProductsCache();

        expect(window.apiCall).toHaveBeenCalledWith('/api/food/products', 'GET');
        expect(saveCache).toHaveBeenCalledTimes(1);
        const persisted = saveCache.mock.calls[0][0];
        expect(Array.isArray(persisted)).toBe(true);
        const names = persisted.map((p) => p.name).sort();
        expect(names).toEqual(['Apple', 'Banana']);
    });

    it('initFoodProductsCache falls back to an empty list when apiCall returns null', async () => {
        const { window } = env;
        setAuthCache(window);
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
        window.apiCall = vi.fn(async () => null);

        // Must not throw.
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
