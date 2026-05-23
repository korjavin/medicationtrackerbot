package com.korjavin.medtracker

import android.webkit.JavascriptInterface

// NativeBridge surfaces a tiny native object on the WebView's window as
// `MedtrackerNative`. Two callers consume it:
//
//   - The bootstrap shim near the top of index.html mirrors apiBase() into
//     window.__MEDTRACKER_BOOTSTRAP__.apiBase so the rest of the frontend
//     can read the documented protocol (Phase 2a, Task 5).
//   - features/backend-logs.js calls getBackendLogs() from a Settings →
//     About → "Backend logs" debug screen (Phase 2a, Task 5).
//
// addJavascriptInterface bindings persist across WebView navigations, which
// is the property we rely on — evaluateJavascript(...) before loadUrl(...)
// would target the about:blank document that the new page replaces.
//
// Only methods annotated with @JavascriptInterface are reachable from JS
// (addJavascriptInterface enforces this for API 17+ targets). The page is
// served from http://127.0.0.1:<port> (our embedded backend), but it loads
// third-party scripts (telegram-web-app.js, Google Fonts) cross-origin —
// JavaScriptInterface bindings are page-scoped, not origin-scoped, so any
// JS in the page can call them. apiBase() exposes only the port the page
// already knows it loaded from (no incremental disclosure), but
// getBackendLogs() surfaces the Go process's stdout+stderr which can
// contain HTTP request paths and slog output. We gate it behind
// `debuggable` so a compromise of telegram.org's hosted script can't
// exfiltrate diagnostics from a production install — release builds
// return an empty string. Users who need to send logs to maintainers can
// run a debug build.
class NativeBridge(
    private val apiBase: String,
    private val binderProvider: () -> GoServerService.LocalBinder?,
    private val debuggable: Boolean,
) {
    @JavascriptInterface
    fun apiBase(): String = apiBase

    @JavascriptInterface
    fun getBackendLogs(): String {
        if (!debuggable) return ""
        val binder = binderProvider() ?: return ""
        return binder.recentLogTail()
    }

    companion object {
        // Name attached to the WebView's window. Frontend reads
        // `window.MedtrackerNative.apiBase()` etc.
        const val JS_NAME = "MedtrackerNative"
    }
}
