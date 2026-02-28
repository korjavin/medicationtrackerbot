import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('app.js food CRUD, targets and period helpers', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('saveFoodLog validates required inputs and handles create/update/error branches', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.safeAlert = vi.fn();

      document.getElementById('food-datetime').value = '';
      await window.saveFoodLog();
      expect(window.safeAlert).toHaveBeenCalledWith('Please enter date.');

      document.getElementById('food-datetime').value = '2026-03-01T12:00';
      document.getElementById('food-weight').value = '';
      document.getElementById('food-per-100g').checked = true;
      await window.saveFoodLog();
      expect(window.safeAlert).toHaveBeenCalledWith('Please enter weight for per 100g mode, or uncheck it.');

      document.getElementById('food-name').value = 'Oats';
      document.getElementById('food-barcode').value = '123';
      document.getElementById('food-weight').value = '50';
      document.getElementById('food-carbs').value = '30';
      document.getElementById('food-protein').value = '10';
      document.getElementById('food-fat').value = '5';
      document.getElementById('food-calories').value = '205';
      document.getElementById('food-per-100g').checked = false;
      document.getElementById('food-id').value = '';

      const apiCallSpy = vi.fn().mockResolvedValue({ ok: true });
      window.apiCall = apiCallSpy;
      window.closeFoodModal = vi.fn();
      window.loadFoodLogs = vi.fn();

      await window.saveFoodLog();
      expect(apiCallSpy).toHaveBeenCalledWith('/api/food/log', 'POST', expect.objectContaining({
        name: 'Oats',
        barcode: '123',
        weight: 50,
        per_100g: false
      }));
      expect(window.closeFoodModal).toHaveBeenCalled();
      expect(window.loadFoodLogs).toHaveBeenCalled();

      document.getElementById('food-id').value = '77';
      await window.saveFoodLog();
      expect(apiCallSpy).toHaveBeenCalledWith('/api/food/log/77', 'PUT', expect.any(Object));

      window.apiCall = vi.fn().mockRejectedValue(new Error('save failed'));
      await window.saveFoodLog();
      expect(window.safeAlert).toHaveBeenCalledWith('Failed to save food log.');
    } finally {
      cleanup();
    }
  });

  it('loadFoodTargets and saveFoodTargets cover cache/network success and failure flows', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const setCachedSpy = vi.fn().mockResolvedValue(undefined);
      const invalidateSpy = vi.fn().mockResolvedValue(undefined);
      window.DataStore.getCached = vi.fn().mockResolvedValue({ calories: 1500, carbs: 160, protein: 110, fat: 55 });
      window.DataStore.setCached = setCachedSpy;
      window.DataStore.invalidateTags = invalidateSpy;

      window.apiCall = vi.fn(async (endpoint) => {
        if (endpoint === '/api/food/settings/targets') {
          return { calories: 1700, carbs: 180, protein: 120, fat: 60 };
        }
        return { ok: true };
      });

      await window.loadFoodTargets();
      expect(document.getElementById('food-target-calories').value).toBe('1700');
      expect(document.getElementById('food-target-carbs').value).toBe('180');
      expect(document.getElementById('food-target-protein').value).toBe('120');
      expect(document.getElementById('food-target-fat').value).toBe('60');
      expect(setCachedSpy).toHaveBeenCalledWith('food_targets', expect.any(Object));

      window.safeAlert = vi.fn();
      window.loadFoodLogs = vi.fn();
      document.querySelectorAll('#tabs .tab').forEach((tab) => tab.classList.remove('active'));
      document.querySelector('#tabs .tab[data-tab="food"]').classList.add('active');

      document.getElementById('food-target-calories').value = '1900';
      document.getElementById('food-target-carbs').value = '200';
      document.getElementById('food-target-protein').value = '130';
      document.getElementById('food-target-fat').value = '70';
      window.apiCall = vi.fn().mockResolvedValue({ ok: true });

      await window.saveFoodTargets();
      expect(window.apiCall).toHaveBeenCalledWith('/api/food/settings/targets', 'POST', {
        calories: 1900,
        carbs: 200,
        protein: 130,
        fat: 70
      });
      expect(invalidateSpy).toHaveBeenCalledWith(['settings', 'food_targets']);
      expect(window.safeAlert).toHaveBeenCalledWith('Food targets saved');
      expect(window.loadFoodLogs).toHaveBeenCalled();

      window.apiCall = vi.fn().mockRejectedValue(new Error('targets failed'));
      await window.saveFoodTargets();
      expect(window.safeAlert).toHaveBeenCalledWith('Failed to save food targets');
    } finally {
      cleanup();
    }
  });

  it('deleteFoodLog, setFoodStatsPeriod and shiftFoodDate handle confirm, errors and period stepping', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.apiCall = vi.fn().mockResolvedValue({ ok: true });
      window.loadFoodLogs = vi.fn();
      window.safeAlert = vi.fn();

      window.confirm = vi.fn().mockReturnValue(false);
      await window.deleteFoodLog(5);
      expect(window.apiCall).not.toHaveBeenCalled();

      window.confirm = vi.fn().mockReturnValue(true);
      await window.deleteFoodLog(6);
      expect(window.apiCall).toHaveBeenCalledWith('/api/food/log/6', 'DELETE');
      expect(window.loadFoodLogs).toHaveBeenCalled();

      window.apiCall = vi.fn().mockRejectedValue(new Error('delete failed'));
      await window.deleteFoodLog(7);
      expect(window.safeAlert).toHaveBeenCalledWith('Failed to delete.');

      window.loadFoodLogs = vi.fn();
      window.setFoodStatsPeriod('week');
      expect(window.loadFoodLogs).toHaveBeenCalled();
      expect(document.querySelector('#food-stats-period-container .period-link[data-period="week"]').classList.contains('active')).toBe(true);

      const dateFilter = document.getElementById('food-date-filter');
      dateFilter.value = '2026-03-01';
      window.loadFoodLogs.mockClear();
      window.shiftFoodDate(1);
      expect(dateFilter.value).toBe('2026-03-08');
      expect(window.loadFoodLogs).toHaveBeenCalledTimes(1);

      window.setFoodStatsPeriod('day');
      window.loadFoodLogs.mockClear();
      window.shiftFoodDate(-1);
      expect(dateFilter.value).toBe('2026-03-07');
      expect(window.loadFoodLogs).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('food modal add/edit flows and _renderFoodData support empty and populated states', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.initFoodProductsCache = vi.fn().mockResolvedValue(undefined);
      window.renderFoodAutocomplete = vi.fn();

      window.showAddFoodModal();
      await flushPromises();
      expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(false);
      expect(document.getElementById('food-modal-title').innerText).toBe('Log Food');
      expect(document.getElementById('food-per-100g').checked).toBe(true);
      expect(window.initFoodProductsCache).toHaveBeenCalled();

      window._renderFoodData([], null, 'day', '2026-03-01');
      expect(document.getElementById('food-list').innerHTML).toContain('No food logs for this day');

      const groups = [
        {
          name: 'Lunch',
          time: '13:00',
          calories: 500,
          carbs: 50,
          protein: 30,
          fat: 15,
          logs: [
            {
              id: 1,
              name: 'Rice Bowl',
              barcode: '111',
              weight: 250,
              carbs: 70,
              protein: 20,
              fat: 8,
              calories: 450,
              eaten_at: '2026-03-01T13:00:00Z'
            },
            {
              id: 2,
              name: '<b>Tea</b>',
              barcode: '222',
              weight: 0,
              carbs: 0,
              protein: 0,
              fat: 0,
              calories: 5,
              eaten_at: '2026-03-01T13:30:00Z'
            }
          ]
        }
      ];

      window._renderFoodData(groups, { calories: 500, carbs: 50, protein: 30, fat: 15 }, 'day', '2026-03-01');
      expect(document.getElementById('food-list').innerHTML).toContain('Rice Bowl');
      expect(document.getElementById('food-list').textContent).toContain('<b>Tea</b>');
      expect(document.getElementById('food-list').innerHTML).not.toContain('<b>');
      expect(document.getElementById('food-summary').innerHTML).toContain('Daily Total');

      window.editFoodLog(1);
      expect(document.getElementById('food-modal-title').innerText).toBe('Edit Food');
      expect(document.getElementById('food-per-100g').checked).toBe(true);

      window.editFoodLog(2);
      expect(document.getElementById('food-per-100g').checked).toBe(false);
      expect(document.getElementById('food-calories').value).toBe('5');

      window.editFoodLog(99999);
      const scannerVideo = document.getElementById('food-scanner-video');
      scannerVideo.pause = vi.fn();
      scannerVideo.srcObject = null;
      window.closeFoodModal();
      await flushPromises();
      expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });
});
