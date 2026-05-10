// Task 3 of the offline-meds-resilience plan — `loadMeds()` must paint the
// hydrated cache as the synchronous first paint. After the cold-start
// hydration primer (Task 2) seeds DataStore.api_cache from Dexie, opening
// the Meds screen offline should render planned-dose hour buckets and the
// "Offline · …" stale chip — not a blank list. Conversely, a cold start
// with neither a hydration nor a MedicationStore record must show the
// explicit "No cached data" empty state.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

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

function toLocalTime(date) {
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

describe('Meds cold-start offline resilience (Task 3)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renders planned doses with hourly buckets and a stale chip when Dexie pre-populated the api_cache and we are offline', async () => {
        const { window, document } = env;
        const now = new Date();
        const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
        inOneHour.setMinutes(5, 0, 0);
        const alsoInOneHour = new Date(inOneHour.getTime() + 12 * 60 * 1000);
        const fourHoursOut = new Date(inOneHour.getTime() + 3 * 60 * 60 * 1000);

        const cachedAt = Date.now() - 90 * 60 * 1000; // 90 min ago
        const seededMeds = [
            {
                id: 1,
                name: 'Allopurinol',
                dosage: '100mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(inOneHour)] }),
                archived: false
            },
            {
                id: 2,
                name: 'Bisoprolol',
                dosage: '5mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(alsoInOneHour)] }),
                archived: false
            },
            {
                id: 3,
                name: 'Metformin',
                dosage: '500mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(fourHoursOut)] }),
                archived: false
            }
        ];

        installApiCacheMap(window, {
            medications: { data: seededMeds, timestamp: cachedAt }
        });

        window.medications = [];
        window.initialAuthLoad = false;
        setOnline(window, false);
        // Offline → apiCall returns null silently (no throw, no onError).
        window.apiCall = vi.fn(async () => null);

        await window.loadMeds();

        const list = document.getElementById('med-list');
        const headers = list.querySelectorAll('.wg-section-label');
        expect(headers.length).toBeGreaterThanOrEqual(2);
        expect(headers[0].textContent.trim()).toMatch(/^\d{2}:\d{2} · in /);

        const rows = list.querySelectorAll('.wg-meds-row');
        expect(rows.length).toBe(3);

        const slot = document.getElementById('meds-schedule-stale-badge');
        expect(slot).not.toBeNull();
        const badge = slot.querySelector('.wg-stale-badge');
        expect(badge).not.toBeNull();
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
        expect(badge.textContent).toMatch(/^Offline · 1h old$/);
    });

    it('shows the explicit "No cached data" empty state when no Dexie hydration happened and we are offline', async () => {
        const { window, document } = env;
        installApiCacheMap(window, {}); // empty api_cache
        window.MedTrackerDB.MedicationStore = {
            getCache: async () => null,
            saveCache: async () => undefined
        };

        window.medications = [];
        window.initialAuthLoad = false;
        setOnline(window, false);
        // Offline → apiCall returns null silently. Neither onCached, onFresh,
        // nor onError fires; loadMeds must still surface an empty state.
        window.apiCall = vi.fn(async () => null);

        await window.loadMeds();

        const list = document.getElementById('med-list');
        const empty = list.querySelector('.empty-state-msg');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toContain('No cached data');
    });

    it('falls back to the empty state through the onError branch when apiCall throws and MedicationStore is empty', async () => {
        // The /api/medications fetcher uses apiCall, which catches network
        // errors and returns null — but a thrown rejection still routes
        // through loadSWR.onError. Make sure that path also surfaces the
        // empty state when neither api_cache nor MedicationStore have data.
        allowConsoleNoise();
        const { window, document } = env;
        installApiCacheMap(window, {});
        window.MedTrackerDB.MedicationStore = {
            getCache: async () => null,
            saveCache: async () => undefined
        };
        window.medications = [];
        window.initialAuthLoad = false;
        setOnline(window, false);
        window.apiCall = vi.fn(async () => { throw new Error('offline'); });

        await window.loadMeds();

        const list = document.getElementById('med-list');
        const empty = list.querySelector('.empty-state-msg');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toContain('No cached data');
    });

    it('swaps the stale hydrated list for the fresh fetch result without flashing an empty state', async () => {
        const { window, document } = env;
        const now = new Date();
        const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
        inOneHour.setMinutes(5, 0, 0);

        const staleMeds = [
            {
                id: 1,
                name: 'StaleMed',
                dosage: '10mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(inOneHour)] }),
                archived: false
            }
        ];
        const freshMeds = [
            {
                id: 1,
                name: 'StaleMed',
                dosage: '10mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(inOneHour)] }),
                archived: false
            },
            {
                id: 2,
                name: 'NewlyAddedMed',
                dosage: '50mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(inOneHour)] }),
                archived: false
            }
        ];

        installApiCacheMap(window, {
            medications: { data: staleMeds, timestamp: Date.now() - 6 * 60 * 60 * 1000 }
        });
        window.MedTrackerDB.MedicationStore = {
            getCache: async () => staleMeds,
            saveCache: async () => undefined
        };

        window.medications = [];
        window.initialAuthLoad = false;
        setOnline(window, true);

        // Track every render so we can prove no empty-state flash occurred
        // between onCached and onFresh.
        const renderSpy = vi.fn();
        const originalRender = window.renderMeds;
        window.renderMeds = function patchedRender() {
            renderSpy(window.medications.map((m) => m.name));
            return originalRender.apply(this, arguments);
        };

        window.apiCall = vi.fn(async (endpoint) => {
            if (endpoint === '/api/medications?archived=true') return freshMeds;
            return null;
        });

        await window.loadMeds();

        // First render came from the hydrated cache (StaleMed only),
        // second from the fresh fetch (StaleMed + NewlyAddedMed).
        expect(renderSpy).toHaveBeenCalledTimes(2);
        expect(renderSpy.mock.calls[0][0]).toEqual(['StaleMed']);
        expect(renderSpy.mock.calls[1][0]).toEqual(['StaleMed', 'NewlyAddedMed']);

        // No render received an empty list in between.
        for (const call of renderSpy.mock.calls) {
            expect(call[0].length).toBeGreaterThan(0);
        }

        // Final DOM reflects the fresh data.
        const list = document.getElementById('med-list');
        const rowNames = Array.from(list.querySelectorAll('.wg-meds-row__name')).map((el) => el.textContent);
        expect(rowNames).toEqual(expect.arrayContaining(['StaleMed', 'NewlyAddedMed']));

        // No empty-state element is present.
        expect(list.querySelector('.empty-state-msg')).toBeNull();
    });
});
