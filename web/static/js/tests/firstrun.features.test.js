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
const INTEGRATIONS_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/screens/integrations.js');
const INDEX_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/index.js');
const NOTIFY_JS = path.join(REPO_ROOT, 'web/static/js/features/notify-permission.js');

// W1 — the first-run module picker (bd med-ta2n.1, screens-onboarding-v3.html
// W1): the first and only picker screen of the WGFirstRun overlay. Seven
// check choices, nothing preselected, "Continue with N", Skip = all on. The
// six flagged rows are exactly the cloud shim's PORTED_SET tracking keys;
// Diary has no flag. Continue/Skip write an explicit boolean for every flag
// (med-t05.1), then POST /api/firstrun/complete with `picked`, unless the
// free AI trial is on offer (med-js3k), which comes first.

const SHELL_HTML = `<!doctype html><html><body></body></html>`;

const W1_ORDER = ['medication', 'bp', 'weight', 'workout', 'health', 'food', 'diary'];
const FLAGS = ['medication', 'bp', 'weight', 'workout', 'health', 'food'];

function loadFlow({
    fetchMock = null, toggleMock = null, features = null, notifyPermission = null,
    trialOffer = null, localTrial = null, trialAi = false, wizardChoice = null,
    local = false, native = null,
} = {}) {
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
    // features/settings/integrations.js's trialOffer() (med-6xb9).
    if (trialOffer) window.SettingsIntegrations = { trialOffer };
    // Device-only mode: local-policy.js LOCAL_VAULT.trial.
    if (localTrial) window.CloudVault = { trial: localTrial };
    if (trialAi) {
        const meta = window.document.createElement('meta');
        meta.name = 'medtracker-trial-ai';
        meta.content = '1';
        window.document.head.appendChild(meta);
    }
    if (wizardChoice) window.localStorage.setItem('wg-onboarding-trial-choice', wizardChoice);
    if (local) window.document.documentElement.classList.add('wg-local-vault');
    // The native foundation (native/index.js) as features see it.
    if (native) window.LocalNotifications = { __native: native };

    const files = [STATE_JS, FEATURES_JS, INTEGRATIONS_JS, INDEX_JS];
    if (notifyPermission) {
        window.Notification = { permission: notifyPermission };
        files.unshift(NOTIFY_JS);
    }
    for (const file of files) {
        const src = fs.readFileSync(file, 'utf8');
        window.eval(`${src}\n//# sourceURL=file://${file}`);
    }
    return { window, document: window.document, cleanup: () => dom.window.close() };
}

function okFetch() {
    return vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }));
}

// The flag writes and the completion POST a fetch mock saw.
function writes(fetchMock) {
    const flags = {};
    let complete = null;
    for (const [url, opts] of fetchMock.mock.calls) {
        if (url === '/api/firstrun/complete') complete = opts.body ? JSON.parse(opts.body) : {};
        else flags[url.replace('/api/settings/features/', '')] = JSON.parse(opts.body).enabled;
    }
    return { flags, complete };
}

