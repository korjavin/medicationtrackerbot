package com.example.medtracker

import java.net.URI

/**
 * The account links the shell parses (bd med-nt9p.5, twin of ios/App/AccountURL.swift):
 * an invite/claim link, a device hand-off link, a bare account address, or the
 * Emergency Kit QR (origin, account id and recovery code on separate lines —
 * only the first line is read, the code is never touched). JVM only, so the
 * unit test runs on the CI runner without a device.
 */
object AccountUrl {
    /**
     * The server's own "no such account" 404 (bd med-nt9p.32.14): cmd/cloud marks it with
     * X-Account-Gone: 1 (internal/cloudserver/router.go, the unknown-subdomain branch). A bare 404
     * — a proxy's while the server redeploys, or an older server — is not proof the account is gone.
     */
    fun accountGone(status: Int, headers: Map<String, String>?): Boolean =
        status == 404 && headers.orEmpty().any { (k, v) -> k.equals("X-Account-Gone", ignoreCase = true) && v.trim() == "1" }

    /** The URL to open, or null when the input is not an account on this deployment. */
    fun parse(raw: String, base: String): String? {
        val b = base.lowercase()
        if (b.isEmpty()) return null
        val line = raw.lines().map { it.trim() }.firstOrNull { it.isNotEmpty() } ?: return null
        val uri = try {
            URI(if ("://" in line) line else "https://$line")
        } catch (e: Exception) {
            return null
        }
        val host = uri.host?.lowercase() ?: return null
        if (uri.scheme?.lowercase() != "https" || uri.rawUserInfo != null || uri.port != -1 || !isAccountHost(host, b)) return null
        val path = uri.rawPath?.takeIf { it.isNotEmpty() } ?: "/"
        return "https://$host$path" + (uri.rawQuery?.let { "?$it" } ?: "") + (uri.rawFragment?.let { "#$it" } ?: "")
    }

    /**
     * An invite the app was opened with (bd med-ta2n.12.1, contract med-ta2n.7 §1/§5, twin of iOS
     * AccountURL.parseInvite) as the claim URL https://<sub>.<base>/#claim=<token>: the landing
     * page https://<base>/i/<sub>#<token> (app link), the scheme medtracker://i/<sub>#<token>, or
     * anything [parse] accepts. RAW path and fragment (java.net.URI, never android.net.Uri, which
     * decodes): sub ^[a-z0-9-]+$ after lowercasing, token ^[0-9a-f]+$ (the server's hex claim
     * token), no userinfo, port or query. null otherwise. The add-device hand-off (bd med-r1j2.8)
     * https://<base>/d/<sub>#<slot>.<TK> and medtracker://d/<sub>#<slot>.<TK> become
     * https://<sub>.<base>/claim#<slot>.<TK>, the code two base64url halves.
     */
    fun parseInvite(raw: String, base: String): String? {
        val b = base.lowercase()
        if (b.isEmpty()) return null
        val uri = try {
            URI(raw.trim())
        } catch (e: Exception) {
            return parse(raw, base)
        }
        val scheme = uri.scheme?.lowercase()
        val host = uri.host?.lowercase()
        val landing = scheme == "https" && host == b && uri.port == -1
        val custom = scheme == "medtracker" && (host == "i" || host == "d")
        if (!landing && !custom) return parse(raw, base)
        // Landing path "/i/<sub>" or "/d/<sub>"; the scheme's host is the kind, so its path is "/<sub>".
        val path = uri.rawPath.orEmpty()
        val kind = if (custom) host!! else if (path.startsWith("/d/")) "d" else "i"
        val prefix = if (landing) "/$kind/" else "/"
        val sub = if (path.startsWith(prefix)) path.substring(prefix.length).lowercase() else ""
        val tok = uri.rawFragment.orEmpty()
        val tokOk = if (kind == "d") HANDOFF_CODE.matches(tok) else tok.isNotEmpty() && tok.all { it in '0'..'9' || it in 'a'..'f' }
        if (uri.rawUserInfo != null || uri.port != -1 || uri.rawQuery != null ||
            sub.isEmpty() || !sub.all { it in 'a'..'z' || it in '0'..'9' || it == '-' } || !tokOk
        ) return null
        return parse(if (kind == "d") "https://$sub.$b/claim#$tok" else "https://$sub.$b/#claim=$tok", b)
    }

    /** The add-device code <slot>.<TK>, two base64url halves (web invite.js parse's twin). */
    private val HANDOFF_CODE = Regex("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+")

    /**
     * The Play Install Referrer string (contract med-ta2n.7 §4): a form query whose "invite" value
     * is the percent-encoded landing URL, decoded ONCE, then [parseInvite]. Anything else: null.
     */
    fun referrerInvite(referrer: String?, base: String): String? {
        val value = referrer?.split('&')?.firstOrNull { it.startsWith("invite=") }?.substringAfter('=') ?: return null
        val url = try {
            java.net.URLDecoder.decode(value, "UTF-8")
        } catch (e: IllegalArgumentException) {
            return null
        }
        return parseInvite(url, base)
    }

    /** A WebView attachment download (Files.download): https with a host only, never cleartext. */
    fun isDownloadable(url: String): Boolean {
        val uri = try {
            URI(url)
        } catch (e: Exception) {
            return false
        }
        return uri.scheme?.lowercase() == "https" && uri.host != null
    }

    /**
     * An account's ceremony page (the server's set in internal/cloudserver/router.go), where a
     * bad invite can strand the user; the shell offers "Use another invite" there (bd med-nt9p.20).
     */
    fun isCeremony(url: String?, base: String): Boolean {
        val uri = try {
            URI(url ?: return false)
        } catch (e: Exception) {
            return false
        }
        val host = uri.host?.lowercase() ?: return false
        return uri.scheme?.lowercase() == "https" && isAccountHost(host, base.lowercase()) &&
            uri.path in setOf("/unlock", "/claim", "/recover")
    }

    /** Exactly one DNS label under base: what the asset links and the bridge rules cover. */
    fun isAccountHost(host: String, base: String): Boolean {
        if (base.isEmpty() || !host.endsWith(".$base")) return false
        val label = host.dropLast(base.length + 1)
        return label.isNotEmpty() && '.' !in label
    }
}

/**
 * "rgb(r, g, b)" / "rgba(r, g, b, a)" from getComputedStyle as an opaque ARGB
 * int; null when transparent or unparseable. Twin of Shell.color in Shell.swift.
 */
fun cssColor(css: String): Int? {
    val n = css.split(Regex("[^0-9.]+")).filter { it.isNotEmpty() }.mapNotNull { it.toDoubleOrNull() }
    if (!(n.size == 3 || (n.size == 4 && n[3] > 0))) return null
    val (r, g, b) = n.take(3).map { it.toInt().coerceIn(0, 255) }
    return (0xFF shl 24) or (r shl 16) or (g shl 8) or b
}
