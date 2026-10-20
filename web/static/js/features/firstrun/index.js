// features/firstrun/index.js — orchestrator for the post-install
// guided setup overlay.
//
// Lifecycle:
//   1. Server's /api/bootstrap returns a top-level `needs_first_run: bool`
//      field (Task 2). features/auth-bootstrap.js's applyBootstrapPayload
//      mirrors it onto window.__MEDTRACKER_BOOTSTRAP__.needs_first_run and
//      calls WGFirstRun.mount({ needs_first_run }) on every fresh bootstrap.
//   2. mount() accepts that payload arg (or falls back to the bootstrap
//      mirror for late-loading callers) and on `true` attaches a full-screen
//      overlay to <body>. The orchestrator dispatches rendering to the
//      registered screen module for the current step (Task 4+).
//   3. dismiss() removes the overlay and clears the sessionStorage step
//      tracker. Called once POST /api/firstrun/complete settles: straight
//      from the W1 picker (features step) when no AI trial is on offer, else
//      from the trial step after it (bd med-ta2n.1; med-js3k's "a user who
//      skips still learns the trial exists" holds for Skip and Continue).
//
// Screen registry: each step ("features" | "integrations") owns a module
// under features/firstrun/screens/<step>.js that
// attaches `{ title, render(body, helpers) }` to
// window.WGFirstRun.screens[step]. The orchestrator looks the screen up
// by name, sets the panel title, clears the body container, then calls
// the screen's render with helpers `{ advance, complete, finishPicker,
// dismiss }`. advance('done') completes the flow (there is no done screen).
// A screen with `brand: true` (W1) shows the app mark row instead of the
// step bars.
//
// Resume semantics — the sessionStorage step tracker in state.js survives
// in-session WebView/process kills, so a mid-flow death resumes at the
// last visible step. A full device power-cycle wipes sessionStorage; the
// flow then restarts from "features" because `needs_first_run` is still
// true server-side. This is intentional, not a bug.
//
// This module exposes `window.WGFirstRun` with the public surface
// `{ mount, dismiss, isActive, state, screens }`. state.js installs the
// `.state` sub-namespace and the per-screen files install their entry
// under `.screens` — either loader can run first because each file
// defensively initialises the shared namespace.
(function () {
    'use strict';

    const OVERLAY_ID = 'wg-firstrun-overlay';
    const TITLE_ID = 'wg-firstrun-title';
    const STEPS_ID = 'wg-firstrun-steps';
    const BRAND_ID = 'wg-firstrun-brand';
    const FALLBACK_STEPS = ['features', 'integrations'];
    const BODY_ID = 'wg-firstrun-overlay-body';
    const COMPLETE_URL = '/api/firstrun/complete';
    // Written by the claim wizard (web/cloud/js/signup.js TRIAL_CHOICE_KEY).
    const TRIAL_CHOICE_KEY = 'wg-onboarding-trial-choice';
    // The W1 picks (bd med-ta2n.1), held until completion POSTs them as
    // `picked`. sessionStorage, like the step tracker: it survives the trial
    // step's trial.apply() reload.
    const PICKED_KEY = 'wg-firstrun-picked';

    // Module-local mount latch. The architecture's "no module state"
    // posture allows this because it is a render guard, not domain data:
    // calling mount() twice produces a single overlay rather than two.
    let _mounted = false;

    function _readNeedsFirstRun(payload) {
        if (payload && typeof payload === 'object' && typeof payload.needs_first_run === 'boolean') {
            return payload.needs_first_run;
        }
        const bs = (typeof window !== 'undefined') ? window.__MEDTRACKER_BOOTSTRAP__ : null;
        if (bs && typeof bs.needs_first_run === 'boolean') return bs.needs_first_run;
        return false;
    }

    function _currentStep() {
        const state = window.WGFirstRun && window.WGFirstRun.state;
        if (state && typeof state.getStep === 'function') return state.getStep();
        return 'features';
    }

    function _lookupScreen(stepName) {
        const screens = window.WGFirstRun && window.WGFirstRun.screens;
        if (!screens) return null;
        const screen = screens[stepName];
        if (!screen || typeof screen.render !== 'function') return null;
        return screen;
    }

    function _renderOverlayScaffold() {
        if (document.getElementById(OVERLAY_ID)) return;
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.className = 'wg-firstrun-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', TITLE_ID);

        const panel = document.createElement('div');
        panel.className = 'wg-firstrun-overlay__panel';

        // Kit shell brand row (W1): the app mark + name, shown by screens
        // with `brand: true` in place of the step bars.
        const brand = document.createElement('div');
        brand.id = BRAND_ID;
        brand.className = 'wg-shell__brand';
        const mark = document.createElement('span');
        mark.className = 'wg-mark wg-mark--sm';
        const ico = document.createElement('i');
        ico.className = 'wg-ico';
        ico.setAttribute('data-icon', 'pill');
        mark.appendChild(ico);
        const name = document.createElement('span');
        name.className = 'wg-shell__name';
        name.textContent = 'Med Tracker';
        brand.append(mark, name);
        if (window.WGIcons && typeof window.WGIcons.hydrate === 'function') window.WGIcons.hydrate(brand);
        panel.appendChild(brand);

        // Kit step indicator (.wg-steps): one bar per step, painted by
        // _paintSteps on every render.
        const steps = document.createElement('div');
        steps.id = STEPS_ID;
        steps.className = 'wg-steps';
        steps.setAttribute('role', 'progressbar');
        steps.setAttribute('aria-label', 'Setup progress');
        steps.setAttribute('aria-valuemin', '1');
        panel.appendChild(steps);

        const title = document.createElement('h2');
        title.id = TITLE_ID;
        title.className = 'wg-firstrun-overlay__title wg-shell__title';
        panel.appendChild(title);

        const body = document.createElement('div');
        body.className = 'wg-firstrun-overlay__body';
        body.id = BODY_ID;
        panel.appendChild(body);

        overlay.appendChild(panel);
        document.body.appendChild(overlay);
    }

    function _paintSteps(stepName) {
        const steps = document.getElementById(STEPS_ID);
        if (!steps) return;
        const state = window.WGFirstRun && window.WGFirstRun.state;
        const order = (state && state.VALID_STEPS) || FALLBACK_STEPS;
        const now = Math.max(0, order.indexOf(stepName));
        steps.replaceChildren();
        order.forEach(function (_, i) {
            const bar = document.createElement('i');
            if (i < now) bar.className = 'is-done';
            else if (i === now) bar.className = 'is-now';
            steps.appendChild(bar);
        });
        steps.setAttribute('aria-valuemax', String(order.length));
        steps.setAttribute('aria-valuenow', String(now + 1));
        steps.setAttribute('aria-valuetext', 'Step ' + (now + 1) + ' of ' + order.length);
    }

    function _renderCurrentStep() {
        const stepName = _currentStep();
        const screen = _lookupScreen(stepName);
        const title = document.getElementById(TITLE_ID);
        const body = document.getElementById(BODY_ID);
        if (!title || !body) return;
        _paintSteps(stepName);
        const branded = !!(screen && screen.brand);
        document.getElementById(BRAND_ID).hidden = !branded;
        document.getElementById(STEPS_ID).hidden = branded;

        // Screens that haven't loaded yet (e.g. an older bundle, a step
        // module deferred to a later task) leave the panel empty rather
        // than crashing — state.setStep() has already advanced, so the
        // next bootstrap or the next mount() call will render correctly
        // once the screen module is present.
        if (!screen) {
            title.textContent = '';
            body.replaceChildren();
            return;
        }

        title.textContent = screen.title || '';
        body.replaceChildren();
        screen.render(body, _buildHelpers());
    }

    function _buildHelpers() {
        return {
            advance: function (stepName) {
                if (stepName === 'done') {
                    _complete();
                    return;
                }
                const state = window.WGFirstRun && window.WGFirstRun.state;
                if (state && typeof state.setStep === 'function') {
                    state.setStep(stepName);
                }
                _renderCurrentStep();
            },
            complete: function () {
                return _complete();
            },
            finishPicker: function (picked) {
                return _finishPicker(picked);
            },
            dismiss: function () {
                dismiss();
            },
        };
    }

    // W1 is done (its flags are written): remember the picks for completion,
    // then the free AI trial offer if there is one (bd med-js3k — a user who
    // skips must still learn the trial exists), else finish now. A claim-wizard
    // "Use my own keys" choice still lands on the key form (integrations).
    function _finishPicker(picked) {
        try { window.sessionStorage.setItem(PICKED_KEY, JSON.stringify(picked)); } catch (_) { /* storage blocked */ }
        let choice = null;
        try { choice = window.localStorage.getItem(TRIAL_CHOICE_KEY); } catch (_) { /* storage blocked */ }
        return (choice === 'own-keys' ? Promise.resolve(true) : _trialOnOffer()).then(function (offer) {
            if (!offer) return _complete();
            _buildHelpers().advance('integrations');
        });
    }

    function _readPicked() {
        try {
            const picked = JSON.parse(window.sessionStorage.getItem(PICKED_KEY));
            return Array.isArray(picked) ? picked : null;
        } catch (_) {
            return null;
        }
    }

    // Settings' own "is the trial on offer" check (med-6xb9). In cloud mode a
    // claim-wizard trial choice means the trial was already offered there —
    // screens/integrations.js skips its own trial choice for the same reason.
    function _trialOnOffer() {
        const settings = window.SettingsIntegrations;
        if (!settings || typeof settings.trialOffer !== 'function') return Promise.resolve(false);
        if (!(window.CloudVault && window.CloudVault.trial)) {
            let choice = null;
            try { choice = window.localStorage.getItem(TRIAL_CHOICE_KEY); } catch (_) { /* storage blocked */ }
            if (choice) return Promise.resolve(false);
        }
        return Promise.resolve()
            .then(function () { return settings.trialOffer(); })
            .catch(function () { return false; })
            .then(function (offer) { return offer === true; });
    }

    function _complete() {
        // Best-effort POST: dismiss regardless of network result so the
        // user is never stranded on the final screen if the device is
        // offline at completion time. The flag will sync on the next
        // bootstrap once connectivity returns; meanwhile the bootstrap's
        // in-memory needs_first_run is flipped to false so a same-session
        // re-mount no-ops.
        //
        // Prefer window.apiCall when it has loaded — it owns authenticated
        // request handling (session cookie), so the POST authenticates
        // on every build (mobile LocalUserResolver accepts unauthenticated
        // requests but the server build's AuthMiddleware would 401 a bare
        // fetch). The Vitest harness loads only the firstrun modules so
        // apiCall is absent there; the fetch fallback keeps tests minimal.
        const picked = _readPicked();
        const payload = picked ? { picked: picked } : null;
        let promise;
        if (typeof window.apiCall === 'function') {
            try {
                promise = window.apiCall(COMPLETE_URL, 'POST', payload);
            } catch (_) {
                promise = Promise.resolve(null);
            }
        } else {
            try {
                promise = window.fetch(COMPLETE_URL, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: payload ? JSON.stringify(payload) : undefined,
                });
            } catch (_) {
                promise = Promise.resolve(null);
            }
        }
        if (!promise || typeof promise.then !== 'function') {
            promise = Promise.resolve(promise);
        }
        return promise
            .catch(function () { return null; })
            .then(function () {
                if (window.__MEDTRACKER_BOOTSTRAP__ && typeof window.__MEDTRACKER_BOOTSTRAP__ === 'object') {
                    window.__MEDTRACKER_BOOTSTRAP__.needs_first_run = false;
                }
                dismiss();
            });
    }

    function mount(payload) {
        const needs = _readNeedsFirstRun(payload);
        if (_mounted) {
            // If a stale cached /api/bootstrap mounted us with `true` and a
            // fresh BOOTSTRAP_UPDATED later supplies `false`, we must dismiss
            // — otherwise the overlay outlives the server-side completion.
            // The same path also covers the "user completed firstrun on
            // another device" scenario for the browser PWA. When the new
            // payload still says `true`, re-mounting would just duplicate
            // the overlay, so we no-op.
            if (!needs) dismiss();
            return;
        }
        if (!needs) {
            // Defensive cleanup: a stale sessionStorage step entry from
            // a prior in-flight install can outlive a server-side
            // completion (POST /api/firstrun/complete succeeded but the
            // WebView was destroyed before dismiss() fired). Once the
            // bootstrap reports needs_first_run=false there is no resume
            // context to honor — clear the key so a re-install on the
            // same WebView session doesn't resume at a ghost step.
            const state = window.WGFirstRun && window.WGFirstRun.state;
            if (state && typeof state.clear === 'function') state.clear();
            return;
        }
        _renderOverlayScaffold();
        _mounted = true;
        // _currentStep() reads state.getStep(), which returns the
        // persisted sessionStorage value when present. A mid-flow kill
        // therefore re-mounts directly at the last-visible step rather
        // than restarting from the picker.
        _renderCurrentStep();
        _askPendingTrial();
    }

    // bd med-w6sx: the claim wizard's trial step (web/cloud/js/signup.js
    // renderTrialStep) only records the choice — the consent record is vault
    // data, so its second half runs here, once ('trial-asked'), on first open;
    // screens/integrations.js reads the same key to skip its own trial choice.
    // - 'trial-allowed' (bd med-nt9p.40): the wizard showed the `ai` disclosure
    //   and the user allowed it — record that grant, ask nothing. A decision
    //   already in the vault wins (grant() never overwrites it); only if nothing
    //   could be stored does the dialog ask, so the trial is never on unconsented.
    // - 'trial': a pre-med-nt9p.40 shell that showed no disclosure — ask.
    function _askPendingTrial() {
        let choice = null;
        try { choice = window.localStorage.getItem(TRIAL_CHOICE_KEY); } catch (_) { /* storage blocked */ }
        if (choice !== 'trial' && choice !== 'trial-allowed') return;
        if (document.querySelector('meta[name="medtracker-trial-ai"]')?.content !== '1') return;
        const consent = window.TrialConsent;
        if (!consent || typeof consent.request !== 'function') return;
        try { window.localStorage.setItem(TRIAL_CHOICE_KEY, 'trial-asked'); } catch (_) { /* storage blocked */ }
        if (choice === 'trial' || typeof consent.grant !== 'function') {
            consent.request('ai');
            return;
        }
        Promise.resolve(consent.grant('ai'))
            .catch(function () { return null; })
            .then(function (decided) { if (typeof decided !== 'boolean') consent.request('ai'); });
    }

    function dismiss() {
        const el = document.getElementById(OVERLAY_ID);
        if (el && el.parentNode) {
            el.parentNode.removeChild(el);
        }
        _mounted = false;
        try { window.sessionStorage.removeItem(PICKED_KEY); } catch (_) { /* storage blocked */ }
        if (window.WGFirstRun && window.WGFirstRun.state && typeof window.WGFirstRun.state.clear === 'function') {
            window.WGFirstRun.state.clear();
        }
    }

    function isActive() {
        return _mounted;
    }

    // Attach to the shared WGFirstRun namespace; state.js + screen
    // modules may have populated `.state` / `.screens` before this
    // script ran. The bare `window.WGFirstRun = ...` assignment matches
    // the architecture-globals allowlist (one entry covers the entire
    // module surface); assigning property-by-property keeps the regex
    // from flagging the chained writes.
    window.WGFirstRun = window.WGFirstRun || {};
    window.WGFirstRun.mount = mount;
    window.WGFirstRun.dismiss = dismiss;
    window.WGFirstRun.isActive = isActive;
})();
