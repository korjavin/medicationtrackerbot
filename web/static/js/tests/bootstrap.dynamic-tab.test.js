import { describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv, createMockResponse } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const BOOTSTRAP_JS = path.join(REPO_ROOT, 'web/static/js/features/bootstrap.js');

describe('bootstrap.js dynamic tab selection', () => {
    it('prepends today when the saved tab_order predates the Today tab', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            try { window.localStorage.removeItem('today_opt_out'); } catch (_) {}
            // Mock API calls for checkAuth
            const bootstrapPayload = {
                features: { bp: false, weight: true, medication: true }, // BP is disabled
                settings: { tab_order: JSON.stringify(['bp', 'weight', 'meds']) }
            };

            vi.spyOn(window, 'fetch').mockImplementation(async (url) => {
                if (url === '/api/bootstrap') {
                    return createMockResponse({ json: bootstrapPayload });
                }
                if (url === '/auth/status') {
                    return createMockResponse({ json: { authenticated: true } });
                }
                return createMockResponse({ json: {} });
            });

            const switchTabSpy = vi.fn();
            window.switchTab = switchTabSpy;
            window.initOIDCSetupBanner = vi.fn();
            window.handleDeepLinks = vi.fn();

            const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
            window.eval(bootstrapSource);

            await new Promise(resolve => setTimeout(resolve, 50));

            const bpTab = document.querySelector('.tab[data-tab="bp"]');
            if (bpTab) expect(bpTab.style.display).toBe('none');

            // Today is prepended for users with a pre-Today tab_order, so it
            // becomes the first visible tab (bp is hidden) and the default switchTab target.
            expect(switchTabSpy).toHaveBeenCalledWith('today');
            expect(switchTabSpy).not.toHaveBeenCalledWith('bp');
        } finally {
            cleanup();
        }
    });

    it('falls back to today if no visible tabs found (sanity check)', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            // Hide all tabs
            document.querySelectorAll('.tab').forEach(t => t.style.display = 'none');

            const switchTabSpy = vi.fn();
            window.switchTab = switchTabSpy;
            window.checkAuth = vi.fn().mockResolvedValue(true);
            window.initOIDCSetupBanner = vi.fn();
            window.handleDeepLinks = vi.fn();

            const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
            window.eval(bootstrapSource);

            await new Promise(resolve => setTimeout(resolve, 10));

            expect(switchTabSpy).toHaveBeenCalledWith('today');
        } finally {
            cleanup();
        }
    });
});
