import { describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('app.js extended behavior coverage', () => {
  it('apiCall returns wrapper value when offlineAwareApiCall succeeds', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      const payload = { ok: true, source: 'offline-wrapper' };
      window.offlineAwareApiCall = vi.fn().mockResolvedValue(payload);

      const result = await window.apiCall('/api/test', 'GET');
      expect(result).toEqual(payload);
      expect(window.offlineAwareApiCall).toHaveBeenCalledWith('/api/test', 'GET', null);
    } finally {
      cleanup();
    }
  });

  it('apiCall suppresses alert for failing GET through offlineAwareApiCall', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      const showAlertSpy = vi.fn();
      window.Telegram.WebApp.showAlert = showAlertSpy;
      window.offlineAwareApiCall = vi.fn().mockRejectedValue(new Error('offline'));

      const result = await window.apiCall('/api/test', 'GET');

      expect(result).toBeNull();
      expect(showAlertSpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('apiCall shows alert for failing non-GET through offlineAwareApiCall', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      const showAlertSpy = vi.fn();
      window.Telegram.WebApp.showAlert = showAlertSpy;
      window.offlineAwareApiCall = vi.fn().mockRejectedValue(new Error('write failed'));

      const result = await window.apiCall('/api/test', 'POST', { a: 1 });

      expect(result).toBeNull();
      expect(showAlertSpy).toHaveBeenCalledTimes(1);
      expect(showAlertSpy.mock.calls[0][0]).toContain('write failed');
    } finally {
      cleanup();
    }
  });

  it('requestTabRefresh debounces reloadCurrentTab when refresh is safe', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      const reloadSpy = vi.fn();
      window.reloadCurrentTab = reloadSpy;

      window.requestTabRefresh({ source: 'changes' });
      window.requestTabRefresh({ source: 'online' });

      await new Promise((resolve) => setTimeout(resolve, 560));
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('requestTabRefresh shows pending banner when modal is open and applies later', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const reloadSpy = vi.fn();
      window.reloadCurrentTab = reloadSpy;

      window.showBPRecordModal();
      window.requestTabRefresh({ source: 'changes' });

      const banner = document.getElementById('data-refresh-banner');
      expect(banner).toBeTruthy();
      expect(banner.classList.contains('hidden')).toBe(false);
      expect(reloadSpy).not.toHaveBeenCalled();

      window.closeBPRecordModal();
      window.applyPendingTabRefresh();

      expect(reloadSpy).toHaveBeenCalledTimes(1);
      expect(banner.classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('handlePushAction schedules medication confirm modal with parsed params', () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      const showModalSpy = vi.fn();
      window.showMedicationConfirmModal = showModalSpy;

      const timeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation((fn, ms) => {
        fn();
        return 1;
      });

      const params = new URLSearchParams('ids=1,2&names=Aspirin,Vitamin%20D&scheduled=2026-02-27T10:00:00Z');
      window.handlePushAction('medication_confirm', params);

      expect(timeoutSpy).toHaveBeenCalled();
      expect(timeoutSpy.mock.calls[0][1]).toBe(500);
      expect(showModalSpy).toHaveBeenCalledWith(['1', '2'], ['Aspirin', 'Vitamin D'], '2026-02-27T10:00:00Z');

      timeoutSpy.mockRestore();
    } finally {
      cleanup();
    }
  });
});
