// Wandergeek Food → Food DB sub-tab panel (Phase 4 follow-up, Task 5).
//
// Asserts the Food DB sub-tab shell uses the Wandergeek primitives —
// `.wg-food-db-panel` wrapper, `.wg-input` search, `.wg-gloss--inset`
// sort strip with `.wg-gloss` pills (active pill also wearing
// `.wg-gloss--sun`), and `.wg-card .wg-food-db-card` product rows. Also
// asserts that loading / empty / error states render the token-driven
// `.wg-food-db-panel__empty` hint instead of the legacy `.hint` class.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('Food → Food DB panel (Phase 4 follow-up, Task 5)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
        env.window.safeAlert = vi.fn();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('panel root carries the Wandergeek .wg-food-db-panel shell class', () => {
        const { document } = env;
        const panel = document.getElementById('food-fooddb-tab');
        expect(panel).not.toBeNull();
        expect(panel.classList.contains('wg-food-db-panel')).toBe(true);
        expect(panel.classList.contains('food-tab-content')).toBe(true);
    });

    it('search input uses the .wg-input token class and has no inline style', () => {
        const { document } = env;
        const search = document.getElementById('fooddb-search');
        expect(search).not.toBeNull();
        expect(search.classList.contains('wg-input')).toBe(true);
        expect(search.classList.contains('wg-food-db-panel__search')).toBe(true);
        expect(search.getAttribute('style')).toBeNull();
    });

    it('sort strip is a .wg-gloss--inset container with three .wg-gloss pills', () => {
        const { document } = env;
        const strip = document.querySelector('#food-fooddb-tab .fooddb-sort-controls');
        expect(strip).not.toBeNull();
        expect(strip.classList.contains('wg-gloss--inset')).toBe(true);
        expect(strip.classList.contains('wg-food-db-panel__sort')).toBe(true);
        expect(strip.getAttribute('style')).toBeNull();

        const pills = strip.querySelectorAll('.fooddb-sort-btn');
        expect(pills).toHaveLength(3);
        pills.forEach((btn) => {
            expect(btn.classList.contains('wg-gloss')).toBe(true);
            expect(btn.classList.contains('wg-food-db-panel__sort-btn')).toBe(true);
            // No legacy paper-era button classes.
            expect(btn.classList.contains('btn')).toBe(false);
            expect(btn.classList.contains('btn-secondary')).toBe(false);
            expect(btn.classList.contains('btn-pill')).toBe(false);
        });
    });

    it('default active sort pill wears .wg-gloss--sun + aria-pressed=true', () => {
        const { document } = env;
        const pills = document.querySelectorAll('#food-fooddb-tab .fooddb-sort-btn');
        const active = Array.from(pills).find((b) => b.classList.contains('active'));
        expect(active).not.toBeUndefined();
        expect(active.dataset.sort).toBe('usage');
        expect(active.classList.contains('wg-gloss--sun')).toBe(true);
        expect(active.getAttribute('aria-pressed')).toBe('true');

        const inactive = Array.from(pills).filter((b) => !b.classList.contains('active'));
        inactive.forEach((btn) => {
            expect(btn.classList.contains('wg-gloss--sun')).toBe(false);
            expect(btn.getAttribute('aria-pressed')).toBe('false');
        });
    });

    it('clicking a sort pill moves .wg-gloss--sun + aria-pressed to it', () => {
        const { window, document } = env;
        // loadFoodDB reaches for apiCall / DataStore; stub to no-op so the
        // click handler can complete without network I/O.
        window.loadFoodDB = vi.fn();

        const pills = document.querySelectorAll('#food-fooddb-tab .fooddb-sort-btn');
        const nameBtn = Array.from(pills).find((b) => b.dataset.sort === 'name');
        nameBtn.click();

        pills.forEach((btn) => {
            const isActive = btn.dataset.sort === 'name';
            expect(btn.classList.contains('active')).toBe(isActive);
            expect(btn.classList.contains('wg-gloss--sun')).toBe(isActive);
            expect(btn.getAttribute('aria-pressed')).toBe(isActive ? 'true' : 'false');
        });
    });

    it('renderFoodDBList mounts each product as a .wg-card .wg-food-db-card row', () => {
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
            {
                id: 2,
                name: 'Chicken breast',
                carbs_100g: 0,
                protein_100g: 31,
                fat_100g: 3.6,
                energy_kcal_100g: 165,
                usage_count: 7,
                is_meal: false,
            },
        ];
        window.renderFoodDBList(products, products.length);

        const list = document.getElementById('fooddb-list');
        const cards = list.querySelectorAll('.wg-food-db-card');
        expect(cards).toHaveLength(2);

        cards.forEach((card) => {
            expect(card.classList.contains('wg-card')).toBe(true);
            expect(card.classList.contains('wg-food-db-card')).toBe(true);
            expect(card.getAttribute('style')).toBeNull();
            // Required legacy class names (architecture test) still present
            // on inner elements so reskin doesn't regress the expected DOM.
            expect(card.querySelector('.food-db-actions-row')).not.toBeNull();
            expect(card.querySelector('.food-db-info')).not.toBeNull();
            expect(card.querySelector('.food-db-name')).not.toBeNull();
            expect(card.querySelector('.food-db-macros')).not.toBeNull();
            expect(card.querySelector('.food-db-meta')).not.toBeNull();
        });
    });

    it('renderFoodDBList empty-state uses .wg-food-db-panel__empty (not legacy .hint)', () => {
        const { window, document } = env;
        window.renderFoodDBList([], 0);

        const list = document.getElementById('fooddb-list');
        const empty = list.querySelector('.wg-food-db-panel__empty');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toContain('No products found');
        // No paper-era .hint fallback in the list.
        expect(list.querySelector('.hint')).toBeNull();
    });

    it('pagination dock uses .wg-food-db-panel__pagination + .wg-gloss page buttons', () => {
        const { document } = env;
        const dock = document.getElementById('fooddb-pagination');
        expect(dock).not.toBeNull();
        expect(dock.classList.contains('wg-food-db-panel__pagination')).toBe(true);

        const prev = document.getElementById('fooddb-prev-btn');
        const next = document.getElementById('fooddb-next-btn');
        [prev, next].forEach((btn) => {
            expect(btn.classList.contains('wg-gloss')).toBe(true);
            expect(btn.classList.contains('wg-food-db-panel__page-btn')).toBe(true);
            expect(btn.classList.contains('btn-secondary')).toBe(false);
        });
    });

    it('index.html uses no inline style attributes inside the Food DB panel', () => {
        const { document } = env;
        const panel = document.getElementById('food-fooddb-tab');
        // Walk every element in the Food DB panel; none should carry a
        // style= attribute — the Phase 4 restyle must push visual values
        // into WG token classes instead.
        const nodes = panel.querySelectorAll('*');
        nodes.forEach((node) => {
            expect(node.getAttribute('style')).toBeNull();
        });
    });
});
