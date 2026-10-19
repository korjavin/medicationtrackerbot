package com.example.medtracker

/**
 * Local mode's optional lock (bd med-nt9p.32.9), the twin of ios/App/LocalLock.swift: the
 * phone's fingerprint, face or screen lock before the on-device app shows. A UI lock, not
 * encryption: while it holds, MainActivity keeps the WebView out of the window, defers every
 * load and notification tap, and the bridge answers "locked".
 *
 * Pure state, no Android types (LocalLockTest runs it on the JVM); MainActivity persists `on`
 * (prefs "shell" [KEY]) and runs BiometricPrompt. Unlike iOS there is no separate system
 * setting: `on` changes only through [confirmed], after a successful check.
 */
class LocalLock(on: Boolean) {
    enum class State { LOCKED, UNLOCKING, UNLOCKED }

    var on = on
        private set
    var state = if (on) State.LOCKED else State.UNLOCKED
        private set
    /**
     * Armed at launch and on going to the background: the next resume prompts once. Never
     * re-armed by the prompt's own pause/resume, so a cancel leaves the app locked, no loop.
     */
    var promptDue = on
        private set
    /** Bumped by every prompt and every background: a stale prompt's result is dropped. */
    var attempt = 0
        private set

    /** Concealed and bridge closed. Local mode only: an account has its own passkey unlock. */
    fun holds(local: Boolean) = local && on && state != State.UNLOCKED

    fun background() {
        if (!on) return
        state = State.LOCKED
        promptDue = true
        attempt++
    }

    /** The activity resumed: the attempt to prompt for, or null. */
    fun activate(local: Boolean): Int? {
        if (!holds(local) || !promptDue || state != State.LOCKED) return null
        promptDue = false
        return begin()
    }

    /** The Unlock button (or activate): null while a prompt is already up or nothing is locked. */
    fun begin(): Int? {
        if (state != State.LOCKED) return null
        state = State.UNLOCKING
        return ++attempt
    }

    fun finish(attempt: Int, ok: Boolean) {
        if (attempt != this.attempt || state != State.UNLOCKING) return
        state = if (ok) State.UNLOCKED else State.LOCKED
    }

    /**
     * The intro's or Settings' choice, after a successful check — which also unlocks a lock
     * still on from an earlier stay in local mode, so it may turn it off.
     */
    fun confirmed(on: Boolean) {
        this.on = on
        state = State.UNLOCKED
        attempt++
    }

    companion object {
        /** The persisted choice in the "shell" prefs; absent (every install before .9) is off. */
        const val KEY = "wgLocalLock"
    }
}
