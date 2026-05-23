// features/firstrun/index.js — orchestrator for the post-install
// guided setup overlay (mobile Phase 2c).
//
// Lifecycle:
//   1. Server's /api/bootstrap returns a top-level `needs_first_run: bool`
//      field (Task 2). The Capacitor shell + browser fetch path mirror it
//      onto window.__MEDTRACKER_BOOTSTRAP__.needs_first_run before the rest
//      of the app boots; auth-bootstrap.js may also set it directly when
//      applyBootstrapPayload runs from a fresh network response.
//   2. mount() reads that field (or accepts a payload arg for tests / the
//      Capacitor early-boot path), and on `true` attaches a full-screen
//      overlay to <body>. The orchestrator dispatches rendering to the
//      registered screen module for the current step (Task 4+).
//   3. dismiss() removes the overlay and clears the sessionStorage step
//      tracker. Called by the "done" screen after POST /api/firstrun/
//      complete succeeds, and by "Skip all" on the welcome screen via
//      the complete() helper.
//
// Screen registry: each step ("welcome" | "permissions" | "integrations"
// | "done") owns a module under features/firstrun/screens/<step>.js that
// attaches `{ title, render(body, helpers) }` to
// window.WGFirstRun.screens[step]. The orchestrator looks the screen up
// by name, sets the panel title, clears the body container, then calls
// the screen's render with helpers `{ advance, complete, dismiss }`.
//
// Resume semantics — the sessionStorage step tracker in state.js survives
// in-session WebView/process kills, so a mid-flow death resumes at the
// last visible step. A full device power-cycle wipes sessionStorage; the
// flow then restarts from "welcome" because `needs_first_run` is still
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
    const BODY_ID = 'wg-firstrun-overlay-body';
    const COMPLETE_URL = '/api/firstrun/complete';

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
        return 'welcome';
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

        const title = document.createElement('h2');
        title.id = TITLE_ID;
        title.className = 'wg-firstrun-overlay__title';
        panel.appendChild(title);

        const body = document.createElement('div');
        body.className = 'wg-firstrun-overlay__body';
        body.id = BODY_ID;
        panel.appendChild(body);

        overlay.appendChild(panel);
        document.body.appendChild(overlay);
    }

    function _renderCurrentStep() {
        const stepName = _currentStep();
        const screen = _lookupScreen(stepName);
        const title = document.getElementById(TITLE_ID);
        const body = document.getElementById(BODY_ID);
        if (!title || !body) return;

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
                const state = window.WGFirstRun && window.WGFirstRun.state;
                if (state && typeof state.setStep === 'function') {
                    state.setStep(stepName);
                }
                _renderCurrentStep();
            },
            complete: function () {
                return _complete();
            },
            dismiss: function () {
                dismiss();
            },
        };
    }

    function _complete() {
        // Best-effort POST: dismiss regardless of network result so the
        // user is never stranded on the final screen if the device is
        // offline at completion time. The flag will sync on the next
        // bootstrap once connectivity returns; meanwhile the bootstrap's
        // in-memory needs_first_run is flipped to false so a same-session
        // re-mount no-ops.
        let promise;
        try {
            promise = window.fetch(COMPLETE_URL, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
            });
        } catch (_) {
            promise = Promise.resolve(null);
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
        if (_mounted) return;
        const needs = _readNeedsFirstRun(payload);
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
        // than restarting from welcome.
        _renderCurrentStep();
    }

    function dismiss() {
        const el = document.getElementById(OVERLAY_ID);
        if (el && el.parentNode) {
            el.parentNode.removeChild(el);
        }
        _mounted = false;
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
