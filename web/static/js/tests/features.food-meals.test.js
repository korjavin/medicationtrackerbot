// Focused integration tests for the extracted features/food/meals.js
// sub-file. Covers the My Meals + save-as-meal modal lifecycle exposed
// on window.FoodMeals, plus the cross-file selected-id handoff through
// window.FoodLog accessors that drives the save-as-meal payload.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

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
});
