package com.example.medtracker

import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import java.lang.ref.WeakReference
import java.security.MessageDigest

/**
 * Native push (bd med-erq1.5, twin of iOS med-erq1.4): FCM as the relay's content-free wake
 * channel in account mode. The server (internal/cloudserver/nativepush.go) sends data {kind}
 * plus a notification block with the same fixed text as [BODY]: in the background the system
 * shows that block; in the foreground [PushService] gets the message and wakes the page instead.
 * No drain here: the inbox drain needs the unlocked page (the DEK lives in page memory).
 *
 * Firebase is configured from the build (BuildConfig.FIREBASE_*, CI repo variables, owner bead
 * med-erq1.7) — no google-services.json, no google-services plugin: it would carry the package,
 * which never goes into this tree. Unset (forks, QA, before the owner setup) means no FirebaseApp,
 * no token (push.token answers null) and nothing else changes.
 */
object Push {
    /** The server's kinds and its fixed text (nativepush.go nativeWakeBody); never anything else. */
    private val BODY = mapOf(
        "inbox-wake" to "Open the app to record what you sent",
        "dry-queue" to "Open the app to keep reminders running",
    )

    val configured get() = BuildConfig.FIREBASE_APP_ID.isNotEmpty()

    /** The shell activity while it exists (onCreate → onDestroy), main thread only. */
    var live: WeakReference<MainActivity>? = null

    /** App.onCreate. Auto-init is off (manifest): no token exists until push.token asks for one. */
    fun init(c: Context) {
        if (!configured || FirebaseApp.getApps(c).isNotEmpty()) return
        runCatching {
            FirebaseApp.initializeApp(c, FirebaseOptions.Builder()
                .setApplicationId(BuildConfig.FIREBASE_APP_ID)
                .setApiKey(BuildConfig.FIREBASE_API_KEY)
                .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
                .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
                .build())
        }
    }

    /** push.token: the FCM token, or null without Firebase, without the notification grant, or on failure. */
    fun token(c: Context, reply: (String?) -> Unit) {
        if (!configured || FirebaseApp.getApps(c).isEmpty() || !allowed(c)) return reply(null)
        runCatching {
            FirebaseMessaging.getInstance().token.addOnCompleteListener { t ->
                reply(if (t.isSuccessful) t.result?.takeIf { it.isNotEmpty() } else null)
            }
        }.onFailure { reply(null) }
    }

    fun allowed(c: Context) = c.getSystemService(NotificationManager::class.java).areNotificationsEnabled()

    /** For Diag: never the token itself. */
    fun fingerprint(token: String) =
        MessageDigest.getInstance("SHA-256").digest(token.toByteArray()).take(4).joinToString("") { "%02x".format(it) }

    /**
     * A wake (main thread): into the live account page when it is in front, else the fixed
     * notification — the same text whether the app was alive or not. Unknown kinds are dropped.
     */
    fun deliver(c: Context, kind: String) {
        val body = BODY[kind] ?: return
        val a = live?.get() ?: return notify(c, kind, body)
        a.pushEvent(kind) { delivered -> if (!delivered) notify(c, kind, body) }
    }

    /**
     * Tag = kind, id 0: the same shade slot as the server's notification block (android.notification.tag
     * in nativepush.go), so a repeated wake replaces the last one whichever side posted it.
     */
    private fun notify(c: Context, kind: String, body: String) {
        Notifications.channel(c)
        // Tap: the launcher entry, which opens the vault's home (Today).
        val tap = Intent(c, MainActivity::class.java).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        c.getSystemService(NotificationManager::class.java).notify(kind, 0, Notification.Builder(c, Notifications.CHANNEL)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle("Med Tracker")
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(PendingIntent.getActivity(c, 0, tap,PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .build())
    }

    fun main(fn: () -> Unit) {
        Handler(Looper.getMainLooper()).post(fn)
    }
}

/** Firebase needs its app before any component runs, including a service started for a message. */
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Push.init(this)
    }
}

/** Reads data.kind only; the payload carries nothing else. */
class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) = Push.main { Push.live?.get()?.pushEvent("token") }

    override fun onMessageReceived(message: RemoteMessage) {
        val kind = message.data["kind"] ?: return
        Push.main { Push.deliver(applicationContext, kind) }
    }
}
