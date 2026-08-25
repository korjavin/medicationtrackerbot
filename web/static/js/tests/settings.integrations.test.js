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
        expect(card.classList.contains('wg-card')).toBe(true);

        const expectedInputs = [
            'integrations-openai-api-key',
            'integrations-openai-url',
            'integrations-openai-model',
            'integrations-openai-vision-api-key',
            'integrations-openai-vision-url',
            'integrations-openai-vision-model',
            'integrations-food-api-key',
            'integrations-food-url',
            'integrations-elevenlabs-api-key',
            'integrations-elevenlabs-agent-id'
        ];

        for (const id of expectedInputs) {
            const input = document.getElementById(id);
            expect(input, `missing input #${id}`).not.toBeNull();
        }

        const saveBtn = document.getElementById('save-integrations-btn');
        expect(saveBtn).not.toBeNull();
    });

    it('server mode shows the "restart" note and restart wording in the save toast (med-eas.6)', async () => {
        const { window, document } = env;
        // Default harness env is server mode (no __MEDTRACKER_CLOUD__).
        const note = document.getElementById('integrations-restart-note');
        expect(note).not.toBeNull();
        expect(note.hidden).toBe(false);

        const alerts = [];
        window.safeAlert = (msg) => alerts.push(msg);
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'PATCH') return { ok: true };
            if (method === 'GET') return { openai: {}, food: {}, elevenlabs: {} };
            return null;
        });
        await window.SettingsIntegrations.save();
        expect(alerts[0]).toContain('Restart the server');
    });

    it('cloud mode hides the "restart" note and drops the restart wording from the save toast (med-eas.6)', async () => {
        const { window, document } = env;
        window.__MEDTRACKER_CLOUD__ = true;

        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'PATCH') return { ok: true };
            if (method === 'GET') return { openai: {}, food: {}, elevenlabs: {} };
            return null;
        });
        // load() re-applies note visibility for the (now cloud) mode.
        await window.SettingsIntegrations.load();

        // Wait for dynamic imports to resolve
        await new Promise(r => setTimeout(r, 0));

        const note = document.getElementById('integrations-restart-note');
        expect(note.hidden).toBe(true);

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
        expect(document.getElementById('integrations-food-api-key').value).toBe('***');
        expect(document.getElementById('integrations-food-url').value).toBe('https://fastfood.example.com');
        // med-xrr: a stored legacy food.domain has no input to land in.
        expect(document.getElementById('integrations-food-domain')).toBeNull();
        expect(document.getElementById('integrations-elevenlabs-api-key').value).toBe('');
        expect(document.getElementById('integrations-elevenlabs-agent-id').value).toBe('agent_abc');
    });

    // med-xrr: the Domain input is gone, but a value stored by an older build
    // must survive a save — readDOMIntoPayload sends '' for any absent input,
    // and '' means "clear" to both patch paths, so `domain` has to be absent
    // from the payload entirely rather than merely absent from the DOM.
    it('save() omits food.domain so a legacy stored value is preserved, not cleared', async () => {
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
        expect(patch.body.food).toBeTruthy();
        expect(Object.prototype.hasOwnProperty.call(patch.body.food, 'domain')).toBe(false);
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

        // Repeated calls shouldn't trigger another mount
        await window.SettingsIntegrations.load();
        await new Promise(r => setTimeout(r, 0));

        expect(loadTelegramModule).toHaveBeenCalledTimes(1);
        expect(mountTelegram).toHaveBeenCalledTimes(1);
    });

    it('non-cloud mode does not call the Telegram loader and does not mount it', async () => {
        const { window } = env;
        // explicitly set non-cloud mode
        window.__MEDTRACKER_CLOUD__ = false;

        const mountTelegram = vi.fn();
        const loadTelegramModule = vi.fn(() => Promise.resolve({ mountTelegram }));
        window.SettingsIntegrations._setTelegramLoader(loadTelegramModule);

        window.apiCall = vi.fn(async () => ({}));

        window.SettingsIntegrations._resetTelegramMounted();

        await window.SettingsIntegrations.load();
        await new Promise(r => setTimeout(r, 0));

        expect(loadTelegramModule).not.toHaveBeenCalled();
        expect(mountTelegram).not.toHaveBeenCalled();
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

        it('wires each model input to its own datalist and Load models button', () => {
            const { document } = env;
            for (const scope of ['text', 'vision']) {
                expect(document.getElementById(OPTIONS[scope]), `missing datalist for ${scope}`).not.toBeNull();
                const button = document.getElementById(BUTTONS[scope]);
                expect(button, `missing load button for ${scope}`).not.toBeNull();
                expect(button.textContent).toBe('Load models');
            }
            expect(document.getElementById('integrations-openai-model').getAttribute('list')).toBe(OPTIONS.text);
            expect(document.getElementById('integrations-openai-vision-model').getAttribute('list')).toBe(OPTIONS.vision);
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

        it('a click populates the datalist from the shim and flips the button to Refresh', async () => {
            const { window, document } = env;
            const urls = [];
            window.apiCall = vi.fn(async (url) => {
                urls.push(url);
                return { models: ['gpt-4o', 'gpt-4o-mini'], cached: false, error: '', code: '' };
            });

            await window.SettingsIntegrations._loadModels('text');

            expect(optionValues(document, 'text')).toEqual(['gpt-4o', 'gpt-4o-mini']);
            expect(urls[0]).toBe('/api/settings/integrations/models?scope=text');
            expect(document.getElementById(BUTTONS.text).textContent).toBe('Refresh models');
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

        it('saving new credentials clears the stale list and resets the button', async () => {
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
            expect(document.getElementById(BUTTONS.text).textContent).toBe('Load models');
            expect(document.getElementById(NOTES.text).hidden).toBe(true);
        });
    });
});
