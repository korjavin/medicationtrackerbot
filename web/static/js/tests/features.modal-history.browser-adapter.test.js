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
const UTILS_SRC = fs.readFileSync(
    path.join(REPO_ROOT, 'web/static/js/core/utils.js'), 'utf8');
const MODAL_MANAGER_SRC = fs.readFileSync(
    path.join(REPO_ROOT, 'web/static/js/core/modal-manager.js'), 'utf8');

function flush() { return new Promise((resolve) => setTimeout(resolve, 0)); }

// history.back() in jsdom: one task to traverse, one more to fire popstate.
async function settleHistory() { await flush(); await flush(); await flush(); }

function createBrowserEnv() {
    const dom = new JSDOM(
        `<!doctype html><html><body>
            <div id="modal-overlay" class="hidden">
                <div id="bp-modal" class="hidden"></div>
            </div>
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
    window.eval(UTILS_SRC);
    window.eval(MODAL_MANAGER_SRC);
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

    // bd med-62lh: the in-page dialog (safeConfirm/safePrompt/safeChoose)
    // mounts on <body> outside #modal-overlay; it owns its own history entry.
    describe('in-page dialog (safeConfirm) and Back', () => {
        function dialogMounted(document) {
            return !!document.querySelector('mt-modal.mt-confirm-modal');
        }

        it('Back over a dialog on a plain section cancels it and stays; the next Back goes to Today', async () => {
            const { window, document, cleanup } = createBrowserEnv();
            try {
                await settleHistory();
                const pending = window.safeConfirm('Delete?');
                await flush();
                expect(dialogMounted(document)).toBe(true);
                window.switchTab.mockClear();

                window.history.back();
                await settleHistory();

                await expect(pending).resolves.toBe(false);
                expect(dialogMounted(document)).toBe(false);
                expect(window.switchTab).not.toHaveBeenCalled();
                expect(window.AppStore.get('currentTab')).toBe('bp');

                window.history.back();
                await settleHistory();
                expect(window.switchTab).toHaveBeenCalledWith('today');
            } finally { cleanup(); }
        });

        it('Back over a dialog on Today cancels it without leaving the app', async () => {
            const { window, document, cleanup } = createBrowserEnv();
            try {
                window.AppStore.set('currentTab', 'today');
                await settleHistory();
                const pending = window.safePrompt('Name?');
                await flush();
                expect(window.history.state).toEqual({ modalDialog: true });
                window.switchTab.mockClear();

                window.history.back();
                await settleHistory();

                await expect(pending).resolves.toBe(null);
                expect(dialogMounted(document)).toBe(false);
                expect(window.switchTab).not.toHaveBeenCalled();
                // Back consumed the dialog's own entry, not the page's.
                expect(window.history.state).toBe(null);
                expect(window.location.href).toBe('https://example.test/');
            } finally { cleanup(); }
        });

        it('Back over a dialog on a registered modal cancels only the dialog', async () => {
            const { window, document, cleanup } = createBrowserEnv();
            try {
                window.ModalManager.bp.open();
                await settleHistory();
                const pending = window.safeConfirm('Discard?');
                await flush();
                window.switchTab.mockClear();

                window.history.back();
                await settleHistory();

                await expect(pending).resolves.toBe(false);
                expect(dialogMounted(document)).toBe(false);
                expect(document.getElementById('bp-modal').classList.contains('hidden')).toBe(false);
                expect(document.getElementById('modal-overlay').classList.contains('hidden')).toBe(false);
                expect(window.switchTab).not.toHaveBeenCalled();

                // The parent modal's own entry is intact: the next Back closes it.
                window.history.back();
                await settleHistory();
                expect(document.getElementById('bp-modal').classList.contains('hidden')).toBe(true);
                expect(window.switchTab).not.toHaveBeenCalled();
            } finally { cleanup(); }
        });

        it('the in-app chevron with a dialog open cancels the dialog and keeps the tab', async () => {
            const { window, document, cleanup } = createBrowserEnv();
            try {
                await settleHistory();
                const pending = window.safeConfirm('Delete?');
                await flush();
                window.switchTab.mockClear();

                document.getElementById('wg-browser-back-button').click();
                await settleHistory();

                await expect(pending).resolves.toBe(false);
                expect(dialogMounted(document)).toBe(false);
                expect(window.switchTab).not.toHaveBeenCalled();
                expect(window.AppStore.get('currentTab')).toBe('bp');
            } finally { cleanup(); }
        });

        it.each([
            ['its Confirm button', (d) => d.querySelector('.mt-confirm-modal__confirm').click(), true],
            ['its Cancel button', (d) => d.querySelector('.mt-confirm-modal__cancel').click(), false],
            ['Escape', (d, w) => d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' })), false],
            ['the backdrop', (d) => d.querySelector('.mt-confirm-backdrop').click(), false],
        ])('closing a dialog via %s pops exactly its entry and does not bounce to Today', async (_label, close, expected) => {
            const { window, document, cleanup } = createBrowserEnv();
            try {
                await settleHistory();
                const before = window.history.length;
                const pending = window.safeConfirm('Delete?');
                await flush();
                const backSpy = vi.spyOn(window.history, 'back');
                window.switchTab.mockClear();

                close(document, window);
                await settleHistory();

                await expect(pending).resolves.toBe(expected);
                expect(backSpy).toHaveBeenCalledTimes(1);
                expect(window.history.length).toBe(before + 1);
                expect(window.history.state).toEqual({ wgSectionBack: true });
                expect(window.switchTab).not.toHaveBeenCalled();
                expect(window.AppStore.get('currentTab')).toBe('bp');
            } finally { cleanup(); }
        });
    });
});
