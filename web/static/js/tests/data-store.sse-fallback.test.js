import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDataStoreEnv } from './helpers/data-store-harness.js';

function installMockEventSource(window) {
  const instances = [];
  class MockEventSource {
    constructor(url) {
      this.url = url;
      this.close = vi.fn();
      instances.push(this);
    }
  }
  window.EventSource = MockEventSource;
  return instances;
}

function setOnline(window, value) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value
  });
}

// data-store.js runs inside the jsdom window, which has its own Date object
// independent of vitest's vi.setSystemTime mock. Returning a controllable now()
// lets the SSE error-window logic see deterministic time advances.
function installClock(window, initial = 0) {
  let now = initial;
  const originalNow = window.Date.now.bind(window.Date);
  window.Date.now = () => now;
  return {
    advance(ms) { now += ms; },
    restore() { window.Date.now = originalNow; }
  };
}

describe('data-store.js SSE-first fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('startChangePolling prefers SSE when EventSource is available', () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      setOnline(window, true);
      const instances = installMockEventSource(window);
      const startPollSpy = vi.spyOn(window.DataStore, 'startChangePollInterval');

      window.DataStore.startChangePolling();

      expect(instances).toHaveLength(1);
      expect(instances[0].url).toContain('/api/changes/stream?');
      expect(startPollSpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('falls back to polling immediately when EventSource is undefined', () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      setOnline(window, true);
      window.EventSource = undefined;
      const startPollSpy = vi.spyOn(window.DataStore, 'startChangePollInterval');

      window.DataStore.startChangePolling();

      expect(startPollSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('applyChangesPayload runs when SSE delivers a message', async () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      setOnline(window, true);
      const instances = installMockEventSource(window);
      const applySpy = vi.spyOn(window.DataStore, 'applyChangesPayload').mockResolvedValue(undefined);
      const stopPollSpy = vi.spyOn(window.DataStore, 'stopChangePollInterval');

      window.DataStore.startChangePolling();
      expect(instances).toHaveLength(1);

      instances[0].onopen();
      expect(stopPollSpy).toHaveBeenCalled();

      await instances[0].onmessage({ data: JSON.stringify({ cursor: 42, changed_tags: ['bp'] }) });
      expect(applySpy).toHaveBeenCalledWith({ cursor: 42, changed_tags: ['bp'] });
    } finally {
      cleanup();
    }
  });

  it('gives up on SSE after 3 consecutive errors inside a 30s window', () => {
    const { window, cleanup } = loadDataStoreEnv();
    const clock = installClock(window, 0);

    try {
      setOnline(window, true);
      const instances = installMockEventSource(window);
      const startPollSpy = vi.spyOn(window.DataStore, 'startChangePollInterval');

      window.DataStore.startChangePolling();
      expect(instances).toHaveLength(1);

      // First error: still tries to reconnect on the retry timer.
      instances[0].onerror();
      expect(startPollSpy).toHaveBeenCalledTimes(1);
      clock.advance(5000);
      vi.advanceTimersByTime(5000);
      expect(instances.length).toBeGreaterThanOrEqual(2);

      // Second error: still retries.
      instances[instances.length - 1].onerror();
      clock.advance(10000);
      vi.advanceTimersByTime(10000);
      const lengthAfterSecondRetry = instances.length;
      expect(lengthAfterSecondRetry).toBeGreaterThanOrEqual(3);

      // Third error inside the 30s window: gives up — no more retries.
      instances[instances.length - 1].onerror();
      clock.advance(60000);
      vi.advanceTimersByTime(60000);
      expect(instances.length).toBe(lengthAfterSecondRetry);

      // Subsequent explicit attempts also bail out.
      const ok = window.DataStore.startChangeStream();
      expect(ok).toBe(false);
      expect(instances.length).toBe(lengthAfterSecondRetry);
    } finally {
      clock.restore();
      cleanup();
    }
  });

  it('does not give up when errors are spread across multiple windows', () => {
    const { window, cleanup } = loadDataStoreEnv();
    const clock = installClock(window, 0);

    try {
      setOnline(window, true);
      const instances = installMockEventSource(window);

      window.DataStore.startChangePolling();
      expect(instances).toHaveLength(1);

      // Two errors land inside the first 30s window — under threshold.
      instances[0].onerror();
      clock.advance(5000);
      vi.advanceTimersByTime(5000);
      instances[instances.length - 1].onerror();

      // Then >30s elapses, resetting the in-window counter.
      clock.advance(35000);
      vi.advanceTimersByTime(35000);
      instances[instances.length - 1].onerror();

      // Total errorCount is now 3, but they're split across windows so
      // gave-up must NOT have been set — a fresh startChangeStream attempt
      // (after closing the current EventSource) should still succeed.
      window.DataStore.stopChangePolling();
      const ok = window.DataStore.startChangeStream();
      expect(ok).toBe(true);
    } finally {
      clock.restore();
      cleanup();
    }
  });

  it('startChangePollInterval skips ticks while SSE is connected', async () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      setOnline(window, true);
      const instances = installMockEventSource(window);
      const pollOnceSpy = vi.spyOn(window.DataStore, 'pollChangesOnce').mockResolvedValue(undefined);

      // Open SSE first, then start the poll interval directly (mirrors the
      // race where an SSE error scheduled the poller and SSE then recovered).
      window.DataStore.startChangePolling();
      instances[0].onopen();
      window.DataStore.startChangePollInterval();

      await vi.advanceTimersByTimeAsync(30000);
      expect(pollOnceSpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
