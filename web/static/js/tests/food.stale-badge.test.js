// Food section-header stale badge — the chip reads its freshness from
// window.FoodLog.meta (stamped on every loadFoodLogs read) and flips to
// the offline tone when navigator.onLine is false. Reads are vault-served
// via apiCall, so meta is always fresh; tone follows connectivity only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function setOnline(window, online) {
    Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        get: () => online
    });
}

const GROUPS = [{
    name: 'Lunch',
    time: '13:00',
    calories: 420,
    carbs: 50,
    protein: 18,
    fat: 12,
    logs: [{ id: 99, name: 'Salad', weight: 250, calories: 420, carbs: 50, protein: 18, fat: 12 }]
}];

describe('Food section-header stale badge', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
        const { document } = env;
        document.getElementById('food-date-filter').value = '2026-05-09';
        env.window.loadFoodTargets = async () => {};
        env.window.DataStore.getCached = async () => null;
        env.window.DataStore.setCached = async () => {};
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('shows the Offline chip in offline mode with the fresh read timestamp', async () => {
        const { window, document } = env;

        setOnline(window, false);
        window.apiCall = vi.fn(async (url) => {
            if (url.startsWith('/api/food/log?')) return GROUPS;
            return null;
        });

        await window.loadFoodLogs();

        const slot = document.getElementById('food-stale-badge');
        expect(slot).not.toBeNull();
        expect(slot.classList.contains('hidden')).toBe(false);
        const badge = slot.querySelector('.wg-stale-badge');
        expect(badge).not.toBeNull();
        // Offline → offline tone with a just-read timestamp.
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
        expect(badge.textContent.startsWith('Offline · ')).toBe(true);
        expect(badge.textContent).toMatch(/^Offline · (just now|\d+m old)$/);
        // Offline always warns, even on a fresh read.
        expect(badge.classList.contains('wg-stale-badge--warning')).toBe(true);
    });

    it('shows the Updated tone when online (no offline prefix, no warning)', async () => {
        const { window, document } = env;

        setOnline(window, true);
        window.apiCall = vi.fn(async (url) => {
            if (url.startsWith('/api/food/log?')) return GROUPS;
            return null;
        });

        await window.loadFoodLogs();

        const slot = document.getElementById('food-stale-badge');
        expect(slot).not.toBeNull();
        const badge = slot.querySelector('.wg-stale-badge');
        expect(badge).not.toBeNull();
        // Online tone: no "Offline · " prefix and no offline class.
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(false);
        expect(badge.textContent.startsWith('Offline · ')).toBe(false);
        expect(badge.textContent.startsWith('Updated ')).toBe(true);
        expect(badge.classList.contains('wg-stale-badge--warning')).toBe(false);
    });

    it('renders groups from apiCall even when the v2 cache holds older data', async () => {
        const { window, document } = env;

        const v2Groups = [{
            name: 'Breakfast',
            time: '08:00',
            calories: 320,
            carbs: 50,
            protein: 12,
            fat: 6,
            logs: [{ id: 1, name: 'Oatmeal', weight: 200, calories: 320, carbs: 50, protein: 12, fat: 6 }]
        }];
        window.DataStore.getCached = async (key) => key === 'food_2026-05-09_v2'
            ? { groups: v2Groups, weekStats: null }
            : null;

        setOnline(window, true);
        window.apiCall = vi.fn(async (url) => {
            if (url.startsWith('/api/food/log?')) return GROUPS;
            return null;
        });

        await window.loadFoodLogs();

        // The authoritative payload (Lunch) replaced the v2 render (Breakfast).
        const list = document.getElementById('food-list');
        expect(list.textContent).toContain('Lunch');
        expect(list.textContent).not.toContain('Breakfast');

        const slot = document.getElementById('food-stale-badge');
        const badge = slot.querySelector('.wg-stale-badge');
        expect(badge).not.toBeNull();
        expect(badge.textContent.startsWith('Updated ')).toBe(true);
    });

    it('renders the empty state plus an offline chip when apiCall returns null offline', async () => {
        const { window, document } = env;

        setOnline(window, false);
        window.apiCall = vi.fn(async () => null);

        await window.loadFoodLogs();

        const list = document.getElementById('food-list');
        expect(list.textContent).toBe('No food logs for this day.');

        const slot = document.getElementById('food-stale-badge');
        expect(slot).not.toBeNull();
        expect(slot.classList.contains('hidden')).toBe(false);
        const badge = slot.querySelector('.wg-stale-badge');
        expect(badge).not.toBeNull();
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
    });
});
