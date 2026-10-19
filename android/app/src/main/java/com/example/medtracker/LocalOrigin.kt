package com.example.medtracker

/**
 * Local mode (epic med-nt9p.32, bd med-nt9p.32.2): the bundled web app (ios/bundle-web.sh with
 * WG_BUNDLE_OUT=android/app/src/main/assets/web, run by android.yml) on the asset origin
 * https://appassets.androidplatform.net, served by LocalApp.kt. Kotlin twin of
 * ios/App/LocalOrigin.swift; no Android types, so LocalOriginTest runs it on the JVM.
 */
object LocalOrigin {
    /** WebViewAssetLoader's reserved host: real https (secure context), never resolves. */
    const val HOST = "appassets.androidplatform.net"
    const val HOME = "https://$HOST/"
    /** Persisted mode choice: true = this device only, no account (bd med-nt9p.32.4). */
    const val MODE_KEY = "wgLocalMode"
    /** Native mirror of the BYOK provider hosts the page registered (bridge op setEgressHosts). */
    const val HOSTS_KEY = "wgLocalEgressHosts"
    /** Same cap as cmd/cloud's PUT /api/egress-hosts (internal/cloudserver/egress.go). */
    const val MAX_HOSTS = 8
    /** Bridge ops only the bundled app may call (bd med-nt9p.32.4); an account page gets "unsupported". */
    val LOCAL_OPS = setOf(
        "setEgressHosts", "local.reset", "local.leave",
        // The anonymous trial (bd med-nt9p.32.8.4, Attest.kt): an account page never reaches it.
        "attest.status", "attest.enroll", "attest.setPass", "attest.assert",
    )

    /** The bridge's caller gate: only the open vault's own top-level https page (the account host, or HOST in local mode). */
    fun bridgeCaller(isMainFrame: Boolean, scheme: String?, host: String?, vault: String?): Boolean =
        isMainFrame && scheme == "https" && vault != null && host?.lowercase() == vault

    /** A local-only op answers only in local mode; every other op in both modes. */
    fun opAllowed(op: String, local: Boolean) = local || op !in LOCAL_OPS

    /**
     * Visual QA scene start page (debug launch extra wgQAScene, DebugHooks), twin of iOS
     * LocalOrigin.qaHome: HOME?qa=<name> for 1–64 of [a-z0-9-], else null.
     */
    fun qaHome(scene: String?): String? =
        scene?.takeIf { it.isNotEmpty() && it.length <= 64 && it.all { c -> c in 'a'..'z' || c in '0'..'9' || c == '-' } }
            ?.let { "$HOME?qa=$it" }

    /**
     * Asset path for a request path, routed like cmd/cloud's account host (router.go ServeHTTP):
     * "/" is the app document, /static/ and /domain/ their trees, everything else the cloud shell
     * tree (/js/…, /css/…, /vendor/…, and /qa/… which only a QA=1 bundle has). null: no such file.
     */
    fun file(path: String): String? {
        val p = path.ifEmpty { "/" } // a bare https://appassets.androidplatform.net is the root
        if (!p.startsWith("/") || p.split('/').any { it == ".." || it == "." }) return null
        if (p == "/") return "web/index.html"
        if (p.endsWith("/")) return null // no directory listings
        if (p.startsWith("/static/") || p.startsWith("/domain/")) return "web$p"
        return "web/cloud$p"
    }

    /**
     * cspPolicy (router.go) with connect-src scoped to 'self' plus the registered hosts only —
     * never a wildcard https:/wss:, the account app document's invariant. Each host as https://
     * AND wss://, like router.go buildConnectSrc. Hosts are pre-validated.
     */
    fun csp(hosts: List<String>): String {
        val connect = (listOf("'self'") + hosts.flatMap { listOf("https://$it", "wss://$it") }).joinToString(" ")
        return "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; worker-src 'self'; " +
            "media-src 'self'; connect-src $connect; object-src 'none'; base-uri 'none'; " +
            "frame-ancestors 'none'; form-action 'none'"
    }

    /** The page's host list, accepted only whole: at most MAX_HOSTS bare, normalized DNS names. */
    fun validHosts(raw: Any?): List<String>? {
        if (raw !is List<*> || raw.size > MAX_HOSTS) return null
        if (!raw.all { it is String && validHost(it) }) return null
        return raw.map { it as String }
    }

    /** Mirror of validEgressHost (egress.go): no second CSP token, scheme, port or path. */
    fun validHost(h: String): Boolean =
        h.isNotEmpty() && h.length <= 253 && !h.startsWith(".") && !h.startsWith("-") &&
            !h.endsWith(".") && !h.endsWith("-") && ".." !in h &&
            h.all { it in 'a'..'z' || it in '0'..'9' || it == '.' || it == '-' }

    /** The SharedPreferences form of the host mirror: space-separated (validHost admits no space). */
    fun encodeHosts(hosts: List<String>) = hosts.joinToString(" ")

    /** The stored mirror, or none when absent or no longer valid. */
    fun decodeHosts(raw: String?): List<String> =
        if (raw.isNullOrEmpty()) emptyList() else validHosts(raw.split(' ')) ?: emptyList()

    /** MIME by extension, without a charset (WebResourceResponse carries the encoding). */
    fun mime(path: String) = when (path.substringAfterLast('/').substringAfterLast('.', "").lowercase()) {
        "html" -> "text/html"
        "js", "mjs" -> "text/javascript" // module scripts need a JS MIME
        "css" -> "text/css"
        "json" -> "application/json"
        "webmanifest" -> "application/manifest+json"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "ico" -> "image/x-icon"
        "woff2" -> "font/woff2"
        "txt" -> "text/plain"
        else -> "application/octet-stream"
    }
}
