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

  it('BP modal Cancel button click closes the modal', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.showBPRecordModal();
      await flushMutations();

      const modal = document.getElementById('bp-modal');
      expect(modal.classList.contains('hidden')).toBe(false);

      document.getElementById('bp-modal-cancel-btn').click();
      await flushMutations();

      expect(modal.classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('popstate closes topmost modal when modal history is active', async () => {
    const { window, document, backButtonState, cleanup } = loadFrontendEnv();

    try {
      window.ModalManager.weight.open();
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

  it('popstate also closes food modal opened via modal manager API', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    let pauseSpy;

    try {
      pauseSpy = vi
        .spyOn(window.HTMLMediaElement.prototype, 'pause')
        .mockImplementation(() => {});
      window.ModalManager.food.open();
      await flushMutations();
      expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(false);

      window.dispatchEvent(new window.PopStateEvent('popstate'));
      await flushMutations();

      expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(true);
      expect(document.getElementById('modal-overlay').classList.contains('hidden')).toBe(true);
    } finally {
      if (pauseSpy) pauseSpy.mockRestore();
      cleanup();
    }
  });

  it('popstate closes food product sub-modal before parent food modal', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.ModalManager.food.open();
      window.ModalManager.foodProduct.open();
      await flushMutations();

      expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(false);
      expect(document.getElementById('food-product-modal').classList.contains('hidden')).toBe(false);

      window.dispatchEvent(new window.PopStateEvent('popstate'));
      await flushMutations();

      expect(document.getElementById('food-product-modal').classList.contains('hidden')).toBe(true);
      expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(false);
      expect(document.getElementById('modal-overlay').classList.contains('hidden')).toBe(false);
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

  // Regression for Task 3 of the messenger-adapter plan: modal-history.js used
  // to read window.Telegram.WebApp.BackButton directly to show/hide on overlay
  // transitions. After migration, all back-button toggling goes through
  // window.MessengerAdapter. Spy on the adapter to lock in that the
  // overlay-driven show/hide chain delegates through the adapter, not the
  // raw Telegram SDK.
  it('drives BackButton via window.MessengerAdapter when the overlay toggles', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      const showSpy = vi.spyOn(window.MessengerAdapter, 'showBack');
      const hideSpy = vi.spyOn(window.MessengerAdapter, 'hideBack');

      window.showBPRecordModal();
      await flushMutations();
      expect(showSpy).toHaveBeenCalled();

      window.closeBPRecordModal();
      await flushMutations();
      expect(hideSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('skips Telegram BackButton show/hide wiring on unsupported WebApp versions', async () => {
    const { window, document, backButtonState, cleanup } = loadFrontendEnv({ telegramVersion: '6.0' });

    try {
      window.showBPRecordModal();
      await flushMutations();
      expect(document.getElementById('bp-modal').classList.contains('hidden')).toBe(false);
      expect(backButtonState.showCalls).toBe(0);
      expect(backButtonState.clickHandler).toBeNull();

      window.closeBPRecordModal();
      await flushMutations();
      expect(document.getElementById('bp-modal').classList.contains('hidden')).toBe(true);
      expect(backButtonState.hideCalls).toBe(0);
    } finally {
      cleanup();
    }
  });
});
