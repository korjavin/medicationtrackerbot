// Focused integration tests for the extracted features/food/meals.js
// sub-file. Covers the My Meals + save-as-meal modal lifecycle exposed
// on window.FoodMeals, plus the cross-file selected-id handoff through
// window.FoodLog accessors that drives the save-as-meal payload.

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

describe('features/food/meals.js — split-file integration', () => {
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

    it('exposes the FoodMeals public-API namespace on window', () => {
        const { window } = env;
        expect(window.FoodMeals).toBeTypeOf('object');
        expect(window.FoodMeals.load).toBeTypeOf('function');
        expect(window.FoodMeals.openSaveModal).toBeTypeOf('function');
        expect(window.FoodMeals.closeSaveModal).toBeTypeOf('function');
        expect(window.FoodMeals.confirmSave).toBeTypeOf('function');
    });

    it('openFoodSaveMealModal pre-fills the meal name with a time-based default', () => {
        const { window, document } = env;
        window.openFoodSaveMealModal();

        const nameInput = document.getElementById('food-save-meal-name');
        expect(nameInput.value).toMatch(/^Meal /);
    });

    it('closeFoodSaveMealModal hides the modal', () => {
        const { window, document } = env;
        window.openFoodSaveMealModal();
        const modal = document.getElementById('food-save-meal-modal');
        expect(modal.classList.contains('hidden')).toBe(false);

        window.closeFoodSaveMealModal();
        expect(modal.classList.contains('hidden')).toBe(true);
    });

    it('confirmSaveMeal POSTs the selected log ids from window.FoodLog and refreshes the cache on success', async () => {
        const { window, document } = env;
        // Seed selected ids on the FoodLog side (the canonical owner).
        window.FoodLog.multiSelectMode = true;
        window.FoodLog.addSelected(1);
        window.FoodLog.addSelected(2);

        const apiSpy = vi.fn().mockResolvedValue({ id: 999 });
        window.apiCall = apiSpy;
        window.initFoodProductsCache = vi.fn().mockResolvedValue(undefined);
        // Stub the post-save refresh path so the test doesn't leave a pending
        // loadFoodLogs() that races the env.cleanup() teardown.
        window.toggleFoodSelectMode = vi.fn();
        window.loadMyMeals = vi.fn();

        document.getElementById('food-save-meal-name').value = 'Test Meal';

        await window.confirmSaveMeal();

        expect(apiSpy).toHaveBeenCalledWith(
            '/api/food/products/from-logs',
            'POST',
            expect.objectContaining({
                name: 'Test Meal',
                log_ids: expect.arrayContaining([1, 2]),
            })
        );
    });

    it('confirmSaveMeal alerts and skips the POST when the name is empty', async () => {
        const { window, document } = env;
        const apiSpy = vi.fn();
        window.apiCall = apiSpy;
        window.alert = vi.fn();

        document.getElementById('food-save-meal-name').value = '   ';
        await window.confirmSaveMeal();

        expect(apiSpy).not.toHaveBeenCalled();
    });

    // ===========================================================================
    // Optimistic write conversion (Plan 2026-05-17 Task 4)
    //
    // confirmSaveMeal + the My Meals delete handler should mutate the cached
    // food_products_cache + window.FoodProducts.cache BEFORE the network round
    // trip resolves, then roll back on failure.
    // ===========================================================================

    it('confirmSaveMeal appends a placeholder meal into the cache before the POST resolves', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            food_products_cache: [{ id: 1, name: 'Existing', is_meal: false }]
        });
        window.FoodProducts.cache = [{ id: 1, name: 'Existing', is_meal: false }];
        window.FoodLog.multiSelectMode = true;
        window.FoodLog.addSelected(10);

        document.getElementById('food-save-meal-name').value = 'Bowl';
        window.initFoodProductsCache = vi.fn().mockResolvedValue(undefined);
        window.toggleFoodSelectMode = vi.fn();
        window.loadMyMeals = vi.fn();

        const pending = deferred();
        window.apiCall = vi.fn(async (endpoint) => {
            if (endpoint === '/api/food/products/from-logs') return pending.promise;
            return null;
        });

        const handlerDone = window.confirmSaveMeal();
        for (let i = 0; i < 8; i++) await Promise.resolve();

        expect(window.FoodProducts.cache.length).toBe(2);
        expect(window.FoodProducts.cache[1].name).toBe('Bowl');
        expect(window.FoodProducts.cache[1].is_meal).toBe(true);
        const cached = cache.get('food_products_cache');
        expect(cached.length).toBe(2);
        expect(cached[1].name).toBe('Bowl');

        pending.resolve({ id: 42 });
        await handlerDone;
    });

    it('confirmSaveMeal rolls back when apiCall returns null (offline/5xx) and suppresses the success toast', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            food_products_cache: [{ id: 1, name: 'Existing', is_meal: false }]
        });
        window.FoodProducts.cache = [{ id: 1, name: 'Existing', is_meal: false }];

        document.getElementById('food-save-meal-name').value = 'Bowl';
        window.initFoodProductsCache = vi.fn().mockResolvedValue(undefined);
        window.toggleFoodSelectMode = vi.fn();
        window.loadMyMeals = vi.fn();
        const showToast = vi.fn();
        window.SyncManager = { ...(window.SyncManager || {}), showToast };

        // apiCall returns null (not throws) on offline/5xx for write ops; the
        // handler must still roll back rather than treat it as success.
        window.apiCall = vi.fn(async () => null);

        await window.confirmSaveMeal();

        expect(window.FoodProducts.cache.length).toBe(1);
        expect(window.FoodProducts.cache[0].id).toBe(1);
        const cached = cache.get('food_products_cache');
        if (cached) {
            expect(cached.some((p) => p && p.isLocal)).toBe(false);
        }
        expect(showToast).not.toHaveBeenCalled();
    });

    it('confirmSaveMeal rolls back the optimistic placeholder when the POST rejects', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            food_products_cache: [{ id: 1, name: 'Existing', is_meal: false }]
        });
        window.FoodProducts.cache = [{ id: 1, name: 'Existing', is_meal: false }];

        document.getElementById('food-save-meal-name').value = 'Bowl';
        window.initFoodProductsCache = vi.fn().mockResolvedValue(undefined);
        window.toggleFoodSelectMode = vi.fn();
        window.loadMyMeals = vi.fn();
        window.safeAlert = vi.fn();

        window.apiCall = vi.fn(async () => { throw new Error('boom'); });

        await window.confirmSaveMeal();

        // The contract: the optimistic placeholder must not survive POST failure.
        // applyOptimistic.rollback restores the prior snapshot then invalidates
        // tags so the next read goes to network — either outcome (snapshot
        // restored OR cache evicted) is acceptable for the persisted cache;
        // the in-memory cache is restored deterministically by the catch block.
        expect(window.FoodProducts.cache.length).toBe(1);
        expect(window.FoodProducts.cache[0].id).toBe(1);
        const cached = cache.get('food_products_cache');
        if (cached) {
            expect(cached.some((p) => p && p.isLocal)).toBe(false);
        }
        expect(window.safeAlert).toHaveBeenCalledWith('Failed to save meal.');
    });

    it('My Meals delete drops the meal from the cache before the DELETE resolves', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            food_products_cache: [
                { id: 1, name: 'Bread', is_meal: false },
                { id: 7, name: 'Bowl', is_meal: true, total_weight_g: 0, energy_kcal_100g: 0, carbs_100g: 0, protein_100g: 0, fat_100g: 0 }
            ]
        });
        window.FoodProducts.cache = [
            { id: 1, name: 'Bread', is_meal: false },
            { id: 7, name: 'Bowl', is_meal: true, total_weight_g: 0, energy_kcal_100g: 0, carbs_100g: 0, protein_100g: 0, fat_100g: 0 }
        ];
        // initFoodProductsCache is invoked from the success path; stub it
        // out so it doesn't reach for a network and (critically) doesn't
        // re-render via loadMyMeals after the test cleanup.
        window.initFoodProductsCache = vi.fn().mockResolvedValue(undefined);

        window.safeConfirm = (_msg, cb) => Promise.resolve(cb(true));

        let apiCallSignal;
        const apiCalled = new Promise((r) => { apiCallSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (endpoint, method) => {
            if (endpoint === '/api/food/products/7' && method === 'DELETE') {
                apiCallSignal();
                return pending.promise;
            }
            return null;
        });

        // Render the meals list once via the real function so the delete
        // button is wired with the production handler — then immediately
        // swap loadMyMeals out so the post-success re-render doesn't
        // re-enter loadMyMeals after the test has finished asserting.
        await window.loadMyMeals();
        window.loadMyMeals = vi.fn();
        const list = document.getElementById('food-meals-list');
        const delBtn = list.querySelector('button.icon-action-btn.delete');
        expect(delBtn).toBeTruthy();

        delBtn.click();
        // Wait until the DELETE fires — by then the optimistic cache write
        // settled.
        await apiCalled;

        expect(window.FoodProducts.cache.some((p) => p.id === 7)).toBe(false);
        const cached = cache.get('food_products_cache');
        expect(cached.some((p) => p && p.id === 7)).toBe(false);

        // Keep the DELETE pending; resolving it would trigger the success
        // path's re-render after the test cleanup runs.
    });

    it('My Meals delete restores the meal when apiCall returns null (offline/5xx)', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            food_products_cache: [
                { id: 1, name: 'Bread', is_meal: false },
                { id: 7, name: 'Bowl', is_meal: true, total_weight_g: 0, energy_kcal_100g: 0, carbs_100g: 0, protein_100g: 0, fat_100g: 0 }
            ]
        });
        window.FoodProducts.cache = [
            { id: 1, name: 'Bread', is_meal: false },
            { id: 7, name: 'Bowl', is_meal: true, total_weight_g: 0, energy_kcal_100g: 0, carbs_100g: 0, protein_100g: 0, fat_100g: 0 }
        ];
        window.initFoodProductsCache = vi.fn().mockResolvedValue(undefined);
        window.safeAlert = vi.fn();

        // apiCall returns null (not throws) on offline/5xx for write ops.
        // Use a deferred so the test can wait until the handler reaches the
        // rollback branch before asserting.
        const apiDone = deferred();
        window.apiCall = vi.fn(async (endpoint, method) => {
            if (endpoint === '/api/food/products/7' && method === 'DELETE') {
                queueMicrotask(() => apiDone.resolve());
                return null;
            }
            return null;
        });

        let confirmResolve;
        const confirmDone = new Promise((r) => { confirmResolve = r; });
        window.safeConfirm = async (_msg, cb) => {
            await cb(true);
            confirmResolve();
        };

        await window.loadMyMeals();
        window.loadMyMeals = vi.fn();
        const list = document.getElementById('food-meals-list');
        const delBtn = list.querySelector('button.icon-action-btn.delete');
        expect(delBtn).toBeTruthy();

        delBtn.click();
        await apiDone.promise;
        await confirmDone;

        // The deleted meal must be restored to both the in-memory cache and
        // the persisted ApiCache snapshot (if any survives).
        expect(window.FoodProducts.cache.some((p) => p.id === 7)).toBe(true);
        const cachedAfter = cache.get('food_products_cache');
        if (cachedAfter) {
            expect(cachedAfter.some((p) => p && p.id === 7)).toBe(true);
        }
    });
});
