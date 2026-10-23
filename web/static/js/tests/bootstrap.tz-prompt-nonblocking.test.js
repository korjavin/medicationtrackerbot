/**
 * Bootstrap's TZ-mismatch prompt.
 *
 * 1. It fires FIRE-AND-FORGET after the bottom nav has mounted and the initial
 *    tab has switched in. Regression: maybeUpdateTimezone() used to `await
 *    safeConfirm(...)` BEFORE switchTab(); in a plain browser that blocked
 *    first paint (white page until Esc).
 * 2. Whether to ask is the domain's decision (bd med-gjsp): bootstrap calls
 *    GET /api/tz-suggestion/should-prompt → tzplan.shouldPromptSuggestion and
 *    prompts iff it says so. A pending/approved transition plan that already
 *    targets the detected zone, or a synced dismissal, silences it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv, createMockResponse } from './helpers/frontend-harness.js';
import { loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';
import { idle, signal } from './helpers/settle.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const BOOTSTRAP_JS = path.join(REPO_ROOT, 'web/static/js/features/bootstrap.js');
const SHOULD_PROMPT = '/api/tz-suggestion/should-prompt';

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
    vi.spyOn(window, 'fetch').mockImplementation(async () => createMockResponse({ json: {} }));
}

function stubBootstrapGlobals(window) {
    window.switchTab = vi.fn();
    window.checkAuth = vi.fn().mockResolvedValue(true);
    window.handleDeepLinks = vi.fn();
}

// apiCall stand-in: answers the should-prompt question with `decision`, and
// fires `asked` once it has, so a negative assertion has a unit of work to
// wait on instead of a deadline.
function stubApiCall(window, decision) {
    const asked = signal();
    const spy = vi.fn(async (endpoint) => {
        if (String(endpoint).startsWith(SHOULD_PROMPT)) {
            queueMicrotask(() => asked.fire());
            return decision;
        }
        return { status: 'ok' };
    });
    window.apiCall = spy;
    return { spy, asked };
}

// utils.js `safeConfirm` mounts the in-page modal SYNCHRONOUSLY inside its
// Promise executor, so firing after the call-through makes "the modal is in
// the DOM" a fact rather than a deadline to poll against.
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

function runBootstrap(window) {
    window.eval(fs.readFileSync(BOOTSTRAP_JS, 'utf8'));
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

        forceDetectedTimezone(window, 'America/Chicago');
        stubApiCall(window, { prompt: true, reason: '', current_tz: 'Europe/Berlin' });

        // A never-resolving prompt: if bootstrap still awaited it on the
        // critical path, switchTab would never be reached.
        let promptCalled = 0;
        const prompted = signal();
        window.safeConfirm = () => {
            promptCalled += 1;
            prompted.fire();
            return new Promise(() => { /* never resolves */ });
        };

        stubBootstrapFetch(window);
        stubBootstrapGlobals(window);

        runBootstrap(window);

        // The prompt itself is the settle point: a switchTab that has not
        // happened by then is the regression.
        await prompted.wait;

        expect(window.switchTab).toHaveBeenCalledWith('today');
        expect(promptCalled).toBe(1);
    });

    it('asks the domain with the detected zone', async () => {
        allowConsoleNoise();
        const { window } = env;

        forceDetectedTimezone(window, 'America/Argentina/Buenos_Aires');
        const { spy, asked } = stubApiCall(window, { prompt: false, reason: 'x' });
        stubBootstrapFetch(window);
        stubBootstrapGlobals(window);

        runBootstrap(window);
        await asked.wait;

        expect(spy).toHaveBeenCalledWith(
            `${SHOULD_PROMPT}?detected_tz=${encodeURIComponent('America/Argentina/Buenos_Aires')}`,
        );
    });

    it('accept POSTs /api/settings and invalidates cache', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        const detectedTz = 'America/Chicago';
        forceDetectedTimezone(window, detectedTz);
        const { spy: apiCallSpy } = stubApiCall(window, { prompt: true, reason: '', current_tz: 'Europe/Berlin' });
        // The invalidation is the LAST statement of the accept path.
        const invalidated = signal();
        const invalidateSpy = vi.fn(async () => { invalidated.fire(); });
        window.DataStore.invalidateKey = invalidateSpy;

        stubBootstrapFetch(window);
        stubBootstrapGlobals(window);
        const modalShown = watchConfirmModal(window);

        runBootstrap(window);

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
        const dismissCalls = apiCallSpy.mock.calls.filter((args) => args[0] === '/api/tz-suggestion/dismiss');
        expect(dismissCalls).toHaveLength(0);
    });

    // bd med-26gl — a staged plan's Apply / Cancel card must be on screen.
    async function acceptWithSettingsResult(window, document, settingsResult) {
        forceDetectedTimezone(window, 'America/Chicago');
        window.apiCall = vi.fn(async (endpoint) => {
            if (String(endpoint).startsWith(SHOULD_PROMPT)) return { prompt: true, reason: '', current_tz: 'Europe/Berlin' };
            if (endpoint === '/api/settings') return settingsResult;
            return { status: 'ok' };
        });
        const invalidated = signal();
        window.DataStore.invalidateKey = vi.fn(async () => { invalidated.fire(); });
        stubBootstrapFetch(window);
        stubBootstrapGlobals(window);
        const modalShown = watchConfirmModal(window);

        runBootstrap(window);
        await modalShown.wait;
        // Boot's own switchTab already ran; count only what the accept adds.
        window.switchTab.mockClear();
        document.querySelector('mt-modal.mt-confirm-modal .mt-confirm-modal__confirm').click();
        await invalidated.wait;
        await idle();
    }

    it('accept that stages a plan (planCreated: true) switches to Today', async () => {
        allowConsoleNoise();
        const { window, document } = env;
        await acceptWithSettingsResult(window, document, { changed: false, planCreated: true });
        expect(window.switchTab.mock.calls).toEqual([['today']]);
    });

    it('accept applied immediately (planCreated: false) navigates nowhere', async () => {
        allowConsoleNoise();
        const { window, document } = env;
        await acceptWithSettingsResult(window, document, { changed: true, planCreated: false });
        expect(window.switchTab).not.toHaveBeenCalled();
    });

    it('cancel POSTs /api/tz-suggestion/dismiss with detected_tz', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        const detectedTz = 'America/Chicago';
        forceDetectedTimezone(window, detectedTz);
        const dismissed = signal();
        const apiCallSpy = vi.fn(async (endpoint) => {
            if (String(endpoint).startsWith(SHOULD_PROMPT)) return { prompt: true, reason: '', current_tz: 'Europe/Berlin' };
            if (endpoint === '/api/tz-suggestion/dismiss') dismissed.fire();
            return { status: 'ok' };
        });
        window.apiCall = apiCallSpy;
        const invalidateSpy = vi.fn().mockResolvedValue(undefined);
        window.DataStore.invalidateKey = invalidateSpy;

        stubBootstrapFetch(window);
        stubBootstrapGlobals(window);
        const modalShown = watchConfirmModal(window);

        runBootstrap(window);

        await modalShown.wait;
        document.querySelector('mt-modal.mt-confirm-modal .mt-confirm-modal__cancel').click();
        await dismissed.wait;
        await idle();

        expect(apiCallSpy).toHaveBeenCalledWith('/api/tz-suggestion/dismiss', 'POST', { detected_tz: detectedTz });
        const settingsCalls = apiCallSpy.mock.calls.filter((args) => args[0] === '/api/settings');
        expect(settingsCalls).toHaveLength(0);
        expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it('does not prompt when the domain says no', async () => {
        allowConsoleNoise();
        const { window, document } = env;

        forceDetectedTimezone(window, 'America/Chicago');
        const { spy: apiCallSpy, asked } = stubApiCall(window, {
            prompt: false, reason: 'user already dismissed this detected timezone',
        });
        stubBootstrapFetch(window);
        stubBootstrapGlobals(window);

        runBootstrap(window);
        await asked.wait;
        await idle();

        expect(document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
        expect(apiCallSpy).not.toHaveBeenCalledWith('/api/settings', expect.anything(), expect.anything());
        expect(apiCallSpy).not.toHaveBeenCalledWith('/api/tz-suggestion/dismiss', expect.anything(), expect.anything());
    });
});

