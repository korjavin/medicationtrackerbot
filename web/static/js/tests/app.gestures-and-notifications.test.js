import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

describe('app.js test notification flows', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  it('sendTestMedicationNotification shows success, server error and network error alerts', async () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const alertSpy = vi.fn();
      window.Telegram.WebApp.showAlert = alertSpy;

      window.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        async text() { return 'sent'; }
      });

      await window.sendTestMedicationNotification();
      expect(alertSpy).toHaveBeenLastCalledWith('sent');

      window.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        async text() { return 'bad request'; }
      });
      await window.sendTestMedicationNotification();
      expect(alertSpy).toHaveBeenLastCalledWith('Error: bad request');

      window.fetch = vi.fn().mockRejectedValueOnce(new Error('offline'));
      await window.sendTestMedicationNotification();
      expect(alertSpy).toHaveBeenLastCalledWith('Error sending test notification: offline');
      consoleErrorSpy.mockRestore();
    } finally {
      cleanup();
    }
  });

  it('sendTestMedicationNotification routes its auth header through window.makeAuthHeaders', async () => {
    // Plan 2026-05-13-auth-header-consolidation Task 3: the
    // /api/webpush/test-medication direct fetch must read its
    // X-Telegram-Init-Data via window.makeAuthHeaders() so the SW-token
    // hand-off + future scheme changes flow through one helper. A
    // regression to inline construction would either drop the header or
    // skip the helper entirely.
    const { window, cleanup } = loadFrontendEnv({ telegramInitData: 'notify-token-xyz' });

    try {
      window.Telegram.WebApp.showAlert = vi.fn();
      const captured = [];
      const makeAuthHeadersSpy = vi.spyOn(window, 'makeAuthHeaders');
      window.fetch = vi.fn(async (url, opts) => {
        captured.push({ url, opts });
        return { ok: true, async text() { return 'sent'; } };
      });

      await window.sendTestMedicationNotification();

      expect(makeAuthHeadersSpy).toHaveBeenCalled();
      expect(captured).toHaveLength(1);
      expect(captured[0].url).toBe('/api/webpush/test-medication');
      expect(captured[0].opts.method).toBe('POST');
      expect(captured[0].opts.headers).toEqual({ 'X-Telegram-Init-Data': 'notify-token-xyz' });
    } finally {
      cleanup();
    }
  });

  it('sendTestMedicationNotification omits the auth header when init data is empty', async () => {
    // With no userInitData (the harness's default), makeAuthHeaders
    // returns an empty object — fetch must still get a headers object,
    // and it must not carry an `'X-Telegram-Init-Data': ''` placeholder.
    const { window, cleanup } = loadFrontendEnv();

    try {
      window.Telegram.WebApp.showAlert = vi.fn();
      const captured = [];
      window.fetch = vi.fn(async (url, opts) => {
        captured.push({ url, opts });
        return { ok: true, async text() { return 'sent'; } };
      });

      await window.sendTestMedicationNotification();

      expect(captured).toHaveLength(1);
      expect('X-Telegram-Init-Data' in captured[0].opts.headers).toBe(false);
    } finally {
      cleanup();
    }
  });

});
