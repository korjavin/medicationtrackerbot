import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const BACKEND_LOGS_JS = path.join(REPO_ROOT, 'web/static/js/features/backend-logs.js');

// Phase 2a, Task 5. Settings → About → "Backend logs" debug screen surfaces
// the embedded Go binary's last 200 stdout+stderr lines through the
// Capacitor shell's NativeBridge addJavascriptInterface. In the browser PWA
// + server-mode build the row stays hidden — these tests pin both branches.

const SHELL_HTML = `<!doctype html><html><body>
    <section id="settings-about" class="wg-card wg-settings-section wg-settings-about wg-settings-hidden">
        <div id="backend-logs-row" class="wg-settings-row hidden">
            <button id="backend-logs-open-btn" type="button">View logs</button>
        </div>
    </section>
    <div id="backend-logs-modal" class="hidden">
        <button id="backend-logs-close-btn" type="button">Close</button>
        <pre id="backend-logs-output"></pre>
    </div>
</body></html>`;

function loadBackendLogs({ native = null } = {}) {
    const dom = new JSDOM(SHELL_HTML, {
        url: 'http://127.0.0.1:54321/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    if (native) window.MedtrackerNative = native;
    const source = fs.readFileSync(BACKEND_LOGS_JS, 'utf8');
    window.eval(`${source}\n//# sourceURL=file://${BACKEND_LOGS_JS}`);
    // JSDOM with runScripts:'outside-only' keeps document.readyState at
    // 'loading' until a load event is dispatched, so the IIFE registers a
    // DOMContentLoaded listener instead of mounting synchronously. Fire the
    // event manually to mimic browser timing before any assertion runs.
    if (window.document.readyState !== 'complete') {
        window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
    }
    return { window, document: window.document, cleanup: () => dom.window.close() };
}

describe('BackendLogs — Capacitor shell only', () => {
    it('keeps the row hidden when MedtrackerNative is absent (browser/server mode)', () => {
        const { document, window, cleanup } = loadBackendLogs();
        try {
            const row = document.getElementById('backend-logs-row');
            expect(row.classList.contains('hidden')).toBe(true);
            expect(window.BackendLogs.hasNativeBridge()).toBe(false);
        } finally { cleanup(); }
    });

    it('reveals the row when MedtrackerNative.getBackendLogs is present', () => {
        const { document, window, cleanup } = loadBackendLogs({
            native: { getBackendLogs: () => '  line A\nE line B' },
        });
        try {
            const row = document.getElementById('backend-logs-row');
            expect(row.classList.contains('hidden')).toBe(false);
            expect(window.BackendLogs.hasNativeBridge()).toBe(true);
        } finally { cleanup(); }
    });

    it('opens the modal with the latest logs on button click', () => {
        const lines = '  LISTENING 127.0.0.1:54321\n  ok\nE warn message';
        const { document, window, cleanup } = loadBackendLogs({
            native: { getBackendLogs: () => lines },
        });
        try {
            const openBtn = document.getElementById('backend-logs-open-btn');
            const modal = document.getElementById('backend-logs-modal');
            const out = document.getElementById('backend-logs-output');

            expect(modal.classList.contains('hidden')).toBe(true);
            openBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
            expect(modal.classList.contains('hidden')).toBe(false);
            expect(out.textContent).toBe(lines);
        } finally { cleanup(); }
    });

    it('renders a placeholder when the native bridge returns no lines', () => {
        const { document, window, cleanup } = loadBackendLogs({
            native: { getBackendLogs: () => '' },
        });
        try {
            const openBtn = document.getElementById('backend-logs-open-btn');
            const out = document.getElementById('backend-logs-output');
            openBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
            expect(out.textContent).toContain('no log lines captured yet');
        } finally { cleanup(); }
    });

    it('closes the modal via the close button', () => {
        const { document, window, cleanup } = loadBackendLogs({
            native: { getBackendLogs: () => 'something' },
        });
        try {
            const openBtn = document.getElementById('backend-logs-open-btn');
            const closeBtn = document.getElementById('backend-logs-close-btn');
            const modal = document.getElementById('backend-logs-modal');
            openBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
            expect(modal.classList.contains('hidden')).toBe(false);
            closeBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
            expect(modal.classList.contains('hidden')).toBe(true);
        } finally { cleanup(); }
    });

    it('swallows native bridge errors and renders the placeholder', () => {
        const { document, window, cleanup } = loadBackendLogs({
            native: {
                getBackendLogs: () => { throw new Error('native crashed'); },
            },
        });
        try {
            const openBtn = document.getElementById('backend-logs-open-btn');
            const out = document.getElementById('backend-logs-output');
            openBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
            expect(out.textContent).toContain('no log lines captured yet');
        } finally { cleanup(); }
    });
});

// med-g3k. The backend-logs row is the About section's only content, so
// outside the Capacitor shell the section rendered its heading and the words
// "Diagnostics for the embedded server" over nothing at all.
describe('Settings → About section visibility', () => {
    it('stays hidden without the native bridge', () => {
        const { document, cleanup } = loadBackendLogs();
        try {
            expect(document.getElementById('settings-about').classList.contains('wg-settings-hidden')).toBe(true);
        } finally { cleanup(); }
    });

    it('is revealed in the Capacitor shell, alongside the logs row', () => {
        const { document, cleanup } = loadBackendLogs({
            native: { getBackendLogs: () => 'line one' },
        });
        try {
            expect(document.getElementById('settings-about').classList.contains('wg-settings-hidden')).toBe(false);
            expect(document.getElementById('backend-logs-row').classList.contains('hidden')).toBe(false);
        } finally { cleanup(); }
    });
});
