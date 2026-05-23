import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockResponse, loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

const AUTH_CACHE_KEY = 'medtracker_auth_state';

// Embedded-shell short-circuit (Capacitor APK / mobile build).
// native-bootstrap.js sets window.__MEDTRACKER_BOOTSTRAP__.apiBase before
// app.js evaluates. On the mobile build the Go binary uses LocalUserResolver
// (no cookie, no Telegram), so checkAuth() must skip the /auth/status probe
// and the login-screen render entirely.
describe('app.js checkAuth — embedded-shell bypass', () => {
    beforeEach(() => {
        allowConsoleNoise();
    });

    it('bypasses /auth/status and mounts WGFirstRun on a fresh mobile install', async () => {
        const { window, cleanup } = loadFrontendEnv();
        try {
            // Set the embedded-shell signal BEFORE checkAuth() runs.
            window.__MEDTRACKER_BOOTSTRAP__ = { apiBase: 'http://127.0.0.1:34567' };

            const firstRunMount = vi.fn();
            window.WGFirstRun = { mount: firstRunMount };

            window.fetch = vi.fn().mockResolvedValueOnce(createMockResponse({
                status: 200,
                json: { cursor: 0, features: {}, needs_first_run: true }
            }));

            const authorized = await window.checkAuth();

            expect(authorized).toBe(true);

            // Only one network call — /api/bootstrap (resolved against
            // apiBase when the embedded-shell signal is set). No /auth/status
            // probe and no /auth/* call of any kind.
            const calls = window.fetch.mock.calls;
            expect(calls.length).toBe(1);
            expect(calls[0][0]).toMatch(/\/api\/bootstrap\?(tz=|tz_offset=)/);
            for (const call of calls) {
                expect(call[0]).not.toMatch(/\/auth\//);
            }

            // Login container must NOT be rendered.
            expect(window.document.getElementById('telegram-login-container')).toBeNull();

            // Firstrun overlay was mounted via applyBootstrapPayload.
            expect(firstRunMount).toHaveBeenCalledWith({ needs_first_run: true });

            // Auth state cached as 'local'.
            const cachedAuth = JSON.parse(window.localStorage.getItem(AUTH_CACHE_KEY));
            expect(cachedAuth.authenticated).toBe(true);
            expect(cachedAuth.authMethod).toBe('local');
        } finally {
            cleanup();
        }
    });

    it('bypasses login screen and lands on Today when firstrun is already complete', async () => {
        const { window, cleanup } = loadFrontendEnv();
        try {
            window.__MEDTRACKER_BOOTSTRAP__ = { apiBase: 'http://127.0.0.1:34567' };

            const firstRunMount = vi.fn();
            window.WGFirstRun = { mount: firstRunMount };

            window.fetch = vi.fn().mockResolvedValueOnce(createMockResponse({
                status: 200,
                json: { cursor: 7, features: { bp: true }, needs_first_run: false }
            }));

            const authorized = await window.checkAuth();

            expect(authorized).toBe(true);

            // Login container must NOT be rendered.
            expect(window.document.getElementById('telegram-login-container')).toBeNull();

            // applyBootstrapPayload calls mount({ needs_first_run: false }) so
            // any already-mounted stale overlay can dismiss; the no-op branch
            // inside mount() handles the "not mounted, false flag" case.
            expect(firstRunMount).toHaveBeenCalledWith({ needs_first_run: false });

            // Auth state cached as 'local'.
            const cachedAuth = JSON.parse(window.localStorage.getItem(AUTH_CACHE_KEY));
            expect(cachedAuth.authMethod).toBe('local');
        } finally {
            cleanup();
        }
    });

    it('leaves the existing web/PWA path unchanged when no embedded-shell signal is set', async () => {
        const { window, cleanup } = loadFrontendEnv();
        try {
            // Explicitly clear the embedded-shell signal — the harness may not
            // set it but we want to be defensive.
            delete window.__MEDTRACKER_BOOTSTRAP__;

            window.fetch = vi.fn()
                .mockResolvedValueOnce(createMockResponse({
                    status: 200,
                    json: { authenticated: true, method: 'cookie' }
                }))
                .mockResolvedValueOnce(createMockResponse({
                    status: 200,
                    json: { cursor: 5, features: { bp: true } }
                }));

            const authorized = await window.checkAuth();

            expect(authorized).toBe(true);

            // First call is the /auth/status probe — proves we did NOT take
            // the embedded-shell short-circuit.
            expect(window.fetch).toHaveBeenNthCalledWith(1, '/auth/status', {
                method: 'GET',
                credentials: 'same-origin'
            });

            // Bootstrap path stamps auth method as 'cookie', NOT 'local'.
            const cachedAuth = JSON.parse(window.localStorage.getItem(AUTH_CACHE_KEY));
            expect(cachedAuth.authMethod).toBe('cookie');
        } finally {
            cleanup();
        }
    });
});
