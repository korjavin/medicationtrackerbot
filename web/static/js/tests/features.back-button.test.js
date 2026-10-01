/**
 * features.back-button.test.js
 *
 * BrowserAdapter back-button wiring for section-level navigation.
 *
 * features/back-button.js registers one back handler on
 * window.MessengerAdapter and drives three behaviors:
 *   1. show the in-app chevron on non-Today views, hide it on Today (when no modal is open)
 *   2. back (chevron tap / browser back) returns to Today when no modal is open
 *   3. when a modal IS open, back closes the topmost modal (via ModalManager)
 *
 * It also exposes AppBackButton.refresh() so modal-history.js can ask for a
 * visibility recomputation after a modal closes on a non-Today section.
 *
 * Uses a hand-rolled JSDOM setup that loads the real BrowserAdapter and
 * observes the in-app chevron element (#wg-browser-back-button), without
 * wiring the full frontend-harness.
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
const MESSENGER_ADAPTER_JS = path.join(REPO_ROOT, 'web/static/js/core/messenger-adapter.js');
const BACK_BUTTON_JS = path.join(REPO_ROOT, 'web/static/js/features/back-button.js');
const MODAL_MANAGER_JS = path.join(REPO_ROOT, 'web/static/js/core/modal-manager.js');

function createEnv() {
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

    // Minimal switchTab stub: toggles .view.active + publishes currentTab to AppStore.
    window.switchTab = vi.fn((tab) => {
        window.document.querySelectorAll('.view').forEach((el) => el.classList.remove('active'));
        const target = window.document.getElementById(`${tab}-view`);
        if (target) target.classList.add('active');
        if (window.AppStore) window.AppStore.set('currentTab', tab);
    });

    window.eval(fs.readFileSync(STORE_JS, 'utf8'));
    // Real ModalManager: back-button.js asks it whether a modal is open.
    window.eval(fs.readFileSync(MODAL_MANAGER_JS, 'utf8'));
    // Load the messenger adapter so back-button.js can call
    // window.MessengerAdapter.{isBackButtonSupported,onBack,showBack,hideBack}
    // (the BrowserAdapter renders the in-app chevron observed below).
    window.eval(fs.readFileSync(MESSENGER_ADAPTER_JS, 'utf8'));
    window.eval(fs.readFileSync(BACK_BUTTON_JS, 'utf8'));

    return {
        window,
        document: window.document,
        chevronVisible: () => {
            const el = window.document.getElementById('wg-browser-back-button');
            return !!el && el.hidden === false;
        },
        pressBack: () => {
            window.dispatchEvent(new window.Event('popstate'));
        },
        cleanup: () => dom.window.close()
    };
}

describe('features/back-button.js — BrowserAdapter back chevron for section navigation', () => {
    it('exposes AppBackButton.setup on window', () => {
        const { window, cleanup } = createEnv();
        try {
            expect(window.AppBackButton).toBeDefined();
            expect(typeof window.AppBackButton.setup).toBe('function');
        } finally {
            cleanup();
        }
    });

    it('registers a back handler on setup', () => {
        const { window, cleanup } = createEnv();
        try {
            const onBackSpy = vi.spyOn(window.MessengerAdapter, 'onBack');
            window.AppBackButton.setup();
            expect(onBackSpy).toHaveBeenCalledTimes(1);
            expect(typeof onBackSpy.mock.calls[0][0]).toBe('function');
        } finally {
            cleanup();
        }
    });

    it('hides the chevron while on Today', () => {
        const { window, chevronVisible, cleanup } = createEnv();
        try {
            window.AppBackButton.setup();
            // initial currentTab resolves to Today via the .view.active DOM.
            expect(chevronVisible()).toBe(false);
            window.switchTab('today');
            expect(chevronVisible()).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('shows the chevron when navigating to a section view', () => {
        const { window, chevronVisible, cleanup } = createEnv();
        try {
            window.AppBackButton.setup();
            expect(chevronVisible()).toBe(false);
            window.switchTab('bp');
            expect(chevronVisible()).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('hides the chevron when returning to Today from a section', () => {
        const { window, chevronVisible, cleanup } = createEnv();
        try {
            window.AppBackButton.setup();
            window.switchTab('bp');
            expect(chevronVisible()).toBe(true);
            window.switchTab('today');
            expect(chevronVisible()).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('back handler calls switchTab("today") when no modal is open', () => {
        const { window, pressBack, cleanup } = createEnv();
        try {
            window.AppBackButton.setup();
            window.switchTab('bp');
            window.switchTab.mockClear();

            pressBack();

            expect(window.switchTab).toHaveBeenCalledWith('today');
        } finally {
            cleanup();
        }
    });

    it('back handler closes top-most modal (via ModalManager) when one is open', () => {
        const { window, document, pressBack, cleanup } = createEnv();
        try {
            const closeSpy = vi.spyOn(window.ModalManager, 'closeTopMostVisibleModal').mockImplementation(() => true);
            window.AppBackButton.setup();
            window.switchTab('bp');
            document.getElementById('modal-overlay').classList.remove('hidden');
            window.switchTab.mockClear();

            pressBack();

            expect(closeSpy).toHaveBeenCalled();
            expect(window.switchTab).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    // bd med-62lh: the in-page dialog mounts outside #modal-overlay but still
    // counts as an open modal.
    it('back handler cancels an in-page dialog instead of switching tabs', () => {
        const { window, document, pressBack, cleanup } = createEnv();
        try {
            window.AppBackButton.setup();
            window.switchTab('bp');
            const dialog = document.createElement('mt-modal');
            dialog.className = 'wg-modal mt-confirm-modal';
            const cancel = document.createElement('button');
            cancel.className = 'mt-confirm-modal__cancel';
            const cancelSpy = vi.fn(() => dialog.remove());
            cancel.addEventListener('click', cancelSpy);
            dialog.appendChild(cancel);
            document.body.appendChild(dialog);
            window.switchTab.mockClear();

            pressBack();

            expect(cancelSpy).toHaveBeenCalledTimes(1);
            expect(window.switchTab).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('exposes refresh() that recomputes visibility from currentTab', () => {
        const { window, chevronVisible, cleanup } = createEnv();
        try {
            window.AppBackButton.setup();
            window.switchTab('bp');
            // Simulate modal-history hiding the chevron when a modal opened
            // and closed on a section view. refresh() should re-show it
            // because currentTab is bp.
            window.MessengerAdapter.hideBack();
            expect(chevronVisible()).toBe(false);
            window.AppBackButton.refresh();
            expect(chevronVisible()).toBe(true);

            window.switchTab('today');
            // Simulate a stale visible chevron; refresh() hides it on Today.
            window.MessengerAdapter.showBack();
            window.AppBackButton.refresh();
            expect(chevronVisible()).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('refresh() is a no-op while a modal is open (modal-history owns visibility)', () => {
        const { window, document, chevronVisible, cleanup } = createEnv();
        try {
            window.AppBackButton.setup();
            window.switchTab('bp');
            document.getElementById('modal-overlay').classList.remove('hidden');

            window.AppBackButton.refresh();

            expect(chevronVisible()).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('does not drive show/hide when a modal is open (modal-history owns visibility)', () => {
        const { window, document, chevronVisible, cleanup } = createEnv();
        try {
            window.AppBackButton.setup();
            document.getElementById('modal-overlay').classList.remove('hidden');

            window.switchTab('bp');

            expect(chevronVisible()).toBe(false);
        } finally {
            cleanup();
        }
    });

    // Regression for the messenger-adapter plan: back-button.js reaches the
    // back affordance only through window.MessengerAdapter
    // (onBack / showBack / hideBack). Spy on the adapter to lock in that the
    // wiring delegates instead of touching a host SDK directly.
    it('routes back-button calls through window.MessengerAdapter', () => {
        const { window, cleanup } = createEnv();
        try {
            const onBackSpy = vi.spyOn(window.MessengerAdapter, 'onBack');
            const showSpy = vi.spyOn(window.MessengerAdapter, 'showBack');
            const hideSpy = vi.spyOn(window.MessengerAdapter, 'hideBack');

            window.AppBackButton.setup();
            window.switchTab('bp');
            window.switchTab('today');

            expect(onBackSpy).toHaveBeenCalledTimes(1);
            expect(showSpy).toHaveBeenCalled();
            expect(hideSpy).toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });
});
