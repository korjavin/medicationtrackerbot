package com.example.medtracker

import android.Manifest
import android.app.Activity
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject

/**
 * Local notifications from the web app's reminder horizon (bd med-nt9p.7),
 * twin of ios/App/Notifications.swift. WebView has no Web Push, so the page
 * hands its computed reminders to window.LocalNotifications
 * (web/static/js/native/local-notifications.js), which reaches the
 * `notifications.*` ops here through the wgNative bridge. Scheduling is
 * replace-all: every app open and every reminder-affecting edit sends the
 * full, already-capped list (the page appends the "Open the app…" notice).
 *
 * Each row is an exact alarm (AlarmManager.setExactAndAllowWhileIdle); the
 * rows persist in app-private storage, plaintext like iOS's pending requests,
 * because alarms are dropped on reboot and when the exact-alarm grant is
 * revoked — [Rearm] re-arms them from there.
 */
class Notifications(private val activity: Activity, private val host: () -> String?) {
    private val waiting = mutableListOf<(String) -> Unit>()
    private var stage = 0
    private var awaitingResume = false

    /** The bridge already checked the caller is the account's own page. */
    fun handle(op: String, args: JSONObject?, reply: (Any?, String?) -> Unit) {
        when (op) {
            "notifications.permission" -> reply(permission(activity), null)
            "notifications.requestPermission" -> {
                waiting += { reply(it, null) }
                if (waiting.size == 1) { stage = 0; step() }
            }
            "notifications.schedule" -> {
                val h = host() ?: return reply(0, null)
                reply(schedule(activity, h, args?.optJSONArray("items") ?: JSONArray()), null)
            }
            "notifications.test" -> {
                val h = host() ?: return reply(null, "stale")
                if (!manager(activity).areNotificationsEnabled()) return reply(null, "Notifications are off for Med Tracker.")
                post(activity, h, TEST_ID, JSONObject().put("body", "Test notification").put("section", "today"))
                reply(true, null)
            }
            else -> reply(null, "unsupported: $op")
        }
    }

