// Task 3 of the offline-sections-sweep plan — each Workouts subtab loader
// (loadNextWorkout, loadWorkoutHistoryTab, loadWorkoutGroups,
// loadExerciseLibrary, loadWorkoutStatsTab) must paint hydrated cache as the
// synchronous first paint when Dexie pre-populated the api_cache row. After
// `hydrateSectionsFromDexie` runs at cold start, opening a Workouts subtab
// offline should render the cached payload — not a blank shell or the
// "Loading..." placeholder.
//
// Conversely, an offline cold start with no cached row must show an explicit
// empty / fallback state instead of leaving the placeholder visible.

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
    window.MedTrackerDB.WorkoutStore = window.MedTrackerDB.WorkoutStore || {
        saveCache: async () => undefined,
        getCache: async () => null,
        clearCache: async () => undefined
    };
    return map;
}

function setOnline(window, online) {
    Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        get: () => online
    });
}

describe('Workouts cold-start Dexie hydration (Task 3)', () => {
    let env;

    beforeEach(() => {
        allowConsoleNoise();
        env = loadFrontendEnv({ withWorkout: true });
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('hydrateSectionsFromDexie seeds all five workout cache keys from the Dexie api_cache', async () => {
        const { window } = env;
        setAuthCache(window);
        const cachedAt = Date.now() - 60_000;
        installApiCacheMap(window, {
            workout_next: { data: { session: { id: 1 } }, timestamp: cachedAt },
            workout_history: { data: { sessions: [{ id: 7 }], miband: [] }, timestamp: cachedAt },
            workout_groups: { data: [{ id: 2, name: 'Push' }], timestamp: cachedAt },
            workout_stats: { data: { total_volume: 100 }, timestamp: cachedAt },
            exercise_library: { data: [{ id: 3, name: 'Squat' }], timestamp: cachedAt }
        });

        await window.hydrateSectionsFromDexie();

        expect(await window.DataStore.getCached('workout_next')).toEqual({ session: { id: 1 } });
        expect(await window.DataStore.getCached('workout_history')).toEqual({ sessions: [{ id: 7 }], miband: [] });
        expect(await window.DataStore.getCached('workout_groups')).toEqual([{ id: 2, name: 'Push' }]);
        expect(await window.DataStore.getCached('workout_stats')).toEqual({ total_volume: 100 });
        expect(await window.DataStore.getCached('exercise_library')).toEqual([{ id: 3, name: 'Squat' }]);
    });

    it('loadNextWorkout paints the cached next-workout card on offline cold start', async () => {
        const { window, document } = env;
        setAuthCache(window);
        const cachedAt = Date.now() - 60 * 60 * 1000; // 1h ago
        installApiCacheMap(window, {
            workout_next: {
                data: {
                    session: {
                        id: 42,
                        scheduled_date: '2026-05-09',
                        scheduled_time: '08:00',
                        status: 'pending',
                        is_today: true
                    },
                    group_name: 'Push',
                    variant_name: 'A',
                    exercises_count: 3,
                    variant_id: 1,
                    group_id: 1,
                    is_rotating: false
                },
                timestamp: cachedAt
            }
        });

        await window.hydrateSectionsFromDexie();
        setOnline(window, false);
        // apiCallDirect throws on offline so the SWR fetcher routes through onError.
        window.apiCallDirect = vi.fn(async () => { throw new Error('offline'); });

        await window.loadNextWorkout();

        const container = document.getElementById('next-workout-card');
        // Cached card painted — group name comes from the cached payload.
        expect(container.textContent).toContain('Push');
        const card = container.querySelector('.wg-workouts-next-card');
        expect(card).not.toBeNull();
    });

    it('loadWorkoutGroups renders cached groups + stale chip on offline cold start', async () => {
        const { window, document } = env;
        setAuthCache(window);
        const cachedAt = Date.now() - 90 * 60 * 1000; // 90 min ago
        installApiCacheMap(window, {
            workout_groups: {
                data: [
                    { id: 1, name: 'Morning Routine', variants: [] },
                    { id: 2, name: 'Evening Routine', variants: [] }
                ],
                timestamp: cachedAt
            }
        });

        await window.hydrateSectionsFromDexie();
        setOnline(window, false);
        window.apiCallDirect = vi.fn(async () => { throw new Error('offline'); });

        await window.loadWorkoutGroups();

        const container = document.getElementById('workout-groups-list');
        expect(container.textContent).toContain('Morning Routine');
        expect(container.textContent).toContain('Evening Routine');

        const slot = document.getElementById('workout-groups-stale-badge');
        expect(slot).not.toBeNull();
        const badge = slot.querySelector('.wg-stale-badge');
        expect(badge).not.toBeNull();
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
    });

    it('loadWorkoutHistoryTab renders cached sessions on offline cold start', async () => {
        const { window, document } = env;
        setAuthCache(window);
        const cachedAt = Date.now() - 30 * 60 * 1000; // 30 min ago
        // _renderWorkoutHistory expects each session wrapped as
        // `{ session: {...}, group_name, variant_name, ... }`.
        installApiCacheMap(window, {
            workout_history: {
                data: {
                    sessions: [
                        {
                            session: {
                                id: 100,
                                status: 'completed',
                                scheduled_date: '2026-05-09',
                                scheduled_time: '08:00',
                                started_at: '2026-05-09T08:00:00Z',
                                completed_at: '2026-05-09T08:30:00Z'
                            },
                            group_name: 'Push',
                            variant_name: 'A',
                            exercise_logs: []
                        }
                    ],
                    miband: []
                },
                timestamp: cachedAt
            }
        });

        await window.hydrateSectionsFromDexie();
        setOnline(window, false);
        // loadWorkoutHistoryTab uses `apiCall` for sessions/miband. apiCall
        // returns null on offline; the fetcher then throws, routing through
        // onError which preserves the cached render.
        window.apiCall = vi.fn(async () => null);

        await window.loadWorkoutHistoryTab();

        const container = document.getElementById('workout-history-display');
        expect(container.textContent).not.toContain('Loading...');
        // The cached session group name appears somewhere in the rendered output.
        expect(container.textContent).toContain('Push');
    });

    it('loadExerciseLibrary renders cached library on offline cold start', async () => {
        const { window, document } = env;
        setAuthCache(window);
        installApiCacheMap(window, {
            exercise_library: {
                data: [
                    { id: 11, name: 'Push-ups' },
                    { id: 12, name: 'Pull-ups' }
                ],
                timestamp: Date.now() - 60_000
            }
        });

        await window.hydrateSectionsFromDexie();
        setOnline(window, false);
        window.apiCall = vi.fn(async () => null);

        await window.loadExerciseLibrary();

        const container = document.getElementById('exercise-library-list');
        expect(container.textContent).toContain('Push-ups');
        expect(container.textContent).toContain('Pull-ups');
    });

    it('loadWorkoutStatsTab renders cached stats on offline cold start', async () => {
        const { window, document } = env;
        setAuthCache(window);
        installApiCacheMap(window, {
            workout_stats: {
                data: {
                    total_sessions: 12,
                    total_volume_kg: 4500,
                    streak_days: 3,
                    last_30_days: []
                },
                timestamp: Date.now() - 60_000
            }
        });

        await window.hydrateSectionsFromDexie();
        setOnline(window, false);
        window.apiCallDirect = vi.fn(async () => { throw new Error('offline'); });

        await window.loadWorkoutStatsTab();

        const container = document.getElementById('workout-stats-display');
        // The placeholder "Loading..." must be replaced with rendered stats.
        expect(container.textContent).not.toContain('Loading...');
    });

    it('workout_next is readable via DataStore.getCached after hydration so Today can paint synchronously', async () => {
        // The Today next-workout cell reads workout_next from cache on first
        // paint (via _todayReadCaches in app.js). After hydration, the row is
        // both in ApiCache (Dexie-backed) AND registered with DataStore's tag
        // index, so a later invalidateTags(['workout']) evicts it correctly.
        const { window } = env;
        setAuthCache(window);
        const cachedSession = {
            session: {
                id: 77,
                scheduled_date: '2026-05-11',
                scheduled_time: '09:00',
                status: 'pending',
                is_today: true
            },
            group_name: 'Morning 2',
            variant_name: 'Carry & Core'
        };
        installApiCacheMap(window, {
            workout_next: { data: cachedSession, timestamp: Date.now() - 30_000 }
        });

        await window.hydrateSectionsFromDexie();

        // DataStore.getCached resolves synchronously from the same ApiCache
        // row Today reads via cacheStore.getWithMeta — so a cold-start Today
        // render sees the cached next-workout instead of "missing".
        const seeded = await window.DataStore.getCached('workout_next');
        expect(seeded).toEqual(cachedSession);
    });

    it('loadExerciseLibrary shows "No cached data" empty state when Dexie is empty and we are offline', async () => {
        const { window, document } = env;
        setAuthCache(window);
        installApiCacheMap(window, {});

        await window.hydrateSectionsFromDexie();
        setOnline(window, false);
        // apiCall returns null silently on offline — the renderedSomething
        // fallback inside loadExerciseLibrary must paint the empty state.
        window.apiCall = vi.fn(async () => null);

        await window.loadExerciseLibrary();

        const container = document.getElementById('exercise-library-list');
        expect(container.textContent).toContain('No cached data');
        expect(container.textContent).not.toContain('Loading exercise library...');
    });

    it('loadWorkoutGroups shows "No cached data" empty state when Dexie is empty and we are offline', async () => {
        const { window, document } = env;
        setAuthCache(window);
        installApiCacheMap(window, {});

        await window.hydrateSectionsFromDexie();
        setOnline(window, false);
        window.apiCallDirect = vi.fn(async () => { throw new Error('offline'); });

        await window.loadWorkoutGroups();

        const container = document.getElementById('workout-groups-list');
        expect(container.textContent).toContain('No cached data');
    });

    it('loadWorkoutStatsTab shows "No cached data" empty state when Dexie is empty and we are offline', async () => {
        const { window, document } = env;
        setAuthCache(window);
        installApiCacheMap(window, {});

        await window.hydrateSectionsFromDexie();
        setOnline(window, false);
        window.apiCallDirect = vi.fn(async () => { throw new Error('offline'); });

        await window.loadWorkoutStatsTab();

        const container = document.getElementById('workout-stats-display');
        expect(container.textContent).toContain('No cached data');
    });

    it('hydration is a no-op for keys with no Dexie row', async () => {
        const { window } = env;
        setAuthCache(window);
        installApiCacheMap(window, {});

        await window.hydrateSectionsFromDexie();

        expect(await window.DataStore.getCached('workout_next')).toBeNull();
        expect(await window.DataStore.getCached('workout_history')).toBeNull();
        expect(await window.DataStore.getCached('workout_groups')).toBeNull();
        expect(await window.DataStore.getCached('workout_stats')).toBeNull();
        expect(await window.DataStore.getCached('exercise_library')).toBeNull();
    });

    it('hydration does not throw when ApiCache.getWithMeta rejects on a workout key', async () => {
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
