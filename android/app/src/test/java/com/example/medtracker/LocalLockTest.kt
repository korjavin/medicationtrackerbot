package com.example.medtracker

import com.example.medtracker.LocalLock.State
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The lock's lifecycle without BiometricPrompt, as ios/Tests/main.swift checks LocalLock.swift. */
class LocalLockTest {
    @Test
    fun offByDefaultNeverHolds() {
        val lock = LocalLock(false)
        assertFalse(lock.holds(true))
        lock.background()
        assertFalse("off: the background does not lock", lock.holds(true))
        assertNull(lock.activate(true))
    }

    @Test
    fun lifecycle() {
        val lock = LocalLock(true)
        assertTrue("cold launch: locked", lock.holds(true))
        assertFalse("local mode only", lock.holds(false))
        var attempt = lock.activate(true)!!
        assertNull("the prompt's own pause/resume must not prompt again", lock.activate(true))
        lock.finish(attempt, false, cancelled = true)
        assertEquals("cancel stays locked", State.LOCKED, lock.state)
        assertFalse("a cancel is not a failure (N3: no note)", lock.failed)
        assertNull("no prompt loop after a cancel", lock.activate(true))
        attempt = lock.begin()!!
        lock.finish(attempt, false)
        assertTrue("a failed check shows the note", lock.failed)
        lock.background()
        assertFalse("the background clears the note", lock.failed)
        attempt = lock.activate(true)!!
        lock.finish(attempt, false)
        attempt = lock.begin()!!
        assertNull("one prompt at a time", lock.begin())
        lock.background()
        val stale = attempt
        attempt = lock.activate(true)!!
        lock.finish(stale, true)
        assertEquals("a prompt from before the background must not unlock", State.UNLOCKING, lock.state)
        lock.finish(attempt, true)
        assertFalse("unlocked", lock.holds(true))
        assertNull("unlocked: no prompt on resume", lock.activate(true))
        lock.background()
        assertTrue("the background locks again", lock.holds(true))
        assertNull("no prompt from an account's mode", lock.activate(false))
        assertNotNull(lock.activate(true))
    }

    @Test
    fun confirmedTurnsOnOrOffAndUnlocks() {
        val lock = LocalLock(false)
        lock.confirmed(true)
        assertTrue(lock.on)
        assertFalse("the check that turned it on unlocks", lock.holds(true))
        lock.background()
        val attempt = lock.activate(true)!!
        lock.confirmed(false)
        assertFalse(lock.on)
        assertFalse(lock.holds(true))
        lock.finish(attempt, false)
        assertEquals("a prompt from before the choice is dropped", State.UNLOCKED, lock.state)
        lock.background()
        assertFalse("off after the choice", lock.holds(true))
    }
}
