import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

// Phase 5 Task 5 — Meds history sub-tab coverage. The old paper-era
// `history-group` / `history-header` / `history-items` / `history-subitem`
// structure is replaced by a day-grouped `.wg-meds-history` container
// where each minute-cluster renders as a `.wg-card` row with a
// `.wg-tag--mono` status pill. These tests lock in the new structure,
// the day-label logic, the filter strip wiring, the rejected/pending
// tag states, and the preserved delete/edit dispatch.

async function seedMedications(window, meds) {
  window.DataStore.loadSWR = vi.fn(async (options) => {
    await options.onFresh(meds);
  });
  window.apiCall = vi.fn().mockResolvedValue([]);
  await window.loadMeds();
}

describe('features/meds.js renderHistory (Phase 5, Task 5)', () => {
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

  it('groups logs by local day under .wg-section-label headers', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      await seedMedications(window, [
        { id: 1, name: 'Aspirin' },
        { id: 2, name: 'Magnesium' }
      ]);

      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const yesterday = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(todayStart.getTime() - 2 * 24 * 60 * 60 * 1000);

      const todayTaken = new Date(todayStart.getTime() + 10 * 60 * 60 * 1000).toISOString();
      const yesterdayTaken = new Date(yesterday.getTime() + 9 * 60 * 60 * 1000).toISOString();
      const olderTaken = new Date(twoDaysAgo.getTime() + 8 * 60 * 60 * 1000).toISOString();

      window.renderHistory([
        { id: 10, medication_id: 1, status: 'TAKEN', taken_at: todayTaken, scheduled_at: todayTaken },
        { id: 11, medication_id: 2, status: 'TAKEN', taken_at: yesterdayTaken, scheduled_at: yesterdayTaken },
        { id: 12, medication_id: 1, status: 'TAKEN', taken_at: olderTaken, scheduled_at: olderTaken }
      ]);

      const list = document.getElementById('history-list');
      expect(list.classList.contains('wg-meds-history')).toBe(true);

      const days = list.querySelectorAll('.wg-meds-history__day');
      expect(days.length).toBe(3);

      const dayLabels = Array.from(list.querySelectorAll('.wg-meds-history__day-label'));
      expect(dayLabels.length).toBe(3);
      dayLabels.forEach((l) => {
        expect(l.classList.contains('wg-section-label')).toBe(true);
      });
      expect(dayLabels[0].textContent).toBe('Today');
      expect(dayLabels[1].textContent).toBe('Yesterday');
      expect(dayLabels[2].textContent).toMatch(/\w+/);

      const rows = list.querySelectorAll('.wg-meds-history__row.wg-card');
      expect(rows.length).toBe(3);
    } finally {
      cleanup();
    }
  });

  it('renders each row as a .wg-card with mono-name, ISO-local time, and status tag', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      await seedMedications(window, [
        { id: 1, name: 'Aspirin', dosage: '100mg' }
      ]);

      const takenAt = new Date();
      takenAt.setHours(14, 35, 0, 0);

      window.renderHistory([
        { id: 100, medication_id: 1, status: 'TAKEN', taken_at: takenAt.toISOString(), scheduled_at: takenAt.toISOString() }
      ]);

      const row = document.querySelector('.wg-meds-history__row.wg-card');
      expect(row).not.toBeNull();
      expect(row.dataset.status).toBe('TAKEN');
      expect(row.classList.contains('history-group')).toBe(true);

      const name = row.querySelector('.wg-meds-history__name.wg-mono-display');
      expect(name).not.toBeNull();
      expect(name.textContent).toBe('Aspirin');

      const time = row.querySelector('.wg-meds-history__time');
      expect(time).not.toBeNull();
      expect(time.textContent).toBe('14:35');

      const tag = row.querySelector('.wg-meds-history__status.wg-tag--mono');
      expect(tag).not.toBeNull();
      expect(tag.classList.contains('wg-tag--normal')).toBe(true);
      expect(tag.textContent).toContain('✅');
      expect(tag.textContent).toContain('Taken');
    } finally {
      cleanup();
    }
  });

  it('renders PENDING and MISSED statuses as distinct .wg-tag--mono variants', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      await seedMedications(window, [
        { id: 1, name: 'Aspirin' }
      ]);

      const now = new Date();
      const future = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
      const past = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

      window.renderHistory([
        { id: 1, medication_id: 1, status: 'PENDING', scheduled_at: future },
        { id: 2, medication_id: 1, status: 'MISSED', scheduled_at: past }
      ]);

      const tags = document.querySelectorAll('.wg-meds-history__status');
      expect(tags.length).toBe(2);

      const pendingTag = Array.from(tags).find((t) => t.textContent.includes('Pending'));
      const missedTag = Array.from(tags).find((t) => t.textContent.includes('MISSED'));

      expect(pendingTag).toBeDefined();
      expect(pendingTag.classList.contains('wg-tag--mono')).toBe(true);
      expect(pendingTag.classList.contains('wg-tag--high')).toBe(true);
      expect(pendingTag.textContent).toContain('⏳');

      expect(missedTag).toBeDefined();
      expect(missedTag.classList.contains('wg-tag--mono')).toBe(true);
      expect(missedTag.classList.contains('wg-tag--alert')).toBe(true);
      expect(missedTag.textContent).toContain('❌');
    } finally {
      cleanup();
    }
  });

  it('row click dispatches existing showMedicationConfirmModal handler', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      await seedMedications(window, [
        { id: 1, name: 'Aspirin' },
        { id: 2, name: 'Magnesium' }
      ]);

      const now = new Date();
      const takenAt = new Date(now.getTime() - 30 * 60 * 1000).toISOString();

      const modalSpy = vi.fn();
      window.showMedicationConfirmModal = modalSpy;

      window.renderHistory([
        { id: 100, medication_id: 1, status: 'TAKEN', taken_at: takenAt, scheduled_at: takenAt },
        { id: 101, medication_id: 2, status: 'TAKEN', taken_at: takenAt, scheduled_at: takenAt }
      ]);

      const row = document.querySelector('.wg-meds-history__row.history-group');
      expect(row).not.toBeNull();
      row.click();

      expect(modalSpy).toHaveBeenCalledTimes(1);
      expect(modalSpy.mock.calls[0][0]).toEqual([1, 2]);
      expect(modalSpy.mock.calls[0][3]).toBe('edit');
      expect(modalSpy.mock.calls[0][4]).toEqual([100, 101]);
    } finally {
      cleanup();
    }
  });

  it('empty state renders inside .wg-meds-history with placeholder copy', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      await seedMedications(window, [{ id: 1, name: 'Aspirin' }]);

      window.renderHistory([]);
      const list = document.getElementById('history-list');
      expect(list.classList.contains('wg-meds-history')).toBe(true);
      const empty = list.querySelector('.wg-meds-history__empty');
      expect(empty).not.toBeNull();
      expect(empty.textContent).toBe('No history yet.');

      window.renderHistory(null);
      const empty2 = list.querySelector('.wg-meds-history__empty');
      expect(empty2).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it('preserves filter-change refetch wiring — altering days triggers loadHistory', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      await seedMedications(window, [
        {
          id: 1,
          name: 'Aspirin',
          last_taken_at: new Date().toISOString()
        }
      ]);

      let capturedKey = null;
      window.DataStore.loadSWR = vi.fn(async (options) => {
        capturedKey = options.key;
        await options.onFresh([]);
      });

      const daysSelect = document.getElementById('history-filter-days');
      daysSelect.value = '7';
      daysSelect.dispatchEvent(new window.Event('change', { bubbles: true }));

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(window.DataStore.loadSWR).toHaveBeenCalled();
      expect(capturedKey).toContain('history_7');
    } finally {
      cleanup();
    }
  });

  it('filter strip uses .wg-gloss--inset wraps around native selects', () => {
    const { document, cleanup } = loadFrontendEnv();
    try {
      const filters = document.querySelector('.wg-meds-filters');
      expect(filters).not.toBeNull();

      const fields = filters.querySelectorAll('.wg-meds-filters__field.wg-gloss--inset');
      expect(fields.length).toBe(2);

      const medSelect = fields[0].querySelector('#history-filter-med');
      const daysSelect = fields[1].querySelector('#history-filter-days');
      expect(medSelect).not.toBeNull();
      expect(daysSelect).not.toBeNull();
      expect(medSelect.classList.contains('wg-meds-filters__select')).toBe(true);
      expect(daysSelect.classList.contains('wg-meds-filters__select')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('next-intake-trigger is a muted link-style row (no inline style=)', () => {
    const { document, cleanup } = loadFrontendEnv();
    try {
      const trigger = document.getElementById('next-intake-trigger');
      expect(trigger).not.toBeNull();
      expect(trigger.classList.contains('wg-meds-next-intake-trigger')).toBe(true);
      expect(trigger.getAttribute('style')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('row carries data-intake-id on each name span so sync badges can be attached later', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      await seedMedications(window, [
        { id: 1, name: 'Aspirin' },
        { id: 2, name: 'Magnesium' }
      ]);
      const takenAt = new Date().toISOString();

      window.renderHistory([
        { id: 100, medication_id: 1, status: 'TAKEN', taken_at: takenAt, scheduled_at: takenAt },
        { id: 101, medication_id: 2, status: 'TAKEN', taken_at: takenAt, scheduled_at: takenAt }
      ]);

      const names = document.querySelectorAll('.wg-meds-history__name');
      expect(names.length).toBe(2);
      expect(names[0].dataset.intakeId).toBe('100');
      expect(names[1].dataset.intakeId).toBe('101');
    } finally {
      cleanup();
    }
  });
});
