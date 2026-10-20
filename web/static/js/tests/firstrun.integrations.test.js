import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { allowConsoleNoise } from './helpers/setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const STATE_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/state.js');
const INTEGRATIONS_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/screens/integrations.js');
const INDEX_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/index.js');

// features/firstrun/screens/integrations.js — Task 6. The step after the W1
// picker (bd med-ta2n.1): compact OpenAI key form with pre-filled URL
// + model defaults. Save PATCHes /api/settings/integrations and
// finishes the flow; Skip finishes without touching the endpoint.
// A failed PATCH surfaces an inline error and keeps the user on the
// integrations step so they can retry or skip.

const SHELL_HTML = `<!doctype html><html><body></body></html>`;

// There is no done screen (bd med-ta2n.1): leaving this step completes the
// flow — POST /api/firstrun/complete, overlay gone, bootstrap flag flipped.
function completed(window) {
    return !window.WGFirstRun.isActive() && window.__MEDTRACKER_BOOTSTRAP__.needs_first_run === false;
}

// Every fetch except the completion POST (the key PATCHes).
const patches = (fetchMock) => fetchMock.mock.calls.filter(([url]) => url !== '/api/firstrun/complete');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function loadFlow({
    bootstrap = null,
    fetchMock = null,
    initialStep = 'integrations',
    settingsHelper = null,
    cloud = false,
    trialAi = false,
    localTrial = null,
    trialConsent = null,
    wizardChoice = null,
    apiCall = null,
} = {}) {
    const dom = new JSDOM(SHELL_HTML, {
        url: 'https://example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    if (cloud) window.__MEDTRACKER_CLOUD__ = true;
    if (trialAi) {
        // Same carrier cmd/cloud injects (internal/cloudserver/router.go) and
        // that Settings → Integrations reads in applyTrialHints.
        const meta = window.document.createElement('meta');
        meta.name = 'medtracker-trial-ai';
        meta.content = '1';
        window.document.head.appendChild(meta);
    }
    if (bootstrap) window.__MEDTRACKER_BOOTSTRAP__ = bootstrap;
    if (fetchMock) window.fetch = fetchMock;
    if (initialStep) window.sessionStorage.setItem('wg-firstrun-step', initialStep);
    if (settingsHelper) window.SettingsIntegrations = settingsHelper;
    // iOS device-only mode: local-policy.js LOCAL_VAULT.trial and
    // trial-consent.js's window.TrialConsent (cloud.local-mode.test.js runs
    // the real ones end to end).
    if (localTrial) window.CloudVault = { trial: localTrial };
    if (trialConsent) window.TrialConsent = trialConsent;
    // bd med-w6sx: the claim wizard's trial step (web/cloud/js/signup.js).
    if (wizardChoice) window.localStorage.setItem('wg-onboarding-trial-choice', wizardChoice);
    if (apiCall) window.apiCall = apiCall;

    for (const file of [STATE_JS, INTEGRATIONS_JS, INDEX_JS]) {
        const src = fs.readFileSync(file, 'utf8');
        window.eval(`${src}\n//# sourceURL=file://${file}`);
    }

    return { window, document: window.document, cleanup: () => dom.window.close() };
}

describe('firstrun integrations screen', () => {
    it('renders the OpenAI form with pre-filled URL + model defaults', () => {
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
        });
        try {
            window.WGFirstRun.mount();

            const title = document.getElementById('wg-firstrun-title');
            expect(title.textContent.toLowerCase()).toContain('openai');

            const apiKey = document.getElementById('wg-firstrun-openai-api-key');
            const url = document.getElementById('wg-firstrun-openai-url');
            const model = document.getElementById('wg-firstrun-openai-model');
            expect(apiKey).not.toBeNull();
            expect(apiKey.type).toBe('password');
            expect(apiKey.value).toBe('');
            expect(url).not.toBeNull();
            expect(url.value).toBe('https://api.openai.com/v1');
            expect(model).not.toBeNull();
            expect(model.value).toBe('gpt-6-luna');

            expect(document.querySelector('[data-firstrun-action="save"]')).not.toBeNull();
            expect(document.querySelector('[data-firstrun-action="skip"]')).not.toBeNull();
        } finally { cleanup(); }
    });

    // med-awx: a user who skips this screen must know AI still works — but only
    // when the operator actually provisioned TRIAL_OPENAI_API_KEY. The copy
    // keys off the same <meta name="medtracker-trial-ai"> tag aiclient.js reads,
    // so the wizard can never promise a trial the backend won't honour.
    it('promises the rate-limited trial only when the operator injected the trial-ai meta tag', () => {
        const withTrial = loadFlow({ bootstrap: { needs_first_run: true }, cloud: true, trialAi: true });
        try {
            withTrial.window.WGFirstRun.mount();
            // The trial leads (med-oc8h); "Use my own keys" is this form.
            withTrial.document.querySelector('[data-firstrun-action="own-keys"]').click();
            const tagline = withTrial.document.querySelector('.wg-firstrun-screen__tagline').textContent;
            expect(tagline).toMatch(/already work/i);
            expect(tagline).toMatch(/rate-limited/i);
            expect(withTrial.document.querySelector('[data-firstrun-action="skip"]').textContent)
                .toMatch(/trial key/i);
        } finally { withTrial.cleanup(); }

        // Cloud, but the operator set no trial key: never claim AI works out of the box.
        const noTrial = loadFlow({ bootstrap: { needs_first_run: true }, cloud: true });
        try {
            noTrial.window.WGFirstRun.mount();
            const tagline = noTrial.document.querySelector('.wg-firstrun-screen__tagline').textContent;
            expect(tagline).not.toMatch(/trial/i);
            expect(tagline).toMatch(/Add your OpenAI API key/i);
            expect(noTrial.document.querySelector('[data-firstrun-action="skip"]').textContent).toBe('Skip');
        } finally { noTrial.cleanup(); }

    });

    it('Save submits PATCH /api/settings/integrations with the entered key + URL + model', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true, status: 200,
            json: async () => ({ openai: { api_key: '***', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' } }),
        });
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            fetchMock,
        });
        try {
            window.WGFirstRun.mount();

            const apiKey = document.getElementById('wg-firstrun-openai-api-key');
            apiKey.value = 'sk-test-1234';

            document.querySelector('[data-firstrun-action="save"]').click();
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, opts] = fetchMock.mock.calls[0];
            expect(url).toBe('/api/settings/integrations');
            expect(opts.method).toBe('PATCH');
            const body = JSON.parse(opts.body);
            expect(body).toEqual({
                openai: {
                    api_key: 'sk-test-1234',
                    url: 'https://api.openai.com/v1',
                    model: 'gpt-6-luna',
                },
            });
        } finally { cleanup(); }
    });

    it('Save success finishes the flow', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            fetchMock,
        });
        try {
            window.WGFirstRun.mount();
            document.getElementById('wg-firstrun-openai-api-key').value = 'sk-ok';
            document.querySelector('[data-firstrun-action="save"]').click();
            await flush();
            await flush();

            expect(completed(window)).toBe(true);
            expect(fetchMock.mock.calls.map(([url]) => url))
                .toEqual(['/api/settings/integrations', '/api/firstrun/complete']);
            expect(document.getElementById('wg-firstrun-overlay')).toBeNull();
        } finally { cleanup(); }
    });

    it('Save failure surfaces an inline error and keeps the user on the integrations step', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            fetchMock,
        });
        try {
            window.WGFirstRun.mount();
            document.getElementById('wg-firstrun-openai-api-key').value = 'sk-bad';
            const save = document.querySelector('[data-firstrun-action="save"]');
            save.click();
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(window.WGFirstRun.state.getStep()).toBe('integrations');
            const err = document.querySelector('[data-firstrun-form-error="integrations"]');
            expect(err).not.toBeNull();
            expect(err.textContent.toLowerCase()).toContain('couldn');
            // The Save button is re-enabled so a retry without leaving
            // the screen is one tap away.
            expect(save.disabled).toBe(false);
        } finally { cleanup(); }
    });

    it('Save failure when fetch rejects (offline) also keeps the user on the step', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            fetchMock,
        });
        try {
            window.WGFirstRun.mount();
            document.getElementById('wg-firstrun-openai-api-key').value = 'sk-bad';
            document.querySelector('[data-firstrun-action="save"]').click();
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(window.WGFirstRun.state.getStep()).toBe('integrations');
            const err = document.querySelector('[data-firstrun-form-error="integrations"]');
            expect(err.textContent.toLowerCase()).toContain('couldn');
        } finally { cleanup(); }
    });

    it('Skip finishes the flow without calling PATCH', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            fetchMock,
        });
        try {
            window.WGFirstRun.mount();
            document.querySelector('[data-firstrun-action="skip"]').click();
            await flush();
            expect(completed(window)).toBe(true);
            expect(patches(fetchMock)).toEqual([]);
        } finally { cleanup(); }
    });

    it('keeps the user on the integrations step when the helper resolves to null (apiCall swallowed an HTTP failure)', async () => {
        // The shared SettingsIntegrations.patch wraps apiCall, which catches
        // non-aborted errors, surfaces a safeAlert and resolves to null
        // instead of throwing. Without the null-check the screen would
        // advance to done() with an unsaved key — assert the soft-failure
        // path fires instead.
        const helperPatch = vi.fn().mockResolvedValue(null);
        const fetchMock = vi.fn();
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            fetchMock,
            settingsHelper: { patch: helperPatch },
        });
        try {
            window.WGFirstRun.mount();
            document.getElementById('wg-firstrun-openai-api-key').value = 'sk-null';
            const save = document.querySelector('[data-firstrun-action="save"]');
            save.click();
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(helperPatch).toHaveBeenCalledTimes(1);
            expect(window.WGFirstRun.state.getStep()).toBe('integrations');
            const err = document.querySelector('[data-firstrun-form-error="integrations"]');
            expect(err).not.toBeNull();
            expect(err.textContent.toLowerCase()).toContain('couldn');
            expect(save.disabled).toBe(false);
        } finally { cleanup(); }
    });

    it('routes through window.SettingsIntegrations.patch when the shared helper is present', async () => {
        // Production load order has settings/integrations.js loading
        // before bootstrap-loaded fires, so the firstrun screen prefers
        // the shared apiCall-backed helper. window.fetch must never be
        // touched when the helper is available.
        const helperPatch = vi.fn().mockResolvedValue({ openai: { api_key: '***' } });
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            fetchMock,
            settingsHelper: { patch: helperPatch },
        });
        try {
            window.WGFirstRun.mount();
            document.getElementById('wg-firstrun-openai-api-key').value = 'sk-via-helper';
            document.querySelector('[data-firstrun-action="save"]').click();
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(helperPatch).toHaveBeenCalledTimes(1);
            expect(helperPatch.mock.calls[0][0]).toEqual({
                openai: {
                    api_key: 'sk-via-helper',
                    url: 'https://api.openai.com/v1',
                    model: 'gpt-6-luna',
                },
            });
            await flush();
            expect(patches(fetchMock)).toEqual([]);
            expect(completed(window)).toBe(true);
        } finally { cleanup(); }
    });
});

