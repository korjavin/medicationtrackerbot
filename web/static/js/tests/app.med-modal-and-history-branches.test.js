import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

async function seedMedications(window, meds) {
  window.DataStore.loadSWR = vi.fn(async (options) => {
    await options.onFresh(meds);
  });
  window.apiCall = vi.fn().mockResolvedValue([]);
  await window.loadMeds();
}

describe('app.js medication modal CRUD and history edge branches', () => {
  let consoleErrorSpy;
  let consoleLogSpy;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it('showAddModal resets modal inputs, schedule defaults and inventory sections', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      document.getElementById('med-name').value = 'filled';
      document.getElementById('med-track-inventory').checked = true;
      document.getElementById('inventory-fields').classList.remove('hidden');
      document.querySelectorAll('#days-container .days-select span').forEach((el) => el.classList.add('selected'));

      window.showAddModal();

      expect(document.getElementById('modal-overlay').classList.contains('hidden')).toBe(false);
      expect(document.getElementById('med-modal').classList.contains('hidden')).toBe(false);
      expect(document.getElementById('med-name').value).toBe('');
      expect(document.getElementById('schedule-type').value).toBe('daily');
      expect(document.getElementById('time-inputs').querySelectorAll('.med-time-input')).toHaveLength(1);
      expect(document.getElementById('inventory-fields').classList.contains('hidden')).toBe(true);
      expect(document.querySelectorAll('#days-container .days-select span.selected')).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('showEditModal renders inventory/rx/schedule branches and legacy schedule fallback', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      await seedMedications(window, [
        {
          id: 1,
          name: 'Tracked Med',
          dosage: '10mg',
          schedule: JSON.stringify({ type: 'weekly', times: ['08:00'], days: [1, 3] }),
          archived: false,
          inventory_count: 12,
          normalized_name: 'Tracked Med Rx',
          start_date: '2026-03-01T00:00:00Z',
          end_date: '2026-03-31T00:00:00Z'
        },
        {
          id: 2,
          name: 'Legacy Med',
          dosage: '5mg',
          schedule: '21:00',
          archived: false,
          inventory_count: null
        }
      ]);

      window.loadRestockHistory = vi.fn().mockResolvedValue(undefined);

      window.showEditModal(1);
      expect(document.getElementById('med-name').value).toBe('Tracked Med');
      expect(document.getElementById('med-rx-display').style.display).toBe('block');
      expect(document.getElementById('inventory-fields').classList.contains('hidden')).toBe(false);
      expect(window.loadRestockHistory).toHaveBeenCalledWith(1);
      expect(document.querySelectorAll('.days-select span.selected').length).toBeGreaterThan(0);

      window.showEditModal(2);
      expect(document.getElementById('schedule-type').value).toBe('daily');
      expect(document.getElementById('time-inputs').querySelector('.med-time-input').value).toBe('21:00');
      expect(document.getElementById('inventory-fields').classList.contains('hidden')).toBe(true);

      expect(() => window.showEditModal(999)).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('saveMedication validates inputs and supports create/update flows with invalidation', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const alertSpy = vi.fn();
      window.Telegram.WebApp.showAlert = alertSpy;

      window.showAddModal();
      document.getElementById('med-name').value = '';
      await window.saveMedication();
      expect(alertSpy).toHaveBeenCalledWith('Name is required!');

      document.getElementById('med-name').value = 'My Med';
      document.getElementById('schedule-type').value = 'daily';
      window.toggleScheduleFields();
      document.querySelectorAll('.med-time-input').forEach((input) => { input.value = ''; });
      await window.saveMedication();
      expect(alertSpy).toHaveBeenCalledWith('At least one time is required!');

      document.querySelector('.med-time-input').value = '09:00';
      document.getElementById('schedule-type').value = 'weekly';
      window.toggleScheduleFields();
      document.querySelectorAll('#days-container .days-select span').forEach((el) => el.classList.remove('selected'));
      await window.saveMedication();
      expect(alertSpy).toHaveBeenCalledWith('Select at least one day!');

      document.querySelector('#days-container .days-select span[data-day="1"]').classList.add('selected');
      document.getElementById('med-dosage').value = '20mg';
      document.getElementById('med-start-date').value = '2026-03-01';
      document.getElementById('med-end-date').value = '2026-03-31';
      document.getElementById('med-track-inventory').checked = true;
      document.getElementById('med-inventory-count').value = '40';

      window.apiCall = vi.fn().mockResolvedValue({ warning: 'duplicate schedule' });
      window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
      window.DataStore.invalidateKey = vi.fn().mockResolvedValue(undefined);
      window.closeModal = vi.fn();
      window.loadMeds = vi.fn();

      await window.saveMedication();
      expect(window.apiCall).toHaveBeenCalledWith('/api/medications', 'POST', expect.objectContaining({
        name: 'My Med',
        dosage: '20mg',
        inventory_count: 40,
        schedule: JSON.stringify({ type: 'weekly', times: ['09:00'], days: [1] })
      }));
      expect(alertSpy).toHaveBeenCalledWith('⚠️ duplicate schedule');
      expect(window.DataStore.invalidateTags).toHaveBeenCalledWith(['medications', 'history']);
      expect(window.DataStore.invalidateKey).toHaveBeenCalledWith('next_intake');
      expect(window.closeModal).toHaveBeenCalled();
      expect(window.loadMeds).toHaveBeenCalled();

      await seedMedications(window, [
        {
          id: 55,
          name: 'Editable',
          dosage: '2mg',
          schedule: JSON.stringify({ type: 'as_needed' }),
          archived: false
        }
      ]);
      window.showEditModal(55);
      document.getElementById('med-name').value = 'Editable Updated';
      document.getElementById('schedule-type').value = 'as_needed';
      window.apiCall = vi.fn().mockResolvedValue({});
      window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
      window.DataStore.invalidateKey = vi.fn().mockResolvedValue(undefined);
      window.closeModal = vi.fn();
      window.loadMeds = vi.fn();

      await window.saveMedication();
      expect(window.apiCall).toHaveBeenCalledWith('/api/medications/55', 'POST', expect.objectContaining({
        name: 'Editable Updated'
      }));
    } finally {
      cleanup();
    }
  });

  it('deleteMed and _archiveMedApi cover Telegram confirm fallback and archive warning path', async () => {
    const { window, cleanup } = loadFrontendEnv({ telegramInitData: 'token=abc' });

    try {
      await seedMedications(window, [
        {
          id: 1,
          name: 'Archive Me',
          dosage: '1mg',
          schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }),
          archived: false
        }
      ]);

      const archiveSpy = vi.spyOn(window, '_archiveMedApi').mockResolvedValue(undefined);
      window.Telegram.WebApp.showConfirm = vi.fn((_msg, cb) => cb(true));
      window.deleteMed(1);
      expect(archiveSpy).toHaveBeenCalledWith(1);

      window.Telegram.WebApp.showConfirm = vi.fn(() => { throw new Error('unsupported'); });
      window.confirm = vi.fn().mockReturnValue(true);
      window.deleteMed(1);
      expect(window.confirm).toHaveBeenCalledWith('Archive this medication?');

      archiveSpy.mockRestore();
      window.Telegram.WebApp.showAlert = vi.fn();
      window.apiCall = vi.fn().mockResolvedValue({ warning: 'already archived' });
      window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
      window.DataStore.invalidateKey = vi.fn().mockResolvedValue(undefined);
      window.loadMeds = vi.fn();

      await window._archiveMedApi(1);
      expect(window.apiCall).toHaveBeenCalledWith('/api/medications/1', 'POST', expect.objectContaining({
        archived: true
      }));
      expect(window.Telegram.WebApp.showAlert).toHaveBeenCalledWith('⚠️ already archived');
      expect(window.loadMeds).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('loadRestockHistory renders empty state and treats notes as plain text', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.apiCall = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { quantity: 3, restocked_at: '2026-03-02T10:00:00Z', note: '<img src=x onerror=1>' },
          { quantity: 1, restocked_at: '2026-03-03T10:00:00Z', note: '' }
        ]);

      const container = document.getElementById('restock-history');

      await window.loadRestockHistory(11);
      expect(container.textContent).toContain('No restock history');

      await window.loadRestockHistory(11);
      expect(container.textContent).toContain('Recent restocks:');
      expect(container.querySelectorAll('li')).toHaveLength(2);
      expect(container.textContent).toContain('<img src=x onerror=1>');
      expect(container.innerHTML).not.toContain('<img');
    } finally {
      cleanup();
    }
  });

  it('loadHistory triggers loadMeds when meds are empty and handles SWR callbacks', async () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      window.loadMeds = vi.fn().mockResolvedValue(undefined);
      window.renderHistory = vi.fn();
      window.renderNextIntakeTrigger = vi.fn();

      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onCached([{ id: 1 }]);
        await options.onFresh([]);
        await options.onError(new Error('history failed'), null);
      });

      await window.loadHistory();
      expect(window.loadMeds).toHaveBeenCalled();
      expect(window.DataStore.loadSWR).toHaveBeenCalled();
      expect(window.renderHistory).toHaveBeenCalledTimes(3);
      expect(window.renderNextIntakeTrigger).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });
});

