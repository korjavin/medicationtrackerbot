package com.example.medtracker

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

// base.post against a scripted loopback HTTP/1.1 server (contract med-ta2n.24 A7, bd med-ta2n.27).
// A raw ServerSocket: the unit-test classpath is android.jar, which has no com.sun.net.httpserver.
class BasePostTest {
    class Req(val path: String, val headers: Map<String, String>, val body: ByteArray)

    private val requests = CopyOnWriteArrayList<Req>()
    @Volatile private var respond: (Req) -> ByteArray = { raw(200) }
    private val socket = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
    private val root = "http://127.0.0.1:${socket.localPort}"

    init {
        thread(isDaemon = true) {
            while (!socket.isClosed) {
                val c = runCatching { socket.accept() }.getOrNull() ?: break
                thread(isDaemon = true) { serve(c) }
            }
        }
    }

    @After fun stop() = socket.close()

    private fun serve(c: Socket): Unit = c.use {
        val input = c.getInputStream()
        val lines = generateSequence { line(input) }.takeWhile { it.isNotEmpty() }.toList()
        if (lines.isEmpty()) return@use
        val headers = lines.drop(1).associate { it.substringBefore(':').trim().lowercase() to it.substringAfter(':').trim() }
        val body = ByteArray(headers["content-length"]?.toInt() ?: 0)
        var off = 0
        while (off < body.size) {
            val n = input.read(body, off, body.size - off)
            if (n < 0) break
            off += n
        }
        val req = Req(lines[0].split(' ')[1], headers, body)
        requests += req
        runCatching { c.getOutputStream().apply { write(respond(req)); flush() } }
        Unit
    }

    private fun line(input: InputStream): String? {
        val b = ByteArrayOutputStream()
        while (true) {
            val ch = input.read()
            if (ch < 0) return if (b.size() == 0) null else b.toString("UTF-8")
            if (ch == '\n'.code) return b.toString("UTF-8").trimEnd('\r')
            b.write(ch)
        }
    }

    private fun raw(status: Int, headers: List<String> = emptyList(), body: ByteArray = ByteArray(0)): ByteArray {
        val head = (listOf("HTTP/1.1 $status X") + headers + listOf("Content-Length: ${body.size}", "Connection: close", "", ""))
            .joinToString("\r\n")
        return head.toByteArray() + body
    }

