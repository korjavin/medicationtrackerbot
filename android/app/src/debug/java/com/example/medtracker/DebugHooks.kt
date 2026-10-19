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
     * Local-mode QA entry (bd med-nt9p.32.4): the launch extra `wgLocalMode`
     * (`am start … --ez wgLocalMode true`) enters local mode as the first-run Start does
     * (persisted), so android-qa.yml gets the full app without a passkey. Same gate as
     * qaSoftAuthn: debug and the qa.test placeholder base only.
     */
    fun localMode(activity: Activity): Boolean =
        qa() && activity.intent?.getBooleanExtra("wgLocalMode", false) == true

    /** `--es wgQAScene <name>`: the visual QA scene; LocalOrigin.qaHome validates the name. */
    fun qaScene(activity: Activity): String? =
        if (qa()) activity.intent?.getStringExtra("wgQAScene") else null

    /** `--ez wgQALock true`: shows the native lock screen without a lock (android-qa native-lock). */
    fun qaLock(activity: Activity): Boolean =
        qa() && activity.intent?.getBooleanExtra("wgQALock", false) == true

    private fun qa() = BuildConfig.DEBUG && BuildConfig.BASE_DOMAIN == QA_BASE
}
