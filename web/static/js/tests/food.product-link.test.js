// CSP-safe product link in the edit-food modal.
//
// The deployed CSP (internal/server/server.go:373) contains no
// 'unsafe-inline' in script-src, so inline onclick="…" attributes are
// silently dropped by the browser. This test guards the replacement of
// the inline handler at features/food.js:1620 with an addEventListener-
// based wiring, and asserts the produced anchor never carries an inline
// onclick attribute.
//
// See docs/plans/2026-05-13-fix-food-inline-onclick.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('editFoodLog product-link wiring (CSP-safe)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
        env.window.initFoodProductsCache = vi.fn().mockResolvedValue(undefined);

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

    function seedLog(extra = {}) {
        const { window } = env;
        window.currentFoodLogs = {
            7: {
                id: 7,
                name: 'Oatmeal',
                weight: 100,
                carbs: 20,
                protein: 5,
                fat: 2,
                calories: 110,
                eaten_at: '2026-04-20T08:15:00Z',
                ...extra,
            }
        };
    }

    it('renders a clickable link (no inline onclick attribute) when product_id is set', () => {
        seedLog({ product_id: 42, is_meal: false });
        env.window.editFoodLog(7);

        const container = env.document.getElementById('food-product-link-container');
        expect(container.classList.contains('hidden')).toBe(false);

        const link = container.querySelector('a.food-product-link');
        expect(link).not.toBeNull();
        expect(link.getAttribute('href')).toBe('#');
        expect(link.textContent).toBe('→ View in Products');

        // Regression guard: the inline onclick attribute must NOT be set,
        // since the deployed CSP would silently drop it.
        expect(link.hasAttribute('onclick')).toBe(false);
        expect(link.getAttribute('onclick')).toBeNull();
    });

    it('renders meal label when is_meal is true', () => {
        seedLog({ product_id: 101, is_meal: true });
        env.window.editFoodLog(7);

        const link = env.document.querySelector('#food-product-link-container a.food-product-link');
        expect(link).not.toBeNull();
        expect(link.textContent).toBe('→ View Meal');
        expect(link.hasAttribute('onclick')).toBe(false);
    });

    it('clicking the link invokes navigateToFoodProduct with (event, productId, isMeal)', () => {
        seedLog({ product_id: 42, is_meal: false });
        const spy = vi.fn();
        env.window.navigateToFoodProduct = spy;

        env.window.editFoodLog(7);

        const link = env.document.querySelector('#food-product-link-container a.food-product-link');
        expect(link).not.toBeNull();

        link.click();

        expect(spy).toHaveBeenCalledTimes(1);
        const args = spy.mock.calls[0];
        expect(args[0]).toBeDefined();              // event
        expect(typeof args[0].preventDefault).toBe('function');
        expect(args[0].defaultPrevented).toBe(true); // listener called preventDefault
        expect(args[1]).toBe(42);
        expect(args[2]).toBe(false);
    });

    it('passes is_meal=true to navigateToFoodProduct for meal logs', () => {
        seedLog({ product_id: 99, is_meal: true });
        const spy = vi.fn();
        env.window.navigateToFoodProduct = spy;

        env.window.editFoodLog(7);
        const link = env.document.querySelector('#food-product-link-container a.food-product-link');
        link.click();

        expect(spy).toHaveBeenCalledTimes(1);
        const args = spy.mock.calls[0];
        expect(args[1]).toBe(99);
        expect(args[2]).toBe(true);
    });

    it('hides the container and clears its children when product_id is missing', () => {
        seedLog({ product_id: 0, is_meal: false });
        env.window.editFoodLog(7);

        const container = env.document.getElementById('food-product-link-container');
        expect(container.classList.contains('hidden')).toBe(true);
        expect(container.children.length).toBe(0);
        expect(container.querySelector('a.food-product-link')).toBeNull();
    });
});
