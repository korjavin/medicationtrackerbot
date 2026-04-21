import { describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('app.js UI characterization', () => {
  it('switchTab activates target view and triggers matching loader', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const loadSettingsSpy = vi.fn();
      window.loadSettings = loadSettingsSpy;

      window.switchTab('settings');

      expect(document.getElementById('settings-view').classList.contains('active')).toBe(true);
      expect(loadSettingsSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('switchMedTab toggles med subtab classes and calls the right loader', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const loadMedsSpy = vi.fn();
      const loadHistorySpy = vi.fn();
      window.loadMeds = loadMedsSpy;
      window.loadHistory = loadHistorySpy;

      window.switchMedTab('schedule');

      expect(document.querySelector('.med-tab[data-tab="schedule"]').classList.contains('active')).toBe(true);
      expect(document.getElementById('med-schedule-tab').classList.contains('active')).toBe(true);
      expect(loadMedsSpy).toHaveBeenCalledTimes(1);

      window.switchMedTab('history');
      expect(document.querySelector('.med-tab[data-tab="history"]').classList.contains('active')).toBe(true);
      expect(loadHistorySpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('med tab click binding switches subtab and triggers loader', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const loadMedsSpy = vi.fn();
      window.loadMeds = loadMedsSpy;

      const scheduleTab = document.querySelector('.med-tab[data-tab="schedule"]');
      scheduleTab.click();

      expect(scheduleTab.classList.contains('active')).toBe(true);
      expect(document.getElementById('med-schedule-tab').classList.contains('active')).toBe(true);
      expect(loadMedsSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('BP and weight controls open/close modals via JS click bindings', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const overlay = document.getElementById('modal-overlay');
      const bpModal = document.getElementById('bp-modal');
      const weightModal = document.getElementById('weight-modal');

      expect(overlay.classList.contains('hidden')).toBe(true);
      expect(bpModal.classList.contains('hidden')).toBe(true);
      expect(weightModal.classList.contains('hidden')).toBe(true);

      document.getElementById('add-bp-btn').click();

      expect(overlay.classList.contains('hidden')).toBe(false);
      expect(bpModal.classList.contains('hidden')).toBe(false);
      expect(document.getElementById('bp-datetime').value).not.toBe('');

      document.getElementById('bp-modal-cancel-btn').click();
      expect(overlay.classList.contains('hidden')).toBe(true);
      expect(bpModal.classList.contains('hidden')).toBe(true);

      document.getElementById('add-weight-btn').click();
      expect(weightModal.classList.contains('hidden')).toBe(false);

      document.getElementById('weight-modal-cancel-btn').click();
      expect(weightModal.classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('toggleFeatureSetting persists the setting and invalidates settings tags', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      const invalidateSpy = vi.fn().mockResolvedValue(undefined);
      const apiCallSpy = vi.fn().mockResolvedValue({ ok: true });

      window.DataStore.invalidateTags = invalidateSpy;
      window.apiCall = apiCallSpy;

      await window.toggleFeatureSetting('bp', false);
      expect(window.AppStore.get('featureSettings').bp).toBe(false);
      expect(invalidateSpy).toHaveBeenCalledWith(['settings', 'feature_settings']);

      await window.toggleFeatureSetting('bp', true);
      expect(window.AppStore.get('featureSettings').bp).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('medication controls are wired via JS listeners instead of inline handlers', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const modal = document.getElementById('med-modal');
      expect(modal.classList.contains('hidden')).toBe(true);

      document.getElementById('add-btn').click();
      expect(modal.classList.contains('hidden')).toBe(false);

      const scheduleType = document.getElementById('schedule-type');
      scheduleType.value = 'weekly';
      scheduleType.dispatchEvent(new window.Event('change', { bubbles: true }));
      expect(document.getElementById('days-container').classList.contains('hidden')).toBe(false);

      const monday = document.querySelector('#days-container .days-select span[data-day="1"]');
      monday.click();
      expect(monday.classList.contains('selected')).toBe(true);

      const loadHistorySpy = vi.spyOn(window, 'loadHistory').mockImplementation(() => {});
      document.getElementById('history-filter-days').dispatchEvent(new window.Event('change', { bubbles: true }));
      expect(loadHistorySpy).toHaveBeenCalled();

      document.getElementById('med-modal-cancel-btn').click();
      expect(modal.classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('food controls are wired via JS listeners and toggle period/modal states', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const showFoodModalSpy = vi.spyOn(window, 'showAddFoodModal').mockImplementation(() => {});
      const closeFoodModalSpy = vi.spyOn(window, 'closeFoodModal').mockImplementation(() => {});
      window.setFoodStatsPeriod = vi.fn();

      // Add-food CTA is rendered dynamically at the end of the meal list.
      window._renderFoodData([], null, 'day', '2026-04-20');
      document.getElementById('add-food-btn').click();
      expect(showFoodModalSpy).toHaveBeenCalled();

      document.getElementById('food-period-week-link').click();
      expect(window.setFoodStatsPeriod).toHaveBeenCalledWith('week');

      document.getElementById('food-modal-cancel-btn').click();
      expect(closeFoodModalSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
