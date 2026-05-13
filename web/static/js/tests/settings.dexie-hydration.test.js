// Task 6 of the offline-sections-sweep plan — the Settings screen must paint
// hydrated toggles, food targets, reminder status, and weight-unit segmented
// state as the synchronous first paint when Dexie pre-populated the
// `settings_bundle` api_cache row. After the cold-start hydration primer
// (added in `hydrateSectionsFromDexie`) seeds DataStore.api_cache from Dexie,
// opening Settings offline should render last-known toggle/input state — not
// a blank screen waiting on a bootstrap fetch that will never resolve.
//
// The production Settings UI is `loadSettings()` in app.js, keyed on
// `settings_bundle` and bootstrap-cached by applyBootstrapPayload. The
// per-key SWR keys settings_features / settings_food_targets are not the
// hydration targets (an unloaded features/settings.js used them before
// it was deleted on 2026-05-13 — see
// docs/plans/2026-05-13-remove-dead-settings-js.md and
// docs/plans/completed/2026-03-10-fix-tab-order-not-persisting.md).

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

function makeBundle(extra = {}) {
    return {
        featureSettings: {
            medication: true,
            workout: false,
            food: true,
            bp: true,
            weight: true,
            health: false
        },
        tabOrder: null,
        timezone: 'Europe/Berlin',
        serverTime: new Date().toISOString(),
        serverTimezone: 'UTC',
        weightUnitPreference: 'kg',
        foodTargets: { calories: 1900, carbs: 200, protein: 130, fat: 65 },
        bpReminderStatus: { enabled: true },
        weightReminderStatus: { enabled: false },
        ...extra
    };
}

