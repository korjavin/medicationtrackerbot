import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDataStoreEnv } from './helpers/data-store-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

describe('DataStore.applyOptimistic', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  it('writes the mutated payload into cache and dispatches optimistic change', async () => {
    const cached = { items: [{ id: 1, label: 'old' }] };
    const { window, cacheMap, cleanup } = loadDataStoreEnv({
      initialCache: { list: cached }
    });

    try {
      const events = [];
      window.addEventListener('datastore:changed', (e) => events.push(e.detail));

      const handle = await window.DataStore.applyOptimistic(
        'list',
        (prev) => ({ items: [...(prev?.items || []), { id: 2, label: 'new' }] }),
        ['list']
      );

      expect(cacheMap.get('list')).toEqual({
        items: [{ id: 1, label: 'old' }, { id: 2, label: 'new' }]
      });

      const optimistic = events.find((e) => e.source === 'optimistic');
      expect(optimistic).toBeDefined();
      expect(optimistic.changedTags).toEqual(['list']);

      expect(typeof handle.commit).toBe('function');
      expect(typeof handle.rollback).toBe('function');
    } finally {
      cleanup();
    }
  });

  it('passes null to mutator on cold cache and writes the produced payload', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv();

    try {
      const mutator = vi.fn().mockImplementation((prev) => ({ first: true, prev }));

      await window.DataStore.applyOptimistic('cold_key', mutator, ['tag']);

      expect(mutator).toHaveBeenCalledWith(null);
      expect(cacheMap.get('cold_key')).toEqual({ first: true, prev: null });
    } finally {
      cleanup();
    }
  });

  it('clears the cache entry when mutator returns null (e.g. workout_next after finish)', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv({
      initialCache: { workout_next: { id: 'session-1' } }
    });

    try {
      await window.DataStore.applyOptimistic(
        'workout_next',
        () => null,
        ['workouts']
      );

      expect(cacheMap.has('workout_next')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('commit overwrites the cache with the server payload and re-dispatches', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv({
      initialCache: { bp: [{ id: 1, sys: 120 }] }
    });

    try {
      const events = [];
      window.addEventListener('datastore:changed', (e) => events.push(e.detail));

      const handle = await window.DataStore.applyOptimistic(
        'bp',
        (prev) => [{ id: 'local_99', sys: 130 }, ...(prev || [])],
        ['bp']
      );

      await handle.commit([
        { id: 7, sys: 130 },
        { id: 1, sys: 120 }
      ]);

      expect(cacheMap.get('bp')).toEqual([
        { id: 7, sys: 130 },
        { id: 1, sys: 120 }
      ]);
      const commitEvt = events.find((e) => e.source === 'optimistic-commit');
      expect(commitEvt).toBeDefined();
      expect(commitEvt.changedTags).toEqual(['bp']);
    } finally {
      cleanup();
    }
  });

  it('commit with null/undefined leaves the optimistic state in place', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv({
      initialCache: { weight: [{ id: 1, value: 70 }] }
    });

    try {
      const handle = await window.DataStore.applyOptimistic(
        'weight',
        (prev) => [{ id: 'local_x', value: 71 }, ...(prev || [])],
        ['weight']
      );

      await handle.commit(undefined);

      expect(cacheMap.get('weight')).toEqual([
        { id: 'local_x', value: 71 },
        { id: 1, value: 70 }
      ]);
    } finally {
      cleanup();
    }
  });

  it('rollback restores the prior cache so the screen can repaint pre-write state', async () => {
    const original = { rows: [{ id: 1 }] };
    const { window, cacheMap, cleanup } = loadDataStoreEnv({
      initialCache: { list: original }
    });

    try {
      const events = [];
      window.addEventListener('datastore:changed', (e) => events.push(e.detail));

      window.DataStore.registerTags('list', ['list']);

      const handle = await window.DataStore.applyOptimistic(
        'list',
        (prev) => ({ rows: [...prev.rows, { id: 2 }] }),
        ['list']
      );

      // Mid-flight, the optimistic state is present.
      expect(cacheMap.get('list')).toEqual({ rows: [{ id: 1 }, { id: 2 }] });

      await handle.rollback();

      // Prior snapshot is restored so reloadCurrentTab → loadSWR can render
      // the pre-optimistic state. The next fetchFresh will reconcile against
      // the authoritative server state.
      expect(cacheMap.get('list')).toEqual({ rows: [{ id: 1 }] });

      const rollbackEvt = events.find((e) => e.source === 'optimistic-rollback');
      expect(rollbackEvt).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it('rollback clears the cache when no prior cache existed (cold start)', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv();

    try {
      const handle = await window.DataStore.applyOptimistic(
        'list',
        () => ({ rows: [{ id: 1 }] }),
        ['list']
      );

      expect(cacheMap.has('list')).toBe(true);

      await handle.rollback();

      // Cold cache: no prior snapshot to restore, so the optimistic entry is
      // cleared. The next read will fetchFresh and seed from the server.
      expect(cacheMap.has('list')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('does not corrupt the rollback snapshot when mutator mutates prev in place', async () => {
    const cached = { rows: [{ id: 1, value: 'A' }] };
    const { window, cacheMap, cleanup } = loadDataStoreEnv({
      initialCache: { list: cached }
    });

    try {
      // Capture writes so we can verify rollback restored the pristine prior.
      const writes = [];
      const origSet = window.DataStore.setCachedWithTags.bind(window.DataStore);
      window.DataStore.setCachedWithTags = async (key, data, tags) => {
        writes.push({ key, data: structuredClone(data) });
        return origSet(key, data, tags);
      };

      const handle = await window.DataStore.applyOptimistic(
        'list',
        (prev) => {
          // Misbehaving mutator: edits prev in place and returns it. Without
          // a snapshot-before-mutate, this would corrupt the rollback target.
          prev.rows.push({ id: 2, value: 'B' });
          return prev;
        },
        ['list']
      );

      await handle.rollback();

      // The rollback path's setCachedWithTags call should have written the
      // pristine 1-row snapshot back, NOT the 2-row in-place mutation.
      const restoredSnapshot = writes.find(
        (w) => Array.isArray(w.data?.rows) && w.data.rows.length === 1 && w.data.rows[0].id === 1
      );
      expect(restoredSnapshot).toBeDefined();
      // The restored prior snapshot survives — next read will fetchFresh and
      // reconcile against the authoritative server state.
      expect(cacheMap.get('list')).toEqual({ rows: [{ id: 1, value: 'A' }] });
    } finally {
      cleanup();
    }
  });

  it('commit/rollback are no-ops after the handle has settled', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv({
      initialCache: { bp: [{ id: 1 }] }
    });

    try {
      const handle = await window.DataStore.applyOptimistic(
        'bp',
        (prev) => [{ id: 'local' }, ...(prev || [])],
        ['bp']
      );

      await handle.commit([{ id: 99 }]);
      // Second settle is ignored.
      await handle.rollback();

      expect(cacheMap.get('bp')).toEqual([{ id: 99 }]);
    } finally {
      cleanup();
    }
  });

  it('loadSWR with allowNullFresh skips onFresh while an optimistic write is pending', async () => {
    // Regression: applyOptimistic flips pendingOptimistic[key] before
    // dispatching the optimistic event that triggers reloadCurrentTab. The
    // ensuing loadSWR call must NOT call onFresh(null) under allowNullFresh —
    // doing so wipes the optimistic render (e.g. medication history) back to
    // the empty state until the POST resolves.
    const optimisticPayload = [
      { id: 1, medication_id: 7, status: 'TAKEN', _optimistic: true }
    ];
    const { window, cleanup } = loadDataStoreEnv({
      initialCache: { history_7_0: optimisticPayload }
    });

    try {
      // Simulate the pending-optimistic state by calling applyOptimistic and
      // leaving the handle un-settled. loadSWR then runs with the same key.
      const handle = await window.DataStore.applyOptimistic(
        'history_7_0',
        (prev) => prev,
        ['history']
      );

      // Concurrent fetcher returns null (e.g. backend hasn't yet seen the
      // caller's POST). Without the pendingOptimistic guard in loadSWR, this
      // would call onFresh(null) and the renderer would wipe the list.
      const fetcher = vi.fn().mockResolvedValue(null);
      const onFresh = vi.fn();
      const onCached = vi.fn();

      await window.DataStore.loadSWR({
        key: 'history_7_0',
        tags: ['history'],
        fetcher,
        onCached,
        onFresh,
        allowNullFresh: true
      });

      expect(onCached).toHaveBeenCalledWith(optimisticPayload);
      expect(onFresh).not.toHaveBeenCalled();

      // Once the optimistic handle settles, the next loadSWR works normally.
      await handle.commit(null);
    } finally {
      cleanup();
    }
  });

  it('decrements pendingOptimistic when the cache write throws so future fetches are not permanently short-circuited', async () => {
    // Regression: if setCachedWithTags/clearCached throws (IndexedDB quota,
    // disk corruption, etc.), the increment-before-write order would leave
    // pendingOptimistic[key] > 0 forever, permanently short-circuiting every
    // future fetchFresh for that key (returns null without hitting the
    // network).
    const { window, cleanup } = loadDataStoreEnv({
      initialCache: { bp: [{ id: 1, sys: 120 }] }
    });

    try {
      // Replace setCachedWithTags with a throwing stub for the optimistic
      // write only, so the failure path is exercised.
      const orig = window.DataStore.setCachedWithTags.bind(window.DataStore);
      let callCount = 0;
      window.DataStore.setCachedWithTags = async (key, data, tags) => {
        callCount += 1;
        if (callCount === 1) throw new Error('quota exceeded');
        return orig(key, data, tags);
      };

      await expect(
        window.DataStore.applyOptimistic(
          'bp',
          (prev) => [{ id: 'local', sys: 130 }, ...(prev || [])],
          ['bp']
        )
      ).rejects.toThrow('quota exceeded');

      // Pending counter must have been decremented despite the throw, so
      // subsequent fetchFresh calls reach the network. Without the cleanup,
      // pendingOptimistic stays at 1 and fetchFresh short-circuits to null.
      expect(window.DataStore.hasPendingOptimistic('bp')).toBe(false);

      const fetcher = vi.fn().mockResolvedValue([{ id: 2, sys: 140 }]);
      const result = await window.DataStore.fetchFresh('bp', fetcher, ['bp']);
      expect(fetcher).toHaveBeenCalled();
      expect(result).toEqual([{ id: 2, sys: 140 }]);
    } finally {
      cleanup();
    }
  });

  it('decrements pendingOptimistic when commit cache write throws so future fetches are not permanently short-circuited', async () => {
    // Regression: commit() set settled=true before awaiting setCachedWithTags
    // and only ran decrementPending() after the write succeeded. If the
    // cache write threw (IndexedDB quota etc.), pendingOptimistic[key] would
    // stay > 0 forever, permanently short-circuiting every future fetchFresh
    // for that key.
    const { window, cleanup } = loadDataStoreEnv({
      initialCache: { bp: [{ id: 1, sys: 120 }] }
    });

    try {
      const handle = await window.DataStore.applyOptimistic(
        'bp',
        (prev) => [{ id: 'local', sys: 130 }, ...(prev || [])],
        ['bp']
      );

      // Replace setCachedWithTags to throw only on the commit call.
      const orig = window.DataStore.setCachedWithTags.bind(window.DataStore);
      window.DataStore.setCachedWithTags = async () => {
        throw new Error('quota exceeded on commit');
      };

      await expect(handle.commit([{ id: 7, sys: 130 }])).rejects.toThrow('quota exceeded on commit');

      // Restore so fetchFresh can write normally.
      window.DataStore.setCachedWithTags = orig;

      expect(window.DataStore.hasPendingOptimistic('bp')).toBe(false);

      const fetcher = vi.fn().mockResolvedValue([{ id: 2, sys: 140 }]);
      const result = await window.DataStore.fetchFresh('bp', fetcher, ['bp']);
      expect(fetcher).toHaveBeenCalled();
      expect(result).toEqual([{ id: 2, sys: 140 }]);
    } finally {
      cleanup();
    }
  });

  it('decrements pendingOptimistic when rollback cache write throws so future fetches are not permanently short-circuited', async () => {
    // Regression: same shape as the commit-throws case but for rollback().
    const { window, cleanup } = loadDataStoreEnv({
      initialCache: { bp: [{ id: 1, sys: 120 }] }
    });

    try {
      const handle = await window.DataStore.applyOptimistic(
        'bp',
        (prev) => [{ id: 'local', sys: 130 }, ...(prev || [])],
        ['bp']
      );

      const orig = window.DataStore.setCachedWithTags.bind(window.DataStore);
      window.DataStore.setCachedWithTags = async () => {
        throw new Error('quota exceeded on rollback');
      };

      await expect(handle.rollback()).rejects.toThrow('quota exceeded on rollback');

      window.DataStore.setCachedWithTags = orig;

      expect(window.DataStore.hasPendingOptimistic('bp')).toBe(false);

      const fetcher = vi.fn().mockResolvedValue([{ id: 2, sys: 140 }]);
      const result = await window.DataStore.fetchFresh('bp', fetcher, ['bp']);
      expect(fetcher).toHaveBeenCalled();
      expect(result).toEqual([{ id: 2, sys: 140 }]);
    } finally {
      cleanup();
    }
  });

  it('decrements pendingOptimistic when rollback clearCached throws (cold-cache path)', async () => {
    // Regression: rollback's cold-cache branch awaits clearCached. If that
    // throws, decrementPending must still run.
    const { window, cleanup } = loadDataStoreEnv();

    try {
      const handle = await window.DataStore.applyOptimistic(
        'list',
        () => ({ rows: [{ id: 1 }] }),
        ['list']
      );

      const origClear = window.DataStore.clearCached.bind(window.DataStore);
      window.DataStore.clearCached = async () => {
        throw new Error('clear failed');
      };

      await expect(handle.rollback()).rejects.toThrow('clear failed');

      window.DataStore.clearCached = origClear;

      expect(window.DataStore.hasPendingOptimistic('list')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('returns a no-op handle for invalid inputs', async () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      const handle = await window.DataStore.applyOptimistic('', () => ({}), []);
      expect(typeof handle.commit).toBe('function');
      expect(typeof handle.rollback).toBe('function');
      // No throw.
      await handle.commit({});
      await handle.rollback();
    } finally {
      cleanup();
    }
  });
});
