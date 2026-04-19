import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const TODAY_JS = path.join(REPO_ROOT, 'web/static/js/features/today.js');

function loadEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only'
    });
    const { window } = dom;
    const src = fs.readFileSync(TODAY_JS, 'utf8');
    window.eval(`${src}\n//# sourceURL=file://${TODAY_JS}`);
    return {
        window,
        api: window.TodayDashboard,
        cleanup: () => dom.window.close()
    };
}

function makeEventTarget(window) {
    // Simple EventTarget proxy available in jsdom window.
    return new window.EventTarget();
}

describe('TodayDashboard.subscribe', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('invokes onRefresh when a BOOTSTRAP_UPDATED message is dispatched', () => {
        const onRefresh = vi.fn();
        const target = makeEventTarget(env.window);
        const unsubscribe = env.api.subscribe({ onRefresh, target, win: env.window });

        const payload = { features: { bp: true } };
        target.dispatchEvent(new env.window.MessageEvent('message', {
            data: { type: 'BOOTSTRAP_UPDATED', data: payload }
        }));

        expect(onRefresh).toHaveBeenCalledTimes(1);
        const call = onRefresh.mock.calls[0][0];
        expect(call.source).toBe('bootstrap');
        expect(call.data).toBe(payload);

        unsubscribe();
    });

    it('ignores messages of other types', () => {
        const onRefresh = vi.fn();
        const target = makeEventTarget(env.window);
        env.api.subscribe({ onRefresh, target, win: env.window });

        target.dispatchEvent(new env.window.MessageEvent('message', {
            data: { type: 'MEDICATION_CONFIRMED' }
        }));

        expect(onRefresh).not.toHaveBeenCalled();
    });

    it('invokes onRefresh on window online / offline events', () => {
        const onRefresh = vi.fn();
        const target = makeEventTarget(env.window);
        env.api.subscribe({ onRefresh, target, win: env.window });

        env.window.dispatchEvent(new env.window.Event('offline'));
        env.window.dispatchEvent(new env.window.Event('online'));

        expect(onRefresh).toHaveBeenCalledTimes(2);
        expect(onRefresh.mock.calls[0][0]).toMatchObject({ source: 'offline', online: false });
        expect(onRefresh.mock.calls[1][0]).toMatchObject({ source: 'online', online: true });
    });

    it('invokes onRefresh on datastore:changed with relevant tags', () => {
        const onRefresh = vi.fn();
        const target = makeEventTarget(env.window);
        env.api.subscribe({ onRefresh, target, win: env.window });

        env.window.dispatchEvent(new env.window.CustomEvent('datastore:changed', {
            detail: { changedTags: ['bp'] }
        }));
        expect(onRefresh).toHaveBeenCalledTimes(1);
        expect(onRefresh.mock.calls[0][0]).toMatchObject({ source: 'datastore', tags: ['bp'] });

        onRefresh.mockReset();
        env.window.dispatchEvent(new env.window.CustomEvent('datastore:changed', {
            detail: { changedTags: ['unrelated-tag'] }
        }));
        expect(onRefresh).not.toHaveBeenCalled();
    });

    it.each([['workout'], ['history'], ['settings'], ['medications'], ['weight'], ['food'], ['health']])(
        'invokes onRefresh for backend-emitted tag %s',
        (tag) => {
            const onRefresh = vi.fn();
            const target = makeEventTarget(env.window);
            env.api.subscribe({ onRefresh, target, win: env.window });

            env.window.dispatchEvent(new env.window.CustomEvent('datastore:changed', {
                detail: { changedTags: [tag] }
            }));
            expect(onRefresh).toHaveBeenCalledTimes(1);
            expect(onRefresh.mock.calls[0][0]).toMatchObject({ source: 'datastore', tags: [tag] });
        }
    );

    it('unsubscribe removes all listeners', () => {
        const onRefresh = vi.fn();
        const target = makeEventTarget(env.window);
        const unsubscribe = env.api.subscribe({ onRefresh, target, win: env.window });
        unsubscribe();

        target.dispatchEvent(new env.window.MessageEvent('message', {
            data: { type: 'BOOTSTRAP_UPDATED', data: {} }
        }));
        env.window.dispatchEvent(new env.window.Event('online'));
        env.window.dispatchEvent(new env.window.CustomEvent('datastore:changed', {
            detail: { changedTags: ['bp'] }
        }));

        expect(onRefresh).not.toHaveBeenCalled();
    });
});

describe('TodayDashboard.isOfflineStale', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('returns false when online regardless of cache age', () => {
        const now = Date.now();
        expect(env.api.isOfflineStale({
            online: true,
            cacheTimestamp: now - 10 * 60 * 60 * 1000,
            now
        })).toBe(false);
    });

    it('returns true when offline and no cache timestamp is present', () => {
        const now = Date.now();
        expect(env.api.isOfflineStale({ online: false, cacheTimestamp: null, now })).toBe(true);
    });

    it('returns false when offline and cache is within the freshness window', () => {
        const now = Date.now();
        const fiveMinAgo = now - 5 * 60 * 1000;
        expect(env.api.isOfflineStale({ online: false, cacheTimestamp: fiveMinAgo, now })).toBe(false);
    });

    it('returns true when offline and cache is older than the 1h default threshold', () => {
        const now = Date.now();
        const twoHrsAgo = now - 2 * 60 * 60 * 1000;
        expect(env.api.isOfflineStale({ online: false, cacheTimestamp: twoHrsAgo, now })).toBe(true);
    });

    it('respects a custom thresholdMs', () => {
        const now = Date.now();
        const tenMinAgo = now - 10 * 60 * 1000;
        expect(env.api.isOfflineStale({
            online: false,
            cacheTimestamp: tenMinAgo,
            now,
            thresholdMs: 60 * 1000
        })).toBe(true);
        expect(env.api.isOfflineStale({
            online: false,
            cacheTimestamp: tenMinAgo,
            now,
            thresholdMs: 60 * 60 * 1000
        })).toBe(false);
    });
});
