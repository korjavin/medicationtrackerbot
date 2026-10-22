package com.example.medtracker

import org.junit.Assert.assertEquals
import org.junit.Test

/** A tap opens only what sw.js reminderOpenUrl would — mirrors ios/Tests/main.swift's ReminderPath checks. */
class ReminderPathTest {
    @Test
    fun validPathsPassThrough() {
        val dose = "/?action=medication_confirm&ids=2%2C5&scheduled=2026-01-01T09%3A00%3A00.000Z" // reminderDeeplink's shape
        assertEquals(dose, ReminderPath.sanitize(dose))
        val raw = "/?action=medication_confirm&ids=2,5&scheduled=2026-01-01T09:00:00.000Z"
        assertEquals(raw, ReminderPath.sanitize(raw))
        assertEquals("/?tab=meds", ReminderPath.sanitize("/?tab=meds"))
        assertEquals("/?tab=bp", ReminderPath.sanitize("/?tab=bp"))
    }

    @Test
    fun anythingElseFallsBack() {
        listOf(
            null, "", "/?", "/", "?tab=meds", "https://evil.com/?tab=meds", "//evil.com/?tab=meds", "/x?tab=meds",
            "/?tab=meds#claim=x", "/?tab=meds#", "/?tab=meds&next=https://evil.com", "/?reminder_action=bp_snooze",
            "/?tab=me\"ds", "/?tab=meds');alert(1)//\n", "javascript:alert(1)", "/?tab=me ds", "/?tab=médicaments",
            "/?tab=meds%zz", "/?tab=meds&&ids=1",
        ).forEach { assertEquals("$it", ReminderPath.FALLBACK, ReminderPath.sanitize(it)) }
    }

    @Test
    fun legacySections() {
        assertEquals("/?tab=meds", ReminderPath.legacy("meds"))
        assertEquals("/?tab=workouts", ReminderPath.legacy("workouts"))
        assertEquals(ReminderPath.FALLBACK, ReminderPath.legacy("settings"))
        assertEquals(ReminderPath.FALLBACK, ReminderPath.legacy(null))
        assertEquals(ReminderPath.FALLBACK, ReminderPath.legacy(""))
    }
}
