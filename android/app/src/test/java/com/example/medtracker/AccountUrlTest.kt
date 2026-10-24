package com.example.medtracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The same cases as ios/Tests/main.swift (AccountURL), run by android.yml.
class AccountUrlTest {
    private val base = "app.example.com"

    private fun check(input: String, want: String?, base: String = this.base) =
        assertEquals(input, want, AccountUrl.parse(input, base))

    // bd med-nt9p.32.14: only the server's marked 404 forgets the account; a proxy's bare 404 does not.
    @Test
    fun accountGone() {
        assertTrue(AccountUrl.accountGone(404, mapOf("X-Account-Gone" to "1")))
        assertTrue(AccountUrl.accountGone(404, mapOf("content-type" to "text/plain", "x-account-gone" to "1")))
        assertFalse(AccountUrl.accountGone(404, mapOf("Content-Type" to "text/plain")))
        assertFalse(AccountUrl.accountGone(404, emptyMap()))
        assertFalse(AccountUrl.accountGone(404, null))
        assertFalse(AccountUrl.accountGone(404, mapOf("X-Account-Gone" to "0")))
        assertFalse(AccountUrl.accountGone(503, mapOf("X-Account-Gone" to "1")))
    }

    @Test
    fun parse() {
        check("https://abc.app.example.com/#claim=TOKEN", "https://abc.app.example.com/#claim=TOKEN")
        check("https://abc.app.example.com/claim#slot.tk", "https://abc.app.example.com/claim#slot.tk")
        check("https://abc.app.example.com/?tab=meds", "https://abc.app.example.com/?tab=meds")
        check("abc.app.example.com", "https://abc.app.example.com/")
        check("  https://ABC.App.Example.com  ", "https://abc.app.example.com/")
        check("https://abc.app.example.com\nacct-123\nABCD-EFGH-JKMN", "https://abc.app.example.com/") // Emergency Kit QR
        check("\n\n abc.app.example.com \nx", "https://abc.app.example.com/")
        check("", null)
        check("http://abc.app.example.com/", null)
        check("https://app.example.com/", null)
        check("https://a.b.app.example.com/", null)
        check("https://evilapp.example.com/", null)
        check("https://abc.app.example.com.evil.com/", null)
        check("https://u:p@abc.app.example.com/", null)
        check("https://abc.app.example.com:8443/", null)
        check("javascript:alert(1)", null)
        check("https://abc app.example.com/", null)
        check("https://abc.app.example.com/", null, base = "")
    }

