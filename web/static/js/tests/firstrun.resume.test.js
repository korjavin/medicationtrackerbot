import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const STATE_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/state.js');
const FEATURES_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/screens/features.js');
const INTEGRATIONS_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/screens/integrations.js');
const INDEX_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/index.js');

// Task 7 — resume safety. The orchestrator should re-enter the flow at
// the last-persisted sessionStorage step when needs_first_run is still
// true (mid-flow reload). When the bootstrap
// reports needs_first_run=false the orchestrator must defensively clear
// any stale step entry so a ghost step doesn't surface on the next
// install. Power-cycle (sessionStorage wiped) intentionally restarts
// from the W1 picker — documented in features/firstrun/index.js's top comment.

const SHELL_HTML = `<!doctype html><html><body></body></html>`;

function loadFlow({
    bootstrap = null,
    storedStep = null,
} = {}) {
    const dom = new JSDOM(SHELL_HTML, {
        url: 'https://example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    if (bootstrap) window.__MEDTRACKER_BOOTSTRAP__ = bootstrap;
    if (storedStep) window.sessionStorage.setItem('wg-firstrun-step', storedStep);

    // Load every screen so the orchestrator can render whichever step
    // sessionStorage points at — Task 7's whole point is "no fixed
    // entry point: whichever step the user died on, render that one".
    for (const file of [
        STATE_JS,
        FEATURES_JS,
        INTEGRATIONS_JS,
        INDEX_JS,
    ]) {
        const src = fs.readFileSync(file, 'utf8');
        window.eval(`${src}\n//# sourceURL=file://${file}`);
    }

    return { window, document: window.document, cleanup: () => dom.window.close() };
}

describe('firstrun resume safety', () => {
    it('resumes at the persisted step (integrations) instead of restarting from the picker', () => {
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            storedStep: 'integrations',
        });
        try {
            window.WGFirstRun.mount();

            // Integrations screen is the one that renders — its form
            // fields exist, the picker's rows and Skip do not.
            expect(document.getElementById('wg-firstrun-openai-api-key')).not.toBeNull();
            expect(document.querySelector('[data-firstrun-action="save"]')).not.toBeNull();
            expect(document.querySelector('[data-firstrun-feature]')).toBeNull();
            expect(document.querySelector('[data-firstrun-action="skip-all"]')).toBeNull();

            // The title swaps too — the orchestrator pulls it from the
            // screen registry.
            const title = document.getElementById('wg-firstrun-title');
            expect(title.textContent.toLowerCase()).toContain('openai');
        } finally { cleanup(); }
    });

    // A session mid-flow on the pre-v3 overlay (bd med-ta2n.1 removed
    // welcome/done), or an unknown name: back to the picker, never a crash.
    for (const stored of ['an-unrecognized-step', 'welcome', 'done', null]) {
        it(`starts at the W1 picker for a stored step of ${JSON.stringify(stored)}`, () => {
            const { window, document, cleanup } = loadFlow({
                bootstrap: { needs_first_run: true },
                storedStep: stored,
            });
            try {
                window.WGFirstRun.mount();
                expect(document.querySelector('[data-firstrun-feature="medication"]')).not.toBeNull();
                expect(document.querySelector('[data-firstrun-action="skip-all"]')).not.toBeNull();
                expect(document.getElementById('wg-firstrun-openai-api-key')).toBeNull();
                expect(window.WGFirstRun.state.getStep()).toBe('features');
            } finally { cleanup(); }
        });
    }

    it('clears a stale sessionStorage step entry when needs_first_run is false (defensive cleanup)', () => {
        // A prior install's last persisted step survives a re-install on
        // the same WebView session because sessionStorage outlives the
        // bootstrap state transition. The orchestrator must wipe the
        // ghost entry so a future re-trigger (dev replay, future
        // reset-onboarding flow) doesn't resume mid-flow.
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: false },
            storedStep: 'integrations',
        });
        try {
            expect(window.sessionStorage.getItem('wg-firstrun-step')).toBe('integrations');
            window.WGFirstRun.mount();
            expect(document.getElementById('wg-firstrun-overlay')).toBeNull();
            expect(window.WGFirstRun.isActive()).toBe(false);
            expect(window.sessionStorage.getItem('wg-firstrun-step')).toBeNull();
        } finally { cleanup(); }
    });

    it('persisted step survives a simulated mid-flow process kill (re-mount after dismiss-less close)', () => {
        // Simulate the lifecycle: user advances to integrations, the
        // WebView is destroyed before dismiss() runs (process kill).
        // Next launch fires bootstrap → mount(); the orchestrator reads
        // sessionStorage and re-enters at integrations.
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
        });
        try {
            window.WGFirstRun.mount();
            // Walk forward two steps the way the screen handlers do.
            window.WGFirstRun.state.setStep('features');
            window.WGFirstRun.state.setStep('integrations');
            expect(window.sessionStorage.getItem('wg-firstrun-step')).toBe('integrations');

            // Simulate process kill: tear down the overlay element + the
            // mount latch without going through dismiss() (which would
            // clear sessionStorage): DOM is gone, JS state re-initialises
            // from the scripts, sessionStorage persists.
            const overlay = document.getElementById('wg-firstrun-overlay');
            overlay.parentNode.removeChild(overlay);
            // Re-run the module init by reloading the orchestrator
            // source — mirrors the page reload that follows a WebView
            // re-creation. The mount latch is per-module-instance, so
            // re-eval'ing index.js gives us a fresh _mounted=false.
            const indexSrc = fs.readFileSync(INDEX_JS, 'utf8');
            window.eval(`${indexSrc}\n//# sourceURL=file://${INDEX_JS}`);

            window.WGFirstRun.mount();
            expect(document.getElementById('wg-firstrun-openai-api-key')).not.toBeNull();
            expect(window.sessionStorage.getItem('wg-firstrun-step')).toBe('integrations');
        } finally { cleanup(); }
    });
});
