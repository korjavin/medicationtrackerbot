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
    it('sets the first visible tab as active during bootstrap', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            // Mock API calls for checkAuth
            const bootstrapPayload = {
                features: { bp: false, weight: true, medication: true }, // BP is disabled
                settings: { tab_order: JSON.stringify(['bp', 'weight', 'meds']) }
            };
            
            vi.spyOn(window, 'fetch').mockImplementation(async (url) => {
                if (url === '/api/bootstrap') {
                    return createMockResponse({ json: bootstrapPayload });
                }
                return createMockResponse({ json: {} });
            });

            // Mock switchTab and other globals
            const switchTabSpy = vi.fn();
            window.switchTab = switchTabSpy;
            window.initOIDCSetupBanner = vi.fn();
            window.handleDeepLinks = vi.fn();

            // Load bootstrap.js
            const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
            window.eval(bootstrapSource);

            // Wait for checkAuth().then(...) to resolve
            await new Promise(resolve => setTimeout(resolve, 50));

            // BP is first in order but disabled (display: none). Weight is the first visible.
            const bpTab = document.querySelector('.tab[data-tab="bp"]');
            const weightTab = document.querySelector('.tab[data-tab="weight"]');
            
            expect(bpTab.style.display).toBe('none');
            // Check that switchTab was called with 'weight' instead of hardcoded 'bp'
            expect(switchTabSpy).toHaveBeenCalledWith('weight');
            expect(switchTabSpy).not.toHaveBeenCalledWith('bp');

        } finally {
            cleanup();
        }
    });

    it('falls back to bp if no visible tabs found (sanity check)', async () => {
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

            expect(switchTabSpy).toHaveBeenCalledWith('bp');
        } finally {
            cleanup();
        }
    });
});
