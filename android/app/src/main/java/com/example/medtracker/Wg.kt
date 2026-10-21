package com.example.medtracker

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * The native token mirror's views (bd med-ckm5.14, screens-native.html "Native token mirror"):
 * the kit classes as plain Views on res/values/styles.xml, res/font and res/drawable, no Material.
 * Shared by MainActivity's native screens and PermissionsRationaleActivity; the twin of the iOS
 * Wg palette and button styles.
 */
internal object Wg {
    /** wg-bg-screen, as @color/wg_screen: the bands' colour while a native screen shows. */
    val SCREEN = Color.rgb(0x13, 0x2D, 0x29)

    enum class Tone(val style: Int, val tint: Int) {
        INFO(R.style.Widget_Wg_Note_Info, R.color.wg_info_fg),
        WARN(R.style.Widget_Wg_Note_Warn, R.color.wg_warn_fg),
        DANGER(R.style.Widget_Wg_Note_Danger, R.color.wg_danger_fg),
    }
}

internal fun Context.dp(v: Int) = (v * resources.displayMetrics.density).toInt()

internal fun Context.wgText(style: Int, text: CharSequence? = null) =
    TextView(this, null, 0, style).apply { if (text != null) this.text = text }

internal fun Context.wgButton(style: Int, label: String, action: () -> Unit) =
    Button(this, null, 0, style).apply {
        text = label
        setOnClickListener { action() }
    }

/** A kit icon (res/drawable/ic_wg_*), tinted with a colour resource. */
internal fun Context.wgIcon(icon: Int, tint: Int, sizeDp: Int = 20) = ImageView(this).apply {
    setImageResource(icon)
    imageTintList = getColorStateList(tint)
    layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp))
}

/** wg-vstack / wg-hstack: children spaced by [gapDp]; a GONE child takes no gap. */
internal fun Context.wgStack(gapDp: Int, vararg views: View, horizontal: Boolean = false) = LinearLayout(this).apply {
    orientation = if (horizontal) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
    if (horizontal) gravity = Gravity.CENTER_VERTICAL
    dividerDrawable = GradientDrawable().apply { setColor(Color.TRANSPARENT); setSize(dp(gapDp), dp(gapDp)) }
    showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE
    for (v in views) addView(v, v.layoutParams ?: if (horizontal) LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT)
        else LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
}

/** wg-note in a tone: the icon top-aligned, then the text. */
internal fun Context.wgNote(tone: Wg.Tone, icon: Int, text: CharSequence) =
    LinearLayout(this, null, 0, tone.style).apply {
        orientation = LinearLayout.HORIZONTAL
        addView(wgIcon(icon, tone.tint).apply {
            (layoutParams as LinearLayout.LayoutParams).apply { marginEnd = dp(10); topMargin = dp(1) }
        })
        addView(wgText(R.style.Widget_Wg_Text_Note, text), LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
    }

/** A 1dp full-width rule: under the page bar, over the dock. */
internal fun Context.wgRule(color: Int = R.color.wg_line_soft) = View(this).apply {
    setBackgroundResource(color)
    layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, dp(1))
}

/** wg-shell's scrolling column on wg_screen. */
internal fun Context.wgScroll(content: View): ScrollView = ScrollView(this).apply {
    setBackgroundResource(R.color.wg_screen)
    isFillViewport = true
    clipToPadding = false
    addView(content, MATCH_PARENT, WRAP_CONTENT)
}