// The same flow over the real cloud shim + web/domain/tzplan.js, so the
// decision under test is the domain's, not a stub's.
describe('bootstrap.js TZ prompt over the cloud shim (bd med-gjsp)', () => {
    let env;

    const settingsRecord = (timezone) => ({
        recordId: 'settings', clientTs: Date.now(), deleted: false, timezone,
    });
    const planRecord = (status) => ({
        recordId: 'tzplan-current',
        clientTs: Date.now(),
        deleted: false,
        old_tz: 'Europe/Berlin',
        new_tz: 'America/Chicago',
        status,
        created_at: new Date().toISOString(),
        steps: [{
            medicationId: 1, medName: 'Metformin', stepNumber: 1, totalSteps: 1, scheduledAtMs: Date.now() + 3600_000, note: 'Shift dose 1h',
        }],
    });

    // Fires once the should-prompt answer is back from the shim.
    function watchDecision(window) {
        const decided = signal();
        const inner = window.offlineAwareApiCall;
        window.offlineAwareApiCall = async (endpoint, ...rest) => {
            const res = await inner(endpoint, ...rest);
            if (String(endpoint).startsWith(SHOULD_PROMPT)) queueMicrotask(() => decided.fire());
            return res;
        };
        return decided;
    }

    function boot(seedRecords) {
        env = loadCloudShimFrontendEnv({ seedRecords });
        const { window } = env;
        allowConsoleNoise();
        forceDetectedTimezone(window, 'America/Chicago');
        stubBootstrapFetch(window);
        stubBootstrapGlobals(window);
        const decided = watchDecision(window);
        const modalShown = watchConfirmModal(window);
        runBootstrap(window);
        return { window, decided, modalShown };
    }

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('a PENDING_APPROVAL plan targeting the detected zone silences the prompt', async () => {
        const { decided } = boot({ settings: [settingsRecord('Europe/Berlin')], tzplan: [planRecord('PENDING_APPROVAL')] });
        await decided.wait;
        await idle();
        expect(env.document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
    });

    it('an APPROVED plan targeting the detected zone silences the prompt', async () => {
        const { decided } = boot({ settings: [settingsRecord('America/Chicago')], tzplan: [planRecord('APPROVED')] });
        await decided.wait;
        await idle();
        expect(env.document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
    });

    it('no plan: prompts, naming the stored zone', async () => {
        const { modalShown } = boot({ settings: [settingsRecord('Europe/Berlin')] });
        await modalShown.wait;
        const message = env.document.querySelector('mt-modal.mt-confirm-modal .mt-confirm-modal__message');
        expect(message.textContent).toContain('America/Chicago');
        expect(message.textContent).toContain('Europe/Berlin');
    });

    it('travelling back to the stored zone never prompts', async () => {
        const { decided } = boot({ settings: [settingsRecord('America/Chicago')] });
        await decided.wait;
        await idle();
        expect(env.document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
    });
});
