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

describe('app.js swipe navigation and test notification flows', () => {
  it('sendTestMedicationNotification shows success, server error and network error alerts', async () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const alertSpy = vi.fn();
      window.Telegram.WebApp.showAlert = alertSpy;

      window.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        async text() { return 'sent'; }
      });

      await window.sendTestMedicationNotification();
      expect(alertSpy).toHaveBeenLastCalledWith('sent');

      window.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        async text() { return 'bad request'; }
      });
      await window.sendTestMedicationNotification();
      expect(alertSpy).toHaveBeenLastCalledWith('Error: bad request');

      window.fetch = vi.fn().mockRejectedValueOnce(new Error('offline'));
      await window.sendTestMedicationNotification();
      expect(alertSpy).toHaveBeenLastCalledWith('Error sending test notification: offline');
      consoleErrorSpy.mockRestore();
    } finally {
      cleanup();
    }
  });

  it('swipe navigation switches tabs left/right and ignores invalid gestures', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const visibleTabs = Array.from(document.querySelectorAll('#tabs .tab'))
        .filter((tab) => tab.style.display !== 'none');
      visibleTabs.forEach((tab) => tab.classList.remove('active'));
      visibleTabs[1].classList.add('active');
      const activeIndex = 1;

      const switchSpy = vi.fn();
      window.switchTab = switchSpy;

      const touchStart = makeTouchEvent(window, 'touchstart', { x: 300, y: 200 });
      document.body.dispatchEvent(touchStart);
      const swipeLeft = makeTouchEvent(window, 'touchend', { x: 200, y: 210 });
      document.body.dispatchEvent(swipeLeft);
      expect(switchSpy).toHaveBeenCalledWith(visibleTabs[activeIndex + 1].dataset.tab);

      const touchStart2 = makeTouchEvent(window, 'touchstart', { x: 200, y: 200 });
      document.body.dispatchEvent(touchStart2);
      const swipeRight = makeTouchEvent(window, 'touchend', { x: 290, y: 205 });
      document.body.dispatchEvent(swipeRight);
      expect(switchSpy).toHaveBeenCalledWith(visibleTabs[activeIndex - 1].dataset.tab);

      const touchStartSmall = makeTouchEvent(window, 'touchstart', { x: 200, y: 200 });
      document.body.dispatchEvent(touchStartSmall);
      const tooShort = makeTouchEvent(window, 'touchend', { x: 170, y: 205 });
      document.body.dispatchEvent(tooShort);

      const touchStartVertical = makeTouchEvent(window, 'touchstart', { x: 200, y: 200 });
      document.body.dispatchEvent(touchStartVertical);
      const tooVertical = makeTouchEvent(window, 'touchend', { x: 120, y: 320 });
      document.body.dispatchEvent(tooVertical);

      expect(switchSpy.mock.calls.length).toBe(2);

      const medInput = document.getElementById('med-name');
      const touchStartInput = makeTouchEvent(window, 'touchstart', { x: 300, y: 120 });
      medInput.dispatchEvent(touchStartInput);
      const swipeOnInput = makeTouchEvent(window, 'touchend', { x: 200, y: 120 });
      medInput.dispatchEvent(swipeOnInput);
      expect(switchSpy.mock.calls.length).toBe(2);
    } finally {
      cleanup();
    }
  });
});