// bd med-o7zq.29 — iOS device-only mode leads with the anonymous free trial;
// "Use my own keys" is the key form above. A refusal or a failed grant never
// traps the user.
describe('firstrun integrations screen in device-only mode', () => {
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
    function trialPort(overrides = {}) {
        return {
            status: vi.fn(async () => ({ on: false })),
            apply: vi.fn(async () => false),
            enroll: vi.fn(async () => ({ ok: true })),
            ...overrides,
        };
    }

    it('offers the free trial first, own keys second, and says where to switch later', async () => {
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true }, localTrial: trialPort(),
        });
        try {
            window.WGFirstRun.mount();
            await settle();
            expect(document.getElementById('wg-firstrun-title').textContent).toBe('AI and food database');
            expect(document.querySelector('.wg-firstrun-screen__tagline').textContent)
                .toMatch(/without your own keys/);
            const actions = [...document.querySelectorAll('[data-firstrun-action]')].map((b) => b.dataset.firstrunAction);
            expect(actions).toEqual(['trial', 'own-keys', 'skip']);
            expect(document.querySelector('[data-firstrun-action="trial"]').className).toContain('wg-btn--primary');
            expect(document.body.textContent).toContain('Settings → AI & integrations');
            expect(document.getElementById('wg-firstrun-openai-api-key')).toBeNull();
        } finally { cleanup(); }
    });

    it('the trial tap runs the anon consent, applies it, enrolls, and finishes', async () => {
        const trial = trialPort();
        const consent = { request: vi.fn(async () => true) };
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true }, localTrial: trial, trialConsent: consent,
        });
        try {
            window.WGFirstRun.mount();
            await settle();
            document.querySelector('[data-firstrun-action="trial"]').click();
            await settle();
            expect(consent.request).toHaveBeenCalledWith('anon');
            expect(trial.apply).toHaveBeenCalledTimes(1);
            expect(trial.enroll).toHaveBeenCalledTimes(1);
            expect(completed(window)).toBe(true);
        } finally { cleanup(); }
    });

    it('when applying reloads the page, the resumed step sees the trial on and finishes the grant', async () => {
        const trial = trialPort({ apply: vi.fn(async () => true) });
        const first = loadFlow({
            bootstrap: { needs_first_run: true }, localTrial: trial, trialConsent: { request: async () => true },
        });
        try {
            first.window.WGFirstRun.mount();
            await settle();
            first.document.querySelector('[data-firstrun-action="trial"]').click();
            await settle();
            expect(trial.enroll).not.toHaveBeenCalled(); // the reload's job
            expect(first.window.WGFirstRun.state.getStep()).toBe('integrations');
        } finally { first.cleanup(); }

        const resumed = loadFlow({
            bootstrap: { needs_first_run: true }, localTrial: trialPort({ status: async () => ({ on: true }) }),
        });
        try {
            resumed.window.WGFirstRun.mount();
            await settle();
            expect(completed(resumed.window)).toBe(true);
        } finally { resumed.cleanup(); }
    });

    it('declining the consent says the trial stays off and leaves own keys and skip working', async () => {
        const trial = trialPort();
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true }, localTrial: trial, fetchMock,
            trialConsent: { request: vi.fn(async () => false) },
        });
        try {
            window.WGFirstRun.mount();
            await settle();
            document.querySelector('[data-firstrun-action="trial"]').click();
            await settle();
            expect(trial.apply).not.toHaveBeenCalled();
            expect(document.querySelector('[data-firstrun-form-error="trial"]').textContent).toMatch(/stays off/);
            expect(window.WGFirstRun.state.getStep()).toBe('integrations');

            // BYO: the key form, saving as before.
            const keys = document.querySelector('[data-firstrun-action="own-keys"]');
            expect(keys.disabled).toBe(false);
            keys.click();
            document.getElementById('wg-firstrun-openai-api-key').value = 'sk-mine';
            document.querySelector('[data-firstrun-action="save"]').click();
            await settle();
            expect(JSON.parse(fetchMock.mock.calls[0][1].body).openai.api_key).toBe('sk-mine');
            expect(completed(window)).toBe(true);
        } finally { cleanup(); }
    });

    it.each([
        ['trial_already_used', /already used on this iPhone/],
        ['trial_not_configured', /not available right now/],
        ['network', /Check your connection/],
    ])('a failed grant (%s) says why and the user can still skip', async (code, copy) => {
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            localTrial: trialPort({ enroll: vi.fn(async () => ({ ok: false, code })) }),
            trialConsent: { request: async () => true },
        });
        try {
            window.WGFirstRun.mount();
            await settle();
            const tryBtn = document.querySelector('[data-firstrun-action="trial"]');
            tryBtn.click();
            await settle();
            expect(document.querySelector('[data-firstrun-form-error="trial"]').textContent).toMatch(copy);
            expect(tryBtn.disabled).toBe(false);
            expect(tryBtn.textContent).toBe('Try again');
            expect(window.WGFirstRun.state.getStep()).toBe('integrations');
            document.querySelector('[data-firstrun-action="skip"]').click();
            await settle();
            expect(completed(window)).toBe(true);
        } finally { cleanup(); }
    });

    it('without App Attest (status null, the Simulator) shows the key form', async () => {
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true }, localTrial: trialPort({ status: async () => null }),
        });
        try {
            window.WGFirstRun.mount();
            await settle();
            expect(document.getElementById('wg-firstrun-openai-api-key')).not.toBeNull();
            expect(document.querySelector('[data-firstrun-action="trial"]')).toBeNull();
        } finally { cleanup(); }
    });
});

