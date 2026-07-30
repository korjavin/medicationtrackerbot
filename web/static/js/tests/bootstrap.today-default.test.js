import { describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv, createMockResponse } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';
import { signal } from './helpers/settle.js';
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

// med-tc1.10 — the settle point IS the call under test. Every case here asserts
// which section bootstrap lands on, and bootstrap reaches that decision through
// checkAuth().then → mountCanonicalBottomNav → switchTab(readSavedActiveTab()).
// The old `setTimeout(r, 50)` bet that the whole chain fits in 50ms of wall
// clock; resolving from inside the spy (the #716 pattern) makes "switchTab has
// been called" a fact instead. bootstrap calls switchTab exactly once — the
// deep-link router is stubbed out and the nav's onChange only fires on a tap —
// so this same barrier also settles the `not.toHaveBeenCalledWith(...)` half:
// after it, the one and only call has already happened.
function spySwitchTab() {
    const called = signal();
    return { spy: vi.fn(() => called.fire()), called };
}

describe('bootstrap.js initial-section restore', () => {
    it('calls switchTab("today") for a fresh user (no saved active tab)', async () => {
        allowConsoleNoise();
        const { window, cleanup } = loadFrontendEnv();
        try {
            stubFetch(window, {
                features: { bp: true, weight: true, medication: true }
            });

            const { spy: switchTabSpy, called } = spySwitchTab();
            stubBootstrapGlobals(window, switchTabSpy);

            const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
            window.eval(bootstrapSource);

            await called.wait;

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
            window.localStorage.setItem('mt-active-tab-at', String(Date.now()));

            const { spy: switchTabSpy, called } = spySwitchTab();
            stubBootstrapGlobals(window, switchTabSpy);

            const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
            window.eval(bootstrapSource);

            await called.wait;

            expect(switchTabSpy).toHaveBeenCalledWith('bp');
        } finally {
            cleanup();
        }
    });

    it('falls back to switchTab("today") when the saved section is older than 30 min', async () => {
        allowConsoleNoise();
        const { window, cleanup } = loadFrontendEnv();
        try {
            stubFetch(window, {
                features: { bp: true, weight: true, medication: true }
            });
            window.featureSettings = { bp: true, weight: true, medication: true };
            window.localStorage.setItem('mt-active-tab', 'bp');
            // Last activity 31 minutes ago — past the 30-min restore window.
            window.localStorage.setItem('mt-active-tab-at', String(Date.now() - 31 * 60 * 1000));

            const { spy: switchTabSpy, called } = spySwitchTab();
            stubBootstrapGlobals(window, switchTabSpy);

            const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
            window.eval(bootstrapSource);

            await called.wait;

            expect(switchTabSpy).toHaveBeenCalledWith('today');
            expect(switchTabSpy).not.toHaveBeenCalledWith('bp');
        } finally {
            cleanup();
        }
    });

    it('falls back to switchTab("today") when the saved section has no activity timestamp', async () => {
        allowConsoleNoise();
        const { window, cleanup } = loadFrontendEnv();
        try {
            stubFetch(window, {
                features: { bp: true, weight: true, medication: true }
            });
            window.featureSettings = { bp: true, weight: true, medication: true };
            // Legacy state: section saved before timestamps were introduced.
            window.localStorage.setItem('mt-active-tab', 'bp');

            const { spy: switchTabSpy, called } = spySwitchTab();
            stubBootstrapGlobals(window, switchTabSpy);

            const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
            window.eval(bootstrapSource);

            await called.wait;

            expect(switchTabSpy).toHaveBeenCalledWith('today');
            expect(switchTabSpy).not.toHaveBeenCalledWith('bp');
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
            window.localStorage.setItem('mt-active-tab-at', String(Date.now()));

            const { spy: switchTabSpy, called } = spySwitchTab();
            stubBootstrapGlobals(window, switchTabSpy);

            const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
            window.eval(bootstrapSource);

            await called.wait;

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
            window.localStorage.setItem('mt-active-tab-at', String(Date.now()));

            const { spy: switchTabSpy, called } = spySwitchTab();
            stubBootstrapGlobals(window, switchTabSpy);

            const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
            window.eval(bootstrapSource);

            await called.wait;

            expect(switchTabSpy).toHaveBeenCalledWith('today');
            expect(switchTabSpy).not.toHaveBeenCalledWith('unknown-id');
        } finally {
            cleanup();
        }
    });
});