    /**
     * Enable walks both system grants: the notification permission (the
     * runtime prompt, or the app's notification settings once it was refused),
     * then Alarms & reminders — off by default on Android 14. The reply waits
     * for the user to come back from each screen.
     */
    private fun step() {
        val enabled = manager(activity).areNotificationsEnabled()
        if (!enabled && stage < 1) {
            stage = 1
            val prefs = store(activity)
            val granted = activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
            if (!granted && (!prefs.getBoolean(ASKED, false) ||
                    activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))) {
                prefs.edit().putBoolean(ASKED, true).apply()
                activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), PERMISSION_REQUEST)
            } else {
                open(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName))
            }
            return
        }
        if (enabled && !alarms(activity).canScheduleExactAlarms() && stage < 2) {
            stage = 2
            open(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${activity.packageName}")))
            return
        }
        val result = permission(activity)
        val replies = waiting.toList()
        waiting.clear()
        replies.forEach { it(result) }
    }

    private fun open(intent: Intent) {
        awaitingResume = runCatching { activity.startActivity(intent) }.isSuccess
        if (!awaitingResume) step()
    }

    /** MainActivity.onRequestPermissionsResult: true when it was this one's. */
    fun onRequestPermissionsResult(requestCode: Int): Boolean {
        if (requestCode != PERMISSION_REQUEST) return false
        if (waiting.isNotEmpty()) step()
        return true
    }

    /** MainActivity.onResume: the user came back from a settings screen. */
    fun onResume() {
        if (!awaitingResume) return
        awaitingResume = false
        if (waiting.isNotEmpty()) step()
    }

    /** Fires one reminder row: posts its notification. Not exported — only our alarms reach it. */
    class Fire : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val i = intent.getIntExtra(EXTRA_INDEX, -1)
            val s = store(context)
            val h = s.getString(HOST, null) ?: return
            val row = rows(context).optJSONObject(i) ?: return
            if (row.optLong("fireAtUnix") != intent.getLongExtra(EXTRA_AT, -1)) return // a replaced schedule's alarm
            post(context, h, (row.optLong("fireAtUnix") % Int.MAX_VALUE).toInt() xor i, row)
        }
    }

    /** Boot, app update and the exact-alarm grant clear or allow alarms: re-arm the stored rows. */
    class Rearm : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED,
                AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED -> arm(context)
            }
        }
    }

    companion object {
        /** No 64 cap like iOS; a sane ceiling anyway (the page sends at most 64). */
        const val CAP = 200
        /** The sections a tap may open (stable section ids, CLAUDE.md rule 6). */
        val SECTIONS = setOf("today", "meds", "bp", "weight", "workouts", "health")
        private const val ACTION_TAP = "com.example.medtracker.OPEN_REMINDER"
        private const val CHANNEL = "reminders"
        private const val PERMISSION_REQUEST = 7001
        private const val TEST_ID = 0x7e57
        private const val HOST = "host"
        private const val ROWS = "rows"
        private const val ASKED = "askedPermission"
        private const val EXTRA_INDEX = "index"
        private const val EXTRA_AT = "fireAtUnix"

        private fun store(c: Context) = c.getSharedPreferences("reminders", Context.MODE_PRIVATE)
        private fun manager(c: Context) = c.getSystemService(NotificationManager::class.java)
        private fun alarms(c: Context) = c.getSystemService(AlarmManager::class.java)
        private fun rows(c: Context) = runCatching { JSONArray(store(c).getString(ROWS, "[]")) }.getOrDefault(JSONArray())

        /** 'granted' needs both grants; until then 'default', or 'denied' once notifications were refused. */
        fun permission(c: Context): String = when {
            !manager(c).areNotificationsEnabled() -> if (store(c).getBoolean(ASKED, false)) "denied" else "default"
            !alarms(c).canScheduleExactAlarms() -> "default"
            else -> "granted"
        }

        /** Replaces every pending reminder; returns how many are now armed. */
        fun schedule(c: Context, host: String, items: JSONArray): Int {
            disarm(c)
            val now = System.currentTimeMillis() / 1000
            val keep = JSONArray()
            for (i in 0 until items.length()) {
                if (keep.length() >= CAP) break
                val item = items.optJSONObject(i) ?: continue
                val at = item.optLong("fireAtUnix")
                val body = item.optString("body").takeIf { it.isNotEmpty() } ?: continue
                if (at <= now) continue
                keep.put(JSONObject().put("fireAtUnix", at).put("title", item.optString("title")).put("body", body)
                    .put("section", item.optString("section", "today")))
            }
            store(c).edit().putString(HOST, host).putString(ROWS, keep.toString()).commit()
            return arm(c)
        }

        /** Account switch: the previous account's reminders go; the new page sends its own. */
        fun clear(c: Context) {
            disarm(c)
            store(c).edit().remove(HOST).remove(ROWS).commit()
        }

        private fun alarm(c: Context, i: Int, at: Long, flags: Int): PendingIntent? =
            PendingIntent.getBroadcast(c, i, Intent(c, Fire::class.java).putExtra(EXTRA_INDEX, i).putExtra(EXTRA_AT, at),
                flags or PendingIntent.FLAG_IMMUTABLE)

        private fun disarm(c: Context) {
            val rows = rows(c)
            for (i in 0 until rows.length()) alarm(c, i, 0, PendingIntent.FLAG_NO_CREATE)?.let {
                alarms(c).cancel(it)
                it.cancel()
            }
        }

        /** Arms the stored future rows; without both grants nothing (posting would fail). */
        private fun arm(c: Context): Int {
            if (permission(c) != "granted") return 0
            val rows = rows(c)
            val now = System.currentTimeMillis() / 1000
            var count = 0
            for (i in 0 until rows.length()) {
                val at = rows.optJSONObject(i)?.optLong("fireAtUnix") ?: continue
                if (at <= now) continue
                val pi = alarm(c, i, at, PendingIntent.FLAG_UPDATE_CURRENT) ?: continue
                // An instant, not a wall-clock time: a time-zone change does not move it.
                runCatching { alarms(c).setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at * 1000, pi) }
                    .onSuccess { count++ }
            }
            return count
        }

        private fun post(c: Context, host: String, id: Int, row: JSONObject) {
            val nm = manager(c)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH))
            val section = row.optString("section").takeIf { it in SECTIONS } ?: "today"
            // The URL is the intent's identity, so each section keeps its own tap target.
            val tap = Intent(ACTION_TAP, Uri.parse("https://$host/?tab=$section"), c, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            val body = row.optString("body")
            nm.notify(id, Notification.Builder(c, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setContentTitle(row.optString("title").takeIf { it.isNotEmpty() } ?: "Med Tracker")
                .setContentText(body)
                .setStyle(Notification.BigTextStyle().bigText(body))
                .setCategory(Notification.CATEGORY_REMINDER)
                .setAutoCancel(true)
                .setContentIntent(PendingIntent.getActivity(c, 0, tap, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
                .build())
        }

        /** A reminder tap for this account: the section it opens, else null (another account's, or not a tap). */
        fun tappedSection(intent: Intent?, host: String?): String? {
            if (intent?.action != ACTION_TAP || host == null) return null
            val uri = intent.data ?: return null
            if (uri.host?.lowercase() != host) return null
            return uri.getQueryParameter("tab")?.takeIf { it in SECTIONS }
        }
    }
}