// bd med-oc8h — cloud mode with an operator trial key leads with the trial too.
// The cloud trial has no switch; its opt-in is the `ai` TrialConsent scope,
// the same grant as Settings → AI & integrations' "Allow" on the trial AI row.
describe('firstrun integrations screen in cloud mode with an operator trial', () => {
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

    it('offers the free trial first, own keys second, and says where to switch later', async () => {
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true }, cloud: true, trialAi: true,
        });
        try {
            window.WGFirstRun.mount();
            await settle();
            expect(document.getElementById('wg-firstrun-title').textContent).toBe('AI features');
            expect(document.querySelector('.wg-firstrun-screen__tagline').textContent)
                .toMatch(/without your own key.*rate-limited/);
            const actions = [...document.querySelectorAll('[data-firstrun-action]')].map((b) => b.dataset.firstrunAction);
            expect(actions).toEqual(['trial', 'own-keys', 'skip']);
            expect(document.querySelector('[data-firstrun-action="trial"]').className).toContain('wg-btn--primary');
            expect(document.body.textContent).toContain('You can switch any time in Settings → AI & integrations.');
            expect(document.getElementById('wg-firstrun-openai-api-key')).toBeNull();
            // No reload resume in cloud: the step stays put until the user picks.
            expect(window.WGFirstRun.state.getStep()).toBe('integrations');
        } finally { cleanup(); }
    });

    it('the trial tap asks the ai consent and finishes on Allow', async () => {
        const consent = { request: vi.fn(async () => true) };
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true }, cloud: true, trialAi: true, trialConsent: consent, fetchMock,
        });
        try {
            window.WGFirstRun.mount();
            await settle();
            document.querySelector('[data-firstrun-action="trial"]').click();
            await settle();
            expect(consent.request).toHaveBeenCalledWith('ai');
            expect(patches(fetchMock)).toEqual([]); // no key PATCH
            expect(completed(window)).toBe(true);
        } finally { cleanup(); }
    });

    it('declining says the trial stays off and leaves own keys and skip working', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true }, cloud: true, trialAi: true, fetchMock,
            trialConsent: { request: vi.fn(async () => false) },
        });
        try {
            window.WGFirstRun.mount();
            await settle();
            const tryBtn = document.querySelector('[data-firstrun-action="trial"]');
            tryBtn.click();
            await settle();
            expect(document.querySelector('[data-firstrun-form-error="trial"]').textContent).toMatch(/stays off/);
            expect(tryBtn.disabled).toBe(false);
            expect(window.WGFirstRun.state.getStep()).toBe('integrations');

            document.querySelector('[data-firstrun-action="own-keys"]').click();
            document.getElementById('wg-firstrun-openai-api-key').value = 'sk-mine';
            document.querySelector('[data-firstrun-action="save"]').click();
            await settle();
            expect(JSON.parse(fetchMock.mock.calls[0][1].body).openai.api_key).toBe('sk-mine');
            expect(completed(window)).toBe(true);
        } finally { cleanup(); }
    });

    it('a consent dialog that throws says so and skip still works', async () => {
        allowConsoleNoise(); // the screen logs the failure
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true }, cloud: true, trialAi: true,
            trialConsent: { request: vi.fn(async () => { throw new Error('boom'); }) },
        });
        try {
            window.WGFirstRun.mount();
            await settle();
            document.querySelector('[data-firstrun-action="trial"]').click();
            await settle();
            expect(document.querySelector('[data-firstrun-form-error="trial"]').textContent).toMatch(/Couldn’t start/);
            document.querySelector('[data-firstrun-action="skip"]').click();
            await settle();
            expect(completed(window)).toBe(true);
        } finally { cleanup(); }
    });

    // bd med-w6sx: the claim wizard asked trial-or-keys next to Telegram; the
    // consent itself is vault data, so it completes here, on the app's first open.
    it('a legacy wizard "trial" (pre-med-nt9p.40 shell, no disclosure shown) asks the ai consent as soon as the overlay mounts, once', async () => {
        const consent = { request: vi.fn(async () => true) };
        const { window, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true }, cloud: true, trialAi: true, trialConsent: consent,
            wizardChoice: 'trial', initialStep: 'features',
        });
        try {
            window.WGFirstRun.mount();
            await settle();
            expect(consent.request).toHaveBeenCalledTimes(1);
            expect(consent.request).toHaveBeenCalledWith('ai');
            expect(window.localStorage.getItem('wg-onboarding-trial-choice')).toBe('trial-asked');
            window.WGFirstRun.dismiss();
            window.WGFirstRun.mount();
            await settle();
            expect(consent.request).toHaveBeenCalledTimes(1);
        } finally { cleanup(); }
    });

    // bd med-nt9p.40: the wizard now shows the `ai` disclosure word for word and
    // stores 'trial-allowed' on Allow — that answer is the consent, so the app
    // records it and asks nothing (owner: "answered for trial twice").
    it('a wizard "Allow the free trial" is recorded on first open with no second question', async () => {
        let granted = false;
        const consent = {
            request: vi.fn(async () => true),
            grant: vi.fn(async (scope) => { granted = scope === 'ai'; return true; }),
        };
        const apiCall = vi.fn(async (url, method) => (url === '/api/settings/trial-consent' && method === 'GET'
            ? { ai: granted ? true : null, voice: null, tg: null, anon: null, updated_at: 1 } : null));
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true }, cloud: true, trialAi: true, trialConsent: consent, apiCall,
            wizardChoice: 'trial-allowed', initialStep: 'features',
        });
        try {
            window.WGFirstRun.mount();
            await settle();
            expect(consent.grant).toHaveBeenCalledTimes(1);
            expect(consent.grant).toHaveBeenCalledWith('ai');
            expect(consent.request).not.toHaveBeenCalled();
            expect(window.localStorage.getItem('wg-onboarding-trial-choice')).toBe('trial-asked');

            // Walking on to the AI step: no trial choice there either — the
            // granted consent finishes the flow (resumed there, as a
            // reload mid-flow would).
            window.WGFirstRun.dismiss();
            window.WGFirstRun.state.setStep('integrations');
            window.WGFirstRun.mount();
            await settle();
            expect(document.querySelector('[data-firstrun-action="trial"]')).toBeNull();
            expect(completed(window)).toBe(true);
            expect(consent.grant).toHaveBeenCalledTimes(1);
            expect(consent.request).not.toHaveBeenCalled();
        } finally { cleanup(); }
    });

    it('a wizard Allow whose grant cannot be stored falls back to the dialog — never on unconsented', async () => {
        const consent = { request: vi.fn(async () => false), grant: vi.fn(async () => null) };
        const { window, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true }, cloud: true, trialAi: true, trialConsent: consent,
            wizardChoice: 'trial-allowed', initialStep: 'features',
        });
        try {
            window.WGFirstRun.mount();
            await settle();
            expect(consent.grant).toHaveBeenCalledWith('ai');
            expect(consent.request).toHaveBeenCalledTimes(1);
            expect(consent.request).toHaveBeenCalledWith('ai');
        } finally { cleanup(); }
    });

    it('a wizard Allow defers to a refusal the vault already holds — no grant, no question', async () => {
        const consent = { request: vi.fn(async () => true), grant: vi.fn(async () => false) };
        const { window, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true }, cloud: true, trialAi: true, trialConsent: consent,
            wizardChoice: 'trial-allowed', initialStep: 'features',
        });
        try {
            window.WGFirstRun.mount();
            await settle();
            expect(consent.grant).toHaveBeenCalledTimes(1);
            expect(consent.request).not.toHaveBeenCalled();
            expect(window.localStorage.getItem('wg-onboarding-trial-choice')).toBe('trial-asked');
        } finally { cleanup(); }
    });

    it('a wizard Allow is not recorded where the operator has no trial key', async () => {
        const consent = { request: vi.fn(async () => true), grant: vi.fn(async () => true) };
        const { window, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true }, cloud: true, trialConsent: consent,
            wizardChoice: 'trial-allowed', initialStep: 'features',
        });
        try {
            window.WGFirstRun.mount();
            await settle();
            expect(consent.grant).not.toHaveBeenCalled();
            expect(consent.request).not.toHaveBeenCalled();
        } finally { cleanup(); }
    });

    for (const choice of ['own-keys', 'skip', 'trial-asked']) {
        it(`a wizard "${choice}" pops nothing up and the step opens on the key form`, async () => {
            const consent = { request: vi.fn(async () => true), grant: vi.fn(async () => true) };
            const { window, document, cleanup } = loadFlow({
                bootstrap: { needs_first_run: true }, cloud: true, trialAi: true, trialConsent: consent,
                wizardChoice: choice,
            });
            try {
                window.WGFirstRun.mount();
                await settle();
                expect(consent.request).not.toHaveBeenCalled();
                expect(consent.grant).not.toHaveBeenCalled();
                expect(document.querySelector('[data-firstrun-action="trial"]')).toBeNull();
                expect(document.getElementById('wg-firstrun-openai-api-key')).not.toBeNull();
            } finally { cleanup(); }
        });
    }

    it('skips the step once the ai consent is granted (here or on another device)', async () => {
        const apiCall = vi.fn(async (url, method) => (url === '/api/settings/trial-consent' && method === 'GET'
            ? { ai: true, voice: null, tg: null, anon: null, updated_at: 1 } : null));
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true }, cloud: true, trialAi: true, apiCall,
        });
        try {
            window.WGFirstRun.mount();
            await settle();
            expect(completed(window)).toBe(true);
            expect(document.querySelector('[data-firstrun-action="trial"]')).toBeNull();
        } finally { cleanup(); }
    });

    it('keeps the trial choice while the consent is still open', async () => {
        const apiCall = vi.fn(async () => ({ ai: null, voice: null, tg: null, anon: null, updated_at: 0 }));
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true }, cloud: true, trialAi: true, apiCall,
        });
        try {
            window.WGFirstRun.mount();
            await settle();
            expect(window.WGFirstRun.state.getStep()).toBe('integrations');
            expect(document.querySelector('[data-firstrun-action="trial"]')).not.toBeNull();
        } finally { cleanup(); }
    });
});
