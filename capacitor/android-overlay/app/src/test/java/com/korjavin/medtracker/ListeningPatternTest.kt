package com.korjavin.medtracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.regex.Pattern

// Pure-JVM mirror of the LISTENING_PATTERN check in GoServerServiceTest.
// Lives under src/test/ (NOT src/androidTest/) so it runs on `./gradlew test`
// without needing an emulator. The instrumentation suite still verifies the
// same invariant end-to-end, but this unit test is what catches a regex typo
// in 50 ms on every CI run.
//
// The regex itself is duplicated here rather than imported from
// GoServerService — that class depends on android.* symbols, which the JVM
// `test` source set can't link against. Keeping the regex in two places is
// the lesser evil; a CI lane that runs both src/test/ and src/androidTest/
// will catch any drift between them via the instrumentation test below.
class ListeningPatternTest {

    private val pattern: Pattern = Pattern.compile("^LISTENING 127\\.0\\.0\\.1:(\\d+)$")

    @Test
    fun matchesCanonicalListeningLine() {
        val m = pattern.matcher("LISTENING 127.0.0.1:54321")
        assertTrue(m.matches())
        assertEquals(54321, m.group(1)!!.toInt())
    }

    @Test
    fun rejectsNonLoopbackHost() {
        assertFalse(pattern.matcher("LISTENING 0.0.0.0:54321").matches())
        assertFalse(pattern.matcher("LISTENING 192.168.1.5:54321").matches())
    }

    @Test
    fun rejectsNonNumericPort() {
        assertFalse(pattern.matcher("LISTENING 127.0.0.1:abc").matches())
        assertFalse(pattern.matcher("LISTENING 127.0.0.1:").matches())
    }

    @Test
    fun rejectsLeadingWhitespaceOrExtraTokens() {
        assertFalse(pattern.matcher(" LISTENING 127.0.0.1:80").matches())
        assertFalse(pattern.matcher("LISTENING 127.0.0.1:80 ").matches())
        assertFalse(pattern.matcher("LISTENING 127.0.0.1:80 extra").matches())
    }

    @Test
    fun rejectsOrdinaryLogLines() {
        assertFalse(pattern.matcher("info: server starting").matches())
        assertFalse(pattern.matcher("").matches())
    }
}
