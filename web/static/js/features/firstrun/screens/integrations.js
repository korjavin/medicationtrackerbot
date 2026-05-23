// features/firstrun/screens/integrations.js — Task 6 of the mobile
// Phase 2c plan. Third screen in the first-run overlay: a compact OpenAI
// key form (API key + URL + model with sane defaults pre-filled). The
// Food DB and ElevenLabs integrations are intentionally NOT exposed in
// this screen — the plan keeps first-run short and punts those to
// Settings → Integrations, which the user reaches once the overlay
// dismisses.
//
// PATCH client reuse: when window.SettingsIntegrations.patch is present
// (production load order: settings/integrations.js loads before the
// bootstrap-loaded event fires), the screen calls it so auth headers
// and apiCall's error handling are shared with the Settings UI. When
// the helper is absent (Vitest harness loads only firstrun modules) the
// screen falls back to a direct window.fetch — same pattern the
// orchestrator's _complete() uses, so the test surface stays minimal.
//
// Save semantics:
//   - Submit posts whatever the user typed, including the pre-filled
//     URL + model. Server's PATCH treats "" as "clear field" and the
//     "***" sentinel as "leave as-is"; we never send "***" because the
//     form starts empty (fresh DB has no existing keys to preserve).
//   - On success the screen advances to "done".
//   - On failure the error message renders inline and the user stays on
//     the integrations step so they can retry or skip.
// Skip semantics:
//   - Advances to "done" without touching the PATCH endpoint. The
//     user's API key fields remain empty server-side; AI-dependent
//     features fall back to their existing "configure to enable" empty
//     states.
(function () {
    'use strict';

    const PATCH_URL = '/api/settings/integrations';
    const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1';
    const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

    function _makeField(id, labelText, value, opts) {
        opts = opts || {};
        const wrap = document.createElement('div');
        wrap.className = 'wg-firstrun-field';

        const label = document.createElement('label');
        label.className = 'wg-firstrun-field__label';
        label.setAttribute('for', id);
        label.textContent = labelText;
        wrap.appendChild(label);

        const input = document.createElement('input');
        input.id = id;
        input.className = 'wg-firstrun-field__input';
        input.type = opts.type || 'text';
        input.value = value || '';
        if (opts.placeholder) input.placeholder = opts.placeholder;
        if (opts.autocomplete) input.autocomplete = opts.autocomplete;
        if (opts.spellcheck === false) input.spellcheck = false;
        wrap.appendChild(input);

        return { wrap: wrap, input: input };
    }

    function _readPayload(fields) {
        return {
            openai: {
                api_key: fields.apiKey.value || '',
                url: fields.url.value || '',
                model: fields.model.value || '',
            },
        };
    }

    function _patch(payload) {
        // Prefer the shared helper from features/settings/integrations.js
        // when it has loaded so production callers go through apiCall +
        // auth headers. The fallback fetch uses credentials: 'same-origin'
        // so cookie-authenticated browser sessions still reach the server;
        // mobile builds use LocalUserResolver and need no auth.
        const helper = window.SettingsIntegrations;
        if (helper && typeof helper.patch === 'function') {
            return Promise.resolve(helper.patch(payload));
        }
        return window.fetch(PATCH_URL, {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }).then(function (resp) {
            if (!resp || !resp.ok) {
                const status = resp ? resp.status : 'no-response';
                throw new Error('integrations PATCH failed: ' + status);
            }
            return resp;
        });
    }

    function render(body, helpers) {
        const intro = document.createElement('p');
        intro.className = 'wg-firstrun-screen__tagline';
        intro.textContent = 'Add your OpenAI API key to unlock food photo analysis and other AI features. URL and model defaults are pre-filled — change them only if you use a self-hosted compatible endpoint.';
        body.appendChild(intro);

        const form = document.createElement('div');
        form.className = 'wg-firstrun-form';

        const apiKeyField = _makeField('wg-firstrun-openai-api-key', 'OpenAI API key', '', {
            type: 'password',
            placeholder: 'sk-...',
            autocomplete: 'off',
            spellcheck: false,
        });
        const urlField = _makeField('wg-firstrun-openai-url', 'API URL', DEFAULT_OPENAI_URL, {
            autocomplete: 'off',
            spellcheck: false,
        });
        const modelField = _makeField('wg-firstrun-openai-model', 'Model', DEFAULT_OPENAI_MODEL, {
            autocomplete: 'off',
            spellcheck: false,
        });
        form.appendChild(apiKeyField.wrap);
        form.appendChild(urlField.wrap);
        form.appendChild(modelField.wrap);
        body.appendChild(form);

        const error = document.createElement('p');
        error.className = 'wg-firstrun-form__error';
        error.setAttribute('data-firstrun-form-error', 'integrations');
        body.appendChild(error);

        const actions = document.createElement('div');
        actions.className = 'wg-firstrun-actions';

        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'wg-firstrun-btn wg-firstrun-btn--primary';
        save.textContent = 'Save';
        save.setAttribute('data-firstrun-action', 'save');
        save.addEventListener('click', function () {
            save.disabled = true;
            error.textContent = '';
            const payload = _readPayload({
                apiKey: apiKeyField.input,
                url: urlField.input,
                model: modelField.input,
            });
            Promise.resolve(_patch(payload)).then(function () {
                helpers.advance('done');
            }).catch(function (err) {
                // Soft failure — surface the error inline and re-enable
                // the Save button so the user can retry without leaving
                // the screen. They can also fall back to Skip.
                const msg = (err && err.message) ? err.message : 'Save failed';
                error.textContent = 'Couldn’t save (' + msg + '). You can try again or skip for now.';
                save.disabled = false;
            });
        });

        const skip = document.createElement('button');
        skip.type = 'button';
        skip.className = 'wg-firstrun-btn wg-firstrun-btn--secondary';
        skip.textContent = 'Skip';
        skip.setAttribute('data-firstrun-action', 'skip');
        skip.addEventListener('click', function () {
            helpers.advance('done');
        });

        actions.appendChild(save);
        actions.appendChild(skip);
        body.appendChild(actions);
    }

    window.WGFirstRun = window.WGFirstRun || {};
    window.WGFirstRun.screens = window.WGFirstRun.screens || {};
    window.WGFirstRun.screens.integrations = {
        title: 'OpenAI integration',
        render: render,
    };
})();
