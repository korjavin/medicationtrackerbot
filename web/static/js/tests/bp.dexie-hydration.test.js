// Task 1 of the offline-sections-sweep plan — `loadBPReadings()` must paint
// the hydrated cache as the synchronous first paint when Dexie pre-populated
// the api_cache row. After the cold-start hydration primer (added in
// `hydrateSectionsFromDexie`) seeds DataStore.api_cache from Dexie, opening
// the BP screen offline should render the chart + history list and the
// "Offline · …" stale chip — not a blank list. Conversely, a cold start
// with neither a hydration nor a Dexie row must show the explicit
// "No cached data" empty state.

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
    return map;
}

function setOnline(window, online) {
    Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        get: () => online
    });
}

describe('BP cold-start Dexie hydration (Task 1)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('seeds DataStore.getCached("bp") from the Dexie api_cache row when hydrateSectionsFromDexie runs', async () => {
        const { window } = env;
        setAuthCache(window);
        const cachedAt = Date.now() - 90 * 60 * 1000; // 90 min ago
        const cachedBP = {
            readingsRes: [
                { id: 1, measured_at: new Date().toISOString(), systolic: 120, diastolic: 80 }
            ],
            goalRes: { systolic: 120, diastolic: 80 },
            statsRes: {}
        };
        installApiCacheMap(window, {
            bp: { data: cachedBP, timestamp: cachedAt }
        });

        await window.hydrateSectionsFromDexie();

        const seeded = await window.DataStore.getCached('bp');
        expect(seeded).toEqual(cachedBP);
    });

    it('renders the BP chart, history rows, and an Offline stale chip when Dexie pre-populated the api_cache and we are offline', async () => {
        const { window, document } = env;
        setAuthCache(window);

        const cachedAt = Date.now() - 90 * 60 * 1000; // 90 min ago
        installApiCacheMap(window, {
            bp: {
                data: {
                    readingsRes: [
                        { id: 1, measured_at: new Date().toISOString(), systolic: 130, diastolic: 85 }
                    ],
                    goalRes: { systolic: 120, diastolic: 80 },
                    statsRes: { avg_systolic: 130, avg_diastolic: 85 }
                },
                timestamp: cachedAt
            }
        });
        // BPStore stubs needed by _renderBPData's pending/rejected merge.
        // installApiCacheMap initializes window.MedTrackerDB so this is safe now.
        window.MedTrackerDB.BPStore = {
            getPending: async () => [],
            getRejected: async () => [],
            getAll: async () => [],
            confirmDelete: async () => undefined
        };

        // Cold-start path: hydrate from Dexie before any bootstrap fetch.
        await window.hydrateSectionsFromDexie();

        setOnline(window, false);
        // Offline → apiCall returns null silently. The SWR fetcher returns
        // null and the cached render path runs.
        window.apiCall = vi.fn(async () => null);

        await window.loadBPReadings();

        const list = document.getElementById('bp-list');
        // History list should contain at least the one cached row, not the
        // "No cached data" empty state.
        const empty = list.querySelector('.empty-state-msg');
        expect(empty).toBeNull();
        const rows = list.querySelectorAll('li');
        expect(rows.length).toBeGreaterThanOrEqual(1);

        const slot = document.getElementById('bp-stale-badge');
        expect(slot).not.toBeNull();
        const badge = slot.querySelector('.wg-stale-badge');
        expect(badge).not.toBeNull();
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
        // 90m old offline → "Offline · 1h old" (formatAge truncates to whole hours).
        expect(badge.textContent).toMatch(/^Offline · 1h old$/);
    });

    it('shows the explicit "No cached data" empty state when Dexie is empty and we are offline', async () => {
        const { window, document } = env;
        setAuthCache(window);
        installApiCacheMap(window, {});
        window.MedTrackerDB.BPStore = {
            getPending: async () => [],
            getRejected: async () => [],
            getAll: async () => [],
            confirmDelete: async () => undefined
        };

        await window.hydrateSectionsFromDexie();

        setOnline(window, false);
        window.apiCall = vi.fn(async () => null);

        await window.loadBPReadings();

        const list = document.getElementById('bp-list');
        const empty = list.querySelector('.empty-state-msg');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toContain('No cached data');
    });

    it('skips hydration when there is no auth presence (no initData, no cached auth) — Dexie loader is never called', async () => {
        const { window } = env;
        // Explicitly clear any prior auth cache.
        window.localStorage.removeItem(AUTH_CACHE_KEY);
        installApiCacheMap(window, {
            bp: {
                data: { readingsRes: [{ id: 99 }], goalRes: {}, statsRes: {} },
                timestamp: Date.now() - 60_000
            }
        });
        // Spy on getWithMeta so we can prove the loader was never invoked
        // when no auth presence is detected. (DataStore.getCached reads
        // ApiCache directly so checking the in-memory cache wouldn't
        // distinguish hydration from a direct read.)
        const getMetaSpy = vi.spyOn(window.MedTrackerDB.ApiCache, 'getWithMeta');

        await window.hydrateSectionsFromDexie();

        expect(getMetaSpy).not.toHaveBeenCalled();
    });

    it('is a no-op when Dexie has no row for `bp`', async () => {
        const { window } = env;
        setAuthCache(window);
        installApiCacheMap(window, {});

        await window.hydrateSectionsFromDexie();

        const seeded = await window.DataStore.getCached('bp');
        expect(seeded).toBeNull();
    });

    it('does not throw when ApiCache.getWithMeta rejects — auth flow is never blocked', async () => {
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
