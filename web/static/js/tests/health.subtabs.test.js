// Wandergeek Health sub-tab strip (Phase 8, Task 2).
//
// Asserts the rewritten sub-tab strip uses the Wandergeek primitives —
// kit `.wg-seg` strip, `.wg-seg__opt[aria-pressed]` selection (med-xso6.10) — persists the
// active sub-tab via the `mt-health-subtab` localStorage key, defaults to
// `overview`, and that clicking a sub-tab routes through switchHealthTab()
// to toggle the active-state classes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv, pullToRefresh as pull } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';
import { macrotask, signal } from './helpers/settle.js';

describe('Health sub-tab strip (Phase 8, Task 2)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
        // Stub async sub-tab loaders so they don't reach into `document`
        // after the JSDOM window is closed in afterEach. Tests in this file
        // only care about the DOM class toggles + persistence, not data fetch.
        env.window.loadHealthOverview = () => {};
        env.window.loadNotes = () => {};
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renders the strip as a kit .wg-seg strip with two .health-tab buttons', () => {
        const { document } = env;
        const strip = document.querySelector('#health-subtabs');
        expect(strip).not.toBeNull();
        expect(strip.classList.contains('wg-seg')).toBe(true);

        const buttons = strip.querySelectorAll('.health-tab');
        expect(buttons.length).toBe(2);
        const tabs = Array.from(buttons).map((btn) => btn.dataset.tab);
        expect(tabs).toEqual(['overview', 'notes']);

        buttons.forEach((btn) => {
            expect(btn.classList.contains('wg-seg__opt')).toBe(true);
        });
    });

    it('defaults to the "overview" sub-tab with an aria-pressed selection', () => {
        const { document } = env;
        const buttons = document.querySelectorAll('#health-subtabs .health-tab');
        const overviewBtn = Array.from(buttons).find((b) => b.dataset.tab === 'overview');
        const notesBtn = Array.from(buttons).find((b) => b.dataset.tab === 'notes');

        expect(overviewBtn.getAttribute('aria-pressed')).toBe('true');

        expect(notesBtn.getAttribute('aria-pressed')).toBe('false');
    });

    it('switchHealthTab moves aria-pressed across the strip without inline style', () => {
        const { document, window } = env;
        window.switchHealthTab('notes');

        const buttons = document.querySelectorAll('#health-subtabs .health-tab');
        const overviewBtn = Array.from(buttons).find((b) => b.dataset.tab === 'overview');
        const notesBtn = Array.from(buttons).find((b) => b.dataset.tab === 'notes');

        expect(overviewBtn.getAttribute('aria-pressed')).toBe('false');
        expect(notesBtn.getAttribute('aria-pressed')).toBe('true');

        // No inline style was used to express the active state.
        buttons.forEach((btn) => {
            expect(btn.getAttribute('style')).toBeNull();
        });
    });

    it('switchHealthTab activates the matching tab content panel', () => {
        const { document, window } = env;
        window.switchHealthTab('notes');

        const notesContent = document.getElementById('health-notes-tab');
        expect(notesContent).not.toBeNull();
        expect(notesContent.classList.contains('active')).toBe(true);

        const overviewContent = document.getElementById('health-overview-tab');
        expect(overviewContent.classList.contains('active')).toBe(false);

        const notesBtn = document.querySelector('.health-tab[data-tab="notes"]');
        expect(notesBtn.getAttribute('aria-pressed')).toBe('true');
    });

    it('getActiveHealthSubTab defaults to "overview" when no value is stored', () => {
        const { window } = env;
        window.localStorage.removeItem('mt-health-subtab');
        expect(window.getActiveHealthSubTab()).toBe('overview');
    });

    it('setActiveHealthSubTab round-trips valid values through localStorage', () => {
        const { window } = env;
        window.setActiveHealthSubTab('notes');
        expect(window.localStorage.getItem('mt-health-subtab')).toBe('notes');
        expect(window.getActiveHealthSubTab()).toBe('notes');

        window.setActiveHealthSubTab('overview');
        expect(window.getActiveHealthSubTab()).toBe('overview');
    });

    it('setActiveHealthSubTab ignores invalid values and keeps the previous setting', () => {
        const { window } = env;
        window.setActiveHealthSubTab('notes');
        window.setActiveHealthSubTab('not-a-tab');
        expect(window.getActiveHealthSubTab()).toBe('notes');
    });

    it('switchHealthTab persists the chosen sub-tab to localStorage', () => {
        const { window } = env;
        window.switchHealthTab('notes');
        expect(window.localStorage.getItem('mt-health-subtab')).toBe('notes');

        window.switchHealthTab('overview');
        expect(window.localStorage.getItem('mt-health-subtab')).toBe('overview');
    });

    it('restoreHealthSubTab applies the stored value to the strip', () => {
        const { document, window } = env;
        window.setActiveHealthSubTab('notes');
        window.restoreHealthSubTab();

        const buttons = document.querySelectorAll('#health-subtabs .health-tab');
        const notesBtn = Array.from(buttons).find((b) => b.dataset.tab === 'notes');
        expect(notesBtn.getAttribute('aria-pressed')).toBe('true');
    });
});

