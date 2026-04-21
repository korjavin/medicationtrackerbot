// Wandergeek Food daily macros card (Phase 4, Task 4).
//
// Asserts that renderFoodMacrosCard() populates the #food-macros-card shell
// with a mono kcal total, a "NN% of target" sun value, and four WGMacroBar
// rows (Energy / Protein / Carbs / Fat). Empty-state calls collapse all
// bars to 0% (not hidden). Missing targets fall back to "—" in both the
// header percent and each bar's target suffix.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('Food daily macros card (Phase 4, Task 4)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    function callRender(window, totals, targets) {
        return window.renderFoodMacrosCard(
            totals.calories,
            totals.carbs,
            totals.protein,
            totals.fat,
            targets
        );
    }

    it('exposes renderFoodMacrosCard on window and renders the card shell', () => {
        const { window, document } = env;
        expect(typeof window.renderFoodMacrosCard).toBe('function');

        callRender(
            window,
            { calories: 500, carbs: 60, protein: 40, fat: 15 },
            { calories: 2000, carbs: 220, protein: 120, fat: 70 }
        );

        const card = document.getElementById('food-macros-card');
        expect(card).not.toBeNull();
        expect(card.classList.contains('wg-card')).toBe(true);
        expect(card.classList.contains('wg-food-macros-card')).toBe(true);
        expect(card.classList.contains('hidden')).toBe(false);
    });

    it('renders the mono kcal total and sun-tinted "% of target" header', () => {
        const { window, document } = env;
        callRender(
            window,
            { calories: 500, carbs: 60, protein: 40, fat: 15 },
            { calories: 2000, carbs: 220, protein: 120, fat: 70 }
        );

        const kcal = document.getElementById('food-macros-card-kcal');
        expect(kcal).not.toBeNull();
        expect(kcal.classList.contains('wg-mono-display')).toBe(true);
        expect(kcal.textContent).toBe('500');

        const percent = document.getElementById('food-macros-card-percent-value');
        expect(percent).not.toBeNull();
        expect(percent.textContent).toBe('25%');
    });

    it('renders exactly four macro bars in the Energy / Protein / Carbs / Fat order', () => {
        const { window, document } = env;
        callRender(
            window,
            { calories: 500, carbs: 60, protein: 40, fat: 15 },
            { calories: 2000, carbs: 220, protein: 120, fat: 70 }
        );

        const bars = document.querySelectorAll('#food-macros-card-bars .wg-macro-bar');
        expect(bars).toHaveLength(4);

        const labels = Array.from(bars).map(b => b.querySelector('.wg-macro-bar__label').textContent);
        expect(labels).toEqual(['Energy', 'Protein', 'Carbs', 'Fat']);

        const variants = Array.from(bars).map(b => {
            const fill = b.querySelector('.wg-macro-bar__fill');
            return Array.from(fill.classList).find(c => c.startsWith('wg-macro-bar__fill--'));
        });
        expect(variants).toEqual([
            'wg-macro-bar__fill--energy',
            'wg-macro-bar__fill--protein',
            'wg-macro-bar__fill--carbs',
            'wg-macro-bar__fill--fat',
        ]);
    });

    it('macro bar values and units match the primary fixture', () => {
        const { window, document } = env;
        callRender(
            window,
            { calories: 500, carbs: 60, protein: 40, fat: 15 },
            { calories: 2000, carbs: 220, protein: 120, fat: 70 }
        );

        const bars = document.querySelectorAll('#food-macros-card-bars .wg-macro-bar');
        const energyValue = bars[0].querySelector('.wg-macro-bar__value').textContent;
        expect(energyValue).toContain('500');
        expect(energyValue).toContain('/ 2000 kcal');

        const proteinValue = bars[1].querySelector('.wg-macro-bar__value').textContent;
        expect(proteinValue).toContain('40');
        expect(proteinValue).toContain('/ 120 g');

        const carbsValue = bars[2].querySelector('.wg-macro-bar__value').textContent;
        expect(carbsValue).toContain('60');
        expect(carbsValue).toContain('/ 220 g');

        const fatValue = bars[3].querySelector('.wg-macro-bar__value').textContent;
        expect(fatValue).toContain('15');
        expect(fatValue).toContain('/ 70 g');
    });

    it('empty state renders zeros and collapses bars to 0% (not hidden)', () => {
        const { window, document } = env;
        callRender(
            window,
            { calories: 0, carbs: 0, protein: 0, fat: 0 },
            { calories: 2000, carbs: 220, protein: 120, fat: 70 }
        );

        const card = document.getElementById('food-macros-card');
        expect(card.classList.contains('hidden')).toBe(false);

        expect(document.getElementById('food-macros-card-kcal').textContent).toBe('0');
        expect(document.getElementById('food-macros-card-percent-value').textContent).toBe('0%');

        const fills = document.querySelectorAll('#food-macros-card-bars .wg-macro-bar__fill');
        expect(fills).toHaveLength(4);
        fills.forEach(fill => {
            expect(fill.style.getPropertyValue('--fill-pct')).toBe('0%');
        });
    });

    it('missing targets fall back to "—" in header percent and bar target suffix', () => {
        const { window, document } = env;
        callRender(
            window,
            { calories: 400, carbs: 50, protein: 30, fat: 10 },
            { calories: 0, carbs: 0, protein: 0, fat: 0 }
        );

        expect(document.getElementById('food-macros-card-percent-value').textContent).toBe('—');

        const bars = document.querySelectorAll('#food-macros-card-bars .wg-macro-bar');
        bars.forEach(bar => {
            const target = bar.querySelector('.wg-macro-bar__value-target').textContent;
            expect(target).toContain('/ —');
        });
    });

    it('tolerates a missing / null targets argument without throwing', () => {
        const { window, document } = env;
        expect(() => callRender(
            window,
            { calories: 200, carbs: 20, protein: 10, fat: 5 },
            null
        )).not.toThrow();
        const percent = document.getElementById('food-macros-card-percent-value');
        expect(percent.textContent).toBe('—');
    });

    it('rounds non-integer totals to whole kcal in the header display', () => {
        const { window, document } = env;
        callRender(
            window,
            { calories: 499.7, carbs: 50, protein: 30, fat: 10 },
            { calories: 2000, carbs: 220, protein: 120, fat: 70 }
        );
        expect(document.getElementById('food-macros-card-kcal').textContent).toBe('500');
    });

    it('_renderFoodData populates the macros card on day view and hides legacy #food-summary', () => {
        const { window, document } = env;

        window._renderFoodData([], null, 'day', '2026-04-20');

        const card = document.getElementById('food-macros-card');
        expect(card.classList.contains('hidden')).toBe(false);
        expect(document.getElementById('food-macros-card-kcal').textContent).toBe('0');

        const summary = document.getElementById('food-summary');
        expect(summary.classList.contains('hidden')).toBe(true);

        const progress = document.getElementById('food-target-progress');
        expect(progress.classList.contains('hidden')).toBe(true);
        expect(progress.children).toHaveLength(0);
    });

    it('_renderFoodData hides the macros card when period is week', () => {
        const { window, document } = env;
        const groups = [];
        const weekStats = { calories: 3500, carbs: 400, protein: 250, fat: 100 };

        window._renderFoodData(groups, weekStats, 'week', '2026-04-20');

        const card = document.getElementById('food-macros-card');
        expect(card.classList.contains('hidden')).toBe(true);
    });
});
