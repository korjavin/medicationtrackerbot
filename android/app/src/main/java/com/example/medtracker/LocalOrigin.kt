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
        // The optional app lock's Settings row (bd med-nt9p.32.9, LocalLock.kt).
        "lock.status", "lock.set",
        // The local → cloud move's stash (bd med-nt9p.32.17, Move.kt): the local origin writes it.
        "move.stash",
        // The account → local leave stash (bd med-o7zq.36.3, second Move dir): the local origin picks it up.
        "leave.take", "leave.clear",
        // Local mode's invite request + attested feedback through the shell (BasePost.kt, bd med-ta2n.27).
        "base.post",
    )

    /**
     * base.post's paths (contract med-ta2n.24 A2): exact match, no query, no normalization. Twin of
     * iOS LocalOrigin.basePostPaths; the trial chat/food/voice paths stay page fetch.
     */
    val BASE_POST_PATHS = setOf(
        "/api/attest/challenge", "/api/attest/delete", "/api/attest/enroll", "/api/attest/feedback", "/api/invite-requests",
    )

    /**
     * local.reset {dropAttest} (bd med-egb3, contract point 4): only a JSON true (no optBoolean
     * coercion of "true"), which the page sends only once our server deleted the install record.
     */
    fun dropsAttest(flag: Any?): Boolean = flag == true

    /**
     * Bridge ops only an account page may call (bd med-nt9p.32.13); the bundled app gets "unsupported".
     * move.take/move.clear (bd med-nt9p.32.17): the new account picks up the local origin's stash.
     * push.token (bd med-erq1.5, Push.kt): local mode never reports an FCM token.
     * account.leave.forget (bd med-r1j2.19): a capability marker, never callable ("unsupported"): this
     * shell honours account.leave {then: "local", forget: true}.
     */
    val ACCOUNT_OPS = setOf("account.leave", "move.take", "move.clear", "leave.stash", "push.token", "account.leave.forget")
    /** Every other op the shell answers, in both modes (MainActivity.onBridge, Notifications, HealthConnect). */
    val SHARED_OPS = setOf(
        "ping", "chrome", "shell.ops", "diag.append", "health.authorize", "health.query",
        "notifications.permission", "notifications.requestPermission", "notifications.schedule", "notifications.test",
        // The denied note's "Open Android Settings" (web #1218, bd med-ckm5.16).
        "notifications.openSettings",
        // The camera-denied "Allow camera in Settings" (bd med-r1j2.19): this app's system Settings page.
        "app.openSettings",
        // The pending-invite slot (bd med-ta2n.12.1, Invite.kt) and F1's Paste (Android only).
        "invite.pending", "invite.clear", "clipboard.read",
        // "Join and erase" (bd med-r1j2.8): the local page probes it to offer the erase; only the joined
        // account, booted unlocked, makes it act (MainActivity); in local mode a no-op.
        "local.erase",
        // The page's back stack (bd med-y7b4.5, native/back.js): Back goes to the page while it can step.
        "back.state",
    )

    /** The bridge op shell.ops (bd med-nt9p.32.13): what this shell answers in this mode, for the page's capability probe. */
    fun ops(local: Boolean): List<String> = (SHARED_OPS + if (local) LOCAL_OPS else ACCOUNT_OPS).sorted()

    /** The bridge's caller gate: only the open vault's own top-level https page (the account host, or HOST in local mode). */
    fun bridgeCaller(isMainFrame: Boolean, scheme: String?, host: String?, vault: String?): Boolean =
        isMainFrame && ownOrigin(scheme, host, vault)

    /**
     * The open vault's own https origin: the account host, or HOST in local mode (MainActivity.vaultHost).
     * Files' getUserMedia grant (bd med-zdzc: the local trial's voice call needs the mic) and wgFiles ask this.
     */
    fun ownOrigin(scheme: String?, host: String?, vault: String?): Boolean =
        scheme == "https" && vault != null && host?.lowercase() == vault

    /** A local-only op answers only in local mode, an account-only op only in account mode; every other op in both. */
    fun opAllowed(op: String, local: Boolean) = op !in (if (local) ACCOUNT_OPS else LOCAL_OPS)

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
