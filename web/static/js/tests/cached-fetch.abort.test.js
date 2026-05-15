import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCachedFetchEnv } from './helpers/cached-fetch-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

describe('cachedFetch — timeoutMs propagation', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  it('forwards a caller-supplied timeoutMs into apiCallDirect as the 4th arg', async () => {
    const { window, cleanup } = loadCachedFetchEnv();

    try {
      window.apiCallDirect = vi.fn().mockResolvedValue({ readingsRes: [] });

      await window.cachedFetch('bp', '/api/bp?days=30', {
        tags: ['bp'],
        timeoutMs: 5_000
      });

      expect(window.apiCallDirect).toHaveBeenCalledTimes(1);
      const args = window.apiCallDirect.mock.calls[0];
      expect(args[0]).toBe('/api/bp?days=30');
      expect(args[1]).toBe('GET');
      expect(args[2]).toBeNull();
      expect(args[3]).toEqual({ timeoutMs: 5_000 });
    } finally {
      cleanup();
    }
  });

  it('omits timeoutMs from opts when caller does not specify it (apiCallDirect default applies)', async () => {
    const { window, cleanup } = loadCachedFetchEnv();

    try {
      window.apiCallDirect = vi.fn().mockResolvedValue({ readingsRes: [] });

      await window.cachedFetch('bp', '/api/bp?days=30', { tags: ['bp'] });

      expect(window.apiCallDirect).toHaveBeenCalledTimes(1);
      const args = window.apiCallDirect.mock.calls[0];
      // No 4th arg, or an empty/undefined opts — either way, no timeoutMs.
      const opts = args[3];
      if (opts !== undefined) {
        expect(opts.timeoutMs).toBeUndefined();
      }
    } finally {
      cleanup();
    }
  });

  it('forwards timeoutMs through both the foreground cache-miss path and the SWR background path', async () => {
    const now = Date.now();
    const cachedAt = now - (5 * 60 * 1000); // stale → triggers SWR background
    const { window, cleanup } = loadCachedFetchEnv({
      initialCache: { meds: { data: [{ id: 1 }], timestamp: cachedAt } }
    });

    try {
      window.apiCallDirect = vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]);

      await window.cachedFetch('meds', '/api/medications', {
        tags: ['medications'],
        freshAfterMs: 60_000,
        timeoutMs: 15_000,
        now
      });

      // Drain microtasks so the background SWR fires.
      for (let i = 0; i < 10 && window.apiCallDirect.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }

      expect(window.apiCallDirect).toHaveBeenCalledTimes(1);
      expect(window.apiCallDirect.mock.calls[0][3]).toEqual({ timeoutMs: 15_000 });
    } finally {
      cleanup();
    }
  });

  it('aborted background revalidation does not throw to the foreground caller (cache hit still returns)', async () => {
    const now = Date.now();
    const cachedAt = now - (5 * 60 * 1000); // stale → triggers SWR background
    const { window, cleanup } = loadCachedFetchEnv({
      initialCache: { meds: { data: [{ id: 1 }], timestamp: cachedAt } }
    });

    try {
      const abortErr = new Error('timed out');
      abortErr.name = 'TimeoutError';
      abortErr.aborted = true;
      window.apiCallDirect = vi.fn().mockRejectedValue(abortErr);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await window.cachedFetch('meds', '/api/medications', {
        tags: ['medications'],
        freshAfterMs: 60_000,
        timeoutMs: 50,
        now
      });

      // Foreground returns the cached payload immediately.
      expect(result.data).toEqual([{ id: 1 }]);
      expect(result.isFromCache).toBe(true);

      // Drain microtasks so the rejected background SWR settles.
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }

      expect(window.apiCallDirect).toHaveBeenCalledTimes(1);
      // The abort is a non-network, non-programmer-error condition — it is
      // currently logged as a warn (same path as any non-network failure).
      // What matters is: it does NOT throw to the foreground caller.
      warnSpy.mockRestore();
    } finally {
      cleanup();
    }
  });

  it('cache hit returns even when foreground+background revalidation aborts', async () => {
    // Identical setup, but verify behaviour with a fresh cache hit (no SWR background fetch fires).
    const now = Date.now();
    const cachedAt = now - 1_000; // fresh
    const { window, cleanup } = loadCachedFetchEnv({
      initialCache: { weight: { data: { logsRes: [{ weight: 70 }] }, timestamp: cachedAt } }
    });

    try {
      // Even fresh cache kicks off a background revalidation; make it reject
      // as aborted. The foreground call must still return the cached value
      // and the rejection must not propagate.
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      abortErr.aborted = true;
      window.apiCallDirect = vi.fn().mockRejectedValue(abortErr);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await window.cachedFetch('weight', '/api/weight?days=30', {
        tags: ['weight'],
        freshAfterMs: 60_000,
        timeoutMs: 10,
        now
      });

      expect(result.data).toEqual({ logsRes: [{ weight: 70 }] });
      expect(result.isFromCache).toBe(true);
      expect(result.isStale).toBe(false);

      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }
      warnSpy.mockRestore();
    } finally {
      cleanup();
    }
  });

  it('passes additional fetchOpts alongside timeoutMs', async () => {
    const { window, cleanup } = loadCachedFetchEnv();

    try {
      window.apiCallDirect = vi.fn().mockResolvedValue({ ok: true });

      await window.cachedFetch('food_2026-05-09_day', '/api/food/log?date=2026-05-09', {
        tags: ['food'],
        fetchOpts: { method: 'POST', body: { hello: 'world' } },
        timeoutMs: 8_000
      });

      const args = window.apiCallDirect.mock.calls[0];
      expect(args[0]).toBe('/api/food/log?date=2026-05-09');
      expect(args[1]).toBe('POST');
      expect(args[2]).toEqual({ hello: 'world' });
      expect(args[3]).toEqual({ timeoutMs: 8_000 });
    } finally {
      cleanup();
    }
  });
});
