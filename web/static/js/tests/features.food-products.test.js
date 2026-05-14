// Focused integration tests for the extracted features/food/products.js
// sub-file. Covers the cache + autocomplete accessors exposed on
// window.FoodProducts and the showEditFoodProductModal / closeFoodProductModal
// flows that moved out of the monolithic food.js.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('features/food/products.js — split-file integration', () => {
    let env;
    let consoleErrorSpy;

    beforeEach(() => {
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        env = loadFrontendEnv();
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('exposes the FoodProducts namespace with cache + suggestions accessors', () => {
        const { window } = env;
        expect(window.FoodProducts).toBeTypeOf('object');
        expect(Array.isArray(window.FoodProducts.cache)).toBe(true);
        expect(Array.isArray(window.FoodProducts.suggestions)).toBe(true);
    });

    it('cache + suggestions setters reject non-array values without throwing', () => {
        const { window } = env;
        window.FoodProducts.cache = null;
        expect(window.FoodProducts.cache).toEqual([]);
        window.FoodProducts.suggestions = undefined;
        expect(window.FoodProducts.suggestions).toEqual([]);

        window.FoodProducts.cache = [{ id: 1, name: 'Foo' }];
        expect(window.FoodProducts.cache[0].name).toBe('Foo');
    });

    it('showEditFoodProductModal hydrates inputs from the product record', () => {
        const { window, document } = env;
        window.showEditFoodProductModal({
            id: 42,
            name: 'Greek Yogurt',
            barcode: '5901234123457',
            carbs_100g: 4.5,
            protein_100g: 9,
            fat_100g: 5,
            energy_kcal_100g: 100,
            is_meal: false,
            total_weight_g: 0,
        });

        expect(document.getElementById('food-product-id').value).toBe('42');
        expect(document.getElementById('food-product-name').value).toBe('Greek Yogurt');
        expect(document.getElementById('food-product-barcode').value).toBe('5901234123457');
        expect(document.getElementById('food-product-carbs').value).toBe('4.5');
        expect(document.getElementById('food-product-calories').value).toBe('100');
    });

    it('closeFoodProductModal hides the product modal', () => {
        const { window, document } = env;
        window.showEditFoodProductModal({
            id: 7,
            name: 'Apple',
            carbs_100g: 14,
            protein_100g: 0.3,
            fat_100g: 0.2,
            energy_kcal_100g: 52,
        });
        expect(document.getElementById('food-product-modal').classList.contains('hidden')).toBe(false);

        window.closeFoodProductModal();
        expect(document.getElementById('food-product-modal').classList.contains('hidden')).toBe(true);
    });

    it('decodeFoodDisplayText decodes URI-encoded and HTML-escaped names', () => {
        const { window } = env;
        expect(window.decodeFoodDisplayText('Caf%C3%A9')).toBe('Café');
        expect(window.decodeFoodDisplayText('  hello  ')).toBe('hello');
    });
});
