import { describe, expect, it, vi, beforeEach } from 'vitest';
import { loadFrontendEnv, createMockResponse } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const BOOTSTRAP_JS = path.join(REPO_ROOT, 'web/static/js/features/bootstrap.js');

function stubFetch(window, payload) {
    vi.spyOn(window, 'fetch').mockImplementation(async (url) => {
        if (url === '/api/bootstrap') return createMockResponse({ json: payload });
        if (url === '/auth/status') return createMockResponse({ json: { authenticated: true } });
        return createMockResponse({ json: {} });
    });
}

function stubBootstrapGlobals(window, switchTabSpy) {
    window.switchTab = switchTabSpy;
    window.initOIDCSetupBanner = vi.fn();
    window.handleDeepLinks = vi.fn();
}

describe('bootstrap.js Today tab default + opt-out', () => {
    beforeEach(() => {
        // Nothing global — each test manages its own localStorage via window below.
    });

    it('makes Today the default tab for a fresh user (no saved tab_order)', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            try { window.localStorage.removeItem('today_opt_out'); } catch (_) {}

            // Fresh user — no tab_order persisted.
            stubFetch(window, {
                features: { bp: true, weight: true, medication: true }
                // settings omitted → no tab_order
            });

            const switchTabSpy = vi.fn();
            stubBootstrapGlobals(window, switchTabSpy);

            const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
            window.eval(bootstrapSource);

            await new Promise(resolve => setTimeout(resolve, 50));

            // Today is the first tab in the DOM (index.html), so firstVisible
            // resolves to it and switchTab('today') is called.
            const firstTab = document.querySelector('#tabs .tab');
            expect(firstTab?.dataset.tab).toBe('today');
            expect(switchTabSpy).toHaveBeenCalledWith('today');
        } finally {
            cleanup();
        }
    });

    it('respects an explicit opt-out: tab_order without today is preserved', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            // User explicitly removed Today from their tab strip.
            try { window.localStorage.setItem('today_opt_out', '1'); } catch (_) {}

            stubFetch(window, {
                features: { bp: true, weight: true, medication: true },
                settings: { tab_order: JSON.stringify(['bp', 'weight']) }
            });

            const switchTabSpy = vi.fn();
            stubBootstrapGlobals(window, switchTabSpy);

            const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
            window.eval(bootstrapSource);

            await new Promise(resolve => setTimeout(resolve, 50));

            // With opt-out set, Today must NOT be prepended. The user's saved
            // first tab (bp) becomes the default.
            expect(switchTabSpy).toHaveBeenCalledWith('bp');
            expect(switchTabSpy).not.toHaveBeenCalledWith('today');

            // DOM reflects the saved order — Today is not forced to the front.
            const tabsContainer = document.getElementById('tabs');
            const domOrder = Array.from(tabsContainer.querySelectorAll('.tab')).map(t => t.dataset.tab);
            const bpIdx = domOrder.indexOf('bp');
            const todayIdx = domOrder.indexOf('today');
            expect(bpIdx).toBeGreaterThanOrEqual(0);
            expect(todayIdx).toBeGreaterThan(bpIdx);

            try { window.localStorage.removeItem('today_opt_out'); } catch (_) {}
        } finally {
            cleanup();
        }
    });
});
