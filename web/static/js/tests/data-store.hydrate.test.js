import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDataStoreEnv } from './helpers/data-store-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

describe('DataStore.hydrateFromDexie', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  it('is a no-op when the Dexie loader returns null', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv();

    try {
      const loader = vi.fn().mockResolvedValue(null);
      const result = await window.DataStore.hydrateFromDexie('medications', loader);

      expect(loader).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ hydrated: false });
      expect(cacheMap.has('medications')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('seeds the cache from a populated Dexie record and preserves the original timestamp', async () => {
    const { window, cacheMap, metaMap, cleanup } = loadDataStoreEnv();

    try {
      const meds = [{ id: 1, name: 'Atorvastatin' }, { id: 2, name: 'Metformin' }];
      const dexieTs = Date.now() - (2 * 60 * 60 * 1000);
      const loader = vi.fn().mockResolvedValue({ data: meds, timestamp: dexieTs });

      const result = await window.DataStore.hydrateFromDexie('medications', loader, { tags: ['medications'] });

      expect(result).toEqual({ hydrated: true, fetchedAt: dexieTs });
      expect(cacheMap.get('medications')).toEqual(meds);
      expect(metaMap.get('medications')).toBe(dexieTs);

      const meta = await window.MedTrackerDB.ApiCache.getWithMeta('medications');
      expect(meta).toEqual({ data: meds, timestamp: dexieTs });
    } finally {
      cleanup();
    }
  });

  it('does not overwrite an in-memory cache entry that is fresher than the Dexie record', async () => {
    const fresherTs = Date.now();
    const { window, cacheMap, metaMap, cleanup } = loadDataStoreEnv({
      initialCache: { medications: [{ id: 'fresh' }] },
      initialMeta: { medications: fresherTs }
    });

    try {
      const olderTs = fresherTs - (5 * 60 * 1000);
      const loader = vi.fn().mockResolvedValue({
        data: [{ id: 'stale' }],
        timestamp: olderTs
      });

      const result = await window.DataStore.hydrateFromDexie('medications', loader);

      expect(result).toEqual({ hydrated: false, fetchedAt: fresherTs });
      expect(cacheMap.get('medications')).toEqual([{ id: 'fresh' }]);
      expect(metaMap.get('medications')).toBe(fresherTs);
    } finally {
      cleanup();
    }
  });

  it('applies the transform callback before seeding the cache', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv();

    try {
      const dexieTs = Date.now() - 60_000;
      const loader = vi.fn().mockResolvedValue({
        data: { items: [{ id: 1 }, { id: 2 }] },
        timestamp: dexieTs
      });
      const transform = vi.fn((raw) => raw.items.map((m) => ({ ...m, hydrated: true })));

      const result = await window.DataStore.hydrateFromDexie('medications', loader, { transform });

      expect(transform).toHaveBeenCalledWith({ items: [{ id: 1 }, { id: 2 }] });
      expect(result.hydrated).toBe(true);
      expect(cacheMap.get('medications')).toEqual([
        { id: 1, hydrated: true },
        { id: 2, hydrated: true }
      ]);
    } finally {
      cleanup();
    }
  });

  it('hydrates when the loader returns a raw value (no { data, timestamp } envelope)', async () => {
    const { window, cacheMap, metaMap, cleanup } = loadDataStoreEnv();

    try {
      const meds = [{ id: 1 }];
      const loader = vi.fn().mockResolvedValue(meds);

      const before = Date.now();
      const result = await window.DataStore.hydrateFromDexie('medications', loader);
      const after = Date.now();

      expect(result.hydrated).toBe(true);
      expect(result.fetchedAt).toBeGreaterThanOrEqual(before);
      expect(result.fetchedAt).toBeLessThanOrEqual(after);
      expect(cacheMap.get('medications')).toEqual(meds);
      // No source timestamp → falls back to setCached (Date.now() stamp).
      expect(metaMap.get('medications')).toBeGreaterThanOrEqual(before);
    } finally {
      cleanup();
    }
  });

  it('does not throw when the Dexie loader rejects', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv();

    try {
      const loader = vi.fn().mockRejectedValue(new Error('IndexedDB unavailable'));

      const result = await window.DataStore.hydrateFromDexie('medications', loader);

      expect(result).toEqual({ hydrated: false });
      expect(cacheMap.has('medications')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('returns { hydrated: false } for a missing key or non-function loader', async () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      expect(await window.DataStore.hydrateFromDexie('', async () => ({ data: [1] })))
        .toEqual({ hydrated: false });
      expect(await window.DataStore.hydrateFromDexie('medications', null))
        .toEqual({ hydrated: false });
    } finally {
      cleanup();
    }
  });

  it('registers tags so a later invalidateByTag evicts the hydrated entry', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv();

    try {
      const loader = vi.fn().mockResolvedValue({
        data: [{ id: 1 }],
        timestamp: Date.now() - 10_000
      });

      await window.DataStore.hydrateFromDexie('medications', loader, { tags: ['medications'] });
      expect(cacheMap.has('medications')).toBe(true);

      await window.DataStore.invalidateByTag('medications');
      expect(cacheMap.has('medications')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('still registers tags when the freshness check short-circuits the write', async () => {
    // Mirrors the cold-start path: bootstrap from the previous session wrote
    // MedicationStore (Dexie) first, ApiCache second, so on reload the
    // ApiCache row is slightly newer than the MedicationStore row. The
    // freshness no-op must still register tags or invalidateByTag silently
    // misses the key until some later loadSWR/setCachedWithTags repopulates it.
    const fresherTs = Date.now();
    const { window, cacheMap, cleanup } = loadDataStoreEnv({
      initialCache: { medications: [{ id: 'fresh' }] },
      initialMeta: { medications: fresherTs }
    });

    try {
      const olderTs = fresherTs - 1_000;
      const loader = vi.fn().mockResolvedValue({
        data: [{ id: 'stale' }],
        timestamp: olderTs
      });

      const result = await window.DataStore.hydrateFromDexie('medications', loader, { tags: ['medications'] });
      expect(result).toEqual({ hydrated: false, fetchedAt: fresherTs });
      expect(cacheMap.get('medications')).toEqual([{ id: 'fresh' }]);

      await window.DataStore.invalidateByTag('medications');
      expect(cacheMap.has('medications')).toBe(false);
    } finally {
      cleanup();
    }
  });
});
