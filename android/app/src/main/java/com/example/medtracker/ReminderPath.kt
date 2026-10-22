package com.example.medtracker

/**
 * What a reminder tap may open (bd med-nt9p.52, twin of ios/App/ReminderPath.swift): the app's
 * own root with only the query keys of web/cloud/js/reminder-deeplink.js — the same allowlist as
 * web/cloud/sw.js reminderOpenUrl. Never an arbitrary string out of a row. Plain Kotlin, so
 * ReminderPathTest checks it on the JVM.
 */
object ReminderPath {
    const val FALLBACK = "/?tab=today"
    private val KEYS = setOf("tab", "action", "ids", "scheduled")
    /** The sections a row without a url — from a page before med-9d1a — may open (CLAUDE.md rule 6). */
    val SECTIONS = setOf("today", "meds", "bp", "weight", "workouts", "health")
    /** An already-encoded query (Swift's urlQueryAllowed + '%'): no space, quote, fragment or non-ASCII. */
    private val QUERY = Regex("[A-Za-z0-9\\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2}")

    /** A relative "/?…" path whose every key is allowlisted, else [FALLBACK]. */
    fun sanitize(raw: String?): String {
        if (raw == null || !raw.startsWith("/?")) return FALLBACK
        val query = raw.substring(2)
        if (query.isEmpty() || QUERY.replace(query, "").isNotEmpty()) return FALLBACK
        if (!query.split('&').all { it.substringBefore('=') in KEYS }) return FALLBACK
        return raw
    }

    fun legacy(section: String?): String = if (section in SECTIONS) "/?tab=$section" else FALLBACK
}
