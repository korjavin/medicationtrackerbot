// Food meal list (kit F1–F3, med-xso6.16).
//
// Each meal renders as a kit `.wg-section` (eyebrow "Meal · time" + kcal in
// the head) over a `.wg-list` of `.wg-row` items: title wraps, meta is
// "grams · P · F" plus the shared sync chip, kcal is the row value. Tap a row
// to edit; swipe / the overflow menu has Edit and Delete. An empty day is a
// `.wg-empty` with the fast-path shortcuts; Add in the app bar is the only
// primary and the list never mounts a second CTA.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clickRowAction, loadFrontendEnv } from './helpers/frontend-harness.js';
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

    it('renders one .wg-section per meal with an eyebrow head over a .wg-list', () => {
        const { window, document } = env;
        window._renderFoodData(FIXTURE, null, 'day', '2026-04-20');

        const groups = document.querySelectorAll('#food-list .wg-section.wg-food-meal-group');
        expect(groups).toHaveLength(2);
        groups.forEach(g => expect(g.querySelector(':scope > .wg-list')).not.toBeNull());

        const headers = Array.from(groups).map(g =>
            g.querySelector(':scope > .wg-section__head')
        );
        headers.forEach(h => expect(h).not.toBeNull());

        expect(headers[0].querySelector('.wg-food-meal-group__title').textContent)
            .toBe('Breakfast · 08:15');
        expect(headers[1].querySelector('.wg-food-meal-group__title').textContent)
            .toBe('Snack · 11:30');
    });

    it('the section head shows the rounded meal kcal', () => {
        const { window, document } = env;
        window._renderFoodData(FIXTURE, null, 'day', '2026-04-20');

        const totals = document.querySelectorAll(
            '#food-list .wg-food-meal-group__total'
        );
        expect(totals[0].classList.contains('wg-meta')).toBe(true);
        expect(totals[0].textContent).toBe('420 kcal');
        expect(totals[1].textContent).toBe('180 kcal');
    });

    it('each logged item renders as a .wg-row: title, "grams · P · F" meta, kcal value', () => {
        const { window, document } = env;
        window._renderFoodData(FIXTURE, null, 'day', '2026-04-20');

        const rows = document.querySelectorAll('#food-list .wg-row.wg-food-item-row');
        expect(rows).toHaveLength(3);

        const first = rows[0];
        expect(first.getAttribute('data-log-id')).toBe('1');
        expect(first.querySelector('.wg-row__title').textContent).toBe('Oatmeal');
        expect(first.querySelector('.wg-row__meta').textContent).toBe('200 g · P 12 · F 6');
        const kcal = first.querySelector('.wg-row__value.wg-row__value--sun');
        expect(kcal.firstChild.textContent).toBe('320');
        expect(kcal.querySelector('small').textContent).toBe('kcal');
        // No emoji meal prefix; is_meal rows get the kit food icon instead.
        expect(first.querySelector('.wg-food-item-row__meal-ico')).toBeNull();
    });

    it('a saved-meal row carries the food icon before its title', () => {
        const { window, document } = env;
        const groups = [{ ...FIXTURE[0], logs: [{ ...FIXTURE[0].logs[0], is_meal: true }] }];
        window._renderFoodData(groups, null, 'day', '2026-04-20');
        const title = document.querySelector('#food-list .wg-row__title');
        expect(title.querySelector('.wg-ico svg')).not.toBeNull();
        expect(title.textContent).toBe('Oatmeal');
    });

    it('offline-pending logs get the shared Pending sync chip', () => {
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

        const tag = row.querySelector('.wg-chip.wg-chip--pending');
        expect(tag).not.toBeNull();
        expect(tag.textContent).toBe('Pending');
    });

    it('rejected logs get a danger Sync failed chip with tooltip', () => {
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

        const tag = row.querySelector('.wg-chip.wg-chip--danger');
        expect(tag).not.toBeNull();
        expect(tag.textContent).toBe('Sync failed');
        expect(tag.title).toBe('HTTP 400 — bad payload');
    });

    it('overflow menu Edit invokes editFoodLog once, without bubbling to the row handler', () => {
        const { window, document } = env;
        window._renderFoodData(FIXTURE, null, 'day', '2026-04-20');

        const editSpy = vi.spyOn(window, 'editFoodLog').mockImplementation(() => {});
        const row = document.querySelector(
            '#food-list .wg-food-item-row[data-log-id="1"]'
        );
        expect(row.classList.contains('wg-swipe')).toBe(true);
        expect(row.querySelector('.wg-row__trail .wg-swipe__more')).not.toBeNull();
        clickRowAction(row, 'Edit');
        expect(editSpy).toHaveBeenCalledTimes(1);
        expect(editSpy).toHaveBeenCalledWith(1);
        editSpy.mockRestore();
    });

    it('overflow menu Delete invokes deleteFoodLog without bubbling to the row handler', () => {
        const { window, document } = env;
        window._renderFoodData(FIXTURE, null, 'day', '2026-04-20');

        const deleteSpy = vi.spyOn(window, 'deleteFoodLog').mockImplementation(() => {});
        const editSpy = vi.spyOn(window, 'editFoodLog').mockImplementation(() => {});
        const row = document.querySelector(
            '#food-list .wg-food-item-row[data-log-id="3"]'
        );
        clickRowAction(row, 'Delete');
        expect(deleteSpy).toHaveBeenCalledWith(3);
        expect(editSpy).not.toHaveBeenCalled();
        deleteSpy.mockRestore();
        editSpy.mockRestore();
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

    it('no sticky Add-food CTA dock is rendered — only the app-bar Add remains', () => {
        // Round-2 Task 3: the bottom CTA was removed; Add-food affordance
        // is `#add-food-inline-btn` in the Food app bar.
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

    it('an empty day renders .wg-empty with Search / Scan / Photo / Describe secondary shortcuts', () => {
        const { window, document } = env;
        window._renderFoodData([], null, 'day', '2026-04-20');

        const list = document.getElementById('food-list');
        const empty = list.querySelector('.wg-card .wg-empty');
        expect(empty).not.toBeNull();
        expect(empty.querySelector('.wg-empty__title').textContent).toBe('No food logged this day');
        const acts = Array.from(empty.querySelectorAll('.wg-empty__acts .wg-btn'));
        expect(acts.map((b) => b.textContent.trim())).toEqual(['Search', 'Scan', 'Photo', 'Describe']);
        acts.forEach((b) => expect(b.classList.contains('wg-btn--primary')).toBe(false));
        expect(document.querySelector('.wg-food-add-cta')).toBeNull();
        expect(document.getElementById('food-add-cta-dock')).toBeNull();
    });

    it("today's empty state says so", () => {
        const { window, document } = env;
        const d = new Date();
        const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        window._renderFoodData([], null, 'day', today);
        expect(document.querySelector('#food-list .wg-empty__title').textContent).toBe('No food logged today');
    });

    it('the empty-day shortcuts open the matching fast path', () => {
        const { window, document } = env;
        const calls = [];
        window.showAddFoodModal = () => calls.push('add');
        window.openFoodScannerModal = () => calls.push('scan');
        window.triggerFoodPhotoPicker = () => calls.push('photo');
        window.setFoodParseAIMode = (on) => calls.push(`ai:${on}`);
        window._renderFoodData([], null, 'day', '2026-04-20');

        const click = (label) => Array.from(document.querySelectorAll('#food-list .wg-empty__acts .wg-btn'))
            .find((b) => b.textContent.trim() === label).click();
        click('Search');
        expect(calls).toEqual(['add']);
        click('Scan');
        expect(calls).toEqual(['add', 'add', 'scan']);
        click('Photo');
        expect(calls.at(-1)).toBe('photo');
        click('Describe');
        expect(calls.slice(-2)).toEqual(['add', 'ai:true']);
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

        const header = document.querySelector('#food-list .wg-food-meal-group .wg-section__head');
        expect(header).not.toBeNull();
        expect(header.textContent).toContain('Meal');
    });
});
