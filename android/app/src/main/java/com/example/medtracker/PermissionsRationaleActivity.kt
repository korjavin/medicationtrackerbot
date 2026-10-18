package com.example.medtracker

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.TypedValue
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * Health Connect's "why does this app need access" screen (bd med-nt9p.8):
 * opened by Health Connect (ACTION_SHOW_PERMISSIONS_RATIONALE) and by Android
 * 14's permission usage link (VIEW_PERMISSION_USAGE, the manifest alias). It
 * must reach the privacy policy — the same document the iOS app links.
 */
class PermissionsRationaleActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (24 * resources.displayMetrics.density).toInt()
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            addView(TextView(this@PermissionsRationaleActivity).apply {
                text = "Health Connect access"
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
            })
            addView(TextView(this@PermissionsRationaleActivity).apply {
                text = "When you switch on the Health Connect import in Settings, Med Tracker reads your blood " +
                    "pressure and weight readings, only while the app is open. They are added to your " +
                    "end-to-end encrypted vault, the same as readings you enter by hand. Med Tracker never " +
                    "writes to Health Connect. You can turn access off at any time in Health Connect → App permissions."
                setPadding(0, pad / 2, 0, pad / 2)
            })
            addView(Button(this@PermissionsRationaleActivity).apply {
                text = "Privacy policy"
                isAllCaps = false
                setOnClickListener {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PRIVACY_POLICY)).addCategory(Intent.CATEGORY_BROWSABLE))
                    } catch (e: ActivityNotFoundException) {
                    }
                }
            })
        }
        setContentView(ScrollView(this).apply {
            fitsSystemWindows = true
            addView(column)
        })
    }

    private companion object {
        /** docs/privacy-policy.md, as ios/App/App.swift links it. */
        const val PRIVACY_POLICY = "https://github.com/korjavin/medicationtrackerbot/blob/master/docs/privacy-policy.md"
    }
}
