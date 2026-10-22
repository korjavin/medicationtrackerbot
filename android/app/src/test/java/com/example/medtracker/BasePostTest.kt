package com.example.medtracker

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.InetSocketAddress
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

// base.post against a loopback server (contract med-ta2n.24 A7, bd med-ta2n.27).
class BasePostTest {
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
        executor = Executors.newCachedThreadPool()
        start()
    }
    private val root = "http://127.0.0.1:${server.address.port}"
    private val hits = AtomicInteger()
    private val received = ConcurrentHashMap<String, Any>()

    @After fun stop() = server.stop(0)

    private fun route(path: String, handle: (HttpExchange) -> Unit) = server.createContext(path) { ex ->
        hits.incrementAndGet()
        received["body"] = ex.requestBody.readBytes()
        received["headers"] = ex.requestHeaders
        handle(ex)
        ex.close()
    }

    private fun reply(ex: HttpExchange, status: Int, body: ByteArray = ByteArray(0)) {
        ex.sendResponseHeaders(status, if (body.isEmpty()) -1 else body.size.toLong())
        if (body.isNotEmpty()) ex.responseBody.write(body)
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
        route("/") { reply(it, 200) }
        for (p in listOf("/api/attest/chat", "/api/invite-requests?x=1", "api/invite-requests", "/api/invite-requests/", null, 7)) {
            fails("invalid path") { BasePost.send(root, p, "{}", null) }
        }
        assertEquals(0, hits.get())
    }

    @Test fun bodyMustBeAString() {
        fails("invalid body") { BasePost.send(root, "/api/invite-requests", null, null) }
        fails("invalid body") { BasePost.send(root, "/api/invite-requests", 42, null) }
    }

    @Test fun bodyCapBeforeConnecting() {
        route("/") { reply(it, 200) }
        fails("body too large") { BasePost.send(root, "/api/attest/feedback", "a".repeat(BasePost.MAX_BODY + 1), null) }
        assertEquals(0, hits.get())
    }

    @Test fun headerAllowlist() {
        for (h in listOf(
            mapOf("Cookie" to "a=b"), mapOf("Content-Type" to "text/plain"), mapOf("x-attest-key-id" to "k"),
            mapOf("X-Attest-Key-Id" to "a".repeat(9 * 1024)), mapOf("X-Attest-Key-Id" to 1),
            mapOf("X-Attest-Key-Id" to "a\r\nX-Evil: 1"), "X-Attest-Key-Id",
        )) fails("invalid headers") { BasePost.send(root, "/api/attest/feedback", "{}", h) }
    }

    @Test fun noBase() = fails("no base") { BasePost.post("", "/api/invite-requests", "{}", null) }

    @Test fun verbatimBodyAndHeaders() {
        route("/api/attest/feedback") { ex ->
            ex.responseHeaders.add("X-Attest-Challenge", "c2")
            ex.responseHeaders.add("X-Trial-Remaining", "3")
            ex.responseHeaders.add("Retry-After", "5")
            ex.responseHeaders.add("X-Other", "no")
            reply(ex, 202, """{"ok":true}""".toByteArray())
        }
        // Real non-ASCII, a JSON escape, a number form a re-serializer would change, trailing spaces.
        val body = "{\"text\":\"h\u00e9llo \ud83d\ude42\",\"esc\":\"\\u00e9\",\"n\":1.50,\"x\":\"\u2028\"}  "
        val r = BasePost.send(root, "/api/attest/feedback", body, mapOf("X-Attest-Key-Id" to "kid", "X-Attest-Assertion" to "sig"))
        assertEquals(202, r.status)
        assertEquals("""{"ok":true}""", r.body)
        assertEquals(mapOf("X-Attest-Challenge" to "c2", "X-Trial-Remaining" to "3", "Retry-After" to "5"), r.headers)
        assertArrayEquals(sha(body.toByteArray(Charsets.UTF_8)), sha(received["body"] as ByteArray))
        val h = received["headers"] as com.sun.net.httpserver.Headers
        assertEquals("kid", h.getFirst("X-Attest-Key-Id"))
        assertEquals("sig", h.getFirst("X-Attest-Assertion"))
        assertEquals("application/json", h.getFirst("Content-Type"))
        assertEquals("application/json", h.getFirst("Accept"))
        assertEquals(null, h.getFirst("Cookie"))
    }

    @Test fun redirectIsNotFollowed() {
        val followed = AtomicInteger()
        server.createContext("/elsewhere") { followed.incrementAndGet(); reply(it, 200); it.close() }
        route("/api/invite-requests") { ex ->
            ex.responseHeaders.add("Location", "$root/elsewhere")
            reply(ex, 302)
        }
        val r = BasePost.send(root, "/api/invite-requests", "{}", null)
        assertEquals(302, r.status)
        assertEquals(0, followed.get())
    }

    @Test fun errorStatusIsAReply() {
        route("/api/invite-requests") { ex ->
            ex.responseHeaders.add("Retry-After", "60")
            reply(ex, 429, """{"error":"busy"}""".toByteArray())
        }
        val r = BasePost.send(root, "/api/invite-requests", "{}", null)
        assertEquals(429, r.status)
        assertEquals("""{"error":"busy"}""", r.body)
        assertEquals(mapOf("Retry-After" to "60"), r.headers)
    }

    @Test fun noContent() {
        route("/api/attest/feedback") { reply(it, 204) }
        val r = BasePost.send(root, "/api/attest/feedback", "{}", null)
        assertEquals(204, r.status)
        assertEquals("", r.body)
    }

    @Test fun responseCap() {
        route("/api/attest/challenge") { reply(it, 200, ByteArray(BasePost.MAX_RESPONSE + 1) { 'a'.code.toByte() }) }
        fails("response too large") { BasePost.send(root, "/api/attest/challenge", "{}", null) }
    }

    @Test fun stalledServerIsNetwork() {
        route("/api/attest/enroll") { Thread.sleep(10_000) }
        val start = System.nanoTime()
        fails("network") { BasePost.send(root, "/api/attest/enroll", "{}", null, timeoutMs = 1000) }
        assertTrue((System.nanoTime() - start) / 1_000_000 < 5000)
    }

    @Test fun refusedConnectionIsNetwork() {
        val dead = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val port = dead.address.port
        dead.stop(0)
        fails("network") { BasePost.send("http://127.0.0.1:$port", "/api/attest/enroll", "{}", null) }
    }
}
