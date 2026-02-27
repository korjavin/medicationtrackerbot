import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDataStoreEnv } from './helpers/data-store-harness.js';

describe('data-store.js realtime and polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('buildChangesStreamURL includes cursor and initData params', () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      window.userInitData = 'abc123';
      window.DataStore.setChangeCursor(19);

      const url = window.DataStore.buildChangesStreamURL();
      expect(url).toContain('/api/changes/stream?');
      expect(url).toContain('since=19');
      expect(url).toContain('initData=abc123');
    } finally {
      cleanup();
    }
  });

  it('startChangePolling triggers prune and periodic poll when online', async () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        value: true
      });

      const pruneSpy = vi.spyOn(window.DataStore, 'pruneStaleClientCache').mockResolvedValue(undefined);
      const pollSpy = vi.spyOn(window.DataStore, 'pollChangesOnce').mockResolvedValue(undefined);

      window.DataStore.startChangePolling();
      expect(pruneSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30000);
      expect(pollSpy).toHaveBeenCalledTimes(1);

      window.DataStore.stopChangePolling();
      await vi.advanceTimersByTimeAsync(30000);
      expect(pollSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('startChangeStream returns false when EventSource is unavailable', () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        value: true
      });

      window.EventSource = undefined;
      const ok = window.DataStore.startChangeStream();
      expect(ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('startChangeStream handles open/message/error lifecycle', async () => {
    const { window, cleanup } = loadDataStoreEnv();

    try {
      Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        value: true
      });

      class MockEventSource {
        static instance;

        constructor(url) {
          this.url = url;
          this.close = vi.fn();
          MockEventSource.instance = this;
        }
      }

      window.EventSource = MockEventSource;

      const stopPollSpy = vi.spyOn(window.DataStore, 'stopChangePollInterval').mockImplementation(() => {});
      const startPollSpy = vi.spyOn(window.DataStore, 'startChangePollInterval').mockImplementation(() => {});
      const applySpy = vi.spyOn(window.DataStore, 'applyChangesPayload').mockResolvedValue(undefined);

      const ok = window.DataStore.startChangeStream();
      expect(ok).toBe(true);

      MockEventSource.instance.onopen();
      expect(stopPollSpy).toHaveBeenCalled();

      await MockEventSource.instance.onmessage({ data: JSON.stringify({ cursor: 10, changed_tags: ['bp'] }) });
      expect(applySpy).toHaveBeenCalledWith({ cursor: 10, changed_tags: ['bp'] });

      MockEventSource.instance.onerror();
      expect(MockEventSource.instance.close).toHaveBeenCalled();
      expect(startPollSpy).toHaveBeenCalled();

      window.DataStore.stopChangePolling();
      await vi.runOnlyPendingTimersAsync();
    } finally {
      cleanup();
    }
  });
});
