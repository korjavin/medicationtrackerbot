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

// features/firstrun/screens/done.js — Task 4. Terminal screen of the
// first-run overlay: a single "Open app" button that POSTs the
// completion endpoint and dismisses. After completion the in-memory
// bootstrap flag is flipped to false so a same-session re-mount is a
// no-op; the next server bootstrap will also return false because
// settings.first_run_complete is now true.

const SHELL_HTML = `<!doctype html><html><body></body></html>`;

function loadFlow({ bootstrap = null, fetchMock = null, initialStep = null, cloud = false, trialVoice = false } = {}) {
    const dom = new JSDOM(SHELL_HTML, {
        url: 'https://example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    if (bootstrap) window.__MEDTRACKER_BOOTSTRAP__ = bootstrap;
    if (fetchMock) window.fetch = fetchMock;
    if (initialStep) window.sessionStorage.setItem('wg-firstrun-step', initialStep);
    if (cloud) window.__MEDTRACKER_CLOUD__ = true;
    if (trialVoice) {
        const meta = window.document.createElement('meta');
        meta.name = 'medtracker-trial-voice';
        meta.content = '1';
        window.document.head.appendChild(meta);
    }

    for (const file of [STATE_JS, WELCOME_JS, DONE_JS, INDEX_JS]) {
        const src = fs.readFileSync(file, 'utf8');
        window.eval(`${src}\n//# sourceURL=file://${file}`);
    }

    return { window, document: window.document, cleanup: () => dom.window.close() };
}

describe('firstrun done screen', () => {
    it('renders the done message and a single "Open app" button when step=done', () => {
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            initialStep: 'done',
        });
        try {
            window.WGFirstRun.mount();

            const title = document.getElementById('wg-firstrun-title');
            expect(title.textContent).toMatch(/all set/i);

            const body = document.getElementById('wg-firstrun-overlay-body');
            expect(body.querySelector('.wg-firstrun-screen__tagline')).not.toBeNull();

            const openApp = body.querySelector('[data-firstrun-action="open-app"]');
            expect(openApp).not.toBeNull();
            expect(openApp.textContent).toBe('Open app');
            expect(openApp.classList.contains('wg-firstrun-btn--primary')).toBe(true);

            // No secondary button on the terminal screen — there is no
            // "back" path and no separate skip; the user only has one
            // way forward.
            expect(body.querySelectorAll('button').length).toBe(1);
        } finally { cleanup(); }
    });

    it('"Open app" POSTs /api/firstrun/complete and dismisses', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            initialStep: 'done',
            fetchMock,
        });
        try {
            window.WGFirstRun.mount();
            document.querySelector('[data-firstrun-action="open-app"]').click();
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, opts] = fetchMock.mock.calls[0];
            expect(url).toBe('/api/firstrun/complete');
            expect(opts.method).toBe('POST');

            expect(document.getElementById('wg-firstrun-overlay')).toBeNull();
            expect(window.WGFirstRun.isActive()).toBe(false);
            expect(window.__MEDTRACKER_BOOTSTRAP__.needs_first_run).toBe(false);
        } finally { cleanup(); }
    });

    it('second mount on a subsequent bootstrap (needs_first_run: false) does not re-render', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            initialStep: 'done',
            fetchMock,
        });
        try {
            window.WGFirstRun.mount();
            document.querySelector('[data-firstrun-action="open-app"]').click();
            await new Promise(resolve => setTimeout(resolve, 0));

            // Simulate the next bootstrap which now reports the user is
            // past first run. The orchestrator's mount() should see
            // needs_first_run: false and short-circuit.
            window.WGFirstRun.mount({ needs_first_run: false });
            expect(document.getElementById('wg-firstrun-overlay')).toBeNull();
            expect(window.WGFirstRun.isActive()).toBe(false);
        } finally { cleanup(); }
    });

    // med-1mn: the last screen is where a friend learns the app can be driven
    // by an LLM and by voice. It must never advertise a capability this
    // deployment cannot deliver.
    describe('capability blurbs', () => {
        const caps = (document) => Array.from(
            document.querySelectorAll('[data-firstrun-capability]')
        ).map((el) => el.getAttribute('data-firstrun-capability'));

        it('names MCP and voice in cloud mode when the operator has a voice key', () => {
            const { window, document, cleanup } = loadFlow({
                bootstrap: { needs_first_run: true }, initialStep: 'done', cloud: true, trialVoice: true,
            });
            try {
                window.WGFirstRun.mount();
                expect(caps(document)).toEqual(['mcp', 'voice']);

                const body = document.getElementById('wg-firstrun-overlay-body');
                expect(body.textContent).toMatch(/Two things worth knowing about/);
                // The honest limits, not just the pitch.
                expect(body.textContent).toMatch(/open and unlocked/);
                expect(body.textContent).toMatch(/rate-limited/);
                // MCP has somewhere to go; voice is in-app.
                expect(document.querySelector('.wg-firstrun-capability__link').href)
                    .toMatch(/\/connectors$/);
                // Still exactly one button — the blurbs add links, not actions.
                expect(body.querySelectorAll('button').length).toBe(1);
            } finally { cleanup(); }
        });

        it('omits voice on a cloud deployment with no ElevenLabs key', () => {
            const { window, document, cleanup } = loadFlow({
                bootstrap: { needs_first_run: true }, initialStep: 'done', cloud: true, trialVoice: false,
            });
            try {
                window.WGFirstRun.mount();
                expect(caps(document)).toEqual(['mcp']);
                const body = document.getElementById('wg-firstrun-overlay-body');
                expect(body.textContent).toMatch(/One thing worth knowing about/);
                expect(body.textContent).not.toMatch(/voice agent/i);
            } finally { cleanup(); }
        });

        it('shows neither in bot mode, where the Connectors page does not exist', () => {
            const { window, document, cleanup } = loadFlow({
                bootstrap: { needs_first_run: true }, initialStep: 'done', cloud: false, trialVoice: true,
            });
            try {
                window.WGFirstRun.mount();
                expect(caps(document)).toEqual([]);
                const body = document.getElementById('wg-firstrun-overlay-body');
                expect(body.textContent).not.toMatch(/worth knowing about/);
            } finally { cleanup(); }
        });
    });

    it('"Open app" still dismisses if the POST rejects (offline-safe)', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            initialStep: 'done',
            fetchMock,
        });
        try {
            window.WGFirstRun.mount();
            document.querySelector('[data-firstrun-action="open-app"]').click();
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(document.getElementById('wg-firstrun-overlay')).toBeNull();
        } finally { cleanup(); }
    });
});
