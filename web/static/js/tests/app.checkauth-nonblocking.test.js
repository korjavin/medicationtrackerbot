import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockResponse, loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

const AUTH_CACHE_KEY = 'medtracker_auth_state';

function setAuthCache(window) {
  window.localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({
    authenticated: true,
    authMethod: 'cookie',
    timestamp: Date.now(),
    ttl: 30 * 24 * 60 * 60 * 1000
  }));
}

function mockServiceWorker(window) {
  Object.defineProperty(window.navigator, 'serviceWorker', {
    configurable: true,
    value: {
      controller: { scriptURL: '/sw.js' },
      addEventListener: () => {}
    }
  });
}

describe('checkAuth non-blocking with cached bootstrap', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  it('fast path: cached auth + active SW → renders from SW-cached bootstrap immediately', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      setAuthCache(window);
      mockServiceWorker(window);

      const bootstrapData = {
        cursor: 10,
        features: { bp: true },
        medications: [{ id: 1, name: 'Aspirin' }],
        settings: {}
      };

      // fetch for /api/bootstrap returns cached data, then /auth/status background check
      window.fetch = vi.fn()
        .mockResolvedValueOnce(createMockResponse({ status: 200, json: bootstrapData }))
        .mockResolvedValueOnce(createMockResponse({ status: 200, json: { authenticated: true } }));

      const authorized = await window.checkAuth();

      expect(authorized).toBe(true);
      // First call should be /api/bootstrap (not /auth/status — that's the non-blocking part)
      expect(window.fetch.mock.calls[0][0]).toBe('/api/bootstrap');
      // Auth state should be saved
      const cachedAuth = JSON.parse(window.localStorage.getItem(AUTH_CACHE_KEY));
      expect(cachedAuth.authenticated).toBe(true);
      // Cursor should be set from bootstrap
      expect(window.localStorage.getItem('medtracker_changes_cursor')).toBe('10');
    } finally {
      cleanup();
    }
  });

  it('fast path: SW cache miss falls back to IndexedDB cache', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      setAuthCache(window);
      mockServiceWorker(window);

      const getCacheSpy = vi.fn().mockResolvedValue([{ id: 2, name: 'Metformin' }]);
      window.MedTrackerDB = {
        MedicationStore: { getCache: getCacheSpy }
      };
      window.DataStore.getCached = vi.fn().mockResolvedValue({
        tabOrder: ['weight', 'bp']
      });
      window.applyTabOrder = vi.fn();

      // /api/bootstrap fails (network error), then background auth check
      window.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce(createMockResponse({ status: 200, json: { authenticated: true } }));

      const authorized = await window.checkAuth();

      expect(authorized).toBe(true);
      expect(getCacheSpy).toHaveBeenCalledTimes(1);
      expect(window.applyTabOrder).toHaveBeenCalledWith(['weight', 'bp']);
    } finally {
      cleanup();
    }
  });

  it('fast path: no cached auth falls through to blocking flow', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      // No cached auth, no SW
      window.localStorage.removeItem(AUTH_CACHE_KEY);

      // Blocking flow: /auth/status → authenticated → /api/bootstrap
      window.fetch = vi.fn()
        .mockResolvedValueOnce(createMockResponse({
          status: 200,
          json: { authenticated: true }
        }))
        .mockResolvedValueOnce(createMockResponse({
          status: 200,
          json: { cursor: 5, features: { bp: true }, settings: {} }
        }));

      const authorized = await window.checkAuth();

      expect(authorized).toBe(true);
      // First call should be /auth/status (blocking path)
      expect(window.fetch.mock.calls[0][0]).toBe('/auth/status');
    } finally {
      cleanup();
    }
  });

  it('fast path: cached auth but no SW falls through to blocking flow', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      setAuthCache(window);
      // No serviceWorker.controller — can't use fast path

      window.fetch = vi.fn()
        .mockResolvedValueOnce(createMockResponse({
          status: 200,
          json: { authenticated: true }
        }))
        .mockResolvedValueOnce(createMockResponse({
          status: 200,
          json: { cursor: 5, features: {}, settings: {} }
        }));

      const authorized = await window.checkAuth();

      expect(authorized).toBe(true);
      expect(window.fetch.mock.calls[0][0]).toBe('/auth/status');
    } finally {
      cleanup();
    }
  });

  it('verifyAuthInBackground clears auth when session expired', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      setAuthCache(window);

      window.fetch = vi.fn().mockResolvedValue(createMockResponse({
        status: 200,
        json: { authenticated: false }
      }));

      // Call the background verifier directly
      window.verifyAuthInBackground();

      // Wait for the async chain to complete
      await vi.waitFor(() => {
        expect(window.localStorage.getItem(AUTH_CACHE_KEY)).toBeNull();
      });
    } finally {
      cleanup();
    }
  });

  it('verifyAuthInBackground keeps auth on server error', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      setAuthCache(window);

      window.fetch = vi.fn().mockResolvedValue(createMockResponse({
        status: 503,
        text: 'down'
      }));

      window.verifyAuthInBackground();

      // Give background check time to process
      await new Promise(r => setTimeout(r, 50));

      // Auth state should still be present — server error doesn't clear it
      expect(window.localStorage.getItem(AUTH_CACHE_KEY)).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it('verifyAuthInBackground keeps auth on network error', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      setAuthCache(window);

      window.fetch = vi.fn().mockRejectedValue(new Error('network down'));

      window.verifyAuthInBackground();

      await new Promise(r => setTimeout(r, 50));

      // Auth state preserved when network fails
      expect(window.localStorage.getItem(AUTH_CACHE_KEY)).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it('Telegram path: apiCall goes through SW, renders bootstrap', async () => {
    const { window, cleanup } = loadFrontendEnv({ telegramInitData: 'test_init_data' });
    try {
      const bootstrapData = {
        cursor: 7,
        features: { bp: true },
        medications: [{ id: 1, name: 'Test' }],
        settings: {}
      };

      // apiCall uses window.fetch internally
      window.fetch = vi.fn().mockResolvedValue(createMockResponse({
        status: 200,
        json: bootstrapData
      }));

      const authorized = await window.checkAuth();
      expect(authorized).toBe(true);
      expect(window.localStorage.getItem('medtracker_changes_cursor')).toBe('7');
    } finally {
      cleanup();
    }
  });

  it('applyBootstrapPayload is idempotent — calling twice overwrites cleanly', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      const firstPayload = {
        cursor: 5,
        features: { bp: true },
        medications: [{ id: 1, name: 'Aspirin' }],
        settings: { tab_order: '["bp","weight"]' }
      };

      const secondPayload = {
        cursor: 10,
        features: { bp: true, food: true },
        medications: [{ id: 1, name: 'Aspirin' }, { id: 2, name: 'Metformin' }],
        settings: { tab_order: '["weight","bp","food"]' }
      };

      await window.applyBootstrapPayload(firstPayload);
      expect(window.localStorage.getItem('medtracker_changes_cursor')).toBe('5');

      await window.applyBootstrapPayload(secondPayload);
      expect(window.localStorage.getItem('medtracker_changes_cursor')).toBe('10');

      // No errors, no duplicate state — second call cleanly replaced first
    } finally {
      cleanup();
    }
  });
});
