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

describe('bootstrap.js Today is unconditionally the initial view', () => {
    it('calls switchTab("today") for a fresh user (no saved tab_order)', async () => {
        allowConsoleNoise();
        const { window, cleanup } = loadFrontendEnv();
        try {
            stubFetch(window, {
                features: { bp: true, weight: true, medication: true }
            });

            const switchTabSpy = vi.fn();
            stubBootstrapGlobals(window, switchTabSpy);

            const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
            window.eval(bootstrapSource);

            await new Promise(resolve => setTimeout(resolve, 50));

            expect(switchTabSpy).toHaveBeenCalledWith('today');
        } finally {
            cleanup();
        }
    });

    it('calls switchTab("today") even when a saved tab_order exists', async () => {
        allowConsoleNoise();
        const { window, cleanup } = loadFrontendEnv();
        try {
            stubFetch(window, {
                features: { bp: true, weight: true, medication: true },
                settings: { tab_order: JSON.stringify(['bp', 'weight']) }
            });

            const switchTabSpy = vi.fn();
            stubBootstrapGlobals(window, switchTabSpy);

            const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
            window.eval(bootstrapSource);

            await new Promise(resolve => setTimeout(resolve, 50));

            expect(switchTabSpy).toHaveBeenCalledWith('today');
            expect(switchTabSpy).not.toHaveBeenCalledWith('bp');
        } finally {
            cleanup();
        }
    });
});
