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
 * The rows persist in app-private storage, plaintext like iOS's pending
 * requests. One exact alarm (AlarmManager.setExactAndAllowWhileIdle) is armed
 * at a time, for the next row: when it fires, [Fire] posts every row now due
 * and arms the next. Doze rate-limits allow-while-idle alarms per app, so one
 * alarm per instant (several meds at 08:00 are one wake) and a late wake still
 * posts all it missed. Alarms are dropped on reboot, app update and a revoked
 * grant — [Rearm] arms again from the stored rows.
 */
class Notifications(private val activity: Activity, private val host: () -> String?) {
    private val waiting = mutableListOf<(String) -> Unit>()
    private var stage = 0
    private var awaitingResume = false
    /** openSettings: the first step opens the settings screen even with notifications allowed. */
    private var settings = false

    /** The bridge already checked the caller is the account's own page. */
    fun handle(op: String, args: JSONObject?, reply: (Any?, String?) -> Unit) {
        when (op) {
            "notifications.permission" -> reply(permission(activity), null)
            "notifications.requestPermission" -> {
                waiting += { reply(it, null) }
                if (waiting.size == 1) { stage = 0; step() }
            }
            // The denied note's "Open Android Settings" (bd med-ckm5.16): the app's notification
            // settings, never the runtime prompt, then Alarms & reminders when that is missing too —
            // permission() needs both. Replies permission() once the user is back.
            "notifications.openSettings" -> {
                waiting += { reply(it, null) }
                if (waiting.size == 1) { stage = 0; settings = true; step() }
            }
            "notifications.schedule" -> {
                val h = host() ?: return reply(0, null)
                reply(schedule(activity, h, args?.optJSONArray("items") ?: JSONArray()), null)
            }
            "notifications.test" -> {
                val h = host() ?: return reply(null, "stale")
                if (!notifying(activity)) return reply(null, "Notifications are off for Med Tracker.")
                post(activity, h, TEST_ID, JSONObject().put("body", "Test notification").put("section", "today"))
                reply(true, null)
            }
            else -> reply(null, "unsupported: $op")
        }
    }

