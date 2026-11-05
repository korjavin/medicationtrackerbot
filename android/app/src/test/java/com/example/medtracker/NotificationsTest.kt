package com.example.medtracker

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.pm.PackageManager
import android.provider.Settings
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAlarmManager

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class NotificationsTest {
    class PermissionActivity : Activity() {
        var rationale = false
        override fun shouldShowRequestPermissionRationale(permission: String) = rationale
    }

    @Test
    fun autoDeniedRequestWaitsForSettingsReturnAndRepliesCurrentPermission() {
        val activity = Robolectric.buildActivity(PermissionActivity::class.java).setup().get()
        val nm = activity.getSystemService(NotificationManager::class.java)
        shadowOf(nm).setNotificationsEnabled(false)
        ShadowAlarmManager.setCanScheduleExactAlarms(true)
        val diagnostics = mutableListOf<String>()
        val replies = mutableListOf<Any?>()
        val notifications = Notifications(activity, diagnostics::add) { "qa.test" }
        notifications.handle("notifications.requestPermission", null) { value, error ->
            assertNull(error)
            replies += value
        }
        assertEquals("runtime-prompt", diagnostics.last().substringAfter("result="))
        assertTrue(replies.isEmpty())
        shadowOf(activity).nextStartedActivity // consume Robolectric's runtime-permission activity
        assertTrue(notifications.onRequestPermissionsResult(7001, intArrayOf(PackageManager.PERMISSION_DENIED)))
        val intent = shadowOf(activity).nextStartedActivity
        assertEquals(Settings.ACTION_APP_NOTIFICATION_SETTINGS, intent.action)
        assertEquals(activity.packageName, intent.getStringExtra(Settings.EXTRA_APP_PACKAGE))
        assertTrue("no reply while settings covers Enable", replies.isEmpty())
        notifications.onResume() // the permission dialog's resume is not the settings return
        assertTrue(replies.isEmpty())
        notifications.onPause()
        shadowOf(activity).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        shadowOf(nm).setNotificationsEnabled(true)
        notifications.onResume()
        assertEquals(listOf(Notifications.permission(activity)), replies)
        assertEquals(listOf("granted"), replies)
        assertEquals(listOf("runtime-prompt", "app-settings", "granted"), diagnostics.map { it.substringAfter("result=") })
        notifications.onResume()
        assertEquals("reply once", 1, replies.size)
    }

    @Test
    fun denialWithRationaleRepliesDeniedWithoutOpeningSettings() {
        val activity = Robolectric.buildActivity(PermissionActivity::class.java).setup().get()
        shadowOf(activity.getSystemService(NotificationManager::class.java)).setNotificationsEnabled(false)
        val replies = mutableListOf<Any?>()
        val notifications = Notifications(activity) { "qa.test" }
        notifications.handle("notifications.requestPermission", null) { value, _ -> replies += value }
        shadowOf(activity).nextStartedActivity // inspect only activities started after the callback
        activity.rationale = true
        assertFalse(notifications.onRequestPermissionsResult(42, intArrayOf(PackageManager.PERMISSION_DENIED)))
        assertTrue(replies.isEmpty())
        notifications.onRequestPermissionsResult(7001, intArrayOf(PackageManager.PERMISSION_DENIED))
        assertEquals(listOf("denied"), replies)
        assertNull(shadowOf(activity).nextStartedActivity)
    }
}
