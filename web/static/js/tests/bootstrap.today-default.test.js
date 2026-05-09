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

describe('bootstrap.js initial-section restore', () => {
    it('calls switchTab("today") for a fresh user (no saved active tab)', async () => {
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

    it('restores switchTab("bp") when mt-active-tab="bp" and bp feature is enabled', async () => {
        allowConsoleNoise();
        const { window, cleanup } = loadFrontendEnv();
        try {
            stubFetch(window, {
                features: { bp: true, weight: true, medication: true }
            });
            window.featureSettings = { bp: true, weight: true, medication: true };
            window.localStorage.setItem('mt-active-tab', 'bp');

            const switchTabSpy = vi.fn();
            stubBootstrapGlobals(window, switchTabSpy);

            const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
            window.eval(bootstrapSource);

            await new Promise(resolve => setTimeout(resolve, 50));

            expect(switchTabSpy).toHaveBeenCalledWith('bp');
        } finally {
            cleanup();
        }
    });

    it('falls back to switchTab("today") when mt-active-tab points to a disabled feature', async () => {
        allowConsoleNoise();
        const { window, cleanup } = loadFrontendEnv();
        try {
            stubFetch(window, {
                features: { bp: false, weight: true, medication: true }
            });
            window.featureSettings = { bp: false, weight: true, medication: true };
            window.localStorage.setItem('mt-active-tab', 'bp');

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

    it('falls back to switchTab("today") when mt-active-tab is an unknown id', async () => {
        allowConsoleNoise();
        const { window, cleanup } = loadFrontendEnv();
        try {
            stubFetch(window, {
                features: { bp: true, weight: true, medication: true }
            });
            window.featureSettings = { bp: true, weight: true, medication: true };
            window.localStorage.setItem('mt-active-tab', 'unknown-id');

            const switchTabSpy = vi.fn();
            stubBootstrapGlobals(window, switchTabSpy);

            const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
            window.eval(bootstrapSource);

            await new Promise(resolve => setTimeout(resolve, 50));

            expect(switchTabSpy).toHaveBeenCalledWith('today');
            expect(switchTabSpy).not.toHaveBeenCalledWith('unknown-id');
        } finally {
            cleanup();
        }
    });
});