    /**
     * Enable walks both system grants: the notification permission (the
     * runtime prompt, or the app's / the Reminders channel's notification
     * settings once refused), then Alarms & reminders — off by default on
     * Android 14. The reply waits for the user to come back from each screen.
     */
    private fun step() {
        val enabled = notifying(activity)
        val forced = settings
        settings = false
        // Forced with notifications on: their settings only when the alarms page has nothing to fix.
        if ((!enabled || forced && alarms(activity).canScheduleExactAlarms()) && stage < 1) {
            stage = 1
            val prefs = store(activity)
            val pkg = activity.packageName
            val granted = activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
            when {
                !forced && !granted && (!prefs.getBoolean(ASKED, false) ||
                    activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) -> {
                    prefs.edit().putBoolean(ASKED, true).apply()
                    activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), PERMISSION_REQUEST)
                }
                // Allowed for the app, but the Reminders channel was switched off.
                !enabled && manager(activity).areNotificationsEnabled() -> open(Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, pkg).putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL))
                else -> open(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg))
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

    /** The alarm: posts the rows now due, then arms the next. Not exported — only our alarm reaches it. */
    class Fire : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val s = store(context)
            val h = s.getString(HOST, null) ?: return
            val now = System.currentTimeMillis() / 1000
            val posted = s.getLong(POSTED, 0)
            val rows = rows(context)
            var last = posted
            // Its own id per posted reminder, so none replaces another still in the shade.
            var id = s.getInt(NEXT_ID, 1)
            for (i in 0 until rows.length()) {
                val row = rows.optJSONObject(i) ?: continue
                val at = row.optLong("fireAtUnix")
                // Due (the alarm may wake a little early), not posted yet, not stale after a long power-off.
                if (at > now + SLACK || at <= posted || at < now - STALE) continue
                post(context, h, id, row)
                id = id % 1_000_000 + 1
                last = maxOf(last, at)
            }
            s.edit().putLong(POSTED, last).putInt(NEXT_ID, id).commit()
            arm(context)
        }
    }

    /** Boot, app update and the exact-alarm grant clear or allow alarms: arm again from the stored rows. */
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
        private const val ACTION_TAP = "com.example.medtracker.OPEN_REMINDER"
        private const val CHANNEL = "reminders"
        private const val PERMISSION_REQUEST = 7001
        /** Outside the reminders' ids (1..1_000_000). */
        private const val TEST_ID = 0
        private const val NEXT_ID = "nextId"
        private const val HOST = "host"
        private const val ROWS = "rows"
        private const val ASKED = "askedPermission"
        /** The last posted row's fireAtUnix: a re-armed alarm never posts a row twice. */
        private const val POSTED = "postedThrough"
        private const val SLACK = 5L
        /** Rows missed by more than this (the phone was off) are dropped, not posted late. */
        private const val STALE = 3600L

        private fun store(c: Context) = c.getSharedPreferences("reminders", Context.MODE_PRIVATE)
        private fun manager(c: Context) = c.getSystemService(NotificationManager::class.java)
        private fun alarms(c: Context) = c.getSystemService(AlarmManager::class.java)
        private fun rows(c: Context) = runCatching { JSONArray(store(c).getString(ROWS, "[]")) }.getOrDefault(JSONArray())

        /** 'granted' needs both grants; until then 'default', or 'denied' once notifications were refused. */
        fun permission(c: Context): String = when {
            !notifying(c) -> if (store(c).getBoolean(ASKED, false) || manager(c).areNotificationsEnabled()) "denied" else "default"
            !alarms(c).canScheduleExactAlarms() -> "default"
            else -> "granted"
        }

        /** Notifications allowed for the app and its Reminders channel not switched off. */
        private fun notifying(c: Context): Boolean {
            val nm = manager(c)
            channel(nm)
            return nm.areNotificationsEnabled() &&
                nm.getNotificationChannel(CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE
        }

        /** Idempotent: an existing channel keeps the user's changes. */
        private fun channel(nm: NotificationManager) =
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH))

        /** Replaces every pending reminder; returns how many are now scheduled. */
        fun schedule(c: Context, host: String, items: JSONArray): Int {
            val now = System.currentTimeMillis() / 1000
            val keep = JSONArray()
            for (i in 0 until items.length()) {
                if (keep.length() >= CAP) break
                val item = items.optJSONObject(i) ?: continue
                val at = item.optLong("fireAtUnix")
                val body = item.optString("body").takeIf { it.isNotEmpty() } ?: continue
                if (at <= now) continue
                keep.put(JSONObject().put("fireAtUnix", at).put("title", item.optString("title")).put("body", body)
                    .put("section", item.optString("section", "today")).put("url", item.optString("url")))
            }
            store(c).edit().putString(HOST, host).putString(ROWS, keep.toString()).commit()
            return arm(c)
        }

        /**
         * Account or mode switch, local erase: the previous vault's reminders go — the scheduled
         * rows and the ones already in the shade (their text and tap belong to that vault); the
         * new page sends its own. Reminders are the app's only notifications.
         */
        fun clear(c: Context) {
            manager(c).cancelAll()
            store(c).edit().remove(HOST).remove(ROWS).remove(POSTED).commit()
            arm(c)
        }

        /**
         * (Re)arms the one alarm at the next unposted row — in the past after a
         * reboot, so missed rows post at once. Returns how many rows are still
         * to come; 0 without both grants (posting would fail; [Rearm] retries).
         */
        private fun arm(c: Context): Int {
            val pi = PendingIntent.getBroadcast(c, 0, Intent(c, Fire::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            alarms(c).cancel(pi)
            if (permission(c) != "granted") return 0
            val rows = rows(c)
            val now = System.currentTimeMillis() / 1000
            val floor = maxOf(store(c).getLong(POSTED, 0), now - STALE)
            val due = (0 until rows.length()).mapNotNull { rows.optJSONObject(it)?.optLong("fireAtUnix") }.filter { it > floor }
            val next = due.minOrNull() ?: return 0
            // An instant, not a wall-clock time: a time-zone change does not move it.
            val armed = runCatching { alarms(c).setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next * 1000, pi) }.isSuccess
            return if (armed) due.count { it > now } else 0
        }

        private fun post(c: Context, host: String, id: Int, row: JSONObject) {
            val nm = manager(c)
            channel(nm)
            // A row from a page before med-9d1a has no url: its section.
            val path = ReminderPath.sanitize(row.optString("url").ifEmpty { ReminderPath.legacy(row.optString("section")) })
            // The URL is the intent's identity, so each row target keeps its own PendingIntent.
            val tap = Intent(ACTION_TAP, Uri.parse("https://$host$path"), c, MainActivity::class.java)
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

        /** A reminder tap for this vault: the sanitized "/?…" path it opens, else null (another vault's, or not a tap). */
        fun tappedPath(intent: Intent?, host: String?): String? {
            if (intent?.action != ACTION_TAP || host == null) return null
            val uri = intent.data ?: return null
            if (uri.host?.lowercase() != host) return null
            return ReminderPath.sanitize("/?" + (uri.encodedQuery ?: ""))
        }
    }
}
