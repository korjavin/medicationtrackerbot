import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

// Map-backed fake of MedTrackerDB.ApiCache mirroring the row shape of the
// real Dexie api_cache table — same contract used by app.dexie-hydration.test.js.
function installFakeApiCache(window) {
    const map = new Map();
    const meta = new Map();
    window.MedTrackerDB = window.MedTrackerDB || {};
    window.MedTrackerDB.ApiCache = {
        async get(key) { return map.has(key) ? map.get(key) : null; },
        async getWithMeta(key) {
            if (!map.has(key)) return null;
            return { data: map.get(key), timestamp: meta.has(key) ? meta.get(key) : null };
        },
        async set(key, value) { map.set(key, value); meta.set(key, Date.now()); },
        async setWithMeta(key, value, timestamp) {
            map.set(key, value);
            meta.set(key, Number.isFinite(timestamp) ? timestamp : Date.now());
        },
        async clear(key) { map.delete(key); meta.delete(key); }
    };
    return { cacheMap: map, metaMap: meta };
}

describe('applyBootstrapPayload — medications cache + Dexie seeding', () => {
    beforeEach(() => {
        allowConsoleNoise();
    });

    it('seeds DataStore.getCached("medications") and MedicationStore Dexie cache from the bootstrap payload', async () => {
        const { window, cleanup } = loadFrontendEnv();
        try {
            const { cacheMap } = installFakeApiCache(window);

            const saveCacheSpy = vi.fn().mockResolvedValue();
            window.MedTrackerDB.MedicationStore = {
                saveCache: saveCacheSpy,
                loadCache: vi.fn().mockImplementation(async () => {
                    const calls = saveCacheSpy.mock.calls;
                    if (!calls.length) return null;
                    return { data: calls[calls.length - 1][0], timestamp: Date.now() };
                })
            };

            const meds = [
                { id: 1, name: 'Atorvastatin', schedule: '{}' },
                { id: 2, name: 'Metformin', schedule: '{}' }
            ];

            await window.applyBootstrapPayload({
                cursor: 1,
                features: { medication: true },
                medications: meds,
                settings: {}
            });

            // DataStore in-memory cache has the meds list under the canonical key.
            const seeded = await window.DataStore.getCached('medications');
            expect(seeded).toEqual(meds);
            // Underlying ApiCache row was written too — survives a reload.
            expect(cacheMap.get('medications')).toEqual(meds);
            // MedicationStore.saveCache was invoked with the exact list so a
            // subsequent cold-start hydration sees the same data.
            expect(saveCacheSpy).toHaveBeenCalledTimes(1);
            expect(saveCacheSpy).toHaveBeenCalledWith(meds);
            // Dexie loadCache returns the saved meds — round-trip works.
            const dexieRecord = await window.MedTrackerDB.MedicationStore.loadCache();
            expect(dexieRecord.data).toEqual(meds);
        } finally {
            cleanup();
        }
    });

    it('tolerates a bootstrap response without a medications field — no error and no cache overwrite', async () => {
        const { window, cleanup } = loadFrontendEnv();
        try {
            const { cacheMap } = installFakeApiCache(window);

            // Pre-seed an existing medications cache (simulating a prior bootstrap
            // or Dexie hydration). A medications-less payload must not wipe it.
            const existing = [{ id: 42, name: 'Pre-existing' }];
            await window.DataStore.setCachedWithTags('medications', existing, ['medications']);
            expect(cacheMap.get('medications')).toEqual(existing);

            const saveCacheSpy = vi.fn().mockResolvedValue();
            window.MedTrackerDB.MedicationStore = { saveCache: saveCacheSpy };

            // Payload omits `medications` entirely.
            await expect(window.applyBootstrapPayload({
                cursor: 2,
                features: { medication: true },
                settings: {}
            })).resolves.toBe(true);

            // Existing cache is preserved untouched.
            expect(await window.DataStore.getCached('medications')).toEqual(existing);
            expect(cacheMap.get('medications')).toEqual(existing);
            // No Dexie write occurred.
            expect(saveCacheSpy).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('skips medications seeding when the field is present but not an array', async () => {
        const { window, cleanup } = loadFrontendEnv();
        try {
            const { cacheMap } = installFakeApiCache(window);

            const saveCacheSpy = vi.fn().mockResolvedValue();
            window.MedTrackerDB.MedicationStore = { saveCache: saveCacheSpy };

            // Backend returning null (e.g. archived listing failed) should be
            // a safe no-op — the field is present but unusable.
            await window.applyBootstrapPayload({
                cursor: 3,
                features: { medication: true },
                medications: null,
                settings: {}
            });

            expect(saveCacheSpy).not.toHaveBeenCalled();
            expect(cacheMap.has('medications')).toBe(false);
        } finally {
            cleanup();
        }
    });
});
