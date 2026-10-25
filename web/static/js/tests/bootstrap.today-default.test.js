import { describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv, createMockResponse, pullToRefresh } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';
import { macrotask, signal } from './helpers/settle.js';
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
        return createMockResponse({ json: {} });
    });
}

function stubBootstrapGlobals(window, switchTabSpy) {
    window.switchTab = switchTabSpy;
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

// Pull to refresh on Today (bd med-y7b4.6): the sync pull only — so with no
// account (local mode) there is nothing to pull and no gesture.
describe('Today pull to refresh (med-y7b4.6)', () => {
    function today() {
        const env = loadFrontendEnv();
        env.window.AppStore.set('currentTab', 'today');
        env.window.safeToast = vi.fn();
        return env;
    }

    it('runs the sync pull only, never the Health import; new entries show an ok toast', async () => {
        const { window, cleanup } = today();
        try {
            const calls = [];
            window.AppRefresh.setImport(async () => { calls.push('import'); return { added: 3 }; }, 'Apple Health', () => true);
            window.AppRefresh.setSync(async () => { calls.push('pull'); return { arrived: true }; });
            pullToRefresh(window);
            const pill = window.document.querySelector('#today-view .wg-ptr');
            expect(pill.textContent).toBe('Syncing…');
            expect(pill.previousElementSibling.classList.contains('wg-appbar')).toBe(true);
            await window.AppRefresh.run();
            expect(calls).toEqual(['pull']);
            expect(window.safeToast).toHaveBeenCalledWith('Synced · new entries', 'success');
        } finally {
            cleanup();
        }
    });

    it('nothing new: the pill just goes, no toast', async () => {
        const { window, cleanup } = today();
        try {
            window.AppRefresh.setSync(async () => ({ arrived: false }));
            pullToRefresh(window);
            await window.AppRefresh.run();
            await macrotask();
            expect(window.document.querySelector('.wg-ptr')).toBeNull();
            expect(window.safeToast).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('local mode: no sync registered, so no gesture and no pull', async () => {
        const { window, cleanup } = today();
        try {
            const importer = vi.fn(async () => ({ added: 1 }));
            window.AppRefresh.setImport(importer, 'Apple Health', () => true);
            pullToRefresh(window, 100, { release: false });
            expect(window.document.querySelector('.wg-ptr')).toBeNull();
            window.document.dispatchEvent(new window.Event('touchend'));
            await window.AppRefresh.run('today');
            expect(importer).not.toHaveBeenCalled();
            expect(window.safeToast).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });
});
