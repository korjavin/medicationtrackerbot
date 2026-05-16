// Regression for the modal-close-via-X bounce-to-Today bug in BrowserAdapter
// mode. When window.Telegram is absent, BrowserAdapter.onBack registers a
// popstate listener that drives section-back (switchTab('today')). Closing a
// modal via in-app Cancel/X fires onOverlayClosed → history.back() → popstate.
// Without the swallowNextPopstate guard in modal-history.js, BrowserAdapter's
// listener also fires and kicks the user off the current section.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ADAPTER_SRC = fs.readFileSync(
    path.join(REPO_ROOT, 'web/static/js/core/messenger-adapter.js'), 'utf8');
const STORE_SRC = fs.readFileSync(
    path.join(REPO_ROOT, 'web/static/js/core/store.js'), 'utf8');
const MODAL_HISTORY_SRC = fs.readFileSync(
    path.join(REPO_ROOT, 'web/static/js/features/modal-history.js'), 'utf8');
const BACK_BUTTON_SRC = fs.readFileSync(
    path.join(REPO_ROOT, 'web/static/js/features/back-button.js'), 'utf8');

function flush() { return new Promise((resolve) => setTimeout(resolve, 0)); }

function createBrowserEnv() {
    const dom = new JSDOM(
        `<!doctype html><html><body>
            <div id="modal-overlay" class="hidden"></div>
            <div id="today-view" class="view active"></div>
            <div id="bp-view" class="view"></div>
        </body></html>`,
        { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true }
    );
    const { window } = dom;
    expect(window.Telegram).toBeUndefined();

    window.switchTab = vi.fn((tab) => {
        if (window.AppStore) window.AppStore.set('currentTab', tab);
    });
    window.ModalManager = {
        closeTopMostVisibleModal: vi.fn(() => {
            window.document.getElementById('modal-overlay').classList.add('hidden');
        })
    };

    window.eval(STORE_SRC);
    window.eval(ADAPTER_SRC);
    window.eval(MODAL_HISTORY_SRC);
    window.eval(BACK_BUTTON_SRC);

    window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
    window.AppBackButton.setup();
    window.AppStore.set('currentTab', 'bp');

    return { window, document: window.document, cleanup: () => dom.window.close() };
}

describe('modal-history.js in BrowserAdapter mode', () => {
    it('selects BrowserAdapter when Telegram is absent', () => {
        const { window, cleanup } = createBrowserEnv();
        try {
            expect(window.MessengerAdapter.isPresent()).toBe(false);
        } finally { cleanup(); }
    });

    it('does not bounce to Today when an in-app modal close (X / Cancel) fires history.back()', async () => {
        const { window, document, cleanup } = createBrowserEnv();
        try {
            const overlay = document.getElementById('modal-overlay');

            // Open modal (overlay becomes visible) → MutationObserver fires
            // onOverlayShown → modalPushed=true, history.pushState.
            overlay.classList.remove('hidden');
            await flush();

            window.switchTab.mockClear();

            // User clicks Cancel/X — overlay becomes hidden → MutationObserver
            // fires onOverlayClosed → swallowNextPopstate=true, history.back()
            // → popstate. With the guard, modal-history consumes the popstate
            // and stops propagation; BrowserAdapter's section-back listener
            // must NOT fire and switchTab('today') must NOT be called.
            overlay.classList.add('hidden');
            await flush();
            await flush();

            expect(window.switchTab).not.toHaveBeenCalledWith('today');
        } finally { cleanup(); }
    });

    it('still routes browser-back to switchTab("today") when no modal is open', async () => {
        const { window, cleanup } = createBrowserEnv();
        try {
            // No modal opened in this run. A bare popstate (user hits browser
            // back on a section view) should reach BrowserAdapter's listener
            // and trigger section-back.
            window.switchTab.mockClear();
            window.dispatchEvent(new window.Event('popstate'));
            await flush();
            expect(window.switchTab).toHaveBeenCalledWith('today');
        } finally { cleanup(); }
    });
});
