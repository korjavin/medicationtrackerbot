// Focused integration tests for the extracted features/food/db.js
// sub-file. Covers the closure-private page/sort/query/total state
// exposed via window.FoodDB getters/setters.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('features/food/db.js — split-file integration', () => {
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

    it('exposes the FoodDB namespace with page/sort/query/total accessors', () => {
        const { window } = env;
        expect(window.FoodDB).toBeTypeOf('object');
        expect(window.FoodDB.page).toBe(0);
        expect(window.FoodDB.sort).toBe('usage');
        expect(window.FoodDB.query).toBe('');
        expect(window.FoodDB.total).toBe(0);
        expect(window.FoodDB.load).toBeTypeOf('function');
        expect(window.FoodDB.render).toBeTypeOf('function');
    });

    it('setters normalize falsy / out-of-band values', () => {
        const { window } = env;
        window.FoodDB.page = '3';
        expect(window.FoodDB.page).toBe(3);
        window.FoodDB.page = null;
        expect(window.FoodDB.page).toBe(0);

        window.FoodDB.sort = '';
        expect(window.FoodDB.sort).toBe('usage');

        window.FoodDB.query = null;
        expect(window.FoodDB.query).toBe('');

        window.FoodDB.total = '12';
        expect(window.FoodDB.total).toBe(12);
    });

    it('renderFoodDBList handles an empty product list and surfaces pagination state', () => {
        const { window, document } = env;
        window.FoodDB.page = 0;
        window.renderFoodDBList([], 0);

        const list = document.getElementById('fooddb-list');
        expect(list.innerHTML).toContain('No products found');
        expect(document.getElementById('fooddb-prev-btn').disabled).toBe(true);
        expect(document.getElementById('fooddb-next-btn').disabled).toBe(true);
    });

    it('loadFoodDB fetches and renders products, updating total', async () => {
        const { window, document } = env;
        const products = [
            {
                id: 1,
                name: 'Apple',
                carbs_100g: 14,
                protein_100g: 0.3,
                fat_100g: 0.2,
                energy_kcal_100g: 52,
                usage_count: 3,
                is_meal: false,
            },
        ];
        window.apiCall = vi.fn().mockResolvedValue({ products, total: 1 });

        await window.loadFoodDB();

        expect(window.FoodDB.total).toBe(1);
        const list = document.getElementById('fooddb-list');
        expect(list.textContent).toContain('Apple');
    });
});
