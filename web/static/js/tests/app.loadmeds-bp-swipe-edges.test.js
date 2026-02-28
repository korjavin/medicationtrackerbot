import { describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function makeTouchEvent(window, type, { x, y }) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  const point = { clientX: x, clientY: y };
  if (type === 'touchstart') {
    Object.defineProperty(event, 'touches', { configurable: true, value: [point] });
  } else {
    Object.defineProperty(event, 'changedTouches', { configurable: true, value: [point] });
  }
  return event;
}

describe('app.js loadMeds/BP/swipe edge branches', () => {
  it('wrapped loadMeds runs original loader and then refreshes weekly hub', async () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      window.renderMeds = vi.fn();
      window.populateMedFilter = vi.fn();
      window.renderWeeklyHub = vi.fn();
      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onCached([]);
      });

      await window.loadMeds();

      expect(window.DataStore.loadSWR).toHaveBeenCalled();
      expect(window.renderWeeklyHub).toHaveBeenCalledTimes(1);
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
      expect(alertSpy).toHaveBeenCalledWith('Please fill in all required fields');

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

  it('swipe navigation skips hidden tabs and ignores out-of-range swipes', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const tabs = Array.from(document.querySelectorAll('#tabs .tab'));
      tabs.forEach((tab) => tab.classList.remove('active'));

      tabs[1].style.display = 'none';
      tabs[0].classList.add('active');

      const visibleTabs = tabs.filter((tab) => tab.style.display !== 'none');
      const switchSpy = vi.fn();
      window.switchTab = switchSpy;

      document.body.dispatchEvent(makeTouchEvent(window, 'touchstart', { x: 320, y: 180 }));
      document.body.dispatchEvent(makeTouchEvent(window, 'touchend', { x: 220, y: 190 }));
      expect(switchSpy).toHaveBeenCalledWith(visibleTabs[1].dataset.tab);

      document.body.dispatchEvent(makeTouchEvent(window, 'touchstart', { x: 200, y: 180 }));
      document.body.dispatchEvent(makeTouchEvent(window, 'touchend', { x: 300, y: 185 }));
      expect(switchSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });
});
