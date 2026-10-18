package com.example.medtracker

import org.junit.Assert.assertEquals
import org.junit.Test

// The same cases as ios/Tests/main.swift (AccountURL), run by android.yml.
class AccountUrlTest {
    private val base = "app.example.com"

    private fun check(input: String, want: String?, base: String = this.base) =
        assertEquals(input, want, AccountUrl.parse(input, base))

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
    fun color() {
        assertEquals(0xFF132D29.toInt(), cssColor("rgb(19, 45, 41)"))
        assertEquals(0xFFFFFFFF.toInt(), cssColor("rgba(255, 255, 255, 0.5)"))
        assertEquals(null, cssColor("rgba(0, 0, 0, 0)"))
        assertEquals(null, cssColor("transparent"))
        assertEquals(null, cssColor(""))
    }
}
