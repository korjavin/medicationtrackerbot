import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockResponse, loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

const AUTH_CACHE_KEY = 'medtracker_auth_state';

describe('app.js checkAuth behavior', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  it('authorizes via cookie bootstrap and stores auth state', async () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      window.fetch = vi.fn()
        .mockResolvedValueOnce(createMockResponse({
          status: 200,
          json: { authenticated: true, method: 'cookie' }
        }))
        .mockResolvedValueOnce(createMockResponse({
          status: 200,
          json: { cursor: 5, features: { bp: true } }
        }));

      const authorized = await window.checkAuth();

      expect(authorized).toBe(true);
      expect(window.fetch).toHaveBeenNthCalledWith(1, '/auth/status', { method: 'GET', credentials: 'same-origin' });
      expect(window.fetch).toHaveBeenCalledWith(
        expect.stringMatching(/^\/api\/bootstrap\?(tz=|tz_offset=)/),
        { method: 'GET' }
      );

      const cachedAuth = JSON.parse(window.localStorage.getItem(AUTH_CACHE_KEY));
      expect(cachedAuth.authenticated).toBe(true);
      expect(cachedAuth.authMethod).toBe('cookie');
      expect(window.localStorage.getItem('medtracker_changes_cursor')).toBe('5');
    } finally {
      cleanup();
    }
  });

  it('uses cached auth when server is unavailable and loads medications from cache', async () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      window.localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({
        authenticated: true,
        authMethod: 'cookie',
        timestamp: Date.now(),
        ttl: 30 * 24 * 60 * 60 * 1000
      }));
      window.sessionStorage.setItem('medtracker_auth_reload_in_progress', '1');

      const getCacheSpy = vi.fn().mockResolvedValue([{ id: 1, name: 'Aspirin' }]);
      window.MedTrackerDB = {
        MedicationStore: { getCache: getCacheSpy }
      };

      window.fetch = vi.fn().mockResolvedValue(createMockResponse({ status: 503, text: 'down' }));

      const authorized = await window.checkAuth();

      expect(authorized).toBe(true);
      expect(getCacheSpy).toHaveBeenCalledTimes(1);
      expect(window.sessionStorage.getItem('medtracker_auth_reload_in_progress')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('reads cached settings_bundle during offline fallback', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      window.localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({
        authenticated: true,
        authMethod: 'cookie',
        timestamp: Date.now(),
        ttl: 30 * 24 * 60 * 60 * 1000
      }));
      window.fetch = vi.fn().mockResolvedValue(createMockResponse({ status: 502, text: 'Bad Gateway' }));

      window.MedTrackerDB = { MedicationStore: { getCache: vi.fn().mockResolvedValue([]) } };

      const getCachedSpy = vi.fn().mockImplementation(async (key) => {
        if (key === 'settings_bundle') {
          return { tabOrder: ['weight', 'bp', 'food'] };
        }
        return null;
      });
      window.DataStore.getCached = getCachedSpy;

      const authorized = await window.checkAuth();

      expect(authorized).toBe(true);
      expect(getCachedSpy).toHaveBeenCalledWith('settings_bundle');
    } finally {
      cleanup();
    }
  });

  it('shows login screen when unauthorized and no cache is available', async () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        value: true
      });
      window.localStorage.removeItem(AUTH_CACHE_KEY);
      window.fetch = vi.fn().mockResolvedValue(createMockResponse({
        status: 200,
        json: { authenticated: false }
      }));

      const authorized = await window.checkAuth();

      expect(authorized).toBe(false);
      const widgetContainer = window.document.getElementById('telegram-login-container');
      expect(widgetContainer).toBeTruthy();
      const telegramLink = widgetContainer.querySelector('a');
      expect(telegramLink).toBeTruthy();
      expect(telegramLink.getAttribute('href')).toBe('https://t.me/test_bot');
    } finally {
      cleanup();
    }
  });

  it('shows offline login message when network is unavailable and no cache exists', async () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        value: false
      });
      window.localStorage.removeItem(AUTH_CACHE_KEY);
      window.fetch = vi.fn().mockRejectedValue(new Error('network down'));

      const authorized = await window.checkAuth();

      expect(authorized).toBe(false);
      expect(window.document.body.textContent).toContain('internet connection');
      expect(window.document.getElementById('telegram-login-container')).toBeNull();
      expect(window.document.querySelector('button')).toBeTruthy();
    } finally {
      cleanup();
    }
  });
});
