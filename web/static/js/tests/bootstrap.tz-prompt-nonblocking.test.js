/**
 * Bootstrap fires the TZ-mismatch prompt FIRE-AND-FORGET, after the
 * canonical bottom nav has mounted and the initial tab has switched in.
 *
 * Regression: when the user opens the web app in a regular browser (not the
 * Telegram WebApp) and the detected browser timezone differs from the cached
 * `settings_bundle.timezone`, `maybeUpdateTimezone()` used to `await
 * safeConfirm(...)` BEFORE `mountCanonicalBottomNav()` and `switchTab()`.
 * In non-Telegram contexts `safeConfirm` falls through to the synchronous
 * native `confirm()` which blocks the main thread before any paint — the
 * user sees a white page until Esc dismisses the (invisible) modal.
 *
 * This file pins the fix: even when the prompt never resolves, the bottom
 * nav mounts and the initial tab is switched in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv, createMockResponse } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';
import { idle, signal } from './helpers/settle.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const BOOTSTRAP_JS = path.join(REPO_ROOT, 'web/static/js/features/bootstrap.js');

// med-tc1.10 — the fake store doubles as the progress barrier. maybeUpdateTimezone
// touches this cache at exactly two points: one `get` (the settings bundle whose
// timezone it compares against) and, on the dismiss path, one `set` (the offline
// mirror of the dismissal). Firing a signal from inside each is the #716 pattern —
// the point of interest reports itself instead of a sleep guessing at it.
//   `read`    — maybeUpdateTimezone has loaded the bundle and is now deciding.
//   `written` — the dismiss mirror has landed; `map` is safe to assert on.
// Both are keyed on 'settings_bundle' so an unrelated cache touch from another
// bootstrap path can never settle a barrier early and weaken an assertion.
function installApiCacheMap(window, initialCache = {}) {
    const map = new Map();
    for (const [key, value] of Object.entries(initialCache)) {
        map.set(key, { id: key, timestamp: Date.now(), data: value });
    }
    const read = signal();
    const written = signal();
    window.MedTrackerDB = window.MedTrackerDB || {};
    window.MedTrackerDB.ApiCache = {
        async get(key) {
            const entry = map.get(key);
            if (key === 'settings_bundle') read.fire();
            return entry ? entry.data : null;
        },
        async getWithMeta(key) {
            const entry = map.get(key);
            return entry ? { data: entry.data, timestamp: entry.timestamp } : null;
        },
        async set(key, data) {
            map.set(key, { id: key, timestamp: Date.now(), data });
            if (key === 'settings_bundle') written.fire();
        },
        async setWithMeta(key, data, timestamp) {
            map.set(key, { id: key, timestamp, data });
            if (key === 'settings_bundle') written.fire();
        },
        async clear(key) {
            if (key) map.delete(key);
            else map.clear();
        }
    };
    return { map, read, written };
}

function forceDetectedTimezone(window, detectedTz) {
    const originalDTF = window.Intl.DateTimeFormat;
    window.Intl.DateTimeFormat = function DateTimeFormat(...args) {
        const inst = new originalDTF(...args);
        const orig = inst.resolvedOptions.bind(inst);
        inst.resolvedOptions = () => ({ ...orig(), timeZone: detectedTz });
        return inst;
    };
}

function stubBootstrapFetch(window) {
    vi.spyOn(window, 'fetch').mockImplementation(async (url) => {
        if (url === '/api/bootstrap') return createMockResponse({ json: {} });
        if (url === '/auth/status') return createMockResponse({ json: { authenticated: true } });
        return createMockResponse({ json: {} });
    });
}

function stubBootstrapGlobals(window) {
    window.switchTab = vi.fn();
    window.checkAuth = vi.fn().mockResolvedValue(true);
    window.initOIDCSetupBanner = vi.fn();
    window.handleDeepLinks = vi.fn();
}

// med-tc1.10 — replaces a 200ms/5ms poll loop for the confirm modal.
// utils.js `safeConfirm` mounts the in-page modal SYNCHRONOUSLY inside its
// Promise executor (_mountConfirmModal appends to document.body before
// safeConfirm returns), so wrapping the global and firing after the call-through
// makes "the modal is in the DOM" a fact rather than a deadline to poll against.
function watchConfirmModal(window) {
    const shown = signal();
    const original = window.safeConfirm;
    window.safeConfirm = (...args) => {
        const result = original(...args);
        shown.fire();
        return result;
    };
    return shown;
}

describe('bootstrap.js TZ prompt is non-blocking', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renders the initial tab before the TZ prompt resolves', async () => {
        allowConsoleNoise();
        const { window } = env;

        // Seed the cached settings bundle with a timezone different from
        // whatever Intl resolves on the host so maybeUpdateTimezone will
        // prompt. To stay deterministic across CI environments we force
        // Intl.DateTimeFormat().resolvedOptions().timeZone to a known value.
        const detectedTz = 'America/Chicago';
        forceDetectedTimezone(window, detectedTz);

        installApiCacheMap(window, {
            settings_bundle: { timezone: 'Europe/Berlin' }
        });

        // Stub safeConfirm to return a never-resolving Promise; if bootstrap
        // still awaits it on the critical path, switchTab will never be
        // reached and the assertion below will fail.
        let promptCalled = 0;
        const prompted = signal();
        window.safeConfirm = () => {
            promptCalled += 1;
            prompted.fire();
            return new Promise(() => { /* never resolves */ });
        };

        stubBootstrapFetch(window);

        const switchTabSpy = vi.fn();
        window.switchTab = switchTabSpy;
        window.checkAuth = vi.fn().mockResolvedValue(true);
        window.initOIDCSetupBanner = vi.fn();
        window.handleDeepLinks = vi.fn();

        const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
        window.eval(bootstrapSource);

        // med-tc1.10 — the prompt itself is the settle point, and it is exactly
        // the ordering under test: this resolves the instant bootstrap reaches
        // safeConfirm, so a switchTab that has not happened BY THEN is the
        // regression (an awaited prompt on the critical path). The old 50ms
        // sleep only hoped the whole checkAuth → mount → switchTab →
        // queueMicrotask → getCached chain fit inside a wall-clock window.
        await prompted.wait;

        expect(switchTabSpy).toHaveBeenCalledWith('today');
        // The prompt was scheduled — confirms we genuinely hit the await
        // path and bootstrap did not short-circuit before the TZ check.
        expect(promptCalled).toBe(1);
    });

    it('maybeUpdateTimezone: accept POSTs /api/settings and invalidates cache', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        const detectedTz = 'America/Chicago';
        forceDetectedTimezone(window, detectedTz);
        installApiCacheMap(window, {
            settings_bundle: { timezone: 'Europe/Berlin' }
        });

        const apiCallSpy = vi.fn().mockResolvedValue({ status: 'ok' });
        window.apiCall = apiCallSpy;
        // The invalidation is the LAST statement of the accept path, so firing
        // from inside its mock settles the whole `apiCall → invalidateKey` tail.
        const invalidated = signal();
        const invalidateSpy = vi.fn(async () => { invalidated.fire(); });
        window.DataStore.invalidateKey = invalidateSpy;

        stubBootstrapFetch(window);
        stubBootstrapGlobals(window);
        const modalShown = watchConfirmModal(window);

        const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
        window.eval(bootstrapSource);

        await modalShown.wait;
        const modal = document.querySelector('mt-modal.mt-confirm-modal');
        expect(modal).not.toBeNull();
        const message = modal.querySelector('.mt-confirm-modal__message');
        expect(message.textContent).toContain(detectedTz);
        expect(message.textContent).toContain('Europe/Berlin');

        modal.querySelector('.mt-confirm-modal__confirm').click();

        await invalidated.wait;

        expect(apiCallSpy).toHaveBeenCalledWith('/api/settings', 'POST', { timezone: detectedTz });
        expect(invalidateSpy).toHaveBeenCalledWith('settings_bundle');
        // Accept path must NOT call the dismiss endpoint — the server-side
        // RecordTimezone clears the dismissed flag for us.
        const dismissCalls = apiCallSpy.mock.calls.filter(args => args[0] === '/api/tz-suggestion/dismiss');
        expect(dismissCalls).toHaveLength(0);
    });

    it('maybeUpdateTimezone: cancel POSTs /api/tz-suggestion/dismiss with detected_tz', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        const detectedTz = 'America/Chicago';
        forceDetectedTimezone(window, detectedTz);
        // The cache mirror is the LAST statement of the dismiss path (it runs
        // after the dismiss POST), so `written` settles the whole tail.
        const { written } = installApiCacheMap(window, {
            settings_bundle: { timezone: 'Europe/Berlin' }
        });

        const apiCallSpy = vi.fn().mockResolvedValue({ status: 'ok' });
        window.apiCall = apiCallSpy;
        const invalidateSpy = vi.fn().mockResolvedValue(undefined);
        window.DataStore.invalidateKey = invalidateSpy;

        stubBootstrapFetch(window);
        stubBootstrapGlobals(window);
        const modalShown = watchConfirmModal(window);

        const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
        window.eval(bootstrapSource);

        await modalShown.wait;
        const modal = document.querySelector('mt-modal.mt-confirm-modal');
        expect(modal).not.toBeNull();

        modal.querySelector('.mt-confirm-modal__cancel').click();

        await written.wait;

        expect(apiCallSpy).toHaveBeenCalledWith(
            '/api/tz-suggestion/dismiss',
            'POST',
            { detected_tz: detectedTz },
        );
        // Cancel must NOT trigger an /api/settings POST nor a cache invalidation.
        const settingsCalls = apiCallSpy.mock.calls.filter(args => args[0] === '/api/settings');
        expect(settingsCalls).toHaveLength(0);
        expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it('maybeUpdateTimezone: cancel mirrors dismissal into cached settings_bundle (offline-safe)', async () => {
        // When the user dismisses while the dismiss POST is silently dropped
        // (offline / 5xx → apiCall returns null without throwing), the same
        // browser must still skip the prompt on reload. Mirror the dismissal
        // into the cached settings_bundle so the next maybeUpdateTimezone call
        // sees it locally even if the server never recorded it.
        allowConsoleNoise();
        const { window, document } = env;

        const detectedTz = 'America/Chicago';
        forceDetectedTimezone(window, detectedTz);
        const { map: cacheMap, written } = installApiCacheMap(window, {
            settings_bundle: { timezone: 'Europe/Berlin' }
        });

        // Simulate offline: dismiss endpoint returns null (no throw).
        const apiCallSpy = vi.fn().mockResolvedValue(null);
        window.apiCall = apiCallSpy;
        window.DataStore.invalidateKey = vi.fn().mockResolvedValue(undefined);

        stubBootstrapFetch(window);
        stubBootstrapGlobals(window);
        const modalShown = watchConfirmModal(window);

        const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
        window.eval(bootstrapSource);

        await modalShown.wait;
        const modal = document.querySelector('mt-modal.mt-confirm-modal');
        expect(modal).not.toBeNull();
        modal.querySelector('.mt-confirm-modal__cancel').click();

        // `written` fires from inside ApiCache.set AFTER the map has been
        // updated, so the entry below is guaranteed to be the mirrored one.
        await written.wait;

        const cached = cacheMap.get('settings_bundle');
        expect(cached?.data?.dismissedTzSuggestion).toBe(detectedTz);
        expect(cached?.data?.timezone).toBe('Europe/Berlin');
    });

    it('maybeUpdateTimezone: skip when detectedTz equals stored timezone', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        const detectedTz = 'America/Chicago';
        forceDetectedTimezone(window, detectedTz);
        const { read } = installApiCacheMap(window, {
            settings_bundle: { timezone: detectedTz }
        });

        const apiCallSpy = vi.fn().mockResolvedValue({ status: 'ok' });
        window.apiCall = apiCallSpy;

        stubBootstrapFetch(window);
        stubBootstrapGlobals(window);

        const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
        window.eval(bootstrapSource);

        // A negative assertion needs a unit of WORK, not a deadline. Two
        // barriers: `read` proves maybeUpdateTimezone actually ran and loaded
        // the bundle (so the case is not passing because nothing happened at
        // all), and `idle()` then gives the skip decision every chance to turn
        // into a prompt — each round drains the entire microtask queue, and
        // safeConfirm mounts its modal synchronously once reached.
        await read.wait;
        await idle();

        expect(document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
        expect(apiCallSpy).not.toHaveBeenCalledWith('/api/settings', expect.anything(), expect.anything());
    });

    it('maybeUpdateTimezone: skip when settings_bundle.dismissed_tz_suggestion matches detectedTz', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        const detectedTz = 'America/Chicago';
        forceDetectedTimezone(window, detectedTz);
        const { read } = installApiCacheMap(window, {
            settings_bundle: {
                timezone: 'Europe/Berlin',
                dismissedTzSuggestion: detectedTz,
            }
        });

        const apiCallSpy = vi.fn().mockResolvedValue({ status: 'ok' });
        window.apiCall = apiCallSpy;

        stubBootstrapFetch(window);
        stubBootstrapGlobals(window);

        const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
        window.eval(bootstrapSource);

        await read.wait;
        await idle();

        expect(document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
        // Neither endpoint should be touched when we silently skip.
        expect(apiCallSpy).not.toHaveBeenCalledWith('/api/settings', expect.anything(), expect.anything());
        expect(apiCallSpy).not.toHaveBeenCalledWith('/api/tz-suggestion/dismiss', expect.anything(), expect.anything());
    });
});
