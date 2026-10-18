package com.example.medtracker

import java.security.MessageDigest

// Pure helpers for the spike (bd med-nt9p.4), unit-tested on the CI runner.
object SpikeText {
    /** The deployment's base domain from an account host `<label>.<base>`; null for anything shallower. */
    fun baseOf(host: String): String? {
        val h = host.lowercase().trimEnd('.')
        val i = h.indexOf('.')
        if (i <= 0) return null
        val base = h.substring(i + 1)
        return if ('.' in base) base else null
    }

    /**
     * Replaces the base domain with `<base>` and each account label with
     * `<sub-xxxxxx>` (a short SHA-256: stable, so two accounts stay
     * distinguishable, with no raw label kept), so the report can be pasted
     * into a bead.
     */
    fun redact(s: String, base: String): String {
        if (base.isEmpty()) return s
        val re = Regex("([A-Za-z0-9-]+)\\." + Regex.escape(base), RegexOption.IGNORE_CASE)
        return re.replace(s) { m -> "<sub-${tag(m.groupValues[1].lowercase())}>.<base>" }
            .replace(base, "<base>", ignoreCase = true)
    }

    private fun tag(label: String): String =
        MessageDigest.getInstance("SHA-256").digest(label.toByteArray())
            .take(3).joinToString("") { "%02x".format(it) }
}
