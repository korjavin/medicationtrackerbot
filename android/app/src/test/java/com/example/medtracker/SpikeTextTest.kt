package com.example.medtracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class SpikeTextTest {
    @Test
    fun baseOf() {
        assertEquals("example.org", SpikeText.baseOf("Acct.Example.org"))
        assertEquals("cloud.example.org", SpikeText.baseOf("a1.cloud.example.org"))
        assertNull(SpikeText.baseOf("example.org"))
        assertNull(SpikeText.baseOf("localhost"))
    }

    @Test
    fun redactHidesBaseAndLabels() {
        val out = SpikeText.redact("loaded https://alice.example.org/ then https://Bob.example.org/x and example.org", "example.org")
        assertFalse(out.contains("example", ignoreCase = true))
        assertFalse(out.contains("alice", ignoreCase = true))
        assertFalse(out.contains("bob", ignoreCase = true))
        // Same label → same tag; different labels → different tags.
        val tags = Regex("<sub-([0-9a-f]{6})>").findAll(out).map { it.groupValues[1] }.toList()
        assertEquals(2, tags.size)
        assertEquals(tags[0] == tags[1], false)
        assertEquals(SpikeText.redact("alice.example.org", "example.org"), SpikeText.redact("ALICE.example.org", "example.org"))
        assertEquals("no base", SpikeText.redact("no base", ""))
    }
}
