// Wandergeek Food meal-grouped item list (Phase 4, Task 5).
//
// Asserts that the daily-log render path renders each meal as a
// `.wg-food-meal-group` with a `.wg-section-label` header + trailing mono
// kcal total, each item as a `.wg-card` row carrying name/grams/kcal/P-F,
// preserves offline-pending + rejected badge states as `.wg-tag--mono`
// variants, wires the edit/delete icon buttons to the existing handlers,
// and appends a full-width `.wg-gloss--sun` "Add food" CTA after the last
// meal group on day-period renders.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const FIXTURE = [
    {
        name: 'Breakfast',
        time: '08:15',
        calories: 420,
        carbs: 55,
        protein: 22,
        fat: 10,
        logs: [
            {
                id: 1,
                name: 'Oatmeal',
                weight: 200,
                calories: 320,
                carbs: 50,
                protein: 12,
                fat: 6,
                eaten_at: '2026-04-20T08:15:00Z'
            },
            {
                id: 2,
                name: 'Espresso',
                weight: 30,
                calories: 5,
                carbs: 1,
                protein: 0,
                fat: 0,
                eaten_at: '2026-04-20T08:20:00Z'
            }
        ]
    },
    {
        name: 'Snack',
        time: '11:30',
        calories: 180,
        carbs: 22,
        protein: 6,
        fat: 8,
        logs: [
            {
                id: 3,
                name: 'Apple',
                weight: 180,
                calories: 95,
                carbs: 25,
                protein: 0.5,
                fat: 0.3,
                eaten_at: '2026-04-20T11:30:00Z'
            }
        ]
    }
];

