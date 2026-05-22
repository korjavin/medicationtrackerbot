// Capacitor shell bootstrap shim: the Android MainActivity attaches a native
// object as window.MedtrackerNative (via addJavascriptInterface, which
// persists across navigations). We mirror its apiBase() into
// window.__MEDTRACKER_BOOTSTRAP__ so core/api.js — and any future consumer —
// reads the documented protocol without caring whether the value came from
// native bridge, server template, or test harness. Server-mode + browser PWA
// have no MedtrackerNative and this block is a no-op.
//
// Also wires the reminder pre-schedule loop (Phase 2b Task 5) for the
// Capacitor build. The loop fetches /api/reminders/upcoming?hours=24 and
// hands the queue to @capacitor/local-notifications so the OS fires
// reminders natively even when the WebView is suspended. We can only start
// the loop after the capacitor/reminders.js impl has been parsed (it runs
// later in the script order), so we attach a DOMContentLoaded listener
// rather than calling startPreScheduleLoop() inline.
//
// Lives in an external file because the Go server's CSP (`script-src 'self'
// …`) blocks inline scripts, so an in-page <script> shim would silently fail
// in production. Loaded before core/api.js so resolveApiUrl sees the value
// on first call.
(function () {
    try {
        var native = window.MedtrackerNative;
        if (native && typeof native.apiBase === 'function') {
            var base = native.apiBase();
            if (typeof base === 'string' && base) {
                window.__MEDTRACKER_BOOTSTRAP__ = { apiBase: base };
            }
        }
    } catch (e) { /* best-effort shim — silent on any host quirk */ }

    function isNativePlatform() {
        try {
            var cap = window.Capacitor;
            return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
        } catch (_) { return false; }
    }

    function startReminderLoop() {
        try {
            if (!isNativePlatform()) return;
            var r = window.Reminders;
            if (r && typeof r.startPreScheduleLoop === 'function') {
                r.startPreScheduleLoop();
            }
        } catch (_) { /* best-effort */ }
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            // Script tags after the impls have already parsed by the time we
            // get here, so it is safe to start the loop synchronously.
            startReminderLoop();
        } else {
            document.addEventListener('DOMContentLoaded', startReminderLoop, { once: true });
        }
    }
})();
