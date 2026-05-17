// Friendly food-photo flow — Task 3: in-app summary card component.
//
// Pins the contract for `showFoodPhotoSummary({ items, onUndo })`:
//   1. Renders a card with one row per item (name, weight, kcal) and a
//      totals row that sums kcal/carbs/protein/fat across items.
//   2. The Undo button fires the `onUndo` callback exactly once even when
//      clicked multiple times in quick succession.
//   3. The Close button removes the card from the DOM and cancels the
//      auto-dismiss timer (so it can't fire after the card is gone).
//   4. The auto-dismiss timer removes the card after the configured delay.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CSS_PATH = path.join(REPO_ROOT, 'web/static/css/styles.css');

function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

const SAMPLE_ITEMS = [
    { id: 11, name: 'Oatmeal',     weight: 80, carbs: 50, protein: 10, fat: 5,  calories: 280 },
    { id: 12, name: 'Banana',      weight: 120, carbs: 27, protein: 1,  fat: 0,  calories: 105 },
    { id: 13, name: 'Almond milk', weight: 200, carbs: 2,  protein: 1,  fat: 2,  calories: 30  },
];

describe('showFoodPhotoSummary (friendly food-photo flow, Task 3)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        // Tear down any stray cards before disposing of the env so a failing
        // test in the middle of a suite doesn't leak DOM into the next one.
        try {
            env.document.querySelectorAll('.wg-food-photo-summary').forEach((el) => el.remove());
            env.window.localStorage.clear();
        } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('exposes showFoodPhotoSummary as a global function (loaded before food.js)', () => {
        expect(typeof env.window.showFoodPhotoSummary).toBe('function');
    });

    it('renders one row per item with name, weight (g), and kcal', () => {
        const { document, window } = env;
        window.showFoodPhotoSummary({ items: SAMPLE_ITEMS, autoDismissMs: 0 });

        const card = document.querySelector('.wg-food-photo-summary');
        expect(card).not.toBeNull();
        expect(card.getAttribute('role')).toBe('status');

        const rows = card.querySelectorAll('.wg-food-photo-summary__item');
        expect(rows.length).toBe(SAMPLE_ITEMS.length);

        // First row sanity: name + weight + kcal cells exist with the right text.
        const first = rows[0];
        expect(first.querySelector('.wg-food-photo-summary__item-name').textContent).toBe('Oatmeal');
        expect(first.querySelector('.wg-food-photo-summary__item-weight').textContent).toBe('80 g');
        expect(first.querySelector('.wg-food-photo-summary__item-kcal').textContent).toBe('280 kcal');
    });

    it('totals row sums kcal/carbs/protein/fat across all items', () => {
        const { document, window } = env;
        window.showFoodPhotoSummary({ items: SAMPLE_ITEMS, autoDismissMs: 0 });

        const totals = document.querySelector('.wg-food-photo-summary__totals');
        expect(totals).not.toBeNull();

        // 280 + 105 + 30 = 415 kcal
        const kcal = totals.querySelector('.wg-food-photo-summary__totals-kcal');
        expect(kcal.textContent).toBe('415 kcal');

        // C: 50+27+2=79  P: 10+1+1=12  F: 5+0+2=7
        const macros = totals.querySelector('.wg-food-photo-summary__totals-macros');
        expect(macros.textContent).toBe('C 79g · P 12g · F 7g');
    });

    it('header text reflects the item count (singular vs plural)', () => {
        const { document, window } = env;

        window.showFoodPhotoSummary({ items: [SAMPLE_ITEMS[0]], autoDismissMs: 0 });
        let title = document.querySelector('.wg-food-photo-summary__title');
        expect(title.textContent).toBe('Logged 1 item from photo');

        // Re-render with 3 items: stale card is replaced, not stacked.
        window.showFoodPhotoSummary({ items: SAMPLE_ITEMS, autoDismissMs: 0 });
        const cards = document.querySelectorAll('.wg-food-photo-summary');
        expect(cards.length).toBe(1);

        title = document.querySelector('.wg-food-photo-summary__title');
        expect(title.textContent).toBe('Logged 3 items from photo');
    });

    it('header text uses "from description" when source=description', () => {
        const { document, window } = env;

        window.showFoodPhotoSummary({ items: SAMPLE_ITEMS, source: 'description', autoDismissMs: 0 });
        const title = document.querySelector('.wg-food-photo-summary__title');
        expect(title.textContent).toBe('Logged 3 items from description');
    });

    it('Undo button fires onUndo exactly once even on rapid double-click', async () => {
        const { document, window } = env;
        const onUndo = vi.fn().mockResolvedValue(undefined);
        window.showFoodPhotoSummary({ items: SAMPLE_ITEMS, onUndo, autoDismissMs: 0 });

        const undoBtn = document.querySelector('.wg-food-photo-summary__undo');
        expect(undoBtn).not.toBeNull();

        undoBtn.click();
        undoBtn.click();
        undoBtn.click();
        await flushPromises();

        expect(onUndo).toHaveBeenCalledTimes(1);
        // Button is disabled after firing so it can't be reused without a fresh card.
        expect(undoBtn.disabled).toBe(true);
    });

    it('Close button removes the card from the DOM', () => {
        const { document, window } = env;
        window.showFoodPhotoSummary({ items: SAMPLE_ITEMS, autoDismissMs: 0 });

        const card = document.querySelector('.wg-food-photo-summary');
        expect(card).not.toBeNull();

        const closeBtn = card.querySelector('.wg-food-photo-summary__close');
        expect(closeBtn).not.toBeNull();
        closeBtn.click();

        expect(document.querySelector('.wg-food-photo-summary')).toBeNull();
    });

    it('auto-dismiss timer removes the card after the configured delay', () => {
        const { document, window } = env;
        vi.useFakeTimers();
        try {
            window.showFoodPhotoSummary({ items: SAMPLE_ITEMS, autoDismissMs: 500 });
            expect(document.querySelector('.wg-food-photo-summary')).not.toBeNull();

            vi.advanceTimersByTime(499);
            expect(document.querySelector('.wg-food-photo-summary')).not.toBeNull();

            vi.advanceTimersByTime(1);
            expect(document.querySelector('.wg-food-photo-summary')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('Close cancels the auto-dismiss timer (no double-removal/error after dismiss)', () => {
        const { document, window } = env;
        vi.useFakeTimers();
        try {
            const handle = window.showFoodPhotoSummary({ items: SAMPLE_ITEMS, autoDismissMs: 500 });
            const closeBtn = document.querySelector('.wg-food-photo-summary__close');
            closeBtn.click();
            expect(document.querySelector('.wg-food-photo-summary')).toBeNull();

            // Firing the timer after manual dismiss must not throw.
            expect(() => vi.advanceTimersByTime(1000)).not.toThrow();

            // Calling dismiss() a second time is a no-op.
            expect(() => handle.dismiss()).not.toThrow();
        } finally {
            vi.useRealTimers();
        }
    });

    it('handles empty / missing items gracefully (no crash, header still rendered)', () => {
        const { document, window } = env;
        window.showFoodPhotoSummary({ items: [], autoDismissMs: 0 });

        const card = document.querySelector('.wg-food-photo-summary');
        expect(card).not.toBeNull();

        const rows = card.querySelectorAll('.wg-food-photo-summary__item');
        expect(rows.length).toBe(0);

        const totals = card.querySelector('.wg-food-photo-summary__totals-kcal');
        expect(totals.textContent).toBe('0 kcal');
    });

    it('CSS: .wg-food-photo-summary block exists and uses --wg-* tokens for color', () => {
        // Defensive: the architecture rule from CLAUDE.md (no hardcoded
        // colors / no inline styles) is enforced for the canonical Phase 4
        // files; this test pins the new card to the same convention so the
        // visual surface stays driven by tokens.
        const css = fs.readFileSync(CSS_PATH, 'utf8');

        const openIdx = css.indexOf('\n.wg-food-photo-summary {');
        expect(openIdx).toBeGreaterThan(0);
        const closeIdx = css.indexOf('\n}', openIdx);
        expect(closeIdx).toBeGreaterThan(openIdx);
        const block = css.slice(openIdx, closeIdx);

        // Color value comes from a token, not a hex literal.
        expect(block).toMatch(/color:\s*var\(--wg-/);
        expect(block).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    });
});
