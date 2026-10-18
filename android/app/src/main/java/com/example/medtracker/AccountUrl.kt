package com.example.medtracker

import java.net.URI

/**
 * What the first-run screen accepts (bd med-nt9p.5, twin of ios/App/AccountURL.swift):
 * an invite/claim link, a device hand-off link, a bare account address, or the
 * Emergency Kit QR (origin, account id and recovery code on separate lines —
 * only the first line is read, the code is never touched). JVM only, so the
 * unit test runs on the CI runner without a device.
 */
object AccountUrl {
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