// Pull to refresh on Health (bd med-y7b4.6, kit PR1–PR3): the gesture runs the
// Health import, then the sync pull; never a dialog, one refresh at a time.
describe('Health pull to refresh (med-y7b4.6)', () => {
    let env;
    let calls;

    beforeEach(() => {
        env = loadFrontendEnv();
        env.window.AppStore.set('currentTab', 'health');
        env.window.safeToast = vi.fn();
        calls = [];
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    const register = (window, { importer, syncer } = {}) => {
        if (importer !== null) {
            window.AppRefresh.setImport(importer || (async () => { calls.push('import'); return { added: 0 }; }), 'Health Connect', () => true);
        }
        if (syncer !== null) {
            window.AppRefresh.setSync(syncer || (async () => { calls.push('pull'); return { arrived: false }; }));
        }
    };

    it('the pill names the source, flips at the threshold, and below it a release does nothing', () => {
        const { window, document } = env;
        register(window);
        pull(window, 30, { release: false });
        const pill = document.querySelector('#health-view .wg-ptr');
        expect(pill.textContent).toBe('Pull to check Health Connect');
        expect(pill.classList.contains('wg-ptr--ready')).toBe(false);
        // It sits under the segment strips, above the content.
        expect(pill.previousElementSibling.id).toBe('health-subtabs');
        window.document.dispatchEvent(new window.Event('touchend'));
        expect(document.querySelector('.wg-ptr')).toBeNull();
        expect(calls).toEqual([]);

        pull(window, 90, { release: false });
        expect(document.querySelector('.wg-ptr').textContent).toBe('Release to check Health Connect');
        expect(document.querySelector('.wg-ptr').classList.contains('wg-ptr--ready')).toBe(true);
    });

    it('a release past the threshold imports, then pulls; nothing new shows no toast', async () => {
        const { window, document } = env;
        register(window);
        pull(window);
        expect(document.querySelector('.wg-ptr').classList.contains('wg-ptr--busy')).toBe(true);
        await window.AppRefresh.run();
        await macrotask();
        expect(calls).toEqual(['import', 'pull']);
        expect(window.safeToast).not.toHaveBeenCalled();
        expect(document.querySelector('.wg-ptr')).toBeNull();
    });

    it('new readings show one ok toast naming the store', async () => {
        const { window } = env;
        register(window, { importer: async () => ({ added: 12 }) });
        pull(window);
        await window.AppRefresh.run();
        expect(window.safeToast).toHaveBeenCalledWith('12 new readings from Health Connect', 'success');
    });

    it('a second pull while one is in flight is ignored', async () => {
        const { window } = env;
        const entered = signal();
        let finish;
        register(window, {
            importer: () => {
                calls.push('import');
                entered.fire();
                return new Promise((resolve) => { finish = () => resolve({ added: 0 }); });
            },
        });
        pull(window);
        await entered.wait;
        pull(window);
        expect(window.document.querySelectorAll('.wg-ptr')).toHaveLength(1);
        finish();
        await window.AppRefresh.run();
        await macrotask();
        expect(calls).toEqual(['import', 'pull']);
    });

    it('a failed import still pulls, then shows one danger toast with the fix, no dialog', async () => {
        allowConsoleNoise();
        const { window } = env;
        const confirmSpy = vi.spyOn(window, 'confirm');
        register(window, { importer: async () => { throw new Error('denied'); } });
        pull(window);
        await window.AppRefresh.run();
        expect(calls).toEqual(['pull']);
        expect(window.safeToast).toHaveBeenCalledTimes(1);
        expect(window.safeToast).toHaveBeenCalledWith("Couldn't read Health Connect · check its access in Settings", 'error');
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('a failed pull shows its message as a danger toast', async () => {
        allowConsoleNoise();
        const { window } = env;
        register(window, { syncer: async () => { throw new Error('Offline · showing what\'s on this device'); } });
        pull(window);
        await window.AppRefresh.run();
        expect(calls).toEqual(['import']);
        expect(window.safeToast).toHaveBeenCalledWith('Offline · showing what\'s on this device', 'error');
    });

    it('local mode (no account) imports only', async () => {
        const { window } = env;
        register(window, { syncer: null });
        pull(window);
        await window.AppRefresh.run();
        expect(calls).toEqual(['import']);
    });

    it('no gesture while a sheet is open', () => {
        const { window, document } = env;
        register(window);
        document.getElementById('importexport-export-sheet').classList.remove('hidden');
        pull(window);
        expect(document.querySelector('.wg-ptr')).toBeNull();
        expect(calls).toEqual([]);
    });

    it('no gesture when the page is scrolled down', () => {
        const { window, document } = env;
        register(window);
        Object.defineProperty(window, 'scrollY', { value: 200, configurable: true });
        pull(window);
        expect(document.querySelector('.wg-ptr')).toBeNull();
        expect(calls).toEqual([]);
    });
});
