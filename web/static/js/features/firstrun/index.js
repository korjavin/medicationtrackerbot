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
//      overlay to <body>. Subsequent task screens (Task 4–6) render
//      themselves inside the overlay panel.
//   3. dismiss() removes the overlay and clears the sessionStorage step
//      tracker. Called by the "done" screen after POST /api/firstrun/
//      complete succeeds, and by "Skip all" on the welcome screen.
//
// Resume semantics — the sessionStorage step tracker in state.js survives
// in-session WebView/process kills, so a mid-flow death resumes at the
// last visible step. A full device power-cycle wipes sessionStorage; the
// flow then restarts from "welcome" because `needs_first_run` is still
// true server-side. This is intentional, not a bug.
//
// This module exposes `window.WGFirstRun` with the public surface
// `{ mount, dismiss, isActive, state }`. The state sub-namespace is
// installed by state.js — either loader can run first.
(function () {
    'use strict';

    const OVERLAY_ID = 'wg-firstrun-overlay';
    const TITLE_ID = 'wg-firstrun-title';

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

    function _renderOverlay() {
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
        // Welcome-screen copy lands in Task 4. Until then the orchestrator
        // renders a tokenized eyebrow so the overlay is observable in
        // tests + on-device smoke without polluting the production
        // surface — Task 4 replaces this with the real screen content.
        title.textContent = 'Welcome';

        panel.appendChild(title);

        const body = document.createElement('div');
        body.className = 'wg-firstrun-overlay__body';
        body.id = 'wg-firstrun-overlay-body';
        panel.appendChild(body);

        overlay.appendChild(panel);
        document.body.appendChild(overlay);
    }

    function mount(payload) {
        if (_mounted) return;
        const needs = _readNeedsFirstRun(payload);
        if (!needs) return;
        _renderOverlay();
        _mounted = true;
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

    // Attach to the shared WGFirstRun namespace; state.js may have
    // populated the `.state` property before this script ran. The bare
    // `window.WGFirstRun = ...` assignment matches the architecture-
    // globals allowlist (one entry covers the entire module surface);
    // assigning property-by-property keeps the regex from flagging the
    // chained writes.
    window.WGFirstRun = window.WGFirstRun || {};
    window.WGFirstRun.mount = mount;
    window.WGFirstRun.dismiss = dismiss;
    window.WGFirstRun.isActive = isActive;
})();
