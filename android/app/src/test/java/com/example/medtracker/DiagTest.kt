package com.example.medtracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DiagTest {
    private val base = "app.example.com"

    @Test
    fun redactsHostsAndCert() {
        val out = Diag.redact(
            """{"rp":"abc.app.example.com","message":"origin android:apk-key-hash:AbC-12_x= at https://APP.example.com/"}""",
            base,
        )
        assertFalse(out, out.contains("abc"))
        assertFalse(out, out.lowercase().contains("example.com"))
        assertTrue(out, Regex("<sub-[0-9a-f]{6}>\\.<base>").containsMatchIn(out))
        assertTrue(out, out.contains("android:apk-key-hash:<cert>"))
        assertTrue(out, out.contains("https://<base>/"))
        // Stable per label, different across labels.
        assertEquals(Diag.redact("abc.$base", base), Diag.redact("ABC.$base", base))
        assertFalse(Diag.redact("abc.$base", base) == Diag.redact("abd.$base", base))
    }

    @Test
    fun appendIsOneLineAndCapped() {
        var log = ""
        for (i in 1..Diag.CAP + 5) log = Diag.append(log, "entry $i\nsecond line", base, "T")
        val lines = log.lines()
        assertEquals(Diag.CAP, lines.size)
        assertEquals("T entry 6 second line", lines.first())
        assertEquals("T entry ${Diag.CAP + 5} second line", lines.last())
        assertTrue(Diag.append("", "x".repeat(10_000), base, "T").length <= 2000)
    }
}
