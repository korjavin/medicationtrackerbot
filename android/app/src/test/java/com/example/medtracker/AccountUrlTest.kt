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
