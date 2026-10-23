package com.example.medtracker

/**
 * "The user is back from the screen we opened" (bd med-nt9p.56): a resume counts only after a
 * pause that followed the open. The permission dialog's Allow is delivered just before the
 * activity's own resume, and Enable opens Alarms & reminders right then: that resume is the
 * dialog's, not the return from Alarms. Pure state, no Android types (ReturnGateTest).
 */
class ReturnGate {
    private var waiting = false
    private var left = false

    /** A settings screen was started. */
    fun opened() {
        waiting = true
        left = false
    }

    /** The activity paused: the opened screen covers it now. */
    fun paused() {
        if (waiting) left = true
    }

    /** The activity resumed: true once per open, only when it is back from that screen. */
    fun resumed(): Boolean {
        if (!waiting || !left) return false
        waiting = false
        return true
    }
}
