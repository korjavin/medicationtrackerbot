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
      expect(document.getElementById('med-confirm-eyebrow').textContent).toBe('Edit intake');
      expect(document.getElementById('med-confirm-action-btn').textContent).toBe('Update');
      expect(document.getElementById('med-confirm-snooze-btn').classList.contains('hidden')).toBe(true);
      expect(document.getElementById('med-confirm-skip-btn').classList.contains('hidden')).toBe(true);
      expect(consoleErrorSpy).toHaveBeenCalled();
      const lastErrorCall = consoleErrorSpy.mock.calls.at(-1);
      expect(lastErrorCall[0]).toBe('Error formatting date for input');
      expect(String(lastErrorCall[1]?.message || lastErrorCall[1])).toContain('Invalid time value');

      window.showMedicationConfirmModal([12], ['Magnesium'], '2026-02-28T09:30:00Z', 'log_past', [222]);
      expect(document.getElementById('med-confirm-eyebrow').textContent).toBe('Log intake');
      expect(document.getElementById('med-confirm-title').textContent).toBe('Magnesium');
      expect(document.getElementById('med-confirm-action-btn').textContent).toBe('Log');
      expect(document.querySelectorAll('.med-confirm-check')).toHaveLength(1);
      // The time row shows the given time, not "Now".
      expect(document.getElementById('med-confirm-time-value').textContent).not.toMatch(/^Now/);
    } finally {
      cleanup();
    }
  });

  it('take sheet (M2): kit sheet, check-choice rows, count on the primary, Time taken defaults to now', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const modal = document.getElementById('med-confirm-modal');
      expect(modal.classList.contains('wg-sheet')).toBe(true);
      expect(modal.querySelector('.wg-sheethead')).not.toBeNull();
      expect(modal.querySelector('.wg-sheet__foot #med-confirm-action-btn')).not.toBeNull();
      expect(document.getElementById('med-confirm-snooze-btn').classList.contains('wg-btn--ghost')).toBe(true);
      expect(document.getElementById('med-confirm-skip-btn').classList.contains('wg-btn--ghost')).toBe(true);

      window.showMedicationConfirmModal(['1', '2', '3'], ['Aspirin', 'Vitamin D', 'Zinc'], '2026-02-27T10:00:00Z');
      const eyebrow = document.getElementById('med-confirm-eyebrow').textContent;
      const title = document.getElementById('med-confirm-title').textContent;
      expect(eyebrow).toBe('Time for meds');
      expect(title).not.toBe('');
      expect(title.toLowerCase()).not.toContain(eyebrow.toLowerCase());

      const rows = document.querySelectorAll('#med-confirm-list .wg-choice.wg-choice--check');
      expect(rows.length).toBe(3);
      rows.forEach((row) => expect(row.getAttribute('aria-pressed')).toBe('true'));

      const btn = document.getElementById('med-confirm-action-btn');
      expect(btn.textContent.replace(/\s+/g, ' ').trim()).toBe('Take 3');
      expect(btn.querySelector('.wg-btn__count').textContent).toBe('3');

      rows[0].click();
      expect(rows[0].getAttribute('aria-pressed')).toBe('false');
      expect(rows[1].getAttribute('aria-pressed')).toBe('true');
      expect(btn.querySelector('.wg-btn__count').textContent).toBe('2');
      rows[0].click();
      expect(btn.querySelector('.wg-btn__count').textContent).toBe('3');

      // Time taken: a value row defaulting to now; the native input is only the picker.
      expect(document.getElementById('med-confirm-time-value').textContent).toMatch(/^Now/);
      expect(document.getElementById('med-confirm-time-btn').classList.contains('wg-setting')).toBe(true);
      expect(document.getElementById('med-confirm-datetime').value).not.toBe('');
    } finally {
      cleanup();
    }
  });

  it('confirm mode sends taken_at only after the user picks a time', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.loadMeds = vi.fn();
      window.loadHistory = vi.fn();
      window.apiCall = vi.fn().mockResolvedValue({ status: 'confirmed' });

      window.showMedicationConfirmModal([1], ['A'], '2026-02-28T10:00:00Z', 'confirm', [100]);
      await window.confirmSelectedMedications();
      expect(window.apiCall.mock.calls[0][2]).not.toHaveProperty('taken_at');

      window.apiCall.mockClear();
      window.showMedicationConfirmModal([1], ['A'], '2026-02-28T10:00:00Z', 'confirm', [100]);
      const input = document.getElementById('med-confirm-datetime');
      input.value = '2026-02-28T09:40';
      input.dispatchEvent(new window.Event('change'));
      expect(document.getElementById('med-confirm-time-value').textContent).not.toMatch(/^Now/);
      await window.confirmSelectedMedications();
      expect(window.apiCall.mock.calls[0][2].taken_at).toBe(new Date('2026-02-28T09:40').toISOString());
    } finally {
      cleanup();
    }
  });

  it('confirmSelectedMedications calls API with empty array when nothing is selected to allow reverting, and surfaces API errors', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    // Mock loadMeds and loadHistory to avoid DOM errors in tests
    window.loadMeds = vi.fn();
    window.loadHistory = vi.fn();

    try {
      window.showMedicationConfirmModal([1, 2], ['A', 'B'], '2026-02-28T10:00:00Z');

      document.querySelectorAll('.med-confirm-check').forEach((checkbox) => {
        checkbox.setAttribute('aria-pressed', 'false');
      });
      window.apiCall = vi.fn().mockResolvedValue({ status: "ok" });
      await window.confirmSelectedMedications();
      expect(window.apiCall).toHaveBeenCalledWith('/api/medications/confirm-schedule', 'POST', {
        scheduled_at: '2026-02-28T10:00:00Z',
        medication_ids: []
      });
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
      checks[0].setAttribute('aria-pressed', 'true');
      checks[1].setAttribute('aria-pressed', 'false');

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
