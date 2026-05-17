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

  it('rollback restores the prior cache and invalidates tags', async () => {
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

      // invalidateTags clears the cache entry so the next read goes to network.
      expect(cacheMap.has('list')).toBe(false);

      const rollbackEvt = events.find((e) => e.source === 'optimistic-rollback');
      expect(rollbackEvt).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it('rollback restores a cold-start clear when no prior cache existed', async () => {
    const { window, cacheMap, cleanup } = loadDataStoreEnv();

    try {
      const handle = await window.DataStore.applyOptimistic(
        'list',
        () => ({ rows: [{ id: 1 }] }),
        ['list']
      );

      expect(cacheMap.has('list')).toBe(true);

      await handle.rollback();

      // Cold cache: rollback clears and invalidates — the entry must not survive.
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
      // invalidateTags then clears the entry so the next read goes to network.
      expect(cacheMap.has('list')).toBe(false);
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
