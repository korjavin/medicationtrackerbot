// Food Add sheet (kit F4–F5, med-xso6.17): one .wg-sheet behind every Add
// (Food app bar, Today's Log food, empty-day shortcuts) with search, the
// Scan / Photo / Describe tiles and a Recent list. Recent re-logs in one
// write; a search pick shows portion picks and an "Add <g> g · <kcal> kcal"
// primary; a scanned barcode with no match falls back to the manual form.
// The Photo / Describe review flow is covered by food.ai-mode.test.js.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

async function settle(n = 5) {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

const RECENT_GROUPS = [
    {
        name: 'Breakfast',
        logs: [
            { id: 'l1', name: 'Greek yogurt', product_id: 'p-yog', weight: 170, carbs: 7, protein: 17, fat: 0, calories: 98, eaten_at: '2026-10-08T08:00:00Z' },
            { id: 'l2', name: 'Greek yogurt', product_id: 'p-yog', weight: 120, carbs: 5, protein: 12, fat: 0, calories: 68, eaten_at: '2026-10-07T08:00:00Z' },
            { id: 'l3', name: 'Banana', weight: 120, carbs: 27, protein: 1, fat: 0, calories: 112, eaten_at: '2026-10-08T07:00:00Z' },
        ],
    },
];

describe('Food Add sheet', () => {
    let env;
    let apiCall;

    beforeEach(() => {
        allowConsoleNoise();
        env = loadFrontendEnv();
        const { window } = env;
        apiCall = vi.fn(async (url, method) => {
            if ((method || 'GET') === 'GET' && String(url).startsWith('/api/food/log?')) return RECENT_GROUPS;
            if (method === 'POST') return { id: 'new-log' };
            return null;
        });
        window.apiCall = apiCall;
        window.loadFoodLogs = vi.fn();
        window.initFoodProductsCache = vi.fn().mockResolvedValue(undefined);
        window.safeToast = vi.fn();
        window.CloudFoodSearch = {
            search: vi.fn(async () => []),
            remoteConfigured: vi.fn(async () => false),
        };
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

    const posts = () => apiCall.mock.calls.filter(([, m]) => m === 'POST');
    const sheet = () => env.document.getElementById('food-add-sheet');

    it('Add opens one .wg-sheet with search, Scan / Photo / Describe tiles and a Recent list', async () => {
        const { window, document } = env;
        window.showAddFoodModal();
        await settle();

        expect(sheet().classList.contains('hidden')).toBe(false);
        expect(sheet().classList.contains('wg-sheet')).toBe(true);
        expect(document.querySelectorAll('mt-modal.wg-sheet:not(.hidden)')).toHaveLength(1);
        expect(document.getElementById('food-add-search')).not.toBeNull();
        const tiles = Array.from(document.querySelectorAll('#food-add-tiles .wg-action .wg-action__label')).map((n) => n.textContent);
        expect(tiles).toEqual(['Scan', 'Photo', 'Describe']);

        // Recent: newest first, one row per product (the older yogurt dedupes).
        expect(document.getElementById('food-add-recent-section').classList.contains('hidden')).toBe(false);
        const titles = Array.from(document.querySelectorAll('#food-add-recent .wg-row__title')).map((n) => n.textContent);
        expect(titles).toEqual(['Greek yogurt', 'Banana']);
        expect(document.querySelector('#food-add-recent .wg-row__meta').textContent).toContain('170 g · 98 kcal');
    });

    it('a Recent + tap logs that food with its last portion in exactly one write, then closes', async () => {
        const { window, document } = env;
        window.FoodLog.addSheet.open();
        await settle();

        document.querySelector('#food-add-recent button[aria-label="Add Greek yogurt 170 g"]').click();
        await settle(10);

        expect(posts()).toHaveLength(1);
        expect(posts()[0][0]).toBe('/api/food/log');
        expect(posts()[0][2]).toEqual(expect.objectContaining({
            name: 'Greek yogurt', product_id: 'p-yog', weight: 170, calories: 98, per_100g: false,
        }));
        expect(sheet().classList.contains('hidden')).toBe(true);
        expect(window.safeToast).toHaveBeenCalledWith(expect.stringContaining('Greek yogurt'), 'success');
    });

    it('search shows results in the sheet; a pick shows portion picks and an "Add <g> g · <kcal> kcal" primary that writes once', async () => {
        const { window, document } = env;
        window.CloudFoodSearch.search = vi.fn(async () => [
            { id: 'p-oat', name: 'Oat flakes', carbs_100g: 60, protein_100g: 12, fat_100g: 7, energy_kcal_100g: 360 },
        ]);
        window.FoodLog.addSheet.open();
        await settle();

        document.getElementById('food-add-search').value = 'oat';
        await window.FoodLog.addSheet.runSearch('oat', false);
        const results = document.getElementById('food-add-results');
        expect(results.classList.contains('hidden')).toBe(false);
        expect(document.getElementById('food-add-recent-section').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('food-add-foot').classList.contains('hidden')).toBe(true);

        results.querySelector('button.wg-food-add__result').click();
        const picks = Array.from(results.querySelectorAll('.wg-food-add__portions .wg-pick')).map((b) => b.dataset.grams);
        expect(picks).toEqual(['100', '150', '200', 'other']);
        const primary = document.getElementById('food-add-primary-btn');
        expect(document.getElementById('food-add-foot').classList.contains('hidden')).toBe(false);
        expect(primary.textContent).toBe('Add 100 g · 360 kcal');

        results.querySelector('.wg-pick[data-grams="150"]').click();
        expect(primary.textContent).toBe('Add 150 g · 540 kcal');

        primary.click();
        await settle(10);

        expect(posts()).toHaveLength(1);
        expect(posts()[0][2]).toEqual(expect.objectContaining({
            name: 'Oat flakes', product_id: 'p-oat', weight: 150, carbs: 90, protein: 18, fat: 11, calories: 540,
        }));
        expect(sheet().classList.contains('hidden')).toBe(true);
    });

    it('a scanned barcode with no match opens the manual form prefilled with it', async () => {
        const { window, document } = env;
        window.FoodLog.addSheet.open();
        await settle();

        // The scanner (opened from the Scan tile) hands the decode to the sheet.
        expect(window.handleDecodedValue('4600000000001')).toBe(true);
        await settle(10);

        expect(sheet().classList.contains('hidden')).toBe(true);
        expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('food-barcode').value).toBe('4600000000001');
        expect(document.getElementById('food-modal-more').open).toBe(true);
        expect(posts()).toHaveLength(0);
    });

    it('Esc closes the sheet', async () => {
        const { window } = env;
        window.FoodLog.addSheet.open();
        await settle();
        expect(sheet().classList.contains('hidden')).toBe(false);

        const e = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        window.document.body.dispatchEvent(e);

        expect(sheet().classList.contains('hidden')).toBe(true);
        expect(window.FoodLog.addSheet.isOpen()).toBe(false);
    });
});