    // bd med-ta2n.12.1: the shared vectors of contract med-ta2n.7 §5, `inviteVectors` in
    // ios/Tests/main.swift (#1237), ported unchanged. "" = rejected. Add a vector there first.
    private val inviteVectors = listOf(
        "https://app.example.com/i/abc#0a1b2c" to "https://abc.app.example.com/#claim=0a1b2c",
        "https://APP.example.com/i/ABC#0a1b2c" to "https://abc.app.example.com/#claim=0a1b2c",
        "medtracker://i/abc#0a1b2c" to "https://abc.app.example.com/#claim=0a1b2c",
        "MedTracker://I/abc#0a1b2c" to "https://abc.app.example.com/#claim=0a1b2c",
        "medtracker://i/my-sub-9#00ff" to "https://my-sub-9.app.example.com/#claim=00ff",
        "https://abc.app.example.com/#claim=0a1b2c" to "https://abc.app.example.com/#claim=0a1b2c",
        "https://abc.app.example.com/#claim=0a1b2c&kit=1" to "https://abc.app.example.com/#claim=0a1b2c&kit=1",
        "abc.app.example.com" to "https://abc.app.example.com/",
        "https://app.example.com/i/abc" to "", // no token
        "https://app.example.com/i/abc#" to "", // empty token
        "https://app.example.com/i/#0a1b2c" to "", // no sub
        "https://app.example.com/i/a/b#0a1b2c" to "",
        "https://app.example.com/i/a.b#0a1b2c" to "",
        "https://app.example.com/i/a_b#0a1b2c" to "",
        "https://app.example.com/i/%61bc#0a1b2c" to "", // raw path: no percent-decoding
        "https://app.example.com/i/abc#%30a1b" to "", // raw fragment
        "https://app.example.com/i/abc#0A1B2C" to "", // token is lowercase hex
        "https://app.example.com/i/abc#0a1g" to "",
        "https://app.example.com/i/abc#0a-1b" to "",
        "https://app.example.com/i/abc#0a1b&kit=1" to "",
        "https://app.example.com/i/abc?x=1#0a1b2c" to "",
        "https://app.example.com/i/abc?#0a1b2c" to "",
        "https://app.example.com:8443/i/abc#0a1b2c" to "",
        "https://u@app.example.com/i/abc#0a1b2c" to "",
        "https://u:p@app.example.com/i/abc#0a1b2c" to "",
        "http://app.example.com/i/abc#0a1b2c" to "",
        "https://evil.com/i/abc#0a1b2c" to "",
        "https://app.example.com.evil.com/i/abc#0a1b2c" to "",
        "https://evilapp.example.com/i/abc#0a1b2c" to "",
        "https://app.example.com/x/abc#0a1b2c" to "",
        "medtracker://x/abc#0a1b2c" to "",
        "medtracker://i/abc" to "",
        "medtracker://i/#0a1b2c" to "",
        "medtracker://i/a/b#0a1b2c" to "",
        "medtracker://i:1/abc#0a1b2c" to "",
        "medtracker://u@i/abc#0a1b2c" to "",
        "medtracker://i/abc?x=1#0a1b2c" to "",
        "otherapp://i/abc#0a1b2c" to "",
        "wgapp://local/" to "",
        "" to "",
        // bd med-r1j2.8: the add-device hand-off /d/<sub>#<slot>.<TK> → the account's /claim (web invite.test.js).
        "https://app.example.com/d/ABC#AbC_d-12.QUJD" to "https://abc.app.example.com/claim#AbC_d-12.QUJD",
        "medtracker://d/abc#AbC_d-12.QUJD" to "https://abc.app.example.com/claim#AbC_d-12.QUJD",
        "https://abc.app.example.com/claim#AbC_d-12.QUJD" to "https://abc.app.example.com/claim#AbC_d-12.QUJD",
        "https://app.example.com/d/abc" to "", // no code
        "https://app.example.com/d/abc#nodot" to "",
        "https://app.example.com/d/abc#a.b.c" to "",
        "https://app.example.com/d/abc#a+b.c" to "",
        "https://app.example.com/d/abc?x=1#AbC_d-12.QUJD" to "",
        "https://app.example.com/d/a.b#AbC_d-12.QUJD" to "",
        "https://app.example.com:8443/d/abc#AbC_d-12.QUJD" to "",
        "https://u@app.example.com/d/abc#AbC_d-12.QUJD" to "",
        "https://evil.example/d/abc#AbC_d-12.QUJD" to "",
        "https://app.example.com.evil.com/d/abc#AbC_d-12.QUJD" to "",
        "medtracker://d/abc" to "",
        "medtracker://d/abc?x=1#AbC_d-12.QUJD" to "",
        "https://app.example.com/i/abc#AbC_d-12.QUJD" to "", // the invite form stays hex-only
    )

    @Test
    fun parseInvite() {
        assertEquals(56, inviteVectors.size)
        for ((input, want) in inviteVectors) assertEquals(input, want, AccountUrl.parseInvite(input, base) ?: "")
        assertEquals(null, AccountUrl.parseInvite("https://app.example.com/i/abc#0a1b2c", ""))
    }

