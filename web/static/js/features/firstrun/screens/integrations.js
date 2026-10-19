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
// auth-bootstrap module calls into WGFirstRun.mount), the screen calls
// it so auth headers and apiCall's error handling are shared with the
// Settings UI. apiCall swallows HTTP failures into a null return, so
// _patch coerces null/undefined into a thrown error before the screen
// would mistake it for success. When the helper is absent (Vitest
// harness loads only firstrun modules) the screen falls back to a
// direct window.fetch with explicit !resp.ok handling.
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
//     user's API key fields remain empty server-side. In cloud mode with
//     an operator trial key configured, AI features keep working through
//     that key (rate-limited); otherwise AI-dependent features fall back
//     to their existing "configure to enable" empty states. The copy in
//     this screen keys off the same trial meta tag so it never promises
//     an out-of-the-box trial the operator hasn't provisioned.
//
// iOS device-only mode (bd med-o7zq.29): the screen leads with the anonymous
// free trial instead of the key form. window.CloudVault.trial
// (web/cloud/js/local-policy.js) exists only in local mode, and its status()
// is null where the shell has no App Attest — then the key form renders as
// before. "Try the free trial" is the Settings → AI & integrations switch's
// own flow: the `anon` TrialConsent ceremony, trial.apply() (which reloads
// when the CSP has to admit our server — the overlay then resumes on this
// step, sees the trial on and finishes), then trial.enroll() for the grant or
// rejoin. A refusal or a failed grant says why and leaves "Use my own keys"
// and "Skip for now" one tap away.
//
// Cloud mode (bd med-oc8h): where the operator configured a trial key (the
// medtracker-trial-ai meta tag, _trialAvailable below) the same three-button
// choice leads. The cloud trial needs no switch — aiclient.js routes through
// the operator key whenever the user has no key of their own — but every
// trial transmission is gated on the `ai` TrialConsent scope. So "Try the free
// trial" is the Settings → AI & integrations "Allow" on the trial AI row:
// TrialConsent.request('ai'), which persists the grant itself; on a grant the
// screen advances to done. The Telegram (`tg`) and voice scopes stay
// asked-on-first-use / in Settings, as before.
(function () {
    'use strict';

    const PATCH_URL = '/api/settings/integrations';
    const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1';
    const DEFAULT_OPENAI_MODEL = 'gpt-6-luna';

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
        // auth headers. apiCall (which the helper wraps) swallows HTTP
        // failures and resolves to null — coerce that into a thrown error
        // so the save handler's catch branch fires instead of advancing
        // the user to the "done" screen with an unsaved key. The fallback
        // window.fetch path is for the Vitest harness only (production
        // load order guarantees SettingsIntegrations is present by save
        // time) and uses credentials: 'same-origin'.
        const helper = window.SettingsIntegrations;
        if (helper && typeof helper.patch === 'function') {
            return Promise.resolve(helper.patch(payload)).then(function (result) {
                if (result === null || result === undefined) {
                    throw new Error('integrations PATCH failed');
                }
                return result;
            });
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

    // In cloud mode the operator may configure a shared trial OpenAI key
    // (TRIAL_OPENAI_API_KEY); cmd/cloud then injects <meta
    // name="medtracker-trial-ai" content="1"> and web/cloud/js/aiclient.js
    // routes through it whenever the user has no key of their own. Read the
    // same tag Settings → Integrations reads (applyTrialHints), so the two
    // surfaces can never disagree about whether the trial path exists.
    function _trialAvailable() {
        return document.querySelector('meta[name="medtracker-trial-ai"]')?.content === '1';
    }

    const TAGLINE_TRIAL = 'AI features — food by description, food photo, and voice — already work, '
        + 'using a shared trial key that is rate-limited; you’ll be asked for consent before the '
        + 'first trial use. Add your own OpenAI key to lift the limit '
        + 'and keep your prompts off the operator’s key. You can skip this and add one later in '
        + 'Settings → Integrations.';
    const TAGLINE_NO_TRIAL = 'Add your OpenAI API key to unlock food photo analysis and other AI '
        + 'features. URL and model defaults are pre-filled — change them only if you use a '
        + 'self-hosted compatible endpoint.';

    const TRIAL_TAGLINE = 'Try the AI and food database without your own keys. The free trial is '
        + 'limited and runs through our server; you’ll see exactly what it sends before it turns on.';
    const SWITCH_NOTE = 'You can switch any time in Settings → AI & integrations.';
    const CLOUD_TRIAL_TAGLINE = 'Try the AI features — food by description and food photo — without your '
        + 'own key. The free trial is rate-limited and runs on the operator’s shared key; you’ll see '
        + 'exactly what it sends before it turns on.';
    const TRIAL_DECLINED = 'The free trial stays off. You can use your own keys, or skip for now.';
    const TRIAL_ERRORS = {
        trial_already_used: 'The free trial was already used on this iPhone. You can use your own keys, or skip for now.',
        trial_not_configured: 'The free trial is not available right now. You can use your own keys, or skip for now.',
    };
    const TRIAL_FAILED = 'Couldn’t start the free trial. Check your connection and try again, use your own keys, or skip for now.';

    function _localTrial() {
        return (window.CloudVault && window.CloudVault.trial) || null;
    }

    function _button(className, text, action) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wg-btn wg-btn--lg wg-btn--block' + (className ? ' ' + className : '');
        btn.textContent = text;
        btn.setAttribute('data-firstrun-action', action);
        return btn;
    }

    // trial: the local-mode port (consent `anon`, then apply + enroll), or
    // null in cloud mode (consent `ai` is the whole opt-in).
    function renderTrialChoice(body, helpers, trial) {
        const intro = document.createElement('p');
        intro.className = 'wg-firstrun-screen__tagline';
        intro.textContent = trial ? TRIAL_TAGLINE : CLOUD_TRIAL_TAGLINE;
        body.appendChild(intro);

        const error = document.createElement('p');
        error.className = 'wg-firstrun-form__error';
        error.setAttribute('data-firstrun-form-error', 'trial');
        body.appendChild(error);

        const actions = document.createElement('div');
        actions.className = 'wg-firstrun-actions';
        const tryBtn = _button('wg-btn--primary', 'Try the free trial', 'trial');
        const keysBtn = _button('', 'Use my own keys', 'own-keys');
        // Never disabled: whatever the trial does, the user can move on.
        const skip = _button('wg-btn--ghost', 'Skip for now', 'skip');
        actions.append(tryBtn, keysBtn, skip);
        body.appendChild(actions);

        const note = document.createElement('p');
        note.className = 'wg-hint';
        note.textContent = SWITCH_NOTE;
        body.appendChild(note);

        function busy(on) {
            tryBtn.disabled = on;
            keysBtn.disabled = on;
        }
        function fail(text) {
            error.textContent = text;
            tryBtn.textContent = 'Try again';
            busy(false);
        }
        async function finish() {
            busy(true);
            error.textContent = '';
            tryBtn.textContent = 'Starting the free trial…';
            let res;
            try { res = await trial.enroll(); } catch (_) { res = { ok: false, code: 'network' }; }
            if (!tryBtn.isConnected) return;
            if (res && res.ok) {
                helpers.advance('done');
                return;
            }
            fail(TRIAL_ERRORS[res && res.code] || TRIAL_FAILED);
        }

        tryBtn.addEventListener('click', async function () {
            busy(true);
            error.textContent = '';
            let reloading = false;
            try {
                const scope = trial ? 'anon' : 'ai';
                const granted = window.TrialConsent ? await window.TrialConsent.request(scope) : false;
                if (granted !== true) {
                    fail(TRIAL_DECLINED);
                    tryBtn.textContent = 'Try the free trial';
                    return;
                }
                if (!trial) {
                    helpers.advance('done');
                    return;
                }
                reloading = (await trial.apply()) === true;
            } catch (e) {
                console.error('[firstrun] trial start failed', e);
                fail(TRIAL_FAILED);
                return;
            }
            // The CSP changes on a reload; this step resumes after it.
            if (!reloading) await finish();
        });
        keysBtn.addEventListener('click', function () {
            body.replaceChildren();
            renderKeys(body, helpers);
        });
        skip.addEventListener('click', function () {
            helpers.advance('done');
        });

        // The same gate as the Settings row: no App Attest → the key form.
        // Already on (back from apply()'s reload) → finish the grant.
        if (!trial) return;
        Promise.resolve(trial.status()).catch(function () { return null; }).then(function (status) {
            if (!tryBtn.isConnected) return;
            if (!status) {
                body.replaceChildren();
                renderKeys(body, helpers);
            } else if (status.on) {
                finish();
            }
        });
    }

    function render(body, helpers) {
        const localTrial = _localTrial();
        if (localTrial) {
            renderTrialChoice(body, helpers, localTrial);
            return;
        }
        if (_trialAvailable()) {
            // bd med-w6sx: the claim wizard already asked trial-or-keys —
            // don't ask twice. Consent granted (here, or on another device)
            // means the step has nothing left to offer.
            // A wizard "Use my own keys" keeps the key form up either way.
            const choice = _wizardTrialChoice();
            if (choice) renderKeys(body, helpers);
            else renderTrialChoice(body, helpers, null);
            if (choice !== 'own-keys') _ifTrialGranted(body, function () { helpers.advance('done'); });
            return;
        }
        renderKeys(body, helpers);
    }

    // Written by the claim wizard (web/cloud/js/signup.js TRIAL_CHOICE_KEY).
    function _wizardTrialChoice() {
        try { return window.localStorage.getItem('wg-onboarding-trial-choice'); } catch (_) { return null; }
    }

    function _ifTrialGranted(body, then) {
        if (typeof window.apiCall !== 'function') return;
        const marker = body.firstChild;
        Promise.resolve()
            .then(function () { return window.apiCall('/api/settings/trial-consent', 'GET'); })
            .catch(function () { return null; })
            .then(function (consent) {
                // Only while this screen is still the one on show.
                if (consent && consent.ai === true && marker && marker.isConnected) then();
            });
    }

    function renderKeys(body, helpers) {
        const trial = _trialAvailable();

        const intro = document.createElement('p');
        intro.className = 'wg-firstrun-screen__tagline';
        intro.textContent = trial ? TAGLINE_TRIAL : TAGLINE_NO_TRIAL;
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
        save.className = 'wg-btn wg-btn--primary wg-btn--lg wg-btn--block';
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
        skip.className = 'wg-btn wg-btn--ghost wg-btn--lg wg-btn--block';
        // Skipping key setup is NOT consent (bd med-yor.2): the trial path
        // asks for explicit consent on first use, so the label must not read
        // like a grant.
        skip.textContent = trial ? 'Skip — the trial key asks for consent on first use' : 'Skip';
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
        get title() {
            if (_localTrial()) return 'AI and food database';
            return _trialAvailable() ? 'AI features' : 'OpenAI integration';
        },
        render: render,
    };
})();
