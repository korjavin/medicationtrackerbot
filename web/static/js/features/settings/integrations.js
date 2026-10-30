// features/settings/integrations.js — owns the Settings → Integrations
// section that lets the user configure OpenAI / ElevenLabs
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

    // UI presets only: provider identity is always derived from the existing URL.
    const AI_PROVIDERS = [
        { id: 'openai', label: 'OpenAI', summary: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-6-luna', placeholder: 'Paste your OpenAI key', hint: 'Starts with sk-.', keys: 'https://platform.openai.com/api-keys' },
        { id: 'anthropic', label: 'Anthropic (Claude)', summary: 'Anthropic', url: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5', placeholder: 'Paste your Anthropic key', hint: 'Starts with sk-ant-.', keys: 'https://platform.claude.com/settings/keys' },
        { id: 'gemini', label: 'Google Gemini', summary: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-3.8-flash', placeholder: 'Paste your Gemini key', hint: 'Starts with AIza.', keys: 'https://aistudio.google.com/apikey' },
        { id: 'openrouter', label: 'OpenRouter', summary: 'OpenRouter', url: 'https://openrouter.ai/api/v1', model: 'openai/gpt-6-luna', placeholder: 'Paste your OpenRouter key', hint: 'Starts with sk-or-.', keys: 'https://openrouter.ai/settings/keys' },
        { id: 'other', label: 'Other', summary: 'Other', url: '', model: '', placeholder: 'Optional API key', hint: 'Optional for providers that do not require a key.', keys: '' }
    ];
    let _aiProviderDraft = 'openai'; // module-state: selected UI preset, never persisted
    let _aiProviderLoaded = null; // module-state: saved URL/model and masked main key for safe reselect
    let _aiProviderPage = null; // module-state: current integrations WGPage primary state
    let _aiProviderKeyURL = ''; // module-state: URL the current draft main key belongs to

    function normalizeProviderURL(url) {
        return String(url || '').trim().replace(/\/+$/, '');
    }

    function providerForURL(url) {
        const normalized = normalizeProviderURL(url);
        return AI_PROVIDERS.find((p) => p.id !== 'other' && (!normalized ? p.id === 'openai' : normalizeProviderURL(p.url) === normalized)) || AI_PROVIDERS[4];
    }

    function providerSaveAllowed() {
        if (_aiProviderDraft === 'other') return true;
        if (_aiProviderDraft === (_aiProviderLoaded?.provider || 'openai')) return true;
        const key = getInput(FIELD_IDS.openai.api_key)?.value.trim();
        return !!key && key !== '***';
    }

    function renderProvider() {
        const provider = AI_PROVIDERS.find((p) => p.id === _aiProviderDraft);
        const label = getInput('integrations-provider-value');
        if (label) label.textContent = provider.label;
        const urlField = getInput('integrations-openai-url-field');
        if (urlField) urlField.hidden = provider.id !== 'other';
        const key = getInput(FIELD_IDS.openai.api_key);
        if (key) key.placeholder = provider.placeholder;
        const keyLabel = getInput('integrations-provider-key-label');
        if (keyLabel) keyLabel.textContent = provider.id === 'other' ? 'API key · optional' : 'API key';
        const hint = getInput('integrations-provider-key-hint');
        if (hint) hint.textContent = provider.hint;
        const link = getInput('integrations-provider-key-link');
        if (link) {
            link.hidden = !provider.keys;
            if (provider.keys) link.href = provider.keys;
            else link.removeAttribute('href');
        }
        const note = getInput('integrations-provider-switch-note');
        if (note) {
            note.hidden = providerSaveAllowed();
            const saved = AI_PROVIDERS.find((p) => p.id === _aiProviderLoaded?.provider);
            note.querySelector('span').textContent = (_aiProviderLoaded?.key
                ? 'Your ' + saved.summary + ' key is still saved and in use. '
                : 'Your saved setup is unchanged. ') + 'Paste a ' + provider.summary + ' key to switch.';
        }
        _aiProviderPage?.setPrimaryEnabled(providerSaveAllowed());
    }

    async function chooseProvider() {
        if (typeof safeChoose !== 'function') return;
        const sub = { openai: 'GPT models', openrouter: 'Many providers with one key', other: 'Your own API URL, e.g. a local server' };
        const picked = await safeChoose('', AI_PROVIDERS.map((p) => ({ value: p.id, label: p.label, sub: sub[p.id], selected: p.id === _aiProviderDraft })), { title: 'AI provider' });
        const provider = AI_PROVIDERS.find((p) => p.id === picked);
        if (!provider || picked === _aiProviderDraft) return;
        const previous = AI_PROVIDERS.find((p) => p.id === _aiProviderDraft);
        const url = getInput(FIELD_IDS.openai.url);
        const model = getInput(FIELD_IDS.openai.model);
        const key = getInput(FIELD_IDS.openai.api_key);
        _aiProviderDraft = picked;
        if (_aiProviderLoaded && picked === _aiProviderLoaded.provider) {
            url.value = _aiProviderLoaded.url;
            model.value = _aiProviderLoaded.model;
            key.value = _aiProviderLoaded.key;
        } else {
            url.value = provider.url;
            if (!model.value.trim() || model.value === previous.model) model.value = provider.model;
            key.value = '';
        }
        _aiProviderKeyURL = normalizeProviderURL(url.value);
        key.type = 'password';
        const reveal = key.closest('.wg-secret')?.querySelector('[data-secret-reveal]');
        reveal?.setAttribute('aria-pressed', 'false');
        reveal?.setAttribute('aria-label', 'Show key');
        resetModelSuggestions();
        renderProvider();
        applyTrialHints();
    }

    const FIELD_IDS = {
        openai: {
            api_key: 'integrations-openai-api-key',
            url: 'integrations-openai-url',
            model: 'integrations-openai-model',
            vision_api_key: 'integrations-openai-vision-api-key',
            vision_url: 'integrations-openai-vision-url',
            vision_model: 'integrations-openai-vision-model'
        },
        // No `food` group (med-bpp9) and no food.domain (med-xrr): the custom
        // food-DB server UI is gone, but the resolvers still read a stored
        // food.{api_key,url,domain}. Leaving the group out of FIELD_IDS is what
        // preserves it — readDOMIntoPayload would otherwise send '' for absent
        // inputs and both patch paths treat '' as "clear this"; patchIntegrations
        // leaves omitted groups untouched.
        elevenlabs: {
            api_key: 'integrations-elevenlabs-api-key',
            agent_id: 'integrations-elevenlabs-agent-id'
        }
    };

    // Secret-bearing fields per group — mirrors INTEGRATIONS_SECRET_FIELDS in
    // web/domain/settings.js and the server's handleGetIntegrations masking.
    const SECRET_FIELDS = {
        openai: new Set(['api_key', 'vision_api_key']),
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
        const main = payload.openai || {};
        _aiProviderDraft = providerForURL(main.url).id;
        _aiProviderLoaded = {
            provider: _aiProviderDraft,
            url: typeof main.url === 'string' ? main.url : '',
            model: typeof main.model === 'string' ? main.model : '',
            // Retain only the preservation sentinel, never a raw key.
            key: main.api_key ? '***' : ''
        };
        _aiProviderKeyURL = normalizeProviderURL(main.url);
        renderProvider();
        applyTrialHints();
    }

    // applyTrialHints shows "Trial key active (rate-limited)…" next to the
    // OpenAI / ElevenLabs key fields when the operator's trial key is
    // available (the boolean <meta name="medtracker-trial-ai/voice"> flags
    // injected by cmd/cloud) and the user has no own key in the vault
    // (masked value "***" means a key is stored).
    function applyTrialHints() {
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
        renderTrialCard();
        for (const [metaName, hintId, scopes] of CONSENT_MOUNTS) {
            const hint = document.getElementById(hintId);
            if (!hint) continue;
            const containerId = hintId + '-consent';
            let container = document.getElementById(containerId);
            const trialOn = document.querySelector('meta[name="' + metaName + '"]')?.content === '1';
            if (!trialOn) {
                if (container) container.remove();
                continue;
            }
            if (!container) {
                container = document.createElement('div');
                container.id = containerId;
                container.className = 'wg-vstack';
                hint.insertAdjacentElement('afterend', container);
            }
            container.textContent = '';
            for (const [scope, labelText] of scopes) {
                const value = _trialConsent ? _trialConsent[scope] : null;
                const row = document.createElement('div');
                row.className = 'wg-hstack';
                row.setAttribute('data-trial-consent-scope', scope);

                const label = document.createElement('span');
                label.className = 'wg-hint wg-spacer';
                label.textContent = labelText + ': ';
                row.appendChild(label);

                const state = document.createElement('span');
                state.className = 'wg-meta';
                state.setAttribute('data-trial-consent-state', String(value));
                state.textContent = consentStateText(value);
                row.appendChild(state);

                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'wg-btn wg-btn--sm';
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
            // persists the choice itself and resolves true only when the
            // PATCH landed, so apply the grant locally first — the re-GET is
            // reconciliation only and may fail without unshowing the grant.
            let granted = false;
            if (window.TrialConsent && typeof window.TrialConsent.request === 'function') {
                granted = (await window.TrialConsent.request(scope)) === true;
                if (granted) {
                    _trialConsent = { ...(_trialConsent || {}), [scope]: true };
                    renderTrialConsentRows();
                }
                await loadTrialConsent();
            } else if (typeof safeToast === 'function') {
                safeToast('Consent dialog unavailable — reload and try again', 'error');
            }
            return granted;
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
            if (typeof safeToast === 'function') safeToast('Failed to update trial consent', 'error');
            return false;
        }
        if (handle) { try { await handle.commit(fresh); } catch (_) { /* best-effort */ } }
        _trialConsent = fresh;
        renderTrialConsentRows();
        return true;
    }

    // The free trial card (kit A1, med-ckm5.10): one WGOfferCard for both
    // trials. Cloud: the operator trial is the `ai` consent (med-6xb9), on
    // offer while the trial flag is set, no own key is saved and the consent
    // record has loaded (so a granted trial never flashes the offer). Local
    // (bd med-o7zq.16): window.CloudVault.trial (web/cloud/js/local-policy.js)
    // exists only in local mode; its status() is null where the shell has no
    // App Attest (the Simulator, old devices), and the card stays hidden. On =
    // the `anon` consent (AI, food database, voice): turning it on is the
    // consent ceremony (local-mode copy in trial-consent.js), turning it off
    // revokes it; either way trial.apply() re-scopes the shell's CSP and
    // reloads the page when it changed. Enrollment runs after that reload.
    let _trialSeq = 0;
    async function renderTrialCard() {
        const wrap = document.getElementById('integrations-trial');
        const mount = document.getElementById('integrations-trial-card');
        if (!wrap || !mount || !window.WGOfferCard) return;
        const seq = ++_trialSeq;
        const trial = window.CloudVault && window.CloudVault.trial;
        let status = null;
        let available;
        let on;
        if (trial) {
            try { status = await trial.status(); } catch (_) { status = null; }
            if (seq !== _trialSeq) return; // a newer render owns the card
            available = !!status;
            on = available && status.on === true;
        } else {
            available = document.querySelector('meta[name="medtracker-trial-ai"]')?.content === '1' && !!_trialConsent;
            on = available && _trialConsent.ai === true;
        }
        const keySet = !!(getInput(FIELD_IDS.openai.api_key)?.value);
        const show = on || (available && !keySet);
        wrap.classList.toggle('hidden', !show);
        mount.textContent = '';
        syncOwnKeyRows();
        if (!show) return;
        const local = !!trial;
        const meta = local ? 'Food AI · food database · voice' : 'Food logging · no API key';
        let card;
        if (on) {
            const body = [];
            if (status) {
                const rows = trialMeters(status);
                if (rows.length) body.push(window.WGOfferCard.meters(rows));
                const text = trialStatusText(status);
                if (text) {
                    const note = document.createElement('p');
                    note.id = 'integrations-trial-status';
                    note.className = 'wg-hint';
                    note.textContent = text;
                    body.push(note);
                }
            }
            card = window.WGOfferCard.create({
                title: 'AI free trial',
                meta,
                trail: window.WGChip ? window.WGChip.create({ text: 'On', state: 'ok', small: true, icon: 'check' }) : null,
                text: local
                    ? 'Uses our keys, so you don’t need your own. Requests go through our server to the operator’s providers.'
                    : 'Uses the operator’s shared key, so you don’t need your own. Rate-limited.',
                body,
                actions: [{ label: 'Turn off the trial', ghost: true, sm: true, action: 'trial-stop', onClick: () => { stopTrial(); } }],
            });
        } else {
            card = window.WGOfferCard.create({
                title: 'Try AI for free',
                meta,
                text: 'Describe a meal or snap a photo and the AI logs it, without your own key. You’ll see what is sent before you agree.',
                actions: [{ label: 'Try it', icon: 'sparkle', action: 'trial-start', onClick: () => { startTrial(); } }],
            });
        }
        card.setAttribute('data-trial-state', on ? 'on' : 'offer');
        mount.appendChild(card);
    }

    // The "Your own keys · replace the trial" rows: Set / Not set from the
    // masked GET values, and a tap jumps to that provider's key field.
    const OWN_KEY_INPUTS = { openai: FIELD_IDS.openai.api_key, elevenlabs: FIELD_IDS.elevenlabs.api_key };
    function syncOwnKeyRows() {
        document.querySelectorAll('#integrations-trial [data-own-key]').forEach((row) => {
            const input = getInput(OWN_KEY_INPUTS[row.getAttribute('data-own-key')]);
            const state = row.querySelector('[data-own-key-state]');
            if (state) state.textContent = input && input.value ? 'Set' : 'Not set';
        });
    }

    // Meters where the server told us a total (bd med-o7zq.28): the voice
    // allowance and today's share of it. The AI's lifetime budget has no
    // total on the wire (only `remaining`), so it stays a sentence.
    function trialMeters(status) {
        const min = (s) => Math.round(s / 60);
        const rows = [];
        if (status.voiceLifetime > 0 && typeof status.voiceRemaining === 'number') {
            const used = Math.max(0, status.voiceLifetime - status.voiceRemaining);
            rows.push({ label: 'Voice', used, total: status.voiceLifetime, value: min(used) + ' / ' + min(status.voiceLifetime) + ' min' });
        }
        if (status.voiceDaily > 0 && typeof status.voiceDailyRemaining === 'number') {
            const used = Math.max(0, status.voiceDaily - status.voiceDailyRemaining);
            rows.push({ label: 'Today', used, total: status.voiceDaily, value: min(used) + ' / ' + min(status.voiceDaily) + ' min' });
        }
        return rows;
    }

    function trialStatusText(status) {
        let text = '';
        if (status.on && (status.used || status.remaining === 0)) {
            text = 'AI trial used — add your own key below to keep using the AI.';
        } else if (status.on && typeof status.remaining === 'number') {
            text = status.remaining + ' free AI requests left' + (status.daily ? ' (up to ' + status.daily + ' a day).' : '.');
        } else if (status.on) {
            text = 'Free trial on.';
        }
        // Voice seconds left, from the grant/rejoin and then each call's
        // up-front charge (bd med-o7zq.23/.28); below 30 s the server grants
        // no call. The limits are the server's (TRIAL_ANON_VOICE_*), never
        // numbers baked into the app.
        const voice = status.voiceRemaining;
        if (status.on && typeof voice === 'number') {
            if (voice < 30) {
                text += ' Voice minutes used up.';
            } else {
                const min = (s) => Math.max(1, Math.floor(s / 60)) + ' min';
                const limits = [];
                if (status.voiceDaily > 0) limits.push('up to ' + min(status.voiceDaily) + ' a day');
                if (status.voiceCallMax > 0) limits.push('each call uses up to ' + min(status.voiceCallMax));
                text += ' Voice: ' + min(voice) + ' left' + (limits.length ? ' (' + limits.join('; ') + ').' : '.');
            }
        }
        return text.trim();
    }

    let _trialBusy = false;
    async function setLocalTrial(on) {
        const trial = window.CloudVault && window.CloudVault.trial;
        if (!trial || _trialBusy) return false;
        _trialBusy = true;
        let ok = false;
        try {
            ok = on
                ? (window.TrialConsent ? await window.TrialConsent.request('anon') : false) === true
                : await setTrialConsentScope('anon', false);
            if (ok) await trial.apply();
        } catch (e) {
            console.error('[settings] trial toggle failed', e);
            if (typeof safeToast === 'function') safeToast('Could not change the free trial — try again', 'error');
        } finally {
            _trialBusy = false;
            await renderTrialCard();
        }
        return ok;
    }

    // trialOffer (med-6xb9): is a free AI trial on offer — no own OpenAI
    // key, none started, and one this install can start? Today's "Try AI for
    // free" card reads it, so a skipped onboarding still finds the trial.
    async function trialOffer() {
        if (typeof apiCall !== 'function') return false;
        try {
            const integ = await apiCall('/api/settings/integrations', 'GET');
            if (!integ || (integ.openai && integ.openai.api_key)) return false;
            const trial = window.CloudVault && window.CloudVault.trial;
            if (trial) {
                const status = await trial.status();
                return !!status && status.on !== true;
            }
            if (document.querySelector('meta[name="medtracker-trial-ai"]')?.content !== '1') return false;
            const consent = await apiCall('/api/settings/trial-consent', 'GET');
            return !!consent && consent.ai !== true;
        } catch (_) {
            return false;
        }
    }

    // startTrial: the Settings opt-in from anywhere — local mode's switch
    // (`anon` consent + apply, which may reload), else cloud's `ai` consent.
    // Resolves true once the trial is on.
    async function startTrial() {
        if (window.CloudVault && window.CloudVault.trial) return await setLocalTrial(true);
        return await setTrialConsentScope('ai', true);
    }

    // stopTrial: the card's "Turn off the trial" — revokes the same consent.
    async function stopTrial() {
        if (window.CloudVault && window.CloudVault.trial) return await setLocalTrial(false);
        return await setTrialConsentScope('ai', false);
    }

    async function loadTrialConsent() {
        if (typeof apiCall !== 'function') return;
        const anyTrial = CONSENT_MOUNTS.some(([metaName]) =>
            document.querySelector('meta[name="' + metaName + '"]')?.content === '1');
        if (!anyTrial) return;
        try {
            // apiCall returns null (not a throw) on transient GET failures —
            // only overwrite prior state with a real record, so a failed
            // refresh doesn't repaint granted scopes as "Not asked".
            const fresh = await apiCall('/api/settings/trial-consent', 'GET');
            if (fresh && typeof fresh === 'object') _trialConsent = fresh;
        } catch (_) { /* aborted — keep prior state */ }
        renderTrialConsentRows();
    }

    // Model-id suggestions (bd med-byom). Strictly a typing aid: the inputs stay
    // free text, and every failure path here ends with the field exactly as
    // usable as it was before. The fetch runs only on an explicit click and
    // reads the SAVED vault credentials on the shim side — never these DOM
    // values — because a URL typed but not yet saved is also a URL the
    // document's connect-src does not allow yet, and sending an existing key to
    // a half-typed hostname is exactly the accident worth designing out.
    const MODEL_LOADERS = [
        {
            scope: 'text',
            input: 'integrations-openai-model',
            button: 'integrations-openai-model-load',
            list: 'integrations-openai-model-options',
            note: 'integrations-openai-model-note'
        },
        {
            scope: 'vision',
            input: 'integrations-openai-vision-model',
            button:'integrations-openai-vision-model-load',
            list: 'integrations-openai-vision-model-options',
            note: 'integrations-openai-vision-model-note'
        }
    ];
    // Sequence guard per scope: a click that lands after a newer one repaints
    // nothing, so a slow first response can't overwrite a fresh second list.
    const _modelSeq = { text: 0, vision: 0 };

    function setModelNote(noteId, text) {
        const note = document.getElementById(noteId);
        if (!note) return;
        note.textContent = text || '';
        note.hidden = !text;
    }

    function renderModelOptions(listId, models) {
        const list = document.getElementById(listId);
        if (!list) return;
        list.textContent = '';
        for (const id of models) {
            const option = document.createElement('option');
            option.value = id;
            list.appendChild(option);
        }
    }

    // resetModelSuggestions drops a list whose credentials just changed. The
    // shim's cache keys on base URL + key fingerprint so it re-fetches anyway;
    // this only stops the stale dropdown from lingering on screen until then.
    function resetModelSuggestions() {
        for (const cfg of MODEL_LOADERS) {
            _modelSeq[cfg.scope] += 1;
            renderModelOptions(cfg.list, []);
            setModelNote(cfg.note, '');
            const btn = document.getElementById(cfg.button);
            if (btn) {
                btn.disabled = false;
                delete btn.dataset.modelsLoaded;
            }
        }
    }

    async function loadModels(cfg) {
        const btn = document.getElementById(cfg.button);
        const refresh = !!(btn && btn.dataset.modelsLoaded);
        const seq = (_modelSeq[cfg.scope] += 1);
        if (btn) btn.disabled = true;
        setModelNote(cfg.note, 'Loading models…');

        let res = null;
        try {
            res = (typeof apiCall === 'function')
                ? await apiCall('/api/settings/integrations/models?scope=' + cfg.scope + (refresh ? '&refresh=1' : ''), 'GET')
                : null;
        } catch (_) {
            // The shim answers failures as a payload; a throw here means the
            // route itself is unreachable (server mode, offline). Same outcome.
            res = null;
        }
        // Superseded: leave the button to the newer call, which owns it now.
        if (seq !== _modelSeq[cfg.scope]) return null;
        if (btn) btn.disabled = false;

        if (!res || res.error || !Array.isArray(res.models)) {
            setModelNote(cfg.note, (res && res.error) || "Couldn't load the model list — type the model id instead.");
            return null;
        }
        renderModelOptions(cfg.list, res.models);
        if (btn) btn.dataset.modelsLoaded = '1';
        setModelNote(cfg.note, res.models.length
            ? res.models.length + ' models available — pick one or type your own'
            : 'Provider returned no models — type the model id instead.');
        return res.models;
    }

    // Choose (the model value row's action): load the list, then offer it in
    // the kit choice dialog. Picking fills the free-text input; Save writes it.
    async function chooseModel(cfg) {
        const models = await loadModels(cfg);
        if (!models || !models.length || typeof safeChoose !== 'function') return;
        const input = getInput(cfg.input);
        if (!input) return;
        const picked = await safeChoose('', models.map((id) => ({ value: id, label: id, selected: id === input.value })),
            { title: cfg.scope === 'vision' ? 'Vision model' : 'Model' });
        if (picked == null) return;
        input.value = picked;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Key fields (.wg-secret): reveal toggles the password mask; Copy puts the
    // typed key on the clipboard. A saved key is only ever the "***" mask here
    // (the GET never returns it), so there is nothing to copy until the user
    // types one. Nothing is logged or sent anywhere.
    function bindSecretField(wrap) {
        const input = wrap.querySelector('input');
        const reveal = wrap.querySelector('[data-secret-reveal]');
        const copy = wrap.querySelector('[data-secret-copy]');
        if (!input || wrap.dataset.integrationsBound) return;
        wrap.dataset.integrationsBound = '1';
        reveal?.addEventListener('click', () => {
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            reveal.setAttribute('aria-pressed', String(show));
            reveal.setAttribute('aria-label', show ? 'Hide key' : 'Show key');
        });
        copy?.addEventListener('click', async () => {
            const value = input.value;
            if (!value || value === '***') {
                if (typeof safeToast === 'function') safeToast('Saved keys stay hidden — type a key to copy it', 'info');
                return;
            }
            try {
                await navigator.clipboard.writeText(value);
                if (typeof safeToast === 'function') safeToast('Key copied', 'info');
            } catch (_) {
                if (typeof safeToast === 'function') safeToast('Copy failed', 'error');
            }
        });
    }

    // The Telegram row on the AI & integrations page. telegram.js stamps the
    // mount with the rendered state; no stamp or 'disabled' = Telegram is off
    // on this server, so the row (and its page) stays hidden.
    function syncTelegramRow() {
        const mount = document.getElementById('telegram-settings-mount');
        const row = document.getElementById('integrations-telegram-row');
        const state = mount ? mount.dataset.tgState : '';
        if (row) row.hidden = !state || state === 'disabled';
        const desc = document.querySelector('[data-settings-summary="telegram"]');
        if (desc) desc.textContent = { linked: 'Linked', 'needs-sync': 'Needs sync' }[state] || 'Not linked';
    }

    // Local mode (bd med-ta2n.18): Telegram is a sync feature. The row shows
    // "Needs sync" and its page sells it, routing to Turn on sync. Nothing
    // here touches telegram.js or /api/telegram/* (med-4mva). The privacy
    // fact must stay true: messages pass through Telegram and our relay in
    // the clear (privacy-manifest.js telegram-relay / telegram-inbound).
    const TELEGRAM_FACTS = [
        ['message', 'Text the bot to log.', ' "/bp 120 80", "two eggs and toast", a photo of your plate - it lands in your log.'],
        ['bell', 'Reminders in the chat.', ' A dose reminder arrives in Telegram; one tap confirms it.'],
        ['clock', 'Recorded when the app opens.', ' The bot answers "Queued" at once; your app records the message the next time it opens on any of your devices.'],
        ['lock', 'Your records stay yours.', ' The server stores your log but can\'t read it. Telegram itself is not end-to-end encrypted: what you type to the bot passes through Telegram and our relay as plain text and is sealed the moment it reaches us. Reminders carry only the detail you choose.'],
    ];

    // Turn on sync: the shell slot's invite → P3 "Turn on sync?", else the W5
    // Sync & backup page (the same branch W5's own button takes).
    async function turnOnSync() {
        const sheet = window.InviteSheet;
        let invite = null;
        try { invite = sheet ? await sheet.pending() : null; } catch (_) { invite = null; }
        if (invite) {
            sheet.offer(invite, { kit: true });
            return 'offer';
        }
        window.SettingsView?.openSettingsPage('backup');
        return 'page';
    }

    function renderTelegramOffer(mount) {
        const facts = document.createElement('ul');
        facts.className = 'wg-facts wg-facts--sm';
        for (const [icon, title, text] of TELEGRAM_FACTS) {
            const li = document.createElement('li');
            const i = document.createElement('i');
            i.className = 'wg-ico';
            i.setAttribute('data-icon', icon);
            const span = document.createElement('span');
            const b = document.createElement('b');
            b.textContent = title;
            span.append(b, text);
            li.append(i, span);
            facts.appendChild(li);
        }
        const how = document.createElement('a');
        how.className = 'wg-link';
        how.target = '_blank';
        how.rel = 'noopener';
        how.hidden = true;
        how.setAttribute('data-action', 'telegram-invite-how');
        how.textContent = 'How to get an invite';
        const card = window.WGOfferCard.create({
            lead: 'message',
            title: 'Do almost everything from your messenger',
            body: [facts],
            actions: [{ label: 'Turn on sync', icon: 'cloud-up', action: 'telegram-turn-on-sync', onClick: () => { turnOnSync(); } }],
        });
        card.appendChild(how);
        const head = document.createElement('div');
        head.className = 'wg-section__head';
        const eyebrow = document.createElement('span');
        eyebrow.className = 'wg-eyebrow';
        eyebrow.textContent = 'Telegram';
        head.appendChild(eyebrow);
        const section = document.createElement('div');
        section.className = 'wg-section';
        section.append(head, card);
        mount.textContent = '';
        mount.appendChild(section);
        mount.dataset.tgState = 'needs-sync';
        // Same target as W5's link: the deployment's base landing.
        Promise.resolve().then(() => window.InviteSheet && window.InviteSheet.base()).then((base) => {
            if (!base) return;
            how.href = `https://${base}/`;
            how.hidden = false;
        }).catch(() => {});
    }

    function mountLocalTelegram() {
        const mount = document.getElementById('telegram-settings-mount');
        if (!mount || !window.WGOfferCard) return;
        // The 'needs-sync' stamp is what syncTelegramRow (also run by every
        // Settings summary refresh) reads: row shown, "Needs sync".
        if (mount.dataset.tgState !== 'needs-sync') renderTelegramOffer(mount);
        syncTelegramRow();
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
        // Skip the fetch when the section is hidden so a hidden panel
        // doesn't log failures for every Settings visit or advertise the
        // endpoint in DevTools network noise.
        const section = (typeof document !== 'undefined')
            ? document.getElementById('settings-integrations')
            : null;
        if (section && (section.hasAttribute('hidden') || section.classList.contains('hidden'))) {
            return null;
        }
        // Painted before the GET so a failed read still shows the offer.
        if (document.documentElement.classList.contains('wg-local-vault')) mountLocalTelegram();
        try {
            const payload = await apiCall('/api/settings/integrations', 'GET');
            if (!payload) return null;
            applyPayloadToDOM(payload);
            if (window.DataStore && typeof window.DataStore.setCachedWithTags === 'function') {
                try { await window.DataStore.setCachedWithTags(CACHE_KEY, payload, CACHE_TAGS); } catch (_) { /* best-effort cache */ }
            }

            // Fire-and-forget: consent rows repaint when the GET lands; the
            // integrations payload itself doesn't wait on it.
            // (applyPayloadToDOM above already painted the trial card.)
            loadTrialConsent();

            // Local mode has no server to link Telegram through, and telegram.js
            // reads its status with a raw fetch the shim never sees (a 404 on
            // the shell's origin, med-4mva): don't mount it; mountLocalTelegram
            // above shows the sync offer instead (med-ta2n.18).
            const tgMount = document.getElementById('telegram-settings-mount');
            const local = document.documentElement.classList.contains('wg-local-vault');
            if (tgMount && !_telegramMounted && !local) {
                _telegramMounted = true;
                _telegramModuleLoader()
                    .then(({ mountTelegram }) => mountTelegram(tgMount, {}))
                    .then(syncTelegramRow)
                    .catch((err) => {
                        _telegramMounted = false;
                        console.error('[settings] telegram module failed', err);
                    });
            }

            return payload;
        } catch (e) {
            console.error('Failed to load integrations:', e);
            return null;
        }
    }

    async function saveIntegrations() {
        if (!providerSaveAllowed()) return;
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
            if (typeof safeToast === 'function') safeToast('Failed to save integrations', 'error');
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
        applyPayloadToDOM(fresh || maskPayload(payload));
        window.SettingsView?.refreshIntegrationsSummary?.();
        // The saved provider may now be a different one, which makes any list
        // already on screen wrong. Drop it; the next click re-fetches.
        resetModelSuggestions();
        // Commit the masked server view when the reload succeeded, else the
        // locally-masked payload — never the raw cleartext keys.
        if (handle) { try { await handle.commit(fresh || maskPayload(payload)); } catch (_) { /* best-effort */ } }

        if (typeof safeToast === 'function') {
            safeToast('Integrations saved.', 'info');
        }
    }

    // Save is the page-bar primary (features/settings.js openSettingsPage).
    function bindControls() {
        const providerButton = getInput('integrations-provider-choose');
        if (providerButton && !providerButton.dataset.integrationsBound) {
            providerButton.dataset.integrationsBound = '1';
            providerButton.addEventListener('click', chooseProvider);
            getInput(FIELD_IDS.openai.api_key)?.addEventListener('input', renderProvider);
            getInput(FIELD_IDS.openai.url)?.addEventListener('input', () => {
                const url = normalizeProviderURL(getInput(FIELD_IDS.openai.url).value);
                if (url !== _aiProviderKeyURL) getInput(FIELD_IDS.openai.api_key).value = '';
                _aiProviderKeyURL = url;
                renderProvider();
            });
        }
        for (const cfg of MODEL_LOADERS) {
            const loadBtn = document.getElementById(cfg.button);
            if (!loadBtn || loadBtn.dataset.integrationsBound) continue;
            loadBtn.dataset.integrationsBound = '1';
            loadBtn.addEventListener('click', () => { chooseModel(cfg); });
        }
        document.querySelectorAll('#settings-integrations .wg-secret').forEach(bindSecretField);
        // Notifications page, local mode: "Want reminders in Telegram too?"
        const tgSync = document.getElementById('local-notify-telegram-sync');
        if (tgSync && !tgSync.dataset.integrationsBound) {
            tgSync.dataset.integrationsBound = '1';
            tgSync.addEventListener('click', () => { turnOnSync(); });
        }
        document.querySelectorAll('#integrations-trial [data-own-key]').forEach((row) => {
            if (row.dataset.integrationsBound) return;
            row.dataset.integrationsBound = '1';
            row.addEventListener('click', () => {
                const input = getInput(OWN_KEY_INPUTS[row.getAttribute('data-own-key')]);
                if (!input) return;
                if (typeof input.scrollIntoView === 'function') input.scrollIntoView({ block: 'center' });
                input.focus();
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindControls);
    } else {
        bindControls();
    }

    window.SettingsIntegrations = {
        load: loadIntegrations,
        save: saveIntegrations,
        trialOffer,
        startTrial,
        turnOnSync,
        bindPage(page) { _aiProviderPage = page; renderProvider(); },
        savedProviderLabel() {
            return (_aiProviderLoaded?.key || _aiProviderLoaded?.url.trim())
                ? AI_PROVIDERS.find((p) => p.id === _aiProviderLoaded.provider).summary : '';
        },
        // Internals exposed for the integration test suite. Not used by app code.
        _applyPayloadToDOM: applyPayloadToDOM,
        _readDOMIntoPayload: readDOMIntoPayload,
        _cacheKey: CACHE_KEY,
        _cacheTags: CACHE_TAGS,
        // Returns the in-flight promise so tests can await a click's effect
        // without racing the fire-and-forget listener.
        _loadModels: (scope) => loadModels(MODEL_LOADERS.find((c) => c.scope === scope)),
        _chooseModel: (scope) => chooseModel(MODEL_LOADERS.find((c) => c.scope === scope)),
        syncTelegramRow,
        // Returns the in-flight promise, like _loadModels.
        _renderTrialCard: renderTrialCard,
        _setLocalTrial: setLocalTrial,
        _resetTelegramMounted: () => { _telegramMounted = false; },
        _setTelegramLoader: (loader) => { _telegramModuleLoader = loader; }
    };
})();
