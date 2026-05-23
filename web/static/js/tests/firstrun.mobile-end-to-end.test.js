import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockResponse, loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const STATE_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/state.js');
const WELCOME_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/screens/welcome.js');
const DONE_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/screens/done.js');
const INDEX_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/index.js');

// End-to-end test for the mobile launch path (Task 5 of the
// skip-Telegram-login plan, 2026-05-23).
//
// The chain under test: checkAuth() observes window.__MEDTRACKER_BOOTSTRAP__
// .apiBase (set by core/native-bootstrap.js inside the embedded shell),
// short-circuits the /auth/status + login fallback, fetches /api/bootstrap,
// and routes the payload through applyBootstrapPayload → WGFirstRun.mount.
// On a fresh install the server returns needs_first_run: true, so the
// welcome screen must paint inside the firstrun overlay.
//
// loadFrontendEnv() does NOT load the firstrun screen modules (it loads
// app.js + auth-bootstrap.js), so this test layers state.js + the welcome
// screen + the orchestrator on top to materialise the rendered DOM.

function loadFirstRunModules(window) {
    for (const file of [STATE_JS, WELCOME_JS, DONE_JS, INDEX_JS]) {
        const src = fs.readFileSync(file, 'utf8');
        window.eval(`${src}\n//# sourceURL=file://${file}`);
    }
}

describe('checkAuth → /api/bootstrap → firstrun welcome screen (mobile end-to-end)', () => {
    beforeEach(() => {
        allowConsoleNoise();
    });

    it('paints the welcome screen on a fresh embedded-shell launch (needs_first_run=true)', async () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            // Embedded-shell signal: set BEFORE checkAuth() runs. native-bootstrap.js
            // populates this before app.js evaluates in production; here we set it
            // post-load because the harness doesn't run native-bootstrap.js.
            window.__MEDTRACKER_BOOTSTRAP__ = { apiBase: 'http://127.0.0.1:34567' };

            // Layer the firstrun modules on top of the harness so WGFirstRun.mount
            // actually renders into the document instead of being mocked.
            loadFirstRunModules(window);

            // Single mocked /api/bootstrap response — needs_first_run: true is the
            // contract from Task 2 (lazy-insert of the settings row on fresh DB).
            window.fetch = vi.fn().mockResolvedValueOnce(createMockResponse({
                status: 200,
                json: { cursor: 0, features: {}, needs_first_run: true }
            }));

            const authorized = await window.checkAuth();
            expect(authorized).toBe(true);

            // The firstrun overlay scaffold is in the DOM, the welcome title is
            // shown, and both action buttons are present. This is the same shape
            // firstrun.welcome.test.js asserts — the difference here is that the
            // path arrives via checkAuth() rather than a direct mount() call.
            const overlay = document.getElementById('wg-firstrun-overlay');
            expect(overlay).not.toBeNull();

            const title = document.getElementById('wg-firstrun-title');
            expect(title.textContent).toMatch(/welcome/i);

            const body = document.getElementById('wg-firstrun-overlay-body');
            expect(body.querySelector('[data-firstrun-action="advance"]')).not.toBeNull();
            expect(body.querySelector('[data-firstrun-action="skip-all"]')).not.toBeNull();

            // The login container must NOT be rendered — the embedded-shell branch
            // returns before the login fallback in checkAuth(). This mirrors the
            // assertion in app.embedded-shell-bypass.test.js but pairs it with the
            // welcome-screen render so the end-to-end invariant is captured here.
            expect(document.getElementById('telegram-login-container')).toBeNull();

            // The orchestrator marks itself active once the overlay mounts.
            expect(window.WGFirstRun.isActive()).toBe(true);
            expect(window.WGFirstRun.state.getStep()).toBe('welcome');
        } finally {
            cleanup();
        }
    });
});
