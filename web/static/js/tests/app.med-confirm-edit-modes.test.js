import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('app.js medication confirm edit/log modes', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('showMedicationConfirmModal configures edit/log_past modes and handles invalid datetime formatting', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.showMedicationConfirmModal([11], ['Vitamin D'], 'not-a-date', 'edit', [111]);
      expect(document.getElementById('med-confirm-title').innerText).toBe('Edit Intake');
      expect(document.getElementById('med-confirm-time-edit').style.display).toBe('block');
      expect(document.getElementById('med-confirm-action-btn').innerText).toBe('Update');
      expect(document.getElementById('med-confirm-snooze-btn').style.display).toBe('none');
      expect(consoleErrorSpy).toHaveBeenCalled();
      const lastErrorCall = consoleErrorSpy.mock.calls.at(-1);
      expect(lastErrorCall[0]).toBe('Error formatting date for input');
      expect(String(lastErrorCall[1]?.message || lastErrorCall[1])).toContain('Invalid time value');

      window.showMedicationConfirmModal([12], ['Magnesium'], '2026-02-28T09:30:00Z', 'log_past', [222]);
      expect(document.getElementById('med-confirm-title').innerText).toBe('Log Intake');
      expect(document.getElementById('med-confirm-action-btn').innerText).toBe('Log Intake');
      expect(document.querySelectorAll('.med-confirm-check')).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('confirmSelectedMedications closes without API call when nothing is selected, and surfaces API errors', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.showMedicationConfirmModal([1, 2], ['A', 'B'], '2026-02-28T10:00:00Z');

      document.querySelectorAll('.med-confirm-check').forEach((checkbox) => {
        checkbox.checked = false;
      });
      window.apiCall = vi.fn();
      await window.confirmSelectedMedications();
      expect(window.apiCall).not.toHaveBeenCalled();
      expect(document.getElementById('med-confirm-modal').classList.contains('hidden')).toBe(true);

      window.safeAlert = vi.fn();
      window.showMedicationConfirmModal([3], ['C'], '2026-02-28T10:05:00Z');
      // apiCall returns null on error (handles error internally); modal still closes
      window.apiCall = vi.fn().mockResolvedValue(null);
      await window.confirmSelectedMedications();
      expect(window.safeAlert).not.toHaveBeenCalledWith('Confirmed!');
      expect(document.getElementById('med-confirm-modal').classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('updateIntakeHistory builds taken/pending updates and handles no-op and error paths', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.safeAlert = vi.fn();
      window.loadMeds = vi.fn();
      window.loadHistory = vi.fn();

      window.showMedicationConfirmModal(
        [10, 20],
        ['Med A', 'Med B'],
        '2026-02-28T11:00:00Z',
        'edit',
        [100, 200]
      );
      document.getElementById('med-confirm-datetime').value = '2026-02-28T11:45';
      const checks = document.querySelectorAll('.med-confirm-check');
      checks[0].checked = true;
      checks[1].checked = false;

      window.apiCall = vi.fn().mockResolvedValue({ ok: true });
      await window.updateIntakeHistory();
      expect(window.apiCall).toHaveBeenCalledWith('/api/intakes/update', 'POST', {
        updates: [
          {
            id: 100,
            status: 'TAKEN',
            taken_at: new Date('2026-02-28T11:45').toISOString()
          },
          {
            id: 200,
            status: 'PENDING',
            taken_at: ''
          }
        ]
      });
      expect(window.safeAlert).toHaveBeenCalledWith('Updated!');
      expect(window.loadMeds).toHaveBeenCalled();
      expect(window.loadHistory).toHaveBeenCalled();

      window.showMedicationConfirmModal([30], ['Med C'], '2026-02-28T12:00:00Z', 'edit', [null]);
      window.apiCall = vi.fn();
      await window.updateIntakeHistory();
      expect(window.apiCall).not.toHaveBeenCalled();

      window.showMedicationConfirmModal([40], ['Med D'], '2026-02-28T12:10:00Z', 'edit', [400]);
      document.getElementById('med-confirm-datetime').value = '2026-02-28T12:15';
      // apiCall returns null on error (handles error internally)
      window.apiCall = vi.fn().mockResolvedValue(null);
      window.safeAlert.mockClear();
      await window.updateIntakeHistory();
      expect(window.safeAlert).not.toHaveBeenCalledWith('Updated!');
    } finally {
      cleanup();
    }
  });

  it('confirmLogPast posts payload and handles failure branch', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.safeAlert = vi.fn();
      window.loadMeds = vi.fn();
      window.loadHistory = vi.fn();

      window.showMedicationConfirmModal([77], ['Med X'], '2026-02-28T13:00:00Z', 'log_past', []);
      document.getElementById('med-confirm-datetime').value = '2026-02-28T13:20';
      window.apiCall = vi.fn().mockResolvedValue({ ok: true });
      await window.confirmLogPast();
      expect(window.apiCall).toHaveBeenCalledWith('/api/medications/log-past', 'POST', {
        medication_id: 77,
        taken_at: new Date('2026-02-28T13:20').toISOString()
      });
      expect(window.safeAlert).toHaveBeenCalledWith('Intake logged!');
      expect(window.loadMeds).toHaveBeenCalled();
      expect(window.loadHistory).toHaveBeenCalled();

      window.showMedicationConfirmModal([88], ['Med Y'], '2026-02-28T14:00:00Z', 'log_past', []);
      document.getElementById('med-confirm-datetime').value = '2026-02-28T14:10';
      // apiCall returns null on error (handles error internally)
      window.apiCall = vi.fn().mockResolvedValue(null);
      window.safeAlert.mockClear();
      await window.confirmLogPast();
      expect(window.safeAlert).not.toHaveBeenCalledWith('Intake logged!');
    } finally {
      cleanup();
    }
  });
});
