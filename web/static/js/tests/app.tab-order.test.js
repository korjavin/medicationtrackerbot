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
});
