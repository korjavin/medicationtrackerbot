// features/firstrun/state.js — first-run flow step tracker.
//
// Persists the current step ("welcome" | "features" |
// "integrations" | "done") to sessionStorage so a mid-flow reload can
// resume at the last-visible step on the next bootstrap. A full device
// power-cycle wipes sessionStorage; the flow then restarts from "welcome"
// on the next launch, which is acceptable because `needs_first_run` is
// still true server-side. Documented as intentional in features/firstrun/
// index.js's top-of-file comment.
//
// NOTE: This `state` is distinct from today.js's render-only `__firstRun`
// flag (today.js:1054-1069). today's flag means "no data yet, show the
// empty-state hero"; this state machine drives the post-install setup
// overlay and is gated on the server-side `needs_first_run` bootstrap
// field. The two never collide.
(function () {
    'use strict';

    const KEY = 'wg-firstrun-step';
    const DEFAULT_STEP = 'welcome';
    const VALID_STEPS = Object.freeze(['welcome', 'features', 'integrations', 'done']);

    function _safeRead() {
        try {
            return window.sessionStorage.getItem(KEY);
        } catch (_) {
            return null;
        }
    }

    function _safeWrite(value) {
        try {
            window.sessionStorage.setItem(KEY, value);
        } catch (_) {
            // Private mode / quota / no storage — silently ignore.
            // Caller falls back to default step on the next getStep().
        }
    }

    function _safeRemove() {
        try {
            window.sessionStorage.removeItem(KEY);
        } catch (_) {
            // Same rationale as _safeWrite — best-effort cleanup.
        }
    }

    function getStep() {
        const raw = _safeRead();
        if (raw && VALID_STEPS.includes(raw)) return raw;
        return DEFAULT_STEP;
    }

    function setStep(name) {
        if (!VALID_STEPS.includes(name)) return;
        _safeWrite(name);
    }

    function clear() {
        _safeRemove();
    }

    // Attach to the shared WGFirstRun namespace under `.state` so the
    // orchestrator (index.js) can pull this in regardless of script load
    // order. The bare `window.WGFirstRun` assignment is on the
    // architecture-globals allowlist; `.state` is a chained property and
    // therefore not flagged.
    window.WGFirstRun = window.WGFirstRun || {};
    window.WGFirstRun.state = {
        KEY: KEY,
        DEFAULT_STEP: DEFAULT_STEP,
        VALID_STEPS: VALID_STEPS,
        getStep: getStep,
        setStep: setStep,
        clear: clear,
    };
})();
