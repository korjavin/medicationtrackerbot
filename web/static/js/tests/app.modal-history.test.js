import { describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function flushMutations() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('app.js modal history and back behavior', () => {
  it('pushes history and shows Telegram BackButton when overlay becomes visible', async () => {
    const { window, document, backButtonState, cleanup } = loadFrontendEnv();

    try {
      const pushStateSpy = vi.spyOn(window.history, 'pushState');
      const backSpy = vi.spyOn(window.history, 'back');

      window.showBPRecordModal();
      await flushMutations();

      expect(document.getElementById('modal-overlay').classList.contains('hidden')).toBe(false);
      expect(pushStateSpy).toHaveBeenCalled();
      expect(backButtonState.showCalls).toBeGreaterThan(0);

      window.closeBPRecordModal();
      await flushMutations();

      expect(document.getElementById('modal-overlay').classList.contains('hidden')).toBe(true);
      expect(backSpy).toHaveBeenCalled();
      expect(backButtonState.hideCalls).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it('popstate closes topmost modal when modal history is active', async () => {
    const { window, document, backButtonState, cleanup } = loadFrontendEnv();

    try {
      window.showWeightModal();
      await flushMutations();

      expect(document.getElementById('weight-modal').classList.contains('hidden')).toBe(false);

      window.dispatchEvent(new window.PopStateEvent('popstate'));
      await flushMutations();

      expect(document.getElementById('weight-modal').classList.contains('hidden')).toBe(true);
      expect(document.getElementById('modal-overlay').classList.contains('hidden')).toBe(true);
      expect(backButtonState.hideCalls).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it('Telegram BackButton callback closes open modal', async () => {
    const { window, document, backButtonState, cleanup } = loadFrontendEnv();

    try {
      expect(typeof backButtonState.clickHandler).toBe('function');

      window.showAddModal();
      await flushMutations();
      expect(document.getElementById('med-modal').classList.contains('hidden')).toBe(false);

      backButtonState.clickHandler();
      await flushMutations();

      expect(document.getElementById('med-modal').classList.contains('hidden')).toBe(true);
      expect(document.getElementById('modal-overlay').classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });
});
