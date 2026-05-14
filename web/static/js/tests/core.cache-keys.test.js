// core.cache-keys.test.js
//
// Tests for the centralized cache-key registry at
// web/static/js/core/cache-keys.js. Verifies static-key lookup, dynamic
// family construction, tag resolution, registerAll wiring into a DataStore-
// shaped object, and the "unknown key throws" typo catcher.

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CACHE_KEYS_JS = path.join(REPO_ROOT, 'web/static/js/core/cache-keys.js');

function loadCacheKeysEnv() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const src = fs.readFileSync(CACHE_KEYS_JS, 'utf8');
    dom.window.eval(`${src}\n//# sourceURL=file://${CACHE_KEYS_JS}`);
    return {
        window: dom.window,
        cleanup: () => dom.window.close()
    };
}

describe('core/cache-keys.js — static-key registry', () => {
    let env;
    beforeEach(() => { env = loadCacheKeysEnv(); });

    it('exposes CacheKeys on window', () => {
        expect(env.window.CacheKeys).toBeDefined();
        expect(typeof env.window.CacheKeys.registerAll).toBe('function');
        expect(typeof env.window.CacheKeys.lookup).toBe('function');
    });

    it('looks up canonical static keys with tag + freshness metadata', () => {
        const { CacheKeys } = env.window;
        const entry = CacheKeys.lookup('next_intake');
        expect(entry.key).toBe('next_intake');
        expect(entry.tag).toBe('medications');
        expect(entry.freshAfterMs).toBe(5 * 60 * 1000);
        expect(entry.staleAfterMs).toBe(12 * 60 * 60 * 1000);
    });

    it('enumerates every documented static key (no silent drops)', () => {
        const expected = [
            'medications',
            'next_intake',
            'bp',
            'weight',
            'workout_next',
            'workout_history',
            'workout_groups',
            'workout_stats',
            'exercise_library',
            'food_products_cache',
            'food_targets',
            'diary_notes',
            'settings_bundle'
        ];
        const present = Object.keys(env.window.CacheKeys.static);
        for (const k of expected) {
            expect(present).toContain(k);
        }
    });

    it('settings_bundle is registered with no tag (never invalidated)', () => {
        expect(env.window.CacheKeys.lookup('settings_bundle').tag).toBeNull();
    });

    it('throws on unknown key (catches typos like medication vs medications)', () => {
        const { CacheKeys } = env.window;
        expect(() => CacheKeys.lookup('medication')).toThrow(/unknown cache key/);
        expect(() => CacheKeys.lookup('')).toThrow();
        expect(() => CacheKeys.lookup(null)).toThrow();
    });
});

describe('core/cache-keys.js — dynamic key families', () => {
    let env;
    beforeEach(() => { env = loadCacheKeysEnv(); });

    it('history(days, medId) returns history_<days>_<medId>', () => {
        expect(env.window.CacheKeys.history(7, 42)).toBe('history_7_42');
        expect(env.window.CacheKeys.history(30, 'abc')).toBe('history_30_abc');
    });

    it('history(days, null) returns history_<days>_ with empty medId tail', () => {
        expect(env.window.CacheKeys.history(7, null)).toBe('history_7_');
        expect(env.window.CacheKeys.history(7, undefined)).toBe('history_7_');
    });

    it('dayFoodKey(date) returns food_<date>_day', () => {
        expect(env.window.CacheKeys.dayFoodKey('2026-05-14')).toBe('food_2026-05-14_day');
    });

    it('healthOverviewKey(tz) returns health_overview_<tz>', () => {
        expect(env.window.CacheKeys.healthOverviewKey('Europe/Berlin')).toBe('health_overview_Europe/Berlin');
    });

    it('tagFor resolves both static keys and dynamic-family-prefixed keys', () => {
        const { CacheKeys } = env.window;
        expect(CacheKeys.tagFor('bp')).toBe('bp');
        expect(CacheKeys.tagFor('history_7_42')).toBe('history');
        expect(CacheKeys.tagFor('food_2026-05-14_day')).toBe('food');
        expect(CacheKeys.tagFor('health_overview_UTC')).toBe('health');
        expect(CacheKeys.tagFor('settings_bundle')).toBeNull();
        expect(CacheKeys.tagFor('completely_unknown')).toBeNull();
    });

    it('exposes families[] with prefix and tag for downstream registerTagFamily', () => {
        const { CacheKeys } = env.window;
        const byPrefix = Object.fromEntries(CacheKeys.families.map((f) => [f.prefix, f.tag]));
        expect(byPrefix['history_']).toBe('history');
        expect(byPrefix['food_']).toBe('food');
        expect(byPrefix['health_overview_']).toBe('health');
    });
});

describe('core/cache-keys.js — registerAll', () => {
    let env;
    beforeEach(() => { env = loadCacheKeysEnv(); });

    it('calls dataStore.registerTags(key, [tag]) for every tagged static key', () => {
        const calls = [];
        const fakeDS = {
            registerTags(key, tags) { calls.push({ key, tags }); }
        };
        env.window.CacheKeys.registerAll(fakeDS);

        const byKey = Object.fromEntries(calls.map((c) => [c.key, c.tags]));
        expect(byKey['medications']).toEqual(['medications']);
        expect(byKey['next_intake']).toEqual(['medications']);
        expect(byKey['bp']).toEqual(['bp']);
        expect(byKey['weight']).toEqual(['weight']);
        expect(byKey['workout_next']).toEqual(['workout']);
        expect(byKey['workout_history']).toEqual(['workout']);
        expect(byKey['workout_groups']).toEqual(['workout']);
        expect(byKey['workout_stats']).toEqual(['workout']);
        expect(byKey['exercise_library']).toEqual(['exercise_library']);
        expect(byKey['food_products_cache']).toEqual(['food']);
        expect(byKey['diary_notes']).toEqual(['health-notes']);
    });

    it('skips static entries with no tag (settings_bundle is never registered)', () => {
        const calls = [];
        const fakeDS = {
            registerTags(key, tags) { calls.push({ key, tags }); }
        };
        env.window.CacheKeys.registerAll(fakeDS);
        const keys = calls.map((c) => c.key);
        expect(keys).not.toContain('settings_bundle');
    });

    it('calls registerTagFamily(prefix, tag) for each family when available', () => {
        const familyCalls = [];
        const fakeDS = {
            registerTags() { /* no-op */ },
            registerTagFamily(prefix, tag) { familyCalls.push({ prefix, tag }); }
        };
        env.window.CacheKeys.registerAll(fakeDS);
        const byPrefix = Object.fromEntries(familyCalls.map((c) => [c.prefix, c.tag]));
        expect(byPrefix['history_']).toBe('history');
        expect(byPrefix['food_']).toBe('food');
        expect(byPrefix['health_overview_']).toBe('health');
    });

    it('is a safe no-op when registerTagFamily is not yet implemented on DataStore', () => {
        const fakeDS = { registerTags() { /* no-op */ } };
        expect(() => env.window.CacheKeys.registerAll(fakeDS)).not.toThrow();
    });

    it('is a safe no-op when given null/undefined dataStore', () => {
        expect(() => env.window.CacheKeys.registerAll(null)).not.toThrow();
        expect(() => env.window.CacheKeys.registerAll(undefined)).not.toThrow();
    });
});

