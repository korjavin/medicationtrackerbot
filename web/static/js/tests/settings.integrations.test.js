// Settings → Integrations section (Task 3 of the local-only mode
// foundation plan). Pin the contract:
//
//   - the section renders with one input per OpenAI/Food/ElevenLabs field
//   - load() populates the inputs from GET /api/settings/integrations
//   - save() routes through DataStore.applyOptimistic and PATCHes the
//     same shape; "***" survives the round-trip as a secret-preservation
//     sentinel
//   - on save failure, applyOptimistic.rollback restores the prior cache
//     row instead of leaving the optimistic mutation in place

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { createSettingsDomain } from '../../../domain/settings.js';
import { createAIClient } from '../../../cloud/js/aiclient.js';

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

describe('Settings → Integrations section', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
        installApiCacheMap(env.window);
        env.window.SettingsIntegrations._setTelegramLoader(vi.fn(() => Promise.resolve({ mountTelegram: vi.fn() })));
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renders the Integrations card with one input per provider field', () => {
        const { document } = env;
        const card = document.getElementById('settings-integrations');
        expect(card).not.toBeNull();
        expect(card.closest('[data-settings-page="integrations"]')).not.toBeNull();

        const expectedInputs = [
            'integrations-openai-api-key',
            'integrations-openai-url',
            'integrations-openai-model',
            'integrations-openai-vision-api-key',
            'integrations-openai-vision-url',
            'integrations-openai-vision-model',
            'integrations-elevenlabs-api-key',
            'integrations-elevenlabs-agent-id'
        ];

        for (const id of expectedInputs) {
            const input = document.getElementById(id);
            expect(input, `missing input #${id}`).not.toBeNull();
        }

        // med-bpp9: the custom food-DB server section is gone, link included.
        expect(document.getElementById('integrations-food-api-key')).toBeNull();
        expect(document.getElementById('integrations-food-url')).toBeNull();
        expect(document.documentElement.innerHTML).not.toContain('fastfooddb');

        // med-xso6.24: Save is the WGPage primary, not an in-body button.
        expect(document.getElementById('save-integrations-btn')).toBeNull();
        // Every key field is a .wg-secret password input (masked by default).
        for (const id of ['integrations-openai-api-key', 'integrations-openai-vision-api-key',
            'integrations-elevenlabs-api-key']) {
            const input = document.getElementById(id);
            expect(input.type, id).toBe('password');
            expect(input.closest('.wg-secret'), id).not.toBeNull();
        }
    });

    it('the page-bar primary saves the integrations form', async () => {
        const { window } = env;
        const save = vi.spyOn(window.SettingsIntegrations, 'save').mockResolvedValue(undefined);
        const page = window.SettingsView.openSettingsPage('integrations');
        expect(page).not.toBeNull();
        const primary = page.el.querySelectorAll('.wg-pagebar .wg-btn--primary');
        expect(primary.length).toBe(1);
        expect(primary[0].textContent).toBe('Save');
        primary[0].click();
        expect(save).toHaveBeenCalledTimes(1);
        // Save keeps the page open (a failed save must not lose typed keys).
        expect(page.el.isConnected).toBe(true);
        page.close();
    });

    describe('AI provider picker', () => {
        async function pick(id) {
            env.window.safeChoose = vi.fn(async () => id);
            env.document.getElementById('integrations-provider-choose').click();
            await vi.waitFor(() => expect(env.window.safeChoose).toHaveBeenCalled());
            await vi.waitFor(() => expect(env.document.getElementById('integrations-provider-value').textContent)
                .toBe(env.window.safeChoose.mock.calls[0][1].find((p) => p.value === id).label));
        }

        function load(main = {}) {
            env.window.SettingsIntegrations._applyPayloadToDOM({ openai: main, elevenlabs: {} });
        }

        function field(name) { return env.document.getElementById('integrations-openai-' + name); }

        it('derives presets from saved URLs without rewriting URL or model', () => {
            for (const [url, label] of [
                ['', 'OpenAI'],
                [' https://api.anthropic.com/v1/// ', 'Anthropic (Claude)'],
                ['https://generativelanguage.googleapis.com/v1beta/openai/', 'Google Gemini'],
                ['https://openrouter.ai/api/v1', 'OpenRouter']
            ]) {
                load({ url, model: 'my-existing-model', api_key: '***' });
                expect(env.document.getElementById('integrations-provider-value').textContent).toBe(label);
                expect(env.document.getElementById('integrations-openai-url-field').hidden).toBe(true);
                expect(field('url').value).toBe(url);
                expect(field('model').value).toBe('my-existing-model');
            }
            load({ url: 'https://custom.example/v1', model: 'local-model' });
            expect(env.document.getElementById('integrations-provider-value').textContent).toBe('Other');
            expect(env.document.getElementById('integrations-openai-url-field').hidden).toBe(false);
            expect(field('url').value).toBe('https://custom.example/v1');
        });

        it('offers five choices and fills only eligible model recommendations', async () => {
            load();
            await pick('anthropic');
            expect(env.window.safeChoose.mock.calls[0][1].map((p) => p.value)).toEqual(['openai', 'anthropic', 'gemini', 'openrouter', 'other']);
            expect(field('url').value).toBe('https://api.anthropic.com/v1');
            expect(field('model').value).toBe('claude-sonnet-5-5');
            expect(field('api-key').placeholder).toBe('Paste your Anthropic key');
            const link = env.document.getElementById('integrations-provider-key-link');
            expect(link.href).toBe('https://platform.claude.com/settings/keys');
            expect(link.target).toBe('_blank');
            expect(link.rel).toContain('noopener');
            await pick('gemini');
            expect(field('model').value).toBe('gemini-3.8-flash');
            expect(env.document.getElementById('integrations-provider-key-hint').textContent).toContain('AIza');
            await pick('openrouter');
            expect(field('model').value).toBe('openai/gpt-6-luna');
            field('model').value = 'custom-model';
            await pick('anthropic');
            expect(field('model').value).toBe('custom-model');
        });

        it('clears only the draft main key and guards both page Save and direct save until a new key', async () => {
            load({ api_key: '***', model: 'gpt-6-luna', vision_api_key: '***', vision_url: 'https://photos.example/v1', vision_model: 'photo-custom' });
            const page = env.window.SettingsView.openSettingsPage('integrations');
            const save = page.el.querySelector('.wg-pagebar .wg-btn--primary');
            env.window.apiCall = vi.fn();
            await pick('gemini');
            expect(field('api-key').value).toBe('');
            expect(field('vision-api-key').value).toBe('***');
            expect(field('vision-url').value).toBe('https://photos.example/v1');
            expect(save.disabled).toBe(true);
            expect(env.document.getElementById('integrations-provider-switch-note').hidden).toBe(false);
            await env.window.SettingsIntegrations.save();
            expect(env.window.apiCall).not.toHaveBeenCalled();
            for (const key of ['***', '   ', 'AIza-fixture-new']) {
                field('api-key').value = key;
                field('api-key').dispatchEvent(new env.window.Event('input', { bubbles: true }));
                expect(save.disabled).toBe(key !== 'AIza-fixture-new');
            }
            page.close();
        });

        it('reselecting the loaded provider restores its mask, raw URL and existing Gemini 2.5 model', async () => {
            const url = ' https://generativelanguage.googleapis.com/v1beta/openai/// ';
            load({ url, model: 'gemini-2.5-flash', api_key: '***' });
            await pick('anthropic');
            expect(field('model').value).toBe('gemini-2.5-flash');
            field('model').value = 'unsaved-change';
            await pick('gemini');
            expect(field('api-key').value).toBe('***');
            expect(field('url').value).toBe(url);
            expect(field('model').value).toBe('gemini-2.5-flash');
            await pick('gemini');
            expect(field('url').value).toBe(url);
        });

        it('requires a new Other key and clears a saved mask on custom URL edits', async () => {
            load({ url: 'https://old.example/v1', api_key: '***', model: 'local-model' });
            const page = env.window.SettingsView.openSettingsPage('integrations');
            const save = page.el.querySelector('.wg-pagebar .wg-btn--primary');
            field('url').value = 'https://new.example/v1';
            field('url').dispatchEvent(new env.window.Event('input', { bubbles: true }));
            expect(field('api-key').value).toBe('');
            expect(save.disabled).toBe(true);
            expect(env.document.getElementById('integrations-provider-key-link').hidden).toBe(true);
            await pick('anthropic');
            await pick('other');
            expect(field('url').value).toBe('https://old.example/v1');
            expect(field('api-key').value).toBe('***');
            expect(field('model').value).toBe('local-model');
            page.close();
        });

        it('keeps Advanced overrides mounted and unchanged through a normal save', async () => {
            const main = { url: 'https://generativelanguage.googleapis.com/v1beta/openai///', model: 'gemini-2.5-flash', api_key: '***', vision_api_key: '***', vision_url: 'https://photos.example/v1', vision_model: 'photo-custom' };
            load(main);
            const advanced = env.document.getElementById('integrations-provider-advanced');
            expect(advanced.open).toBe(false);
            expect(advanced.querySelector('#integrations-openai-vision-model')).not.toBeNull();
            let patch;
            env.window.apiCall = vi.fn(async (url, method, body) => {
                if (method === 'PATCH') { patch = body; return { ok: true }; }
                return { openai: main, elevenlabs: {} };
            });
            await env.window.SettingsIntegrations.save();
            expect(patch.openai).toEqual(main);
            expect(Object.keys(patch)).toEqual(['openai', 'elevenlabs']);
            expect(advanced.open).toBe(false);
        });

        it('Other requires an explicit URL and never preserves a saved key at a changed API base', async () => {
            for (const savedURL of ['', 'https://old.example/v1']) {
                load({ url: savedURL, api_key: '***', model: 'custom' });
                const page = env.window.SettingsView.openSettingsPage('integrations');
                const save = page.el.querySelector('.wg-pagebar .wg-btn--primary');
                env.window.apiCall = vi.fn();
                if (!savedURL) await pick('other');
                field('url').value = '';
                field('url').dispatchEvent(new env.window.Event('input', { bubbles: true }));
                field('api-key').value = 'fixture-other-key';
                field('api-key').dispatchEvent(new env.window.Event('input', { bubbles: true }));
                expect(save.disabled).toBe(true);
                expect(env.document.getElementById('integrations-provider-url-hint').textContent).toBe('Enter your provider’s API URL before saving.');
                await env.window.SettingsIntegrations.save();
                expect(env.window.apiCall).not.toHaveBeenCalled();
                field('url').value = 'https://new.example/v1';
                field('url').dispatchEvent(new env.window.Event('input', { bubbles: true }));
                field('api-key').value = '***';
                field('api-key').dispatchEvent(new env.window.Event('input', { bubbles: true }));
                expect(save.disabled).toBe(true);
                await env.window.SettingsIntegrations.save();
                expect(env.window.apiCall).not.toHaveBeenCalled();
                field('api-key').value = '';
                field('api-key').dispatchEvent(new env.window.Event('input', { bubbles: true }));
                expect(save.disabled).toBe(true);
                expect(env.document.getElementById('integrations-provider-key-hint').textContent).toBe('Enter an API key for this provider before saving.');
                field('api-key').value = 'fixture-new-other-key';
                field('api-key').dispatchEvent(new env.window.Event('input', { bubbles: true }));
                expect(save.disabled).toBe(false);
                page.close();
            }
        });

        it('Back discards a provider draft before reopening and saving voice settings', async () => {
            const main = { url: 'https://api.anthropic.com/v1/', api_key: '***', model: 'custom-saved' };
            load(main);
            let page = env.window.SettingsView.openSettingsPage('integrations');
            await pick('gemini');
            field('api-key').value = 'fixture-draft-key';
            field('api-key').dispatchEvent(new env.window.Event('input', { bubbles: true }));
            page.close();
            page = env.window.SettingsView.openSettingsPage('integrations');
            expect(env.document.getElementById('integrations-provider-value').textContent).toBe('Anthropic (Claude)');
            expect(field('url').value).toBe(main.url);
            expect(field('model').value).toBe(main.model);
            expect(field('api-key').value).toBe('***');
            expect(page.el.querySelector('.wg-pagebar .wg-btn--primary').disabled).toBe(false);
            env.document.getElementById('integrations-elevenlabs-api-key').value = 'fixture-voice-key';
            let patch;
            env.window.apiCall = vi.fn(async (url, method, body) => {
                if (method === 'PATCH') { patch = body; return { ok: true }; }
                return { openai: main, elevenlabs: { api_key: '***' } };
            });
            await env.window.SettingsIntegrations.save();
            expect(patch.openai.url).toBe(main.url);
            expect(patch.openai.api_key).toBe('***');
            expect(patch.openai.model).toBe(main.model);
            expect(patch.elevenlabs.api_key).toBe('fixture-voice-key');
            page.close();
        });

        it('unset OpenAI reselect fills eligible defaults but preserves a newly typed custom model', async () => {
            load();
            await pick('anthropic');
            await pick('openai');
            expect(field('url').value).toBe('https://api.openai.com/v1');
            expect(field('model').value).toBe('gpt-6-luna');
            await pick('anthropic');
            field('model').value = 'custom-draft';
            await pick('openai');
            expect(field('model').value).toBe('custom-draft');
        });

        it('summary omits providers with no saved key', () => {
            for (const url of ['https://api.openai.com/v1', 'https://api.anthropic.com/v1', 'https://generativelanguage.googleapis.com/v1beta/openai/', 'https://openrouter.ai/api/v1']) {
                load({ url, api_key: '', model: 'saved-model' });
                env.window.SettingsView.refreshIntegrationsSummary();
                expect(env.document.querySelector('[data-settings-summary="integrations"]').textContent).toBe('AI, voice, Telegram');
            }
            load({ url: 'https://local.example/v1', api_key: '', model: 'local-model' });
            env.window.SettingsView.refreshIntegrationsSummary();
            expect(env.document.querySelector('[data-settings-summary="integrations"]').textContent).toBe('AI, voice, Telegram');
        });

        it('preserves legacy keyless Other on load and ordinary save, while requiring a key for a new URL', async () => {
            const main = { url: ' https://legacy.example/v1/ ', model: 'legacy-model', api_key: '' };
            load(main);
            const page = env.window.SettingsView.openSettingsPage('integrations');
            const save = page.el.querySelector('.wg-pagebar .wg-btn--primary');
            expect(field('url').value).toBe(main.url);
            expect(save.disabled).toBe(false);
            let patch;
            env.window.apiCall = vi.fn(async (url, method, body) => {
                if (method === 'PATCH') { patch = body; return { ok: true }; }
                return { openai: main, elevenlabs: {} };
            });
            await env.window.SettingsIntegrations.save();
            expect(patch.openai.url).toBe(main.url);
            expect(patch.openai.api_key).toBe('');
            expect(patch.openai.model).toBe(main.model);
            field('url').value = 'https://new.example/v1';
            field('url').dispatchEvent(new env.window.Event('input', { bubbles: true }));
            expect(save.disabled).toBe(true);
            field('api-key').value = 'fixture-new-key';
            field('api-key').dispatchEvent(new env.window.Event('input', { bubbles: true }));
            expect(save.disabled).toBe(false);
            page.close();
        });

        it('draft switches retain the saved main-key active/trial/own-key status until Save', async () => {
            const meta = env.document.createElement('meta');
            meta.name = 'medtracker-trial-ai';
            meta.content = '1';
            env.document.head.appendChild(meta);
            load({ api_key: '***', url: '', model: 'gpt-6-luna' });
            const hint = env.document.getElementById('integrations-openai-trial-hint');
            const own = env.document.querySelector('#integrations-trial [data-own-key="openai"] [data-own-key-state]');
            expect(hint.hidden).toBe(true);
            expect(own.textContent).toBe('Set');
            await pick('gemini');
            expect(field('api-key').value).toBe('');
            expect(hint.hidden).toBe(true);
            expect(own.textContent).toBe('Set');
            field('api-key').value = 'fixture-new-key';
            field('api-key').dispatchEvent(new env.window.Event('input', { bubbles: true }));
            expect(hint.hidden).toBe(true);
            expect(own.textContent).toBe('Set');
            // A successful save that clears the key changes the active state.
            await pick('openai');
            field('api-key').value = '';
            env.window.apiCall = vi.fn(async (url, method) => method === 'PATCH' ? { ok: true } : { openai: { api_key: '', url: '', model: 'gpt-6-luna' }, elevenlabs: {} });
            await env.window.SettingsIntegrations.save();
            expect(hint.hidden).toBe(false);
            expect(own.textContent).toBe('Not set');
        });

        it('shows the saved provider summary after save and retains it during draft changes', async () => {
            const main = { url: 'https://api.anthropic.com/v1', api_key: '***', model: 'custom' };
            load(main);
            env.window.SettingsView.refreshIntegrationsSummary();
            const summary = env.document.querySelector('[data-settings-summary="integrations"]');
            expect(summary.textContent).toBe('Anthropic');
            await pick('gemini');
            env.window.SettingsView.refreshIntegrationsSummary();
            expect(summary.textContent).toBe('Anthropic');
            field('api-key').value = 'AIza-fixture-new';
            field('api-key').dispatchEvent(new env.window.Event('input', { bubbles: true }));
            env.window.apiCall = vi.fn(async (url, method) => method === 'PATCH' ? { ok: true } : { openai: { url: field('url').value, api_key: '***', model: field('model').value }, elevenlabs: {} });
            await env.window.SettingsIntegrations.save();
            expect(summary.textContent).toBe('Google Gemini');
        });

        it('Choose uses the saved-credentials route after switching, with manual entry usable on failure', async () => {
            load({ url: 'https://api.openai.com/v1', api_key: '***' });
            await pick('anthropic');
            const page = env.window.SettingsView.openSettingsPage('integrations');
            field('api-key').value = 'sk-ant-fixture-new';
            field('api-key').dispatchEvent(new env.window.Event('input', { bubbles: true }));
            env.window.apiCall = vi.fn(async () => ({ error: 'Model listing unavailable' }));
            await env.window.SettingsIntegrations._chooseModel('text');
            expect(env.window.apiCall).toHaveBeenCalledWith('/api/settings/integrations/models?scope=text', 'GET');
            expect(field('model').disabled).toBe(false);
            expect(page.el.querySelector('.wg-pagebar .wg-btn--primary').disabled).toBe(false);
            page.close();
        });
    });

    describe('photo credentials through Settings → settings domain → AI client', () => {
        const main = { api_key: 'fixture-main-key', url: 'https://api.openai.com/v1', model: 'gpt-6-luna' };

        async function setup(overrides) {
            const memory = new Map();
            const settings = createSettingsDomain({ records: {
                async list(type) { return memory.get(type) || []; },
                async put(type, row) { memory.set(type, [structuredClone(row)]); }
            }, now: () => 1, timeZone: () => 'UTC' });
            await settings.patchIntegrations({ openai: { ...main, ...overrides } });
            env.window.apiCall = vi.fn(async (path, method, body) => {
                if (path !== '/api/settings/integrations') return null;
                return method === 'PATCH' ? settings.patchIntegrations(body) : settings.getIntegrations();
            });
            await env.window.SettingsIntegrations.load();
            return { settings, page: env.window.SettingsView.openSettingsPage('integrations') };
        }

        function field(name) { return env.document.getElementById('integrations-openai-' + name); }
        function fill(name, value) {
            field(name).value = value;
            field(name).dispatchEvent(new env.window.Event('input', { bubbles: true }));
        }
        async function pick(id) {
            env.window.safeChoose = vi.fn(async () => id);
            env.document.getElementById('integrations-provider-choose').click();
            await vi.waitFor(() => expect(env.document.getElementById('integrations-provider-value').textContent)
                .toBe(id === 'anthropic' ? 'Anthropic (Claude)' : 'OpenAI'));
        }
        async function request(settings, image = true) {
            const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data: [DONE]\n\n', { status: 200 }));
            try {
                await createAIClient({ settingsDomain: settings }).chatStream({
                    body: { messages: [{ role: 'user', content: image
                        ? [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]
                        : 'fixture text' }] }, onChunk() {}
                });
                expect(send).toHaveBeenCalledTimes(1);
                const [url, init] = send.mock.calls[0];
                return { url, authorization: init.headers.Authorization, model: JSON.parse(init.body).model };
            } finally { send.mockRestore(); }
        }
        function saveButton(page) { return page.el.querySelector('.wg-pagebar .wg-btn--primary'); }

        it('rejects a main preservation sentinel when no stored key exists, including failed-read fallback and cache/status', async () => {
            const meta = env.document.createElement('meta');
            meta.name = 'medtracker-trial-ai'; meta.content = '1'; env.document.head.appendChild(meta);
            for (const url of ['', 'https://legacy.example/v1']) {
                const { settings, page } = await setup({ api_key: '', url, vision_api_key: '', vision_url: '', vision_model: '' });
                const afterPatch = vi.fn(async (path, method, body) => method === 'PATCH' ? settings.patchIntegrations(body) : null);
                env.window.apiCall = afterPatch; // a post-PATCH GET would fail, so fallback must never invent a key
                fill('api-key', '***');
                expect(saveButton(page).disabled).toBe(true);
                await env.window.SettingsIntegrations.save();
                expect(afterPatch).not.toHaveBeenCalled();
                expect((await settings.readIntegrationsUnmasked()).openai.api_key).toBe('');
                expect((await env.window.MedTrackerDB.ApiCache.get('settings_integrations')).openai.api_key).toBe('');
                expect(env.window.SettingsIntegrations.savedProviderLabel()).toBe('');
                expect(env.document.getElementById('integrations-openai-trial-hint').hidden).toBe(false);
                expect(env.document.querySelector('[data-own-key="openai"] [data-own-key-state]').textContent).toBe('Not set');
                page.close();
            }
        });

        it('keeps an explicit saved photo key at its old inherited URL/model after main switch and Save', async () => {
            const { settings, page } = await setup({ vision_api_key: 'fixture-photo-key', vision_url: '', vision_model: '' });
            await pick('anthropic');
            fill('api-key', 'fixture-anthropic-key');
            expect(field('vision-api-key').value).toBe('***');
            expect(field('vision-url').value).toBe(main.url);
            expect(field('vision-model').value).toBe(main.model);
            expect((await settings.readIntegrationsUnmasked()).openai.vision_url).toBe('');
            expect(saveButton(page).disabled).toBe(false);
            const realCall = env.window.apiCall;
            env.window.apiCall = vi.fn(async (path, method, body) => method === 'PATCH' ? null : realCall(path, method, body));
            await env.window.SettingsIntegrations.save();
            expect((await settings.readIntegrationsUnmasked()).openai.url).toBe(main.url);
            expect((await settings.readIntegrationsUnmasked()).openai.vision_url).toBe('');
            expect(field('vision-url').value).toBe(main.url);
            expect(env.window.SettingsIntegrations.savedProviderLabel()).toBe('OpenAI');
            env.window.apiCall = realCall;
            await env.window.SettingsIntegrations.save();
            expect(await request(settings)).toEqual({ url: main.url + '/chat/completions', authorization: 'Bearer fixture-photo-key', model: main.model });
            expect(await request(settings, false)).toEqual({ url: 'https://api.anthropic.com/v1/chat/completions', authorization: 'Bearer fixture-anthropic-key', model: 'claude-sonnet-5-5' });
            expect(env.document.getElementById('integrations-photo-summary').textContent).toBe('Food photos keep their saved provider');
            const cache = await env.window.MedTrackerDB.ApiCache.get('settings_integrations');
            expect(cache.openai.api_key).toBe('***');
            expect(cache.openai.vision_api_key).toBe('***');
            expect(JSON.stringify(cache)).not.toContain('fixture-');
            page.close();
        });

        it('allows a newly entered photo key for the selected main endpoint without pinning it to the old provider', async () => {
            const { settings, page } = await setup({ vision_api_key: '', vision_url: '', vision_model: '' });
            await pick('anthropic');
            fill('api-key', 'fixture-anthropic-key');
            fill('vision-api-key', '***');
            expect(saveButton(page).disabled).toBe(true); // no saved photo secret exists for this sentinel
            fill('vision-api-key', 'fixture-new-photo-key');
            expect(field('vision-url').value).toBe('');
            expect(field('vision-model').value).toBe('');
            expect(saveButton(page).disabled).toBe(false);
            await env.window.SettingsIntegrations.save();
            expect(await request(settings)).toEqual({ url: 'https://api.anthropic.com/v1/chat/completions', authorization: 'Bearer fixture-new-photo-key', model: 'claude-sonnet-5-5' });
            page.close();
        });

        it('blocks a retained cross-origin photo URL from borrowing the new main key until explicit key or URL action', async () => {
            for (const resolution of ['key', 'inherit']) {
                const { settings, page } = await setup({ vision_api_key: '', vision_url: 'https://photos.example/v1', vision_model: 'photo-custom' });
                await pick('anthropic');
                fill('api-key', 'fixture-anthropic-key');
                expect(saveButton(page).disabled).toBe(true);
                expect(env.document.getElementById('integrations-provider-advanced').open).toBe(true);
                expect(env.document.getElementById('integrations-photo-key-hint').textContent).toBe('Enter a photo API key for this URL, or clear Photo API URL to use the provider above.');
                await env.window.SettingsIntegrations.save();
                expect(env.window.apiCall.mock.calls.filter((call) => call[1] === 'PATCH')).toHaveLength(0);
                if (resolution === 'key') fill('vision-api-key', 'fixture-explicit-photo-key');
                else fill('vision-url', '');
                expect(saveButton(page).disabled).toBe(false);
                await env.window.SettingsIntegrations.save();
                expect(await request(settings)).toEqual({
                    url: resolution === 'key' ? 'https://photos.example/v1/chat/completions' : 'https://api.anthropic.com/v1/chat/completions',
                    authorization: resolution === 'key' ? 'Bearer fixture-explicit-photo-key' : 'Bearer fixture-anthropic-key', model: 'photo-custom'
                });
                page.close();
            }
        });

        it('preserves explicit edits after pinning and requires photo key re-entry at the edited base', async () => {
            const { settings, page } = await setup({ vision_api_key: 'fixture-photo-key', vision_url: '', vision_model: '' });
            await pick('anthropic');
            fill('api-key', 'fixture-anthropic-key');
            fill('vision-url', 'https://new-photos.example/v1');
            fill('vision-model', 'photo-custom');
            expect(field('vision-url').value).toBe('https://new-photos.example/v1');
            expect(saveButton(page).disabled).toBe(true);
            expect(env.document.getElementById('integrations-photo-key-hint').textContent).toContain('Enter the photo API key again for this URL.');
            await env.window.SettingsIntegrations.save();
            expect((await settings.readIntegrationsUnmasked()).openai.url).toBe(main.url);
            fill('vision-api-key', 'fixture-new-photo-key');
            expect(saveButton(page).disabled).toBe(false);
            await env.window.SettingsIntegrations.save();
            expect(await request(settings)).toEqual({ url: 'https://new-photos.example/v1/chat/completions', authorization: 'Bearer fixture-new-photo-key', model: 'photo-custom' });
            page.close();
        });

        it('explicitly clearing the photo key and URL after pinning follows main and keeps a model-only edit', async () => {
            const { settings, page } = await setup({ vision_api_key: 'fixture-photo-key', vision_url: '', vision_model: '' });
            await pick('anthropic');
            fill('api-key', 'fixture-anthropic-key');
            fill('vision-api-key', '');
            expect(saveButton(page).disabled).toBe(false);
            expect(field('vision-url').value).toBe('');
            expect(field('vision-model').value).toBe('');
            fill('vision-url', '');
            fill('vision-model', 'photo-custom');
            expect(saveButton(page).disabled).toBe(false);
            await env.window.SettingsIntegrations.save();
            expect((await settings.readIntegrationsUnmasked()).openai.vision_api_key).toBe('');
            expect(await request(settings)).toEqual({ url: 'https://api.anthropic.com/v1/chat/completions', authorization: 'Bearer fixture-anthropic-key', model: 'photo-custom' });
            page.close();
        });

        it('also rejects manual photo URL retargeting with an untouched mask while main is unchanged', async () => {
            const { settings, page } = await setup({ vision_api_key: 'fixture-photo-key', vision_url: 'https://photos.example/v1', vision_model: 'photo-custom' });
            fill('vision-url', 'https://edited.example/v1');
            expect(saveButton(page).disabled).toBe(true);
            expect(env.document.getElementById('integrations-provider-advanced').open).toBe(true);
            await env.window.SettingsIntegrations.save();
            expect(env.window.apiCall.mock.calls.filter((call) => call[1] === 'PATCH')).toHaveLength(0);
            fill('vision-api-key', 'fixture-reentered-photo-key');
            expect(saveButton(page).disabled).toBe(false);
            await env.window.SettingsIntegrations.save();
            expect((await settings.readIntegrationsUnmasked()).openai.api_key).toBe('fixture-main-key');
            expect(await request(settings)).toEqual({ url: 'https://edited.example/v1/chat/completions', authorization: 'Bearer fixture-reentered-photo-key', model: 'photo-custom' });
            page.close();
        });

        it('main reselect preserves deliberate photo edits while full Back restores the loaded photo state', async () => {
            const { settings, page } = await setup({ vision_api_key: 'fixture-photo-key', vision_url: '', vision_model: '' });
            await pick('anthropic');
            expect(field('vision-url').value).toBe(main.url);
            await pick('openai');
            expect(field('vision-url').value).toBe('');
            expect(field('vision-model').value).toBe('');
            await pick('anthropic');
            page.close();
            expect(field('vision-url').value).toBe('');
            expect(field('vision-model').value).toBe('');
            const reopened = env.window.SettingsView.openSettingsPage('integrations');
            await pick('anthropic');
            fill('vision-url', 'https://edited.example/v1');
            fill('vision-model', 'explicit-photo-model');
            await pick('openai');
            expect(field('vision-url').value).toBe('https://edited.example/v1');
            expect(field('vision-model').value).toBe('explicit-photo-model');
            reopened.close();
            expect(field('vision-url').value).toBe('');
            expect(field('vision-model').value).toBe('');
            expect((await settings.readIntegrationsUnmasked()).openai.vision_url).toBe('');
        });

        it('replacing the saved photo mask first unwinds old untouched URL/model pins and binds to the current provider', async () => {
            const { settings, page } = await setup({ vision_api_key: 'fixture-photo-key', vision_url: '', vision_model: '' });
            await pick('anthropic');
            fill('api-key', 'fixture-anthropic-key');
            expect(field('vision-url').value).toBe(main.url);
            expect(field('vision-model').value).toBe(main.model);
            fill('vision-api-key', 'fixture-replacement-photo-key');
            expect(field('vision-url').value).toBe('');
            expect(field('vision-model').value).toBe('');
            expect(env.document.getElementById('integrations-photo-url-hint').hidden).toBe(true);
            expect(env.document.getElementById('integrations-photo-model-hint').hidden).toBe(true);
            expect(saveButton(page).disabled).toBe(false);
            await env.window.SettingsIntegrations.save();
            expect(await request(settings)).toEqual({ url: 'https://api.anthropic.com/v1/chat/completions', authorization: 'Bearer fixture-replacement-photo-key', model: 'claude-sonnet-5-5' });
            page.close();
        });

        it('clearing an old photo key removes only untouched pins so inheritance uses the new main model', async () => {
            for (const explicitModel of ['', 'photo-custom', main.model]) {
                const { settings, page } = await setup({ vision_api_key: 'fixture-photo-key', vision_url: '', vision_model: '' });
                await pick('anthropic');
                fill('api-key', 'fixture-anthropic-key');
                if (explicitModel) fill('vision-model', explicitModel);
                fill('vision-api-key', '');
                fill('vision-url', '');
                expect(field('vision-model').value).toBe(explicitModel);
                expect(env.document.getElementById('integrations-photo-model-hint').hidden).toBe(true);
                await env.window.SettingsIntegrations.save();
                expect(await request(settings)).toEqual({ url: 'https://api.anthropic.com/v1/chat/completions', authorization: 'Bearer fixture-anthropic-key', model: explicitModel || 'claude-sonnet-5-5' });
                page.close();
            }
        });

        it('replacement preserves deliberate photo URL/model edits even when their text equals the generated pins', async () => {
            const { settings, page } = await setup({ vision_api_key: 'fixture-photo-key', vision_url: '', vision_model: '' });
            await pick('anthropic');
            fill('api-key', 'fixture-anthropic-key');
            fill('vision-url', main.url);
            fill('vision-model', main.model);
            fill('vision-api-key', 'fixture-replacement-photo-key');
            expect(field('vision-url').value).toBe(main.url);
            expect(field('vision-model').value).toBe(main.model);
            expect(saveButton(page).disabled).toBe(false);
            await env.window.SettingsIntegrations.save();
            expect(await request(settings)).toEqual({ url: main.url + '/chat/completions', authorization: 'Bearer fixture-replacement-photo-key', model: main.model });
            page.close();
        });

        it('changing a photo URL retires an untouched model pin while keeping explicit model edits', async () => {
            for (const explicitModel of ['', 'photo-custom']) {
                const { settings, page } = await setup({ vision_api_key: 'fixture-photo-key', vision_url: '', vision_model: '' });
                await pick('anthropic');
                fill('api-key', 'fixture-anthropic-key');
                if (explicitModel) fill('vision-model', explicitModel);
                fill('vision-url', 'https://new-photos.example/v1');
                expect(field('vision-model').value).toBe(explicitModel);
                expect(saveButton(page).disabled).toBe(true);
                expect(env.document.getElementById('integrations-photo-model-hint').hidden).toBe(true);
                fill('vision-api-key', 'fixture-new-photo-key');
                expect(field('vision-url').value).toBe('https://new-photos.example/v1');
                await env.window.SettingsIntegrations.save();
                expect(await request(settings)).toEqual({ url: 'https://new-photos.example/v1/chat/completions', authorization: 'Bearer fixture-new-photo-key', model: explicitModel || 'claude-sonnet-5-5' });
                page.close();
            }
        });

        it('binds a typed photo key only at entry: later main choices/reselect need deliberate re-entry', async () => {
            const { settings, page } = await setup({ vision_api_key: '', vision_url: '', vision_model: '' });
            await pick('anthropic');
            fill('api-key', 'fixture-anthropic-key');
            fill('vision-api-key', 'fixture-anthropic-photo-key');
            env.window.safeChoose = vi.fn(async () => 'gemini');
            env.document.getElementById('integrations-provider-choose').click();
            await vi.waitFor(() => expect(env.document.getElementById('integrations-provider-value').textContent).toBe('Google Gemini'));
            fill('api-key', 'fixture-gemini-main-key');
            expect(field('vision-api-key').value).toBe('fixture-anthropic-photo-key');
            expect(field('vision-url').value).toBe('');
            expect(saveButton(page).disabled).toBe(true);
            await env.window.SettingsIntegrations.save();
            expect(env.window.apiCall.mock.calls.filter((call) => call[1] === 'PATCH')).toHaveLength(0);
            await pick('openai'); // choosing the loaded main provider is not photo-key re-entry
            expect(saveButton(page).disabled).toBe(true);
            fill('vision-api-key', 'fixture-reentered-openai-photo-key');
            expect(saveButton(page).disabled).toBe(false);
            await env.window.SettingsIntegrations.save();
            expect(await request(settings)).toEqual({ url: main.url + '/chat/completions', authorization: 'Bearer fixture-reentered-openai-photo-key', model: main.model });
            page.close();
        });

        it('does not rebind a typed photo key on a later photo URL edit and full Back discards its draft', async () => {
            const { settings, page } = await setup({ vision_api_key: '', vision_url: '', vision_model: '' });
            fill('vision-api-key', 'fixture-openai-photo-key');
            fill('vision-url', 'https://new-photos.example/v1');
            expect(saveButton(page).disabled).toBe(true);
            await env.window.SettingsIntegrations.save();
            expect((await settings.readIntegrationsUnmasked()).openai.vision_api_key).toBe('');
            env.document.getElementById('integrations-elevenlabs-api-key').value = 'fixture-unsaved-voice-key';
            page.close();
            expect(field('vision-api-key').value).toBe('');
            expect(field('vision-url').value).toBe('');
            expect(env.document.getElementById('integrations-elevenlabs-api-key').value).toBe('');
            const reopened = env.window.SettingsView.openSettingsPage('integrations');
            expect(saveButton(reopened).disabled).toBe(false);
            reopened.close();
        });

        it('A→B typed photo key→C refuses B’s key and sends only a key explicitly re-entered for C', async () => {
            const { settings, page } = await setup({ vision_api_key: '', vision_url: '', vision_model: '' });
            await pick('anthropic');
            fill('api-key', 'fixture-anthropic-main-key');
            fill('vision-api-key', 'fixture-anthropic-photo-key');
            env.window.safeChoose = vi.fn(async () => 'gemini');
            env.document.getElementById('integrations-provider-choose').click();
            await vi.waitFor(() => expect(env.document.getElementById('integrations-provider-value').textContent).toBe('Google Gemini'));
            fill('api-key', 'fixture-gemini-main-key');
            expect(saveButton(page).disabled).toBe(true);
            await env.window.SettingsIntegrations.save();
            expect(env.window.apiCall.mock.calls.filter((call) => call[1] === 'PATCH')).toHaveLength(0);
            fill('vision-api-key', 'fixture-gemini-photo-key');
            expect(saveButton(page).disabled).toBe(false);
            await env.window.SettingsIntegrations.save();
            expect(await request(settings)).toEqual({ url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', authorization: 'Bearer fixture-gemini-photo-key', model: 'gemini-3.8-flash' });
            page.close();
        });

        it('a no-op or same-base photo URL event retires only URL ownership and keeps the still-bound automatic model', async () => {
            const { settings, page } = await setup({ vision_api_key: 'fixture-photo-key', vision_url: '', vision_model: '' });
            await pick('anthropic');
            fill('api-key', 'fixture-anthropic-key');
            fill('vision-url', main.url + '/');
            expect(field('vision-model').value).toBe(main.model);
            expect(env.document.getElementById('integrations-photo-url-hint').hidden).toBe(true);
            expect(env.document.getElementById('integrations-photo-model-hint').hidden).toBe(false);
            expect(saveButton(page).disabled).toBe(false);
            await env.window.SettingsIntegrations.save();
            expect(await request(settings)).toEqual({ url: main.url + '/chat/completions', authorization: 'Bearer fixture-photo-key', model: main.model });
            page.close();
        });

        it('materializes the raw effective photo URL so existing custom trailing-slash request paths stay intact', async () => {
            const rawURL = 'https://custom.example/prefix///';
            const { settings, page } = await setup({ url: rawURL, vision_api_key: 'fixture-photo-key', vision_url: '', vision_model: '' });
            const before = await request(settings);
            await pick('anthropic');
            fill('api-key', 'fixture-anthropic-key');
            fill('model', 'claude-sonnet-5-5');
            expect(field('vision-url').value).toBe(rawURL);
            await env.window.SettingsIntegrations.save();
            expect((await settings.readIntegrationsUnmasked()).openai.vision_url).toBe(rawURL);
            expect(await request(settings)).toEqual(before);
            page.close();
        });

        it('fully inherited photo credentials follow main and failed Save leaves the saved active setup unchanged', async () => {
            const { settings, page } = await setup({ vision_api_key: '', vision_url: '', vision_model: 'photo-custom' });
            await pick('anthropic');
            fill('api-key', 'fixture-anthropic-key');
            expect(field('vision-url').value).toBe('');
            expect(field('vision-model').value).toBe('photo-custom');
            const realCall = env.window.apiCall;
            env.window.apiCall = vi.fn(async (path, method, body) => method === 'PATCH' ? null : realCall(path, method, body));
            await env.window.SettingsIntegrations.save();
            expect(env.window.SettingsIntegrations.savedProviderLabel()).toBe('OpenAI');
            expect(await request(settings)).toEqual({ url: main.url + '/chat/completions', authorization: 'Bearer fixture-main-key', model: 'photo-custom' });
            env.window.apiCall = realCall;
            await env.window.SettingsIntegrations.save();
            expect(await request(settings)).toEqual({ url: 'https://api.anthropic.com/v1/chat/completions', authorization: 'Bearer fixture-anthropic-key', model: 'photo-custom' });
            page.close();
        });
    });

    describe('key fields (reveal / copy)', () => {
        function secret(document) {
            return document.getElementById('integrations-openai-api-key').closest('.wg-secret');
        }

        it('reveal toggles the mask and its pressed state', () => {
            const { document } = env;
            const wrap = secret(document);
            const input = wrap.querySelector('input');
            const reveal = wrap.querySelector('[data-secret-reveal]');
            reveal.click();
            expect(input.type).toBe('text');
            expect(reveal.getAttribute('aria-pressed')).toBe('true');
            reveal.click();
            expect(input.type).toBe('password');
            expect(reveal.getAttribute('aria-pressed')).toBe('false');
        });

        it('copy puts a typed key on the clipboard and nowhere else', async () => {
            const { window, document } = env;
            const writeText = vi.fn(async () => {});
            Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
            window.apiCall = vi.fn();
            window.fetch = vi.fn();
            const wrap = secret(document);
            wrap.querySelector('input').value = 'sk-typed';
            wrap.querySelector('[data-secret-copy]').click();
            await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('sk-typed'));
            expect(window.apiCall).not.toHaveBeenCalled();
            expect(window.fetch).not.toHaveBeenCalled();
        });

        it('copy refuses the saved-key mask', async () => {
            const { window, document } = env;
            const writeText = vi.fn(async () => {});
            Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
            const toasts = [];
            window.safeToast = (msg) => toasts.push(msg);
            const wrap = secret(document);
            wrap.querySelector('input').value = '***';
            wrap.querySelector('[data-secret-copy]').click();
            await new Promise((r) => setTimeout(r, 0));
            expect(writeText).not.toHaveBeenCalled();
            expect(toasts[0]).toMatch(/type a key/i);
        });
    });

    describe('Telegram row', () => {
        it('stays hidden until the module stamps an enabled state, then shows Linked', () => {
            const { window, document } = env;
            const row = document.getElementById('integrations-telegram-row');
            const mount = document.getElementById('telegram-settings-mount');
            expect(row.hidden).toBe(true);
            mount.dataset.tgState = 'disabled';
            window.SettingsIntegrations.syncTelegramRow();
            expect(row.hidden).toBe(true);
            mount.dataset.tgState = 'linked';
            window.SettingsIntegrations.syncTelegramRow();
            expect(row.hidden).toBe(false);
            expect(row.querySelector('[data-settings-summary="telegram"]').textContent).toBe('Linked');
            mount.dataset.tgState = 'none';
            window.SettingsIntegrations.syncTelegramRow();
            expect(row.querySelector('[data-settings-summary="telegram"]').textContent).toBe('Not linked');
        });

        it('opens the Telegram page nested under AI & integrations', () => {
            const { window, document } = env;
            const page = window.SettingsView.openSettingsPage('telegram');
            expect(page).not.toBeNull();
            expect(page.el.querySelector('#telegram-settings-mount')).not.toBeNull();
            expect(page.el.textContent).toContain('AI & integrations');
            page.close();
            expect(document.querySelector('.wg-settings-pages #telegram-settings-mount')).not.toBeNull();
        });
    });

    it('save toast confirms without restart wording (changes apply live)', async () => {
        const { window, document } = env;

        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'PATCH') return { ok: true };
            if (method === 'GET') return { openai: {}, food: {}, elevenlabs: {} };
            return null;
        });
        await window.SettingsIntegrations.load();

        // Wait for dynamic imports to resolve
        await new Promise(r => setTimeout(r, 0));

        const alerts = [];
        window.safeAlert = (msg) => alerts.push(msg);
        await window.SettingsIntegrations.save();
        expect(alerts[0]).toBe('Integrations saved.');
        expect(alerts[0]).not.toContain('Restart');
    });

    it('exposes SettingsIntegrations on window with load + save methods', () => {
        const { window } = env;
        expect(window.SettingsIntegrations).toBeDefined();
        expect(typeof window.SettingsIntegrations.load).toBe('function');
        expect(typeof window.SettingsIntegrations.save).toBe('function');
    });

    it('load() populates inputs from GET /api/settings/integrations including the *** secret mask', async () => {
        const { window, document } = env;

        window.apiCall = vi.fn(async (url, method) => {
            expect(url).toBe('/api/settings/integrations');
            expect(method).toBe('GET');
            return {
                openai: {
                    api_key: '***',
                    url: 'https://api.openai.com/v1',
                    model: 'gpt-5',
                    vision_api_key: '',
                    vision_url: '',
                    vision_model: ''
                },
                food: { api_key: '***', url: 'https://fastfood.example.com', domain: 'legacy.example.com' },
                elevenlabs: { api_key: '', agent_id: 'agent_abc' }
            };
        });

        const result = await window.SettingsIntegrations.load();
        expect(result).toBeTruthy();
        expect(document.getElementById('integrations-openai-api-key').value).toBe('***');
        expect(document.getElementById('integrations-openai-url').value).toBe('https://api.openai.com/v1');
        expect(document.getElementById('integrations-openai-model').value).toBe('gpt-5');
        expect(document.getElementById('integrations-elevenlabs-api-key').value).toBe('');
        expect(document.getElementById('integrations-elevenlabs-agent-id').value).toBe('agent_abc');
    });

    // med-xrr: the Domain input is gone, but a value stored by an older build
    // must survive a save — readDOMIntoPayload sends '' for any absent input,
    // and '' means "clear" to both patch paths, so `domain` has to be absent
    // from the payload entirely rather than merely absent from the DOM.
    it('save() omits the food group so a stored custom food URL/key/domain is preserved, not cleared', async () => {
        const { window, document } = env;

        const calls = [];
        window.apiCall = vi.fn(async (url, method, body) => {
            calls.push({ url, method, body });
            if (url === '/api/settings/integrations' && method === 'PATCH') return { ok: true };
            return {
                openai: { api_key: '', url: '', model: '', vision_api_key: '', vision_url: '', vision_model: '' },
                food: { api_key: '', url: '', domain: 'legacy.example.com' },
                elevenlabs: { api_key: '', agent_id: '' }
            };
        });

        await window.SettingsIntegrations.save();

        const patch = calls.find((c) => c.method === 'PATCH');
        expect(patch).toBeTruthy();
        expect(patch.body.food).toBeUndefined();
    });

    it('save() routes the write through DataStore.applyOptimistic and PATCHes the form payload', async () => {
        const { window, document } = env;

        const calls = [];
        window.apiCall = vi.fn(async (url, method, body) => {
            calls.push({ url, method, body });
            if (url === '/api/settings/integrations' && method === 'PATCH') return { ok: true };
            if (url === '/api/settings/integrations' && method === 'GET') {
                return {
                    openai: { api_key: '***', url: 'https://proxy.example.com/v1', model: 'gpt-5', vision_api_key: '', vision_url: '', vision_model: '' },
                    food: { api_key: '', url: '', domain: '' },
                    elevenlabs: { api_key: '', agent_id: '' }
                };
            }
            return null;
        });

        // A preservation sentinel belongs to the API base loaded with it.
        await window.SettingsIntegrations.load();

        // Spy on applyOptimistic to confirm the save handler actually
        // routes through it (CLAUDE.md rule 9).
        const realApply = window.DataStore.applyOptimistic.bind(window.DataStore);
        const applySpy = vi.fn((key, mutator, tags) => realApply(key, mutator, tags));
        window.DataStore.applyOptimistic = applySpy;

        document.getElementById('integrations-openai-api-key').value = '***';
        document.getElementById('integrations-openai-url').value = 'https://proxy.example.com/v1';
        document.getElementById('integrations-openai-model').value = 'gpt-5';
        document.getElementById('integrations-elevenlabs-api-key').value = 'el-new';
        document.getElementById('integrations-elevenlabs-agent-id').value = 'agent_xyz';

        await window.SettingsIntegrations.save();

        expect(applySpy).toHaveBeenCalled();
        const [appliedKey, , appliedTags] = applySpy.mock.calls[0];
        expect(appliedKey).toBe('settings_integrations');
        expect(appliedTags).toContain('settings');

        const patchCall = calls.find((c) => c.method === 'PATCH');
        expect(patchCall).toBeTruthy();
        expect(patchCall.body.openai.api_key).toBe('***');
        expect(patchCall.body.openai.url).toBe('https://proxy.example.com/v1');
        expect(patchCall.body.elevenlabs.api_key).toBe('el-new');
        expect(patchCall.body.elevenlabs.agent_id).toBe('agent_xyz');

        // The optimistic write must never persist the raw provider key into the
        // plaintext api_cache — only the masked "***" sentinel. In cloud mode
        // the real secret lives only in the encrypted vault.
        const optimisticCache = applySpy.mock.calls[0][1](null);
        expect(optimisticCache.elevenlabs.api_key).toBe('***');
        const cached = await window.DataStore.getCached('settings_integrations');
        expect(cached.elevenlabs.api_key).not.toBe('el-new');
    });

    it('cloud mode shows the trial hint only when the trial flag is set and the vault key is empty', async () => {
        const { window, document } = env;
        window.__MEDTRACKER_CLOUD__ = true;
        for (const name of ['medtracker-trial-ai', 'medtracker-trial-voice']) {
            const meta = document.createElement('meta');
            meta.setAttribute('name', name);
            meta.setAttribute('content', '1');
            document.head.appendChild(meta);
        }

        window.apiCall = vi.fn(async () => ({
            openai: { api_key: '', url: '', model: '', vision_api_key: '', vision_url: '', vision_model: '' },
            food: { api_key: '', url: '', domain: '' },
            elevenlabs: { api_key: '***', agent_id: '' }
        }));
        await window.SettingsIntegrations.load();

        const aiHint = document.getElementById('integrations-openai-trial-hint');
        const voiceHint = document.getElementById('integrations-elevenlabs-trial-hint');
        expect(aiHint.hidden).toBe(false);          // no vault key + trial flag → hint
        expect(voiceHint.hidden).toBe(true);        // vault key present → no hint
        expect(aiHint.textContent).toContain('Trial key active');
    });

    it('cloud mode mounts the Telegram module into #telegram-settings-mount exactly once', async () => {
        const { window, document } = env;
        window.__MEDTRACKER_CLOUD__ = true;

        const mountTelegram = vi.fn();
        const loadTelegramModule = vi.fn(() => Promise.resolve({ mountTelegram }));
        window.SettingsIntegrations._setTelegramLoader(loadTelegramModule);

        window.apiCall = vi.fn(async () => ({}));

        window.SettingsIntegrations._resetTelegramMounted();

        await window.SettingsIntegrations.load();
        await new Promise(r => setTimeout(r, 0)); // tick for import resolution

        expect(loadTelegramModule).toHaveBeenCalledTimes(1);
        expect(mountTelegram).toHaveBeenCalledTimes(1);
        expect(mountTelegram.mock.calls[0][0]).toBe(document.getElementById('telegram-settings-mount'));
        // med-ta2n.18 regression: cloud never gets the local sync offer.
        expect(document.querySelector('#telegram-settings-mount [data-offer-card]')).toBeNull();
        expect(document.getElementById('integrations-telegram-row').hidden).toBe(true); // until telegram.js stamps a state

        // Repeated calls shouldn't trigger another mount
        await window.SettingsIntegrations.load();
        await new Promise(r => setTimeout(r, 0));

        expect(loadTelegramModule).toHaveBeenCalledTimes(1);
        expect(mountTelegram).toHaveBeenCalledTimes(1);
    });

    // med-4mva: local mode has no Telegram server; mounting telegram.js there
    // fetched /api/telegram/status straight off the shell's origin (404).
    // med-ta2n.18: instead, the row says "Needs sync" and the page is a sync
    // offer whose Turn on sync takes W5's branch (invite waiting → P3, else
    // the Sync & backup page) — still with no telegram.js and no /api/telegram/*.
    describe('local mode', () => {
        let loadTelegramModule;
        let fetchSpy;
        beforeEach(() => {
            const { window, document } = env;
            document.documentElement.classList.add('wg-local-vault');
            loadTelegramModule = vi.fn(() => Promise.resolve({ mountTelegram: vi.fn() }));
            window.SettingsIntegrations._setTelegramLoader(loadTelegramModule);
            window.SettingsIntegrations._resetTelegramMounted();
            window.apiCall = vi.fn(async () => ({}));
            fetchSpy = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
            window.fetch = fetchSpy;
        });
        afterEach(() => { env.document.documentElement.classList.remove('wg-local-vault'); });

        const telegramRequests = () => [
            ...env.window.apiCall.mock.calls.map(([u]) => String(u)),
            ...fetchSpy.mock.calls.map(([u]) => String(u)),
        ].filter((u) => u.includes('/api/telegram'));

        it('never mounts telegram.js; the row shows "Needs sync" and the page renders the offer', async () => {
            const { window, document } = env;
            window.InviteSheet = { pending: vi.fn(async () => null), base: vi.fn(async () => 'app.example.com'), offer: vi.fn() };
            await window.SettingsIntegrations.load();
            await window.SettingsIntegrations.load();
            await new Promise(r => setTimeout(r, 0));

            expect(loadTelegramModule).not.toHaveBeenCalled();
            const row = document.getElementById('integrations-telegram-row');
            expect(row.hidden).toBe(false);
            expect(row.querySelector('[data-settings-summary="telegram"]').textContent).toBe('Needs sync');
            window.SettingsIntegrations.syncTelegramRow(); // every Settings summary refresh runs it
            expect(row.hidden).toBe(false);
            expect(row.querySelector('[data-settings-summary="telegram"]').textContent).toBe('Needs sync');

            const page = window.SettingsView.openSettingsPage('telegram');
            const mount = page.el.querySelector('#telegram-settings-mount');
            expect(mount.querySelectorAll('[data-offer-card]')).toHaveLength(1); // a second load() repaints nothing
            expect(mount.querySelector('.wg-eyebrow').textContent).toBe('Telegram');
            expect(mount.textContent).toMatch(/Do almost everything from your messenger/);
            expect(mount.textContent).toMatch(/passes through Telegram and our relay as plain text/);
            expect(mount.textContent).not.toMatch(/nothing leaves/i);
            expect(mount.querySelectorAll('.wg-facts li')).toHaveLength(4);
            const how = mount.querySelector('[data-action="telegram-invite-how"]');
            expect(how.hidden).toBe(false);
            expect(how.getAttribute('href')).toBe('https://app.example.com/');
            page.close();
            expect(telegramRequests()).toEqual([]);
        });

        it('Turn on sync opens the Sync & backup page when no invite is waiting', async () => {
            const { window, document } = env;
            window.InviteSheet = { pending: vi.fn(async () => null), base: vi.fn(async () => ''), offer: vi.fn() };
            await window.SettingsIntegrations.load();
            const page = window.SettingsView.openSettingsPage('telegram');
            expect(page.el.querySelector('[data-action="telegram-invite-how"]').hidden).toBe(true); // no base
            page.el.querySelector('[data-action="telegram-turn-on-sync"]').click();
            await vi.waitFor(() => expect(document.querySelector('.wg-settings-pages [data-settings-page="backup"]')).toBeNull());
            expect(document.getElementById('importexport-sync-group')).not.toBeNull();
            expect(window.InviteSheet.offer).not.toHaveBeenCalled();
            expect(telegramRequests()).toEqual([]);
        });

        it('Turn on sync opens P3 when an invite is waiting in the shell slot', async () => {
            const { window } = env;
            const invite = 'https://abc.app.example.com/#claim=0a1b2c';
            window.InviteSheet = { pending: vi.fn(async () => invite), base: vi.fn(async () => ''), offer: vi.fn() };
            await window.SettingsIntegrations.load();
            const page = window.SettingsView.openSettingsPage('telegram');
            page.el.querySelector('[data-action="telegram-turn-on-sync"]').click();
            await vi.waitFor(() => expect(window.InviteSheet.offer).toHaveBeenCalledWith(invite, { kit: true }));
            page.close();
        });

        it('the Notifications page hint routes to Turn on sync too', async () => {
            const { window, document } = env;
            window.InviteSheet = { pending: vi.fn(async () => null), base: vi.fn(async () => ''), offer: vi.fn() };
            const hint = document.getElementById('local-notify-telegram-sync');
            expect(hint.closest('.wg-local-only')).not.toBeNull(); // CSS-gated: local mode only
            expect(hint.parentElement.textContent).toBe('Want reminders in Telegram too? Turn on sync.');
            hint.click();
            await vi.waitFor(() => expect(document.querySelector('.wg-settings-pages [data-settings-page="backup"]')).toBeNull());
        });
    });

    it('hides the trial hints when no trial meta flags are injected (server mode / no trial envs)', async () => {
        const { window, document } = env;
        window.apiCall = vi.fn(async () => ({
            openai: { api_key: '', url: '', model: '', vision_api_key: '', vision_url: '', vision_model: '' },
            food: { api_key: '', url: '', domain: '' },
            elevenlabs: { api_key: '', agent_id: '' }
        }));
        await window.SettingsIntegrations.load();
        expect(document.getElementById('integrations-openai-trial-hint').hidden).toBe(true);
        expect(document.getElementById('integrations-elevenlabs-trial-hint').hidden).toBe(true);
    });

    // Trial-consent rows (bd med-yor.2 Task 4): per-scope grant/revoke
    // controls under the trial hints, backed by the encrypted-vault
    // trialconsent record via /api/settings/trial-consent.
    function installTrialMetas(document, names) {
        for (const name of names) {
            const meta = document.createElement('meta');
            meta.setAttribute('name', name);
            meta.setAttribute('content', '1');
            document.head.appendChild(meta);
        }
    }

    function trialConsentApiStub(window, consent) {
        const state = { ...consent };
        return vi.fn(async (url, method, body) => {
            if (url === '/api/settings/integrations') {
                return { openai: {}, food: {}, elevenlabs: {} };
            }
            if (url === '/api/settings/trial-consent' && method === 'GET') {
                return { ...state };
            }
            if (url === '/api/settings/trial-consent' && method === 'PATCH') {
                Object.assign(state, body);
                state.updated_at = 99;
                return { ...state };
            }
            return null;
        });
    }

    function consentRow(document, scope) {
        return document.querySelector(`[data-trial-consent-scope="${scope}"]`);
    }

    it('cloud + trial flags: renders ai + tg rows under the AI hint and a voice row under the voice hint, with states from the GET', async () => {
        const { window, document } = env;
        window.__MEDTRACKER_CLOUD__ = true;
        installTrialMetas(document, ['medtracker-trial-ai', 'medtracker-trial-voice']);
        window.apiCall = trialConsentApiStub(window, { ai: true, voice: null, tg: false, updated_at: 1 });

        await window.SettingsIntegrations.load();
        await new Promise(r => setTimeout(r, 0));

        const aiRow = consentRow(document, 'ai');
        const tgRow = consentRow(document, 'tg');
        const voiceRow = consentRow(document, 'voice');
        expect(aiRow).not.toBeNull();
        expect(tgRow).not.toBeNull();
        expect(voiceRow).not.toBeNull();

        // ai + tg live under the OpenAI hint's container, voice under ElevenLabs'.
        expect(document.getElementById('integrations-openai-trial-hint-consent').contains(aiRow)).toBe(true);
        expect(document.getElementById('integrations-openai-trial-hint-consent').contains(tgRow)).toBe(true);
        expect(document.getElementById('integrations-elevenlabs-trial-hint-consent').contains(voiceRow)).toBe(true);

        expect(aiRow.querySelector('[data-trial-consent-state]').textContent).toBe('Allowed');
        expect(aiRow.querySelector('[data-trial-consent-action]').textContent).toBe('Revoke');
        expect(tgRow.querySelector('[data-trial-consent-state]').textContent).toBe('Not allowed');
        expect(tgRow.querySelector('[data-trial-consent-action]').textContent).toBe('Allow');
        expect(voiceRow.querySelector('[data-trial-consent-state]').textContent).toBe('Not asked');
        expect(voiceRow.querySelector('[data-trial-consent-action]').textContent).toBe('Allow');

        // The tg disclosure must be honest about what that scope covers.
        expect(tgRow.textContent).toMatch(/Telegram assistant/i);
        expect(tgRow.textContent).toMatch(/vault/i);
    });

    it('renders no consent rows without trial meta flags (server mode / no trial envs)', async () => {
        const { window, document } = env;
        window.apiCall = vi.fn(async () => ({ openai: {}, food: {}, elevenlabs: {} }));
        await window.SettingsIntegrations.load();
        await new Promise(r => setTimeout(r, 0));
        expect(document.querySelector('[data-trial-consent-scope]')).toBeNull();
        // The consent record is never even read outside cloud+trial.
        expect(window.apiCall).not.toHaveBeenCalledWith('/api/settings/trial-consent', 'GET');
    });

    it('a failed consent refresh keeps prior state instead of repainting granted scopes as "Not asked"', async () => {
        const { window, document } = env;
        window.__MEDTRACKER_CLOUD__ = true;
        installTrialMetas(document, ['medtracker-trial-ai', 'medtracker-trial-voice']);
        // apiCall's offline wrapper swallows GET failures into null (no throw)
        // — loadTrialConsent must not let that null wipe the loaded record.
        let failGets = false;
        const stub = trialConsentApiStub(window, { ai: true, voice: null, tg: null, updated_at: 1 });
        window.apiCall = vi.fn(async (url, method, body) => {
            if (url === '/api/settings/trial-consent' && method === 'GET' && failGets) return null;
            return stub(url, method, body);
        });

        await window.SettingsIntegrations.load();
        await new Promise(r => setTimeout(r, 0));
        expect(consentRow(document, 'ai').querySelector('[data-trial-consent-state]').textContent).toBe('Allowed');

        // Grant voice through the dialog; the post-grant refresh GET fails.
        failGets = true;
        consentRow(document, 'voice').querySelector('[data-trial-consent-action]').click();
        await new Promise(r => setTimeout(r, 0));
        document.querySelector('.wg-trial-consent-modal [data-trial-consent-choice="allow"]').click();
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));

        // ai keeps its real granted state; the failed refresh didn't reset it.
        expect(consentRow(document, 'ai').querySelector('[data-trial-consent-state]').textContent).toBe('Allowed');
        expect(consentRow(document, 'ai').querySelector('[data-trial-consent-action]').textContent).toBe('Revoke');
        // The just-granted voice scope shows the durable grant even though
        // the reconciliation GET failed — request() resolving true is
        // authoritative (its PATCH landed).
        expect(consentRow(document, 'voice').querySelector('[data-trial-consent-state]').textContent).toBe('Allowed');
        expect(consentRow(document, 'voice').querySelector('[data-trial-consent-action]').textContent).toBe('Revoke');
    });

    it('Allow opens the consent disclosure dialog — the grant only lands after the dialog Allow', async () => {
        const { window, document } = env;
        window.__MEDTRACKER_CLOUD__ = true;
        installTrialMetas(document, ['medtracker-trial-ai']);
        window.apiCall = trialConsentApiStub(window, { ai: true, voice: null, tg: null, updated_at: 1 });

        await window.SettingsIntegrations.load();
        await new Promise(r => setTimeout(r, 0));

        // tg starts "Not asked" → the row's Allow mounts the disclosure
        // dialog instead of PATCHing directly (for `tg` this row is the only
        // grant path, so the dialog is the only place the disclosure shows).
        consentRow(document, 'tg').querySelector('[data-trial-consent-action]').click();
        await new Promise(r => setTimeout(r, 0));
        expect(window.apiCall).not.toHaveBeenCalledWith('/api/settings/trial-consent', 'PATCH', expect.anything());
        const dialog = document.querySelector('.wg-trial-consent-modal');
        expect(dialog).not.toBeNull();
        expect(dialog.getAttribute('data-trial-consent-scope')).toBe('tg');

        dialog.querySelector('[data-trial-consent-choice="allow"]').click();
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
        expect(window.apiCall).toHaveBeenCalledWith('/api/settings/trial-consent', 'PATCH', { tg: true });
        expect(consentRow(document, 'tg').querySelector('[data-trial-consent-state]').textContent).toBe('Allowed');
        expect(consentRow(document, 'tg').querySelector('[data-trial-consent-action]').textContent).toBe('Revoke');
    });

    it('a dismissed disclosure dialog persists nothing and leaves the row Not asked', async () => {
        const { window, document } = env;
        window.__MEDTRACKER_CLOUD__ = true;
        installTrialMetas(document, ['medtracker-trial-ai']);
        window.apiCall = trialConsentApiStub(window, { ai: null, voice: null, tg: null, updated_at: 1 });

        await window.SettingsIntegrations.load();
        await new Promise(r => setTimeout(r, 0));

        consentRow(document, 'ai').querySelector('[data-trial-consent-action]').click();
        await new Promise(r => setTimeout(r, 0));
        document.querySelector('.mt-confirm-backdrop').click();
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));

        expect(window.apiCall).not.toHaveBeenCalledWith('/api/settings/trial-consent', 'PATCH', expect.anything());
        expect(consentRow(document, 'ai').querySelector('[data-trial-consent-state]').textContent).toBe('Not asked');
    });

    // med-6xb9: a skipped onboarding must still find the free trial — the
    // cloud entry leads the page, and Today's card asks the same question.
    // med-ckm5.10 (kit A1): the trial is one WGOfferCard — on offer, then ON
    // with "Turn off the trial", with the own-key rows below it.
    const trialCard = (document) => document.querySelector('#integrations-trial-card [data-offer-card]');

    it('cloud: the "Try AI for free" card leads the page while the trial is on offer, starts the ai consent, then shows ON and turns off', async () => {
        const { window, document } = env;
        window.__MEDTRACKER_CLOUD__ = true;
        installTrialMetas(document, ['medtracker-trial-ai']);
        window.apiCall = trialConsentApiStub(window, { ai: null, voice: null, tg: null, updated_at: 1 });

        await window.SettingsIntegrations.load();
        await new Promise(r => setTimeout(r, 0));

        const offer = document.getElementById('integrations-trial');
        expect(offer.classList.contains('hidden')).toBe(false);
        expect(document.querySelector('#settings-integrations > :not(p)')).toBe(offer);
        expect(trialCard(document).matches('.wg-card.wg-card--accent')).toBe(true);
        expect(trialCard(document).getAttribute('data-trial-state')).toBe('offer');
        expect(trialCard(document).querySelector('.wg-card__title').textContent).toBe('Try AI for free');
        expect([...document.querySelectorAll('#integrations-trial [data-own-key-state]')].map((n) => n.textContent))
            .toEqual(['Not set', 'Not set']);
        expect(await window.SettingsIntegrations.trialOffer()).toBe(true);

        trialCard(document).querySelector('[data-action="trial-start"]').click();
        await new Promise(r => setTimeout(r, 0));
        const dialog = document.querySelector('.wg-trial-consent-modal');
        expect(dialog.getAttribute('data-trial-consent-scope')).toBe('ai');
        dialog.querySelector('[data-trial-consent-choice="allow"]').click();
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));

        expect(window.apiCall).toHaveBeenCalledWith('/api/settings/trial-consent', 'PATCH', { ai: true });
        expect(offer.classList.contains('hidden')).toBe(false);
        expect(trialCard(document).getAttribute('data-trial-state')).toBe('on');
        expect(trialCard(document).querySelector('.wg-chip--ok').textContent).toBe('On');
        expect(await window.SettingsIntegrations.trialOffer()).toBe(false);

        trialCard(document).querySelector('[data-action="trial-stop"]').click();
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
        expect(window.apiCall).toHaveBeenCalledWith('/api/settings/trial-consent', 'PATCH', { ai: false });
        expect(trialCard(document).getAttribute('data-trial-state')).toBe('offer');
    });

    it('cloud: own-key rows show Set and jump to the key field (no food row since med-bpp9)', async () => {
        const { window, document } = env;
        window.__MEDTRACKER_CLOUD__ = true;
        installTrialMetas(document, ['medtracker-trial-ai']);
        window.apiCall = vi.fn(async (url) => (url === '/api/settings/integrations'
            ? { openai: { api_key: '***' }, elevenlabs: {} }
            : { ai: true, updated_at: 1 }));
        await window.SettingsIntegrations.load();
        await new Promise(r => setTimeout(r, 0));
        expect(document.querySelector('#integrations-trial [data-own-key="food"]')).toBeNull();
        const row = document.querySelector('#integrations-trial [data-own-key="openai"]');
        expect(row.querySelector('[data-own-key-state]').textContent).toBe('Set');
        row.click();
        expect(document.activeElement).toBe(document.getElementById('integrations-openai-api-key'));
    });

    it('cloud: no trial entry or offer once an own key is saved, without the trial flag, or before consent loads', async () => {
        const { window, document } = env;
        window.__MEDTRACKER_CLOUD__ = true;
        const offer = document.getElementById('integrations-trial');

        // No trial flag (server without TRIAL_OPENAI_API_KEY): nothing to offer.
        window.apiCall = trialConsentApiStub(window, { ai: null, updated_at: 1 });
        await window.SettingsIntegrations.load();
        await new Promise(r => setTimeout(r, 0));
        expect(offer.classList.contains('hidden')).toBe(true);
        expect(await window.SettingsIntegrations.trialOffer()).toBe(false);

        // Own key stored: the trial is beside the point.
        installTrialMetas(document, ['medtracker-trial-ai']);
        window.apiCall = vi.fn(async (url) => (url === '/api/settings/integrations'
            ? { openai: { api_key: '***' }, food: {}, elevenlabs: {} }
            : { ai: null, updated_at: 1 }));
        await window.SettingsIntegrations.load();
        await new Promise(r => setTimeout(r, 0));
        expect(offer.classList.contains('hidden')).toBe(true);
        expect(await window.SettingsIntegrations.trialOffer()).toBe(false);
    });

    it('a declined consent dialog leaves the trial on offer', async () => {
        const { window, document } = env;
        window.__MEDTRACKER_CLOUD__ = true;
        installTrialMetas(document, ['medtracker-trial-ai']);
        window.apiCall = trialConsentApiStub(window, { ai: null, updated_at: 1 });
        await window.SettingsIntegrations.load();
        await new Promise(r => setTimeout(r, 0));

        const started = window.SettingsIntegrations.startTrial();
        await new Promise(r => setTimeout(r, 0));
        document.querySelector('.mt-confirm-backdrop').click();
        expect(await started).toBe(false);
        expect(document.getElementById('integrations-trial').classList.contains('hidden')).toBe(false);
        expect(trialCard(document).getAttribute('data-trial-state')).toBe('offer');
    });

    it('Revoke PATCHes the single scope through DataStore.applyOptimistic with no dialog', async () => {
        const { window, document } = env;
        window.__MEDTRACKER_CLOUD__ = true;
        installTrialMetas(document, ['medtracker-trial-ai']);
        window.apiCall = trialConsentApiStub(window, { ai: true, voice: null, tg: null, updated_at: 1 });

        await window.SettingsIntegrations.load();
        await new Promise(r => setTimeout(r, 0));

        const realApply = window.DataStore.applyOptimistic.bind(window.DataStore);
        const applySpy = vi.fn((key, mutator, tags) => realApply(key, mutator, tags));
        window.DataStore.applyOptimistic = applySpy;

        // ai starts "Allowed" → the button revokes it directly.
        consentRow(document, 'ai').querySelector('[data-trial-consent-action]').click();
        await new Promise(r => setTimeout(r, 0));
        expect(document.querySelector('.wg-trial-consent-modal')).toBeNull();
        expect(applySpy).toHaveBeenCalled();
        expect(applySpy.mock.calls[0][0]).toBe('settings_trial_consent');
        expect(window.apiCall).toHaveBeenCalledWith('/api/settings/trial-consent', 'PATCH', { ai: false });
        expect(consentRow(document, 'ai').querySelector('[data-trial-consent-state]').textContent).toBe('Not allowed');
        expect(consentRow(document, 'ai').querySelector('[data-trial-consent-action]').textContent).toBe('Allow');
    });

    it('rolls back the optimistic consent state and cache row when the revoke PATCH fails', async () => {
        const { window, document } = env;
        window.__MEDTRACKER_CLOUD__ = true;
        installTrialMetas(document, ['medtracker-trial-ai']);

        const prior = { ai: true, voice: null, tg: null, updated_at: 1 };
        await window.DataStore.setCachedWithTags('settings_trial_consent', prior, ['settings']);
        window.apiCall = vi.fn(async (url, method) => {
            if (url === '/api/settings/integrations') return { openai: {}, food: {}, elevenlabs: {} };
            if (url === '/api/settings/trial-consent' && method === 'GET') return { ...prior };
            return null; // PATCH fails (offline / server error)
        });
        const alerts = [];
        window.safeAlert = (msg) => alerts.push(msg);

        await window.SettingsIntegrations.load();
        await new Promise(r => setTimeout(r, 0));

        consentRow(document, 'ai').querySelector('[data-trial-consent-action]').click();
        await new Promise(r => setTimeout(r, 0));

        expect(consentRow(document, 'ai').querySelector('[data-trial-consent-state]').textContent).toBe('Allowed');
        expect(await window.DataStore.getCached('settings_trial_consent')).toEqual(prior);
        expect(alerts[0]).toContain('Failed to update trial consent');
    });

    it('save() rolls back the optimistic cache row when the PATCH fails', async () => {
        const { window, document } = env;

        // Seed an initial cached row so the rollback has something to
        // restore to.
        const priorPayload = {
            openai: { api_key: '', url: '', model: '', vision_api_key: '', vision_url: '', vision_model: '' },
            food: { api_key: '', url: '', domain: '' },
            elevenlabs: { api_key: '', agent_id: '' }
        };
        await window.DataStore.setCachedWithTags('settings_integrations', priorPayload, ['settings', 'integrations']);

        document.getElementById('integrations-openai-api-key').value = 'sk-new-key';

        window.apiCall = vi.fn(async () => null); // simulate offline / failure

        await window.SettingsIntegrations.save();

        const cached = await window.DataStore.getCached('settings_integrations');
        expect(cached).toEqual(priorPayload);
    });

    // bd med-byom — the model fields become native comboboxes. Everything here
    // is about the field staying free text: the datalist is a suggestion
    // surface, and no failure of it may change what the user can type or save.
    describe('model-id suggestions', () => {
        const OPTIONS = {
            text: 'integrations-openai-model-options',
            vision: 'integrations-openai-vision-model-options'
        };
        const BUTTONS = {
            text: 'integrations-openai-model-load',
            vision: 'integrations-openai-vision-model-load'
        };
        const NOTES = {
            text: 'integrations-openai-model-note',
            vision: 'integrations-openai-vision-model-note'
        };

        function optionValues(document, scope) {
            return [...document.getElementById(OPTIONS[scope]).querySelectorAll('option')].map((o) => o.value);
        }

        it('wires each model input to its own Choose button and keeps it free text', () => {
            const { document } = env;
            for (const scope of ['text', 'vision']) {
                expect(document.getElementById(OPTIONS[scope]), `missing datalist for ${scope}`).not.toBeNull();
                const button = document.getElementById(BUTTONS[scope]);
                expect(button, `missing load button for ${scope}`).not.toBeNull();
                expect(button.textContent.trim()).toBe('Choose');
            }
            // The input itself must stay a plain text field — a <select> or a
            // pattern here would turn the list into validation.
            expect(document.getElementById('integrations-openai-model').tagName).toBe('INPUT');
            expect(document.getElementById('integrations-openai-model').hasAttribute('pattern')).toBe(false);
        });

        it('nothing is fetched on load() or on typing — only on the explicit click', async () => {
            const { window, document } = env;
            const calls = [];
            window.apiCall = vi.fn(async (url) => {
                calls.push(url);
                if (url === '/api/settings/integrations') {
                    return {
                        openai: { api_key: '***', url: 'https://p.example.com/v1', model: 'gpt-5', vision_api_key: '', vision_url: '', vision_model: '' },
                        food: { api_key: '', url: '', domain: '' },
                        elevenlabs: { api_key: '', agent_id: '' }
                    };
                }
                return { models: ['a'], cached: false, error: '', code: '' };
            });

            await window.SettingsIntegrations.load();
            const model = document.getElementById('integrations-openai-model');
            model.value = 'https://evil.example.com';
            model.dispatchEvent(new window.Event('input', { bubbles: true }));
            document.getElementById('integrations-openai-url').value = 'https://evil.example.com/v1';
            document.getElementById('integrations-openai-url').dispatchEvent(new window.Event('input', { bubbles: true }));

            expect(calls.some((u) => u.includes('/models'))).toBe(false);

            // The click is the only trigger, and it is wired at bind time.
            expect(document.getElementById(BUTTONS.text).dataset.integrationsBound).toBe('1');
            await window.SettingsIntegrations._loadModels('text');
            expect(calls.some((u) => u.includes('/models'))).toBe(true);
        });

        it('a load populates the datalist from the shim; the next one refreshes', async () => {
            const { window, document } = env;
            const urls = [];
            window.apiCall = vi.fn(async (url) => {
                urls.push(url);
                return { models: ['gpt-4o', 'gpt-4o-mini'], cached: false, error: '', code: '' };
            });

            await window.SettingsIntegrations._loadModels('text');

            expect(optionValues(document, 'text')).toEqual(['gpt-4o', 'gpt-4o-mini']);
            expect(urls[0]).toBe('/api/settings/integrations/models?scope=text');
            expect(document.getElementById(BUTTONS.text).disabled).toBe(false);
            expect(document.getElementById(NOTES.text).hidden).toBe(false);
            expect(document.getElementById(NOTES.text).textContent).toContain('2 models');

            // The second press is a refresh, and says so on the wire so the
            // shim skips its in-memory cache.
            await window.SettingsIntegrations._loadModels('text');
            expect(urls[1]).toBe('/api/settings/integrations/models?scope=text&refresh=1');
        });

        it('the text and vision lists are independent', async () => {
            const { window, document } = env;
            window.apiCall = vi.fn(async (url) => (url.includes('scope=vision')
                ? { models: ['vision-a'], cached: false, error: '', code: '' }
                : { models: ['text-a', 'text-b'], cached: false, error: '', code: '' }));

            await window.SettingsIntegrations._loadModels('text');
            await window.SettingsIntegrations._loadModels('vision');

            expect(optionValues(document, 'text')).toEqual(['text-a', 'text-b']);
            expect(optionValues(document, 'vision')).toEqual(['vision-a']);
        });

        it('a failure leaves the field free text with a quiet note and no unhandled rejection', async () => {
            const { window, document } = env;
            const rejections = [];
            const onRejection = (e) => { rejections.push(e); };
            window.addEventListener('unhandledrejection', onRejection);

            window.apiCall = vi.fn(async () => ({
                models: [], cached: false, error: "Couldn't reach the provider. If you just saved this URL, reload the app first.", code: 'unreachable'
            }));

            document.getElementById('integrations-openai-model').value = 'my-custom-model';
            await window.SettingsIntegrations._loadModels('text');

            expect(optionValues(document, 'text')).toEqual([]);
            expect(document.getElementById(NOTES.text).textContent).toMatch(/reload the app/i);
            expect(document.getElementById(NOTES.text).hidden).toBe(false);
            // Untouched and still saveable — that is the whole contract.
            expect(document.getElementById('integrations-openai-model').value).toBe('my-custom-model');
            expect(document.getElementById(BUTTONS.text).disabled).toBe(false);
            expect(window.SettingsIntegrations._readDOMIntoPayload().openai.model).toBe('my-custom-model');

            window.removeEventListener('unhandledrejection', onRejection);
            expect(rejections).toEqual([]);
        });

        it('an unreachable route (server mode / offline) degrades the same way', async () => {
            const { window, document } = env;
            window.apiCall = vi.fn(async () => { throw new Error('404 not found'); });

            await window.SettingsIntegrations._loadModels('text');

            expect(optionValues(document, 'text')).toEqual([]);
            expect(document.getElementById(NOTES.text).textContent).toMatch(/type the model id/i);
        });

        it('a superseded in-flight load does not overwrite the newer list', async () => {
            const { window, document } = env;
            let resolveSlow;
            let call = 0;
            window.apiCall = vi.fn(async () => {
                call += 1;
                if (call === 1) return new Promise((resolve) => { resolveSlow = resolve; });
                return { models: ['fresh'], cached: false, error: '', code: '' };
            });

            const slow = window.SettingsIntegrations._loadModels('text');
            const fast = window.SettingsIntegrations._loadModels('text');
            await fast;
            expect(optionValues(document, 'text')).toEqual(['fresh']);

            resolveSlow({ models: ['stale'], cached: false, error: '', code: '' });
            await slow;
            expect(optionValues(document, 'text')).toEqual(['fresh']);
        });

        it('saving new credentials clears the stale list', async () => {
            const { window, document } = env;
            window.apiCall = vi.fn(async (url, method) => {
                if (url.includes('/models')) return { models: ['old-a'], cached: false, error: '', code: '' };
                if (method === 'PATCH') return { ok: true };
                return {
                    openai: { api_key: '***', url: 'https://new.example.com/v1', model: '', vision_api_key: '', vision_url: '', vision_model: '' },
                    food: { api_key: '', url: '', domain: '' },
                    elevenlabs: { api_key: '', agent_id: '' }
                };
            });

            await window.SettingsIntegrations._loadModels('text');
            expect(optionValues(document, 'text')).toEqual(['old-a']);

            await window.SettingsIntegrations.save();

            expect(optionValues(document, 'text')).toEqual([]);
            expect(document.getElementById(NOTES.text).hidden).toBe(true);
        });

        // med-xso6.24: Choose opens the kit choice dialog over the loaded ids;
        // the pick lands in the free-text input (WGSheet is not used yet).
        it('Choose offers the loaded models and writes the pick into the input', async () => {
            const { window, document } = env;
            window.apiCall = vi.fn(async () => ({ models: ['gpt-4o', 'gpt-4o-mini'], cached: false, error: '', code: '' }));
            window.safeChoose = vi.fn(async () => 'gpt-4o-mini');
            const input = document.getElementById('integrations-openai-model');
            input.value = 'gpt-4o';

            await window.SettingsIntegrations._chooseModel('text');

            const choices = window.safeChoose.mock.calls[0][1];
            expect(choices.map((c) => c.value)).toEqual(['gpt-4o', 'gpt-4o-mini']);
            expect(choices.find((c) => c.selected).value).toBe('gpt-4o');
            expect(input.value).toBe('gpt-4o-mini');
        });

        it('a dismissed choice or a failed load leaves the typed model alone', async () => {
            const { window, document } = env;
            const input = document.getElementById('integrations-openai-model');
            input.value = 'my-model';
            window.apiCall = vi.fn(async () => ({ models: ['a'], cached: false, error: '', code: '' }));
            window.safeChoose = vi.fn(async () => null);
            await window.SettingsIntegrations._chooseModel('text');
            expect(input.value).toBe('my-model');

            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            window.safeChoose = vi.fn();
            await window.SettingsIntegrations._chooseModel('text');
            expect(window.safeChoose).not.toHaveBeenCalled();
            expect(input.value).toBe('my-model');
        });
    });
});
