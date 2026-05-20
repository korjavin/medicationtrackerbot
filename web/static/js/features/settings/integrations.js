// features/settings/integrations.js — owns the Settings → Integrations
// section that lets the user configure OpenAI / Food DB / ElevenLabs
// credentials from inside the app (Task 3 of the local-only-mode
// foundation plan). The section is invisible to the MCP agent and only
// reachable via the Settings screen.
//
// Wire shape (GET /api/settings/integrations):
//   {
//     "openai":     { api_key, url, model, vision_api_key, vision_url, vision_model },
//     "food":       { api_key, url, domain },
//     "elevenlabs": { api_key, agent_id }
//   }
// Secret fields are masked with "***" when the server has a value
// stored. PATCH submits the same shape: "***" preserves the existing
// secret (the user didn't re-enter it), "" clears it, any other string
// overwrites it.
//
// The save handler routes through DataStore.applyOptimistic per
// CLAUDE.md rule 9 so the masked GET payload repaints immediately on
// successful save and rolls back on failure.
(function () {
    'use strict';

    const CACHE_KEY = 'settings_integrations';
    const CACHE_TAGS = ['settings', 'integrations'];

    const FIELD_IDS = {
        openai: {
            api_key: 'integrations-openai-api-key',
            url: 'integrations-openai-url',
            model: 'integrations-openai-model',
            vision_api_key: 'integrations-openai-vision-api-key',
            vision_url: 'integrations-openai-vision-url',
            vision_model: 'integrations-openai-vision-model'
        },
        food: {
            api_key: 'integrations-food-api-key',
            url: 'integrations-food-url',
            domain: 'integrations-food-domain'
        },
        elevenlabs: {
            api_key: 'integrations-elevenlabs-api-key',
            agent_id: 'integrations-elevenlabs-agent-id'
        }
    };

    function getInput(id) {
        return document.getElementById(id);
    }

    function applyPayloadToDOM(payload) {
        if (!payload || typeof payload !== 'object') return;
        for (const group of Object.keys(FIELD_IDS)) {
            const groupPayload = payload[group] || {};
            for (const field of Object.keys(FIELD_IDS[group])) {
                const input = getInput(FIELD_IDS[group][field]);
                if (!input) continue;
                const value = groupPayload[field];
                input.value = typeof value === 'string' ? value : '';
            }
        }
    }

    function readDOMIntoPayload() {
        const out = {};
        for (const group of Object.keys(FIELD_IDS)) {
            const groupPayload = {};
            for (const field of Object.keys(FIELD_IDS[group])) {
                const input = getInput(FIELD_IDS[group][field]);
                groupPayload[field] = input ? input.value : '';
            }
            out[group] = groupPayload;
        }
        return out;
    }

    async function loadIntegrations() {
        if (typeof apiCall !== 'function') return null;
        // Demo mode hides #settings-integrations via DemoBanner.mount because
        // the backend returns 403 on GET/PATCH to keep visitors from rotating
        // operator-owned provider keys. Skip the fetch when the section is
        // hidden so the demo deployment doesn't log a 403 for every Settings
        // visit and doesn't advertise the endpoint in DevTools network noise.
        const section = (typeof document !== 'undefined')
            ? document.getElementById('settings-integrations')
            : null;
        if (section && (section.hasAttribute('hidden') || section.classList.contains('hidden'))) {
            return null;
        }
        try {
            const payload = await apiCall('/api/settings/integrations', 'GET');
            if (!payload) return null;
            applyPayloadToDOM(payload);
            if (window.DataStore && typeof window.DataStore.setCachedWithTags === 'function') {
                try { await window.DataStore.setCachedWithTags(CACHE_KEY, payload, CACHE_TAGS); } catch (_) { /* best-effort cache */ }
            }
            return payload;
        } catch (e) {
            console.error('Failed to load integrations:', e);
            return null;
        }
    }

    async function saveIntegrations() {
        const payload = readDOMIntoPayload();
        const apiOk = typeof apiCall === 'function';
        const dsOk = window.DataStore && typeof window.DataStore.applyOptimistic === 'function';

        let handle = null;
        if (dsOk) {
            handle = await window.DataStore.applyOptimistic(CACHE_KEY, () => payload, CACHE_TAGS);
        }

        let res = null;
        try {
            res = apiOk ? await apiCall('/api/settings/integrations', 'PATCH', payload) : null;
        } catch (e) {
            if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
            console.error('Failed to save integrations:', e);
            if (typeof safeAlert === 'function') safeAlert('Failed to save integrations');
            return;
        }

        if (!res) {
            if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
            return;
        }

        // Reload the masked view from the server so the inputs go back to
        // showing "***" for secrets the user just entered (we no longer
        // need the cleartext on screen) and reflect any server-side
        // normalization. Commit the optimistic write with the fresh
        // payload so the cache matches what the API now returns.
        let fresh = null;
        try {
            fresh = apiOk ? await apiCall('/api/settings/integrations', 'GET') : null;
        } catch (_) { /* fall through with optimistic payload */ }
        if (fresh) applyPayloadToDOM(fresh);
        if (handle) { try { await handle.commit(fresh || payload); } catch (_) { /* best-effort */ } }

        if (typeof safeAlert === 'function') safeAlert('Integrations saved. Restart the server for the new values to take effect.');
    }

    function bindControls() {
        const btn = document.getElementById('save-integrations-btn');
        if (btn && !btn.dataset.integrationsBound) {
            btn.dataset.integrationsBound = '1';
            btn.addEventListener('click', () => { saveIntegrations(); });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindControls);
    } else {
        bindControls();
    }

    window.SettingsIntegrations = {
        load: loadIntegrations,
        save: saveIntegrations,
        // Internals exposed for the integration test suite. Not used by app code.
        _applyPayloadToDOM: applyPayloadToDOM,
        _readDOMIntoPayload: readDOMIntoPayload,
        _cacheKey: CACHE_KEY,
        _cacheTags: CACHE_TAGS
    };
})();