const row = (document, key) => document.querySelector(`[data-firstrun-feature="${key}"]`);
const action = (document, name) => document.querySelector(`[data-firstrun-action="${name}"]`);
const pick = (document, ...keys) => keys.forEach((k) => row(document, k).click());
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('firstrun W1 module picker', () => {
    it('is the first screen: title, lede, seven rows in W1 order, nothing picked, brand row', () => {
        const { window, document, cleanup } = loadFlow({ fetchMock: okFetch() });
        try {
            window.WGFirstRun.mount();
            expect(window.WGFirstRun.state.getStep()).toBe('features');
            expect(document.getElementById('wg-firstrun-title').textContent).toBe('What do you want to track?');
            expect(document.querySelector('#wg-firstrun-overlay-body .wg-shell__lede').textContent)
                .toBe('Pick any. You can change this later in Settings.');

            const rows = [...document.querySelectorAll('[data-firstrun-feature]')];
            expect(rows.map((r) => r.getAttribute('data-firstrun-feature'))).toEqual(W1_ORDER);
            expect(rows.map((r) => r.firstChild.firstChild.textContent))
                .toEqual(['Medications', 'Blood pressure', 'Weight', 'Workouts', 'Sleep', 'Food', 'Diary']);
            expect(row(document, 'health').textContent).toContain('From your watch or by hand');
            for (const r of rows) {
                expect(r.classList.contains('wg-choice--check')).toBe(true);
                expect(r.getAttribute('aria-pressed')).toBe('false');
            }
            // Brand row instead of the step bars.
            expect(document.getElementById('wg-firstrun-brand').hidden).toBe(false);
            expect(document.getElementById('wg-firstrun-steps').hidden).toBe(true);
            // No crypto talk on the screen.
            expect(document.getElementById('wg-firstrun-overlay').textContent)
                .not.toMatch(/encrypt|vault|passkey|\bkeys?\b/i);
        } finally { cleanup(); }
    });

    // PORTED_SET (web/cloud/js/apishim.js) has no gamification; weekly_digest
    // is Telegram-only; live_hr is a Vitals sub-feature.
    it('has no rows for gamification, weekly_digest or live_hr', () => {
        const { window, document, cleanup } = loadFlow({ fetchMock: okFetch() });
        try {
            window.WGFirstRun.mount();
            for (const key of ['gamification', 'weekly_digest', 'live_hr']) expect(row(document, key)).toBeNull();
        } finally { cleanup(); }
    });

    it('the primary counts the picks: "Continue" at 0, "Continue with N" after', () => {
        const { window, document, cleanup } = loadFlow({ fetchMock: okFetch() });
        try {
            window.WGFirstRun.mount();
            const cont = action(document, 'continue');
            expect(cont.classList.contains('wg-btn--primary')).toBe(true);
            expect(cont.textContent).toBe('Continue');
            pick(document, 'medication', 'food', 'diary');
            expect(row(document, 'food').getAttribute('aria-pressed')).toBe('true');
            expect(cont.textContent).toBe('Continue with 3');
            pick(document, 'food');
            expect(cont.textContent).toBe('Continue with 2');
            // Taps write nothing.
        } finally { cleanup(); }
    });

    it('taps write nothing until Continue', async () => {
        const fetchMock = okFetch();
        const { window, document, cleanup } = loadFlow({ fetchMock });
        try {
            window.WGFirstRun.mount();
            pick(document, 'bp', 'weight');
            await flush();
            expect(fetchMock).not.toHaveBeenCalled();
        } finally { cleanup(); }
    });

    // The load-bearing case (med-t05.1): unpicked flags are written false, or
    // getFeatures() would spread the all-on DEFAULT_FEATURES back over them.
    it('Continue with 3 picks writes exactly those on, the rest off, and completes with picked', async () => {
        const fetchMock = okFetch();
        const { window, document, cleanup } = loadFlow({ fetchMock });
        try {
            window.WGFirstRun.mount();
            pick(document, 'food', 'medication', 'diary');
            action(document, 'continue').click();
            await flush();

            const { flags, complete } = writes(fetchMock);
            expect(flags).toEqual({ medication: true, bp: false, weight: false, workout: false, health: false, food: true });
            // W1 order, not tap order; Diary has no flag but is a pick.
            expect(complete).toEqual({ picked: ['medication', 'food', 'diary'] });
            expect(document.getElementById('wg-firstrun-overlay')).toBeNull();
            expect(window.__MEDTRACKER_BOOTSTRAP__.needs_first_run).toBe(false);
            expect(window.sessionStorage.getItem('wg-firstrun-step')).toBeNull();
            expect(window.sessionStorage.getItem('wg-firstrun-picked')).toBeNull();
        } finally { cleanup(); }
    });

    it('Skip turns all six on and picks all seven, whatever was tapped', async () => {
        const fetchMock = okFetch();
        const { window, document, cleanup } = loadFlow({ fetchMock });
        try {
            window.WGFirstRun.mount();
            pick(document, 'bp');
            const skip = action(document, 'skip-all');
            expect(skip.textContent).toBe('Skip');
            expect(skip.classList.contains('wg-btn--ghost')).toBe(true);
            skip.click();
            await flush();

            const { flags, complete } = writes(fetchMock);
            expect(flags).toEqual(Object.fromEntries(FLAGS.map((k) => [k, true])));
            expect(complete).toEqual({ picked: W1_ORDER });
            expect(document.getElementById('wg-firstrun-overlay')).toBeNull();
        } finally { cleanup(); }
    });

    it('Continue with nothing picked acts like Skip', async () => {
        const fetchMock = okFetch();
        const { window, document, cleanup } = loadFlow({ fetchMock });
        try {
            window.WGFirstRun.mount();
            action(document, 'continue').click();
            await flush();
            const { flags, complete } = writes(fetchMock);
            expect(Object.values(flags)).toEqual(FLAGS.map(() => true));
            expect(complete).toEqual({ picked: W1_ORDER });
        } finally { cleanup(); }
    });

    it('routes the writes through toggleFeatureSetting when it is loaded', async () => {
        const features = {};
        const toggle = vi.fn((key, enabled) => { features[key] = enabled; return Promise.resolve(true); });
        const fetchMock = okFetch();
        const { window, document, cleanup } = loadFlow({ features, fetchMock, toggleMock: toggle });
        try {
            window.WGFirstRun.mount();
            pick(document, 'weight');
            action(document, 'continue').click();
            await flush();
            expect(toggle.mock.calls.map((c) => c[0])).toEqual(FLAGS);
            expect(features).toEqual({ medication: false, bp: false, weight: true, workout: false, health: false, food: false });
            // Only the completion POST goes to fetch.
            expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/firstrun/complete']);
        } finally { cleanup(); }
    });

    // Moving on after a failed write would leave the unpicked sections
    // silently ON (unwritten flag -> DEFAULT_FEATURES).
    it('stays on W1 with an error when a write fails or silently does not stick', async () => {
        for (const opts of [
            { fetchMock: vi.fn(() => Promise.resolve({ ok: false, status: 500 })) },
            // toggleFeatureSetting resolves whatever happened; the mirror tells.
            { fetchMock: okFetch(), features: {}, toggleMock: vi.fn(() => Promise.resolve(null)) },
        ]) {
            const { window, document, cleanup } = loadFlow(opts);
            try {
                window.WGFirstRun.mount();
                pick(document, 'bp');
                const cont = action(document, 'continue');
                cont.click();
                await flush();
                expect(window.WGFirstRun.state.getStep()).toBe('features');
                expect(document.getElementById('wg-firstrun-overlay')).not.toBeNull();
                expect(cont.disabled).toBe(false);
                expect(row(document, 'bp').disabled).toBe(false);
                expect(document.querySelector('[data-firstrun-feature-error]').textContent)
                    .toMatch(/couldn’t save your choices/i);
            } finally { cleanup(); }
        }
    });

    it('still dismisses when the completion POST rejects (offline-safe)', async () => {
        const fetchMock = vi.fn((url) => (url === '/api/firstrun/complete'
            ? Promise.reject(new Error('network down'))
            : Promise.resolve({ ok: true, status: 200 })));
        const { window, document, cleanup } = loadFlow({ fetchMock });
        try {
            window.WGFirstRun.mount();
            action(document, 'skip-all').click();
            await flush();
            expect(document.getElementById('wg-firstrun-overlay')).toBeNull();
            expect(window.WGFirstRun.isActive()).toBe(false);
        } finally { cleanup(); }
    });

    // End to end against the real cloud domain layer: getFeatures() spreading
    // DEFAULT_FEATURES over the stored flags decides what the app does, and the
    // firstrun record carries the picks W3 reads.
    it('persists flags and picks the cloud domain layer reads back', async () => {
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
        // notifyPermission: the production load, with the Medications note slot.
        const { window, document, cleanup } = loadFlow({ fetchMock, notifyPermission: 'default' });
        try {
            window.WGFirstRun.mount();
            pick(document, 'medication', 'weight', 'health');
            action(document, 'continue').click();
            await flush();
            await flush();

            expect(await router('/api/settings/features', 'GET')).toMatchObject({
                medication: true, weight: true, health: true, bp: false, food: false, workout: false,
            });
            const [firstrun] = await records.list('firstrun');
            expect(firstrun).toMatchObject({ first_run_complete: true, picked: ['medication', 'weight', 'health'] });
            expect((await router('/api/bootstrap', 'GET')).needs_first_run).toBe(false);
        } finally { cleanup(); }
    });

    // med-ckm5.4 (kit O3): with notifications blocked, picking Medications says
    // right under it that reminders won't fire.
    it('Medications picked + notifications denied shows the "Reminders won\'t fire" note', async () => {
        const { window, document, cleanup } = loadFlow({ fetchMock: okFetch(), notifyPermission: 'denied' });
        try {
            window.WGFirstRun.mount();
            const slot = document.querySelector('[data-firstrun-notify-note]');
            expect(slot.previousElementSibling).toBe(row(document, 'medication'));
            await flush();
            expect(slot.querySelector('[data-notify-denied]')).toBeNull();

            pick(document, 'medication');
            await flush();
            const note = slot.querySelector('.wg-note.wg-note--warn[data-notify-denied]');
            expect(note).not.toBeNull();
            expect(note.textContent).toContain('Reminders won’t fire.');

            pick(document, 'medication');
            await flush();
            expect(slot.children).toHaveLength(0);
        } finally { cleanup(); }
    });

    it('Medications picked + notifications granted shows no note', async () => {
        const { window, document, cleanup } = loadFlow({ fetchMock: okFetch(), notifyPermission: 'granted' });
        try {
            window.WGFirstRun.mount();
            pick(document, 'medication');
            await flush();
            expect(document.querySelector('[data-notify-denied]')).toBeNull();
        } finally { cleanup(); }
    });
});

