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

    // The debug launch extra wgQAScene's parser (bd med-nt9p.32.4), the iOS qaHome rules.
    @Test
    fun qaHome() {
        assertEquals("https://appassets.androidplatform.net/?qa=today-dark", LocalOrigin.qaHome("today-dark"))
        assertEquals("${LocalOrigin.HOME}?qa=${"a".repeat(64)}", LocalOrigin.qaHome("a".repeat(64)))
        for (bad in listOf(null, "", "a".repeat(65), "Today", "a b", "a&x=1", "../x", "a/b", "é"))
            assertNull("accepted $bad", LocalOrigin.qaHome(bad))
    }

    @Test
    fun bridgeGate() {
        val acct = "me.example.org"
        assertTrue(LocalOrigin.bridgeCaller(true, "https", acct, acct))
        assertTrue(LocalOrigin.bridgeCaller(true, "https", "ME.example.org", acct))
        assertTrue(LocalOrigin.bridgeCaller(true, "https", LocalOrigin.HOST, LocalOrigin.HOST))
        // An account page while local mode is open, the asset origin in account mode, frames, http, no vault.
        assertFalse(LocalOrigin.bridgeCaller(true, "https", acct, LocalOrigin.HOST))
        assertFalse(LocalOrigin.bridgeCaller(true, "https", LocalOrigin.HOST, acct))
        assertFalse(LocalOrigin.bridgeCaller(false, "https", acct, acct))
        assertFalse(LocalOrigin.bridgeCaller(true, "http", acct, acct))
        assertFalse(LocalOrigin.bridgeCaller(true, "https", null, null))
        assertFalse(LocalOrigin.bridgeCaller(true, "https", "other.example.org", acct))
        for (op in listOf("setEgressHosts", "local.reset", "local.leave", "attest.status", "attest.enroll", "attest.setPass", "attest.assert", "lock.status", "lock.set", "move.stash", "leave.take", "leave.clear", "base.post")) {
            assertFalse(op, LocalOrigin.opAllowed(op, local = false))
            assertTrue(op, LocalOrigin.opAllowed(op, local = true))
        }
        // account.leave (bd med-nt9p.32.13) and the move's pickup (bd med-nt9p.32.17): account mode only.
        for (op in listOf("account.leave", "move.take", "move.clear", "leave.stash")) {
            assertTrue(op, LocalOrigin.opAllowed(op, local = false))
            assertFalse(op, LocalOrigin.opAllowed(op, local = true))
        }
        for (op in listOf("ping", "chrome", "shell.ops", "notifications.schedule", "health.query", "")) {
            assertTrue(op, LocalOrigin.opAllowed(op, local = false))
            assertTrue(op, LocalOrigin.opAllowed(op, local = true))
        }
    }

    // shell.ops (bd med-nt9p.32.13): the page's capability probe lists only what the gate lets through.
    @Test
    fun shellOps() {
        val account = LocalOrigin.ops(local = false)
        val local = LocalOrigin.ops(local = true)
        assertTrue(account.containsAll(listOf("ping", "shell.ops", "account.leave", "notifications.schedule", "health.query")))
        assertTrue(account.contains("notifications.openSettings") && local.contains("notifications.openSettings"))
        assertTrue(account.contains("app.openSettings") && local.contains("app.openSettings"))
        assertTrue(account.contains("account.leave.forget") && !local.contains("account.leave.forget"))
        assertTrue(account.containsAll(listOf("move.take", "move.clear")))
        // The invite slot and F1's Paste (bd med-ta2n.12.1): both modes.
        val invite = listOf("invite.pending", "invite.clear", "clipboard.read")
        assertTrue(account.containsAll(invite) && local.containsAll(invite))
        assertFalse(account.contains("local.leave"))
        assertFalse(account.contains("move.stash"))
        assertTrue(account.contains("leave.stash"))
        assertFalse(account.contains("leave.take") || account.contains("leave.clear"))
        assertTrue(local.containsAll(listOf("ping", "shell.ops", "local.leave", "lock.set", "attest.assert", "move.stash")))
        assertFalse(local.contains("account.leave"))
        assertFalse(local.contains("move.take") || local.contains("move.clear"))
        assertTrue(local.containsAll(listOf("leave.take", "leave.clear")))
        assertFalse(local.contains("leave.stash"))
        // base.post (bd med-ta2n.27): local only; an account page gets "unsupported: base.post".
        assertTrue(local.contains("base.post") && !account.contains("base.post"))
        for (op in account) assertTrue(op, LocalOrigin.opAllowed(op, local = false))
        for (op in local) assertTrue(op, LocalOrigin.opAllowed(op, local = true))
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
