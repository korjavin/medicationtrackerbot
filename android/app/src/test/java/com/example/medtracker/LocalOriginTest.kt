package com.example.medtracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The LocalOrigin cases of ios/Tests/main.swift (bd med-o7zq.4), run by android.yml.
class LocalOriginTest {
    private fun route(path: String, want: String?) = assertEquals(path, want, LocalOrigin.file(path))

    @Test
    fun file() {
        route("/", "web/index.html")
        route("", "web/index.html") // https://appassets.androidplatform.net without the slash
        route("/static/js/core/utils.js", "web/static/js/core/utils.js")
        route("/domain/bp.js", "web/domain/bp.js")
        route("/js/apishim.js", "web/cloud/js/apishim.js")
        route("/vendor/qrcode.mjs", "web/cloud/vendor/qrcode.mjs")
        route("/qa/driver.js", "web/cloud/qa/driver.js") // only a QA=1 bundle has the file
        route("/index.html", "web/cloud/index.html") // as on an account host: "/" is the app document
        route("/static/../../etc/passwd", null)
        route("/./js/a.js", null)
        route("/js/..", null)
        route("/static/", null)
        route("relative.js", null)
    }

    @Test
    fun csp() {
        val csp = LocalOrigin.csp(listOf("api.openai.com"))
        assertTrue(csp, csp.contains("connect-src 'self' https://api.openai.com wss://api.openai.com;"))
        assertFalse("wildcard in $csp", Regex("(https|wss):[; ]").containsMatchIn(csp))
        assertTrue(LocalOrigin.csp(emptyList()).contains("connect-src 'self';"))
        assertTrue(csp.contains("script-src 'self';") && csp.contains("object-src 'none'"))
    }

    @Test
    fun validHosts() {
        assertEquals(listOf("api.openai.com", "api.anthropic.com"), LocalOrigin.validHosts(listOf("api.openai.com", "api.anthropic.com")))
        assertEquals(emptyList<String>(), LocalOrigin.validHosts(emptyList<String>()))
        val bad: List<Any?> = listOf(
            null, "api.openai.com", listOf(1), listOf("API.openai.com"), listOf("a.com b.com"), listOf("https://a.com"),
            listOf("a.com:443"), listOf("a.com/x"), listOf(".a.com"), listOf("a.com."), listOf("a..com"), listOf("-a.com"),
            listOf("*.a.com"), listOf(""), listOf("[::1]"), listOf("a.com", null), List(LocalOrigin.MAX_HOSTS + 1) { "a.com" },
        )
        for (b in bad) assertNull("accepted $b", LocalOrigin.validHosts(b))
        // The SharedPreferences mirror round-trips, and a tampered one reads as no hosts.
        val hosts = listOf("api.openai.com", "api.anthropic.com")
        assertEquals(hosts, LocalOrigin.decodeHosts(LocalOrigin.encodeHosts(hosts)))
        assertEquals(emptyList<String>(), LocalOrigin.decodeHosts(null))
        assertEquals(emptyList<String>(), LocalOrigin.decodeHosts(""))
        assertEquals(emptyList<String>(), LocalOrigin.decodeHosts("evil.com 'unsafe-inline'"))
    }

    @Test
    fun mime() {
        assertEquals("text/javascript", LocalOrigin.mime("web/cloud/js/a.js"))
        assertEquals("text/javascript", LocalOrigin.mime("web/cloud/vendor/q.mjs"))
        assertEquals("font/woff2", LocalOrigin.mime("web/static/fonts/x.woff2"))
        assertEquals("text/html", LocalOrigin.mime(LocalOrigin.file("")!!))
        assertEquals("application/manifest+json", LocalOrigin.mime("a.webmanifest"))
        assertEquals("application/octet-stream", LocalOrigin.mime("web/cloud/LICENSE"))
    }
}