// bd med-js3k: neither Skip nor Continue may hide the free AI trial. With one
// on offer the trial step follows W1; leaving it finishes the flow.
describe('firstrun W1 → trial offer', () => {
    it('with the cloud trial on offer, W1 leads to the trial step; its Skip completes with the picks', async () => {
        const fetchMock = okFetch();
        const trialOffer = vi.fn().mockResolvedValue(true);
        const { window, document, cleanup } = loadFlow({ fetchMock, trialOffer, trialAi: true });
        try {
            window.WGFirstRun.mount();
            pick(document, 'food');
            action(document, 'continue').click();
            await flush();

            expect(trialOffer).toHaveBeenCalledTimes(1);
            expect(writes(fetchMock).complete).toBeNull();
            expect(window.WGFirstRun.state.getStep()).toBe('integrations');
            expect(action(document, 'trial')).not.toBeNull();
            // The trial step shows the step bars, not the brand row.
            expect(document.getElementById('wg-firstrun-steps').hidden).toBe(false);
            expect(document.getElementById('wg-firstrun-brand').hidden).toBe(true);

            action(document, 'skip').click();
            await flush();
            expect(writes(fetchMock).complete).toEqual({ picked: ['food'] });
            expect(document.getElementById('wg-firstrun-overlay')).toBeNull();
        } finally { cleanup(); }
    });

    it('in device-only mode Skip shows the local trial choice first', async () => {
        const fetchMock = okFetch();
        const localTrial = { status: vi.fn().mockResolvedValue({ on: false }), apply: vi.fn(), enroll: vi.fn() };
        const { window, document, cleanup } = loadFlow({
            fetchMock, localTrial, trialOffer: vi.fn().mockResolvedValue(true),
        });
        try {
            window.WGFirstRun.mount();
            action(document, 'skip-all').click();
            await flush();
            expect(document.getElementById('wg-firstrun-title').textContent).toBe('AI and food database');

            action(document, 'skip').click();
            await flush();
            expect(writes(fetchMock).complete).toEqual({ picked: W1_ORDER });
            expect(document.getElementById('wg-firstrun-overlay')).toBeNull();
        } finally { cleanup(); }
    });

    it('completes straight from W1 when no trial is on offer', async () => {
        for (const opts of [
            {},
            { trialOffer: vi.fn().mockResolvedValue(false) },
            { trialOffer: vi.fn().mockRejectedValue(new Error('offline')) },
            // The claim wizard already offered the trial.
            { trialOffer: vi.fn().mockResolvedValue(true), trialAi: true, wizardChoice: 'skip' },
        ]) {
            const fetchMock = okFetch();
            const { window, document, cleanup } = loadFlow({ fetchMock, ...opts });
            try {
                window.WGFirstRun.mount();
                action(document, 'skip-all').click();
                await flush();
                expect(writes(fetchMock).complete).toEqual({ picked: W1_ORDER });
                expect(document.getElementById('wg-firstrun-overlay')).toBeNull();
                expect(action(document, 'trial')).toBeNull();
            } finally { cleanup(); }
        }
    });
});

