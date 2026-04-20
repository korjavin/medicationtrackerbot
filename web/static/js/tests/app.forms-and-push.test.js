import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('app.js form submissions and push modal behavior', () => {
  let consoleLogSpy;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('showMedicationConfirmModal renders confirm mode and close hides it', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const overlay = document.getElementById('modal-overlay');
      const modal = document.getElementById('med-confirm-modal');

      window.showMedicationConfirmModal(['1', '2'], ['Aspirin', 'Vitamin D'], '2026-02-27T10:00:00Z');

      expect(overlay.classList.contains('hidden')).toBe(false);
      expect(modal.classList.contains('hidden')).toBe(false);
      expect(document.getElementById('med-confirm-action-btn').innerText).toBe('Confirm Selected');
      expect(document.getElementById('med-confirm-snooze-btn').style.display).toBe('inline-block');
      expect(document.querySelectorAll('.med-confirm-check').length).toBe(2);

      document.getElementById('med-confirm-dismiss-btn').click();
      expect(overlay.classList.contains('hidden')).toBe(true);
      expect(modal.classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('confirmSelectedMedications posts selected ids and refreshes lists', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const apiCallSpy = vi.fn().mockResolvedValue({ ok: true });
      const loadMedsSpy = vi.fn();
      const loadHistorySpy = vi.fn();
      const alertSpy = vi.fn();

      window.apiCall = apiCallSpy;
      window.loadMeds = loadMedsSpy;
      window.loadHistory = loadHistorySpy;
      window.Telegram.WebApp.showAlert = alertSpy;

      window.showMedicationConfirmModal(['10', '20'], ['A', 'B'], '2026-02-27T10:00:00Z');

      const checks = document.querySelectorAll('.med-confirm-check');
      checks[1].checked = false;

      await window.confirmSelectedMedications();

      expect(apiCallSpy).toHaveBeenCalledTimes(1);
      expect(apiCallSpy.mock.calls[0][0]).toBe('/api/medications/confirm-schedule');
      expect(apiCallSpy.mock.calls[0][1]).toBe('POST');
      expect(apiCallSpy.mock.calls[0][2]).toEqual({
        scheduled_at: '2026-02-27T10:00:00Z',
        medication_ids: [10]
      });
      expect(loadMedsSpy).toHaveBeenCalledTimes(1);
      expect(loadHistorySpy).toHaveBeenCalledTimes(1);
      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(document.getElementById('med-confirm-modal').classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('confirmSelectedMedications includes intake_ids in POST body when provided via push notification', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const apiCallSpy = vi.fn().mockResolvedValue({ ok: true });
      const loadMedsSpy = vi.fn();
      const loadHistorySpy = vi.fn();
      const alertSpy = vi.fn();

      window.apiCall = apiCallSpy;
      window.loadMeds = loadMedsSpy;
      window.loadHistory = loadHistorySpy;
      window.Telegram.WebApp.showAlert = alertSpy;

      window.showMedicationConfirmModal([10, 20], ['A', 'B'], '2026-02-27T10:00:00Z', 'confirm', [100, 200]);

      const checks = document.querySelectorAll('.med-confirm-check');
      checks[1].checked = false;

      await window.confirmSelectedMedications();

      expect(apiCallSpy).toHaveBeenCalledTimes(1);
      expect(apiCallSpy.mock.calls[0][0]).toBe('/api/medications/confirm-schedule');
      expect(apiCallSpy.mock.calls[0][1]).toBe('POST');
      expect(apiCallSpy.mock.calls[0][2]).toEqual({
        scheduled_at: '2026-02-27T10:00:00Z',
        medication_ids: [10],
        intake_ids: [100]
      });
    } finally {
      cleanup();
    }
  });

  it('skipSelectedMedications posts selected intake ids using row indices', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const apiCallSpy = vi.fn(async (path, method, body) => {
        if (path === '/api/medications/skip') return { ok: true, body };
        return { ok: true };
      });
      const loadMedsSpy = vi.fn();
      const loadHistorySpy = vi.fn();
      const alertSpy = vi.fn();

      window.apiCall = apiCallSpy;
      window.loadMeds = loadMedsSpy;
      window.loadHistory = loadHistorySpy;
      window.Telegram.WebApp.showAlert = alertSpy;

      window.showMedicationConfirmModal([10, 20], ['A', 'B'], '2026-02-27T10:00:00Z', 'confirm', [100, 200]);

      const checks = document.querySelectorAll('.med-confirm-check');
      checks[1].checked = false;

      await window.skipSelectedMedications();

      expect(apiCallSpy).toHaveBeenCalledTimes(1);
      expect(apiCallSpy.mock.calls[0][0]).toBe('/api/medications/skip');
      expect(apiCallSpy.mock.calls[0][1]).toBe('POST');
      expect(apiCallSpy.mock.calls[0][2]).toEqual({ intake_id: 100 });
      expect(loadMedsSpy).toHaveBeenCalledTimes(1);
      expect(loadHistorySpy).toHaveBeenCalledTimes(1);
      expect(alertSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('handleBPSubmit posts payload, invalidates bp tag and refreshes list', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const apiCallSpy = vi.fn().mockResolvedValue({ id: 1 });
      const invalidateSpy = vi.fn().mockResolvedValue(undefined);
      const loadBPSpy = vi.fn();

      window.apiCall = apiCallSpy;
      window.DataStore.invalidateTags = invalidateSpy;
      window.loadBPReadings = loadBPSpy;

      window.showBPRecordModal();

      const inputDateTime = '2026-02-27T10:30';
      document.getElementById('bp-datetime').value = inputDateTime;
      document.getElementById('bp-systolic').value = '128';
      document.getElementById('bp-diastolic').value = '82';
      document.getElementById('bp-pulse').value = '67';
      document.getElementById('bp-site').value = 'right_arm';
      document.getElementById('bp-position').value = 'seated';
      document.getElementById('bp-notes').value = 'Morning';

      await window.handleBPSubmit({ preventDefault() {} });

      expect(apiCallSpy).toHaveBeenCalledTimes(1);
      expect(apiCallSpy.mock.calls[0][0]).toBe('/api/bp');
      expect(apiCallSpy.mock.calls[0][1]).toBe('POST');
      expect(apiCallSpy.mock.calls[0][2]).toEqual({
        measured_at: new Date(inputDateTime).toISOString(),
        systolic: 128,
        diastolic: 82,
        pulse: 67,
        site: 'right_arm',
        position: 'seated',
        notes: 'Morning'
      });
      expect(invalidateSpy).toHaveBeenCalledWith(['bp']);
      expect(loadBPSpy).toHaveBeenCalledTimes(1);
      expect(document.getElementById('bp-modal').classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('handleBPSubmit awaits loadBPReadings so the new row renders before resolving', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const apiCallSpy = vi.fn().mockResolvedValue({ id: 42 });
      window.apiCall = apiCallSpy;
      window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);

      let resolveLoad;
      const loadPromise = new Promise((resolve) => { resolveLoad = resolve; });
      let loadResolved = false;
      window.loadBPReadings = vi.fn(() => loadPromise.then(() => {
        const list = document.getElementById('bp-list') || document.getElementById('bp-readings-list');
        if (list) {
          const row = document.createElement('div');
          row.className = 'wg-bp-history__item';
          row.textContent = '132/84';
          list.appendChild(row);
        }
        loadResolved = true;
      }));

      window.showBPRecordModal();
      document.getElementById('bp-datetime').value = '2026-02-27T10:30';
      document.getElementById('bp-systolic').value = '132';
      document.getElementById('bp-diastolic').value = '84';

      const submitPromise = window.handleBPSubmit({ preventDefault() {} });

      // Microtask drain so apiCall + invalidateTags + loadBPReadings kick off.
      await Promise.resolve();
      await Promise.resolve();
      expect(loadResolved).toBe(false);

      resolveLoad();
      await submitPromise;

      expect(loadResolved).toBe(true);
      const list = document.getElementById('bp-list') || document.getElementById('bp-readings-list');
      expect(list.textContent).toContain('132/84');
    } finally {
      cleanup();
    }
  });

  it('handleBPSubmit does not close modal or reload list when POST fails', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const apiCallSpy = vi.fn().mockResolvedValue(null);
      const invalidateSpy = vi.fn().mockResolvedValue(undefined);
      const loadBPSpy = vi.fn();

      window.apiCall = apiCallSpy;
      window.DataStore.invalidateTags = invalidateSpy;
      window.loadBPReadings = loadBPSpy;

      window.showBPRecordModal();
      document.getElementById('bp-datetime').value = '2026-02-27T10:30';
      document.getElementById('bp-systolic').value = '132';
      document.getElementById('bp-diastolic').value = '84';

      await window.handleBPSubmit({ preventDefault() {} });

      expect(apiCallSpy).toHaveBeenCalledTimes(1);
      expect(invalidateSpy).not.toHaveBeenCalled();
      expect(loadBPSpy).not.toHaveBeenCalled();
      expect(document.getElementById('bp-modal').classList.contains('hidden')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('handleWeightSubmit posts payload, invalidates weight tag and refreshes list', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const apiCallSpy = vi.fn().mockResolvedValue({ id: 1 });
      const invalidateSpy = vi.fn().mockResolvedValue(undefined);
      const loadWeightSpy = vi.fn();

      window.apiCall = apiCallSpy;
      window.DataStore.invalidateTags = invalidateSpy;
      window.loadWeightLogs = loadWeightSpy;

      window.showWeightModal();

      const inputDateTime = '2026-02-27T11:05';
      document.getElementById('weight-datetime').value = inputDateTime;
      document.getElementById('weight-value').value = '79.4';
      document.getElementById('weight-notes').value = 'After workout';

      await window.handleWeightSubmit({ preventDefault() {} });

      expect(apiCallSpy).toHaveBeenCalledTimes(1);
      expect(apiCallSpy).toHaveBeenCalledWith('/api/weight', 'POST', {
        measured_at: new Date(inputDateTime).toISOString(),
        weight: 79.4,
        notes: 'After workout'
      });
      expect(invalidateSpy).toHaveBeenCalledWith(['weight']);
      expect(loadWeightSpy).toHaveBeenCalledTimes(1);
      expect(document.getElementById('weight-modal').classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });
});
