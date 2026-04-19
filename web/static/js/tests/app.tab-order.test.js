/**
 * saveTabOrder persistence tests.
 *
 * After the Today-as-primary-nav rework the `tab_order` setting no longer
 * controls the order of tab-strip buttons (the strip was removed); it now
 * conveys the Today card order. The persistence API — POST
 * /api/settings/tab-order plus the settings_bundle.tabOrder cache — is
 * unchanged, so these tests still cover the save path end-to-end.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('app.tab-order tests', () => {
    it('saveTabOrder validates array, posts to API, and updates cache', async () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            const apiCallSpy = vi.fn().mockResolvedValue({ status: 'ok' });
            window.apiCall = apiCallSpy;

            const getCachedSpy = vi.fn().mockResolvedValue({
                featureSettings: {},
                tabOrder: ['bp', 'weight', 'food']
            });
            const setCachedSpy = vi.fn().mockResolvedValue(true);

            window.DataStore.getCached = getCachedSpy;
            window.DataStore.setCached = setCachedSpy;

            const newOrder = ['food', 'bp', 'weight'];
            await window.saveTabOrder(newOrder);

            expect(apiCallSpy).toHaveBeenCalledWith('/api/settings/tab-order', 'POST', { order: newOrder });
            expect(getCachedSpy).toHaveBeenCalledWith('settings_bundle');
            expect(setCachedSpy).toHaveBeenCalledWith('settings_bundle', {
                featureSettings: {},
                tabOrder: newOrder
            });

            // Also test invalid array short-circuit
            apiCallSpy.mockClear();
            await window.saveTabOrder(null);
            await window.saveTabOrder("not an array");
            await window.saveTabOrder({ a: 1 });

            expect(apiCallSpy).not.toHaveBeenCalled();

        } finally {
            cleanup();
        }
    });

    // Regression: /api/settings has no tab_order field, so a naive fetchBundle
    // rebuild of settings_bundle would drop the user's saved Today card order
    // the next time loadSettings / fetchSettingsBundle runs. Both must read
    // the existing cache and preserve tabOrder.
    it('fetchSettingsBundle preserves cached tabOrder when /api/settings omits it', async () => {
        const { window, cleanup } = loadFrontendEnv();
        try {
            const originalOrder = ['weight', 'food', 'bp'];
            window.apiCall = vi.fn(async (path) => {
                if (path === '/api/settings/features') return { bp: true, weight: true };
                if (path === '/api/food/settings/targets') return { calories: 2000 };
                if (path === '/api/bp/reminder/status') return { enabled: false };
                if (path === '/api/weight/reminder/status') return { enabled: false };
                if (path === '/api/settings') return { timezone: 'UTC', server_time: '' };
                return null;
            });
            window.DataStore.getCached = vi.fn(async (key) => {
                if (key === 'settings_bundle') return { tabOrder: originalOrder, foodTargets: {} };
                return null;
            });

            const bundle = await window.fetchSettingsBundle();
            expect(bundle).not.toBeNull();
            expect(bundle.tabOrder).toEqual(originalOrder);
        } finally {
            cleanup();
        }
    });
});
