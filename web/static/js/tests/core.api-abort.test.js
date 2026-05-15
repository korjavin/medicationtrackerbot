import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { allowConsoleNoise } from './helpers/setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CORE_API_JS = path.join(REPO_ROOT, 'web/static/js/core/api.js');

function loadApiEnv() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.userInitData = 'test-init';
  const source = fs.readFileSync(CORE_API_JS, 'utf8');
  window.eval(`${source}\n//# sourceURL=file://${CORE_API_JS}`);
  return { window, cleanup: () => dom.window.close() };
}

// Honors the signal — rejects with signal.reason on abort, otherwise never resolves.
function abortableHangingFetch() {
  return (_url, fetchOpts) => new Promise((_resolve, reject) => {
    if (fetchOpts && fetchOpts.signal) {
      fetchOpts.signal.addEventListener('abort', () => {
        reject(fetchOpts.signal.reason);
      });
    }
  });
}

function jsonResponse(body) {
  return {
    status: 200,
    ok: true,
    async text() { return JSON.stringify(body); }
  };
}

describe('apiCallDirect — timeout / AbortSignal support', () => {
  it('fires the default 60s timeout via AbortSignal.timeout(60000)', async () => {
    const { window, cleanup } = loadApiEnv();
    try {
      const timeoutSpy = vi.spyOn(window.AbortSignal, 'timeout');
      window.fetch = abortableHangingFetch();
      // Don't await — we just need to confirm AbortSignal.timeout was invoked.
      window.apiCallDirect('/api/test').catch(() => {});
      await Promise.resolve();
      expect(timeoutSpy).toHaveBeenCalledWith(60_000);
      timeoutSpy.mockRestore();
    } finally {
      cleanup();
    }
  });

  it('rejects with err.aborted === true when the timeout fires', async () => {
    const { window, cleanup } = loadApiEnv();
    try {
      window.fetch = abortableHangingFetch();
      const start = Date.now();
      const err = await window.apiCallDirect('/api/test', 'GET', null, { timeoutMs: 30 })
        .catch((e) => e);
      expect(err.aborted).toBe(true);
      expect(err.name).toBe('TimeoutError');
      // Sanity check: didn't fall back to default 60s.
      expect(Date.now() - start).toBeLessThan(1000);
    } finally {
      cleanup();
    }
  });

  it('aborts mid-flight when the caller-supplied signal aborts', async () => {
    const { window, cleanup } = loadApiEnv();
    try {
      window.fetch = abortableHangingFetch();
      const controller = new window.AbortController();
      const promise = window.apiCallDirect('/api/test', 'GET', null, {
        timeoutMs: 60_000,
        signal: controller.signal
      });
      // Abort on the next macrotask so the fetch handler has attached its listener.
      setTimeout(() => controller.abort(), 0);
      const err = await promise.catch((e) => e);
      expect(err.aborted).toBe(true);
      expect(err.name).toBe('AbortError');
    } finally {
      cleanup();
    }
  });

  it('composes timeout + caller signal via AbortSignal.any (timeout wins)', async () => {
    const { window, cleanup } = loadApiEnv();
    try {
      const anySpy = vi.spyOn(window.AbortSignal, 'any');
      window.fetch = abortableHangingFetch();
      const controller = new window.AbortController();
      const err = await window.apiCallDirect('/api/test', 'GET', null, {
        timeoutMs: 25,
        signal: controller.signal
      }).catch((e) => e);
      expect(anySpy).toHaveBeenCalled();
      expect(err.aborted).toBe(true);
      expect(err.name).toBe('TimeoutError');
      anySpy.mockRestore();
    } finally {
      cleanup();
    }
  });

  it('composes timeout + caller signal via AbortSignal.any (caller wins)', async () => {
    const { window, cleanup } = loadApiEnv();
    try {
      window.fetch = abortableHangingFetch();
      const controller = new window.AbortController();
      const promise = window.apiCallDirect('/api/test', 'GET', null, {
        timeoutMs: 60_000,
        signal: controller.signal
      });
      setTimeout(() => controller.abort(), 0);
      const err = await promise.catch((e) => e);
      expect(err.aborted).toBe(true);
      expect(err.name).toBe('AbortError');
    } finally {
      cleanup();
    }
  });

  it('does not abort a successful fast call', async () => {
    const { window, cleanup } = loadApiEnv();
    try {
      window.fetch = vi.fn(async (_url, fetchOpts) => {
        // The signal field is present so fetch could honor cancellation
        // if the network were real.
        expect(fetchOpts.signal).toBeDefined();
        return jsonResponse({ ok: 1 });
      });
      const result = await window.apiCallDirect('/api/test', 'GET', null, { timeoutMs: 30 });
      expect(result).toEqual({ ok: 1 });
      expect(window.fetch).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('allows opt-out of timeout via timeoutMs: Infinity (no AbortSignal.timeout call)', async () => {
    const { window, cleanup } = loadApiEnv();
    try {
      const timeoutSpy = vi.spyOn(window.AbortSignal, 'timeout');
      window.fetch = vi.fn(async () => jsonResponse({ ok: 1 }));
      await window.apiCallDirect('/api/test', 'GET', null, { timeoutMs: Infinity });
      expect(timeoutSpy).not.toHaveBeenCalled();
      // With no caller signal and no timeout, fetch should receive signal: undefined.
      const fetchOpts = window.fetch.mock.calls[0][1];
      expect(fetchOpts.signal).toBeUndefined();
      timeoutSpy.mockRestore();
    } finally {
      cleanup();
    }
  });
});

describe('apiCall — abort propagation', () => {
  it('lets abort errors bubble instead of swallowing them like network errors', async () => {
    const { window, cleanup } = loadApiEnv();
    try {
      // No offlineAwareApiCall installed → apiCall falls through to direct path.
      window.fetch = abortableHangingFetch();
      const err = await window.apiCall('/api/test', 'GET', null, { timeoutMs: 25 })
        .catch((e) => e);
      expect(err.aborted).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('forwards opts through window.offlineAwareApiCall when present', async () => {
    const { window, cleanup } = loadApiEnv();
    try {
      const seen = [];
      window.offlineAwareApiCall = async (endpoint, method, body, opts) => {
        seen.push({ endpoint, method, body, opts });
        return { hello: 'world' };
      };
      const result = await window.apiCall('/api/test', 'GET', null, { timeoutMs: 1234 });
      expect(result).toEqual({ hello: 'world' });
      expect(seen).toHaveLength(1);
      expect(seen[0].opts).toEqual({ timeoutMs: 1234 });
    } finally {
      cleanup();
    }
  });
});
