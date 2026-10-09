// Post-AI-log feedback (med-xso6.5): showFoodPhotoSummary renders the
// standard kit toast, not a floating card.
//   1. One .wg-toast.wg-toast--ok in the .wg-toasts stack: "N items logged",
//      detail "<kcal> kcal · from photo|description[ · N failed]".
//   2. Undo fires onUndo exactly once and the toast leaves.
//   3. showRemoved / showError swap the toast; showError's Retry action
//      runs the retry handler.
//   4. Auto-dismiss after the configured delay; dismiss() is idempotent.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

const SAMPLE_ITEMS = [
    { id: 11, name: 'Oatmeal',     weight: 80, carbs: 50, protein: 10, fat: 5,  calories: 280 },
    { id: 12, name: 'Banana',      weight: 120, carbs: 27, protein: 1,  fat: 0,  calories: 105 },
    { id: 13, name: 'Almond milk', weight: 200, carbs: 2,  protein: 1,  fat: 2,  calories: 30  },
];

describe('showFoodPhotoSummary — the standard toast', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ withSync: true });
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    const toastText = (doc) => doc.querySelector('.wg-food-photo-summary .wg-toast__text');

    it('exposes showFoodPhotoSummary as a global function (loaded before food.js)', () => {
        expect(typeof env.window.showFoodPhotoSummary).toBe('function');
    });

    it('renders one ok toast with the item count and the kcal total — no floating card', () => {
        const { document, window } = env;
        window.showFoodPhotoSummary({ items: SAMPLE_ITEMS, autoDismissMs: 0 });

        const toast = document.querySelector('.wg-toasts > .wg-toast.wg-food-photo-summary');
        expect(toast).not.toBeNull();
        expect(toast.classList.contains('wg-toast--ok')).toBe(true);
        expect(toast.getAttribute('role')).toBe('status');
        // 280 + 105 + 30 = 415 kcal
        expect(toastText(document).textContent).toBe('3 items logged415 kcal · from photo');
        expect(toastText(document).querySelector('small').textContent).toBe('415 kcal · from photo');
    });

    it('singular count, description source, and the failed suffix', () => {
        const { document, window } = env;
        window.showFoodPhotoSummary({ items: [SAMPLE_ITEMS[0]], autoDismissMs: 0 });
        expect(toastText(document).firstChild.textContent).toBe('1 item logged');

        // A second log replaces nothing it doesn't own: the first toast stays
        // its own toast in the stack.
        window.showFoodPhotoSummary({ items: SAMPLE_ITEMS.slice(0, 2), failed: 1, source: 'description', autoDismissMs: 0 });
        const smalls = [...document.querySelectorAll('.wg-food-photo-summary small')].map((el) => el.textContent);
        expect(smalls[1]).toBe('385 kcal · from description · 1 failed');
    });

    it('Undo fires onUndo exactly once and the toast leaves', async () => {
        const { document, window } = env;
        const onUndo = vi.fn().mockResolvedValue(undefined);
        window.showFoodPhotoSummary({ items: SAMPLE_ITEMS, onUndo, autoDismissMs: 0 });

        const undoBtn = document.querySelector('.wg-food-photo-summary .wg-toast__undo');
        expect(undoBtn.textContent).toBe('Undo');
        undoBtn.click();
        undoBtn.click();
        await flushPromises();

        expect(onUndo).toHaveBeenCalledTimes(1);
        expect(document.querySelector('.wg-food-photo-summary')).toBeNull();
    });

    it('showRemoved swaps in a "Removed N items" toast', () => {
        const { document, window } = env;
        const handle = window.showFoodPhotoSummary({ items: SAMPLE_ITEMS, autoDismissMs: 0 });
        handle.showRemoved(3);
        const toasts = document.querySelectorAll('.wg-food-photo-summary');
        expect(toasts).toHaveLength(1);
        expect(toasts[0].querySelector('.wg-toast__text').textContent).toBe('Removed 3 items');
    });

    it('showError swaps in a danger toast whose Retry runs the handler', async () => {
        const { document, window } = env;
        const handle = window.showFoodPhotoSummary({ items: SAMPLE_ITEMS, autoDismissMs: 0 });
        const retry = vi.fn();
        handle.showError('Could not undo all items. Tap retry to try again.', retry);

        const toast = document.querySelector('.wg-food-photo-summary');
        expect(toast.classList.contains('wg-toast--danger')).toBe(true);
        const btn = toast.querySelector('.wg-toast__undo');
        expect(btn.textContent).toBe('Retry');
        btn.click();
        await flushPromises();
        expect(retry).toHaveBeenCalledOnce();
    });

    it('auto-dismisses after the configured delay; dismiss() is idempotent', async () => {
        const { document, window } = env;
        const handle = window.showFoodPhotoSummary({ items: SAMPLE_ITEMS, autoDismissMs: 20 });
        expect(document.querySelector('.wg-food-photo-summary')).not.toBeNull();
        await new Promise((r) => setTimeout(r, 80));
        expect(document.querySelector('.wg-food-photo-summary')).toBeNull();
        expect(() => { handle.dismiss(); handle.dismiss(); }).not.toThrow();
    });

    it('empty items still render a toast with 0 kcal', () => {
        const { document, window } = env;
        window.showFoodPhotoSummary({ items: [], autoDismissMs: 0 });
        expect(toastText(document).querySelector('small').textContent).toBe('0 kcal · from photo');
    });
});