    private fun fails(expected: String, block: () -> Unit) {
        try {
            block()
            fail("expected $expected")
        } catch (e: BasePost.Failure) {
            assertEquals(expected, e.message)
        }
    }

    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b)

    @Test fun allowlistIsExact() {
        for (p in listOf("/api/attest/chat", "/api/invite-requests?x=1", "api/invite-requests", "/api/invite-requests/", null, 7)) {
            fails("invalid path") { BasePost.send(root, p, "{}", null) }
        }
        assertEquals(0, requests.size)
    }

    @Test fun bodyMustBeAString() {
        fails("invalid body") { BasePost.send(root, "/api/invite-requests", null, null) }
        fails("invalid body") { BasePost.send(root, "/api/invite-requests", 42, null) }
        assertEquals(0, requests.size)
    }

    @Test fun bodyCapBeforeConnecting() {
        fails("body too large") { BasePost.send(root, "/api/attest/feedback", "a".repeat(BasePost.MAX_BODY + 1), null) }
        assertEquals(0, requests.size)
    }

    @Test fun headerAllowlist() {
        for (h in listOf(
            mapOf("Cookie" to "a=b"), mapOf("Content-Type" to "text/plain"), mapOf("x-attest-key-id" to "k"),
            mapOf("X-Attest-Key-Id" to "a".repeat(9 * 1024)), mapOf("X-Attest-Key-Id" to 1),
            mapOf("X-Attest-Key-Id" to "a\r\nX-Evil: 1"), "X-Attest-Key-Id",
        )) fails("invalid headers") { BasePost.send(root, "/api/attest/feedback", "{}", h) }
        assertEquals(0, requests.size)
    }

    @Test fun noBase() = fails("no base") { BasePost.post("", "/api/invite-requests", "{}", null) }

    @Test fun verbatimBodyAndHeaders() {
        respond = {
            raw(202, listOf("X-Attest-Challenge: c2", "X-Trial-Remaining: 3", "Retry-After: 5", "X-Other: no"), """{"ok":true}""".toByteArray())
        }
        // Real non-ASCII, a JSON escape, a number form a re-serializer would change, trailing spaces.
        val body = "{\"text\":\"h\u00e9llo \ud83d\ude42\",\"esc\":\"\\u00e9\",\"n\":1.50,\"x\":\"\u2028\"}  "
        val r = BasePost.send(root, "/api/attest/feedback", body, mapOf("X-Attest-Key-Id" to "kid", "X-Attest-Assertion" to "sig"))
        assertEquals(202, r.status)
        assertEquals("""{"ok":true}""", r.body)
        assertEquals(mapOf("X-Attest-Challenge" to "c2", "X-Trial-Remaining" to "3", "Retry-After" to "5"), r.headers)
        val req = requests.single()
        assertEquals("/api/attest/feedback", req.path)
        assertArrayEquals(sha(body.toByteArray(Charsets.UTF_8)), sha(req.body))
        assertEquals("kid", req.headers["x-attest-key-id"])
        assertEquals("sig", req.headers["x-attest-assertion"])
        assertEquals("application/json", req.headers["content-type"])
        assertEquals("application/json", req.headers["accept"])
        assertNull(req.headers["cookie"])
    }

    @Test fun redirectIsNotFollowed() {
        respond = { raw(302, listOf("Location: $root/elsewhere")) }
        val r = BasePost.send(root, "/api/invite-requests", "{}", null)
        assertEquals(302, r.status)
        assertEquals(listOf("/api/invite-requests"), requests.map { it.path })
    }

    @Test fun errorStatusIsAReply() {
        respond = { raw(429, listOf("Retry-After: 60"), """{"error":"busy"}""".toByteArray()) }
        val r = BasePost.send(root, "/api/invite-requests", "{}", null)
        assertEquals(429, r.status)
        assertEquals("""{"error":"busy"}""", r.body)
        assertEquals(mapOf("Retry-After" to "60"), r.headers)
    }

    @Test fun noContent() {
        respond = { "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".toByteArray() }
        val r = BasePost.send(root, "/api/attest/feedback", "{}", null)
        assertEquals(204, r.status)
        assertEquals("", r.body)
    }

    @Test fun responseCap() {
        respond = { raw(200, body = ByteArray(BasePost.MAX_RESPONSE + 1) { 'a'.code.toByte() }) }
        fails("response too large") { BasePost.send(root, "/api/attest/challenge", "{}", null) }
    }

    @Test fun stalledServerIsNetwork() {
        respond = { Thread.sleep(10_000); raw(200) }
        val start = System.nanoTime()
        fails("network") { BasePost.send(root, "/api/attest/enroll", "{}", null, timeoutMs = 1000) }
        assertTrue((System.nanoTime() - start) / 1_000_000 < 5000)
    }

    @Test fun drippingServerHitsTheWholeCallDeadline() {
        // Each byte arrives inside readTimeout; only the whole-call deadline ends it.
        val drip = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        thread(isDaemon = true) {
            runCatching {
                drip.accept().use { c ->
                    generateSequence { line(c.getInputStream()) }.takeWhile { it.isNotEmpty() }.toList()
                    val out = c.getOutputStream()
                    out.write("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n".toByteArray())
                    repeat(1000) { out.write('a'.code); out.flush(); Thread.sleep(200) }
                }
            }
        }
        val start = System.nanoTime()
        fails("network") { BasePost.send("http://127.0.0.1:${drip.localPort}", "/api/attest/enroll", "", null, timeoutMs = 1000) }
        assertTrue((System.nanoTime() - start) / 1_000_000 < 5000)
        drip.close()
    }

    @Test fun droppedReplyIsNotRetried() {
        // The server got the whole POST and hung up without a status: one request, never a silent resend.
        respond = { ByteArray(0) }
        fails("network") { BasePost.send(root, "/api/invite-requests", "{}", null) }
        Thread.sleep(200) // a retry would land here
        assertEquals(1, requests.size)
        assertEquals("close", requests.single().headers["connection"])
    }

    @Test fun refusedConnectionIsNetwork() {
        val port = ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { it.localPort }
        fails("network") { BasePost.send("http://127.0.0.1:$port", "/api/attest/enroll", "{}", null) }
    }
}
