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
const INTEGRATIONS_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/screens/integrations.js');
const DONE_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/screens/done.js');
const INDEX_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/index.js');

// features/firstrun/screens/integrations.js — Task 6. Third screen in
// the first-run overlay: compact OpenAI key form with pre-filled URL
// + model defaults. Save PATCHes /api/settings/integrations and
// advances to "done"; Skip advances without touching the endpoint.
// A failed PATCH surfaces an inline error and keeps the user on the
// integrations step so they can retry or skip.

const SHELL_HTML = `<!doctype html><html><body></body></html>`;

function loadFlow({
    bootstrap = null,
    fetchMock = null,
    initialStep = 'integrations',
    settingsHelper = null,
    cloud = false,
    trialAi = false,
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

    for (const file of [STATE_JS, WELCOME_JS, INTEGRATIONS_JS, DONE_JS, INDEX_JS]) {
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
            expect(model.value).toBe('gpt-4o-mini');

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

        // Bot mode has no trial path at all, even if a stray meta tag exists.
        const bot = loadFlow({ bootstrap: { needs_first_run: true }, trialAi: true });
        try {
            bot.window.WGFirstRun.mount();
            expect(bot.document.querySelector('.wg-firstrun-screen__tagline').textContent).not.toMatch(/trial/i);
        } finally { bot.cleanup(); }
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
                    model: 'gpt-4o-mini',
                },
            });
        } finally { cleanup(); }
    });

    it('Save success advances to the done step', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            fetchMock,
        });
        try {
            window.WGFirstRun.mount();
            document.getElementById('wg-firstrun-openai-api-key').value = 'sk-ok';
            document.querySelector('[data-firstrun-action="save"]').click();
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(window.WGFirstRun.state.getStep()).toBe('done');
            // The done screen has rendered, so the "Open app" button is
            // present and the form fields are gone.
            expect(document.querySelector('[data-firstrun-action="open-app"]')).not.toBeNull();
            expect(document.getElementById('wg-firstrun-openai-api-key')).toBeNull();
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

    it('Skip advances to done without calling PATCH', () => {
        const fetchMock = vi.fn();
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            fetchMock,
        });
        try {
            window.WGFirstRun.mount();
            document.querySelector('[data-firstrun-action="skip"]').click();
            expect(window.WGFirstRun.state.getStep()).toBe('done');
            expect(fetchMock).not.toHaveBeenCalled();
            expect(document.querySelector('[data-firstrun-action="open-app"]')).not.toBeNull();
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
        const fetchMock = vi.fn();
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
                    model: 'gpt-4o-mini',
                },
            });
            expect(fetchMock).not.toHaveBeenCalled();
            expect(window.WGFirstRun.state.getStep()).toBe('done');
        } finally { cleanup(); }
    });
});