describe('Settings cold-start Dexie hydration (Task 6)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('seeds DataStore.getCached("settings_bundle") from the Dexie api_cache row when hydrateSectionsFromDexie runs', async () => {
        const { window } = env;
        setAuthCache(window);
        const cachedAt = Date.now() - 90 * 60 * 1000; // 90 min ago
        const bundle = makeBundle();
        installApiCacheMap(window, {
            settings_bundle: { data: bundle, timestamp: cachedAt }
        });

        await window.hydrateSectionsFromDexie();

        const seeded = await window.DataStore.getCached('settings_bundle');
        expect(seeded).toEqual(bundle);
    });

    it('hydration preserves the original cached timestamp on settings_bundle so a stale-badge would surface real age, not "Updated just now"', async () => {
        const { window } = env;
        setAuthCache(window);
        const cachedAt = Date.now() - 4 * 60 * 60 * 1000; // 4 hours ago
        const bundle = makeBundle();
        installApiCacheMap(window, {
            settings_bundle: { data: bundle, timestamp: cachedAt }
        });

        await window.hydrateSectionsFromDexie();

        const meta = await window.MedTrackerDB.ApiCache.getWithMeta('settings_bundle');
        expect(meta).not.toBeNull();
        expect(meta.timestamp).toBe(cachedAt);
    });

    it('loadSettings finds the hydrated bundle via DataStore.getCached on cold-start offline (onCached fires with the cached payload)', async () => {
        const { window } = env;
        setAuthCache(window);
        const bundle = makeBundle({
            featureSettings: {
                medication: true,
                workout: false,
                food: false,
                bp: true,
                weight: false,
                health: true
            },
            foodTargets: { calories: 1850, carbs: 195, protein: 125, fat: 60 },
            bpReminderStatus: { enabled: true },
            weightReminderStatus: { enabled: false },
            weightUnitPreference: 'lb'
        });
        installApiCacheMap(window, {
            settings_bundle: { data: bundle, timestamp: Date.now() - 30 * 60 * 1000 }
        });

        await window.hydrateSectionsFromDexie();

        setOnline(window, false);
        // Mock apiCall so loadSettings' fetchBundle returns null (fetcher
        // short-circuits when every endpoint resolves null), and onFresh is
        // therefore skipped. Only onCached fires — and it must receive the
        // hydrated bundle exactly. Wrap the loadSWR call so we can capture
        // the cached argument the onCached callback was invoked with.
        window.apiCall = vi.fn(async () => null);

        let capturedCached = null;
        let onCachedFired = false;
        const origLoadSWR = window.DataStore.loadSWR.bind(window.DataStore);
        window.DataStore.loadSWR = async (options) => {
            const wrappedOnCached = options.onCached;
            return origLoadSWR({
                ...options,
                onCached: async (cached) => {
                    onCachedFired = true;
                    capturedCached = cached;
                    if (wrappedOnCached) return wrappedOnCached(cached);
                }
            });
        };

        await window.loadSettings();

        // The hydrated bundle reached loadSettings' onCached path exactly as
        // written to ApiCache — proves the cold-start cache primer works
        // end-to-end through hydrateSectionsFromDexie → DataStore.getCached →
        // loadSettings → onCached.
        expect(onCachedFired).toBe(true);
        expect(capturedCached).toEqual(bundle);

        // Side effects of applyBundle that don't depend on the rest of the
        // DOM being upgraded by the test harness: featureSettings + weight
        // unit. (Food-target inputs and toggle DOM are exercised by the
        // companion settings.toggles.test.js / settings.food-targets.test.js
        // suites that already mock window.DataStore in isolation.)
        expect(window.featureSettings).toMatchObject({
            medication: true,
            workout: false,
            food: false,
            bp: true,
            weight: false,
            health: true
        });
        expect(window.weightUnitPreference).toBe('lb');

        window.DataStore.loadSWR = origLoadSWR;
    });

    it('loadSettings onError preserves the cached bundle render when the fetcher throws (no-cache fallback path on cold-start offline)', async () => {
        allowConsoleNoise();
        const { window } = env;
        setAuthCache(window);
        const bundle = makeBundle({
            featureSettings: { medication: true, workout: true, food: true, bp: true, weight: true, health: true },
            weightUnitPreference: 'kg'
        });
        installApiCacheMap(window, {
            settings_bundle: { data: bundle, timestamp: Date.now() - 60 * 60 * 1000 }
        });

        await window.hydrateSectionsFromDexie();

        setOnline(window, false);
        // apiCall throws on every endpoint — fetchBundle therefore rejects
        // and loadSWR routes through onError(error, cached). The onError
        // callback in loadSettings re-applies the cached bundle so the UI
        // stays on the last-known state instead of falling back to defaults.
        window.apiCall = vi.fn(async () => { throw new Error('offline'); });

        // Capture the cached argument that onError receives, proving the
        // hydrated bundle is the fallback applyBundle sees.
        let errorCached = null;
        const origLoadSWR = window.DataStore.loadSWR.bind(window.DataStore);
        window.DataStore.loadSWR = async (options) => {
            const wrappedOnError = options.onError;
            return origLoadSWR({
                ...options,
                onError: async (error, cached) => {
                    errorCached = cached;
                    if (wrappedOnError) return wrappedOnError(error, cached);
                }
            });
        };

        await window.loadSettings();

        expect(errorCached).toEqual(bundle);

        window.DataStore.loadSWR = origLoadSWR;
    });

    it('applyBootstrapPayload writes settings_bundle to ApiCache so the next cold start has a Dexie row to hydrate from', async () => {
        const { window } = env;
        const cacheMap = installApiCacheMap(window, {});

        await window.applyBootstrapPayload({
            cursor: 1,
            features: {
                medication: true,
                workout: true,
                food: true,
                bp: false,
                weight: true,
                health: false
            },
            settings: {
                timezone: 'America/New_York',
                food_targets: { calories: 2100, carbs: 240, protein: 140, fat: 70 },
                bp_reminder_status: { enabled: true },
                weight_reminder_status: { enabled: false }
            }
        });

        const seeded = await window.DataStore.getCached('settings_bundle');
        expect(seeded).not.toBeNull();
        expect(seeded.featureSettings).toMatchObject({
            medication: true,
            workout: true,
            food: true,
            bp: false,
            weight: true,
            health: false
        });
        expect(seeded.foodTargets).toEqual({ calories: 2100, carbs: 240, protein: 140, fat: 70 });
        expect(seeded.bpReminderStatus).toEqual({ enabled: true });
        expect(seeded.weightReminderStatus).toEqual({ enabled: false });
        expect(cacheMap.has('settings_bundle')).toBe(true);
    });

    it('hydration is a no-op when Dexie has no settings_bundle row', async () => {
        const { window } = env;
        setAuthCache(window);
        installApiCacheMap(window, {});

        await window.hydrateSectionsFromDexie();

        expect(await window.DataStore.getCached('settings_bundle')).toBeNull();
    });

    it('skips settings_bundle hydration when there is no auth presence — the Dexie loader is never called', async () => {
        const { window } = env;
        // Explicitly clear any prior auth cache.
        window.localStorage.removeItem(AUTH_CACHE_KEY);
        installApiCacheMap(window, {
            settings_bundle: { data: makeBundle(), timestamp: Date.now() - 60_000 }
        });
        const getMetaSpy = vi.spyOn(window.MedTrackerDB.ApiCache, 'getWithMeta');

        await window.hydrateSectionsFromDexie();

        expect(getMetaSpy).not.toHaveBeenCalled();
    });

    it('does not throw when ApiCache.getWithMeta rejects on settings_bundle — auth flow is never blocked', async () => {
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
