import { describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('app.js loadMeds/BP edge branches', () => {
  it('wrapped loadMeds runs original loader', async () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      window.renderMeds = vi.fn();
      window.populateMedFilter = vi.fn();
      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onCached([]);
      });

      await window.loadMeds();

      expect(window.DataStore.loadSWR).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('handleBPSubmit validates required fields and supports null pulse payload', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const alertSpy = vi.fn();
      window.Telegram.WebApp.showAlert = alertSpy;

      window.showBPRecordModal();
      document.getElementById('bp-datetime').value = '';
      document.getElementById('bp-systolic').value = '';
      document.getElementById('bp-diastolic').value = '';

      await window.handleBPSubmit({ preventDefault() {} });
      expect(alertSpy).toHaveBeenCalledWith('Please fill in all required fields with valid numbers');

      const apiCallSpy = vi.fn().mockResolvedValue({ ok: true });
      window.apiCall = apiCallSpy;
      window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
      window.loadBPReadings = vi.fn();

      document.getElementById('bp-datetime').value = '2026-02-28T15:30';
      document.getElementById('bp-systolic').value = '126';
      document.getElementById('bp-diastolic').value = '81';
      document.getElementById('bp-pulse').value = '';
      document.getElementById('bp-site').value = 'left_arm';
      document.getElementById('bp-position').value = 'standing';
      document.getElementById('bp-notes').value = 'No pulse entered';

      await window.handleBPSubmit({ preventDefault() {} });
      expect(apiCallSpy).toHaveBeenCalledWith('/api/bp', 'POST', {
        measured_at: new Date('2026-02-28T15:30').toISOString(),
        systolic: 126,
        diastolic: 81,
        pulse: null,
        site: 'left_arm',
        position: document.getElementById('bp-position').value,
        notes: 'No pulse entered'
      });
    } finally {
      cleanup();
    }
  });

});
