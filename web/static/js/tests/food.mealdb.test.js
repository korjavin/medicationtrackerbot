// Wandergeek Food → Meal DB sub-tab panel (Phase 4 follow-up, Task 5).
//
// Asserts the "My meals" sub-tab shell and its row renderer use the
// Wandergeek primitives — `.wg-food-db-panel` panel wrapper, `.wg-card`
// + `.wg-food-db-card` meal rows, and a token-driven empty state — so
// the panel matches the Daily log's visual rhythm instead of the legacy
// paper-era card look.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('Food → Meal DB panel (Phase 4 follow-up, Task 5)', () => {
    let env;

    // loadMyMeals() reads the module-scoped `foodProductsCache` inside
    // food.js — which we can't set from outside. To seed it we mock
    // `window.MedTrackerDB.FoodProductsStore.getCache`, which the real
    // `initFoodProductsCache()` calls first and uses to populate the
    // closure variable.
    function seedCache(items) {
        env.window.MedTrackerDB = {
            FoodProductsStore: {
                getCache: vi.fn().mockResolvedValue(items),
                saveCache: vi.fn().mockResolvedValue(undefined),
                clearCache: vi.fn().mockResolvedValue(undefined),
            },
        };
    }

    beforeEach(() => {
        env = loadFrontendEnv();
        env.window.apiCall = vi.fn().mockResolvedValue({ products: [] });
        env.window.safeAlert = vi.fn();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('panel root carries the Wandergeek .wg-food-db-panel shell class', () => {
        // Phase 5, Task 4 — the outer food-tab-content wrapper was retired
        // along with the subtab strip; the panel now lives inside the
        // collapsible #food-library-view alongside `.wg-food-db-panel`.
        const { document } = env;
        const panel = document.getElementById('food-meals-tab');
        expect(panel).not.toBeNull();
        expect(panel.classList.contains('wg-food-db-panel')).toBe(true);
        const libraryView = document.getElementById('food-library-view');
        expect(libraryView).not.toBeNull();
        expect(libraryView.contains(panel)).toBe(true);
    });

    it('hint paragraph uses the .wg-food-db-panel__hint token class, no inline style', () => {
        const { document } = env;
        const hint = document.querySelector('#food-meals-tab .wg-food-db-panel__hint');
        expect(hint).not.toBeNull();
        expect(hint.getAttribute('style')).toBeNull();
        expect(hint.textContent).toContain('Select items from your log');
    });

    it('meals list container carries the .wg-food-db-panel__list class', () => {
        const { document } = env;
        const list = document.getElementById('food-meals-list');
        expect(list).not.toBeNull();
        expect(list.classList.contains('wg-food-db-panel__list')).toBe(true);
    });

    it('loadMyMeals renders an empty state with .wg-food-db-panel__empty when cache is empty', async () => {
        const { window, document } = env;
        seedCache([]);
        await window.loadMyMeals();
        const list = document.getElementById('food-meals-list');
        const empty = list.querySelector('.wg-food-db-panel__empty');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toContain("haven't created any meals yet");
    });

    it('loadMyMeals renders each meal as a .wg-card .wg-food-db-card row with WG class structure', async () => {
        const { window, document } = env;
        const meals = [
            {
                id: 11,
                name: 'Oatmeal + berries',
                is_meal: true,
                energy_kcal_100g: 100,
                carbs_100g: 15,
                protein_100g: 4,
                fat_100g: 2,
                total_weight_g: 250,
            },
            {
                id: 12,
                name: 'Chicken bowl',
                is_meal: true,
                energy_kcal_100g: 180,
                carbs_100g: 12,
                protein_100g: 20,
                fat_100g: 6,
                total_weight_g: 400,
            },
        ];
        seedCache(meals);
        await window.loadMyMeals();

        const list = document.getElementById('food-meals-list');
        const cards = list.querySelectorAll('.wg-food-db-card');
        expect(cards).toHaveLength(2);

        cards.forEach((card) => {
            expect(card.classList.contains('wg-card')).toBe(true);
            expect(card.classList.contains('wg-food-db-card')).toBe(true);
            expect(card.getAttribute('style')).toBeNull();

            // Header + nutrition row mounted as before, but now restyled
            // via WG tokens (legacy class names retained for the arch test).
            expect(card.querySelector('.food-meal-header')).not.toBeNull();
            expect(card.querySelector('.food-meal-name')).not.toBeNull();
            expect(card.querySelector('.food-nutrition-row')).not.toBeNull();
            expect(card.querySelector('.food-meal-actions')).not.toBeNull();
        });

        // First meal: weight 250g, 100kcal/100g → 250kcal.
        const first = cards[0];
        expect(first.querySelector('.food-meal-name').textContent).toBe('Oatmeal + berries');
        expect(first.querySelector('.food-nutrition-row').textContent).toContain('250');
    });

    it('edit + delete action buttons are mounted inside .food-meal-actions', async () => {
        const { window, document } = env;
        const meals = [
            {
                id: 11,
                name: 'Oatmeal',
                is_meal: true,
                energy_kcal_100g: 100,
                carbs_100g: 15,
                protein_100g: 4,
                fat_100g: 2,
                total_weight_g: 250,
            },
        ];
        seedCache(meals);
        await window.loadMyMeals();

        const actions = document.querySelector('#food-meals-list .food-meal-actions');
        expect(actions).not.toBeNull();

        const buttons = actions.querySelectorAll('button');
        expect(buttons.length).toBe(2);
        const labels = Array.from(buttons).map((b) => b.textContent);
        expect(labels).toContain('✏️');
        expect(labels).toContain('🗑️');
    });
});
