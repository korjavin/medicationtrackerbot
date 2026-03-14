import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function toLocalTime(date) {
  return date.toTimeString().slice(0, 5);
}

async function seedMedications(window, meds) {
  window.DataStore.loadSWR = vi.fn(async (options) => {
    await options.onFresh(meds);
  });
  window.apiCall = vi.fn().mockResolvedValue([]);
  await window.loadMeds();
}

describe('app.js medication, history and intake flows', () => {
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

  it('addTimeInput/removeTime manipulate dynamic medication time rows', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const container = document.getElementById('time-inputs');
      const initialRows = container.querySelectorAll('.time-row').length;

      window.addTimeInput('08:45');
      expect(container.querySelectorAll('.time-row').length).toBe(initialRows + 1);
      const lastInput = container.querySelector('.time-row:last-child .med-time-input');
      expect(lastInput.value).toBe('08:45');

      const removeBtn = container.querySelector('.time-row:last-child .remove-time');
      window.removeTime(removeBtn);
      expect(container.querySelectorAll('.time-row').length).toBe(initialRows);
    } finally {
      cleanup();
    }
  });

  it('renderMeds and populateMedFilter render mixed schedules and inventory badges', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const now = new Date();
      const soon = new Date(now.getTime() + (60 * 60 * 1000));
      const far = new Date(now.getTime() + (20 * 60 * 60 * 1000));
      const todayDow = now.getDay();

      await seedMedications(window, [
        {
          id: 1,
          name: 'Soon Med',
          dosage: '10mg',
          schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(soon)] }),
          archived: false,
          inventory_count: 2,
          last_taken_at: now.toISOString(),
          normalized_name: 'Soon Med Rx'
        },
        {
          id: 2,
          name: 'Later Med',
          dosage: '5mg',
          schedule: JSON.stringify({ type: 'weekly', days: [todayDow], times: [toLocalTime(far)] }),
          archived: false,
          inventory_count: 20,
          last_taken_at: new Date(now.getTime() - (2 * 24 * 60 * 60 * 1000)).toISOString()
        },
        {
          id: 3,
          name: '<b>As Needed</b>',
          dosage: '1 tab',
          schedule: JSON.stringify({ type: 'as_needed' }),
          archived: false,
          inventory_count: null
        },
        {
          id: 4,
          name: 'Archived Med',
          dosage: '2mg',
          schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }),
          archived: true
        }
      ]);

      const medsHtml = document.getElementById('med-list').innerHTML;
      expect(medsHtml).toContain('Soon Med');
      expect(medsHtml).toContain('Weekly');
      expect(medsHtml).toContain('As Needed');
      expect(medsHtml).toContain('archived');
      expect(medsHtml).toContain('⚠️');
      expect(medsHtml).toContain('Soon Med Rx');
      expect(document.getElementById('med-list').textContent).toContain('<b>As Needed</b>');
      expect(medsHtml).not.toContain('<b>As Needed</b>');

      const editSpy = vi.spyOn(window, 'showEditModal').mockImplementation(() => {});
      const logSpy = vi.spyOn(window, 'logMedicationPast').mockImplementation(() => {});
      const deleteSpy = vi.spyOn(window, 'deleteMed').mockImplementation(() => {});

      const soonCard = Array.from(document.querySelectorAll('#med-list .med-item'))
        .find((el) => el.textContent.includes('Soon Med'));
      soonCard.querySelector('.icon-action-btn:not(.delete)').click(); // Edit button
      soonCard.querySelector('.small-btn').click();
      soonCard.querySelector('.icon-action-btn.delete').click();

      expect(editSpy).toHaveBeenCalledWith(1);
      expect(logSpy).toHaveBeenCalledWith(1, 'Soon Med');
      expect(deleteSpy).toHaveBeenCalledWith(1);

      const filter = document.getElementById('history-filter-med');
      const options = Array.from(filter.querySelectorAll('option'));

      // Should include 'All Medications' and 'Soon Med' (taken recently)
      // but NOT 'Later Med' (taken 2 days ago, which IS recent, so we need to add a test case for one > 7 days)

      // But let's check what's actually there
      expect(options.some(o => o.text.includes('All Medications'))).toBe(true);
      expect(options.some(o => o.text.includes('Soon Med'))).toBe(true);
      expect(options.some(o => o.text.includes('Later Med'))).toBe(true); // 2 days ago is within 7 days
      expect(options.some(o => o.text.includes('As Needed'))).toBe(false); // no last_taken_at
      expect(options.some(o => o.text.includes('Archived Med'))).toBe(false); // no last_taken_at
    } finally {
      cleanup();
    }
  });

  it('populateMedFilter only shows medications taken in the last 7 days', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - (3 * 24 * 60 * 60 * 1000));
      const eightDaysAgo = new Date(now.getTime() - (8 * 24 * 60 * 60 * 1000));

      await seedMedications(window, [
        {
          id: 1,
          name: 'Recent Med',
          schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }),
          last_taken_at: threeDaysAgo.toISOString()
        },
        {
          id: 2,
          name: 'Old Med',
          schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }),
          last_taken_at: eightDaysAgo.toISOString()
        },
        {
          id: 3,
          name: 'Never Taken Med',
          schedule: JSON.stringify({ type: 'daily', times: ['10:00'] }),
          last_taken_at: null
        }
      ]);

      const filter = document.getElementById('history-filter-med');
      const options = Array.from(filter.querySelectorAll('option'));

      expect(options.length).toBe(2); // All Medications + Recent Med
      expect(options[0].text).toBe('All Medications');
      expect(options[1].text).toBe('Recent Med');

      // Test fallback to 0 when previously selected medication ages out
      filter.value = "2"; // Simulate 'Old Med' was selected
      window.populateMedFilter();
      expect(filter.value).toBe("0"); // Should fallback to 'All Medications'

      // Test retaining selected value when still valid
      filter.value = "1"; // Simulate 'Recent Med' was selected
      window.populateMedFilter();
      expect(filter.value).toBe("1"); // Should retain 'Recent Med'
    } finally {
      cleanup();
    }
  });

  it('loadHistory clears the list when fetching returns null or empty array', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      await seedMedications(window, [
        { id: 1, name: 'Aspirin' }
      ]);

      // Seed with initial history
      const now = new Date();
      window.renderHistory([
        { id: 100, medication_id: 1, status: 'TAKEN', taken_at: now.toISOString(), scheduled_at: now.toISOString() }
      ]);

      const list = document.getElementById('history-list');
      expect(list.innerHTML).toContain('Aspirin');

      // Now mock DataStore.loadSWR to return null for fresh
      window.DataStore.loadSWR = vi.fn(async (options) => {
        // Assert we passed allowNullFresh
        expect(options.allowNullFresh).toBe(true);
        await options.onFresh(null);
      });

      await window.loadHistory();

      // List should be empty
      expect(list.innerHTML).toContain('No history yet.');
      expect(list.innerHTML).not.toContain('Aspirin');

      // Test empty array as well
      window.renderHistory([
        { id: 100, medication_id: 1, status: 'TAKEN', taken_at: now.toISOString(), scheduled_at: now.toISOString() }
      ]);
      expect(list.innerHTML).toContain('Aspirin');

      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh([]);
      });
      await window.loadHistory();
      expect(list.innerHTML).toContain('No history yet.');
    } finally {
      cleanup();
    }
  });

  it('renderHistory groups intakes and opens edit modal on TAKEN group click', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      await seedMedications(window, [
        { id: 1, name: 'Aspirin' },
        { id: 2, name: '<b>Magnesium</b>' }
      ]);

      const now = new Date();
      const takenAt = new Date(now.getTime() - (60 * 60 * 1000)).toISOString();
      const scheduledAt = new Date(now.getTime() - (2 * 60 * 60 * 1000)).toISOString();

      const logs = [
        { id: 100, medication_id: 1, status: 'TAKEN', taken_at: takenAt, scheduled_at: scheduledAt },
        { id: 101, medication_id: 2, status: 'TAKEN', taken_at: takenAt, scheduled_at: scheduledAt },
        { id: 102, medication_id: 1, status: 'PENDING', scheduled_at: new Date(now.getTime() + (60 * 60 * 1000)).toISOString() }
      ];

      const modalSpy = vi.fn();
      window.showMedicationConfirmModal = modalSpy;

      window.renderHistory(logs);
      const list = document.getElementById('history-list');
      expect(list.innerHTML).toContain('Aspirin');
      expect(list.innerHTML).toContain('Magnesium');
      expect(list.innerHTML).toContain('✅');
      expect(list.textContent).toContain('<b>Magnesium</b>');
      expect(list.innerHTML).not.toContain('<b>');

      const groups = list.querySelectorAll('.history-group');
      expect(groups.length).toBeGreaterThan(0);
      groups[1].click();

      expect(modalSpy).toHaveBeenCalled();
      expect(modalSpy.mock.calls[0][0]).toEqual([1, 2]);
      expect(modalSpy.mock.calls[0][3]).toBe('edit');
    } finally {
      cleanup();
    }
  });

  it('loadMeds handles cached/fresh/offline-fallback callbacks and refreshes medication list', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const cached = [{
        id: 10,
        name: 'Cached Med',
        dosage: '1',
        schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }),
        archived: false
      }];
      const fresh = [{
        id: 11,
        name: 'Fresh Med',
        dosage: '2',
        schedule: JSON.stringify({ type: 'daily', times: ['10:00'] }),
        archived: false
      }];
      const offline = [{
        id: 12,
        name: 'Offline Med',
        dosage: '3',
        schedule: JSON.stringify({ type: 'daily', times: ['11:00'] }),
        archived: false
      }];

      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onCached(cached);
        await options.onFresh(fresh);
        await options.onError(new Error('boom'), null);
      });

      window.MedTrackerDB = {
        MedicationStore: {
          saveCache: vi.fn().mockResolvedValue(undefined),
          getCache: vi.fn().mockResolvedValue(offline)
        }
      };

      window.apiCall = vi.fn(async (endpoint) => {
        if (endpoint.startsWith('/api/history?days=7')) return [];
        return [];
      });

      await window.loadMeds();

      expect(window.DataStore.loadSWR).toHaveBeenCalled();
      expect(window.MedTrackerDB.MedicationStore.saveCache).toHaveBeenCalledWith(fresh);
      expect(window.MedTrackerDB.MedicationStore.getCache).toHaveBeenCalled();
      expect(document.getElementById('med-list').innerHTML).toContain('Offline Med');
    } finally {
      cleanup();
    }
  });

  it('next intake trigger render/action behave correctly', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const container = document.getElementById('next-intake-trigger');
      const alertSpy = vi.fn();
      window.Telegram.WebApp.showAlert = alertSpy;

      window.DataStore.fetchFresh = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          scheduled_at: new Date().toISOString(),
          medication_names: ['<b>Aspirin</b>', 'Vitamin D']
        });

      await window.renderNextIntakeTrigger();
      expect(container.innerHTML).toBe('');

      await window.renderNextIntakeTrigger();
      expect(container.innerHTML).toContain('Next scheduled intake');
      expect(container.innerHTML).toContain('Take Now');
      expect(container.textContent).toContain('<b>Aspirin</b>, Vitamin D');
      expect(container.innerHTML).not.toContain('<b>');

      const triggerSpy = vi.spyOn(window, 'triggerNextIntake').mockResolvedValue(undefined);
      container.querySelector('button').click();
      expect(triggerSpy).toHaveBeenCalledTimes(1);
      triggerSpy.mockRestore();

      window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
      window.DataStore.invalidateKey = vi.fn().mockResolvedValue(undefined);
      const loadHistorySpy = vi.spyOn(window, 'loadHistory').mockResolvedValue(undefined);

      window.apiCall = vi
        .fn()
        .mockResolvedValueOnce({
          status: 'confirmed',
          medication_names: ['Aspirin'],
          scheduled_at: new Date().toISOString(),
          taken_at: new Date().toISOString()
        })
        .mockResolvedValueOnce(null); // null = apiCall handled the error internally

      await window.triggerNextIntake();
      expect(window.DataStore.invalidateTags).toHaveBeenCalledWith(['history', 'medications']);
      expect(window.DataStore.invalidateKey).toHaveBeenCalledWith('next_intake');
      expect(loadHistorySpy).toHaveBeenCalled();
      expect(alertSpy).toHaveBeenCalled();

      // apiCall returned null → no further action (no extra alert from triggerNextIntake)
      loadHistorySpy.mockClear();
      alertSpy.mockClear();
      await window.triggerNextIntake();
      expect(loadHistorySpy).not.toHaveBeenCalled();
      expect(alertSpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
