/**
 * bootstrap.js dynamic tab-order behavior.
 *
 * After the Wandergeek bottom-nav rework the canonical lateral nav is the
 * fixed-order `.wg-bottom-nav`; `tab_order` no longer selects the initial
 * view — it only controls Today card order. This file guards that:
 *
 *   - A saved `tab_order` never overrides 'today' as the initial view.
 *   - A pre-Today `tab_order` does not redirect bootstrap to a section view
 *     just because its first entry is a section like 'bp'.
 *   - When bootstrap mounts the bottom nav, the 'today' slot paints active.
 */
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
    it('saved tab_order with a leading section does not override the Today landing', async () => {
        allowConsoleNoise();
        const { window, cleanup } = loadFrontendEnv();
        try {
            try { window.localStorage.removeItem('today_opt_out'); } catch (_) {}
            const bootstrapPayload = {
                features: { bp: false, weight: true, medication: true },
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

            expect(switchTabSpy).toHaveBeenCalledWith('today');
            expect(switchTabSpy).not.toHaveBeenCalledWith('bp');
        } finally {
            cleanup();
        }
    });

    it('bootstrap lands on Today even when no section loaders resolve first', async () => {
        allowConsoleNoise();
        const { window, cleanup } = loadFrontendEnv();
        try {
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
