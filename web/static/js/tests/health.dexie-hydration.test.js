// Task 4 of the offline-sections-sweep plan — the Vitals (Health Overview) +
// Notes subtabs must paint hydrated cache as the synchronous first paint when
// Dexie pre-populated the api_cache rows. After `hydrateSectionsFromDexie`
// runs at cold start, opening the Vitals/Notes subtabs offline should render
// the cached payload — not a blank shell or the "Loading..." placeholder.
//
// Two extra wrinkles this suite covers beyond BP/Weight/Workouts:
//   1. The overview cache key is TZ-qualified (`health_overview_<tz>`). When
//      the current TZ has no cached row but a prior TZ does, hydration falls
//      back to the most-recently-written `health_overview_*` entry so a TZ
//      change offline doesn't blank the screen.
//   2. The notes loader uses `apiCall` (silent null on offline). Without an
//      explicit empty-state branch in `onFresh(null, null)`, a cold start
//      offline with no Dexie row would leave the list silently blank.

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
        },
        // Mirrors db.js: returns the entry with the largest timestamp whose
        // id starts with `prefix`, or null. The hydrate fallback path in
        // app.js calls this when the current-TZ health_overview row is empty.
        // `opts.exclude(key) => bool` skips matching ids — used to keep
        // offset-keyed rows from seeding IANA-keyed buckets.
        async findMostRecentByPrefix(prefix, opts) {
            const exclude = (opts && typeof opts.exclude === 'function') ? opts.exclude : null;
            let best = null;
            for (const entry of map.values()) {
                if (typeof entry.id !== 'string' || !entry.id.startsWith(prefix)) continue;
                if (typeof entry.timestamp !== 'number') continue;
                if (exclude && exclude(entry.id)) continue;
                if (!best || entry.timestamp > best.timestamp) best = entry;
            }
            return best ? { key: best.id, data: best.data, timestamp: best.timestamp } : null;
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

// Minimal stub for the overview payload — render functions only inspect
// existence + array-ness of the *_stats / *_history arrays, so the rest of
// the bundle can be empty objects.
function makeOverview(extra = {}) {
    return {
        sleep_stats_7d: [],
        sleep_stats_30d: [],
        step_stats_7d: [],
        step_stats_30d: [],
        heart_rate_history_7d: [],
        heart_rate_history_30d: [],
        spo2_history_7d: [],
        spo2_history_30d: [],
        stress_history_7d: [],
        stress_history_30d: [],
        average_sleep_hours_7d: 7.4,
        average_sleep_hours_30d: 7.1,
        average_steps_7d: 8200,
        average_steps_30d: 7900,
        average_heart_rate_7d: 62,
        average_heart_rate_30d: 64,
        average_spo2_7d: 97,
        average_spo2_30d: 97,
        average_stress_7d: 35,
        average_stress_30d: 40,
        ...extra
    };
}

describe('Health cold-start Dexie hydration (Task 4)', () => {
    let env;

    beforeEach(() => {
        allowConsoleNoise();
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('seeds DataStore.getCached(health_overview_<tz>) from the Dexie api_cache row', async () => {
        const { window } = env;
        setAuthCache(window);
        const hoKey = window.healthOverviewCacheKey();
        const cachedAt = Date.now() - 30 * 60 * 1000; // 30 min ago
        const overview = makeOverview();
        installApiCacheMap(window, {
            [hoKey]: { data: overview, timestamp: cachedAt }
        });

        await window.hydrateSectionsFromDexie();

        expect(await window.DataStore.getCached(hoKey)).toEqual(overview);
    });

    it('seeds DataStore.getCached("diary_notes") from the Dexie api_cache row', async () => {
        const { window } = env;
        setAuthCache(window);
        const cachedAt = Date.now() - 20 * 60 * 1000;
        const notes = [{ id: 1, content: 'Slept well', tag: 'SLEEP', created_at: new Date().toISOString() }];
        installApiCacheMap(window, {
            diary_notes: { data: notes, timestamp: cachedAt }
        });

        await window.hydrateSectionsFromDexie();

        expect(await window.DataStore.getCached('diary_notes')).toEqual(notes);
    });

    it('loadHealthOverview renders cached overview + offline stale chip on cold start', async () => {
        const { window, document } = env;
        setAuthCache(window);
        const hoKey = window.healthOverviewCacheKey();
        const cachedAt = Date.now() - 45 * 60 * 1000; // 45 min ago
        installApiCacheMap(window, {
            [hoKey]: { data: makeOverview(), timestamp: cachedAt }
        });

        await window.hydrateSectionsFromDexie();
        setOnline(window, false);
        // apiCall returns null on offline → onFresh(null, cached) fires;
        // cached render from onCached must remain visible.
        window.apiCall = vi.fn(async () => null);

        await window.loadHealthOverview();

        const content = document.getElementById('health-overview-content');
        expect(content.classList.contains('hidden')).toBe(false);
        // Average values from makeOverview() appear in the summary tiles.
        expect(content.textContent).toContain('SLEEP');
        expect(content.textContent).toContain('STEPS');

        const slot = document.getElementById('health-overview-stale-badge');
        expect(slot).not.toBeNull();
        const badge = slot.querySelector('.wg-stale-badge');
        expect(badge).not.toBeNull();
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
    });

    it('loadNotes renders cached notes + offline stale chip on cold start', async () => {
        const { window, document } = env;
        setAuthCache(window);
        const cachedAt = Date.now() - 15 * 60 * 1000; // 15 min ago
        const cachedNotes = [
            { id: 10, content: 'Felt energetic', tag: 'NOTE', created_at: new Date().toISOString() },
            { id: 9, content: 'Slept 8 hrs', tag: 'SLEEP', created_at: new Date().toISOString() }
        ];
        installApiCacheMap(window, {
            diary_notes: { data: cachedNotes, timestamp: cachedAt }
        });

        await window.hydrateSectionsFromDexie();
        setOnline(window, false);
        window.apiCall = vi.fn(async () => null);

        await window.loadNotes();

        const list = document.getElementById('notes-list');
        expect(list.textContent).toContain('Felt energetic');
        expect(list.textContent).toContain('Slept 8 hrs');

        const slot = document.getElementById('health-notes-stale-badge');
        expect(slot).not.toBeNull();
        const badge = slot.querySelector('.wg-stale-badge');
        expect(badge).not.toBeNull();
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
    });

    it('TZ-mismatch fallback: seeds current-TZ key from the most-recent health_overview_* entry', async () => {
        const { window } = env;
        setAuthCache(window);
        const currentTzKey = window.healthOverviewCacheKey();
        // Two stale TZ-qualified rows that don't match the current TZ. The
        // newer one is what hydration should fall back to. The sentinels use
        // a deliberately non-IANA shape (leading/trailing double underscores)
        // so they are guaranteed disjoint from whatever
        // `Intl.DateTimeFormat().resolvedOptions().timeZone` returns in the
        // harness — real IANA names never use that pattern. Without this the
        // suite flakes when TZ=Europe/Berlin or TZ=America/Los_Angeles.
        const olderKey = 'health_overview___TEST_FALLBACK_OLDER__';
        const newerKey = 'health_overview___TEST_FALLBACK_NEWER__';
        // Sanity: harness TZ should not coincide with our sentinel keys.
        expect(currentTzKey).not.toBe(olderKey);
        expect(currentTzKey).not.toBe(newerKey);

        const olderTs = Date.now() - 6 * 60 * 60 * 1000; // 6h ago
        const newerTs = Date.now() - 30 * 60 * 1000;     // 30min ago
        const olderData = makeOverview({ average_sleep_hours_7d: 6.5 });
        const newerData = makeOverview({ average_sleep_hours_7d: 7.8 });
        installApiCacheMap(window, {
            [olderKey]: { data: olderData, timestamp: olderTs },
            [newerKey]: { data: newerData, timestamp: newerTs }
        });

        await window.hydrateSectionsFromDexie();

        // Current TZ key now resolves to the newer fallback data.
        const seeded = await window.DataStore.getCached(currentTzKey);
        expect(seeded).toEqual(newerData);

        // The preserved timestamp drives the stale chip — it must equal the
        // fallback row's original write time (not Date.now()), so the chip
        // surfaces real age rather than "Updated just now".
        const meta = await window.MedTrackerDB.ApiCache.getWithMeta(currentTzKey);
        expect(meta.timestamp).toBe(newerTs);
    });

    it('TZ fallback renders with offline stale chip when surfaced by loadHealthOverview', async () => {
        const { window, document } = env;
        setAuthCache(window);
        const currentTzKey = window.healthOverviewCacheKey();
        // Non-IANA sentinel so this is guaranteed disjoint from the harness TZ
        // and actually exercises the prefix-scan fallback (not a direct hit).
        const fallbackKey = 'health_overview___TEST_FALLBACK_BERLIN__';
        expect(currentTzKey).not.toBe(fallbackKey);
        const fallbackTs = Date.now() - 2 * 60 * 60 * 1000; // 2h ago
        const fallbackData = makeOverview({ average_sleep_hours_7d: 8.1 });
        installApiCacheMap(window, {
            [fallbackKey]: { data: fallbackData, timestamp: fallbackTs }
        });

        await window.hydrateSectionsFromDexie();
        setOnline(window, false);
        window.apiCall = vi.fn(async () => null);

        await window.loadHealthOverview();

        const content = document.getElementById('health-overview-content');
        expect(content.classList.contains('hidden')).toBe(false);
        expect(content.textContent).toContain('SLEEP');

        const slot = document.getElementById('health-overview-stale-badge');
        const badge = slot.querySelector('.wg-stale-badge');
        expect(badge).not.toBeNull();
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
    });

    it('loadNotes shows "No cached data" empty state when Dexie is empty and offline', async () => {
        const { window, document } = env;
        setAuthCache(window);
        installApiCacheMap(window, {});

        await window.hydrateSectionsFromDexie();
        setOnline(window, false);
        // apiCall returns null silently on offline — without the new empty-
        // state branch in onFresh(null, null), the list would remain blank.
        window.apiCall = vi.fn(async () => null);

        await window.loadNotes();

        const list = document.getElementById('notes-list');
        expect(list.textContent).toContain('No cached data');
        const loading = document.getElementById('notes-loading');
        expect(loading.style.display).toBe('none');
    });

    it('loadHealthOverview shows "No cached data" empty state when Dexie is empty and offline', async () => {
        const { window, document } = env;
        setAuthCache(window);
        installApiCacheMap(window, {});

        await window.hydrateSectionsFromDexie();
        setOnline(window, false);
        window.apiCall = vi.fn(async () => null);

        await window.loadHealthOverview();

        const content = document.getElementById('health-overview-content');
        expect(content.textContent).toContain('No cached data');
        expect(content.classList.contains('hidden')).toBe(false);
    });

    it('hydration is a no-op for health keys with no Dexie row', async () => {
        const { window } = env;
        setAuthCache(window);
        installApiCacheMap(window, {});

        await window.hydrateSectionsFromDexie();

        const hoKey = window.healthOverviewCacheKey();
        expect(await window.DataStore.getCached(hoKey)).toBeNull();
        expect(await window.DataStore.getCached('diary_notes')).toBeNull();
    });

    it('hydration does not throw when findMostRecentByPrefix rejects', async () => {
        const { window } = env;
        setAuthCache(window);
        installApiCacheMap(window, {});
        // Override only the prefix scan to reject — the per-key getWithMeta
        // path should still be exercised cleanly.
        window.MedTrackerDB.ApiCache.findMostRecentByPrefix = async () => {
            throw new Error('IndexedDB unavailable');
        };

        await expect(window.hydrateSectionsFromDexie()).resolves.toBeUndefined();
    });
});
