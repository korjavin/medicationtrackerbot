package com.example.medtracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Push's kind mapping mirrors internal/cloudserver/nativepush.go (nativeWakeTitleFor + nativeWakeBody). */
class PushTest {
    @Test
    fun serverKindsMapToTheirFixedText() {
        assertEquals("Med Tracker" to "Open the app to record what you sent", Push.text("inbox-wake"))
        assertEquals("Med Tracker" to "Open the app to keep reminders running", Push.text("dry-queue"))
        assertEquals(
            "Approve the new device?" to "A new device is waiting · approve it before the code expires",
            Push.text("transfer_claimed"),
        )
        listOf("token", "transfer-claimed", "", "Inbox-wake").forEach { assertNull(it, Push.text(it)) }
    }

    @Test
    fun onlyATransferClaimedTapOpensAddDevice() {
        assertEquals("/?tab=settings&page=add-device", Push.tappedPath("transfer_claimed", fromHistory = false))
        assertNull(Push.tappedPath("transfer_claimed", fromHistory = true))
        listOf(null, "inbox-wake", "dry-queue", "transfer-claimed").forEach { assertNull("$it", Push.tappedPath(it, false)) }
    }
}
