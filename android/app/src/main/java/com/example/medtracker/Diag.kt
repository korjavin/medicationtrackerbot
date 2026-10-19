package com.example.medtracker

import java.security.MessageDigest

/**
 * The passkey ceremony log (bd med-nt9p.22): the page's `diag.append` entries
 * and the shell's own lines, one per line, redacted before they are stored and
 * capped, so "Copy diagnostics" can be pasted into a bead. Pure, unit-tested on
 * the CI runner; MainActivity keeps the text in its own SharedPreferences file.
 */
object Diag {
    const val CAP = 200
    private const val MAX_LINE = 2000

    /** [log] plus one redacted line, keeping the last [CAP] lines. */
    fun append(log: String, line: String, base: String, time: String): String {
        val entry = "$time ${redact(line, base)}".replace(Regex("[\\r\\n]+"), " ").take(MAX_LINE)
        return (log.lines().filter { it.isNotEmpty() } + entry).takeLast(CAP).joinToString("\n")
    }

    /**
     * The spike's rule (bd med-nt9p.4): the base domain becomes `<base>`, each
     * account label `<sub-xxxxxx>` (a short SHA-256, so two accounts stay
     * distinguishable with no raw label kept), the FOR_APP origin's cert hash `<cert>`.
     */
    fun redact(s: String, base: String): String {
        val noCert = s.replace(Regex("android:apk-key-hash:[A-Za-z0-9_\\-+/=]+"), "android:apk-key-hash:<cert>")
        if (base.isEmpty()) return noCert
        val re = Regex("([A-Za-z0-9-]+)\\." + Regex.escape(base), RegexOption.IGNORE_CASE)
        return re.replace(noCert) { m -> "<sub-${tag(m.groupValues[1].lowercase())}>.<base>" }
            .replace(base, "<base>", ignoreCase = true)
    }

    private fun tag(label: String): String =
        MessageDigest.getInstance("SHA-256").digest(label.toByteArray())
            .take(3).joinToString("") { "%02x".format(it) }
}
