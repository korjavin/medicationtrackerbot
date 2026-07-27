import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createApiRouter } from '../../../cloud/js/apishim.js';
import { createInMemoryRecordsPort } from './helpers/cloud-shim-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const STATE_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/state.js');
const FEATURES_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/screens/features.js');
const INDEX_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/index.js');

// features/firstrun/screens/features.js — the feature-picker step (med-4pz.2).
// Sits between "welcome" and "integrations". Toggles write through
// immediately via the Settings global `toggleFeatureSetting` when it is
// loaded, falling back to a direct POST when it is not (this harness).
//
// The catalog is the six tracking sections, which is exactly the cloud
// shim's PORTED_SET — `gamification` and `weekly_digest` must never appear,
// because the shim rejects enabling the former and the latter is bot-only.

const SHELL_HTML = `<!doctype html><html><body></body></html>`;

const TRACKING_KEYS = ['medication', 'bp', 'weight', 'food', 'workout', 'health'];

function loadFlow({ features = null, fetchMock = null, toggleMock = null, initialStep = 'features' } = {}) {
    const dom = new JSDOM(SHELL_HTML, {
        url: 'https://example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    window.__MEDTRACKER_BOOTSTRAP__ = { needs_first_run: true };
    if (features) window.featureSettings = features;
    if (fetchMock) window.fetch = fetchMock;
    if (toggleMock) window.toggleFeatureSetting = toggleMock;
    if (initialStep) window.sessionStorage.setItem('wg-firstrun-step', initialStep);

    for (const file of [STATE_JS, FEATURES_JS, INDEX_JS]) {
        const src = fs.readFileSync(file, 'utf8');
        window.eval(`${src}\n//# sourceURL=file://${file}`);
    }

    return { window, document: window.document, cleanup: () => dom.window.close() };
}

function okFetch() {
    return vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ enabled: true }) }));
}

function rowToggle(document, key) {
    return document.querySelector(`[data-firstrun-feature-toggle="${key}"]`);
}

