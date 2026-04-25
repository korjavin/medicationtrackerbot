// Wandergeek EditFoodModal (Phase 4, Task 6).
//
// Asserts the rewritten edit-food modal uses the Wandergeek shell —
// `.wg-modal` + `.wg-food-modal` shell, dual-line eyebrow + mono "Food"
// title, top-right close icon, gloss-inset input wraps, three-column macros
// row, larger mono total-calories input, bottom Cancel + Save action bar —
// while preserving every existing handler (open/save/cancel/per-100g
// recompute, barcode autocomplete, modal-controller history integration).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('EditFoodModal (Phase 4, Task 6)', () => {
    let env;

    let realRenderFoodAutocomplete;

    beforeEach(() => {
        env = loadFrontendEnv();
        env.window.initFoodProductsCache = vi.fn().mockResolvedValue(undefined);
        realRenderFoodAutocomplete = env.window.renderFoodAutocomplete;
        env.window.renderFoodAutocomplete = vi.fn();

        // JSDOM does not implement HTMLMediaElement.prototype.pause; the
        // food-modal close path tears down the scanner video element, so
        // stub pause() and clear srcObject up front to keep close() quiet.
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

    it('shell uses the shared .wg-modal primitive plus the .wg-food-modal class', () => {
        const { document } = env;
        const modal = document.getElementById('food-modal');
        expect(modal).not.toBeNull();
        expect(modal.classList.contains('wg-modal')).toBe(true);
        expect(modal.classList.contains('wg-food-modal')).toBe(true);
    });

    it('header renders eyebrow + mono title + .wg-icon-btn close affordance', () => {
        const { document } = env;
        const header = document.querySelector('#food-modal .wg-food-modal__header');
        expect(header).not.toBeNull();

        const eyebrow = document.getElementById('food-modal-title');
        expect(eyebrow).not.toBeNull();
        expect(eyebrow.classList.contains('wg-section-label')).toBe(true);
        expect(eyebrow.classList.contains('wg-food-modal__eyebrow')).toBe(true);
        expect(eyebrow.textContent.trim()).toBe('Log Food');

        const title = document.querySelector('#food-modal .wg-food-modal__title');
        expect(title).not.toBeNull();
        expect(title.classList.contains('wg-mono-display')).toBe(true);
        expect(title.textContent.trim()).toBe('Food');

        const close = document.getElementById('food-modal-close-btn');
        expect(close).not.toBeNull();
        expect(close.classList.contains('wg-icon-btn')).toBe(true);
        expect(close.querySelector('.wg-gloss')).not.toBeNull();
    });

    it('Weight + Barcode row uses gloss-inset input wraps and a gloss Scan button', () => {
        const { document } = env;
        const row = document.querySelector('#food-modal .wg-food-modal__row--quick');
        expect(row).not.toBeNull();

        const weightWrap = document.getElementById('food-weight').parentElement;
        expect(weightWrap.classList.contains('wg-gloss--inset')).toBe(true);
        expect(weightWrap.classList.contains('wg-food-modal__input-wrap')).toBe(true);

        const barcodeWrap = document.getElementById('food-barcode').parentElement;
        expect(barcodeWrap.classList.contains('wg-gloss--inset')).toBe(true);

        const scanBtn = document.getElementById('food-scan-btn');
        expect(scanBtn).not.toBeNull();
        expect(scanBtn.classList.contains('wg-gloss')).toBe(true);
        expect(scanBtn.classList.contains('wg-food-modal__scan-btn')).toBe(true);
        expect(scanBtn.textContent).toContain('Scan');
    });

    it('Food name input is wrapped in a gloss-inset wrap with autocomplete container', () => {
        const { document } = env;
        const nameInput = document.getElementById('food-name');
        expect(nameInput).not.toBeNull();
        const wrap = nameInput.parentElement;
        expect(wrap.classList.contains('wg-gloss--inset')).toBe(true);
        expect(wrap.classList.contains('wg-food-modal__name-wrap')).toBe(true);

        const autocomplete = document.getElementById('food-autocomplete-list');
        expect(autocomplete).not.toBeNull();
        expect(autocomplete.parentElement).toBe(wrap);
    });

    it('Macros · per 100g section header + three gloss-inset macro inputs', () => {
        const { document } = env;
        const sectionLabel = document.querySelector('#food-modal .wg-food-modal__section-label');
        expect(sectionLabel).not.toBeNull();
        expect(sectionLabel.classList.contains('wg-section-label')).toBe(true);
        expect(sectionLabel.textContent.trim()).toBe('Macros · per 100g');

        const macrosRow = document.querySelector('#food-modal .wg-food-modal__row--macros');
        expect(macrosRow).not.toBeNull();

        ['food-carbs', 'food-protein', 'food-fat'].forEach(id => {
            const input = document.getElementById(id);
            expect(input).not.toBeNull();
            expect(input.parentElement.classList.contains('wg-gloss--inset')).toBe(true);
        });
    });

    it('Total calories input is gloss-inset and carries the larger mono token class', () => {
        const { document } = env;
        const calories = document.getElementById('food-calories');
        expect(calories).not.toBeNull();
        expect(calories.classList.contains('wg-food-modal__input--total-kcal')).toBe(true);
        expect(calories.parentElement.classList.contains('wg-gloss--inset')).toBe(true);
    });

    it('Date & time input is wrapped in a gloss-inset wrap', () => {
        const { document } = env;
        const dt = document.getElementById('food-datetime');
        expect(dt).not.toBeNull();
        expect(dt.type).toBe('datetime-local');
        expect(dt.parentElement.classList.contains('wg-gloss--inset')).toBe(true);
    });

    it('header action row carries Cancel (.wg-gloss) and Save (.wg-gloss--sun)', () => {
        const { document } = env;
        const actions = document.querySelector('#food-modal .wg-food-modal__header-actions');
        expect(actions).not.toBeNull();
        // Body footer action row no longer exists.
        expect(document.querySelector('#food-modal .wg-food-modal__actions')).toBeNull();

        const cancelBtn = document.getElementById('food-modal-cancel-btn');
        const saveBtn = document.getElementById('food-modal-save-btn');
        expect(cancelBtn.parentElement).toBe(actions);
        expect(saveBtn.parentElement).toBe(actions);

        expect(cancelBtn.classList.contains('wg-gloss')).toBe(true);
        expect(cancelBtn.classList.contains('wg-gloss--sun')).toBe(false);
        expect(saveBtn.classList.contains('wg-gloss')).toBe(true);
        expect(saveBtn.classList.contains('wg-gloss--sun')).toBe(true);
        expect(saveBtn.textContent).toContain('Save entry');

        // Cancel comes before Save (left/right convention).
        const cancelIdx = Array.from(actions.children).indexOf(cancelBtn);
        const saveIdx = Array.from(actions.children).indexOf(saveBtn);
        expect(cancelIdx).toBeGreaterThan(-1);
        expect(saveIdx).toBeGreaterThan(cancelIdx);
    });

    it('per-100g checkbox stays checked by default and is wrapped in a label', () => {
        const { document } = env;
        const cb = document.getElementById('food-per-100g');
        expect(cb).not.toBeNull();
        expect(cb.checked).toBe(true);
        expect(cb.parentElement.classList.contains('wg-food-modal__per100g')).toBe(true);
    });

    it('renderFoodModalIcons populates the close + scan icons exactly once', () => {
        const { document, window } = env;
        // bindFoodControls already ran during harness load; icons should be in.
        const closeSvg = document.querySelector('#food-modal-close-btn .wg-gloss svg');
        const scanSvg = document.querySelector('#food-scan-btn svg');
        expect(closeSvg).not.toBeNull();
        expect(scanSvg).not.toBeNull();

        // Re-running should be idempotent (no duplicate svgs).
        if (typeof window.renderFoodModalIcons === 'function') {
            window.renderFoodModalIcons();
            expect(document.querySelectorAll('#food-modal-close-btn .wg-gloss svg')).toHaveLength(1);
            expect(document.querySelectorAll('#food-scan-btn svg')).toHaveLength(1);
        }
    });

    it('showAddFoodModal opens the modal, sets eyebrow text, and resets inputs', async () => {
        const { document, window } = env;
        window.showAddFoodModal();
        await flushPromises();

        expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('food-modal-title').innerText).toBe('New entry');
        expect(document.getElementById('food-name').value).toBe('');
        expect(document.getElementById('food-weight').value).toBe('');
        expect(document.getElementById('food-per-100g').checked).toBe(true);
        expect(window.initFoodProductsCache).toHaveBeenCalled();
    });

    it('editFoodLog hydrates inputs from a stored log and recomputes per-100g totals', () => {
        const { document, window } = env;
        window.currentFoodLogs = {
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
        };

        window.editFoodLog(42);

        expect(document.getElementById('food-modal-title').innerText).toBe('Edit entry');
        expect(document.getElementById('food-id').value).toBe('42');
        expect(document.getElementById('food-name').value).toBe('Oatmeal');
        expect(document.getElementById('food-barcode').value).toBe('123');
        expect(document.getElementById('food-weight').value).toBe('200');
        expect(document.getElementById('food-per-100g').checked).toBe(true);
        // 50g carbs / 200g * 100 = 25g per 100g
        expect(document.getElementById('food-carbs').value).toBe('25');
        expect(document.getElementById('food-protein').value).toBe('6');
        expect(document.getElementById('food-fat').value).toBe('3');
    });

    it('cancel button (header) routes through closeFoodModal', () => {
        const { document, window } = env;
        window.showAddFoodModal();
        expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(false);

        document.getElementById('food-modal-cancel-btn').click();
        expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(true);
    });

    it('close icon (top-right) also routes through closeFoodModal', () => {
        const { document, window } = env;
        window.showAddFoodModal();
        expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(false);

        document.getElementById('food-modal-close-btn').click();
        expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(true);
    });

    it('save button POSTs a new log when food-id is empty', async () => {
        const { document, window } = env;
        window.safeAlert = vi.fn();
        window.showAddFoodModal();

        document.getElementById('food-datetime').value = '2026-04-20T12:00';
        document.getElementById('food-name').value = 'Apple';
        document.getElementById('food-weight').value = '180';
        document.getElementById('food-per-100g').checked = false;
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
            expect.objectContaining({ name: 'Apple', weight: 180, calories: 95 })
        );
    });

    describe('food-autocomplete-list (Phase 4 follow-up)', () => {
        it('container exists with the .autocomplete-items class inside the name wrap', () => {
            const { document } = env;
            const list = document.getElementById('food-autocomplete-list');
            expect(list).not.toBeNull();
            expect(list.classList.contains('autocomplete-items')).toBe(true);
            expect(list.parentElement.classList.contains('wg-food-modal__name-wrap')).toBe(true);
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

            // Meta span is present for barcoded products and meals, absent for plain rows.
            expect(items[0].querySelector('.autocomplete-item-meta').textContent).toContain('1234567');
            expect(items[1].querySelector('.autocomplete-item-meta').textContent).toContain('Meal');
            expect(items[2].querySelector('.autocomplete-item-meta')).toBeNull();

            // Dropdown becomes visible once items are rendered.
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

    it('Telegram BackButton handler still pops the modal (modal-controller history wiring)', () => {
        const { document, window } = env;
        window.showAddFoodModal();
        expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('modal-overlay').classList.contains('hidden')).toBe(false);

        // Simulate the Telegram BackButton click (the handler set up by the
        // back-button.js feature module). modal-history.js listens to overlay
        // class changes; AppBackButton.refresh delegates to closeTopMostVisibleModal.
        window.ModalManager.closeTopMostVisibleModal();
        expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(true);
    });
});
