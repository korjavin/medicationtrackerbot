import { describe, expect, it, vi } from 'vitest';
import { loadDataStoreEnv } from './helpers/data-store-harness.js';

describe('data-store.js unit tests', () => {
  it('loadSWR emits cached first, then fresh, and updates cache', async () => {
    const cachedValue = { source: 'cache' };
    const freshValue = { source: 'fresh' };
    const { window, cacheMap, cleanup } = loadDataStoreEnv({
      initialCache: { meds: cachedValue }
    });

    try {
      const onCached = vi.fn();
      const onFresh = vi.fn();
      const fetcher = vi.fn().mockResolvedValue(freshValue);

      const result = await window.DataStore.loadSWR({
        key: 'meds',
        tags: ['medication'],
        fetcher,
        onCached,
        onFresh
      });

      expect(onCached).toHaveBeenCalledWith(cachedValue);
      expect(onFresh).toHaveBeenCalledWith(freshValue, cachedValue);
      expect(onCached.mock.invocationCallOrder[0]).toBeLessThan(onFresh.mock.invocationCallOrder[0]);
      expect(result).toEqual({ cached: cachedValue, fresh: freshValue });
      expect(cacheMap.get('meds')).toEqual(freshValue);
    } finally {
      cleanup();
    }
  });

  it('fetchFresh deduplicates in-flight requests per key', async () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      let resolveFetch;
      const fetcher = vi.fn(() => new Promise((resolve) => {
        resolveFetch = resolve;
      }));

      const req1 = window.DataStore.fetchFresh('bp', fetcher, ['bp']);
      const req2 = window.DataStore.fetchFresh('bp', fetcher, ['bp']);

      expect(fetcher).toHaveBeenCalledTimes(1);

      resolveFetch({ ok: true });
      const [res1, res2] = await Promise.all([req1, req2]);

      expect(res1).toEqual({ ok: true });
      expect(res2).toEqual({ ok: true });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('invalidates cache entries by tags only for linked keys', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv();

    try {
      await window.DataStore.fetchFresh('bp_key', async () => ({ k: 1 }), ['bp']);
      await window.DataStore.fetchFresh('shared_key', async () => ({ k: 2 }), ['bp', 'weight']);
      await window.DataStore.fetchFresh('food_key', async () => ({ k: 3 }), ['food']);

      expect(cacheMap.has('bp_key')).toBe(true);
      expect(cacheMap.has('shared_key')).toBe(true);
      expect(cacheMap.has('food_key')).toBe(true);

      await window.DataStore.invalidateTags(['bp']);

      expect(cacheMap.has('bp_key')).toBe(false);
      expect(cacheMap.has('shared_key')).toBe(false);
      expect(cacheMap.has('food_key')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('applyChangesPayload invalidates changed tags, requests refresh and stores cursor', async () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      const invalidateSpy = vi.spyOn(window.DataStore, 'invalidateTags').mockResolvedValue(undefined);
      const requestTabRefreshSpy = vi.fn();
      window.requestTabRefresh = requestTabRefreshSpy;

      await window.DataStore.applyChangesPayload({
        cursor: 123,
        changed_tags: ['bp', 'weight']
      });

      expect(invalidateSpy).toHaveBeenCalledWith(['bp', 'weight']);
      expect(requestTabRefreshSpy).toHaveBeenCalledWith({
        changedTags: ['bp', 'weight'],
        source: 'changes'
      });
      expect(window.DataStore.getChangeCursor()).toBe(123);
    } finally {
      cleanup();
    }
  });

  it('setChangeCursor/getChangeCursor sanitize invalid values', () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      expect(window.DataStore.getChangeCursor()).toBe(0);

      window.DataStore.setChangeCursor(17.9);
      expect(window.DataStore.getChangeCursor()).toBe(17);

      window.DataStore.setChangeCursor(-5);
      expect(window.DataStore.getChangeCursor()).toBe(17);

      window.localStorage.setItem('medtracker_changes_cursor', 'NaN');
      expect(window.DataStore.getChangeCursor()).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('pollChangesOnce triggers unauthorized handler only once', async () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      const unauthorizedSpy = vi.fn();
      window.onDataStoreUnauthorized = unauthorizedSpy;
      window.apiCallDirect = vi.fn().mockRejectedValue(new Error('Unauthorized'));

      await window.DataStore.pollChangesOnce();
      await window.DataStore.pollChangesOnce();

      expect(unauthorizedSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('requestTabRefresh falls back to reloadCurrentTab when no global request handler exists', () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      const reloadSpy = vi.fn();
      window.requestTabRefresh = undefined;
      window.reloadCurrentTab = reloadSpy;

      window.DataStore.requestTabRefresh(['bp']);
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });
});
