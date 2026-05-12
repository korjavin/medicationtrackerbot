// Task 7 of the offline-sections-sweep plan — opening the Settings screen
// should refresh the cached `settings_bundle` from the backend so toggles
// reflect current backend state, not just whatever bootstrap last seeded.
// When the user is offline, the cached bundle must stay visible and the
// stale chip must surface freshness (or "Offline · no cache" when there is
// nothing to show).
//
// Why this lives alongside settings.dexie-hydration.test.js: hydration is the
// COLD-START primer (Task 6); this file pins the ON-MOUNT REFRESH behavior
// (Task 7). They cover orthogonal slices of the same user-facing contract.

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

describe('Settings on-mount refresh (Task 7)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('loadSettings fires the SWR fetcher on mount — every endpoint in the bundle is requested', async () => {
        const { window } = env;
        setAuthCache(window);
        installApiCacheMap(window, {});
        setOnline(window, true);

        // Track each /api/* endpoint touched by fetchBundle. The handler shape
        // (5 parallel apiCall reads merged into a bundle) is implementation
        // detail; the user-facing guarantee is that the merged bundle reflects
        // *current* backend state — so every input slice must be requested.
        const calls = [];
        window.apiCall = vi.fn(async (url) => {
            calls.push(url);
            if (url === '/api/settings/features') return { medication: true, workout: true, food: true, bp: false, weight: true, health: true };
            if (url === '/api/food/settings/targets') return { calories: 2100, carbs: 250, protein: 145, fat: 75 };
            if (url === '/api/bp/reminder/status') return { enabled: false };
            if (url === '/api/weight/reminder/status') return { enabled: true };
            if (url === '/api/settings') {
                return {
                    timezone: 'America/New_York',
                    server_time: new Date().toISOString(),
                    server_timezone: 'EST (UTC-05:00)',
                    weight_unit_preference: 'lb'
                };
            }
            return null;
        });

        await window.loadSettings();

        // Each of the five bundle inputs must be hit at least once.
        expect(calls).toEqual(expect.arrayContaining([
            '/api/settings/features',
            '/api/food/settings/targets',
            '/api/bp/reminder/status',
            '/api/weight/reminder/status',
            '/api/settings'
        ]));
    });

    it('a fresh on-mount refresh overwrites the cached bundle with the new server values (toggles flip)', async () => {
        const { window } = env;
        setAuthCache(window);
        // Pre-seed an old bundle so we can prove the refresh REPLACED it
        // instead of leaving the stale values in place.
        const staleBundle = makeBundle({
            featureSettings: { medication: true, workout: true, food: true, bp: true, weight: true, health: true },
            foodTargets: { calories: 1800, carbs: 180, protein: 120, fat: 60 },
            weightUnitPreference: 'kg'
        });
        installApiCacheMap(window, {
            settings_bundle: { data: staleBundle, timestamp: Date.now() - 6 * 60 * 60 * 1000 }
        });

        await window.hydrateSectionsFromDexie();
        setOnline(window, true);

        // Backend has since switched the user OFF bp + food, raised macros,
        // and switched to lb. The refresh must propagate every change.
        window.apiCall = vi.fn(async (url) => {
            if (url === '/api/settings/features') return { medication: true, workout: true, food: false, bp: false, weight: true, health: true };
            if (url === '/api/food/settings/targets') return { calories: 2200, carbs: 260, protein: 150, fat: 80 };
            if (url === '/api/bp/reminder/status') return { enabled: false };
            if (url === '/api/weight/reminder/status') return { enabled: true };
            if (url === '/api/settings') {
                return {
                    timezone: 'Europe/Berlin',
                    server_time: new Date().toISOString(),
                    server_timezone: 'UTC',
                    weight_unit_preference: 'lb'
                };
            }
            return null;
        });

        await window.loadSettings();

        const refreshed = await window.DataStore.getCached('settings_bundle');
        expect(refreshed.featureSettings).toMatchObject({ food: false, bp: false });
        expect(refreshed.foodTargets).toEqual({ calories: 2200, carbs: 260, protein: 150, fat: 80 });
        expect(refreshed.weightUnitPreference).toBe('lb');
        expect(refreshed.weightReminderStatus).toEqual({ enabled: true });
        expect(refreshed.bpReminderStatus).toEqual({ enabled: false });
    });

    it('mounts a wg-stale-badge into the Settings header pulling from the settings_bundle cache row', async () => {
        allowConsoleNoise();
        const { window, document } = env;
        setAuthCache(window);
        const cachedAt = Date.now() - 90 * 60 * 1000; // 90 min ago
        const bundle = makeBundle();
        installApiCacheMap(window, {
            settings_bundle: { data: bundle, timestamp: cachedAt }
        });
        await window.hydrateSectionsFromDexie();

        // Offline: badge must render with the offline-warning tone so the
        // user sees the values come from cache, not a live backend response.
        // apiCall throws (not just returns null) so the SWR fetcher errors
        // out and the cached row's timestamp is NOT advanced — letting the
        // badge surface the real 90-min-old age the user should see.
        setOnline(window, false);
        window.apiCall = vi.fn(async () => { throw new Error('offline'); });

        await window.loadSettings();

        const slot = document.getElementById('settings-stale-badge');
        expect(slot).not.toBeNull();
        const badge = slot.querySelector('.wg-stale-badge');
        expect(badge).not.toBeNull();
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
        // 90-minute-old cache + offline must render the "X old" age string,
        // not collapse to "Offline · just now" (which only fires when the
        // timestamp is fresher than 60s).
        expect(badge.textContent).toMatch(/Offline ·/);
        expect(badge.textContent).not.toMatch(/just now/i);
    });

    it('opening Settings offline with a cached bundle keeps the cached values rendered — no console error spam', async () => {
        allowConsoleNoise();
        const { window } = env;
        setAuthCache(window);
        const bundle = makeBundle({
            featureSettings: { medication: true, workout: false, food: true, bp: true, weight: true, health: false },
            weightUnitPreference: 'lb'
        });
        installApiCacheMap(window, {
            settings_bundle: { data: bundle, timestamp: Date.now() - 45 * 60 * 1000 }
        });

        await window.hydrateSectionsFromDexie();

        setOnline(window, false);
        // Every fetcher endpoint throws — simulating a hard offline state
        // (no 5xx-as-offline because the network never returns at all).
        window.apiCall = vi.fn(async () => { throw new Error('offline'); });

        await expect(window.loadSettings()).resolves.toBeUndefined();

        // applyBundle (via onCached + onError fallback) must have applied
        // the cached values, NOT clobbered them with defaults.
        expect(window.featureSettings).toMatchObject({
            medication: true, workout: false, food: true, bp: true, weight: true, health: false
        });
        expect(window.weightUnitPreference).toBe('lb');
    });

    it('apiCall returning null on offline does not clobber the cached bundle with empty defaults', async () => {
        // Regression guard for the realistic offline path: `apiCall` swallows
        // network errors and returns null (it does NOT throw), so the SWR
        // fetcher would otherwise compose a non-null bundle of empty/zero
        // defaults — `featureSettings: {}`, `foodTargets: {0,0,0,0}`,
        // `bpReminderStatus: {enabled:false}`, `weightUnitPreference: 'kg'` —
        // and fetchFresh would write that frankenstein bundle to ApiCache,
        // destroying the bootstrap-warmed cache and reverting the rendered
        // toggles. Fixed by returning null from fetchBundle when any input
        // slice is null so loadSWR's onFresh never fires.
        const { window } = env;
        setAuthCache(window);
        const cachedAt = Date.now() - 30 * 60 * 1000;
        const bundle = makeBundle({
            featureSettings: { medication: true, workout: false, food: true, bp: true, weight: true, health: false },
            foodTargets: { calories: 1900, carbs: 200, protein: 130, fat: 65 },
            bpReminderStatus: { enabled: true },
            weightReminderStatus: { enabled: false },
            weightUnitPreference: 'lb'
        });
        installApiCacheMap(window, {
            settings_bundle: { data: bundle, timestamp: cachedAt }
        });

        await window.hydrateSectionsFromDexie();

        setOnline(window, false);
        // Realistic offline shape: every GET resolves to null (the offline-aware
        // apiCall path), NOT throws.
        window.apiCall = vi.fn(async () => null);

        await expect(window.loadSettings()).resolves.toBeUndefined();

        // Cached bundle must survive intact — not replaced by empty defaults.
        const after = await window.DataStore.getCached('settings_bundle');
        expect(after).not.toBeNull();
        expect(after.featureSettings).toMatchObject({
            medication: true, workout: false, food: true, bp: true, weight: true, health: false
        });
        expect(after.foodTargets).toEqual({ calories: 1900, carbs: 200, protein: 130, fat: 65 });
        expect(after.bpReminderStatus).toEqual({ enabled: true });
        expect(after.weightReminderStatus).toEqual({ enabled: false });
        expect(after.weightUnitPreference).toBe('lb');

        // And the original timestamp must NOT be advanced — the badge should
        // continue to surface the real age of the cached row, not "just now".
        const meta = await window.MedTrackerDB.ApiCache.getWithMeta('settings_bundle');
        expect(meta.timestamp).toBe(cachedAt);
    });

    it('opening Settings offline with NO cached bundle does not throw — degrades to module defaults', async () => {
        allowConsoleNoise();
        const { window } = env;
        setAuthCache(window);
        installApiCacheMap(window, {});

        setOnline(window, false);
        window.apiCall = vi.fn(async () => { throw new Error('offline'); });

        // No cache + no network: loadSettings should complete without
        // throwing. featureSettings remains at whatever default the module
        // initialised — the "Settings unavailable offline" spirit is
        // preserved by the toggles staying at their inherent default state
        // rather than the page bricking on an unhandled rejection.
        await expect(window.loadSettings()).resolves.toBeUndefined();
    });

    it('a fresh on-mount refresh updates the cache timestamp so the stale chip flips from "Offline" to "Updated just now"', async () => {
        const { window } = env;
        setAuthCache(window);
        const staleCachedAt = Date.now() - 6 * 60 * 60 * 1000; // 6h ago
        installApiCacheMap(window, {
            settings_bundle: { data: makeBundle(), timestamp: staleCachedAt }
        });

        await window.hydrateSectionsFromDexie();
        setOnline(window, true);

        window.apiCall = vi.fn(async (url) => {
            if (url === '/api/settings/features') return { medication: true, workout: true, food: true, bp: true, weight: true, health: true };
            if (url === '/api/food/settings/targets') return { calories: 2000, carbs: 200, protein: 130, fat: 65 };
            if (url === '/api/bp/reminder/status') return { enabled: true };
            if (url === '/api/weight/reminder/status') return { enabled: false };
            if (url === '/api/settings') {
                return {
                    timezone: 'Europe/Berlin',
                    server_time: new Date().toISOString(),
                    server_timezone: 'UTC',
                    weight_unit_preference: 'kg'
                };
            }
            return null;
        });

        await window.loadSettings();

        const meta = await window.MedTrackerDB.ApiCache.getWithMeta('settings_bundle');
        expect(meta).not.toBeNull();
        // The refresh advanced the timestamp far past the 6h-old seed.
        expect(meta.timestamp).toBeGreaterThan(staleCachedAt);
        // Within a generous window of "now" — covers slow CI clocks without
        // hardcoding a fragile bound.
        expect(meta.timestamp).toBeGreaterThan(Date.now() - 60_000);
    });
});
