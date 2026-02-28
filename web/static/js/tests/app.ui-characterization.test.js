import { describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('app.js UI characterization', () => {
  it('switchTab activates target tab/view and triggers matching loader', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const loadSettingsSpy = vi.fn();
      window.loadSettings = loadSettingsSpy;

      window.switchTab('settings');

      expect(document.querySelector('.tab[data-tab="settings"]').classList.contains('active')).toBe(true);
      expect(document.getElementById('settings-view').classList.contains('active')).toBe(true);
      expect(loadSettingsSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('main tab click binding switches view without inline onclick handlers', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const loadSettingsSpy = vi.fn();
      window.loadSettings = loadSettingsSpy;

      const settingsTab = document.querySelector('.tab[data-tab="settings"]');
      settingsTab.click();

      expect(settingsTab.classList.contains('active')).toBe(true);
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

  it('opens and closes BP modal with shared overlay', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const overlay = document.getElementById('modal-overlay');
      const modal = document.getElementById('bp-modal');

      expect(overlay.classList.contains('hidden')).toBe(true);
      expect(modal.classList.contains('hidden')).toBe(true);

      window.showBPRecordModal();

      expect(overlay.classList.contains('hidden')).toBe(false);
      expect(modal.classList.contains('hidden')).toBe(false);
      expect(document.getElementById('bp-datetime').value).not.toBe('');

      window.closeBPRecordModal();
      expect(overlay.classList.contains('hidden')).toBe(true);
      expect(modal.classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('toggleFeatureSetting updates tab visibility and invalidates settings tags', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const invalidateSpy = vi.fn().mockResolvedValue(undefined);
      const apiCallSpy = vi.fn().mockResolvedValue({ ok: true });
      const loadMedsSpy = vi.fn();
      const loadHistorySpy = vi.fn();

      window.DataStore.invalidateTags = invalidateSpy;
      window.apiCall = apiCallSpy;
      window.loadMeds = loadMedsSpy;
      window.loadHistory = loadHistorySpy;

      await window.toggleFeatureSetting('bp', false);
      expect(document.querySelector('.tab[data-tab="bp"]').style.display).toBe('none');
      expect(invalidateSpy).toHaveBeenCalledWith(['settings', 'feature_settings']);

      await window.toggleFeatureSetting('bp', true);
      expect(document.querySelector('.tab[data-tab="bp"]').style.display).toBe('inline-block');
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
});