// Let the change handler's promise chain settle.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('firstrun feature picker screen', () => {
    it('is a valid step and renders one row per tracking feature', () => {
        const { window, document, cleanup } = loadFlow({ fetchMock: okFetch() });
        try {
            expect(window.WGFirstRun.state.VALID_STEPS).toContain('features');

            window.WGFirstRun.mount();

            const title = document.getElementById('wg-firstrun-title');
            expect(title.textContent).toMatch(/what do you want to track/i);

            const rows = document.querySelectorAll('[data-firstrun-feature]');
            expect(Array.from(rows).map((r) => r.getAttribute('data-firstrun-feature'))).toEqual(TRACKING_KEYS);
        } finally {
            cleanup();
        }
    });

    // Guards the cloud shim contract: PORTED_SET (web/cloud/js/apishim.js) has
    // no `gamification`, so a rendered toggle for it would POST, get a null
    // back, and silently snap off. `weekly_digest` is a Telegram-only digest.
    it('omits gamification and weekly_digest from the catalog', () => {
        const { window, document, cleanup } = loadFlow({ fetchMock: okFetch() });
        try {
            window.WGFirstRun.mount();
            expect(rowToggle(document, 'gamification')).toBeNull();
            expect(rowToggle(document, 'weekly_digest')).toBeNull();
        } finally {
            cleanup();
        }
    });

    // Owner call (med-t05.1): the three low-friction daily-logging sections
    // start on; the three that need a device, a prescription, or a clinical
    // reason start off. Note this is NOT web/domain/settings.js
    // DEFAULT_FEATURES, which stays all-on as the fallback for existing
    // accounts — see the explicit-write test below.
    it('pre-checks food/workout/weight and leaves medication/bp/health unchecked', () => {
        const { window, document, cleanup } = loadFlow({ fetchMock: okFetch() });
        try {
            window.WGFirstRun.mount();
            for (const key of ['food', 'workout', 'weight']) {
                expect(rowToggle(document, key).checked, `${key} should be pre-checked`).toBe(true);
            }
            for (const key of ['medication', 'bp', 'health']) {
                expect(rowToggle(document, key).checked, `${key} should start unchecked`).toBe(false);
            }
        } finally {
            cleanup();
        }
    });

    it('reflects an already-disabled feature from window.featureSettings', () => {
        const { window, document, cleanup } = loadFlow({
            features: { medication: true, bp: false, weight: true, food: true, workout: true, health: true },
            fetchMock: okFetch(),
        });
        try {
            window.WGFirstRun.mount();
            expect(rowToggle(document, 'bp').checked).toBe(false);
            expect(rowToggle(document, 'medication').checked).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('routes a flip through window.toggleFeatureSetting when it is loaded', async () => {
        const features = { medication: true, bp: true, weight: true, food: true, workout: true, health: true };
        // Mirror the real global: it updates window.featureSettings on success.
        const toggle = vi.fn((key, enabled) => {
            features[key] = enabled;
            return Promise.resolve(true);
        });
        const fetchMock = okFetch();
        const { window, document, cleanup } = loadFlow({ features, fetchMock, toggleMock: toggle });
        try {
            window.WGFirstRun.mount();

            const food = rowToggle(document, 'food');
            food.checked = false;
            food.dispatchEvent(new window.Event('change'));
            await flush();

            expect(toggle).toHaveBeenCalledWith('food', false);
            expect(fetchMock).not.toHaveBeenCalled();
            expect(food.checked).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('POSTs the single-feature endpoint when the Settings global is absent', async () => {
        const fetchMock = okFetch();
        const { window, document, cleanup } = loadFlow({ fetchMock });
        try {
            window.WGFirstRun.mount();

            const workout = rowToggle(document, 'workout');
            workout.checked = false;
            workout.dispatchEvent(new window.Event('change'));
            await flush();

            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, opts] = fetchMock.mock.calls[0];
            expect(url).toBe('/api/settings/features/workout');
            expect(opts.method).toBe('POST');
            expect(JSON.parse(opts.body)).toEqual({ enabled: false });
            expect(workout.checked).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('reverts the checkbox and shows an inline error when the write is rejected', async () => {
        const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 500 }));
        const { window, document, cleanup } = loadFlow({ fetchMock });
        try {
            window.WGFirstRun.mount();

            // `food` is one of the pre-checked three, so this exercises a
            // rejected on->off flip.
            const food = rowToggle(document, 'food');
            expect(food.checked).toBe(true);
            food.checked = false;
            food.dispatchEvent(new window.Event('change'));
            await flush();

            expect(food.checked, 'rejected write must not leave the toggle lying').toBe(true);
            expect(food.disabled).toBe(false);
            const error = document.querySelector('[data-firstrun-feature-error]');
            expect(error.textContent).toMatch(/couldn’t save/i);
        } finally {
            cleanup();
        }
    });

    // toggleFeatureSetting resolves regardless of outcome — it reverts its own
    // DOM and returns nothing useful — so the screen re-reads the mirror to
    // decide whether the flip actually stuck.
    it('reverts when toggleFeatureSetting silently fails to apply the flip', async () => {
        const features = { medication: true, bp: true, weight: true, food: true, workout: true, health: true };
        const toggle = vi.fn(() => Promise.resolve(null)); // never mutates the mirror
        const { window, document, cleanup } = loadFlow({ features, toggleMock: toggle, fetchMock: okFetch() });
        try {
            window.WGFirstRun.mount();

            const health = rowToggle(document, 'health');
            health.checked = false;
            health.dispatchEvent(new window.Event('change'));
            await flush();

            expect(health.checked).toBe(true);
            const error = document.querySelector('[data-firstrun-feature-error]');
            expect(error.textContent).toMatch(/couldn’t save/i);
        } finally {
            cleanup();
        }
    });

    it('Continue advances to the integrations step', async () => {
        const { window, document, cleanup } = loadFlow({ fetchMock: okFetch() });
        try {
            window.WGFirstRun.mount();
            document.querySelector('[data-firstrun-action="continue"]').click();
            await flush();
            expect(window.WGFirstRun.state.getStep()).toBe('integrations');
        } finally {
            cleanup();
        }
    });

    // The load-bearing case (med-t05.1). A user who accepts the defaults flips
    // nothing, so a deviation-only write path issues ZERO POSTs, leaves the
    // features record empty, and getFeatures() falls back to the all-on
    // DEFAULT_FEATURES — bp/health/medication come back ON while their boxes
    // showed UNCHECKED. Continue must therefore write all six explicitly.
    it('writes an explicit boolean for all six features when the user accepts the defaults', async () => {
        const fetchMock = okFetch();
        const { window, document, cleanup } = loadFlow({ fetchMock });
        try {
            window.WGFirstRun.mount();
            document.querySelector('[data-firstrun-action="continue"]').click();
            await flush();

            const written = {};
            for (const [url, opts] of fetchMock.mock.calls) {
                expect(opts.method).toBe('POST');
                const key = url.replace('/api/settings/features/', '');
                written[key] = JSON.parse(opts.body).enabled;
            }
            expect(written).toEqual({
                medication: false, bp: false, health: false, weight: true, food: true, workout: true,
            });
            expect(fetchMock).toHaveBeenCalledTimes(TRACKING_KEYS.length);
        } finally {
            cleanup();
        }
    });

    it('routes the Continue writes through toggleFeatureSetting when it is loaded', async () => {
        const features = {};
        const toggle = vi.fn((key, enabled) => { features[key] = enabled; return Promise.resolve(true); });
        const fetchMock = okFetch();
        const { window, document, cleanup } = loadFlow({ features, fetchMock, toggleMock: toggle });
        try {
            window.WGFirstRun.mount();
            document.querySelector('[data-firstrun-action="continue"]').click();
            await flush();

            expect(fetchMock).not.toHaveBeenCalled();
            expect(features).toEqual({
                medication: false, bp: false, health: false, weight: true, food: true, workout: true,
            });
        } finally {
            cleanup();
        }
    });

    // Advancing on a failed write would leave the unchecked features silently
    // ON (unwritten flag -> DEFAULT_FEATURES). Stay put and let the user retry.
    it('stays on the step and shows an error when a Continue write fails', async () => {
        const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 500 }));
        const { window, document, cleanup } = loadFlow({ fetchMock });
        try {
            window.WGFirstRun.mount();
            const cont = document.querySelector('[data-firstrun-action="continue"]');
            cont.click();
            await flush();

            expect(window.WGFirstRun.state.getStep()).toBe('features');
            expect(cont.disabled).toBe(false);
            expect(document.querySelector('[data-firstrun-feature-error]').textContent)
                .toMatch(/couldn’t save your choices/i);
        } finally {
            cleanup();
        }
    });

    // End-to-end against the real cloud domain layer, because a DOM-only
    // assertion passes while the app is wrong: it is getFeatures() spreading
    // DEFAULT_FEATURES over the stored flags that decides what the app does.
    it('persists flags the cloud domain layer reads back with bp/health/medication off', async () => {
        const records = createInMemoryRecordsPort();
        const router = createApiRouter(null, {
            records, now: () => Date.parse('2026-07-10T12:00:00.000Z'), timeZone: 'UTC',
        });
        const fetchMock = vi.fn(async (url, opts) => {
            const method = (opts && opts.method) || 'GET';
            const body = opts && opts.body ? JSON.parse(opts.body) : undefined;
            const result = await router(url, method, body);
            return { ok: result !== null && result !== undefined, status: 200, json: async () => result };
        });

        const { window, document, cleanup } = loadFlow({ fetchMock });
        try {
            window.WGFirstRun.mount();
            document.querySelector('[data-firstrun-action="continue"]').click();
            await flush();

            expect(window.WGFirstRun.state.getStep()).toBe('integrations');
            const flags = await router('/api/settings/features', 'GET');
            expect(flags).toMatchObject({
                bp: false, health: false, medication: false, food: true, workout: true, weight: true,
            });
        } finally {
            cleanup();
        }
    });

    // A user resuming the wizard, or one whose account already carries flags,
    // must see their own state rather than the first-run pre-check set.
    it('prefers an existing mirror value over the first-run pre-check state', () => {
        const { window, document, cleanup } = loadFlow({
            features: { bp: true, food: false },
            fetchMock: okFetch(),
        });
        try {
            window.WGFirstRun.mount();
            expect(rowToggle(document, 'bp').checked, 'explicit true beats pre-check off').toBe(true);
            expect(rowToggle(document, 'food').checked, 'explicit false beats pre-check on').toBe(false);
            // Absent from the mirror -> fall back to the pre-check state.
            expect(rowToggle(document, 'workout').checked).toBe(true);
            expect(rowToggle(document, 'medication').checked).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('is the step the welcome screen advances into', () => {
        const { window, cleanup } = loadFlow({ initialStep: 'features', fetchMock: okFetch() });
        try {
            window.WGFirstRun.mount();
            expect(window.WGFirstRun.state.getStep()).toBe('features');
        } finally {
            cleanup();
        }
    });
});
