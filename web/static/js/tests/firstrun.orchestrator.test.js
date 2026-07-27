import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const STATE_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/state.js');
const INDEX_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/index.js');

// features/firstrun/index.js — Task 3 of the mobile Phase 2c plan.
// The orchestrator listens for the bootstrap `needs_first_run` flag and
// attaches a full-screen overlay onto <body>. Subsequent tasks (4–6)
// add the actual welcome / features / integrations / done screens
// inside the overlay panel; the orchestrator's job is the mount latch
// and the dismiss path that's reused by every screen's exit button.

const SHELL_HTML = `<!doctype html><html><body></body></html>`;

function loadFirstRun({ bootstrap = null } = {}) {
    const dom = new JSDOM(SHELL_HTML, {
        url: 'https://example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    if (bootstrap) window.__MEDTRACKER_BOOTSTRAP__ = bootstrap;

    // Load state.js first so the orchestrator's dismiss() can call into
    // the step tracker without an undefined-property surprise. Either
    // order works in production (each file defensively initialises the
    // namespace), but mirroring the index.html load order keeps the
    // test honest.
    const stateSrc = fs.readFileSync(STATE_JS, 'utf8');
    window.eval(`${stateSrc}\n//# sourceURL=file://${STATE_JS}`);
    const indexSrc = fs.readFileSync(INDEX_JS, 'utf8');
    window.eval(`${indexSrc}\n//# sourceURL=file://${INDEX_JS}`);

    return { window, document: window.document, cleanup: () => dom.window.close() };
}

describe('WGFirstRun orchestrator', () => {
    it('mounts the overlay when bootstrap.needs_first_run === true', () => {
        const { window, document, cleanup } = loadFirstRun({
            bootstrap: { needs_first_run: true },
        });
        try {
            expect(window.WGFirstRun.isActive()).toBe(false);
            window.WGFirstRun.mount();
            const overlay = document.getElementById('wg-firstrun-overlay');
            expect(overlay).not.toBeNull();
            expect(overlay.classList.contains('wg-firstrun-overlay')).toBe(true);
            expect(overlay.getAttribute('role')).toBe('dialog');
            expect(overlay.getAttribute('aria-modal')).toBe('true');
            expect(window.WGFirstRun.isActive()).toBe(true);
        } finally { cleanup(); }
    });

    it('does not mount when bootstrap.needs_first_run === false', () => {
        const { window, document, cleanup } = loadFirstRun({
            bootstrap: { needs_first_run: false },
        });
        try {
            window.WGFirstRun.mount();
            expect(document.getElementById('wg-firstrun-overlay')).toBeNull();
            expect(window.WGFirstRun.isActive()).toBe(false);
        } finally { cleanup(); }
    });

    it('does not mount when bootstrap is missing the needs_first_run field', () => {
        const { window, document, cleanup } = loadFirstRun({ bootstrap: { apiBase: 'http://example' } });
        try {
            window.WGFirstRun.mount();
            expect(document.getElementById('wg-firstrun-overlay')).toBeNull();
            expect(window.WGFirstRun.isActive()).toBe(false);
        } finally { cleanup(); }
    });

    it('mount() twice does not duplicate the overlay', () => {
        const { window, document, cleanup } = loadFirstRun({
            bootstrap: { needs_first_run: true },
        });
        try {
            window.WGFirstRun.mount();
            window.WGFirstRun.mount();
            const overlays = document.querySelectorAll('.wg-firstrun-overlay');
            expect(overlays.length).toBe(1);
        } finally { cleanup(); }
    });

    it('mount(payload) accepts an explicit payload arg (no global needed)', () => {
        const { window, document, cleanup } = loadFirstRun();
        try {
            window.WGFirstRun.mount({ needs_first_run: true });
            expect(document.getElementById('wg-firstrun-overlay')).not.toBeNull();
            expect(window.WGFirstRun.isActive()).toBe(true);
        } finally { cleanup(); }
    });

    it('dismiss() removes the overlay and clears sessionStorage state', () => {
        const { window, document, cleanup } = loadFirstRun({
            bootstrap: { needs_first_run: true },
        });
        try {
            window.WGFirstRun.mount();
            window.WGFirstRun.state.setStep('integrations');
            expect(window.sessionStorage.getItem('wg-firstrun-step')).toBe('integrations');

            window.WGFirstRun.dismiss();

            expect(document.getElementById('wg-firstrun-overlay')).toBeNull();
            expect(window.WGFirstRun.isActive()).toBe(false);
            expect(window.sessionStorage.getItem('wg-firstrun-step')).toBeNull();
        } finally { cleanup(); }
    });

    it('dismiss() is safe to call when no overlay is mounted', () => {
        const { window, cleanup } = loadFirstRun();
        try {
            expect(() => window.WGFirstRun.dismiss()).not.toThrow();
            expect(window.WGFirstRun.isActive()).toBe(false);
        } finally { cleanup(); }
    });

    it('can be re-mounted after a dismiss (e.g. dev reload, replay flow)', () => {
        const { window, document, cleanup } = loadFirstRun({
            bootstrap: { needs_first_run: true },
        });
        try {
            window.WGFirstRun.mount();
            window.WGFirstRun.dismiss();
            window.WGFirstRun.mount();
            const overlays = document.querySelectorAll('.wg-firstrun-overlay');
            expect(overlays.length).toBe(1);
            expect(window.WGFirstRun.isActive()).toBe(true);
        } finally { cleanup(); }
    });

    it('dismisses when re-mount payload flips needs_first_run to false', () => {
        // Reproduces the SW stale-cache scenario: cached /api/bootstrap
        // returned `true` and mounted the overlay; a follow-up
        // BOOTSTRAP_UPDATED with the fresh server state arrives carrying
        // `false`. Without re-evaluating the new payload the overlay
        // would outlive completion. mount() now dismisses when already
        // mounted but the new payload says no longer needed.
        const { window, document, cleanup } = loadFirstRun({
            bootstrap: { needs_first_run: true },
        });
        try {
            window.WGFirstRun.mount();
            expect(document.getElementById('wg-firstrun-overlay')).not.toBeNull();
            expect(window.WGFirstRun.isActive()).toBe(true);

            window.WGFirstRun.mount({ needs_first_run: false });
            expect(document.getElementById('wg-firstrun-overlay')).toBeNull();
            expect(window.WGFirstRun.isActive()).toBe(false);
            expect(window.sessionStorage.getItem('wg-firstrun-step')).toBeNull();
        } finally { cleanup(); }
    });
});