describe('app.js weekly schedule day selection – regression tests', () => {
  // Day values: Sun=0, Mon=1, Tue=2, Wed=3, Thu=4, Fri=5, Sat=6
  const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

  function getSelectedDays(document) {
    return Array.from(
      document.querySelectorAll('#days-container .days-select span.selected')
    ).map((s) => parseInt(s.dataset.day, 10));
  }

  async function seedMedications(window, meds) {
    window.DataStore.loadSWR = vi.fn(async (options) => {
      await options.onFresh(meds);
    });
    window.apiCall = vi.fn().mockResolvedValue([]);
    await window.loadMeds();
  }

  it('showEditModal marks Saturday (day 6) when schedule has days:[6]', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      await seedMedications(window, [
        {
          id: 1,
          name: 'Sat Med',
          dosage: '10mg',
          schedule: JSON.stringify({ type: 'weekly', times: ['10:00'], days: [6] }),
          archived: false,
        },
      ]);
      window.loadRestockHistory = vi.fn().mockResolvedValue(undefined);
      window.showEditModal(1);

      const satSpan = document.querySelector('#days-container .days-select span[data-day="6"]');
      expect(satSpan).not.toBeNull();
      expect(satSpan.classList.contains('selected')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('showEditModal marks exactly the scheduled days and no others', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      // Test each individual day
      for (const day of ALL_DAYS) {
        await seedMedications(window, [
          {
            id: day + 10,
            name: `Med day ${day}`,
            dosage: '5mg',
            schedule: JSON.stringify({ type: 'weekly', times: ['08:00'], days: [day] }),
            archived: false,
          },
        ]);
        window.loadRestockHistory = vi.fn().mockResolvedValue(undefined);
        window.showEditModal(day + 10);

        const selected = getSelectedDays(document);
        expect(selected).toEqual([day]);

        // Confirm the specific day span has 'selected', others don't
        for (const other of ALL_DAYS) {
          const span = document.querySelector(
            `#days-container .days-select span[data-day="${other}"]`
          );
          expect(span).not.toBeNull();
          if (other === day) {
            expect(span.classList.contains('selected')).toBe(true);
          } else {
            expect(span.classList.contains('selected')).toBe(false);
          }
        }
      }
    } finally {
      cleanup();
    }
  });

  it('showEditModal marks multiple days including Saturday correctly', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      await seedMedications(window, [
        {
          id: 1,
          name: 'Multi Med',
          dosage: '5mg',
          schedule: JSON.stringify({ type: 'weekly', times: ['09:00'], days: [1, 3, 6] }), // Mon, Wed, Sat
          archived: false,
        },
      ]);
      window.loadRestockHistory = vi.fn().mockResolvedValue(undefined);
      window.showEditModal(1);

      const selected = getSelectedDays(document).sort((a, b) => a - b);
      expect(selected).toEqual([1, 3, 6]);
    } finally {
      cleanup();
    }
  });

  it('saveMedication collects days only from #days-container, not workout modal spans', async () => {
    // Regression: .days-select span.selected (unscoped) could pick up workout group
    // modal spans. The fix scopes the selector to #days-container.
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      window.showAddModal();
      document.getElementById('med-name').value = 'Sat Only Med';
      document.getElementById('med-dosage').value = '10mg';
      document.getElementById('schedule-type').value = 'weekly';
      window.toggleScheduleFields();

      // Select Saturday in the medication modal
      document.querySelector('#days-container .days-select span[data-day="6"]').classList.add('selected');

      // Simulate workout group modal having Monday selected (stale state from a prior interaction)
      document.querySelector('#workout-group-modal .days-select span[data-day="1"]').classList.add('selected');

      document.querySelector('.med-time-input').value = '10:00';

      const alertSpy = vi.fn();
      window.Telegram.WebApp.showAlert = alertSpy;
      window.apiCall = vi.fn().mockResolvedValue({});
      window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
      window.DataStore.invalidateKey = vi.fn().mockResolvedValue(undefined);
      window.closeModal = vi.fn();
      window.loadMeds = vi.fn();

      await window.saveMedication();

      expect(window.apiCall).toHaveBeenCalledWith(
        '/api/medications',
        'POST',
        expect.objectContaining({
          schedule: JSON.stringify({ type: 'weekly', times: ['10:00'], days: [6] }),
        })
      );
    } finally {
      cleanup();
    }
  });
});
