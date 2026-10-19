package com.example.medtracker

import android.app.Activity
import android.webkit.WebView

/** Release twin of src/debug's DebugHooks (bd med-nt9p.25): does nothing. */
internal object DebugHooks {
    @Suppress("UNUSED_PARAMETER")
    fun onWebView(activity: Activity, w: WebView, rules: Set<String>, diag: (String) -> Unit) = Unit

    @Suppress("UNUSED_PARAMETER")
    fun localMode(activity: Activity) = false

    @Suppress("UNUSED_PARAMETER")
    fun qaScene(activity: Activity): String? = null
}
