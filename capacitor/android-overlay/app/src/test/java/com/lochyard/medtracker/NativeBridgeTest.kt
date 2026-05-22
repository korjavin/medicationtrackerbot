package com.lochyard.medtracker

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.concurrent.LinkedBlockingDeque

// Pure-JVM coverage for the NativeBridge ↔ GoServerService.LocalBinder
// surface that the Settings → Backend logs screen consumes (Task 5). Lives
// under src/test/ so `./gradlew test` runs it without an emulator. The full
// addJavascriptInterface roundtrip into a real WebView is exercised by the
// instrumentation suite — these tests guard the wiring contract.
//
// The log-ring behaviour is reimplemented in-test against the same
// LinkedBlockingDeque shape used in production: the GoServerService class
// transitively depends on android.* symbols, so we can't import it from a
// JVM `test` source set. The behaviour pinned here (drop-oldest at capacity,
// chronological tail) is what NativeBridge.getBackendLogs() relies on.
class NativeBridgeTest {

    @Test
    fun apiBaseRoundTripsThroughTheBridge() {
        val bridge = NativeBridge(apiBase = "http://127.0.0.1:54321", binderProvider = { null })
        assertEquals("http://127.0.0.1:54321", bridge.apiBase())
    }

    @Test
    fun getBackendLogsReturnsEmptyWhenBinderUnavailable() {
        val bridge = NativeBridge(apiBase = "http://127.0.0.1:54321", binderProvider = { null })
        assertEquals("", bridge.getBackendLogs())
    }

    @Test
    fun logRingDropsOldestAtCapacity() {
        // Mirrors GoServerService.pushLogLine() — bounded LinkedBlockingDeque,
        // offer-then-poll-on-failure. We verify the most-recent-N invariant
        // that the backend-logs screen depends on.
        val capacity = 4
        val ring = LinkedBlockingDeque<String>(capacity)
        val incoming = listOf("a", "b", "c", "d", "e", "f")
        for (line in incoming) {
            while (!ring.offer(line)) ring.poll()
        }
        assertEquals(listOf("c", "d", "e", "f"), ring.toList())
    }
}