// F1 entry (W1 footer, opposite Skip): only in a v3 shell (it lists
// invite.pending), in local mode, with no invite already waiting.
describe('firstrun W1 "Have an invite?" footer', () => {
    function shell({ ops = ['invite.pending'], slot = null } = {}) {
        return {
            platform: 'ios',
            has: vi.fn(async (op) => ops.includes(op)),
            call: vi.fn(async (op) => (op === 'invite.pending' ? slot : null)),
        };
    }

    it('shows in a local-mode v3 shell with no slot, and opens F1 via wg:invite-open', async () => {
        const native = shell();
        const { window, document, cleanup } = loadFlow({ fetchMock: okFetch(), local: true, native });
        try {
            window.WGFirstRun.mount();
            await flush();
            const invite = action(document, 'invite');
            expect(invite).not.toBeNull();
            expect(invite.textContent).toBe('Have an invite?');
            expect(invite.classList.contains('wg-btn--ghost')).toBe(true);
            // Same row as Skip, after the spacer.
            expect(invite.parentElement).toBe(action(document, 'skip-all').parentElement);
            expect(native.call).toHaveBeenCalledWith('invite.pending');

            const opened = vi.fn();
            document.addEventListener('wg:invite-open', opened);
            invite.click();
            expect(opened).toHaveBeenCalledTimes(1);
        } finally { cleanup(); }
    });

    it('stays hidden on the web, in account mode, in a pre-v3 shell, and while an invite waits', async () => {
        for (const opts of [
            { local: true }, // the web: no native foundation
            { local: false, native: shell() }, // account mode in a shell
            { local: true, native: shell({ ops: [] }) }, // shell without invite.pending
            { local: true, native: shell({ slot: { url: 'https://a.example.test/#claim=ab', receivedAt: 1 } }) }, // W1 · invited
        ]) {
            const { window, document, cleanup } = loadFlow({ fetchMock: okFetch(), ...opts });
            try {
                window.WGFirstRun.mount();
                await flush();
                expect(action(document, 'invite')).toBeNull();
                expect(action(document, 'skip-all')).not.toBeNull();
            } finally { cleanup(); }
        }
    });
});
