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
import { allowConsoleNoise } from './helpers/setup.js';

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
            'integrations-food-domain',
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
        // Default harness env is server mode (no __MEDTRACKER_CLOUD__, no Capacitor).
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
        allowConsoleNoise();
        const { window, document } = env;
        window.__MEDTRACKER_CLOUD__ = true;

        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'PATCH') return { ok: true };
            if (method === 'GET') return { openai: {}, food: {}, elevenlabs: {} };
            return null;
        });
        // load() re-applies note visibility for the (now cloud) mode.
        await window.SettingsIntegrations.load();
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
                food: { api_key: '***', url: '', domain: 'fastfood.example.com' },
                elevenlabs: { api_key: '', agent_id: 'agent_abc' }
            };
        });

        const result = await window.SettingsIntegrations.load();
        expect(result).toBeTruthy();
        expect(document.getElementById('integrations-openai-api-key').value).toBe('***');
        expect(document.getElementById('integrations-openai-url').value).toBe('https://api.openai.com/v1');
        expect(document.getElementById('integrations-openai-model').value).toBe('gpt-5');
        expect(document.getElementById('integrations-food-api-key').value).toBe('***');
        expect(document.getElementById('integrations-food-domain').value).toBe('fastfood.example.com');
        expect(document.getElementById('integrations-elevenlabs-api-key').value).toBe('');
        expect(document.getElementById('integrations-elevenlabs-agent-id').value).toBe('agent_abc');
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
        allowConsoleNoise();
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
});
