// Task 6 of local-first read resilience — every priority section header
// (BP, Weight, Meds Schedule, Meds History, Workouts, Vitals/Health
// Overview + Notes) mounts the same wg-stale-badge chip. The chip is
// driven by the api_cache timestamp for the section's key and flips to the
// offline tone whenever navigator.onLine is false.
//
// Each test in this file:
//   1. Installs MedTrackerDB.ApiCache with a pre-populated entry (mirrors a
//      bootstrap-warmed or previously-fetched cache).
//   2. Forces navigator.onLine = false so the section's data render survives
//      without hitting the network.
//   3. Stubs window.apiCall so the section does NOT clobber the cache with a
//      null fetch result.
//   4. Calls the section's load function and asserts the badge chip is mounted
//      with the offline tone.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

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

function expectOfflineBadge(slot) {
    expect(slot).not.toBeNull();
    expect(slot.classList.contains('hidden')).toBe(false);
    const badge = slot.querySelector('.wg-stale-badge');
    expect(badge).not.toBeNull();
    expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
    expect(badge.classList.contains('wg-stale-badge--warning')).toBe(true);
    expect(badge.textContent.startsWith('Offline · ')).toBe(true);
    return badge;
}

describe('Section-header stale badges (Task 6)', () => {
    describe('BP', () => {
        let env;
        beforeEach(() => { env = loadFrontendEnv(); });
        afterEach(() => { try { env.window.localStorage.clear(); } catch (_) { /* ignore */ } env.cleanup(); env = null; });

        it('renders the offline chip after loadBPReadings() with a warm api_cache', async () => {
            const { window, document } = env;
            window.MedTrackerDB = {
                BPStore: {
                    getPending: async () => [],
                    getRejected: async () => [],
                    getAll: async () => [],
                    confirmDelete: async () => undefined
                }
            };
            const cachedAt = Date.now() - 12 * 60 * 1000; // 12 min ago
            installApiCacheMap(window, {
                bp: {
                    data: {
                        readingsRes: [{ id: 1, measured_at: new Date().toISOString(), systolic: 120, diastolic: 80 }],
                        goalRes: { systolic: 120, diastolic: 80 },
                        statsRes: {}
                    },
                    timestamp: cachedAt
                }
            });
            setOnline(window, false);
            // Ensure no fetch can land — apiCall returns null on offline; the
            // SWR fetcher returns null and the cached render path runs.
            window.apiCall = vi.fn(async () => null);

            await window.loadBPReadings();

            expectOfflineBadge(document.getElementById('bp-stale-badge'));
        });
    });

    describe('Weight', () => {
        let env;
        beforeEach(() => { env = loadFrontendEnv(); });
        afterEach(() => { try { env.window.localStorage.clear(); } catch (_) { /* ignore */ } env.cleanup(); env = null; });

        it('renders the offline chip after loadWeightLogs() with a warm api_cache', async () => {
            const { window, document } = env;
            window.MedTrackerDB = {
                WeightStore: {
                    getPending: async () => [],
                    getRejected: async () => [],
                    getAll: async () => [],
                    confirmDelete: async () => undefined
                }
            };
            const cachedAt = Date.now() - 30 * 60 * 1000; // 30 min ago
            installApiCacheMap(window, {
                weight: {
                    data: {
                        logsRes: [{ id: 1, measured_at: new Date().toISOString(), weight: 75.0 }],
                        goalRes: {}
                    },
                    timestamp: cachedAt
                }
            });
            setOnline(window, false);
            window.apiCall = vi.fn(async () => null);

            await window.loadWeightLogs();

            expectOfflineBadge(document.getElementById('weight-stale-badge'));
        });
    });

    describe('Meds Schedule', () => {
        let env;
        beforeEach(() => { env = loadFrontendEnv(); });
        afterEach(() => { try { env.window.localStorage.clear(); } catch (_) { /* ignore */ } env.cleanup(); env = null; });

        it('renders the offline chip in the Schedule subtab after loadMeds() with a warm api_cache', async () => {
            const { window, document } = env;
            const cachedAt = Date.now() - 90 * 60 * 1000; // 90 min ago
            installApiCacheMap(window, {
                medications: {
                    // `schedule` is stored as a JSON string in the medications
                    // table — _buildMedsRow JSON.parses it.
                    data: [{
                        id: 1,
                        name: 'Aspirin',
                        dosage: '100mg',
                        schedule: JSON.stringify({ type: 'daily', times: ['08:00'] })
                    }],
                    timestamp: cachedAt
                }
            });
            // Bootstrap path normally pre-populates `medications` so initialAuthLoad
            // is true; bypass that branch by ensuring the variable is reset.
            window.medications = [];
            window.initialAuthLoad = false;
            setOnline(window, false);
            window.apiCall = vi.fn(async () => null);

            await window.loadMeds();

            const slot = document.getElementById('meds-schedule-stale-badge');
            const badge = expectOfflineBadge(slot);
            // 90m old offline → "Offline · 1h old" (formatAge truncates to whole hours)
            expect(badge.textContent).toMatch(/^Offline · 1h old$/);
        });
    });

    describe('Meds History', () => {
        let env;
        beforeEach(() => { env = loadFrontendEnv(); });
        afterEach(() => { try { env.window.localStorage.clear(); } catch (_) { /* ignore */ } env.cleanup(); env = null; });

        it('renders the offline chip in the History subtab after loadHistory() with a warm api_cache', async () => {
            const { window, document } = env;
            // loadHistory() uses key `history_<days>_<medId>` — defaults are 3 days, med 0.
            const days = document.getElementById('history-filter-days').value;
            const medId = document.getElementById('history-filter-med').value;
            const cacheKey = `history_${days}_${medId}`;
            const cachedAt = Date.now() - 7 * 60 * 1000; // 7 min ago
            installApiCacheMap(window, {
                [cacheKey]: { data: [], timestamp: cachedAt },
                medications: { data: [], timestamp: cachedAt }
            });
            window.medications = [{ id: 1, name: 'Aspirin' }];
            setOnline(window, false);
            window.apiCall = vi.fn(async () => null);

            await window.loadHistory();

            expectOfflineBadge(document.getElementById('meds-history-stale-badge'));
        });
    });

    describe('Workouts', () => {
        let env;
        beforeEach(() => { env = loadFrontendEnv({ withWorkout: true }); });
        afterEach(() => { try { env.window.localStorage.clear(); } catch (_) { /* ignore */ } env.cleanup(); env = null; });

        it('renders the offline chip in the History subtab after loadNextWorkout()', async () => {
            const { window, document } = env;
            window.MedTrackerDB = {
                WorkoutStore: { saveCache: async () => undefined, getCache: async () => null }
            };
            const cachedAt = Date.now() - 45 * 60 * 1000; // 45 min ago
            installApiCacheMap(window, {
                workout_next: {
                    data: { session: null },
                    timestamp: cachedAt
                }
            });
            setOnline(window, false);
            window.apiCall = vi.fn(async () => null);

            await window.loadNextWorkout();

            expectOfflineBadge(document.getElementById('workout-history-stale-badge'));
        });

        it('renders the offline chip in the Groups subtab after loadWorkoutGroups()', async () => {
            const { window, document } = env;
            window.MedTrackerDB = {
                WorkoutStore: { saveCache: async () => undefined, getCache: async () => null }
            };
            const cachedAt = Date.now() - 20 * 60 * 1000;
            installApiCacheMap(window, {
                workout_groups: {
                    data: [{ id: 1, name: 'Push', is_rotating: false, active: true }],
                    timestamp: cachedAt
                }
            });
            setOnline(window, false);
            window.apiCall = vi.fn(async () => null);

            await window.loadWorkoutGroups();

            expectOfflineBadge(document.getElementById('workout-groups-stale-badge'));
        });
    });

    describe('Vitals/Health Overview', () => {
        let env;
        beforeEach(() => { env = loadFrontendEnv(); });
        afterEach(() => { try { env.window.localStorage.clear(); } catch (_) { /* ignore */ } env.cleanup(); env = null; });

        it('renders the offline chip after loadHealthOverview() with a warm api_cache', async () => {
            const { window, document } = env;
            // healthOverviewCacheKey() includes the active date (~today's ISO),
            // so we read whatever key the helper picks and seed the cache for it.
            const hoKey = window.healthOverviewCacheKey();
            const cachedAt = Date.now() - 15 * 60 * 1000;
            installApiCacheMap(window, {
                [hoKey]: {
                    data: { sleep_stats_7d: [], steps_stats_7d: [], hr_avg_7d: null },
                    timestamp: cachedAt
                }
            });
            setOnline(window, false);
            window.apiCall = vi.fn(async () => null);

            await window.loadHealthOverview();

            expectOfflineBadge(document.getElementById('health-overview-stale-badge'));
        });
    });

    describe('Vitals/Health Notes', () => {
        let env;
        beforeEach(() => { env = loadFrontendEnv(); });
        afterEach(() => { try { env.window.localStorage.clear(); } catch (_) { /* ignore */ } env.cleanup(); env = null; });

        it('renders the offline chip after loadNotes() with a warm api_cache', async () => {
            const { window, document } = env;
            const cachedAt = Date.now() - 25 * 60 * 1000;
            installApiCacheMap(window, {
                diary_notes: {
                    data: [{ id: 1, body: 'Slept well', tag: 'SLEEP', created_at: new Date().toISOString() }],
                    timestamp: cachedAt
                }
            });
            setOnline(window, false);
            window.apiCall = vi.fn(async () => null);

            await window.loadNotes();

            expectOfflineBadge(document.getElementById('health-notes-stale-badge'));
        });
    });
});
