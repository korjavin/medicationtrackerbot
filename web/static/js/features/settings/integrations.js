// features/settings/integrations.js — owns the Settings → Integrations
// section that lets the user configure OpenAI / Food DB / ElevenLabs
// credentials from inside the app (Task 3 of the local-only-mode
// foundation plan). The section is invisible to the MCP agent and only
// reachable via the Settings screen.
//
// Wire shape (GET /api/settings/integrations):
//   {
//     "openai":     { api_key, url, model, vision_api_key, vision_url, vision_model },
//     "food":       { api_key, url, domain },   // `domain` is read-only legacy; no input
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
        // No `domain` entry: it was a hostname-shorthand duplicate of `url`,
        // ignored whenever `url` was set, and nobody could tell the two apart
        // (med-xrr). The field is gone from the UI; the resolvers still read a
        // stored food.domain, and leaving it out of FIELD_IDS is what preserves
        // it — readDOMIntoPayload would otherwise send '' for the absent input
        // and both patch paths treat '' as "clear this".
        food: {
            api_key: 'integrations-food-api-key',
            url: 'integrations-food-url'
        },
        elevenlabs: {
            api_key: 'integrations-elevenlabs-api-key',
            agent_id: 'integrations-elevenlabs-agent-id'
        }
    };

    // Secret-bearing fields per group — mirrors INTEGRATIONS_SECRET_FIELDS in
    // web/domain/settings.js and the server's handleGetIntegrations masking.
    const SECRET_FIELDS = {
        openai: new Set(['api_key', 'vision_api_key']),
        food: new Set(['api_key']),
        elevenlabs: new Set(['api_key'])
    };

    function getInput(id) {
        return document.getElementById(id);
    }

    // maskPayload converts a raw DOM payload into the masked shape the server
    // GET returns: secret fields collapse to "***" when set, "" when cleared,
    // and the "***" sentinel (user didn't re-enter) stays "***". Used for the
    // optimistic cache write so cleartext provider keys never land in the
    // plaintext api_cache store — in cloud mode the real secret lives only in
    // the encrypted vault. The raw payload still goes to the PATCH itself.
    function maskPayload(payload) {
        const out = {};
        for (const group of Object.keys(payload || {})) {
            out[group] = {};
            const secrets = SECRET_FIELDS[group] || new Set();
            for (const field of Object.keys(payload[group] || {})) {
                const value = payload[group][field];
                out[group][field] = secrets.has(field)
                    ? (value ? '***' : '')
                    : value;
            }
        }
        return out;
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
        applyCloudFoodDbPlaceholder();
        applyTrialHints();
        applyRestartNoteVisibility();
    }

    // applyTrialHints shows "Trial key active (rate-limited)…" next to the
    // OpenAI / ElevenLabs key fields when the operator's trial key is
    // available (the boolean <meta name="medtracker-trial-ai/voice"> flags
    // injected by cmd/cloud) and the user has no own key in the vault
    // (masked value "***" means a key is stored). Cloud-only: bot mode
    // never injects those tags.
    function applyTrialHints() {
        if (!window.__MEDTRACKER_CLOUD__) return;
        const hints = [
            ['integrations-openai-trial-hint', 'medtracker-trial-ai', FIELD_IDS.openai.api_key],
            ['integrations-elevenlabs-trial-hint', 'medtracker-trial-voice', FIELD_IDS.elevenlabs.api_key]
        ];
        for (const [hintId, metaName, inputId] of hints) {
            const hint = document.getElementById(hintId);
            if (!hint) continue;
            const trialOn = document.querySelector('meta[name="' + metaName + '"]')?.content === '1';
            const keySet = !!(getInput(inputId)?.value);
            hint.hidden = !trialOn || keySet;
        }
        renderTrialConsentRows();
    }

    // Trial-consent rows (bd med-yor.2 Task 4). When a trial flag is active
    // in cloud mode, each applicable consent scope gets a row under the
    // provider's trial hint showing its state (Allowed / Not allowed / Not
    // asked) with an Allow/Revoke button. Granting routes through the
    // TrialConsent disclosure dialog (which persists the choice itself);
    // revoking PATCHes the encrypted-vault trialconsent record directly via
    // DataStore.applyOptimistic, like saveIntegrations.
    const CONSENT_CACHE_KEY = 'settings_trial_consent';
    const CONSENT_CACHE_TAGS = ['settings'];
    // [meta flag, hint element to mount after, [scope, label]...]
    const CONSENT_MOUNTS = [
        ['medtracker-trial-ai', 'integrations-openai-trial-hint', [
            ['ai', 'Trial AI — meal descriptions & photos'],
            ['tg', 'Trial AI — Telegram assistant & narrator (reads vault data to answer)']
        ]],
        ['medtracker-trial-voice', 'integrations-elevenlabs-trial-hint', [
            ['voice', 'Trial voice — operator’s ElevenLabs agent']
        ]]
    ];
    let _trialConsent = null;

    function consentStateText(value) {
        if (value === true) return 'Allowed';
        if (value === false) return 'Not allowed';
        return 'Not asked';
    }

    function renderTrialConsentRows() {
        for (const [metaName, hintId, scopes] of CONSENT_MOUNTS) {
            const hint = document.getElementById(hintId);
            if (!hint) continue;
            const containerId = hintId + '-consent';
            let container = document.getElementById(containerId);
            const trialOn = window.__MEDTRACKER_CLOUD__
                && document.querySelector('meta[name="' + metaName + '"]')?.content === '1';
            if (!trialOn) {
                if (container) container.remove();
                continue;
            }
            if (!container) {
                container = document.createElement('div');
                container.id = containerId;
                container.className = 'wg-settings-integrations__consent';
                hint.insertAdjacentElement('afterend', container);
            }
            container.textContent = '';
            for (const [scope, labelText] of scopes) {
                const value = _trialConsent ? _trialConsent[scope] : null;
                const row = document.createElement('div');
                row.className = 'wg-settings-integrations__consent-row';
                row.setAttribute('data-trial-consent-scope', scope);

                const label = document.createElement('span');
                label.className = 'wg-settings-integrations__note';
                label.textContent = labelText + ': ';
                row.appendChild(label);

                const state = document.createElement('span');
                state.className = 'wg-mono-display';
                state.setAttribute('data-trial-consent-state', String(value));
                state.textContent = consentStateText(value);
                row.appendChild(state);

                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'wg-gloss';
                btn.setAttribute('data-trial-consent-action', scope);
                btn.textContent = value === true ? 'Revoke' : 'Allow';
                btn.addEventListener('click', () => { setTrialConsentScope(scope, value !== true); });
                row.appendChild(btn);

                container.appendChild(row);
            }
        }
    }

    async function setTrialConsentScope(scope, allowed) {
        if (allowed) {
            // Granting is a consent ceremony: the disclosure dialog (data
            // categories, operator-account transit, BYO alternative) must be
            // seen before a scope flips true — for `tg` this row is the ONLY
            // grant path (the drain refuses, never prompts), so skipping the
            // dialog here would skip the disclosure entirely. request()
            // persists the choice itself; re-GET to repaint whatever landed
            // (grant, refusal, or nothing on dismissal).
            if (window.TrialConsent && typeof window.TrialConsent.request === 'function') {
                await window.TrialConsent.request(scope);
                await loadTrialConsent();
            } else if (typeof safeAlert === 'function') {
                safeAlert('Consent dialog unavailable — reload and try again');
            }
            return;
        }
        const prev = _trialConsent;
        const next = { ...(prev || {}), [scope]: allowed };
        let handle = null;
        if (window.DataStore && typeof window.DataStore.applyOptimistic === 'function') {
            handle = await window.DataStore.applyOptimistic(CONSENT_CACHE_KEY, () => next, CONSENT_CACHE_TAGS);
        }
        _trialConsent = next;
        renderTrialConsentRows();

        let fresh = null;
        try {
            fresh = (typeof apiCall === 'function')
                ? await apiCall('/api/settings/trial-consent', 'PATCH', { [scope]: allowed })
                : null;
        } catch (_) { fresh = null; }

        if (!fresh) {
            if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
            _trialConsent = prev;
            renderTrialConsentRows();
            if (typeof safeAlert === 'function') safeAlert('Failed to update trial consent');
            return;
        }
        if (handle) { try { await handle.commit(fresh); } catch (_) { /* best-effort */ } }
        _trialConsent = fresh;
        renderTrialConsentRows();
    }

    async function loadTrialConsent() {
        if (!window.__MEDTRACKER_CLOUD__ || typeof apiCall !== 'function') return;
        const anyTrial = CONSENT_MOUNTS.some(([metaName]) =>
            document.querySelector('meta[name="' + metaName + '"]')?.content === '1');
        if (!anyTrial) return;
        try {
            _trialConsent = await apiCall('/api/settings/trial-consent', 'GET');
        } catch (_) { /* keep prior state; rows fall back to "Not asked" */ }
        renderTrialConsentRows();
    }

    // applyCloudFoodDbPlaceholder shows the operator's default food-DB URL
    // (the <meta name="medtracker-food-db-url"> tag injected by cmd/cloud —
    // see internal/cloudserver/router.go; a CSP-safe carrier since the
    // origin's script-src 'self' blocks inline scripts) as the field's
    // placeholder when the user hasn't set their own override. Cloud-only:
    // bot mode never injects that tag, so the placeholder stays empty there.
    function applyCloudFoodDbPlaceholder() {
        if (!window.__MEDTRACKER_CLOUD__) return;
        const input = getInput(FIELD_IDS.food.url);
        if (!input) return;
        input.placeholder = document.querySelector('meta[name="medtracker-food-db-url"]')?.content || '';
    }

    // The "Changes take effect after the server restarts." copy is only true for
    // the server build, which caches the AI/food/ElevenLabs clients at boot and
    // registers no hot-reload. Cloud mode reads the key from the vault per call
    // in the browser, and the mobile build registers an integrations reloader —
    // both apply changes live. Hide the note (and drop the restart wording in the
    // save toast) in those modes so the UI stops lying. (med-eas.6)
    function appliesLive() {
        if (window.__MEDTRACKER_CLOUD__) return true;
        const cap = window.Capacitor;
        return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
    }

    function applyRestartNoteVisibility() {
        const note = document.getElementById('integrations-restart-note');
        if (note) note.hidden = appliesLive();
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

    let _telegramMounted = false;
    let _telegramModuleLoader = () => import('/js/telegram.js');

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

            // Fire-and-forget: consent rows repaint when the GET lands; the
            // integrations payload itself doesn't wait on it.
            loadTrialConsent();

            if (window.__MEDTRACKER_CLOUD__) {
                const tgMount = document.getElementById('telegram-settings-mount');
                if (tgMount && !_telegramMounted) {
                    _telegramMounted = true;
                    _telegramModuleLoader()
                        .then(({ mountTelegram }) => mountTelegram(tgMount, {}))
                        .catch((err) => {
                            _telegramMounted = false;
                            console.error('[settings] telegram module failed', err);
                        });
                }
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
            handle = await window.DataStore.applyOptimistic(CACHE_KEY, () => maskPayload(payload), CACHE_TAGS);
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
        // Commit the masked server view when the reload succeeded, else the
        // locally-masked payload — never the raw cleartext keys.
        if (handle) { try { await handle.commit(fresh || maskPayload(payload)); } catch (_) { /* best-effort */ } }

        if (typeof safeAlert === 'function') {
            safeAlert(appliesLive()
                ? 'Integrations saved.'
                : 'Integrations saved. Restart the server for the new values to take effect.');
        }
    }

    function bindControls() {
        applyRestartNoteVisibility();
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

    // patch is the bare PATCH call extracted for callers that already
    // hold a fully-formed payload (e.g. the first-run integrations
    // screen — features/firstrun/screens/integrations.js). It routes
    // through apiCall so auth headers and the offline-aware error
    // surface are shared with the Settings UI path; callers do not have
    // to know about the secret-mask sentinel because they never read
    // existing secrets back, they only write fresh ones.
    async function patchIntegrations(payload) {
        if (typeof apiCall !== 'function') return null;
        return await apiCall('/api/settings/integrations', 'PATCH', payload);
    }

    window.SettingsIntegrations = {
        load: loadIntegrations,
        save: saveIntegrations,
        patch: patchIntegrations,
        // Internals exposed for the integration test suite. Not used by app code.
        _applyPayloadToDOM: applyPayloadToDOM,
        _readDOMIntoPayload: readDOMIntoPayload,
        _cacheKey: CACHE_KEY,
        _cacheTags: CACHE_TAGS,
        _resetTelegramMounted: () => { _telegramMounted = false; },
        _setTelegramLoader: (loader) => { _telegramModuleLoader = loader; }
    };
})();
