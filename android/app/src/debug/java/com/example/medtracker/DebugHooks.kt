package com.example.medtracker

import android.app.Activity
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * Debug source set only (bd med-nt9p.25, docs/android.md → Agent QA harness): the
 * emulator harness's soft authenticator. Injected only when the launch intent carries
 * the extra `qaSoftAuthn`, which only `adb shell am start … --ez qaSoftAuthn true` can
 * set (a launcher tap never does), and only in the QA build whose base is the placeholder
 * qa.test: MainActivity is exported, so another app could send the extra too, but a debug
 * APK built for the real deployment (the owner's sideload) never honours it. Release builds
 * compile src/release's no-op twin and have neither this code nor the asset.
 */
internal object DebugHooks {
    private const val QA_BASE = "qa.test"

    fun onWebView(activity: Activity, w: WebView, rules: Set<String>, diag: (String) -> Unit) {
        if (!BuildConfig.DEBUG || BuildConfig.BASE_DOMAIN != QA_BASE) return
        if (activity.intent?.getBooleanExtra("qaSoftAuthn", false) != true) return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        runCatching {
            val js = activity.assets.open("qa-softauthn.js").bufferedReader().use { it.readText() }
            WebViewCompat.addDocumentStartJavaScript(w, js, rules)
        }.onSuccess { diag("shell qa soft authenticator ON") }
            .onFailure { diag("shell qa soft authenticator failed: ${it.javaClass.simpleName}") }
    }

    /**
     * Temporary local-mode entry (bd med-nt9p.32.2) until the real mode switch (.4): the launch
     * extra `wgLocalApp` (`am start … --ez wgLocalApp true`) opens the bundled app on
     * https://appassets.androidplatform.net for that launch, without storing anything. Same gate
     * as qaSoftAuthn: debug and the qa.test placeholder base only.
     */
    fun localApp(activity: Activity): Boolean =
        BuildConfig.DEBUG && BuildConfig.BASE_DOMAIN == QA_BASE &&
            activity.intent?.getBooleanExtra("wgLocalApp", false) == true
}
