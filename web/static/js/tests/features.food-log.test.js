// Focused integration tests for the extracted features/food/log.js
// sub-file. Covers the public-API surface of window.FoodLog and the
// closure-private currentFoodLogs accessor that replaced the deleted
// `var currentFoodLogs = {}` global from app.js:1079.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('features/food/log.js — split-file integration', () => {
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

    it('exposes the FoodLog public-API namespace on window', () => {
        const { window } = env;
        expect(window.FoodLog).toBeTypeOf('object');
        expect(window.FoodLog.load).toBeTypeOf('function');
        expect(window.FoodLog.save).toBeTypeOf('function');
        expect(window.FoodLog.delete).toBeTypeOf('function');
        expect(window.FoodLog.openAdd).toBeTypeOf('function');
        expect(window.FoodLog.openEdit).toBeTypeOf('function');
        expect(window.FoodLog.close).toBeTypeOf('function');
        expect(window.FoodLog.getCurrent).toBeTypeOf('function');
        expect(window.FoodLog.setCurrent).toBeTypeOf('function');
    });

    it('getCurrent / setCurrent round-trip the closure-private currentFoodLogs', () => {
        const { window } = env;
        // Initial state is an empty object.
        expect(window.FoodLog.getCurrent()).toEqual({});

        // setCurrent overwrites; setLog adds incrementally.
        window.FoodLog.setCurrent({ 5: { id: 5, name: 'Salad' } });
        expect(window.FoodLog.getCurrent()[5].name).toBe('Salad');
        window.FoodLog.setLog(6, { id: 6, name: 'Soup' });
        expect(window.FoodLog.getCurrent()[6].name).toBe('Soup');
    });

    it('editFoodLog looks up the log via the FoodLog closure (not the deleted window.currentFoodLogs)', () => {
        const { window, document } = env;
        window.FoodLog.setCurrent({
            99: {
                id: 99,
                name: 'Test Food',
                barcode: 'X1',
                weight: 50,
                carbs: 5,
                protein: 2,
                fat: 1,
                calories: 50,
                eaten_at: '2026-04-20T08:15:00Z',
            }
        });

        window.editFoodLog(99);

        expect(document.getElementById('food-id').value).toBe('99');
        expect(document.getElementById('food-name').value).toBe('Test Food');
        expect(document.getElementById('food-barcode').value).toBe('X1');
    });

    it('multi-select state (mode + selected ids) flows through the FoodLog namespace', () => {
        const { window } = env;
        expect(window.FoodLog.multiSelectMode).toBe(false);
        expect(window.FoodLog.selectedCount()).toBe(0);

        window.FoodLog.multiSelectMode = true;
        window.FoodLog.addSelected(1);
        window.FoodLog.addSelected(2);
        expect(window.FoodLog.selectedCount()).toBe(2);
        expect(window.FoodLog.hasSelected(1)).toBe(true);
        expect(window.FoodLog.getSelectedIds().sort()).toEqual([1, 2]);

        window.FoodLog.deleteSelected(1);
        expect(window.FoodLog.hasSelected(1)).toBe(false);

        window.FoodLog.clearSelected();
        expect(window.FoodLog.selectedCount()).toBe(0);
    });

    it('window.foodTargets remains the canonical alias for the closure-private targets state', () => {
        const { window } = env;
        // window.foodTargets is defined as a getter/setter on the log.js closure.
        window.FoodLog.targets = { calories: 2200, carbs: 250, protein: 150, fat: 70 };
        expect(window.foodTargets.calories).toBe(2200);

        // Direct assignment to window.foodTargets routes through the setter.
        window.foodTargets = { calories: 1800, carbs: 200, protein: 120, fat: 60 };
        expect(window.FoodLog.targets.calories).toBe(1800);
    });
});
