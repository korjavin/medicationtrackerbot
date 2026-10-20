package com.example.medtracker

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.TypefaceSpan
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

/** [lead] in Space Grotesk 600, then [rest]: the bold lead of a note. */
internal fun Context.wgLead(lead: String, rest: String): CharSequence {
    val bold = Typeface.create(resources.getFont(R.font.wg_ui), 600, false)
    return SpannableStringBuilder(lead).apply {
        setSpan(TypefaceSpan(bold), 0, lead.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        append(rest)
    }
}

/** wg-note in a tone: the icon top-aligned, then the text. The text view is child 1 ([noteText]). */
internal fun Context.wgNote(tone: Wg.Tone, icon: Int, text: CharSequence) =
    LinearLayout(this, null, 0, tone.style).apply {
        orientation = LinearLayout.HORIZONTAL
        addView(wgIcon(icon, tone.tint).apply {
            (layoutParams as LinearLayout.LayoutParams).apply { marginEnd = dp(10); topMargin = dp(1) }
        })
        addView(wgText(R.style.Widget_Wg_Text_Note, text), LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
    }

internal fun LinearLayout.noteText(text: CharSequence) {
    (getChildAt(1) as TextView).text = text
}

/** One wg-facts item: mint icon (warn for the loss fact), a bold lead line, one line of detail. */
internal fun Context.wgFact(icon: Int, lead: String, detail: String, warn: Boolean = false) =
    LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        addView(wgIcon(icon, if (warn) R.color.wg_warn_fg else R.color.wg_mint).apply {
            (layoutParams as LinearLayout.LayoutParams).apply { marginEnd = dp(12); topMargin = dp(1) }
        })
        addView(wgStack(1, wgText(R.style.Widget_Wg_Text_FactLead, lead), wgText(R.style.Widget_Wg_Text_Fact, detail)),
            LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
    }

/** wg-row__lead: the 36dp icon tile. */
internal fun Context.wgLeadTile(background: Int, icon: Int, tint: Int) = ImageView(this).apply {
    setBackgroundResource(background)
    setImageResource(icon)
    imageTintList = getColorStateList(tint)
    scaleType = ImageView.ScaleType.CENTER_INSIDE
    setPadding(dp(8), dp(8), dp(8), dp(8))
    layoutParams = LinearLayout.LayoutParams(dp(36), dp(36))
}

/** wg-setting--boxed: lead tile, title + description, then [trailing] (a chevron or a switch). */
internal fun Context.wgRow(lead: View, title: TextView, desc: TextView, trailing: View) =
    LinearLayout(this, null, 0, R.style.Widget_Wg_Row).apply {
        orientation = LinearLayout.HORIZONTAL
        addView(lead)
        addView(wgStack(2, title, desc), LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginStart = dp(12); marginEnd = dp(12) })
        addView(trailing)
    }

/** wg-or: a hairline, the word, a hairline. */
internal fun Context.wgOr() = LinearLayout(this).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    fun rule() = View(this@wgOr).apply { setBackgroundResource(R.color.wg_line) }
    addView(rule(), LinearLayout.LayoutParams(0, dp(1), 1f))
    addView(wgText(R.style.Widget_Wg_Text_Label, "or"), LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply {
        marginStart = dp(12); marginEnd = dp(12)
    })
    addView(rule(), LinearLayout.LayoutParams(0, dp(1), 1f))
}

/** A 1dp full-width rule: under the page bar, over the dock. */
internal fun Context.wgRule(color: Int = R.color.wg_line_soft) = View(this).apply {
    setBackgroundResource(color)
    layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, dp(1))
}

/** wg-shell__brand: the mark tile and the wordmark. */
internal fun Context.wgBrand() = wgStack(
    10,
    ImageView(this).apply {
        setBackgroundResource(R.drawable.wg_mark)
        setImageResource(R.drawable.ic_wg_pill)
        imageTintList = getColorStateList(R.color.wg_sun)
        setPadding(dp(8), dp(8), dp(8), dp(8))
        layoutParams = LinearLayout.LayoutParams(dp(36), dp(36))
    },
    wgText(R.style.Widget_Wg_Text_Brand, "Med Tracker"),
    horizontal = true,
)

/**
 * wg-shell's scrolling column on wg_screen. [fade]: the bottom edge fades while more is below
 * (wg-shell--fade, N1 at large font scales); the top never does.
 */
internal fun Context.wgScroll(content: View, fade: Boolean = false): ScrollView = object : ScrollView(this) {
    override fun getTopFadingEdgeStrength() = 0f
}.apply {
    setBackgroundResource(R.color.wg_screen)
    isFillViewport = true
    clipToPadding = false
    if (fade) {
        isVerticalFadingEdgeEnabled = true
        setFadingEdgeLength(dp(72))
    }
    addView(content, MATCH_PARENT, WRAP_CONTENT)
}
