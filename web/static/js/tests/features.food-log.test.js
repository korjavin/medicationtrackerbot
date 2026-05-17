// Focused integration tests for the extracted features/food/log.js
// sub-file. Covers the public-API surface of window.FoodLog and the
// closure-private currentFoodLogs accessor that replaced the deleted
// `var currentFoodLogs = {}` global from app.js:1079.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

// Wires a Map-backed ApiCache into the env so DataStore.applyOptimistic
// reads/writes are observable in tests. Mirrors the helper used by the
// workout/optimistic suites.
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

    // ===========================================================================
    // Optimistic write conversion (Plan 2026-05-17 Task 4)
    //
    // saveFoodLog + deleteFoodLog must update the cached per-day food payloads
    // (`food_<date>_v2` + Today's `food_<date>_day`) BEFORE the network round-trip
    // resolves, then roll back on failure.
    // ===========================================================================

    function isoDate(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${dd}`;
    }

    it('saveFoodLog (create) appends optimistically to food_<date>_v2 + food_<date>_day before the POST resolves', async () => {
        const { window, document } = env;
        const now = new Date();
        const dateStr = isoDate(now);
        const v2Key = `food_${dateStr}_v2`;
        const dayKey = `food_${dateStr}_day`;

        const cache = installApiCache(window, {
            [v2Key]: { groups: [], weekStats: null },
            [dayKey]: { groups: [] }
        });

        document.getElementById('food-datetime').value =
            `${dateStr}T12:30`;
        document.getElementById('food-name').value = 'Banana';
        document.getElementById('food-weight').value = '100';
        document.getElementById('food-carbs').value = '23';
        document.getElementById('food-protein').value = '1';
        document.getElementById('food-fat').value = '0';
        document.getElementById('food-calories').value = '90';
        document.getElementById('food-per-100g').checked = false;
        document.getElementById('food-id').value = '';

        // Block the POST behind a deferred so we can assert the optimistic
        // cache writes happened before the network call resolves.
        let apiCallSignal;
        const apiCalled = new Promise((r) => { apiCallSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (endpoint) => {
            if (endpoint === '/api/food/log') {
                apiCallSignal();
                return pending.promise;
            }
            return null;
        });
        window.loadFoodLogs = vi.fn();

        const handlerDone = window.saveFoodLog();
        // Wait until the POST fires — by then both applyOptimistic calls have
        // settled. Yielding fixed microtask counts is fragile because each
        // applyOptimistic has multiple internal awaits.
        await apiCalled;

        const v2 = cache.get(v2Key);
        expect(v2).toBeTruthy();
        expect(v2.groups.length).toBe(1);
        expect(v2.groups[0].logs[0].name).toBe('Banana');
        expect(v2.groups[0].calories).toBe(90);

        const day = cache.get(dayKey);
        expect(day).toBeTruthy();
        expect(day.groups.length).toBe(1);
        expect(day.groups[0].logs[0].name).toBe('Banana');
        expect(day.groups[0].calories).toBe(90);

        pending.resolve({ status: 'created', id: 777 });
        await handlerDone;
    });

    it('saveFoodLog rolls back the optimistic cache write when the POST returns null', async () => {
        const { window, document } = env;
        const now = new Date();
        const dateStr = isoDate(now);
        const v2Key = `food_${dateStr}_v2`;
        const dayKey = `food_${dateStr}_day`;

        const cache = installApiCache(window, {
            [v2Key]: { groups: [], weekStats: null },
            [dayKey]: { groups: [] }
        });

        document.getElementById('food-datetime').value =
            `${dateStr}T13:00`;
        document.getElementById('food-name').value = 'Apple';
        document.getElementById('food-weight').value = '150';
        document.getElementById('food-carbs').value = '20';
        document.getElementById('food-protein').value = '1';
        document.getElementById('food-fat').value = '0';
        document.getElementById('food-calories').value = '80';
        document.getElementById('food-per-100g').checked = false;
        document.getElementById('food-id').value = '';

        window.apiCall = vi.fn(async (endpoint) => {
            if (endpoint === '/api/food/log') return null;
            return null;
        });
        window.loadFoodLogs = vi.fn();

        await window.saveFoodLog();

        // The contract: the optimistic Apple row must not survive POST failure.
        // applyOptimistic.rollback restores the prior snapshot AND invalidates
        // tags so the next read goes to network. Either outcome (snapshot
        // restored OR cache evicted) is acceptable; the regression is the
        // optimistic state surviving.
        const v2 = cache.get(v2Key);
        if (v2) expect(v2.groups).toEqual([]);
        const day = cache.get(dayKey);
        if (day) expect(day.groups).toEqual([]);
    });

    it('deleteFoodLog drops the row from the cached groups before the DELETE resolves', async () => {
        const { window } = env;
        const now = new Date();
        const dateStr = isoDate(now);
        const v2Key = `food_${dateStr}_v2`;
        const dayKey = `food_${dateStr}_day`;

        const seedGroups = [{
            name: 'Lunch',
            time: '12:00',
            calories: 500,
            carbs: 50,
            protein: 30,
            fat: 15,
            logs: [
                { id: 11, name: 'Rice', weight: 200, calories: 300, carbs: 40, protein: 5, fat: 5 },
                { id: 12, name: 'Tofu', weight: 100, calories: 200, carbs: 10, protein: 25, fat: 10 }
            ]
        }];
        const cache = installApiCache(window, {
            [v2Key]: { groups: JSON.parse(JSON.stringify(seedGroups)), weekStats: null },
            [dayKey]: { groups: JSON.parse(JSON.stringify(seedGroups)) }
        });

        window.safeConfirm = (_msg, cb) => Promise.resolve(cb(true));

        const pending = deferred();
        window.apiCall = vi.fn(async (endpoint, method) => {
            if (endpoint === '/api/food/log/11' && method === 'DELETE') return pending.promise;
            return null;
        });
        window.loadFoodLogs = vi.fn();

        const dateFilter = window.document.getElementById('food-date-filter');
        if (dateFilter) dateFilter.value = dateStr;

        let apiCallSignal;
        const apiCalled = new Promise((r) => { apiCallSignal = r; });
        window.apiCall = vi.fn(async (endpoint, method) => {
            if (endpoint === '/api/food/log/11' && method === 'DELETE') {
                apiCallSignal();
                return pending.promise;
            }
            return null;
        });

        const handlerDone = window.deleteFoodLog(11);
        await apiCalled;

        const v2 = cache.get(v2Key);
        expect(v2.groups[0].logs.length).toBe(1);
        expect(v2.groups[0].logs[0].id).toBe(12);
        expect(v2.groups[0].calories).toBe(200);

        const day = cache.get(dayKey);
        expect(day.groups[0].logs.length).toBe(1);
        expect(day.groups[0].logs[0].id).toBe(12);

        pending.resolve(true);
        await handlerDone;
    });

    it('deleteFoodLog restores the cached groups when the DELETE returns null', async () => {
        const { window } = env;
        const now = new Date();
        const dateStr = isoDate(now);
        const v2Key = `food_${dateStr}_v2`;

        const seedGroups = [{
            name: 'Lunch',
            time: '12:00',
            calories: 500,
            carbs: 50,
            protein: 30,
            fat: 15,
            logs: [{ id: 21, name: 'Pasta', weight: 200, calories: 500, carbs: 50, protein: 30, fat: 15 }]
        }];
        const cache = installApiCache(window, {
            [v2Key]: { groups: JSON.parse(JSON.stringify(seedGroups)), weekStats: null }
        });

        window.safeConfirm = (_msg, cb) => Promise.resolve(cb(true));
        window.apiCall = vi.fn(async () => null);
        window.loadFoodLogs = vi.fn();

        const dateFilter = window.document.getElementById('food-date-filter');
        if (dateFilter) dateFilter.value = dateStr;

        await window.deleteFoodLog(21);

        // The contract: the optimistic delete must not survive POST failure.
        // applyOptimistic.rollback restores the prior snapshot then invalidates
        // tags so the next read goes to network — either outcome (snapshot
        // restored OR cache evicted) is acceptable.
        const v2 = cache.get(v2Key);
        if (v2) {
            expect(v2.groups[0].logs.length).toBe(1);
            expect(v2.groups[0].logs[0].id).toBe(21);
        }
    });
});
