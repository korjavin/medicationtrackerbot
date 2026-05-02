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

  it('fast path: cached auth + active SW → verifies session then renders', async () => {
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

      // Fast path fetches bootstrap + auth/status in parallel, then verifyAuthInBackground
      window.fetch = vi.fn((url) => {
        if (typeof url === 'string' && url.startsWith('/api/bootstrap')) {
          return Promise.resolve(createMockResponse({ status: 200, json: bootstrapData }));
        }
        if (url === '/auth/status') return Promise.resolve(createMockResponse({ status: 200, json: { authenticated: true } }));
        return Promise.resolve(createMockResponse({ status: 200, json: {} }));
      });

      const authorized = await window.checkAuth();

      expect(authorized).toBe(true);
      // Both bootstrap and auth/status should be called in parallel
      const urls = window.fetch.mock.calls.map(c => c[0]);
      expect(urls.some(u => typeof u === 'string' && u.startsWith('/api/bootstrap'))).toBe(true);
      expect(urls).toContain('/auth/status');
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
      const getCachedSpy = vi.fn().mockResolvedValue({
        tabOrder: ['weight', 'bp']
      });
      window.DataStore.getCached = getCachedSpy;

      // Promise.all: bootstrap rejects (network error), auth/status also fails
      // Then verifyAuthInBackground makes another call
      window.fetch = vi.fn((url) => {
        if (typeof url === 'string' && url.startsWith('/api/bootstrap')) {
          return Promise.reject(new Error('network down'));
        }
        if (url === '/auth/status') return Promise.reject(new Error('network down'));
        return Promise.resolve(createMockResponse({ status: 200, json: {} }));
      });

      const authorized = await window.checkAuth();

      expect(authorized).toBe(true);
      expect(getCacheSpy).toHaveBeenCalledTimes(1);
      expect(getCachedSpy).toHaveBeenCalledWith('settings_bundle');
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

  it('fast path: expired session prevents rendering cached bootstrap data', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      setAuthCache(window);
      mockServiceWorker(window);

      // Mock caches API for clearSwBootstrapCache (runs inside JSDOM window)
      window.caches = {
        keys: () => Promise.resolve([]),
        open: () => Promise.resolve({ delete: () => Promise.resolve() })
      };

      const bootstrapData = {
        cursor: 10,
        features: { bp: true },
        medications: [{ id: 1, name: 'Aspirin' }],
        settings: {}
      };

      // Bootstrap returns cached 200 from SW, but auth/status says not authenticated
      window.fetch = vi.fn((url) => {
        if (url === '/api/bootstrap') return Promise.resolve(createMockResponse({ status: 200, json: bootstrapData }));
        if (url === '/auth/status') return Promise.resolve(createMockResponse({ status: 200, json: { authenticated: false } }));
        return Promise.resolve(createMockResponse({ status: 200, json: {} }));
      });

      const authorized = await window.checkAuth();

      // Should fall through to blocking flow (which also fails), not render cached data
      // Auth cache should be cleared
      expect(window.localStorage.getItem(AUTH_CACHE_KEY)).toBeNull();
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

  it('applyBootstrapPayload caches today food groups so external writes show on Today', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      const setCachedWithTagsSpy = vi.fn().mockResolvedValue();
      window.DataStore.setCachedWithTags = setCachedWithTagsSpy;

      const payload = {
        cursor: 42,
        features: { food: true },
        food: {
          date: '2026-05-02',
          groups: [
            { name: 'Lunch', time: '12:30', calories: 540, carbs: 60, protein: 30, fat: 18, logs: [] }
          ]
        },
        settings: {}
      };

      await window.applyBootstrapPayload(payload);

      const foodCalls = setCachedWithTagsSpy.mock.calls.filter(c => c[0] === 'food_2026-05-02_day');
      expect(foodCalls).toHaveLength(1);
      expect(foodCalls[0][1]).toEqual({ groups: payload.food.groups });
      expect(foodCalls[0][2]).toEqual(['food']);
    } finally {
      cleanup();
    }
  });

  it('applyBootstrapPayload tolerates missing food block (no crash, no cache write)', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      const setCachedWithTagsSpy = vi.fn().mockResolvedValue();
      window.DataStore.setCachedWithTags = setCachedWithTagsSpy;

      await window.applyBootstrapPayload({ cursor: 1, features: {}, settings: {} });

      const foodCalls = setCachedWithTagsSpy.mock.calls.filter(c => typeof c[0] === 'string' && c[0].startsWith('food_'));
      expect(foodCalls).toHaveLength(0);
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
