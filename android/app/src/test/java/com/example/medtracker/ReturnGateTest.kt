package com.example.medtracker

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** bd med-nt9p.56: Enable's second stage waits for the return from Alarms & reminders. */
class ReturnGateTest {
    @Test
    fun theDialogsResumeIsNotTheReturn() {
        val g = ReturnGate()
        g.opened() // Allow → onRequestPermissionsResult → Alarms & reminders started
        assertFalse(g.resumed()) // the permission dialog's resume, before Alarms covers the app
        g.paused() // Alarms & reminders on screen
        assertTrue(g.resumed()) // back from it
        assertFalse(g.resumed()) // once per open
    }

    @Test
    fun nothingOpenedNothingDue() {
        val g = ReturnGate()
        g.paused()
        assertFalse(g.resumed())
    }

    @Test
    fun aPauseBeforeTheOpenDoesNotCount() {
        val g = ReturnGate()
        g.paused()
        g.opened()
        assertFalse(g.resumed())
        g.paused()
        assertTrue(g.resumed())
    }
}
