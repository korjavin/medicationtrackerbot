package com.example.medtracker

import android.app.Activity
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * Debug source set only (bd med-nt9p.25, docs/android.md → Agent QA harness): the
 * emulator harness's soft authenticator. Injected only when the launch intent carries
 * the extra `qaSoftAuthn`, which only `adb shell am start … --ez qaSoftAuthn true` can
 * set (a launcher tap never does). Release builds compile src/release's no-op twin and
 * have neither this code nor the asset.
 */
internal object DebugHooks {
    fun onWebView(activity: Activity, w: WebView, rules: Set<String>, diag: (String) -> Unit) {
        if (!BuildConfig.DEBUG || activity.intent?.getBooleanExtra("qaSoftAuthn", false) != true) return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        runCatching {
            val js = activity.assets.open("qa-softauthn.js").bufferedReader().use { it.readText() }
            WebViewCompat.addDocumentStartJavaScript(w, js, rules)
        }.onSuccess { diag("shell qa soft authenticator ON") }
            .onFailure { diag("shell qa soft authenticator failed: ${it.javaClass.simpleName}") }
    }
}
