package com.lochyard.medtracker

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
// (addJavascriptInterface enforces this for API 17+ targets), and the JS
// origin we serve is our own embedded backend, so the well-known XSS-via-
// WebView class of bugs doesn't apply here.
class NativeBridge(
    private val apiBase: String,
    private val binderProvider: () -> GoServerService.LocalBinder?,
) {
    @JavascriptInterface
    fun apiBase(): String = apiBase

    @JavascriptInterface
    fun getBackendLogs(): String {
        val binder = binderProvider() ?: return ""
        return binder.recentLogTail()
    }

    companion object {
        // Name attached to the WebView's window. Frontend reads
        // `window.MedtrackerNative.apiBase()` etc.
        const val JS_NAME = "MedtrackerNative"
    }
}
