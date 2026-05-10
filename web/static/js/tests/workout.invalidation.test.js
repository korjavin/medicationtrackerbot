// Verifies that workout-mutation invalidation drops both the DataStore
// api_cache entries (via the 'workout' tag) and the legacy WorkoutStore
// Dexie cache, so a successful save followed by a failed reload cannot
// resurrect the pre-mutation payload through offlineAwareApiCall's
// handleOfflineWorkoutRead fallback.
//
// Also verifies that the explicit workout cache keys are reachable from a
// push-modal mutation (snoozeWorkout / skipWorkout in app.js) before the
// user has ever visited the workouts tab — i.e. before loadWorkoutGroups
// / loadNextWorkout would have registered those keys with the 'workout'
// tag at runtime.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

describe('workout invalidation: tag + legacy cache + push-modal flows', () => {
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

    it('clears WorkoutStore legacy cache and the explicit workout_* api_cache keys on invalidate', async () => {
        const { window } = env;

        const ApiCache = new Map();
        window.MedTrackerDB = {
            ApiCache: {
                async get(key) { return ApiCache.has(key) ? ApiCache.get(key) : null; },
                async set(key, value) { ApiCache.set(key, value); },
                async clear(key) { ApiCache.delete(key); }
            },
            WorkoutStore: {
                clearCache: vi.fn().mockResolvedValue(undefined)
            }
        };

        // Seed the api_cache as if a prior fetch had populated each workout
        // key. Tag registration happens eagerly when workout.js loads, so
        // invalidateTags(['workout']) should reach all four entries even
        // without a prior loadSWR call from the workouts tab.
        await window.DataStore.setCached('workout_next', { stale: 'next' });
        await window.DataStore.setCached('workout_history', { stale: 'history' });
        await window.DataStore.setCached('workout_groups', [{ id: 1, name: 'Stale' }]);
        await window.DataStore.setCached('workout_stats', { stale: 'stats' });

        await window.invalidateWorkoutCache();

        expect(await window.DataStore.getCached('workout_next')).toBeNull();
        expect(await window.DataStore.getCached('workout_history')).toBeNull();
        expect(await window.DataStore.getCached('workout_groups')).toBeNull();
        expect(await window.DataStore.getCached('workout_stats')).toBeNull();
        expect(window.MedTrackerDB.WorkoutStore.clearCache).toHaveBeenCalledTimes(1);
    });

    it('snoozeWorkout from app.js invalidates workout caches via the helper, not just the tag', async () => {
        const { window, document } = env;

        const ApiCache = new Map();
        window.MedTrackerDB = {
            ApiCache: {
                async get(key) { return ApiCache.has(key) ? ApiCache.get(key) : null; },
                async set(key, value) { ApiCache.set(key, value); },
                async clear(key) { ApiCache.delete(key); }
            },
            WorkoutStore: {
                clearCache: vi.fn().mockResolvedValue(undefined)
            }
        };

        await window.DataStore.setCached('workout_groups', [{ id: 7, name: 'Pre-snooze' }]);

        window.apiCall = vi.fn().mockResolvedValue({ ok: true });
        window.Telegram.WebApp.showAlert = vi.fn();

        window.showWorkoutStartModal(55);
        expect(document.getElementById('workout-start-modal').classList.contains('hidden')).toBe(false);

        await window.snoozeWorkout(15);

        expect(window.apiCall).toHaveBeenCalledWith('/api/workout/sessions/55/snooze', 'POST', { minutes: 15 });
        expect(await window.DataStore.getCached('workout_groups')).toBeNull();
        expect(window.MedTrackerDB.WorkoutStore.clearCache).toHaveBeenCalled();
    });

    it('loadNextWorkout preserves the cached card when the refresh fails offline', async () => {
        const { window, document } = env;

        // Container the next-workout card paints into.
        const container = document.getElementById('next-workout-card');
        expect(container).not.toBeNull();

        const ApiCache = new Map();
        window.MedTrackerDB = {
            ApiCache: {
                async get(key) { return ApiCache.has(key) ? ApiCache.get(key) : null; },
                async getWithMeta(key) {
                    if (!ApiCache.has(key)) return null;
                    return { data: ApiCache.get(key), timestamp: Date.now() };
                },
                async set(key, value) { ApiCache.set(key, value); },
                async clear(key) { ApiCache.delete(key); }
            },
            WorkoutStore: {
                saveCache: async () => undefined,
                getCache: async () => null,
                clearCache: vi.fn().mockResolvedValue(undefined)
            }
        };

        // Seed a real session payload (not just { session: null }) so onCached
        // paints a card we can detect afterwards.
        const cached = {
            session: {
                id: 42,
                scheduled_date: '2026-05-09',
                scheduled_time: '08:00',
                status: 'pending',
                is_snoozed: false,
                is_today: true
            },
            group_name: 'Push',
            variant_name: 'A',
            exercises_count: 3,
            variant_id: 1,
            group_id: 1,
            is_rotating: false
        };
        await window.DataStore.setCached('workout_next', cached);

        // Simulate offline: apiCallDirect throws. The fix routes that into
        // loadSWR's onError, which preserves whatever onCached painted.
        window.apiCallDirect = vi.fn(async () => { throw new Error('offline'); });

        await window.loadNextWorkout();

        // The cached card stays on screen — the bug was that allowNullFresh
        // + apiCall returning null caused onFresh(null) to clear it.
        expect(container.children.length).toBeGreaterThan(0);
        expect(container.textContent).toContain('Push');
    });

    it('loadWorkoutGroups renders the no-cache fallback after a successful save followed by a failed refresh', async () => {
        const { window, document } = env;

        const container = document.getElementById('workout-groups-list');
        expect(container).not.toBeNull();

        const ApiCache = new Map();
        window.MedTrackerDB = {
            ApiCache: {
                async get(key) { return ApiCache.has(key) ? ApiCache.get(key) : null; },
                async getWithMeta(key) {
                    if (!ApiCache.has(key)) return null;
                    return { data: ApiCache.get(key), timestamp: Date.now() };
                },
                async set(key, value) { ApiCache.set(key, value); },
                async clear(key) { ApiCache.delete(key); }
            },
            WorkoutStore: {
                saveCache: async () => undefined,
                getCache: async () => null,
                clearCache: vi.fn().mockResolvedValue(undefined)
            }
        };

        // Seed pre-mutation groups, then simulate the save+invalidate path:
        // invalidateWorkoutCache wipes both api_cache and the legacy
        // WorkoutStore. With no cached value, loadWorkoutGroups must drive
        // its onError branch (not silently no-op) when the refresh fails.
        await window.DataStore.setCached('workout_groups', [{ id: 1, name: 'Pre-save' }]);
        await window.invalidateWorkoutCache();

        window.apiCallDirect = vi.fn(async () => { throw new Error('offline'); });

        await window.loadWorkoutGroups();

        // The bug was that without `allowNullFresh` and apiCall returning
        // null, loadSWR skipped both onFresh AND onError, leaving the
        // pre-mutation DOM untouched. With apiCallDirect throwing, onError
        // fires and renders the explicit no-cached-data hint.
        expect(container.textContent).toContain('No cached data');
        expect(container.textContent).not.toContain('Pre-save');
    });

    it('loadWorkoutStatsTab renders the no-cache fallback after a successful save followed by a failed refresh', async () => {
        const { window, document } = env;

        const container = document.getElementById('workout-stats-display');
        expect(container).not.toBeNull();

        // Seed pre-render content so we can detect that the fallback wipes
        // it. The bug class: invalidateWorkoutCache wipes workout_stats from
        // api_cache, then a failed refresh leaves the pre-mutation DOM in
        // place because loadSWR skips both onFresh (null) and onError (no
        // throw). Pre-paint a fake stats card with apiCall+null behavior so
        // the assertion has something distinct to disprove.
        const stalePara = document.createElement('p');
        stalePara.textContent = 'Stale stats — Active Weeks 9';
        container.replaceChildren(stalePara);

        const ApiCache = new Map();
        window.MedTrackerDB = {
            ApiCache: {
                async get(key) { return ApiCache.has(key) ? ApiCache.get(key) : null; },
                async getWithMeta(key) {
                    if (!ApiCache.has(key)) return null;
                    return { data: ApiCache.get(key), timestamp: Date.now() };
                },
                async set(key, value) { ApiCache.set(key, value); },
                async clear(key) { ApiCache.delete(key); }
            },
            WorkoutStore: {
                saveCache: async () => undefined,
                getCache: async () => null,
                clearCache: vi.fn().mockResolvedValue(undefined)
            }
        };

        await window.DataStore.setCached('workout_stats', { total_sessions: 9 });
        await window.invalidateWorkoutCache();

        window.apiCallDirect = vi.fn(async () => { throw new Error('offline'); });

        await window.loadWorkoutStatsTab();

        // The fix routes the offline failure into onError, which renders
        // the explicit no-cached-data hint instead of leaving the prior
        // DOM untouched.
        expect(container.textContent).toContain('No cached data');
        expect(container.textContent).not.toContain('Stale stats');
    });
});
