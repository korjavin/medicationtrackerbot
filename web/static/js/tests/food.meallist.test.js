// Wandergeek Food meal-grouped item list (Phase 4, Task 5; Round-2 Task 3).
//
// Asserts that the daily-log render path renders each meal as a
// `.wg-food-meal-group` with a `.wg-section-label` header + trailing mono
// kcal total, each item as a `.wg-card` row carrying name/grams/kcal/P-F,
// preserves offline-pending + rejected badge states as `.wg-tag--mono`
// variants, and wires the edit/delete icon buttons to the existing handlers.
//
// Round-2 Task 3 removed the trailing `.wg-food-cta-dock`; the only Add
// affordance is `#add-food-inline-btn` in the day-nav header, matching
// `.local/design-reference/project/screens.jsx` FoodScreen. The meal list
// no longer mounts a second CTA after the last group.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

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

    it('no sticky Add-food CTA dock is rendered — only the header inline button remains', () => {
        // Round-2 Task 3: the bottom CTA was removed; Add-food affordance
        // is the `#add-food-inline-btn` inline pill in the day-nav.
        const { window, document } = env;
        window._renderFoodData(FIXTURE, null, 'day', '2026-04-20');

        expect(document.getElementById('food-add-cta-dock')).toBeNull();
        expect(document.querySelector('.wg-food-cta-dock')).toBeNull();
        expect(document.querySelector('.wg-food-add-cta')).toBeNull();

        const list = document.getElementById('food-list');
        expect(list.querySelector('.wg-food-add-cta')).toBeNull();
    });

    it('header #add-food-inline-btn click opens the add-food modal', () => {
        const { window, document } = env;
        window._renderFoodData(FIXTURE, null, 'day', '2026-04-20');

        const openSpy = vi.spyOn(window, 'showAddFoodModal').mockImplementation(() => {});
        const inline = document.getElementById('add-food-inline-btn');
        expect(inline).not.toBeNull();
        inline.click();
        expect(openSpy).toHaveBeenCalled();
        openSpy.mockRestore();
    });

    it('empty-state renders the hint paragraph without remounting a bottom CTA', () => {
        const { window, document } = env;
        window._renderFoodData([], null, 'day', '2026-04-20');

        const list = document.getElementById('food-list');
        expect(list.querySelector('.wg-food-meal-list__empty').textContent)
            .toContain('No food logs');
        expect(document.querySelector('.wg-food-add-cta')).toBeNull();
        expect(document.getElementById('food-add-cta-dock')).toBeNull();
    });

    it('weekly macros render does not introduce a bottom CTA', () => {
        // Phase 5, Task 4 kept the meal list always-daily when the macros
        // card flips to Weekly. Round-2 Task 3 removed the trailing CTA
        // entirely — the inline header button is the only Add affordance
        // regardless of range.
        const { window, document } = env;
        const weekStats = { calories: 3000, carbs: 320, protein: 180, fat: 110 };
        window._renderFoodData([], weekStats, 'week', '2026-04-20');

        expect(document.getElementById('food-add-cta-dock')).toBeNull();
        expect(document.querySelector('.wg-food-add-cta')).toBeNull();
    });

    it('loadFoodLogs() does not remount a removed Add-food CTA dock', async () => {
        // Regression guard for Round-2 Task 3: previously loadFoodLogs()
        // preseeded the sticky dock on every call. That dock is now gone;
        // loadFoodLogs() must complete cleanly without synthesizing it.
        const { window, document } = env;

        window.loadFoodTargets = async () => {};
        window.DataStore.getCached = async () => null;
        window.DataStore.setCached = async () => {};
        window.apiCall = async () => null;

        await window.loadFoodLogs();
        expect(document.getElementById('food-add-cta-dock')).toBeNull();
        expect(document.querySelector('.wg-food-add-cta')).toBeNull();
    });

    it('loadFoodLogs() does not remount a CTA when the daily fetch fails without cache', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        window.loadFoodTargets = async () => {};
        window.DataStore.getCached = async () => null;
        window.DataStore.setCached = async () => {};
        window.apiCall = async () => { throw new Error('network'); };

        await window.loadFoodLogs();
        expect(document.getElementById('food-add-cta-dock')).toBeNull();
        expect(document.querySelector('.wg-food-add-cta')).toBeNull();
    });

    it('selects the correct log into window.FoodLog by id', () => {
        const { window } = env;
        window._renderFoodData(FIXTURE, null, 'day', '2026-04-20');

        expect(window.FoodLog.getCurrent()[1].name).toBe('Oatmeal');
        expect(window.FoodLog.getCurrent()[3].name).toBe('Apple');
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
