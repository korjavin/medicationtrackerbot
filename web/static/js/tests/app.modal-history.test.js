import { describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function flushMutations() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('app.js modal history and back behavior', () => {
  it('pushes history when overlay becomes visible and goes back on close', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const pushStateSpy = vi.spyOn(window.history, 'pushState');
      const backSpy = vi.spyOn(window.history, 'back');

      window.showBPRecordModal();
      await flushMutations();

      expect(document.getElementById('modal-overlay').classList.contains('hidden')).toBe(false);
      expect(pushStateSpy).toHaveBeenCalled();

      window.closeBPRecordModal();
      await flushMutations();

      expect(document.getElementById('modal-overlay').classList.contains('hidden')).toBe(true);
      expect(backSpy).toHaveBeenCalled();
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
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.ModalManager.weight.open();
      await flushMutations();

      expect(document.getElementById('weight-modal').classList.contains('hidden')).toBe(false);

      window.dispatchEvent(new window.PopStateEvent('popstate'));
      await flushMutations();

      expect(document.getElementById('weight-modal').classList.contains('hidden')).toBe(true);
      expect(document.getElementById('modal-overlay').classList.contains('hidden')).toBe(true);
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

  // Regression for the messenger-adapter plan: modal-history.js used to read
  // the host SDK's BackButton directly to show/hide on overlay transitions.
  // All back-button toggling now goes through window.MessengerAdapter. Spy
  // on the adapter to lock in that the overlay-driven show/hide chain
  // delegates through the adapter.
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

  function pressEsc(window) {
    const e = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.document.body.dispatchEvent(e);
    return e;
  }

  // med-xso6.8: Plan → Day → Exercise shaped pushed pages. Each Back (popstate,
  // Esc, the page-bar chevron) closes exactly the topmost page; the overlay
  // stays until the last one goes.
  it('nested WGPages close one per popstate / Esc / Back chevron; overlay hides with the last', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const overlay = document.getElementById('modal-overlay');
      const backSpy = vi.spyOn(window.history, 'back');
      const titles = () => [...document.querySelectorAll('mt-modal.wg-page .wg-pagebar__title')].map((t) => t.textContent);

      window.WGPage.push({ title: 'Plan', back: 'Train', primary: { label: 'Save', onClick: () => {} } });
      window.WGPage.push({ title: 'Day A', crumb: 'Plan 3', back: 'Plan', primary: { label: 'Done', onClick: () => {} } });
      window.WGPage.push({ title: 'Squat', crumb: 'Plan 3 · Day A', back: 'Day A' });
      await flushMutations();
      expect(titles()).toEqual(['Plan', 'Day A', 'Squat']);
      expect(overlay.classList.contains('hidden')).toBe(false);

      window.dispatchEvent(new window.PopStateEvent('popstate'));
      await flushMutations();
      expect(titles()).toEqual(['Plan', 'Day A']);
      expect(overlay.classList.contains('hidden')).toBe(false);

      expect(pressEsc(window).defaultPrevented).toBe(true);
      await flushMutations();
      expect(titles()).toEqual(['Plan']);
      expect(overlay.classList.contains('hidden')).toBe(false);
      expect(backSpy).not.toHaveBeenCalled();

      document.querySelector('mt-modal.wg-page .wg-back').click();
      await flushMutations();
      expect(titles()).toEqual([]);
      expect(overlay.classList.contains('hidden')).toBe(true);
      expect(backSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('a page whose onBack returns false stays open on Esc', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const onBack = vi.fn(() => false);
      const page = window.WGPage.push({ title: 'Edit day', onBack });
      pressEsc(window);
      await flushMutations();
      expect(onBack).toHaveBeenCalledTimes(1);
      expect(document.querySelector('mt-modal.wg-page')).not.toBeNull();
      page.close();
      expect(document.querySelector('mt-modal.wg-page')).toBeNull();
      expect(document.getElementById('modal-overlay').classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  // med-xso6.34: Esc closes every modal, topmost first — sub-modal before its parent.
  it('Esc closes the topmost modal only: food product, then the food modal', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    // Closing the food modal stops the scanner's <video>; jsdom has no pause().
    const pauseSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    try {
      window.ModalManager.food.open();
      window.ModalManager.foodProduct.open();
      await flushMutations();

      pressEsc(window);
      await flushMutations();
      expect(document.getElementById('food-product-modal').classList.contains('hidden')).toBe(true);
      expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(false);
      expect(document.getElementById('modal-overlay').classList.contains('hidden')).toBe(false);

      pressEsc(window);
      await flushMutations();
      expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(true);
      expect(document.getElementById('modal-overlay').classList.contains('hidden')).toBe(true);
    } finally {
      pauseSpy.mockRestore();
      cleanup();
    }
  });

  it('Esc over an in-page dialog cancels just the dialog, not the modal under it', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      window.ModalManager.weight.open();
      const answer = window.safeConfirm('Discard?');
      await flushMutations();
      expect(document.querySelector('mt-modal.mt-confirm-modal')).not.toBeNull();

      pressEsc(window);
      await expect(answer).resolves.toBe(false);
      await flushMutations();
      expect(document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
      expect(document.getElementById('weight-modal').classList.contains('hidden')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('Esc closes a modal opened outside ModalManager (Settings invite)', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const invite = document.getElementById('invite-modal');
      invite.open();
      pressEsc(window);
      expect(invite.classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

});
