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

});
