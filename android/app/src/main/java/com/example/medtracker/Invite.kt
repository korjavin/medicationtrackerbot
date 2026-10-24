package com.example.medtracker

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * Invite capture (bd med-ta2n.12.1, contract med-ta2n.7 §4–§7; twin of iOS InviteSlot): the
 * pending slot's keys and the pure rules around it, so AccountUrlTest runs them on the JVM.
 * MainActivity owns the SharedPreferences and the delivery.
 */
object Invite {
    /** The pending slot {url, receivedAt} in the "shell" prefs (no backup): the claim URL ... */
    const val URL_KEY = "wgPendingInvite"
    /** ... and when it arrived, epoch ms. */
    const val AT_KEY = "wgPendingInviteAt"
    /** The Play Install Referrer was read, or skipped for an existing install (A6). */
    const val REFERRER_KEY = "wgInstallReferrerDone"

    /** A6: read the referrer only on a true first install — no stored account, no mode choice, not done before. */
    fun readReferrer(hasHost: Boolean, hasMode: Boolean, done: Boolean) = !done && !hasHost && !hasMode

    /** A6: receivedAt is Play's click time, so an old referrer looks its age; the read time only when Play says 0. */
    fun referrerAt(clickSeconds: Long, nowMs: Long) = if (clickSeconds > 0) clickSeconds * 1000 else nowMs

    /** §6 warm delivery: home with invite=1, after an existing query (the QA scene's ?qa=). */
    fun withInvite(home: String) = home + (if ('?' in home) "&" else "?") + "invite=1"

    /**
     * "Join and erase" (bd med-r1j2.8, web med-r1j2.4 AD9): local.leave {url, erase: true} remembers
     * the joined account's host and when; local.erase acts only for that host and only while the
     * 10-minute add-device code could still be live, so a much later unlock never erases anything.
     */
    const val ERASE_HOST_KEY = "wgJoinEraseHost"
    const val ERASE_AT_KEY = "wgJoinEraseAt"
    const val ERASE_TTL_MS = 10 * 60 * 1000L

    fun eraseDue(eraseHost: String?, at: Long, host: String?, nowMs: Long) =
        eraseHost != null && eraseHost == host && nowMs - at in 0..ERASE_TTL_MS
}

/**
 * The invite links' entry (App Link https://<base>/i/… and medtracker://i/…, AndroidManifest.xml):
 * MainActivity is launchMode standard, so a link opened from another app would stack a second
 * shell on the running one. This forwards the link the way a reminder tap arrives
 * (Notifications.kt): CLEAR_TOP | SINGLE_TOP → the running shell's onNewIntent, or a cold start.
 * Its own task is excluded from Recents, so it never relaunches with a stale link.
 */
class InviteLinkActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val fresh = savedInstanceState == null && (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0
        val forward = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (fresh && intent.action == Intent.ACTION_VIEW) forward.setAction(Intent.ACTION_VIEW).setData(intent.data)
        startActivity(forward)
        finish()
    }
}