    // Contract §4: Play hands over invite=<percent-encoded landing URL>; decoded once, then parseInvite.
    @Test
    fun referrer() {
        val claim = "https://abc.app.example.com/#claim=0a1b2c"
        fun check(referrer: String?, want: String?) = assertEquals(referrer, want, AccountUrl.referrerInvite(referrer, base))
        check("invite=https%3A%2F%2Fapp.example.com%2Fi%2Fabc%230a1b2c", claim)
        check("utm_source=x&invite=https%3A%2F%2Fapp.example.com%2Fi%2Fabc%230a1b2c&utm_medium=y", claim)
        check("invite=medtracker%3A%2F%2Fi%2Fabc%230a1b2c", claim)
        // Decoded once: a doubly encoded value stays encoded and fails the raw checks.
        check("invite=https%253A%252F%252Fapp.example.com%252Fi%252Fabc%25230a1b2c", null)
        check("invite=https%3A%2F%2Fevil.com%2Fi%2Fabc%230a1b2c", null)
        check("invite=%E0%A4%A", null) // bad escape
        check("utm_source=google-play&utm_medium=organic", null)
        check("xinvite=https%3A%2F%2Fapp.example.com%2Fi%2Fabc%230a1b2c", null)
        check("", null)
        check(null, null)
    }

    // A6: a true first install only; Play's click time, the read time only when Play says 0.
    @Test
    fun referrerRules() {
        assertTrue(Invite.readReferrer(hasHost = false, hasMode = false, done = false))
        assertFalse(Invite.readReferrer(hasHost = true, hasMode = false, done = false)) // upgrade with an account
        assertFalse(Invite.readReferrer(hasHost = false, hasMode = true, done = false)) // upgrade in local mode
        assertFalse(Invite.readReferrer(hasHost = false, hasMode = false, done = true)) // read before
        assertEquals(1_700_000_000_000L, Invite.referrerAt(1_700_000_000L, 42L))
        assertEquals(42L, Invite.referrerAt(0L, 42L))
        assertEquals("https://appassets.androidplatform.net/?invite=1", Invite.withInvite(LocalOrigin.HOME))
        assertEquals("https://appassets.androidplatform.net/?qa=today&invite=1", Invite.withInvite("${LocalOrigin.HOME}?qa=today"))
        assertEquals("https://abc.app.example.com/?invite=1", Invite.withInvite("https://abc.app.example.com/"))
        // bd med-r1j2.8: the join erase fires only for its own host, within the code's 10 minutes.
        val h = "abc.app.example.com"
        assertTrue(Invite.eraseDue(h, 1_000L, h, 1_000L + Invite.ERASE_TTL_MS))
        assertFalse(Invite.eraseDue(h, 1_000L, h, 1_001L + Invite.ERASE_TTL_MS)) // expired
        assertFalse(Invite.eraseDue(h, 1_000L, h, 999L)) // clock went back
        assertFalse(Invite.eraseDue(h, 1_000L, "xyz.app.example.com", 1_000L)) // another account
        assertFalse(Invite.eraseDue(null, 1_000L, h, 1_000L))
        assertFalse(Invite.eraseDue(h, 1_000L, null, 1_000L))
    }

    @Test
    fun download() {
        fun check(url: String, want: Boolean) = assertEquals(url, want, AccountUrl.isDownloadable(url))
        check("https://abc.app.example.com/export", true)
        check("HTTPS://other.example.org/f.pdf", true)
        check("http://abc.app.example.com/export", false) // cleartext never
        check("http://other.example.org/f.pdf", false)
        check("ftp://abc.app.example.com/f", false)
        check("blob:https://abc.app.example.com/uuid", false)
        check("data:text/plain;base64,aGk=", false)
        check("https:///nohost", false)
        check("not a url", false)
    }

    @Test
    fun color() {
        assertEquals(0xFF132D29.toInt(), cssColor("rgb(19, 45, 41)"))
        assertEquals(0xFFFFFFFF.toInt(), cssColor("rgba(255, 255, 255, 0.5)"))
        assertEquals(null, cssColor("rgba(0, 0, 0, 0)"))
        assertEquals(null, cssColor("transparent"))
        assertEquals(null, cssColor(""))
    }

    @Test
    fun ceremonyPages() {
        fun check(url: String?, want: Boolean) = assertEquals(url, want, AccountUrl.isCeremony(url, "example.com"))
        check("https://alice.example.com/unlock", true)
        check("https://alice.example.com/claim#claim=x", true)
        check("https://alice.example.com/recover", true)
        check("https://alice.example.com/", false)
        check("https://alice.example.com/unlock/x", false)
        check("https://evil.com/unlock", false)
        check("http://alice.example.com/unlock", false)
        check(null, false)
    }
}
