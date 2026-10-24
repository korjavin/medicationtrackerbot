package com.example.medtracker

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.LinearLayout

/**
 * Health Connect's "why does this app need access" screen (bd med-nt9p.8):
 * opened by Health Connect (ACTION_SHOW_PERMISSIONS_RATIONALE) and by Android
 * 14's permission usage link (VIEW_PERMISSION_USAGE, the manifest alias). It
 * must reach the privacy policy — the same document the iOS app links.
 */
class PermissionsRationaleActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // On the native token mirror (bd med-ckm5.14, Wg.kt): title, one paragraph, Privacy policy as a ghost.
        val privacy = wgButton(R.style.Widget_Wg_Button_Ghost, "Privacy policy") {
            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PRIVACY_POLICY)).addCategory(Intent.CATEGORY_BROWSABLE))
            } catch (e: ActivityNotFoundException) {
            }
        }
        val column = wgStack(
            20,
            wgText(R.style.Widget_Wg_Text_Title, "Health Connect access"),
            wgText(
                R.style.Widget_Wg_Text_Lede,
                "When you switch on the Health Connect import in Settings, Med Tracker reads your blood " +
                    "pressure and weight readings, only while the app is open. They are added to your " +
                    "end-to-end encrypted vault, the same as readings you enter by hand. Med Tracker never " +
                    "writes to Health Connect. You can turn access off at any time in Health Connect → App permissions.",
            ),
            privacy.apply { layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT) },
        ).apply { setPadding(dp(24), dp(24), dp(24), dp(24)) }
        setContentView(wgScroll(column).apply { fitsSystemWindows = true })
    }

    companion object {
        /** docs/privacy-policy.md, as ios/App/App.swift links it. */
        const val PRIVACY_POLICY = "https://cloud.myhealthbot.ai/privacy"
    }
}
