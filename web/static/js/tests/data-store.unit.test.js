import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDataStoreEnv } from './helpers/data-store-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

describe('data-store.js unit tests', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

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

  it('registerTags lets invalidateTags evict keys seeded outside fetchFresh', async () => {
    // Today reads some keys directly from IndexedDB (bypassing loadSWR /
    // fetchFresh); without registerTags the key→tag map is empty for those
    // keys so subsequent invalidateTags(['food']) silently no-ops. This
    // pins the contract that registerTags alone is enough to opt into
    // tag invalidation.
    const { window, cacheMap, cleanup } = loadDataStoreEnv({
      initialCache: { food_2026_04_24_day: { groups: [] } }
    });

    try {
      // No registration yet — invalidate is a no-op.
      await window.DataStore.invalidateTags(['food']);
      expect(cacheMap.has('food_2026_04_24_day')).toBe(true);

      window.DataStore.registerTags('food_2026_04_24_day', ['food']);
      await window.DataStore.invalidateTags(['food']);

      expect(cacheMap.has('food_2026_04_24_day')).toBe(false);
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

  it('advanceCursorSilently advances cursor but does NOT invalidate tags', async () => {
    // Regression: advanceCursorSilently runs fire-and-forget from
    // apiCallDirect after every successful write. If it invalidates the
    // tags returned by /api/changes (which include the client's own write)
    // it races with the caller's own post-write refetch chain —
    // bumping the fetchGeneration of the key the caller is currently
    // fetching and causing the resolving response to be dropped as
    // "superseded", leaving the cache empty. The Today fuel/weight/BP
    // tile then renders 0 after a save. The cursor advance is the only
    // safe side effect here; cross-client changes are caught by the
    // regular 30s poll.
    const { window, cleanup } = loadDataStoreEnv();

    try {
      window.apiCallDirect = vi.fn().mockResolvedValue({
        cursor: 42,
        changed_tags: ['food', 'weight', 'bp']
      });
      const invalidateSpy = vi.spyOn(window.DataStore, 'invalidateTags');

      await window.DataStore.advanceCursorSilently();

      expect(invalidateSpy).not.toHaveBeenCalled();
      expect(window.DataStore.getChangeCursor()).toBe(42);
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

  it('setCachedWithTags beats a stale in-flight fetchFresh resolving after bootstrap', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv();

    try {
      let resolveStaleFetch;
      const staleFetcher = vi.fn(() => new Promise((resolve) => {
        resolveStaleFetch = resolve;
      }));

      const staleReq = window.DataStore.fetchFresh('next_intake', staleFetcher, ['history', 'medications']);

      await window.DataStore.setCachedWithTags('next_intake', { scheduled_at: 'bootstrap-value' }, ['history', 'medications']);
      expect(cacheMap.get('next_intake')).toEqual({ scheduled_at: 'bootstrap-value' });

      resolveStaleFetch({ scheduled_at: 'stale-value' });
      await staleReq;

      expect(cacheMap.get('next_intake')).toEqual({ scheduled_at: 'bootstrap-value' });
    } finally {
      cleanup();
    }
  });

  it('fetchFresh resolves with null (not the stale payload) when superseded by setCachedWithTags', async () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      let resolveStaleFetch;
      const staleFetcher = vi.fn(() => new Promise((resolve) => {
        resolveStaleFetch = resolve;
      }));

      const staleReq = window.DataStore.fetchFresh('next_intake', staleFetcher, ['history', 'medications']);

      await window.DataStore.setCachedWithTags('next_intake', { scheduled_at: 'bootstrap-value' }, ['history', 'medications']);

      resolveStaleFetch({ scheduled_at: 'stale-value' });
      const staleResult = await staleReq;

      expect(staleResult).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('loadSWR skips onFresh when the in-flight fetch is superseded by setCachedWithTags', async () => {
    const { window, cleanup } = loadDataStoreEnv({
      initialCache: { next_intake: { scheduled_at: 'cached-value' } }
    });

    try {
      let resolveStaleFetch;
      const staleFetcher = vi.fn(() => new Promise((resolve) => {
        resolveStaleFetch = resolve;
      }));

      const onCached = vi.fn();
      const onFresh = vi.fn();

      const swrPromise = window.DataStore.loadSWR({
        key: 'next_intake',
        tags: ['history', 'medications'],
        fetcher: staleFetcher,
        onCached,
        onFresh
      });

      // Wait until loadSWR has actually invoked the fetcher (i.e. is past
      // getCached/onCached and is awaiting fetchFresh), so the simulated
      // bootstrap write below truly races an in-flight fetch.
      while (staleFetcher.mock.calls.length === 0) {
        await Promise.resolve();
      }

      await window.DataStore.setCachedWithTags('next_intake', { scheduled_at: 'bootstrap-value' }, ['history', 'medications']);

      resolveStaleFetch({ scheduled_at: 'stale-value' });
      const result = await swrPromise;

      expect(onCached).toHaveBeenCalledTimes(1);
      expect(onFresh).not.toHaveBeenCalled();
      expect(result.fresh).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('loadSWR with allowNullFresh still skips onFresh when superseded by invalidateByTag', async () => {
    // Regression: loadHistory() passes allowNullFresh:true so an empty backend
    // response can clear the list. A superseded fetchFresh also resolves with
    // null — without the wasSuperseded guard, onFresh would fire with null and
    // blank a list that a concurrent newer fetch is about to repaint correctly.
    const { window, cleanup } = loadDataStoreEnv({
      initialCache: { history_7_all: [{ id: 1 }, { id: 2 }] }
    });

    try {
      let resolveStaleFetch;
      const staleFetcher = vi.fn(() => new Promise((resolve) => {
        resolveStaleFetch = resolve;
      }));

      const onCached = vi.fn();
      const onFresh = vi.fn();

      const swrPromise = window.DataStore.loadSWR({
        key: 'history_7_all',
        tags: ['history'],
        fetcher: staleFetcher,
        allowNullFresh: true,
        onCached,
        onFresh
      });

      while (staleFetcher.mock.calls.length === 0) {
        await Promise.resolve();
      }

      // Simulate a write-path invalidation (matches what `await DataStore.invalidateByTag('history')`
      // does after confirmLogPast / triggerNextIntake).
      await window.DataStore.invalidateByTag('history');

      resolveStaleFetch([{ id: 1 }, { id: 2 }, { id: 3 }]);
      const result = await swrPromise;

      expect(onFresh).not.toHaveBeenCalled();
      expect(result.fresh).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('loadSWR with allowNullFresh calls onFresh when the backend legitimately returns null', async () => {
    const { window, cleanup } = loadDataStoreEnv({
      initialCache: { history_7_all: [{ id: 1 }] }
    });

    try {
      const fetcher = vi.fn().mockResolvedValue(null);
      const onFresh = vi.fn();

      const result = await window.DataStore.loadSWR({
        key: 'history_7_all',
        tags: ['history'],
        fetcher,
        allowNullFresh: true,
        onFresh
      });

      expect(onFresh).toHaveBeenCalledWith(null, [{ id: 1 }]);
      expect(result.fresh).toBeNull();
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
