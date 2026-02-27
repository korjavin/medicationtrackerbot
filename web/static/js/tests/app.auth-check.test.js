import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockResponse, loadFrontendEnv } from './helpers/frontend-harness.js';

const AUTH_CACHE_KEY = 'medtracker_auth_state';

describe('app.js checkAuth behavior', () => {
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('authorizes via cookie bootstrap and stores auth state', async () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      window.fetch = vi.fn().mockResolvedValue(createMockResponse({
        status: 200,
        json: { cursor: 5, features: { bp: true } }
      }));

      const authorized = await window.checkAuth();

      expect(authorized).toBe(true);
      expect(window.fetch).toHaveBeenCalledWith('/api/bootstrap', { method: 'GET' });

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

  it('shows login screen when unauthorized and no cache is available', async () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        value: true
      });
      window.localStorage.removeItem(AUTH_CACHE_KEY);
      window.fetch = vi.fn().mockResolvedValue(createMockResponse({ status: 401, text: 'unauthorized' }));

      const authorized = await window.checkAuth();

      expect(authorized).toBe(false);
      const widgetContainer = window.document.getElementById('telegram-login-container');
      expect(widgetContainer).toBeTruthy();
      const widgetScript = widgetContainer.querySelector('script');
      expect(widgetScript).toBeTruthy();
      expect(widgetScript.getAttribute('src')).toContain('telegram-widget.js');
      expect(widgetScript.getAttribute('data-telegram-login')).toBe('test_bot');
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
