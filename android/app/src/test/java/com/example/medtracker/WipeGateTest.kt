package com.example.medtracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** bd med-r1j2.12: local-origin loads wait for an in-flight local.erase wipe. */
class WipeGateTest {
    @Test
    fun aLoadDuringTheWipeRunsOnlyAfterIt() {
        val g = WipeGate()
        val ran = mutableListOf<String>()
        assertTrue(g.start())
        g.after { ran += "local" } // a switch to local mode mid-wipe
        assertTrue(g.busy)
        assertEquals(emptyList<String>(), ran)
        g.end()
        assertEquals(listOf("local"), ran)
        assertFalse(g.busy)
    }

    @Test
    fun noWipeNoWait() {
        val g = WipeGate()
        var ran = false
        g.after { ran = true }
        assertTrue(ran)
    }

    @Test
    fun oneWipeAtATime() {
        val g = WipeGate()
        assertTrue(g.start())
        assertFalse(g.start())
        g.end()
        g.end() // idempotent
        assertTrue(g.start())
    }
}
