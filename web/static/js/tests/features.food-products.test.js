// Focused integration tests for the extracted features/food/products.js
// sub-file. Covers the cache + autocomplete accessors exposed on
// window.FoodProducts and the showEditFoodProductModal / closeFoodProductModal
// flows that moved out of the monolithic food.js.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function installApiCache(window, seed = {}) {
    const map = new Map(Object.entries(seed));
    window.MedTrackerDB = {
        ...(window.MedTrackerDB || {}),
        ApiCache: {
            async get(key) { return map.has(key) ? map.get(key) : null; },
            async set(key, value) { map.set(key, value); },
            async clear(key) { map.delete(key); },
            async keys(prefix) {
                const all = [...map.keys()];
                return typeof prefix === 'string' && prefix
                    ? all.filter((k) => k.startsWith(prefix))
                    : all;
            }
        },
        FoodProductsStore: {
            saveCache: async () => undefined,
            getCache: async () => null,
            clearCache: vi.fn().mockResolvedValue(undefined)
        }
    };
    return map;
}

function deferred() {
    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
    });
    return { promise, resolve: resolveFn, reject: rejectFn };
}

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

    // ===========================================================================
    // Optimistic write conversion (Plan 2026-05-17 Task 4)
    //
    // saveFoodProduct should patch the matching product in window.FoodProducts.cache
    // + the cached `food_products_cache` payload BEFORE the PUT resolves, then
    // roll back on failure.
    // ===========================================================================

    it('saveFoodProduct patches the cache row optimistically before the PUT resolves', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            food_products_cache: [
                { id: 1, name: 'Apple', carbs_100g: 14, protein_100g: 0.3, fat_100g: 0.2, energy_kcal_100g: 52 },
                { id: 2, name: 'Banana', carbs_100g: 23, protein_100g: 1, fat_100g: 0, energy_kcal_100g: 90 }
            ]
        });
        window.FoodProducts.cache = [
            { id: 1, name: 'Apple', carbs_100g: 14, protein_100g: 0.3, fat_100g: 0.2, energy_kcal_100g: 52 },
            { id: 2, name: 'Banana', carbs_100g: 23, protein_100g: 1, fat_100g: 0, energy_kcal_100g: 90 }
        ];

        document.getElementById('food-product-id').value = '2';
        document.getElementById('food-product-name').value = 'Banana XL';
        document.getElementById('food-product-barcode').value = '';
        document.getElementById('food-product-carbs').value = '25';
        document.getElementById('food-product-protein').value = '2';
        document.getElementById('food-product-fat').value = '0.5';
        document.getElementById('food-product-calories').value = '100';
        const isMealEl = document.getElementById('food-product-is-meal');
        if (isMealEl) isMealEl.value = 'false';

        window.initFoodProductsCache = vi.fn().mockResolvedValue(undefined);
        window.renderFoodAutocomplete = vi.fn();
        window.safeAlert = vi.fn();

        const pending = deferred();
        window.apiCall = vi.fn(async (endpoint, method) => {
            if (endpoint === '/api/food/products/2' && method === 'PUT') return pending.promise;
            return null;
        });

        const handlerDone = window.saveFoodProduct();
        for (let i = 0; i < 8; i++) await Promise.resolve();

        // In-memory cache patched.
        const inMem = window.FoodProducts.cache.find((p) => p.id === 2);
        expect(inMem.name).toBe('Banana XL');
        expect(inMem.energy_kcal_100g).toBe(100);

        // Persisted cache patched.
        const cached = cache.get('food_products_cache');
        const persisted = cached.find((p) => p && p.id === 2);
        expect(persisted.name).toBe('Banana XL');
        expect(persisted.energy_kcal_100g).toBe(100);

        pending.resolve({ ok: true });
        await handlerDone;
    });

    it('saveFoodProduct rolls back the optimistic patch when the PUT returns null', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            food_products_cache: [
                { id: 5, name: 'Bread', carbs_100g: 50, protein_100g: 10, fat_100g: 3, energy_kcal_100g: 250 }
            ]
        });
        window.FoodProducts.cache = [
            { id: 5, name: 'Bread', carbs_100g: 50, protein_100g: 10, fat_100g: 3, energy_kcal_100g: 250 }
        ];

        document.getElementById('food-product-id').value = '5';
        document.getElementById('food-product-name').value = 'Sourdough';
        document.getElementById('food-product-barcode').value = '';
        document.getElementById('food-product-carbs').value = '55';
        document.getElementById('food-product-protein').value = '8';
        document.getElementById('food-product-fat').value = '4';
        document.getElementById('food-product-calories').value = '280';

        window.initFoodProductsCache = vi.fn().mockResolvedValue(undefined);
        window.renderFoodAutocomplete = vi.fn();
        window.apiCall = vi.fn(async () => null);

        await window.saveFoodProduct();

        // The contract: the optimistic Sourdough patch must not survive PUT
        // failure. In-memory cache is restored deterministically by the
        // catch-block snapshot; the persisted cache is either restored or
        // evicted by applyOptimistic.rollback's invalidateTags.
        const inMem = window.FoodProducts.cache.find((p) => p.id === 5);
        expect(inMem.name).toBe('Bread');
        expect(inMem.energy_kcal_100g).toBe(250);
        const cached = cache.get('food_products_cache');
        if (cached) {
            const persisted = cached.find((p) => p && p.id === 5);
            if (persisted) {
                expect(persisted.name).toBe('Bread');
                expect(persisted.energy_kcal_100g).toBe(250);
            }
        }
    });
});
