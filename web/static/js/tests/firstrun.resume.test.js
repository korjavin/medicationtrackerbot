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
const FEATURES_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/screens/features.js');
const INTEGRATIONS_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/screens/integrations.js');
const DONE_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/screens/done.js');
const INDEX_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/index.js');

// Task 7 — resume safety. The orchestrator should re-enter the flow at
// the last-persisted sessionStorage step when needs_first_run is still
// true (mid-flow reload). When the bootstrap
// reports needs_first_run=false the orchestrator must defensively clear
// any stale step entry so a ghost step doesn't surface on the next
// install. Power-cycle (sessionStorage wiped) intentionally restarts
// from welcome — documented in features/firstrun/index.js's top comment.

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
        WELCOME_JS,
        FEATURES_JS,
        INTEGRATIONS_JS,
        DONE_JS,
        INDEX_JS,
    ]) {
        const src = fs.readFileSync(file, 'utf8');
        window.eval(`${src}\n//# sourceURL=file://${file}`);
    }

    return { window, document: window.document, cleanup: () => dom.window.close() };
}

describe('firstrun resume safety', () => {
    it('resumes at the persisted step (integrations) instead of restarting from welcome', () => {
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            storedStep: 'integrations',
        });
        try {
            window.WGFirstRun.mount();

            // Integrations screen is the one that renders — its form
            // fields exist, welcome's tagline + "Get started" button do
            // not.
            expect(document.getElementById('wg-firstrun-openai-api-key')).not.toBeNull();
            expect(document.querySelector('[data-firstrun-action="save"]')).not.toBeNull();
            expect(document.querySelector('[data-firstrun-action="advance"]')).toBeNull();
            expect(document.querySelector('[data-firstrun-action="skip-all"]')).toBeNull();

            // The title swaps too — the orchestrator pulls it from the
            // screen registry, not from the welcome screen's title.
            const title = document.getElementById('wg-firstrun-title');
            expect(title.textContent.toLowerCase()).toContain('openai');
        } finally { cleanup(); }
    });

    it('resumes at the persisted step (features)', () => {
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            storedStep: 'features',
        });
        try {
            window.WGFirstRun.mount();

            // The feature picker renders its rows; no welcome CTA and no
            // integrations form fields.
            expect(document.querySelector('[data-firstrun-feature]')).not.toBeNull();
            expect(document.querySelector('[data-firstrun-action="advance"]')).toBeNull();
            expect(document.getElementById('wg-firstrun-openai-api-key')).toBeNull();
        } finally { cleanup(); }
    });

    it('resumes at the persisted step (done)', async () => {
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            storedStep: 'done',
        });
        try {
            window.WGFirstRun.mount();

            // Done screen renders directly: "Open app" button is present;
            // none of the prior screens are.
            expect(document.querySelector('[data-firstrun-action="open-app"]')).not.toBeNull();
            expect(document.querySelector('[data-firstrun-action="advance"]')).toBeNull();
            expect(document.querySelector('[data-firstrun-action="save"]')).toBeNull();
        } finally { cleanup(); }
    });

    it('falls back to welcome when sessionStorage holds an unknown step name', () => {
        // Defensive: a future schema change might rename a step. state.js's
        // VALID_STEPS guard maps unknown values back to "welcome" so we
        // never crash trying to look up a missing screen.
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            storedStep: 'an-unrecognized-step',
        });
        try {
            window.WGFirstRun.mount();
            expect(document.querySelector('[data-firstrun-action="advance"]')).not.toBeNull();
            expect(document.querySelector('[data-firstrun-action="skip-all"]')).not.toBeNull();
        } finally { cleanup(); }
    });

    it('starts at welcome when sessionStorage was wiped (power-cycle simulation)', () => {
        // Power-cycle wipes sessionStorage. The bootstrap is still true
        // because the server-side flag hasn't been POSTed yet. The flow
        // restarts at welcome — intentional per the top-of-file comment.
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            storedStep: null,
        });
        try {
            window.WGFirstRun.mount();
            expect(document.querySelector('[data-firstrun-action="advance"]')).not.toBeNull();
            expect(window.WGFirstRun.state.getStep()).toBe('welcome');
        } finally { cleanup(); }
    });

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
