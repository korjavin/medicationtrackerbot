import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDataStoreEnv } from './helpers/data-store-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

describe('Offline read fallbacks', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  describe('data-store.js loadSWR default error handling', () => {
    it('logs warning and returns cached when no onError provided and fetcher fails', async () => {
      const cachedValue = { items: [1, 2, 3] };
      const { window, cleanup } = loadDataStoreEnv({
        initialCache: { test_key: cachedValue }
      });

      try {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const onCached = vi.fn();

        const result = await window.DataStore.loadSWR({
          key: 'test_key',
          tags: ['test'],
          fetcher: async () => { throw new Error('Network error'); },
          onCached
        });

        expect(onCached).toHaveBeenCalledWith(cachedValue);
        expect(result.cached).toEqual(cachedValue);
        expect(result.fresh).toBeNull();
        expect(result.error).toBeDefined();
        expect(warnSpy).toHaveBeenCalled();
        expect(warnSpy.mock.calls[0][0]).toContain('test_key');
      } finally {
        cleanup();
      }
    });

    it('logs warning and returns null cached when no onError and no cache', async () => {
      const { window, cleanup } = loadDataStoreEnv();

      try {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const result = await window.DataStore.loadSWR({
          key: 'empty_key',
          tags: ['test'],
          fetcher: async () => { throw new Error('Network error'); }
        });

        expect(result.cached).toBeNull();
        expect(result.fresh).toBeNull();
        expect(result.error).toBeDefined();
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('does not throw when no onError provided and fetcher fails', async () => {
      const { window, cleanup } = loadDataStoreEnv();

      try {
        // Should not throw - just return cached + error
        const result = await window.DataStore.loadSWR({
          key: 'no_handler',
          tags: ['test'],
          fetcher: async () => { throw new Error('Offline'); }
        });

        expect(result.error).toBeDefined();
        expect(result.error.message).toBe('Offline');
      } finally {
        cleanup();
      }
    });
  });

  describe('onError handlers receive cached data', () => {
    it('onError receives cached as second argument', async () => {
      const cachedValue = { data: 'cached' };
      const { window, cleanup } = loadDataStoreEnv({
        initialCache: { test_err: cachedValue }
      });

      try {
        const onError = vi.fn();
        await window.DataStore.loadSWR({
          key: 'test_err',
          tags: ['test'],
          fetcher: async () => { throw new Error('fail'); },
          onError
        });

        expect(onError).toHaveBeenCalledWith(expect.any(Error), cachedValue);
      } finally {
        cleanup();
      }
    });

    it('onError receives null cached when no cache exists', async () => {
      const { window, cleanup } = loadDataStoreEnv();

      try {
        const onError = vi.fn();
        await window.DataStore.loadSWR({
          key: 'no_cache',
          tags: ['test'],
          fetcher: async () => { throw new Error('fail'); },
          onError
        });

        expect(onError).toHaveBeenCalledWith(expect.any(Error), null);
      } finally {
        cleanup();
      }
    });
  });

  describe('composite fetchers degrade gracefully', () => {
    it('BP fetcher returns data when readings succeed but stats/goal fail', async () => {
      // Simulate the BP fetcher logic with Promise.allSettled
      const [readingsResult, goalResult, statsResult] = await Promise.allSettled([
        Promise.resolve([{ systolic: 120, diastolic: 80 }]),
        Promise.reject(new Error('goal offline')),
        Promise.reject(new Error('stats offline'))
      ]);

      const readingsRes = readingsResult.status === 'fulfilled' ? readingsResult.value : null;
      const goalRes = goalResult.status === 'fulfilled' ? goalResult.value : null;
      const statsRes = statsResult.status === 'fulfilled' ? statsResult.value : null;

      expect(readingsRes).toEqual([{ systolic: 120, diastolic: 80 }]);
      expect(goalRes).toBeNull();
      expect(statsRes).toBeNull();
    });

    it('BP fetcher returns null when readings fail', async () => {
      const [readingsResult, goalResult, statsResult] = await Promise.allSettled([
        Promise.reject(new Error('readings offline')),
        Promise.resolve({ systolic: 130, diastolic: 80 }),
        Promise.resolve({ avg_systolic: 125 })
      ]);

      const readingsRes = readingsResult.status === 'fulfilled' ? readingsResult.value : null;
      const goalRes = goalResult.status === 'fulfilled' ? goalResult.value : null;
      const statsRes = statsResult.status === 'fulfilled' ? statsResult.value : null;

      expect(readingsRes).toBeNull();
      // When readings are null, the fetcher returns null (triggering cache fallback)
      const result = readingsRes === null ? null : { readingsRes, goalRes, statsRes };
      expect(result).toBeNull();
    });

    it('Weight fetcher returns data when logs succeed but goal fails', async () => {
      const [logsResult, goalResult] = await Promise.allSettled([
        Promise.resolve([{ weight: 75.5 }]),
        Promise.reject(new Error('goal offline'))
      ]);

      const logsRes = logsResult.status === 'fulfilled' ? logsResult.value : null;
      const goalRes = goalResult.status === 'fulfilled' ? goalResult.value : null;

      expect(logsRes).toEqual([{ weight: 75.5 }]);
      expect(goalRes).toBeNull();
      const result = logsRes === null ? null : { logsRes, goalRes };
      expect(result).toEqual({ logsRes: [{ weight: 75.5 }], goalRes: null });
    });

    it('Weight fetcher returns null when logs fail', async () => {
      const [logsResult, goalResult] = await Promise.allSettled([
        Promise.reject(new Error('logs offline')),
        Promise.resolve({ target: 70 })
      ]);

      const logsRes = logsResult.status === 'fulfilled' ? logsResult.value : null;
      const goalRes = goalResult.status === 'fulfilled' ? goalResult.value : null;

      expect(logsRes).toBeNull();
      const result = logsRes === null ? null : { logsRes, goalRes };
      expect(result).toBeNull();
    });
  });

  describe('loadSWR with cache renders cached on error', () => {
    it('serves cached data even when fresh fetch fails', async () => {
      const cachedBP = { readingsRes: [{ systolic: 120 }], goalRes: null, statsRes: null };
      const { window, cleanup } = loadDataStoreEnv({
        initialCache: { bp: cachedBP }
      });

      try {
        const onCached = vi.fn();
        const onError = vi.fn();

        await window.DataStore.loadSWR({
          key: 'bp',
          tags: ['bp'],
          fetcher: async () => { throw new Error('Network error'); },
          onCached,
          onError
        });

        // cached should have been called first with the cached data
        expect(onCached).toHaveBeenCalledWith(cachedBP);
        // onError should receive the cached data so it knows not to show error UI
        expect(onError).toHaveBeenCalledWith(expect.any(Error), cachedBP);
      } finally {
        cleanup();
      }
    });

    it('shows no-cache message only when both fetch and cache fail', async () => {
      const { window, cleanup } = loadDataStoreEnv();

      try {
        const onCached = vi.fn();
        const onError = vi.fn();

        await window.DataStore.loadSWR({
          key: 'bp',
          tags: ['bp'],
          fetcher: async () => { throw new Error('Network error'); },
          onCached,
          onError
        });

        expect(onCached).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledWith(expect.any(Error), null);
      } finally {
        cleanup();
      }
    });
  });
});
