// Task 5 of local-first read-resilience — Food must mount the
// wg-stale-badge chip in its section header. The chip reads its freshness
// from lastFoodLogsMeta (captured on every cachedFetch read) and flips to
// the offline tone when navigator.onLine is false OR the cached groups
// are flagged stale by cachedFetch.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CACHED_FETCH_JS = path.join(REPO_ROOT, 'web/static/js/cached-fetch.js');

function installCachedFetch(window) {
    const src = fs.readFileSync(CACHED_FETCH_JS, 'utf8');
    window.eval(`${src}\n//# sourceURL=file://${CACHED_FETCH_JS}`);
}

function installApiCacheMap(window, initialCache = {}) {
    const map = new Map();
    for (const [key, value] of Object.entries(initialCache)) {
        if (value && typeof value === 'object' && 'data' in value && 'timestamp' in value) {
            map.set(key, { id: key, ...value });
        } else {
            map.set(key, { id: key, timestamp: Date.now(), data: value });
        }
    }
    window.MedTrackerDB = window.MedTrackerDB || {};
    window.MedTrackerDB.ApiCache = {
        map,
        async get(key) { const e = map.get(key); return e ? e.data : null; },
        async getWithMeta(key) {
            const e = map.get(key);
            return e ? { data: e.data, timestamp: e.timestamp } : null;
        },
        async set(key, data) { map.set(key, { id: key, timestamp: Date.now(), data }); },
        async clear(key) { if (key) map.delete(key); else map.clear(); }
    };
    window.cacheApiSnapshot = async (key, value) => {
        map.set(key, { id: key, timestamp: Date.now(), data: value });
    };
    return map;
}

function setOnline(window, online) {
    Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        get: () => online
    });
}

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

    it('shows Offline · Nm old chip in offline mode using the cached fetchedAt', async () => {
        const { window, document } = env;
        installCachedFetch(window);

        const cachedAt = Date.now() - 12 * 60 * 1000; // 12 min ago
        installApiCacheMap(window, {
            'food_2026-05-09_day': {
                data: {
                    groups: [{
                        name: 'Lunch',
                        time: '13:00',
                        calories: 420,
                        carbs: 50,
                        protein: 18,
                        fat: 12,
                        logs: [{ id: 99, name: 'Salad', weight: 250, calories: 420, carbs: 50, protein: 18, fat: 12 }]
                    }]
                },
                timestamp: cachedAt
            }
        });
        setOnline(window, false);
        window.apiCall = vi.fn();
        window.apiCallDirect = vi.fn();

        await window.loadFoodLogs();

        const slot = document.getElementById('food-stale-badge');
        expect(slot).not.toBeNull();
        expect(slot.classList.contains('hidden')).toBe(false);
        const badge = slot.querySelector('.wg-stale-badge');
        expect(badge).not.toBeNull();
        // Offline → warning + offline tone, prefixed label.
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
        expect(badge.classList.contains('wg-stale-badge--warning')).toBe(true);
        expect(badge.textContent.startsWith('Offline · ')).toBe(true);
        expect(badge.textContent).toMatch(/^Offline · (just now|\d+m old)$/);
    });

    it('keeps the Updated tone when online but cachedFetch reports the cache is stale', async () => {
        // Regression: badge tone used to flip to "Offline · …" when meta.isStale
        // was true (online + 5xx fallback to >24h cache), mislabeling the data
        // as offline. Tone should follow navigator.onLine only; the warning
        // class is driven by staleAfterMs inside renderStaleBadge.
        const { window, document } = env;
        installCachedFetch(window);

        const cachedAt = Date.now() - 25 * 60 * 60 * 1000; // 25h ago — beyond default staleAfterMs (24h)
        installApiCacheMap(window, {
            'food_2026-05-09_day': {
                data: {
                    groups: [{
                        name: 'Lunch',
                        time: '13:00',
                        calories: 420,
                        carbs: 50,
                        protein: 18,
                        fat: 12,
                        logs: [{ id: 99, name: 'Salad', weight: 250, calories: 420, carbs: 50, protein: 18, fat: 12 }]
                    }]
                },
                timestamp: cachedAt
            }
        });
        setOnline(window, true);
        // apiCallDirect throws a 5xx-style error so cachedFetch falls back to cache
        // and surfaces meta.isStale: true while navigator.onLine remains true.
        const err = new Error('Service Unavailable');
        err.status = 503;
        window.apiCall = vi.fn();
        window.apiCallDirect = vi.fn(async () => { throw err; });

        await window.loadFoodLogs();

        const slot = document.getElementById('food-stale-badge');
        expect(slot).not.toBeNull();
        const badge = slot.querySelector('.wg-stale-badge');
        expect(badge).not.toBeNull();
        // Online tone: no "Offline · " prefix and no offline class.
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(false);
        expect(badge.textContent.startsWith('Offline · ')).toBe(false);
        expect(badge.textContent.startsWith('Updated ')).toBe(true);
        // But warning class must still light up because cache age > staleAfterMs.
        expect(badge.classList.contains('wg-stale-badge--warning')).toBe(true);
    });

    it('uses the v2 cache timestamp when offline + new key empty + v2 cache rendered', async () => {
        // Regression: the OfflineNoCacheError catch path used to nullify
        // lastFoodLogsMeta unconditionally, which surfaced "Offline · no cache"
        // even though the legacy v2 cache had just rendered groups for the
        // date. The badge now reads `food_<date>_v2`'s timestamp via
        // ApiCache.getWithMeta and surfaces "Offline · Xh old" instead.
        const { window, document } = env;
        installCachedFetch(window);

        const v2Groups = [{
            name: 'Lunch',
            time: '12:30',
            calories: 540,
            carbs: 60,
            protein: 28,
            fat: 18,
            logs: [{ id: 9, name: 'Soup', weight: 300, calories: 540, carbs: 60, protein: 28, fat: 18 }]
        }];
        const v2CachedAt = Date.now() - 30 * 60 * 1000; // 30m ago
        // Seed both api_cache (so getWithMeta returns timestamp) AND
        // DataStore.getCached (so the loadFoodLogs `cached` variable is truthy).
        installApiCacheMap(window, {
            'food_2026-05-09_v2': { data: { groups: v2Groups, weekStats: null }, timestamp: v2CachedAt }
        });
        window.DataStore.getCached = async (key) => key === 'food_2026-05-09_v2'
            ? { groups: v2Groups, weekStats: null }
            : null;

        setOnline(window, false);
        window.apiCall = vi.fn();
        window.apiCallDirect = vi.fn();

        await window.loadFoodLogs();

        const slot = document.getElementById('food-stale-badge');
        expect(slot).not.toBeNull();
        const badge = slot.querySelector('.wg-stale-badge');
        expect(badge).not.toBeNull();
        // Should NOT claim "no cache" — v2 data is on screen.
        expect(badge.textContent).not.toBe('Offline · no cache');
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
        // 30m old → either "Offline · 30m old" or close.
        expect(badge.textContent).toMatch(/^Offline · \d+m old$/);
    });

    it('falls back to Offline · no cache when offline and no api_cache entry exists', async () => {
        const { window, document } = env;
        installCachedFetch(window);

        installApiCacheMap(window, {}); // empty
        setOnline(window, false);
        window.apiCall = vi.fn();
        window.apiCallDirect = vi.fn();

        await window.loadFoodLogs();

        const slot = document.getElementById('food-stale-badge');
        expect(slot).not.toBeNull();
        expect(slot.classList.contains('hidden')).toBe(false);
        const badge = slot.querySelector('.wg-stale-badge');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('Offline · no cache');
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
    });
});
