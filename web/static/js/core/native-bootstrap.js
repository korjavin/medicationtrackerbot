// Capacitor shell bootstrap shim: the Android MainActivity attaches a native
// object as window.MedtrackerNative (via addJavascriptInterface, which
// persists across navigations). We mirror its apiBase() into
// window.__MEDTRACKER_BOOTSTRAP__ so core/api.js — and any future consumer —
// reads the documented protocol without caring whether the value came from
// native bridge, server template, or test harness. Server-mode + browser PWA
// have no MedtrackerNative and this block is a no-op.
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
})();
