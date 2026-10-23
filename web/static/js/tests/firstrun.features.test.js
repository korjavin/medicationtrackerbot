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
const TRIAL_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/screens/trial.js');
const OFFER_CARD_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-offer-card.js');
const INDEX_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/index.js');
const NOTIFY_JS = path.join(REPO_ROOT, 'web/static/js/features/notify-permission.js');
const INVITE_JS = path.join(REPO_ROOT, 'web/static/js/features/invite.js');

// W1 — the first-run module picker (bd med-ta2n.1, screens-onboarding-v3.html
// W1): the first and only picker screen of the WGFirstRun overlay. Seven
// check choices, nothing preselected, "Continue with N", Skip = all on. The
// six flagged rows are exactly the cloud shim's PORTED_SET tracking keys;
// Diary has no flag. Continue/Skip write an explicit boolean for every flag
// (med-t05.1), then POST /api/firstrun/complete with `picked`, unless Food
// was picked and the free AI trial is on offer — then W2 comes first
// (med-ta2n.2).

const SHELL_HTML = `<!doctype html><html><body></body></html>`;

const W1_ORDER = ['medication', 'bp', 'weight', 'workout', 'health', 'food', 'diary'];
const FLAGS = ['medication', 'bp', 'weight', 'workout', 'health', 'food'];

