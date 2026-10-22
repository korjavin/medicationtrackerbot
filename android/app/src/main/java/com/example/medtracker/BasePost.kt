package com.example.medtracker

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Timer
import kotlin.concurrent.schedule

/**
 * The bridge op base.post (contract med-ta2n.24 §A, bd med-ta2n.27; iOS twin med-ta2n.26): local
 * mode's invite request and attested feedback, POSTed by the shell to its own deployment — never
 * page fetch, so the local CSP stays without the base host. A dumb allowlisted pipe: the page
 * signs and sets the X-Attest-* headers (attest.assert), the shell only carries the bytes.
 *
 *   base.post {path, body, headers?} → {status, headers, body}
 *
 * The shell's first native egress. Blocking (callers run it off the main thread); no Android
 * types, so BasePostTest runs it on the JVM. Nothing here logs: not the path, body, headers or status.
 */
object BasePost {
    const val MAX_BODY = 5_242_880 // = the server's maxFeedbackBodyBytes
    const val MAX_RESPONSE = 65_536
    const val MAX_HEADER = 8192
    const val TIMEOUT_MS = 30_000
    val REQUEST_HEADERS = setOf("X-Attest-Key-Id", "X-Attest-Challenge", "X-Attest-Assertion")
    val RESPONSE_HEADERS = listOf("X-Attest-Challenge", "X-Trial-Remaining", "Retry-After")

    /** The op's error string (contract A6); nothing else ever reaches the page. */
    class Failure(message: String) : Exception(message)

    class Reply(val status: Int, val headers: Map<String, String>, val body: String)

    private val deadlines = Timer("base.post deadline", true)

    /** [headers]: null when absent, else must be a Map of the allowlisted names to strings. */
    fun post(base: String, path: Any?, body: Any?, headers: Any?): Reply {
        if (base.isEmpty()) throw Failure("no base")
        return send("https://$base", path, body, headers)
    }

    /** [root] is "https://" + base in production; the JVM test points it at a loopback server. */
    internal fun send(root: String, path: Any?, body: Any?, headers: Any?, timeoutMs: Int = TIMEOUT_MS): Reply {
        if (path !is String || path !in LocalOrigin.BASE_POST_PATHS) throw Failure("invalid path")
        if (body !is String) throw Failure("invalid body")
        val bytes = body.toByteArray(Charsets.UTF_8) // verbatim: the assertion binds SHA256(path + "\n" + body)
        if (bytes.size > MAX_BODY) throw Failure("body too large")
        val extra = validHeaders(headers) ?: throw Failure("invalid headers")

        val conn = try {
            URL(root + path).openConnection() as HttpURLConnection
        } catch (e: IOException) {
            throw Failure("network")
        }
        // The whole call, connect to last byte: a server dripping bytes under readTimeout still ends.
        // Two halves: the timer's disconnect aborts a blocked connect/write/read (OkHttp-backed on
        // Android); the body loop checks the clock itself (the JVM's disconnect doesn't abort a read).
        val until = System.nanoTime() + timeoutMs * 1_000_000L
        val deadline = deadlines.schedule(timeoutMs.toLong()) { runCatching { conn.disconnect() } } // a throw would kill the shared timer
        try {
            conn.requestMethod = "POST"
            conn.instanceFollowRedirects = false // a 3xx is the reply, never a second egress
            conn.useCaches = false
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(bytes.size)
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Accept", "application/json")
            extra.forEach { (k, v) -> conn.setRequestProperty(k, v) }
            conn.outputStream.use { it.write(bytes) }
            val status = conn.responseCode
            if (status < 0) throw Failure("network") // no valid status line
            val out = RESPONSE_HEADERS.mapNotNull { h -> conn.getHeaderField(h)?.let { h to it } }.toMap()
            val stream: InputStream? = if (status >= 400) conn.errorStream else conn.inputStream
            return Reply(status, out, stream?.use { read(it, until) } ?: "")
        } catch (e: Failure) {
            throw e
        } catch (e: Exception) {
            // IOException, a timeout, or the deadline's disconnect surfacing as anything else:
            // this runs on a worker thread, so nothing may escape uncaught.
            throw Failure("network")
        } finally {
            deadline.cancel()
            conn.disconnect()
        }
    }

    private fun read(input: InputStream, until: Long): String {
        val buf = ByteArrayOutputStream()
        val chunk = ByteArray(8192)
        while (true) {
            val n = input.read(chunk)
            if (n < 0) break
            buf.write(chunk, 0, n)
            if (buf.size() > MAX_RESPONSE) throw Failure("response too large")
            if (System.nanoTime() > until) throw Failure("network")
        }
        return buf.toString(Charsets.UTF_8.name())
    }

    /** Only the three X-Attest-* names, case-sensitive; string values ≤ 8 KiB with no line break. */
    internal fun validHeaders(raw: Any?): Map<String, String>? {
        if (raw == null) return emptyMap()
        if (raw !is Map<*, *>) return null
        val out = mutableMapOf<String, String>()
        for ((k, v) in raw) {
            if (k !is String || k !in REQUEST_HEADERS || v !is String) return null
            if (v.toByteArray(Charsets.UTF_8).size > MAX_HEADER || '\r' in v || '\n' in v) return null
            out[k] = v
        }
        return out
    }
}
