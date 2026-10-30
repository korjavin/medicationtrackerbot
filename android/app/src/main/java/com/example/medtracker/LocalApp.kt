package com.example.medtracker

import android.content.Context
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.InputStream

/**
 * Serves the bundled web app (APK assets/web, ios/bundle-web.sh in android.yml) on
 * https://appassets.androidplatform.net for local mode (bd med-nt9p.32.2), the twin of
 * ios/App/LocalApp.swift. MainActivity's shouldInterceptRequest calls it while local mode is on;
 * it runs off the main thread. Every response carries the CSP, as cmd/cloud's do; connect-src
 * reads the native host mirror on each request, so a changed list applies on the next load.
 * Not WebViewAssetLoader: its root mapping does not fit the index/static/domain/cloud layout.
 */
class LocalApp internal constructor(
    private val readHosts: () -> String?,
    private val openAsset: (String) -> InputStream,
) {
    constructor(context: Context) : this(
        { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(LocalOrigin.HOSTS_KEY, null) },
        { context.assets.open(it) },
    )

    /** null: not the asset origin, the normal network path (cloud mode is unchanged). */
    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        if (url.host?.lowercase() != LocalOrigin.HOST) return null
        val response = load(request.method, url.scheme, url.path.orEmpty())
        return WebResourceResponse(response.mime, "utf-8", response.code, response.reason, response.headers, response.body)
    }

    /** The response builder is also exercised on the JVM, using the same asset/mirror ports. */
    internal fun load(method: String, scheme: String?, path: String): Response {
        // One validated snapshot belongs to this response, even if the mirror changes while
        // opening/reading the document. A bridge reply cannot describe an earlier navigation.
        val hosts = LocalOrigin.decodeHosts(readHosts())
        val headers = mapOf(
            "Content-Security-Policy" to LocalOrigin.csp(hosts),
            "X-Content-Type-Options" to "nosniff",
            // A new build's assets must never come from WebView's HTTP cache.
            "Cache-Control" to "no-store",
        )
        // Never falls through to the network: anything not served is an explicit error response.
        if (method != "GET") return empty(405, "Method Not Allowed", headers)
        val rel = if (scheme == "https") LocalOrigin.file(path) else null
        val asset = rel?.let { runCatching { openAsset(it) }.getOrNull() }
            ?: return empty(404, "Not Found", headers)
        val body = if (rel == "web/index.html") {
            val html = asset.bufferedReader(Charsets.UTF_8).use { it.readText() }
            ByteArrayInputStream(LocalOrigin.appDocument(html, hosts).toByteArray(Charsets.UTF_8))
        } else asset
        return Response(LocalOrigin.mime(rel), 200, "OK", headers, body)
    }

    internal data class Response(
        val mime: String,
        val code: Int,
        val reason: String,
        val headers: Map<String, String>,
        val body: InputStream,
    )

    private fun empty(code: Int, reason: String, headers: Map<String, String>) =
        Response("text/plain", code, reason, headers, ByteArrayInputStream(ByteArray(0)))

    companion object {
        /** MainActivity's SharedPreferences file, where .4's setEgressHosts writes the mirror. */
        const val PREFS = "shell"
    }
}
