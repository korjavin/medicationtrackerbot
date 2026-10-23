package com.example.medtracker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Debug source set only (bd med-erq1.5): android-qa's stand-in for an FCM message, which the
 * emulator cannot receive without a Firebase project — `am broadcast -n <pkg>/com.example.medtracker.QaPush
 * --es kind inbox-wake` runs PushService's delivery path (Push.deliver). QA build (qa.test base) only.
 */
class QaPush : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!DebugHooks.qa()) return
        Push.deliver(context.applicationContext, intent.getStringExtra("kind") ?: return)
    }
}
