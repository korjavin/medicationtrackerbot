package com.example.medtracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

// The local → cloud move's stash file (bd med-nt9p.32.17), run by android.yml.
class MoveTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun move() = Move(File(tmp.root, "move")) // the dir does not exist until the first stash

    private fun rejects(m: Move, vault: Any?, why: String) {
        try {
            m.stash(vault)
            fail("accepted $why")
        } catch (e: Move.Failure) {
            assertEquals(why, e.message)
        }
    }

    @Test
    fun lifecycle() {
        val m = move()
        assertFalse(m.exists)
        assertNull("no stash → null", m.take())
        m.clear() // no dir yet: a no-op
        m.stash("""{"format":"wg-vault","version":1}""")
        assertTrue(m.exists)
        assertEquals("""{"format":"wg-vault","version":1}""", m.take())
        assertEquals("take does not delete", """{"format":"wg-vault","version":1}""", m.take())
        m.stash("""{"v":"second — ünïcode"}""")
        assertEquals("one stash at a time", """{"v":"second — ünïcode"}""", m.take())
        assertEquals(listOf("vault.json"), File(tmp.root, "move").list()!!.toList())
        m.clear()
        assertFalse(m.exists)
        assertNull(m.take())
    }

    @Test
    fun invalid() {
        val m = move()
        rejects(m, null, "invalid vault")
        rejects(m, 42, "invalid vault")
        rejects(m, "", "invalid vault")
        // Bytes, not chars: a 3-byte char string under the char cap but over the byte cap.
        rejects(m, "€".repeat(Move.MAX_BYTES / 3 + 1), "too large")
        assertFalse("a rejected stash writes nothing", m.exists)
        m.stash("old")
        rejects(m, "a".repeat(Move.MAX_BYTES + 1), "too large")
        assertEquals("a rejected stash keeps the old one", "old", m.take())
    }

    @Test
    fun clearDropsALeftoverTemp() {
        val dir = File(tmp.root, "move").apply { mkdirs() }
        File(dir, "vault.json.tmp").writeText("partial")
        Move(dir).clear()
        assertEquals(0, dir.list()!!.size)
    }
}
