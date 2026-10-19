import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const STATE_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/state.js');
const WELCOME_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/screens/welcome.js');
const DONE_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/screens/done.js');
const INDEX_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/index.js');

// features/firstrun/screens/welcome.js — Task 4. Renders the first
// screen of the post-install overlay (welcome + "Get started" + "Skip
// all"). "Get started" advances the step tracker to "features";
// "Skip all" POSTs /api/firstrun/complete and dismisses without
// touching the remaining screens.

const SHELL_HTML = `<!doctype html><html><body></body></html>`;

function loadFlow({ bootstrap = null, fetchMock = null } = {}) {
    const dom = new JSDOM(SHELL_HTML, {
        url: 'https://example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    if (bootstrap) window.__MEDTRACKER_BOOTSTRAP__ = bootstrap;
    if (fetchMock) window.fetch = fetchMock;

    // Load order mirrors index.html: state + screen modules first, then
    // the orchestrator. Either order works in production because each
    // file defensively initialises window.WGFirstRun, but matching the
    // shipped order keeps the test honest.
    for (const file of [STATE_JS, WELCOME_JS, DONE_JS, INDEX_JS]) {
        const src = fs.readFileSync(file, 'utf8');
        window.eval(`${src}\n//# sourceURL=file://${file}`);
    }

    return { window, document: window.document, cleanup: () => dom.window.close() };
}

describe('firstrun welcome screen', () => {
    it('renders the welcome copy and both action buttons', () => {
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
        });
        try {
            window.WGFirstRun.mount();

            const title = document.getElementById('wg-firstrun-title');
            expect(title.textContent).toMatch(/welcome/i);

            const body = document.getElementById('wg-firstrun-overlay-body');
            expect(body.querySelector('.wg-firstrun-screen__tagline')).not.toBeNull();

            const getStarted = body.querySelector('[data-firstrun-action="advance"]');
            const skipAll = body.querySelector('[data-firstrun-action="skip-all"]');
            expect(getStarted).not.toBeNull();
            expect(getStarted.textContent).toBe('Get started');
            expect(getStarted.classList.contains('wg-btn')).toBe(true);
            expect(getStarted.classList.contains('wg-btn--primary')).toBe(true);
            expect(skipAll).not.toBeNull();
            expect(skipAll.textContent).toBe('Skip all');
            expect(skipAll.classList.contains('wg-btn')).toBe(true);
            expect(skipAll.classList.contains('wg-btn--ghost')).toBe(true);
        } finally { cleanup(); }
    });

    // med-xso6.11: the overlay shows the kit step indicator (.wg-steps), one
    // bar per step, and it follows the flow as the user advances.
    it('shows a step indicator that tracks the current step', () => {
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
        });
        try {
            window.WGFirstRun.mount();
            const steps = document.querySelector('#wg-firstrun-overlay .wg-steps');
            expect(steps).not.toBeNull();
            const bars = () => [...steps.querySelectorAll('i')].map((i) => i.className);
            expect(bars()).toEqual(['is-now', '', '', '']);
            expect(steps.getAttribute('aria-valuetext')).toBe('Step 1 of 4');

            document.querySelector('[data-firstrun-action="advance"]').click();
            expect(bars()).toEqual(['is-done', 'is-now', '', '']);
            expect(steps.getAttribute('aria-valuenow')).toBe('2');
        } finally { cleanup(); }
    });

    it('"Get started" advances the step tracker to features', () => {
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
        });
        try {
            window.WGFirstRun.mount();
            const getStarted = document.querySelector('[data-firstrun-action="advance"]');
            getStarted.click();
            expect(window.WGFirstRun.state.getStep()).toBe('features');
            expect(window.sessionStorage.getItem('wg-firstrun-step')).toBe('features');
        } finally { cleanup(); }
    });

    it('"Get started" re-renders the panel (features screen unregistered → empty body)', () => {
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
        });
        try {
            window.WGFirstRun.mount();
            const before = document.querySelector('[data-firstrun-action="advance"]');
            expect(before).not.toBeNull();
            before.click();
            // Permissions screen is a Task 5 deliverable — until it lands
            // the orchestrator clears the body and the welcome buttons
            // are gone. State has still advanced; the screen will render
            // once the module is added.
            expect(document.querySelector('[data-firstrun-action="advance"]')).toBeNull();
            const title = document.getElementById('wg-firstrun-title');
            expect(title.textContent).toBe('');
        } finally { cleanup(); }
    });

    it('"Skip all" POSTs /api/firstrun/complete and dismisses the overlay', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            fetchMock,
        });
        try {
            window.WGFirstRun.mount();
            const skipAll = document.querySelector('[data-firstrun-action="skip-all"]');
            skipAll.click();
            // The click handler returns a promise via complete(); flush
            // microtasks so the .then(dismiss) chain settles.
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, opts] = fetchMock.mock.calls[0];
            expect(url).toBe('/api/firstrun/complete');
            expect(opts.method).toBe('POST');

            expect(document.getElementById('wg-firstrun-overlay')).toBeNull();
            expect(window.WGFirstRun.isActive()).toBe(false);
            expect(window.sessionStorage.getItem('wg-firstrun-step')).toBeNull();
            expect(window.__MEDTRACKER_BOOTSTRAP__.needs_first_run).toBe(false);
        } finally { cleanup(); }
    });

    it('"Skip all" still dismisses if the POST rejects (offline-safe)', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            fetchMock,
        });
        try {
            window.WGFirstRun.mount();
            document.querySelector('[data-firstrun-action="skip-all"]').click();
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(document.getElementById('wg-firstrun-overlay')).toBeNull();
            expect(window.WGFirstRun.isActive()).toBe(false);
        } finally { cleanup(); }
    });

    // bd med-o7zq.30: in the iOS app's account the welcome screen offers the
    // way to device-only mode — confirm, then the shell leaves the account.
    describe('"Use only on this device" (iOS account)', () => {
        function setup({ platform = 'ios', leave = true, confirm = true } = {}) {
            const flow = loadFlow({ bootstrap: { needs_first_run: true } });
            const { window } = flow;
            window.LocalNotifications = { __native: { platform } };
            const leaveAccount = vi.fn().mockResolvedValue(undefined);
            window.CloudVault = leave ? { leaveAccount } : { exportAll() {} };
            window.safeConfirm = vi.fn().mockResolvedValue(confirm);
            window.safeAlert = vi.fn().mockResolvedValue(undefined);
            window.WGFirstRun.mount();
            const btn = flow.document.querySelector('[data-firstrun-action="device-only"]');
            return { ...flow, btn, leaveAccount };
        }
        const tick = () => new Promise(resolve => setTimeout(resolve, 0));

        it('leaves the account once the user confirms', async () => {
            const { window, btn, leaveAccount, cleanup } = setup();
            try {
                expect(btn).not.toBeNull();
                expect(btn.textContent).toBe('Use only on this device');
                btn.click();
                await tick();
                expect(window.safeConfirm).toHaveBeenCalledTimes(1);
                expect(window.safeConfirm.mock.calls[0][0]).toMatch(/Nothing is deleted/);
                expect(leaveAccount).toHaveBeenCalledTimes(1);
            } finally { cleanup(); }
        });

        it('stays put when the user cancels', async () => {
            const { btn, leaveAccount, cleanup } = setup({ confirm: false });
            try {
                btn.click();
                await tick();
                expect(leaveAccount).not.toHaveBeenCalled();
                expect(btn.disabled).toBe(false);
            } finally { cleanup(); }
        });

        it('says why when the shell cannot leave', async () => {
            const { window, btn, leaveAccount, cleanup } = setup();
            try {
                leaveAccount.mockRejectedValue(new Error('Update Med Tracker'));
                btn.click();
                await tick(); await tick();
                expect(window.safeAlert).toHaveBeenCalledWith('Update Med Tracker');
            } finally { cleanup(); }
        });

        it('is absent on the web and in device-only mode', () => {
            for (const opts of [{ platform: 'web' }, { leave: false }]) {
                const { btn, cleanup } = setup(opts);
                try { expect(btn).toBeNull(); } finally { cleanup(); }
            }
        });
    });
});
