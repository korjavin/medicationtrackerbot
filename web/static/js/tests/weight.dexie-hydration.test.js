// Task 2 of the offline-sections-sweep plan — `loadWeightLogs()` must paint
// the hydrated cache as the synchronous first paint when Dexie pre-populated
// the api_cache row. After the cold-start hydration primer (added in
// `hydrateSectionsFromDexie`) seeds DataStore.api_cache from Dexie, opening
// the Weight screen offline should render the goal card, chart, and history
// list plus the "Offline · …" stale chip — not a blank list. Conversely, a
// cold start with neither a hydration nor a Dexie row must show the explicit
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

function installWeightStoreStubs(window) {
    window.MedTrackerDB = window.MedTrackerDB || {};
    window.MedTrackerDB.WeightStore = {
        getPending: async () => [],
        getRejected: async () => [],
        getAll: async () => [],
        confirmDelete: async () => undefined
    };
}

describe('Weight cold-start Dexie hydration (Task 2)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('seeds DataStore.getCached("weight") from the Dexie api_cache row when hydrateSectionsFromDexie runs', async () => {
        const { window } = env;
        setAuthCache(window);
        const cachedAt = Date.now() - 90 * 60 * 1000; // 90 min ago
        const cachedWeight = {
            logsRes: [
                { id: 1, measured_at: new Date().toISOString(), weight: 75.5, notes: '' }
            ],
            goalRes: { goal: 70, goal_direction: 'lose', highest_weight: 80 }
        };
        installApiCacheMap(window, {
            weight: { data: cachedWeight, timestamp: cachedAt }
        });

        await window.hydrateSectionsFromDexie();

        const seeded = await window.DataStore.getCached('weight');
        expect(seeded).toEqual(cachedWeight);
    });

    it('renders the weight history rows and an Offline stale chip when Dexie pre-populated the api_cache and we are offline', async () => {
        const { window, document } = env;
        setAuthCache(window);

        const cachedAt = Date.now() - 90 * 60 * 1000; // 90 min ago
        installApiCacheMap(window, {
            weight: {
                data: {
                    logsRes: [
                        { id: 1, measured_at: new Date().toISOString(), weight: 75.5, notes: '' },
                        { id: 2, measured_at: new Date(Date.now() - 86400000).toISOString(), weight: 76.0, notes: '' }
                    ],
                    goalRes: { goal: 70, goal_direction: 'lose', highest_weight: 80 }
                },
                timestamp: cachedAt
            }
        });
        installWeightStoreStubs(window);

        // Cold-start path: hydrate from Dexie before any bootstrap fetch.
        await window.hydrateSectionsFromDexie();

        setOnline(window, false);
        // Offline → apiCall returns null silently. The SWR fetcher returns
        // null and the cached render path runs.
        window.apiCall = vi.fn(async () => null);

        await window.loadWeightLogs();

        const list = document.getElementById('weight-list');
        // History list should contain at least one cached row, not the
        // "No cached data" empty state.
        const empty = list.querySelector('.empty-state-msg');
        expect(empty).toBeNull();
        const rows = list.querySelectorAll('li.wg-weight-history-row');
        expect(rows.length).toBeGreaterThanOrEqual(1);

        const slot = document.getElementById('weight-stale-badge');
        expect(slot).not.toBeNull();
        const badge = slot.querySelector('.wg-stale-badge');
        expect(badge).not.toBeNull();
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
        // 90m old offline → "Offline · 1h old" (formatAge truncates to whole hours).
        expect(badge.textContent).toMatch(/^Offline · 1h old$/);
    });

    it('renders the weight goal card from hydrated cache when the cached payload includes a goal', async () => {
        const { window, document } = env;
        setAuthCache(window);

        installApiCacheMap(window, {
            weight: {
                data: {
                    logsRes: [
                        { id: 1, measured_at: new Date().toISOString(), weight: 75, notes: '' }
                    ],
                    goalRes: { goal: 70, goal_direction: 'lose', highest_weight: 80 }
                },
                timestamp: Date.now() - 60_000
            }
        });
        installWeightStoreStubs(window);

        await window.hydrateSectionsFromDexie();

        setOnline(window, false);
        window.apiCall = vi.fn(async () => null);

        await window.loadWeightLogs();

        const goalCard = document.getElementById('weight-goal-card');
        // Goal card should be visible (not hidden) since cached goal is finite.
        expect(goalCard.hidden).toBe(false);
        // Value text contains "70.0" in the active unit (defaults to kg).
        expect(goalCard.textContent).toMatch(/70\.0/);
    });

    it('shows the explicit "No cached data" empty state when Dexie is empty and we are offline', async () => {
        const { window, document } = env;
        setAuthCache(window);
        installApiCacheMap(window, {});
        installWeightStoreStubs(window);

        await window.hydrateSectionsFromDexie();

        setOnline(window, false);
        window.apiCall = vi.fn(async () => null);

        await window.loadWeightLogs();

        const list = document.getElementById('weight-list');
        const empty = list.querySelector('.empty-state-msg');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toContain('No cached data');
    });

    it('is a no-op when Dexie has no row for `weight`', async () => {
        const { window } = env;
        setAuthCache(window);
        installApiCacheMap(window, {});

        await window.hydrateSectionsFromDexie();

        const seeded = await window.DataStore.getCached('weight');
        expect(seeded).toBeNull();
    });

    it('does not throw when ApiCache.getWithMeta rejects on the weight key — auth flow is never blocked', async () => {
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