describe('Food meal-grouped item list (Phase 4, Task 5)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renders one .wg-food-meal-group per meal with a .wg-section-label header', () => {
        const { window, document } = env;
        window._renderFoodData(FIXTURE, null, 'day', '2026-04-20');

        const groups = document.querySelectorAll('#food-list .wg-food-meal-group');
        expect(groups).toHaveLength(2);

        const headers = Array.from(groups).map(g =>
            g.querySelector('.wg-section-label.wg-food-meal-group__header')
        );
        headers.forEach(h => expect(h).not.toBeNull());

        expect(headers[0].querySelector('.wg-food-meal-group__title').textContent)
            .toBe('Breakfast · 08:15');
        expect(headers[1].querySelector('.wg-food-meal-group__title').textContent)
            .toBe('Snack · 11:30');
    });

    it('trailing mono kcal total shows rounded group calories', () => {
        const { window, document } = env;
        window._renderFoodData(FIXTURE, null, 'day', '2026-04-20');

        const totals = document.querySelectorAll(
            '#food-list .wg-food-meal-group__total'
        );
        expect(totals[0].classList.contains('wg-mono-display')).toBe(true);
        expect(totals[0].textContent).toBe('420 kcal');
        expect(totals[1].textContent).toBe('180 kcal');
    });

    it('each logged item renders as a .wg-card .wg-food-item-row with name + grams + kcal + macros', () => {
        const { window, document } = env;
        window._renderFoodData(FIXTURE, null, 'day', '2026-04-20');

        const rows = document.querySelectorAll('#food-list .wg-food-item-row');
        expect(rows).toHaveLength(3);
        rows.forEach(row => expect(row.classList.contains('wg-card')).toBe(true));

        const first = rows[0];
        expect(first.getAttribute('data-log-id')).toBe('1');
        expect(first.querySelector('.wg-food-item-row__name').textContent).toBe('Oatmeal');
        expect(first.querySelector('.wg-food-item-row__grams').textContent).toBe('200g');
        const kcal = first.querySelector('.wg-food-item-row__kcal');
        expect(kcal.classList.contains('wg-mono-display')).toBe(true);
        expect(kcal.textContent).toBe('320 kcal');
        expect(first.querySelector('.wg-food-item-row__macros').textContent)
            .toBe('P 12 / F 6');
    });

    it('offline-pending logs get a .wg-tag.wg-tag--mono.wg-tag--pending badge', () => {
        const { window, document } = env;
        const groups = [
            {
                name: 'Lunch',
                time: '12:30',
                calories: 400,
                carbs: 45,
                protein: 25,
                fat: 10,
                logs: [
                    {
                        id: 10,
                        name: 'Local entry',
                        weight: 200,
                        calories: 400,
                        carbs: 45,
                        protein: 25,
                        fat: 10,
                        eaten_at: '2026-04-20T12:30:00Z',
                        isLocal: true
                    }
                ]
            }
        ];
        window._renderFoodData(groups, null, 'day', '2026-04-20');

        const row = document.querySelector('#food-list .wg-food-item-row');
        expect(row.classList.contains('wg-food-item-row--pending')).toBe(true);

        const tag = row.querySelector('.wg-tag.wg-tag--mono.wg-tag--pending');
        expect(tag).not.toBeNull();
        expect(tag.textContent).toBe('Pending');
    });

    it('rejected logs get a .wg-tag.wg-tag--mono.wg-tag--rejected badge with tooltip', () => {
        const { window, document } = env;
        const groups = [
            {
                name: 'Dinner',
                time: '19:00',
                calories: 600,
                carbs: 60,
                protein: 30,
                fat: 20,
                logs: [
                    {
                        id: 11,
                        name: 'Rejected entry',
                        weight: 300,
                        calories: 600,
                        carbs: 60,
                        protein: 30,
                        fat: 20,
                        eaten_at: '2026-04-20T19:00:00Z',
                        isRejected: true,
                        errorMessage: 'HTTP 400 — bad payload'
                    }
                ]
            }
        ];
        window._renderFoodData(groups, null, 'day', '2026-04-20');

        const row = document.querySelector('#food-list .wg-food-item-row');
        expect(row.classList.contains('wg-food-item-row--rejected')).toBe(true);

        const tag = row.querySelector('.wg-tag.wg-tag--mono.wg-tag--rejected');
        expect(tag).not.toBeNull();
        expect(tag.textContent).toBe('Failed');
        expect(tag.title).toBe('HTTP 400 — bad payload');
    });

    it('edit-icon click invokes editFoodLog without bubbling to the row handler', () => {
        const { window, document } = env;
        window._renderFoodData(FIXTURE, null, 'day', '2026-04-20');

        const editSpy = vi.spyOn(window, 'editFoodLog').mockImplementation(() => {});
        const row = document.querySelector(
            '#food-list .wg-food-item-row[data-log-id="1"]'
        );
        const editBtn = row.querySelector(
            '.wg-food-item-row__actions .wg-icon-btn[data-icon="pencil"]'
        );
        expect(editBtn).not.toBeNull();
        editBtn.click();
        expect(editSpy).toHaveBeenCalledWith(1);
        editSpy.mockRestore();
    });

    it('delete-icon click invokes deleteFoodLog without bubbling to the row handler', () => {
        const { window, document } = env;
        window._renderFoodData(FIXTURE, null, 'day', '2026-04-20');

        const deleteSpy = vi.spyOn(window, 'deleteFoodLog').mockImplementation(() => {});
        const row = document.querySelector(
            '#food-list .wg-food-item-row[data-log-id="3"]'
        );
        const delBtn = row.querySelector(
            '.wg-food-item-row__actions .wg-icon-btn[data-icon="trash"]'
        );
        expect(delBtn).not.toBeNull();
        delBtn.click();
        expect(deleteSpy).toHaveBeenCalledWith(3);
        deleteSpy.mockRestore();
    });

    it('row click (outside actions) still opens the edit flow', () => {
        const { window, document } = env;
        window._renderFoodData(FIXTURE, null, 'day', '2026-04-20');

        const editSpy = vi.spyOn(window, 'editFoodLog').mockImplementation(() => {});
        const row = document.querySelector(
            '#food-list .wg-food-item-row[data-log-id="2"]'
        );
        row.click();
        expect(editSpy).toHaveBeenCalledWith(2);
        editSpy.mockRestore();
    });

    it('mounts a full-width .wg-gloss--sun Add-food CTA into the sticky dock (day period)', () => {
        const { window, document } = env;
        window._renderFoodData(FIXTURE, null, 'day', '2026-04-20');

        const dock = document.getElementById('food-add-cta-dock');
        expect(dock).not.toBeNull();
        expect(dock.classList.contains('wg-food-cta-dock')).toBe(true);
        expect(dock.classList.contains('hidden')).toBe(false);

        const cta = dock.querySelector('.wg-food-add-cta');
        expect(cta).not.toBeNull();
        expect(cta.classList.contains('wg-gloss')).toBe(true);
        expect(cta.classList.contains('wg-gloss--sun')).toBe(true);
        expect(cta.textContent).toContain('Add food');

        // CTA must NOT live inside the scrolling #food-list — it lives in
        // the sibling sticky dock so it stays pinned during scroll.
        const list = document.getElementById('food-list');
        expect(list.querySelector('.wg-food-add-cta')).toBeNull();
    });

    it('CTA dock is a sibling of #food-list inside #food-log-tab', () => {
        const { document } = env;
        const dock = document.getElementById('food-add-cta-dock');
        const list = document.getElementById('food-list');
        const tab = document.getElementById('food-log-tab');
        expect(dock.parentElement).toBe(tab);
        expect(list.parentElement).toBe(tab);
    });

    it('Add-food CTA click opens the add-food modal', () => {
        const { window, document } = env;
        window._renderFoodData(FIXTURE, null, 'day', '2026-04-20');

        const openSpy = vi.spyOn(window, 'showAddFoodModal').mockImplementation(() => {});
        document.querySelector('#food-add-cta-dock .wg-food-add-cta').click();
        expect(openSpy).toHaveBeenCalled();
        openSpy.mockRestore();
    });

    it('empty-state renders the hint paragraph and still shows the Add-food CTA in the dock', () => {
        const { window, document } = env;
        window._renderFoodData([], null, 'day', '2026-04-20');

        const list = document.getElementById('food-list');
        expect(list.querySelector('.wg-food-meal-list__empty').textContent)
            .toContain('No food logs');
        const dock = document.getElementById('food-add-cta-dock');
        expect(dock.querySelector('.wg-food-add-cta')).not.toBeNull();
    });

    it('week period render omits the Add-food CTA and hides the dock', () => {
        const { window, document } = env;
        const weekStats = { calories: 3000, carbs: 320, protein: 180, fat: 110 };
        window._renderFoodData([], weekStats, 'week', '2026-04-20');

        const list = document.getElementById('food-list');
        expect(list.querySelector('.wg-food-add-cta')).toBeNull();
        const dock = document.getElementById('food-add-cta-dock');
        expect(dock.querySelector('.wg-food-add-cta')).toBeNull();
        expect(dock.classList.contains('hidden')).toBe(true);
    });

    it('selects the correct log into currentFoodLogs by id', () => {
        const { window } = env;
        window._renderFoodData(FIXTURE, null, 'day', '2026-04-20');

        expect(window.currentFoodLogs[1].name).toBe('Oatmeal');
        expect(window.currentFoodLogs[3].name).toBe('Apple');
    });

    it('handles a group with missing logs array without throwing', () => {
        const { window, document } = env;
        const groups = [{ name: 'Breakfast', time: '08:00', calories: 0, carbs: 0, protein: 0, fat: 0 }];
        expect(() => window._renderFoodData(groups, null, 'day', '2026-04-20')).not.toThrow();

        const list = document.getElementById('food-list');
        expect(list.querySelector('.wg-food-meal-group')).not.toBeNull();
        expect(list.querySelectorAll('.wg-food-item-row')).toHaveLength(0);
    });

    it('falls back to "Meal" header when group.name is missing', () => {
        const { window, document } = env;
        const groups = [{
            name: '',
            time: '09:00',
            calories: 0, carbs: 0, protein: 0, fat: 0,
            logs: []
        }];
        window._renderFoodData(groups, null, 'day', '2026-04-20');

        const header = document.querySelector('#food-list .wg-food-meal-group__header');
        expect(header).not.toBeNull();
        expect(header.textContent).toContain('Meal');
    });
});
