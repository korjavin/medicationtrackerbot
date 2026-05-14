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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const BOOTSTRAP_JS = path.join(REPO_ROOT, 'web/static/js/features/bootstrap.js');

function installApiCacheMap(window, initialCache = {}) {
    const map = new Map();
    for (const [key, value] of Object.entries(initialCache)) {
        map.set(key, { id: key, timestamp: Date.now(), data: value });
    }
    window.MedTrackerDB = window.MedTrackerDB || {};
    window.MedTrackerDB.ApiCache = {
        async get(key) {
            const entry = map.get(key);
            return entry ? entry.data : null;
        },
        async getWithMeta(key) {
            const entry = map.get(key);
            return entry ? { data: entry.data, timestamp: entry.timestamp } : null;
        },
        async set(key, data) {
            map.set(key, { id: key, timestamp: Date.now(), data });
        },
        async setWithMeta(key, data, timestamp) {
            map.set(key, { id: key, timestamp, data });
        },
        async clear(key) {
            if (key) map.delete(key);
            else map.clear();
        }
    };
    return map;
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

async function waitForModal(document, { timeoutMs = 200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const modal = document.querySelector('mt-modal.mt-confirm-modal');
        if (modal) return modal;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    return null;
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
        window.safeConfirm = () => {
            promptCalled += 1;
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

        // Yield enough turns for: checkAuth().then → mount → switchTab →
        // queueMicrotask(maybeUpdateTimezone) → await DataStore.getCached
        // → safeConfirm (now pending forever).
        await new Promise(resolve => setTimeout(resolve, 50));

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

        // Pre-seed a stale dismissal cookie — accept path should clear it.
        window.localStorage.setItem('tz_prompt_dismissed', 'Asia/Tokyo');

        const apiCallSpy = vi.fn().mockResolvedValue({ status: 'ok' });
        window.apiCall = apiCallSpy;
        const invalidateSpy = vi.fn().mockResolvedValue(undefined);
        window.DataStore.invalidateKey = invalidateSpy;

        stubBootstrapFetch(window);
        stubBootstrapGlobals(window);

        const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
        window.eval(bootstrapSource);

        const modal = await waitForModal(document);
        expect(modal).not.toBeNull();
        const message = modal.querySelector('.mt-confirm-modal__message');
        expect(message.textContent).toContain(detectedTz);
        expect(message.textContent).toContain('Europe/Berlin');

        modal.querySelector('.mt-confirm-modal__confirm').click();

        // Yield for: safeConfirm resolve → await apiCall → await invalidateKey → localStorage.removeItem
        await new Promise(resolve => setTimeout(resolve, 30));

        expect(apiCallSpy).toHaveBeenCalledWith('/api/settings', 'POST', { timezone: detectedTz });
        expect(invalidateSpy).toHaveBeenCalledWith('settings_bundle');
        expect(window.localStorage.getItem('tz_prompt_dismissed')).toBeNull();
    });

    it('maybeUpdateTimezone: cancel writes tz_prompt_dismissed', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        const detectedTz = 'America/Chicago';
        forceDetectedTimezone(window, detectedTz);
        installApiCacheMap(window, {
            settings_bundle: { timezone: 'Europe/Berlin' }
        });

        const apiCallSpy = vi.fn().mockResolvedValue({ status: 'ok' });
        window.apiCall = apiCallSpy;
        const invalidateSpy = vi.fn().mockResolvedValue(undefined);
        window.DataStore.invalidateKey = invalidateSpy;

        stubBootstrapFetch(window);
        stubBootstrapGlobals(window);

        const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
        window.eval(bootstrapSource);

        const modal = await waitForModal(document);
        expect(modal).not.toBeNull();

        modal.querySelector('.mt-confirm-modal__cancel').click();

        await new Promise(resolve => setTimeout(resolve, 30));

        expect(window.localStorage.getItem('tz_prompt_dismissed')).toBe(detectedTz);
        // Cancel must NOT trigger an /api/settings POST nor a cache invalidation.
        const settingsCalls = apiCallSpy.mock.calls.filter(args => args[0] === '/api/settings');
        expect(settingsCalls).toHaveLength(0);
        expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it('maybeUpdateTimezone: skip when detectedTz equals stored timezone', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        const detectedTz = 'America/Chicago';
        forceDetectedTimezone(window, detectedTz);
        installApiCacheMap(window, {
            settings_bundle: { timezone: detectedTz }
        });

        const apiCallSpy = vi.fn().mockResolvedValue({ status: 'ok' });
        window.apiCall = apiCallSpy;

        stubBootstrapFetch(window);
        stubBootstrapGlobals(window);

        const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
        window.eval(bootstrapSource);

        // Give the queueMicrotask path a chance to run; modal must NOT appear.
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
        expect(apiCallSpy).not.toHaveBeenCalledWith('/api/settings', expect.anything(), expect.anything());
    });

    it('maybeUpdateTimezone: skip when tz_prompt_dismissed matches detectedTz', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        const detectedTz = 'America/Chicago';
        forceDetectedTimezone(window, detectedTz);
        installApiCacheMap(window, {
            settings_bundle: { timezone: 'Europe/Berlin' }
        });
        window.localStorage.setItem('tz_prompt_dismissed', detectedTz);

        const apiCallSpy = vi.fn().mockResolvedValue({ status: 'ok' });
        window.apiCall = apiCallSpy;

        stubBootstrapFetch(window);
        stubBootstrapGlobals(window);

        const bootstrapSource = fs.readFileSync(BOOTSTRAP_JS, 'utf8');
        window.eval(bootstrapSource);

        await new Promise(resolve => setTimeout(resolve, 50));

        expect(document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
        // Suppression cookie remains untouched.
        expect(window.localStorage.getItem('tz_prompt_dismissed')).toBe(detectedTz);
    });
});