function loadFlow({
    fetchMock = null, toggleMock = null, features = null, notifyPermission = null,
    trialOffer = null, localTrial = null, trialAi = false, trialConsent = null,
    local = false, native = null, invite = false, base = null,
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
    if (trialConsent) window.TrialConsent = trialConsent;
    if (local) window.document.documentElement.classList.add('wg-local-vault');
    // The native foundation (native/index.js) as features see it.
    if (native) window.LocalNotifications = { __native: native };
    // The shell's deployment base as InviteSheet.base() reads it (Attest.status()).
    if (base) window.Attest = { isSupported: () => true, status: async () => ({ base }) };

    const files = [OFFER_CARD_JS, STATE_JS, FEATURES_JS, TRIAL_JS, INDEX_JS];
    if (invite) files.unshift(INVITE_JS);
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
            pick(document, 'food', 'medication', 'bp');
            action(document, 'continue').click();
            await flush();

            const { flags, complete } = writes(fetchMock);
            expect(flags).toEqual({ medication: true, bp: true, weight: false, workout: false, health: false, food: true });
            // W1 order, not tap order.
            expect(complete).toEqual({ picked: ['medication', 'bp', 'food'] });
            expect(document.getElementById('wg-firstrun-overlay')).toBeNull();
            expect(window.__MEDTRACKER_BOOTSTRAP__.needs_first_run).toBe(false);
            expect(window.sessionStorage.getItem('wg-firstrun-step')).toBeNull();
            expect(window.sessionStorage.getItem('wg-firstrun-picked')).toBeNull();
        } finally { cleanup(); }
    });

    // bd med-ta2n.21: Diary's notes live in Vitals, so Diary without Sleep
    // still keeps `health` on; Diary has no flag of its own but is a pick.
    it('Diary picked without Sleep keeps health on', async () => {
        const fetchMock = okFetch();
        const { window, document, cleanup } = loadFlow({ fetchMock });
        try {
            window.WGFirstRun.mount();
            pick(document, 'diary', 'medication');
            action(document, 'continue').click();
            await flush();

            const { flags, complete } = writes(fetchMock);
            expect(flags).toEqual({ medication: true, bp: false, weight: false, workout: false, health: true, food: false });
            expect(complete).toEqual({ picked: ['medication', 'diary'] });
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

    // med-1ikf: picking Medications is the context to ask in — an undecided
    // permission gets the one-tap Allow, which runs the browser's prompt.
    it('Medications picked + permission undecided offers Allow notifications in place', async () => {
        const { window, document, cleanup } = loadFlow({ fetchMock: okFetch(), notifyPermission: 'default' });
        try {
            const ask = vi.fn(async () => { window.Notification.permission = 'denied'; return 'denied'; });
            window.requestNotificationPermissionNormalized = ask;
            window.WGFirstRun.mount();
            pick(document, 'medication');
            await flush();
            const slot = document.querySelector('[data-firstrun-notify-note]');
            const allow = slot.querySelector('[data-notify-allow]');
            expect(allow).not.toBeNull();
            expect(allow.textContent).toBe('Allow notifications');

            allow.click();
            expect(ask).toHaveBeenCalledTimes(1);
            await flush();
            await flush();
            // Denied at the prompt: the note stays, now pointing at the browser settings.
            expect(slot.querySelector('[data-notify-allow]')).toBeNull();
            expect(slot.textContent).toContain('Allow notifications for this site in your browser settings.');
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

// bd med-ta2n.2 — W2, the AI trial offer: shown after W1 only when Food was
// picked AND a trial is on offer (SettingsIntegrations.trialOffer: local =
// the shell's trial status is non-null, cloud = the operator's trial-ai meta);
// otherwise W1 completes the flow. The trial is asked once, here.
describe('firstrun W1 → W2 trial offer gates', () => {
    it('Food picked + a trial on offer: W2 follows W1, with the step bars', async () => {
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
            expect(window.WGFirstRun.state.getStep()).toBe('trial');
            expect(document.getElementById('wg-firstrun-title').textContent).toBe('Log a meal by just saying it');
            expect(document.getElementById('wg-firstrun-steps').hidden).toBe(false);
            expect(document.getElementById('wg-firstrun-brand').hidden).toBe(true);
        } finally { cleanup(); }
    });

    it('Skip picks Food too, so it reaches W2 when a trial is on offer', async () => {
        const localTrial = { status: vi.fn().mockResolvedValue({ on: false }), apply: vi.fn(), enroll: vi.fn() };
        const { window, document, cleanup } = loadFlow({
            fetchMock: okFetch(), localTrial, trialOffer: vi.fn().mockResolvedValue(true),
        });
        try {
            window.WGFirstRun.mount();
            action(document, 'skip-all').click();
            await flush();
            expect(window.WGFirstRun.state.getStep()).toBe('trial');
            expect(action(document, 'trial')).not.toBeNull();
        } finally { cleanup(); }
    });

    it('Food not picked: completes straight from W1 without asking about the trial', async () => {
        const fetchMock = okFetch();
        const trialOffer = vi.fn().mockResolvedValue(true);
        const { window, document, cleanup } = loadFlow({ fetchMock, trialOffer, trialAi: true });
        try {
            window.WGFirstRun.mount();
            pick(document, 'medication', 'diary');
            action(document, 'continue').click();
            await flush();
            expect(trialOffer).not.toHaveBeenCalled();
            expect(writes(fetchMock).complete).toEqual({ picked: ['medication', 'diary'] });
            expect(document.getElementById('wg-firstrun-overlay')).toBeNull();
        } finally { cleanup(); }
    });

    it('Food picked but no trial on offer: completes straight from W1', async () => {
        for (const opts of [
            {},
            { trialOffer: vi.fn().mockResolvedValue(false) },
            { trialOffer: vi.fn().mockRejectedValue(new Error('offline')) },
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

describe('firstrun W2 trial offer screen', () => {
    const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };
    function trialPort(overrides = {}) {
        return {
            status: vi.fn(async () => ({ on: false })),
            apply: vi.fn(async () => false),
            enroll: vi.fn(async () => ({ ok: true })),
            ...overrides,
        };
    }
    // W1 → Continue with Food → W2, the way a user gets there.
    async function toW2(opts = {}) {
        const fetchMock = okFetch();
        const env = loadFlow({ fetchMock, trialOffer: vi.fn().mockResolvedValue(true), ...opts });
        env.window.WGFirstRun.mount();
        pick(env.document, 'food');
        action(env.document, 'continue').click();
        await settle();
        return { ...env, fetchMock };
    }
    const completed = (window) => !window.WGFirstRun.isActive()
        && window.__MEDTRACKER_BOOTSTRAP__.needs_first_run === false;

    it('sells with one Example, a sun "Try it free" and a full-width "Not now" — no key form, no scarcity', async () => {
        const { document, cleanup } = await toW2({ localTrial: trialPort() });
        try {
            const body = document.getElementById('wg-firstrun-overlay-body');
            expect(body.querySelector('.wg-shell__lede').textContent)
                .toBe('Type, say or snap what you ate. The assistant fills in the food and the numbers.');
            const example = body.querySelector('[data-firstrun-example][data-offer-card]');
            expect(example.querySelector('.wg-card__title').textContent).toBe('Example');
            expect(example.querySelector('.wg-code').textContent).toBe('"Two eggs, toast with butter, coffee with milk"');
            expect([...example.querySelectorAll('.wg-row__title')].map((r) => r.textContent))
                .toEqual(['Eggs, boiled · 2', 'Toast with butter · 1 slice', 'Coffee with milk · 250 ml']);
            expect(example.querySelector('.wg-meta').textContent).toBe('Breakfast · 326 kcal · 21 g protein');
            expect(body.querySelector('.wg-shell__fine').textContent)
                .toBe('Free to try. There’s no account, and the daily limits are shown in Settings.');

            const actions = [...body.querySelectorAll('[data-firstrun-action]')].map((b) => b.dataset.firstrunAction);
            expect(actions).toEqual(['trial', 'not-now']);
            const tryBtn = action(document, 'trial');
            expect(tryBtn.textContent).toBe('Try it free');
            expect(tryBtn.classList.contains('wg-btn--primary')).toBe(true);
            const notNow = action(document, 'not-now');
            expect(notNow.textContent).toBe('Not now');
            expect(notNow.classList.contains('wg-btn--block')).toBe(true);
            expect(notNow.classList.contains('wg-btn--ghost')).toBe(false);

            expect(document.getElementById('wg-firstrun-openai-api-key')).toBeNull();
            expect(body.textContent).not.toMatch(/limited|offer ends|countdown|left today|hurry|own keys?/i);
        } finally { cleanup(); }
    });

    it('cloud mode: the fine print does not claim there is no account', async () => {
        const { document, cleanup } = await toW2({ trialAi: true });
        try {
            expect(document.querySelector('.wg-shell__fine').textContent).not.toMatch(/no account/i);
        } finally { cleanup(); }
    });

    it('Not now completes with the picks and writes nothing else', async () => {
        const consent = { request: vi.fn(async () => true) };
        const trial = trialPort();
        const { window, fetchMock, cleanup } = await toW2({ localTrial: trial, trialConsent: consent });
        try {
            action(window.document, 'not-now').click();
            await settle();
            expect(completed(window)).toBe(true);
            expect(writes(fetchMock).complete).toEqual({ picked: ['food'] });
            // Six flag writes + the completion: no consent, no trial record.
            expect(fetchMock).toHaveBeenCalledTimes(FLAGS.length + 1);
            expect(consent.request).not.toHaveBeenCalled();
            expect(trial.apply).not.toHaveBeenCalled();
            expect(trial.enroll).not.toHaveBeenCalled();
        } finally { cleanup(); }
    });

    it('cloud: Try it free opens the ai consent in place and completes on Allow', async () => {
        const consent = { request: vi.fn(async () => true) };
        const { window, fetchMock, cleanup } = await toW2({ trialAi: true, trialConsent: consent });
        try {
            action(window.document, 'trial').click();
            await settle();
            expect(consent.request).toHaveBeenCalledWith('ai');
            expect(completed(window)).toBe(true);
            expect(writes(fetchMock).complete).toEqual({ picked: ['food'] });
        } finally { cleanup(); }
    });

    it('local: Try it free runs the anon consent, applies it, enrolls, and completes', async () => {
        const trial = trialPort();
        const consent = { request: vi.fn(async () => true) };
        const { window, cleanup } = await toW2({ localTrial: trial, trialConsent: consent });
        try {
            action(window.document, 'trial').click();
            await settle();
            expect(consent.request).toHaveBeenCalledWith('anon');
            expect(trial.apply).toHaveBeenCalledTimes(1);
            expect(trial.enroll).toHaveBeenCalledTimes(1);
            expect(completed(window)).toBe(true);
        } finally { cleanup(); }
    });

    it('local: when applying reloads, the resumed W2 sees the trial on and finishes the grant', async () => {
        const trial = trialPort({ apply: vi.fn(async () => true) });
        const first = await toW2({ localTrial: trial, trialConsent: { request: async () => true } });
        try {
            action(first.document, 'trial').click();
            await settle();
            expect(trial.enroll).not.toHaveBeenCalled(); // the reload's job
            expect(first.window.WGFirstRun.state.getStep()).toBe('trial');
        } finally { first.cleanup(); }

        const resumed = loadFlow({ fetchMock: okFetch(), localTrial: trialPort({ status: async () => ({ on: true }) }) });
        try {
            resumed.window.sessionStorage.setItem('wg-firstrun-step', 'trial');
            resumed.window.WGFirstRun.mount();
            await settle();
            expect(completed(resumed.window)).toBe(true);
        } finally { resumed.cleanup(); }
    });

    it('declining the consent says the trial stays off; Not now still completes', async () => {
        const trial = trialPort();
        const { window, cleanup } = await toW2({ localTrial: trial, trialConsent: { request: vi.fn(async () => false) } });
        try {
            const tryBtn = action(window.document, 'trial');
            tryBtn.click();
            await settle();
            expect(trial.apply).not.toHaveBeenCalled();
            expect(window.document.querySelector('[data-firstrun-form-error="trial"]').textContent).toMatch(/stays off/);
            expect(tryBtn.disabled).toBe(false);
            expect(window.WGFirstRun.state.getStep()).toBe('trial');
            action(window.document, 'not-now').click();
            await settle();
            expect(completed(window)).toBe(true);
        } finally { cleanup(); }
    });

    it.each([
        ['trial_already_used', /already used on this iPhone/],
        ['trial_not_configured', /not available right now/],
        ['network', /Check your connection/],
    ])('a failed grant (%s) says why, offers a retry, and Not now still completes', async (code, copy) => {
        const { window, cleanup } = await toW2({
            localTrial: trialPort({ enroll: vi.fn(async () => ({ ok: false, code })) }),
            trialConsent: { request: async () => true },
        });
        try {
            const tryBtn = action(window.document, 'trial');
            tryBtn.click();
            await settle();
            expect(window.document.querySelector('[data-firstrun-form-error="trial"]').textContent).toMatch(copy);
            expect(tryBtn.disabled).toBe(false);
            expect(tryBtn.textContent).toBe('Try again');
            action(window.document, 'not-now').click();
            await settle();
            expect(completed(window)).toBe(true);
        } finally { cleanup(); }
    });

    // A session stored before the rename (step 'integrations') resumes on W2.
    it('a stale "integrations" step resumes on W2', () => {
        const { window, document, cleanup } = loadFlow({ fetchMock: okFetch(), trialAi: true });
        try {
            window.sessionStorage.setItem('wg-firstrun-step', 'integrations');
            window.WGFirstRun.mount();
            expect(window.WGFirstRun.state.getStep()).toBe('trial');
            expect(document.getElementById('wg-firstrun-title').textContent).toBe('Log a meal by just saying it');
            expect(action(document, 'trial')).not.toBeNull();
        } finally { cleanup(); }
    });
});

// F1 entry (W1 footer, opposite Skip): only in a v3 shell (it lists
// invite.pending), in local mode, with no invite already waiting.
describe('firstrun W1 "Have an invite?" footer', () => {
    // A fake of the native foundation (native/index.js): has(op) answers from the
    // shell's shell.ops list (Android LocalOrigin.ops / MainActivity.kt, iOS
    // LocalOrigin.swift / Shell.swift); call('invite.pending') follows the
    // med-ta2n.7 bridge contract: {url, receivedAt} for a waiting invite, else null.
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

// W1 footnote (bd med-ta2n.28, contract med-ta2n.24 §D): the disclaimer and
// links the deleted native first-run screens carried.
describe('firstrun W1 footnote', () => {
    const DISCLAIMER = 'Med Tracker is a personal log, not a medical device, and does not give medical advice. Talk to your doctor before changing a treatment.';
    const link = (document, name) => document.querySelector(`[data-firstrun-link="${name}"]`);
    function shell(ops) {
        return { platform: 'ios', has: vi.fn(async (op) => ops.includes(op)), call: vi.fn(async () => null) };
    }

    it('shows the disclaimer and Privacy policy below the foot, after Continue/Skip in tab order', async () => {
        const { window, document, cleanup } = loadFlow({ fetchMock: okFetch(), invite: true });
        try {
            window.WGFirstRun.mount();
            await flush();
            const fine = document.querySelector('#wg-firstrun-overlay-body .wg-shell__fine');
            expect(fine.textContent).toBe(DISCLAIMER);
            expect(fine.previousElementSibling.classList.contains('wg-firstrun-foot')).toBe(true);
            const privacy = link(document, 'privacy');
            expect(privacy.textContent).toBe('Privacy policy');
            expect(privacy.getAttribute('href'))
                .toBe('https://github.com/korjavin/medicationtrackerbot/blob/master/docs/privacy-policy.md');
            expect(privacy.target).toBe('_blank');
            expect(privacy.rel).toBe('noopener');
            expect(privacy.classList.contains('wg-link')).toBe(true);
            expect(action(document, 'skip-all').compareDocumentPosition(privacy) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        } finally { cleanup(); }
    });

    it('has no "How to get an invite" on the web or in account mode', async () => {
        for (const opts of [
            { local: false, invite: true, base: 'qa.example.test' }, // the web / account mode, no shell
            { local: false, invite: true, base: 'qa.example.test', native: shell(['base.post']) }, // account mode in a shell
            { local: true, invite: true }, // local, no shell, no base
            { local: true, native: shell(['base.post']), base: 'qa.example.test' }, // invite.js absent
        ]) {
            const { window, document, cleanup } = loadFlow({ fetchMock: okFetch(), ...opts });
            try {
                window.WGFirstRun.mount();
                await flush();
                await flush();
                expect(link(document, 'invite-howto')).toBeNull();
                expect(link(document, 'privacy')).not.toBeNull();
                expect(document.getElementById('wg-firstrun-overlay').textContent).not.toContain('How to get an invite');
            } finally { cleanup(); }
        }
    });

    it('local shell with base.post: "How to get an invite" opens the W5 request sheet', async () => {
        const native = shell(['base.post']);
        const { window, document, cleanup } = loadFlow({ fetchMock: okFetch(), local: true, invite: true, native, base: 'qa.example.test' });
        try {
            const request = vi.spyOn(window.InviteSheet, 'request').mockImplementation(() => {});
            window.WGFirstRun.mount();
            await flush();
            await flush();
            const how = link(document, 'invite-howto');
            expect(how.textContent).toBe('How to get an invite');
            expect(how.tagName).toBe('BUTTON');
            expect(how.classList.contains('wg-link')).toBe(true);
            expect(how.parentElement).toBe(link(document, 'privacy').parentElement);
            expect(native.has).toHaveBeenCalledWith('base.post');
            how.click();
            expect(request).toHaveBeenCalledTimes(1);
        } finally { cleanup(); }
    });

    it('local shell without base.post but with a base: links the landing page', async () => {
        const { window, document, cleanup } = loadFlow({
            fetchMock: okFetch(), local: true, invite: true, native: shell([]), base: 'qa.example.test',
        });
        try {
            window.WGFirstRun.mount();
            await flush();
            await flush();
            const how = link(document, 'invite-howto');
            expect(how.tagName).toBe('A');
            expect(how.getAttribute('href')).toBe('https://qa.example.test/');
            expect(how.target).toBe('_blank');
            expect(how.rel).toBe('noopener');
        } finally { cleanup(); }
    });
});
