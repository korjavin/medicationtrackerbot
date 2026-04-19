/**
 * features.back-button.test.js
 *
 * Task 4 — Telegram WebApp BackButton wiring for section-level navigation.
 *
 * features/back-button.js drives the BackButton with three behaviors:
 *   1. show on non-Today views, hide on Today (when no modal is open)
 *   2. clicking BackButton returns to Today when no modal is open
 *   3. when a modal IS open, defers to modal-history.js (no-op here)
 *
 * Uses a hand-rolled JSDOM setup rather than the shared frontend-harness so
 * the BackButton mock can record ALL registered onClick handlers — the shared
 * harness mock stores only the last handler, which loses modal-history's
 * wiring when back-button.js is also loaded.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const STORE_JS = path.join(REPO_ROOT, 'web/static/js/core/store.js');
const BACK_BUTTON_JS = path.join(REPO_ROOT, 'web/static/js/features/back-button.js');

function isVersionAtLeast(current, target) {
    const a = String(current).split('.').map((v) => parseInt(v, 10) || 0);
    const b = String(target).split('.').map((v) => parseInt(v, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const av = a[i] || 0;
        const bv = b[i] || 0;
        if (av > bv) return true;
        if (av < bv) return false;
    }
    return true;
}

function createEnv({ telegramVersion = '6.9' } = {}) {
    const dom = new JSDOM(
        `<!doctype html><html><body>
            <div id="modal-overlay" class="hidden"></div>
            <div id="today-view" class="view active"></div>
            <div id="bp-view" class="view"></div>
            <div id="settings-view" class="view"></div>
        </body></html>`,
        { url: 'https://example.test/', runScripts: 'outside-only' }
    );
    const { window } = dom;

    const backButtonState = {
        showCalls: 0,
        hideCalls: 0,
        handlers: []
    };
    const backButton = {
        show() { backButtonState.showCalls += 1; },
        hide() { backButtonState.hideCalls += 1; },
        onClick(cb) { backButtonState.handlers.push(cb); }
    };

    window.Telegram = {
        WebApp: {
            isVersionAtLeast(v) { return isVersionAtLeast(telegramVersion, v); },
            BackButton: backButton
        }
    };

    // Minimal switchTab stub: toggles .view.active + publishes currentTab to AppStore.
    window.switchTab = vi.fn((tab) => {
        window.document.querySelectorAll('.view').forEach((el) => el.classList.remove('active'));
        const target = window.document.getElementById(`${tab}-view`);
        if (target) target.classList.add('active');
        if (window.AppStore) window.AppStore.set('currentTab', tab);
    });

    window.eval(fs.readFileSync(STORE_JS, 'utf8'));
    window.eval(fs.readFileSync(BACK_BUTTON_JS, 'utf8'));

    return {
        window,
        document: window.document,
        backButtonState,
        cleanup: () => dom.window.close()
    };
}

describe('features/back-button.js — Telegram BackButton for section navigation', () => {
    it('exposes AppBackButton.setup on window', () => {
        const { window, cleanup } = createEnv();
        try {
            expect(window.AppBackButton).toBeDefined();
            expect(typeof window.AppBackButton.setup).toBe('function');
        } finally {
            cleanup();
        }
    });

    it('registers a BackButton click handler on setup', () => {
        const { window, backButtonState, cleanup } = createEnv();
        try {
            window.AppBackButton.setup();
            expect(backButtonState.handlers.length).toBe(1);
        } finally {
            cleanup();
        }
    });

    it('hides the BackButton while on Today', () => {
        const { window, backButtonState, cleanup } = createEnv();
        try {
            window.AppBackButton.setup();
            // initial currentTab is empty; refreshBackButton(\"\") hides.
            expect(backButtonState.hideCalls).toBeGreaterThan(0);
            const baseline = backButtonState.hideCalls;
            window.switchTab('today');
            expect(backButtonState.hideCalls).toBeGreaterThan(baseline);
        } finally {
            cleanup();
        }
    });

    it('shows the BackButton when navigating to a section view', () => {
        const { window, backButtonState, cleanup } = createEnv();
        try {
            window.AppBackButton.setup();
            const before = backButtonState.showCalls;
            window.switchTab('bp');
            expect(backButtonState.showCalls).toBeGreaterThan(before);
        } finally {
            cleanup();
        }
    });

    it('hides the BackButton when returning to Today from a section', () => {
        const { window, backButtonState, cleanup } = createEnv();
        try {
            window.AppBackButton.setup();
            window.switchTab('bp');
            const before = backButtonState.hideCalls;
            window.switchTab('today');
            expect(backButtonState.hideCalls).toBeGreaterThan(before);
        } finally {
            cleanup();
        }
    });

    it('click handler calls switchTab("today") when no modal is open', () => {
        const { window, backButtonState, cleanup } = createEnv();
        try {
            window.AppBackButton.setup();
            window.switchTab('bp');
            window.switchTab.mockClear();

            backButtonState.handlers[0]();

            expect(window.switchTab).toHaveBeenCalledWith('today');
        } finally {
            cleanup();
        }
    });

    it('click handler defers to modal-history when a modal is open', () => {
        const { window, document, backButtonState, cleanup } = createEnv();
        try {
            window.AppBackButton.setup();
            window.switchTab('bp');
            document.getElementById('modal-overlay').classList.remove('hidden');
            window.switchTab.mockClear();

            backButtonState.handlers[0]();

            expect(window.switchTab).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('does not drive show/hide when a modal is open (modal-history owns visibility)', () => {
        const { window, document, backButtonState, cleanup } = createEnv();
        try {
            window.AppBackButton.setup();
            document.getElementById('modal-overlay').classList.remove('hidden');
            const showBefore = backButtonState.showCalls;
            const hideBefore = backButtonState.hideCalls;

            window.switchTab('bp');

            expect(backButtonState.showCalls).toBe(showBefore);
            expect(backButtonState.hideCalls).toBe(hideBefore);
        } finally {
            cleanup();
        }
    });

    it('skips wiring entirely on unsupported Telegram WebApp versions', () => {
        const { window, backButtonState, cleanup } = createEnv({ telegramVersion: '6.0' });
        try {
            window.AppBackButton.setup();
            window.switchTab('bp');
            expect(backButtonState.handlers.length).toBe(0);
            expect(backButtonState.showCalls).toBe(0);
            expect(backButtonState.hideCalls).toBe(0);
        } finally {
            cleanup();
        }
    });
});
