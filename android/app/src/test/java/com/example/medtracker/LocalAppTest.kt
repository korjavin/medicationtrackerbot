package com.example.medtracker

import java.io.ByteArrayInputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalAppTest {
    private val html = "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><script src=\"/js/local-boot.js\"></script></head><body>Vault</body></html>"
    private fun stream(text: String) = ByteArrayInputStream(text.toByteArray(Charsets.UTF_8))
    private fun body(response: LocalApp.Response) = response.body.bufferedReader().use { it.readText() }

    private fun assertOrigins(response: LocalApp.Response, html: String, expected: List<String>) {
        val tags = Regex("<meta name=\"medtracker-connect-origins\" content=\"([^\"]*)\">").findAll(html).toList()
        assertEquals("exactly one escaped metadata tag", 1, tags.size)
        val json = tags.single().groupValues[1].replace("&quot;", "\"")
        assertEquals(expected.joinToString(",", "[", "]") { "\"$it\"" }, json)
        val connect = response.headers.getValue("Content-Security-Policy")
            .substringAfter("connect-src ").substringBefore(';').split(' ')
        assertEquals(expected, connect.filter { it.startsWith("https://") && it != LocalOrigin.HOME.removeSuffix("/") }.distinct())
        assertTrue(connect.contains("'self'"))
        assertFalse(connect.any { it == "https:" || it == "wss:" })
        assertTrue(html.contains("<meta charset=\"UTF-8\"><script src=\"/js/local-boot.js\"></script>"))
        assertTrue(html.endsWith("</head><body>Vault</body></html>"))
    }

    @Test
    fun documentOriginsMatchResponseCsp() {
        for (mirror in listOf(null, "", "api.openai.com", "api.openai.com api.anthropic.com")) {
            var reads = 0
            val app = LocalApp({ reads++; mirror }, { stream(html) })
            val response = app.load("GET", "https", "/")
            val expected = LocalOrigin.decodeHosts(mirror).map { "https://$it" }
            assertOrigins(response, body(response), expected)
            assertEquals(1, reads)
            assertEquals(200, response.code)
            assertEquals("text/html", response.mime)
            assertEquals("no-store", response.headers["Cache-Control"])
            assertEquals("nosniff", response.headers["X-Content-Type-Options"])
        }
    }

    @Test
    fun invalidMirrorFailsClosedWithoutInjectingHtml() {
        for (mirror in listOf(
            "api.openai.com evil.com 'unsafe-inline'", "a.com\"><script>alert(1)</script>",
            "a.com&evil", "https://a.com", "a.com:443", "a.com\nb.com",
            List(LocalOrigin.MAX_HOSTS + 1) { "a.com" }.joinToString(" "),
        )) {
            val response = LocalApp({ mirror }, { stream(html) }).load("GET", "https", "/")
            assertEquals(LocalOrigin.csp(emptyList()), response.headers["Content-Security-Policy"])
            assertOrigins(response, body(response), emptyList())
        }
    }

    @Test
    fun navigationKeepsItsSnapshotWhenMirrorChangesDuringAssetRead() {
        var mirror = "api.openai.com"
        var reads = 0
        val app = LocalApp({ reads++; mirror }, {
            mirror = "api.anthropic.com"
            stream(html)
        })
        val first = app.load("GET", "https", "/")
        val firstHtml = body(first)
        val firstHeaders = first.headers.toMap()
        val next = app.load("GET", "https", "/")
        assertOrigins(first, firstHtml, listOf("https://api.openai.com"))
        assertOrigins(next, body(next), listOf("https://api.anthropic.com"))
        assertEquals(firstHeaders, first.headers)
        assertEquals(2, reads)
    }

    @Test
    fun selfAndDuplicateHostsDoNotBecomeExternalOrigins() {
        val mirror = "${LocalOrigin.HOST} api.openai.com api.openai.com"
        val response = LocalApp({ mirror }, { stream(html) }).load("GET", "https", "/")
        val doc = body(response)
        assertTrue(doc.contains("content=\"[&quot;https://api.openai.com&quot;]\""))
        assertFalse(doc.contains("content=\"[&quot;https://${LocalOrigin.HOST}"))
        assertEquals(LocalOrigin.csp(LocalOrigin.decodeHosts(mirror)), response.headers["Content-Security-Policy"])
    }

    @Test
    fun assetsErrorsMimeAndTraversalKeepTheirBehavior() {
        val opened = mutableListOf<String>()
        val app = LocalApp({ "api.openai.com" }, { path ->
            opened.add(path)
            if (path == "web/cloud/missing.js") error("not found")
            stream(html) // even HTML subresources are not the app document
        })
        for ((path, mime) in listOf("/js/apishim.js" to "text/javascript", "/static/a.css" to "text/css", "/index.html" to "text/html")) {
            val response = app.load("GET", "https", path)
            assertEquals(200, response.code)
            assertEquals(mime, response.mime)
            assertEquals(html, body(response))
            assertEquals("no-store", response.headers["Cache-Control"])
        }
        val before = opened.size
        for ((method, scheme, path, code) in listOf(
            listOf("GET", "https", "/static/../private", "404"),
            listOf("GET", "http", "/", "404"), listOf("POST", "https", "/", "405"),
        )) {
            val response = app.load(method, scheme, path)
            assertEquals(code.toInt(), response.code)
            assertEquals("text/plain", response.mime)
            assertEquals("", body(response))
        }
        assertEquals(before, opened.size)
        assertEquals(404, app.load("GET", "https", "/missing.js").code)
    }
}
