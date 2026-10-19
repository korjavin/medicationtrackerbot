package com.example.medtracker

import android.content.Context
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream

/**
 * Serves the bundled web app (APK assets/web, ios/bundle-web.sh in android.yml) on
 * https://appassets.androidplatform.net for local mode (bd med-nt9p.32.2), the twin of
 * ios/App/LocalApp.swift. MainActivity's shouldInterceptRequest calls it while local mode is on;
 * it runs off the main thread. Every response carries the CSP, as cmd/cloud's do; connect-src
 * reads the native host mirror on each request, so a changed list applies on the next load.
 * Not WebViewAssetLoader: its root mapping does not fit the index/static/domain/cloud layout.
 */
class LocalApp(private val context: Context) {
    /** null: not the asset origin, the normal network path (cloud mode is unchanged). */
    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        if (url.host?.lowercase() != LocalOrigin.HOST) return null
        val headers = mapOf(
            "Content-Security-Policy" to LocalOrigin.csp(storedHosts()),
            "X-Content-Type-Options" to "nosniff",
            // A new build's assets must never come from WebView's HTTP cache.
            "Cache-Control" to "no-store",
        )
        // Never falls through to the network: anything not served is an explicit error response.
        if (request.method != "GET") return empty(405, "Method Not Allowed", headers)
        val rel = if (url.scheme == "https") LocalOrigin.file(url.path.orEmpty()) else null
        val body = rel?.let { runCatching { context.assets.open(it) }.getOrNull() }
            ?: return empty(404, "Not Found", headers)
        return WebResourceResponse(LocalOrigin.mime(rel), "utf-8", 200, "OK", headers, body)
    }

    private fun storedHosts() = LocalOrigin.decodeHosts(
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(LocalOrigin.HOSTS_KEY, null)
    )

    private fun empty(code: Int, reason: String, headers: Map<String, String>) =
        WebResourceResponse("text/plain", "utf-8", code, reason, headers, ByteArrayInputStream(ByteArray(0)))

    companion object {
        /** MainActivity's SharedPreferences file, where .4's setEgressHosts writes the mirror. */
        const val PREFS = "shell"
    }
}
