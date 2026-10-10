// Manual food form (kit F8, med-xso6.17) — the Add sheet's "Enter manually"
// fallback and the edit form for a logged entry.
//
// A kit sheet: .wg-sheethead with Cancel/Save, "Values are" as a
// .wg-seg--accent over the hidden #food-per-100g checkbox the maths reads,
// the When chip over the hidden #food-datetime input, barcode + product link
// under More. Every existing handler (save/cancel/per-100g recompute,
// autocomplete, modal history) still binds by id.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Manual food form (kit F8)', () => {
    let env;

    let realRenderFoodAutocomplete;

    beforeEach(() => {
        env = loadFrontendEnv();
        env.window.initFoodProductsCache = vi.fn().mockResolvedValue(undefined);
        realRenderFoodAutocomplete = env.window.renderFoodAutocomplete;
        env.window.renderFoodAutocomplete = vi.fn();

        // JSDOM does not implement HTMLMediaElement.prototype.pause; the
        // food-modal close path tears down the scanner video element.
        const video = env.document.getElementById('food-scanner-video');
        if (video) {
            video.pause = vi.fn();
            video.srcObject = null;
        }
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('is a kit sheet: .wg-sheethead with Save + the close X, no AI checkbox, no legacy food-modal parts', () => {
        const { document } = env;
        const modal = document.getElementById('food-modal');
        expect(modal.classList.contains('wg-modal')).toBe(true);
        expect(modal.classList.contains('wg-sheet')).toBe(true);
        const acts = modal.querySelector(':scope > .wg-sheethead .wg-sheethead__acts');
        expect(acts.contains(document.getElementById('food-modal-cancel-btn'))).toBe(true);
        expect(acts.contains(document.getElementById('food-modal-save-btn'))).toBe(true);
        expect(document.getElementById('food-parse-ai')).toBeNull();
        expect(modal.querySelector('[class*="wg-food-modal__header"], .btn, .wg-gloss')).toBeNull();
    });

    it('"Values are" is an accent segment over the hidden per-100g checkbox and recomputes calories', () => {
        const { document } = env;
        const seg = document.getElementById('food-per-100g-seg');
        expect(seg.classList.contains('wg-seg')).toBe(true);
        expect(seg.classList.contains('wg-seg--accent')).toBe(true);
        const box = document.getElementById('food-per-100g');
        expect(box.classList.contains('hidden')).toBe(true);
        expect(box.checked).toBe(true);

        document.getElementById('food-weight').value = '200';
        document.getElementById('food-carbs').value = '50';
        document.getElementById('food-protein').value = '0';
        document.getElementById('food-fat').value = '0';

        seg.querySelector('[data-per100g="false"]').click();
        expect(box.checked).toBe(false);
        expect(seg.querySelector('[data-per100g="false"]').getAttribute('aria-pressed')).toBe('true');
        expect(seg.querySelector('[data-per100g="true"]').getAttribute('aria-pressed')).toBe('false');
        // Totals: 50 g carbs * 4.
        expect(document.getElementById('food-calories').value).toBe('200');

        seg.querySelector('[data-per100g="true"]').click();
        expect(box.checked).toBe(true);
        // Per 100 g of a 200 g portion: 50 * 2 * 4.
        expect(document.getElementById('food-calories').value).toBe('400');
    });

    it('openManual resets the form and carries the Add sheet prefill (name, barcode under More, time chip)', async () => {
        const { document, window } = env;
        document.getElementById('food-weight').value = '999';
        const eatenAt = new Date();
        eatenAt.setHours(8, 5, 0, 0);
        window.FoodLog.openManual({ name: 'Kefir', barcode: '4600000000001', eatenAt });
        await flushPromises();

        expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('food-modal-title').innerText).toBe('Manual entry');
        expect(document.getElementById('food-name').value).toBe('Kefir');
        expect(document.getElementById('food-barcode').value).toBe('4600000000001');
        expect(document.getElementById('food-weight').value).toBe('');
        expect(document.getElementById('food-per-100g').checked).toBe(true);
        expect(document.getElementById('food-modal-more').open).toBe(true);
        expect(document.getElementById('food-datetime-label').textContent).toContain('08:05');
        expect(window.initFoodProductsCache).toHaveBeenCalled();
    });

    it('More stays closed without a barcode; the When chip follows the hidden input', () => {
        const { document, window } = env;
        window.FoodLog.openManual();
        expect(document.getElementById('food-modal-more').open).toBe(false);

        const input = document.getElementById('food-datetime');
        const d = new Date();
        d.setHours(13, 45, 0, 0);
        input.value = window.formatDateTimeLocalForInput(d);
        input.dispatchEvent(new window.Event('change'));
        expect(document.getElementById('food-datetime-label').textContent).toContain('13:45');
    });

    it('editFoodLog hydrates inputs from a stored log and recomputes per-100g values', () => {
        const { document, window } = env;
        window.FoodLog.setCurrent({
            42: {
                id: 42,
                name: 'Oatmeal',
                barcode: '123',
                weight: 200,
                carbs: 50,
                protein: 12,
                fat: 6,
                calories: 320,
                eaten_at: '2026-04-20T08:15:00Z'
            }
        });

        window.editFoodLog(42);

        expect(document.getElementById('food-modal-title').innerText).toBe('Edit entry');
        expect(document.getElementById('food-id').value).toBe('42');
        expect(document.getElementById('food-name').value).toBe('Oatmeal');
        expect(document.getElementById('food-barcode').value).toBe('123');
        expect(document.getElementById('food-modal-more').open).toBe(true);
        expect(document.getElementById('food-weight').value).toBe('200');
        expect(document.getElementById('food-per-100g').checked).toBe(true);
        expect(document.querySelector('#food-per-100g-seg [data-per100g="true"]').getAttribute('aria-pressed')).toBe('true');
        // 50g carbs / 200g * 100 = 25g per 100g
        expect(document.getElementById('food-carbs').value).toBe('25');
        expect(document.getElementById('food-protein').value).toBe('6');
        expect(document.getElementById('food-fat').value).toBe('3');
    });

    it('Cancel routes through closeFoodModal', () => {
        const { document, window } = env;
        window.FoodLog.openManual();
        expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(false);

        document.getElementById('food-modal-cancel-btn').click();
        expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(true);
    });

    it('Save POSTs a new log when food-id is empty and closes the sheet', async () => {
        const { document, window } = env;
        window.safeAlert = vi.fn();
        window.FoodLog.openManual();

        document.getElementById('food-datetime').value = '2026-04-20T12:00';
        document.getElementById('food-name').value = 'Apple';
        document.getElementById('food-weight').value = '180';
        document.querySelector('#food-per-100g-seg [data-per100g="false"]').click();
        document.getElementById('food-carbs').value = '25';
        document.getElementById('food-protein').value = '0';
        document.getElementById('food-fat').value = '0';
        document.getElementById('food-calories').value = '95';

        const apiSpy = vi.fn().mockResolvedValue({ ok: true });
        window.apiCall = apiSpy;
        window.loadFoodLogs = vi.fn();

        document.getElementById('food-modal-save-btn').click();
        await flushPromises();
        await flushPromises();

        expect(apiSpy).toHaveBeenCalledWith(
            '/api/food/log',
            'POST',
            expect.objectContaining({ name: 'Apple', weight: 180, calories: 95, per_100g: false })
        );
        expect(apiSpy.mock.calls.filter(([, m]) => m === 'POST')).toHaveLength(1);
        expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(true);
    });

    describe('food-autocomplete-list', () => {
        it('container exists with the .autocomplete-items class inside the name field', () => {
            const { document } = env;
            const list = document.getElementById('food-autocomplete-list');
            expect(list).not.toBeNull();
            expect(list.classList.contains('autocomplete-items')).toBe(true);
            expect(list.parentElement.classList.contains('wg-food-modal__name')).toBe(true);
            expect(list.parentElement.contains(document.getElementById('food-name'))).toBe(true);
        });

        it('renders items with .autocomplete-item-name and .autocomplete-item-meta spans', () => {
            const { document } = env;
            const list = document.getElementById('food-autocomplete-list');

            realRenderFoodAutocomplete([
                { id: 1, name: 'Oatmeal', barcode: '1234567' },
                { id: 2, name: 'Lunch Bowl', is_meal: true },
                { id: 3, name: 'Plain Rice' },
            ]);

            const items = list.querySelectorAll('.autocomplete-item');
            expect(items).toHaveLength(3);

            items.forEach((item) => {
                expect(item.querySelector('.autocomplete-item-name')).not.toBeNull();
                expect(item.getAttribute('style')).toBeNull();
                expect(item.querySelector('.autocomplete-item-name').getAttribute('style')).toBeNull();
            });

            expect(items[0].querySelector('.autocomplete-item-meta').textContent).toContain('1234567');
            expect(items[1].querySelector('.autocomplete-item-meta').textContent).toContain('Meal');
            expect(items[2].querySelector('.autocomplete-item-meta')).toBeNull();

            expect(list.classList.contains('hidden')).toBe(false);
        });

        it('empty result set keeps the dropdown hidden', () => {
            const { document } = env;
            const list = document.getElementById('food-autocomplete-list');

            realRenderFoodAutocomplete([]);

            expect(list.classList.contains('hidden')).toBe(true);
            expect(list.querySelectorAll('.autocomplete-item')).toHaveLength(0);
        });
    });

    it('Back (closeTopMostVisibleModal) pops the sheet (modal history wiring)', () => {
        const { document, window } = env;
        window.FoodLog.openManual();
        expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('modal-overlay').classList.contains('hidden')).toBe(false);

        window.ModalManager.closeTopMostVisibleModal();
        expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(true);
    });
});
