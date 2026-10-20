package com.example.medtracker

import android.app.Activity
import android.app.KeyguardManager
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.IntentSender
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.Color
import android.hardware.biometrics.BiometricManager.Authenticators
import android.hardware.biometrics.BiometricPrompt
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.ViewTreeObserver
import android.view.Window
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.autofill.AutofillManager
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Space
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.time.Instant
import java.time.LocalTime
import java.time.format.DateTimeFormatter

/**
 * The shell (bd med-nt9p.5), twin of ios/App/Shell.swift: one Android System
 * WebView on the account origin https://<sub>.<base>/, exactly like the PWA.
 * The app remembers only the account host; the vault, Service Worker and
 * IndexedDB live in WebView storage, per origin. The base domain comes from
 * the build (BuildConfig.BASE_DOMAIN), the account from the invite at runtime.
 * Local mode (bd med-nt9p.32.4, prefs wgLocalMode) puts the same WebView on the
 * bundled app at https://appassets.androidplatform.net (LocalApp.kt) instead:
 * no account, one vault at a time, with an optional lock (bd med-nt9p.32.9, LocalLock.kt).
 */
class MainActivity : Activity() {
    private val base = BuildConfig.BASE_DOMAIN
    private val prefs by lazy { getSharedPreferences("shell", MODE_PRIVATE) }
    /** The passkey ceremony log (bd med-nt9p.22): its own file, so Switch account never clears it. */
    private val diagPrefs by lazy { getSharedPreferences("diag", MODE_PRIVATE) }
    private var host: String? = null
    /** In memory only: Try again must keep an invite link's #claim= fragment. */
    private var lastUrl: String? = null
    /** A page of this account finished loading: later load failures leave it usable. */
    private var showingAccount = false
    private var loadFailed = false
    /** Set by open/forget: the previous account's pages must not stay reachable by Back. */
    private var clearHistory = false
    /** The committed page is an account ceremony (/unlock, /claim, /recover; the web draws its exit bar). */
    private var onCeremony = false
    /** N6: the splash stays up until the page or a native screen is ready ([releaseSplash]). */
    private var splashHeld = true
    /** Until then the first-run field's keyboard is still owed a hide (bd med-nt9p.34). */
    private var hideImeUntil = 0L
    private var topColor = SCREEN
    private var bottomColor = SCREEN
    private var bars = WindowInsets.CONSUMED

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var topBand: View
    private lateinit var bottomBand: View
    private lateinit var firstRun: View
    private lateinit var localIntro: View
    private lateinit var input: EditText
    /** N1's pieces, put in order by [renderFirstRun]: a pending move puts the invite first. */
    private lateinit var firstRunColumn: LinearLayout
    private lateinit var firstRunHead: List<View>
    private lateinit var firstRunFoot: List<View>
    private lateinit var moveNote: View
    private lateinit var localRow: View
    private lateinit var localRowDesc: TextView
    private lateinit var orDivider: View
    private lateinit var inviteSection: View
    private lateinit var inputError: TextView
    private lateinit var inputHint: TextView
    private lateinit var errorView: View
    private lateinit var errorIcon: ImageView
    private lateinit var errorTitle: TextView
    private lateinit var errorLede: TextView
    private lateinit var errorMeta: TextView
    private lateinit var errorPrimary: Button
    private lateinit var errorSecondary: Button
    private lateinit var lockView: View
    private lateinit var lockNote: View
    private lateinit var lockFoot: View
    private lateinit var unlockButton: Button
    private lateinit var lockSwitch: Switch
    private lateinit var lockRow: View
    private lateinit var introScroll: ScrollView
    private lateinit var introMove: View
    private lateinit var introMessage: LinearLayout
    private lateinit var startButton: Button
    private lateinit var openInviteButton: Button

    private val files by lazy { Files(this) { if (concealed) null else vaultHost } }
    private val notifications by lazy { Notifications(this) { vaultHost } }

    /** Local mode's asset origin (bd med-nt9p.32.2). */
    private val localApp by lazy { LocalApp(this) }
    /** The persisted choice (LocalOrigin.MODE_KEY); wins over a stored host, like Shell.swift. */
    @Volatile private var local = false
    /** The vault the shell has open (med-o7zq.9): reminders, their taps and the bridge follow it. */
    private val vaultHost get() = if (local) LocalOrigin.HOST else host
    /** A debug QA scene (DebugHooks.qaScene) or the bundled app's root. */
    private val localHome by lazy { LocalOrigin.qaHome(DebugHooks.qaScene(this)) ?: LocalOrigin.HOME }

    /** Local mode's optional lock (bd med-nt9p.32.9); off unless the user turned it on. */
    private val lock by lazy { LocalLock(prefs.getBoolean(LocalLock.KEY, false)) }
    /** The lock holds: the page is out of the window, loads and taps wait, the bridge says "locked". */
    private val concealed get() = lock.holds(local) || DebugHooks.qaLock(this)
    /** What the lock held back, run on unlock. */
    private var deferredUrl: String? = null
    private var deferredSection: String? = null
    /** This app's own screen is up (a picker, print, Settings): its onStop is not a background. */
    private var outbound = false
    /** The phone's check is up; its screen-lock screen stops this activity too. */
    private var prompting = false
    /**
     * The screen went off: locks even while one of this app's own screens is up, when this
     * activity is already stopped and gets no second onStop. Registered only while the lock is on.
     */
    private val screenOff = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            outbound = false
            lock.background()
            applyLock()
        }
    }
    private var screenOffRegistered = false

    /** window.Health's health.* ops (bd med-nt9p.8). */
    private val health by lazy { HealthConnect(this) }
    /** window.Attest's attest.* ops, local mode only (bd med-nt9p.32.8.4). */
    private val attest by lazy { Attest(this) }
    /** The local → cloud move's stash (bd med-nt9p.32.17): no-backup app storage, see Move.kt. */
    private val move by lazy { Move(File(noBackupFilesDir, "move")) }
    /** The account → local leave stash (bd med-o7zq.36.3): the same class, its own no-backup dir. */
    private val leave by lazy { Move(File(noBackupFilesDir, "leave")) }

    private val back = OnBackInvokedCallback { if (localIntro.visibility == View.VISIBLE) showIntro(false) else web.goBack() }
    private var backRegistered = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        // Edge to edge on Android 14 too (targetSdk 35+ only enforces it from 15):
        // layoutBars owns the bar and keyboard insets on every version.
        @Suppress("DEPRECATION")
        window.setDecorFitsSystemWindows(false)
        @Suppress("DEPRECATION")
        window.statusBarColor = Color.TRANSPARENT
        @Suppress("DEPRECATION")
        window.navigationBarColor = Color.TRANSPARENT
        window.isNavigationBarContrastEnforced = false // the band shows the page colour, not a scrim
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        setContentView(buildUi())
        holdSplash()
        publishShortcut()

        if (intent?.action == ACTION_DIAG && savedInstanceState == null) copyDiagnostics()
        adoptSpikeAccount()
        host = prefs.getString(HOST_KEY, null)?.takeIf { AccountUrl.isAccountHost(it, base) }
        local = prefs.getBoolean(LocalOrigin.MODE_KEY, false)
        // QA launch extra, false in release (src/release): enter local mode without the first-run tap.
        if (!local && savedInstanceState == null && DebugHooks.localMode(this)) setLocal(true)
        // A restored activity keeps its launch intent: only a fresh shortcut launch switches.
        if (intent?.action == ACTION_SWITCH && savedInstanceState == null) forget()
        else reopen(Notifications.tappedSection(intent, vaultHost)?.let { sectionUrl(it) } ?: home)
        if (DebugHooks.qaLocalError(this)) showError(LoadError.LOCAL, "local · bundle failed to load")
    }

    /**
     * N6 splash → web hand-off: the platform splash (wg_screen, the mark tile) stays while the
     * first frame is held, until the page posts its first chrome sample or commits a visible frame,
     * or a native screen (first run, error, lock) shows — then the mark fades out over 180 ms onto
     * the same colour. ponytail: capped at [SPLASH_MAX_MS], so a page that never reports still shows.
     */
    private fun holdSplash() {
        root.viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
            override fun onPreDraw(): Boolean {
                if (splashHeld) return false
                root.viewTreeObserver.removeOnPreDrawListener(this)
                return true
            }
        })
        root.postDelayed(::releaseSplash, SPLASH_MAX_MS)
        splashScreen.setOnExitAnimationListener { v ->
            v.animate().alpha(0f).setDuration(180).withEndAction { v.remove() }.start()
        }
    }

    private fun releaseSplash() {
        if (!splashHeld) return
        splashHeld = false
        root.invalidate()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == ACTION_SWITCH) forget()
        if (intent.action == ACTION_DIAG) copyDiagnostics()
        Notifications.tappedSection(intent, vaultHost)?.let { openSection(it) }
    }

    override fun onResume() {
        super.onResume()
        outbound = false
        notifications.onResume()
        // Once per launch or return from the background; the prompt's own pause/resume asks nothing.
        lock.activate(local)?.let { authenticate(it) }
    }

    /** Chromium writes cookies only every ~30 s: a kill soon after sign-in would lose the session (bd med-nt9p.45). */
    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    /**
     * The lock closes on every stop (bd med-nt9p.32.9) — Home, Recents, a call, another app, the
     * screen going off — except for this app's own file picker, share, print and Settings screens
     * and the phone's screen-lock check, while the screen is on.
     * The screen going off on one of them locks through [screenOff].
     * ponytail: leaving the app from one of those screens locks only at the next stop; telling
     * that apart needs tracking other apps' activities. Permission screens (requestPermissions is
     * final) are not exempt: the return from one asks to unlock.
     */
    override fun onStop() {
        super.onStop()
        if (!getSystemService(PowerManager::class.java).isInteractive || !(outbound || prompting)) {
            lock.background()
            applyLock()
        }
    }

    /**
     * Every startActivity lands here: this app's own screens, except a link opened in the browser.
     * Marked only once the launch went through: a failed one (callers catch it) exempts nothing.
     */
    override fun startActivityForResult(intent: Intent, requestCode: Int, options: Bundle?) {
        super.startActivityForResult(intent, requestCode, options)
        if (!intent.hasCategory(Intent.CATEGORY_BROWSABLE)) outbound = true
    }

    /** PrintManager.print opens the print screen through here. */
    override fun startIntentSender(
        intent: IntentSender, fillInIntent: Intent?, flagsMask: Int, flagsValues: Int, extraFlags: Int, options: Bundle?,
    ) {
        super.startIntentSender(intent, fillInIntent, flagsMask, flagsValues, extraFlags, options)
        outbound = true
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (!files.onActivityResult(requestCode, resultCode, data)) super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        if (!files.onRequestPermissionsResult(requestCode) && !notifications.onRequestPermissionsResult(requestCode) &&
            !health.onRequestPermissionsResult(requestCode)
        ) {
            super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        }
    }

    /** A reminder tap (bd med-nt9p.7): switch the open page to the section, or load the account on it. */
    private fun openSection(section: String) {
        val url = sectionUrl(section) ?: return
        if (concealed) {
            deferredSection = section // opened after the unlock
            return
        }
        if (!showingAccount || web.progress < 100) return load(url)
        // No switchTab (the unlock page): load the section URL, the deep-link router opens it after unlock.
        web.evaluateJavascript("typeof window.switchTab === 'function' ? (window.switchTab('$section'), true) : false") {
            if (it != "true") load(url)
        }
    }

    /** The deep-link router reads ?tab= (section ids are Notifications.SECTIONS only). */
    private fun sectionUrl(section: String) = vaultHost?.let { "https://$it/?tab=$section" }

    override fun onDestroy() {
        if (screenOffRegistered) unregisterReceiver(screenOff)
        health.close()
        attest.close()
        web.destroy()
        files.destroy()
        super.onDestroy()
    }

    // MARK: account

    private val home get() = if (local) localHome else host?.let { "https://$it/" }

    /** First-run submit: open the account, or say why not. */
    private fun open(raw: String) {
        val url = AccountUrl.parse(raw, base)
        val h = url?.let { Uri.parse(it).host }
        if (url == null || h == null) {
            val second = "Use your invite link or your account address (yourname.$base)."
            when {
                base.isEmpty() -> fieldError("This build has no service configured.")
                raw.isBlank() -> fieldError("Paste or scan your invite first.", second)
                else -> fieldError("That isn't an account link.", second)
            }
            return
        }
        if (h != host) Notifications.clear(this)
        leave.clear() // opening an account abandons a pending leave stash; the next leave stashes afresh
        prefs.edit().putString(HOST_KEY, h).apply()
        host = h
        input.setText("")
        fieldError(null)
        // Found by the emulator harness (bd med-nt9p.23): the keyboard stayed up over the
        // page or the error screen, so the first Back only closed it. A show still animating
        // cancels this hide (bd med-nt9p.34): the insets listener repeats it when the IME lands.
        // ponytail: 5 s window; a web field focused that fast after Open would lose its keyboard once.
        hideImeUntil = SystemClock.uptimeMillis() + 5_000
        window.insetsController?.hide(WindowInsets.Type.ime())
        reopen(url) // the claim link keeps its #fragment for the page; only the host is stored
    }

    /**
     * Switch account: back to first run, leaving local mode too — or, with [thenLocal], straight
     * into local mode (account.leave {then: "local"}, bd med-nt9p.32.13, iOS forget(thenLocal:)).
     * WebView data is per origin and kept.
     */
    private fun forget(thenLocal: Boolean = false) {
        // The account a leave left (bd med-o7zq.42): leave.clear {back: true} reopens it.
        val left = host
        prefs.edit().apply { if (thenLocal && left != null) putString(LEAVE_HOST_KEY, left) else remove(LEAVE_HOST_KEY) }.apply()
        setLocal(thenLocal)
        Notifications.clear(this)
        prefs.edit().remove(HOST_KEY).apply()
        host = null
        reopen()
    }

    /** The intro's Start: the persisted choice, then the bundled app. */
    private fun openLocal() {
        setLocal(true)
        reopen()
    }

    /** Every mode change clears the alarms (med-o7zq.9): no reminder of the other vault fires or opens it. */
    private fun setLocal(on: Boolean) {
        if (on != local) Notifications.clear(this)
        // Entering local mode again abandons a pending move; the next move stashes afresh.
        if (on) move.clear()
        prefs.edit().putBoolean(LocalOrigin.MODE_KEY, on).apply()
        local = on
    }

    private fun reopen(url: String? = home) {
        deferredUrl = null
        deferredSection = null
        if (concealed) web.loadUrl("about:blank") // the old page must not run behind the lock
        applyLock()
        showingAccount = false
        lastUrl = null
        clearHistory = true
        onCeremony = false
        errorView.visibility = View.GONE
        localIntro.visibility = View.GONE
        if (url == null) {
            web.loadUrl("about:blank")
            firstRun.visibility = View.VISIBLE
            // Callers that explain why (an account gone) set their field error after this.
            fieldError(null)
            renderFirstRun()
        } else {
            firstRun.visibility = View.GONE
            load(url)
        }
        updateChrome()
    }

    private fun load(url: String) {
        errorView.visibility = View.GONE
        lastUrl = url
        if (concealed) {
            deferredUrl = url // loaded after the unlock
            return
        }
        web.loadUrl(url)
        updateChrome()
    }

    private fun retry() {
        (lastUrl ?: home)?.let { load(it) }
    }

    /** N4's three variants (screens-native.html; twin of iOS LoadErrorView). */
    private enum class LoadError { NETWORK, NOT_FOUND, LOCAL }

    /**
     * N4 load error: [what] is the mono meta line for support ("503 · service unavailable"), the
     * time appended. A bare 404 leads with another invite (trying again can't fix it, warn tone);
     * local mode never offers Switch account.
     */
    private fun showError(kind: LoadError, what: String) {
        val h = host ?: "your account"
        val warn = kind == LoadError.NOT_FOUND
        errorIcon.setBackgroundResource(if (warn) R.drawable.wg_shell_icon_warn else R.drawable.wg_shell_icon)
        errorIcon.setImageResource(
            when (kind) {
                LoadError.NETWORK -> R.drawable.ic_wg_cloud_off
                LoadError.NOT_FOUND -> R.drawable.ic_wg_search
                LoadError.LOCAL -> R.drawable.ic_wg_device
            }
        )
        errorIcon.imageTintList = getColorStateList(if (warn) R.color.wg_warn_fg else R.color.wg_fg_2)
        when (kind) {
            LoadError.NETWORK -> {
                errorTitle.text = "Can't reach your account"
                errorLede.text = "Med Tracker couldn't connect to $h. Your records are safe. Check your connection and try again."
            }
            LoadError.NOT_FOUND -> {
                errorTitle.text = "We can't find this account"
                errorLede.text = "There's no account at $h any more. It may have been deleted, or the address changed."
            }
            LoadError.LOCAL -> {
                errorTitle.text = "Can't open Med Tracker"
                errorLede.text = "The app on this phone didn't start. Your records are still here. Try again, or restart your phone if it keeps happening."
            }
        }
        errorMeta.text = "$what · ${LocalTime.now().format(HH_MM)}"
        fun set(b: Button, label: String, action: () -> Unit) {
            b.text = label
            b.setOnClickListener { action() }
        }
        // Leaving local mode keeps its data: it is back on the next switch.
        if (warn) {
            set(errorPrimary, "Use another invite") { forget() }
            set(errorSecondary, "Try again") { retry() }
        } else {
            set(errorPrimary, "Try again") { retry() }
            set(errorSecondary, if (kind == LoadError.LOCAL) "Use an account instead" else "Switch account") { forget() }
        }
        errorView.visibility = View.VISIBLE
        updateChrome()
    }

    private fun isInside(h: String?): Boolean {
        val l = h?.lowercase() ?: return false
        if (local) return l == LocalOrigin.HOST // the bundled app navigates on its own origin only
        return host != null && (l == host || l == base)
    }

    /** The spike (bd med-nt9p.4) kept the last URL: adopt its account so testers skip first run. */
    private fun adoptSpikeAccount() {
        val spike = getSharedPreferences("spike", MODE_PRIVATE)
        val last = spike.getString("lastUrl", null)
        if (last != null && !prefs.contains(HOST_KEY)) {
            AccountUrl.parse(last, base)?.let { Uri.parse(it).host }?.let { prefs.edit().putString(HOST_KEY, it).apply() }
        }
        if (spike.all.isNotEmpty()) deleteSharedPreferences("spike")
    }

    /** Long-press the launcher icon → Switch account: the twin of iOS Settings → Switch account. */
    private fun publishShortcut() {
        val switch = ShortcutInfo.Builder(this, "switch-account")
            .setShortLabel("Switch account")
            .setIntent(Intent(ACTION_SWITCH, null, this, MainActivity::class.java))
            .build()
        val copy = ShortcutInfo.Builder(this, "copy-diagnostics")
            .setShortLabel("Copy diagnostics")
            .setIntent(Intent(ACTION_DIAG, null, this, MainActivity::class.java))
            .build()
        runCatching { getSystemService(ShortcutManager::class.java).setDynamicShortcuts(listOf(switch, copy)) }
    }

    // MARK: web view

    private fun makeWebView(): WebView {
        val w = WebView(this)
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        // iOS parity: page text ignores the system font scale (fixed-height chrome would
        // overflow), pinch-zoom is on instead (no on-screen buttons), and no edge glow.
        w.settings.textZoom = 100
        w.settings.builtInZoomControls = true
        w.settings.displayZoomControls = false
        w.overScrollMode = View.OVER_SCROLL_NEVER
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
            WebSettingsCompat.setWebAuthenticationSupport(w.settings, WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP)
        }
        diag("shell webview webauthn=${webAuthnMode(w)}")
        w.setBackgroundColor(SCREEN) // the token mirror: wg_screen until the page paints (N6)
        w.webViewClient = Client()
        // The account subdomains and the asset origin; onBridge and Files answer only the open vault's.
        val rules = (if (base.isEmpty()) emptySet() else setOf("https://*.$base")) + "https://${LocalOrigin.HOST}"
        files.install(w, rules)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(w, BRIDGE, rules) { _, message, origin, isMainFrame, reply ->
                onBridge(message.data, origin, isMainFrame) { reply.postMessage(it) }
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(w, assets.open("chrome.js").bufferedReader().use { it.readText() }, rules)
        }
        DebugHooks.onWebView(this, w, rules, ::diag) // no-op in release (src/release) and off the qa.test base
        return w
    }

    private inner class Client : WebViewClient() {
        /** Off the main thread. Only the asset origin, only in local mode; null = the network. */
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            if (local) localApp.intercept(request) else null

        /** Only the account host and the base domain load in the app; anything else opens outside it. */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            when (uri.scheme?.lowercase()) {
                "http", "https" -> if (isInside(uri.host) || !request.isForMainFrame) return false
                "blob", "data", "about" -> return false
            }
            openOutside(uri)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            loadFailed = false
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (clearHistory) {
                clearHistory = false
                view.clearHistory()
            }
            val v = vaultHost
            if (!loadFailed && v != null && url?.let { Uri.parse(it).host?.lowercase() } == v) showingAccount = true
            updateBack()
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            // The ceremony pages leave by full navigation, so every commit is seen here.
            val ceremony = AccountUrl.isCeremony(url, base)
            // Leaving /unlock, /claim or /recover for the app (bd med-nt9p.33): Back on Today
            // must leave the app, not reopen the spent ceremony ("invite already claimed").
            if (!ceremony && onCeremony) {
                clearHistory = true
                // Signed in: write the session cookie now, not on Chromium's ~30 s timer (bd med-nt9p.45).
                CookieManager.getInstance().flush()
            }
            onCeremony = ceremony
            updateBack()
        }

        /** N6: the page's first visible frame ends the splash hold. */
        override fun onPageCommitVisible(view: WebView, url: String?) {
            releaseSplash()
        }

        /**
         * Offline with a Service Worker in control never gets here: the worker answers.
         * Unlike WKWebView, WebView replaces the page with its own error page, so a
         * later failure gets the screen too, and Try again reloads that URL.
         */
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            if (bundled(request, "error ${error.errorCode}")) return
            loadFailed = true
            if (showingAccount) lastUrl = request.url.toString()
            val why = error.description?.toString()?.takeIf { it.isNotBlank() } ?: "not loaded"
            showError(if (local) LoadError.LOCAL else LoadError.NETWORK, "error ${error.errorCode} · $why")
        }

        /** An HTTP error before any page of this account showed — a mistyped or deleted account is a 404. */
        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            // Once the account showed, the server's own error page stays (Back leaves it).
            if (!request.isForMainFrame || response.statusCode < 400 || showingAccount) return
            val code = response.statusCode
            if (bundled(request, "HTTP $code")) {
                // The app document itself missing: the bundled app can't start (N4 · local).
                if (request.url.path.orEmpty().trim('/').isEmpty()) {
                    loadFailed = true
                    showError(LoadError.LOCAL, "local · $code · bundle failed to load")
                }
                return
            }
            val h = request.url.host?.lowercase()
            // The server says the stored account is gone (deleted here or elsewhere, or a typo): forget
            // it and say why on the first run (bd med-nt9p.32.14). A 404 without the server's marker
            // (a proxy's during a redeploy, an older server) keeps the error screen and Try again.
            // Set after forget()'s reopen(), which resets the field error; the next open or reopen clears it.
            // The address stays in the field (N1 · error), so it can be fixed in place.
            if (h != null && h == host && AccountUrl.accountGone(response.statusCode, response.responseHeaders)) {
                forget()
                input.setText(h)
                fieldError("There is no account at $h.", "Check the address, or ask whoever invited you for a new link.")
                return
            }
            loadFailed = true
            // WebView often leaves reasonPhrase empty (HTTP/2 has none).
            val reason = response.reasonPhrase?.takeIf { it.isNotBlank() }?.lowercase() ?: STATUS_TEXT[code] ?: "http error"
            showError(if (code == 404) LoadError.NOT_FOUND else LoadError.NETWORK, "$code · $reason")
        }

        /** The asset origin is never "your account": a miss is LocalApp's own 404, so log it and keep the page (the app document aside). */
        private fun bundled(request: WebResourceRequest, what: String): Boolean {
            if (request.url.host?.lowercase() != LocalOrigin.HOST) return false
            diag("shell local $what ${request.url.path}")
            return true
        }

        /** Renderer crash or kill: a fresh WebView on the same URL (it keeps the fragment). */
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            val url = runCatching { view.url }.getOrNull()?.takeIf { it != "about:blank" }
            root.removeView(view)
            view.destroy()
            web = makeWebView()
            if (!concealed) root.addView(web, 0) // else the unlock attaches it
            layoutBars()
            showingAccount = false
            when {
                url != null -> load(url)
                home == null -> web.loadUrl("about:blank")
                else -> retry()
            }
            return true
        }
    }

    /**
     * The wgNative bridge (bd med-nt9p.5): WebMessageListener injected as
     * window.wgNative on the `https` subdomains of base and the asset origin. Only
     * the open vault's top-level page is answered (LocalOrigin.bridgeCaller), and
     * the local-only ops only in local mode. Messages are JSON {op, args, id}; replies
     * {id, result} or {id, error}. Capability ops (native/ android platform,
     * med-nt9p.6) add cases here.
     */
    private fun stash(m: Move, msg: JSONObject, answer: (Any?, String?) -> Unit) = try {
        m.stash(msg.optJSONObject("args")?.opt("vault"))
        answer(true, null)
    } catch (e: Move.Failure) {
        answer(null, e.message)
    } catch (e: IOException) {
        answer(null, "write failed")
    }

    private fun take(m: Move, answer: (Any?, String?) -> Unit) = try {
        answer(m.take()?.let { JSONObject().put("vault", it) } ?: JSONObject.NULL, null)
    } catch (e: IOException) {
        answer(null, "read failed")
    }

    private fun onBridge(data: String?, origin: Uri, isMainFrame: Boolean, reply: (String) -> Unit) {
        val msg = runCatching { JSONObject(data ?: "") }.getOrNull() ?: return
        val id = msg.opt("id")
        fun answer(result: Any?, error: String? = null) {
            if (id == null) return
            reply(JSONObject().put("id", id).apply { if (error != null) put("error", error) else put("result", result) }.toString())
        }
        if (!LocalOrigin.bridgeCaller(isMainFrame, origin.scheme, origin.host, vaultHost)) {
            answer(null, "forbidden")
            return
        }
        // A page still running behind the lock gets no native capability.
        if (concealed) return answer(null, "locked")
        val op = msg.optString("op")
        if (!LocalOrigin.opAllowed(op, local)) return answer(null, "unsupported: $op")
        when (op) {
            "ping" -> answer("pong")
            // The page's capability probe (bd med-nt9p.32.13): an older shell answers "unsupported".
            "shell.ops" -> answer(JSONArray(LocalOrigin.ops(local)))
            // Leave the account (account mode only); the account and this origin's data stay. Settings
            // → Account "Use this phone without an account" passes {then: "local"} → local mode; after
            // an account delete (no args) → the first run, as Switch account (iOS #1179's contract).
            "account.leave" -> {
                answer(true)
                forget(thenLocal = msg.optJSONObject("args")?.optString("then") == "local")
            }
            "chrome" -> {
                val args = msg.optJSONObject("args") ?: return
                cssColor(args.optString("top"))?.let { topColor = it }
                cssColor(args.optString("bottom"))?.let { bottomColor = it }
                updateChrome()
                releaseSplash() // N6: the page's first sample says it is ready

            }
            // The page's BYOK hosts, for the next document's CSP; it reloads itself when changed (local-boot.js).
            "setEgressHosts" -> {
                val raw = msg.optJSONObject("args")?.optJSONArray("hosts")
                val hosts = LocalOrigin.validHosts(raw?.let { a -> List(a.length()) { a.opt(it) } })
                    ?: return answer(null, "invalid hosts")
                val changed = LocalOrigin.decodeHosts(prefs.getString(LocalOrigin.HOSTS_KEY, null)) != hosts
                prefs.edit().putString(LocalOrigin.HOSTS_KEY, LocalOrigin.encodeHosts(hosts)).apply()
                answer(JSONObject().put("changed", changed))
            }
            // The page erased its own storage (local-policy.js); the shell's share is the host mirror and reminders.
            "local.reset" -> {
                prefs.edit().remove(LocalOrigin.HOSTS_KEY).remove(LEAVE_HOST_KEY).apply()
                move.clear()
                leave.clear()
                Notifications.clear(this)
                answer(true)
            }
            // Local → cloud move (bd med-nt9p.32.17): the vault v1 JSON for the next account to pick up.
            // Errors never carry the contents or the path.
            // ponytail: synchronous file I/O on the main thread; move it off-thread if a 64 MB vault ever janks.
            "move.stash" -> stash(move, msg) { r, e -> answer(r, e) }
            // The account side: {vault} or null. Not deleted here: the page clears it once imported,
            // so a failed import retries on the next open.
            "move.take" -> take(move) { r, e -> answer(r, e) }
            "move.clear" -> {
                move.clear()
                answer(true)
            }
            // Account → local leave (bd med-o7zq.36.3): the mirror image, same contract, the "leave" dir.
            // Entering local mode (setLocal/forget) deliberately keeps it; open() and local.reset delete it.
            "leave.stash" -> stash(leave, msg) { r, e -> answer(r, e) }
            "leave.take" -> take(leave) { r, e -> answer(r, e) }
            // {back: true}: the user cancelled the pickup (bd med-o7zq.42), so nothing happened:
            // reopen the account the leave came from (never changed; its origin's data is kept).
            "leave.clear" -> {
                leave.clear()
                val back = prefs.getString(LEAVE_HOST_KEY, null)?.takeIf { AccountUrl.isAccountHost(it, base) }
                prefs.edit().remove(LEAVE_HOST_KEY).apply()
                if (back != null && msg.optJSONObject("args")?.optBoolean("back") == true) {
                    answer(JSONObject().put("back", true))
                    setLocal(false)
                    prefs.edit().putString(HOST_KEY, back).apply()
                    host = back
                    reopen()
                } else answer(true)
            }
            // Settings → Backup → Move to a cloud account: the first run, as Switch account; the data stays.
            "local.leave" -> {
                answer(true)
                forget()
            }
            // Settings → App lock (local-policy.js mountLocalLockRow); available: the phone has a screen lock.
            "lock.status" -> answer(JSONObject().put("on", lock.on).put("available", deviceSecure()))
            "lock.set" -> setLock(msg.optJSONObject("args")?.optBoolean("on") == true) { answer(it == null) }
            "diag.append" -> diag("page " + (msg.optJSONObject("args")?.optString("entry") ?: ""))
            "health.authorize", "health.query" -> health.handle(op, msg.optJSONObject("args")) { r, e -> answer(r, e) }
            "attest.status", "attest.enroll", "attest.setPass", "attest.assert" ->
                attest.handle(op, msg.optJSONObject("args")) { r, e -> answer(r, e) }
            else -> if (op.startsWith("notifications.")) notifications.handle(op, msg.optJSONObject("args")) { r, e -> answer(r, e) }
                else answer(null, "unsupported: $op")
        }
    }

    // MARK: chrome — edge to edge, the page's colours behind the system bars

    private fun buildUi(): View {
        root = FrameLayout(this)
        web = makeWebView()
        root.addView(web)
        topBand = View(this)
        bottomBand = View(this)
        root.addView(topBand, FrameLayout.LayoutParams(MATCH_PARENT, 0, Gravity.TOP))
        root.addView(bottomBand, FrameLayout.LayoutParams(MATCH_PARENT, 0, Gravity.BOTTOM))
        firstRun = buildFirstRun()
        localIntro = buildLocalIntro()
        errorView = buildError()
        lockView = buildLock()
        root.addView(firstRun, MATCH_PARENT, MATCH_PARENT)
        root.addView(localIntro, MATCH_PARENT, MATCH_PARENT)
        root.addView(errorView, MATCH_PARENT, MATCH_PARENT)
        root.addView(lockView, MATCH_PARENT, MATCH_PARENT)
        root.setOnApplyWindowInsetsListener { _, insets ->
            bars = insets
            if (insets.isVisible(WindowInsets.Type.ime()) && firstRun.visibility != View.VISIBLE &&
                SystemClock.uptimeMillis() < hideImeUntil
            ) window.insetsController?.hide(WindowInsets.Type.ime())
            layoutBars()
            WindowInsets.CONSUMED
        }
        return root
    }

    private fun layoutBars() {
        val sys = bars.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
        val ime = bars.getInsets(WindowInsets.Type.ime())
        val bottom = maxOf(sys.bottom, ime.bottom)
        web.layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT).apply {
            setMargins(sys.left, sys.top, sys.right, bottom)
        }
        topBand.layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, sys.top, Gravity.TOP)
        bottomBand.layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, sys.bottom, Gravity.BOTTOM)
        // The keyboard's extra height is a margin, not padding: the ScrollView really shrinks and
        // its onSizeChanged scrolls the focused invite field above the keyboard (N1 at 2x).
        val imeLift = bottom - sys.bottom
        for (v in listOf(firstRun, localIntro, errorView)) {
            v.setPadding(sys.left, sys.top, sys.right, sys.bottom)
            v.layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT).apply { bottomMargin = imeLift }
        }
        // The lock fills the window so its mark sits at the window's centre, where the splash put
        // it (N6); only its foot clears the navigation bar. The lock hides the keyboard.
        lockView.setPadding(sys.left, 0, sys.right, 0)
        lockFoot.setPadding(24.dp, 12.dp, 24.dp, 16.dp + sys.bottom)
    }

    /** Bands and bar icons follow the page, or wg_screen while a native screen is up. */
    private fun updateChrome() {
        val native = firstRun.visibility == View.VISIBLE || errorView.visibility == View.VISIBLE ||
            localIntro.visibility == View.VISIBLE || lockView.visibility == View.VISIBLE
        if (native) releaseSplash() // N6: a native screen is ready to show at once
        val top = if (native) SCREEN else topColor
        val bottom = if (native) SCREEN else bottomColor
        root.setBackgroundColor(top)
        topBand.setBackgroundColor(top)
        bottomBand.setBackgroundColor(bottom)
        val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
        val lightNav = WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        window.insetsController?.setSystemBarsAppearance(
            (if (isLight(top)) light else 0) or (if (isLight(bottom)) lightNav else 0),
            light or lightNav,
        )
        updateBack()
    }

    private val Int.dp get() = (this * resources.displayMetrics.density).toInt()

    private fun isLight(c: Int) = Color.luminance(c) > 0.5f

    /** Back walks the web view's history while the page shows, then leaves the app; on the intro it returns to first run. */
    private fun updateBack() {
        val want = lockView.visibility != View.VISIBLE && (localIntro.visibility == View.VISIBLE ||
            firstRun.visibility != View.VISIBLE && errorView.visibility != View.VISIBLE && web.canGoBack())
        if (want == backRegistered) return
        if (want) onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, back)
        else onBackInvokedDispatcher.unregisterOnBackInvokedCallback(back)
        backRegistered = want
    }

    // MARK: native screens (kit token mirror, bd med-ckm5.14; Wg.kt + res/values/styles.xml)

    /**
     * N1 first run (screens-native.html): one scrolling column that fades at the bottom while more
     * is below. Owner decision 2026-10-19: local first — the boxed "Only on this device" row
     * pushes N2, then "or" and the invite field with Scan in its row and Continue, the only sun.
     * A pending move ([renderFirstRun]) leads with an info note and puts the invite first.
     */
    private fun buildFirstRun(): View {
        input = EditText(this, null, 0, R.style.Widget_Wg_EditText).apply {
            // N1 · 2x: the long placeholder would clip at large font scales.
            hint = if (resources.configuration.fontScale >= 1.5f) "Invite link" else "Paste invite link or address"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            isSingleLine = true
            setOnEditorActionListener { _, action, _ ->
                (action == EditorInfo.IME_ACTION_GO).also { if (it) open(text.toString()) }
            }
        }
        val scan = ImageButton(this, null, 0, R.style.Widget_Wg_IconButton).apply {
            setImageResource(R.drawable.ic_wg_qr)
            contentDescription = "Scan QR code"
            setOnClickListener { scan() }
        }
        val inputRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(input, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { gravity = Gravity.CENTER_VERTICAL })
            addView(scan, LinearLayout.LayoutParams(48.dp, 48.dp).apply { marginStart = 8.dp; gravity = Gravity.TOP })
        }
        inputError = wgText(R.style.Widget_Wg_Text_Error).apply {
            setCompoundDrawablesRelative(getDrawable(R.drawable.ic_wg_alert)!!.apply { setBounds(0, 0, 14.dp, 14.dp) }, null, null, null)
            visibility = View.GONE
        }
        inputHint = wgText(R.style.Widget_Wg_Text_Hint, INVITE_HINT)
        inviteSection = wgStack(
            8,
            wgStack(6, wgText(R.style.Widget_Wg_Text_Label, "Have an invite?"), inputRow, inputError, inputHint),
            wgButton(R.style.Widget_Wg_Button_Primary, "Continue") { open(input.text.toString()) },
        )
        localRowDesc = wgText(R.style.Widget_Wg_Text_RowDesc)
        localRow = wgRow(
            wgLeadTile(R.drawable.wg_lead_ok, R.drawable.ic_wg_device, R.color.wg_ok_fg),
            wgText(R.style.Widget_Wg_Text_RowTitle, "Only on this device"),
            localRowDesc,
            wgIcon(R.drawable.ic_wg_chev_r, R.color.wg_fg_4),
        ).apply { setOnClickListener { showIntro(true) } }
        orDivider = wgOr()
        moveNote = wgNote(
            Wg.Tone.INFO, R.drawable.ic_wg_route,
            wgLead("Your records are ready to move.", " Paste or scan the invite for your new account. They move in after you sign in."),
        )
        firstRunHead = listOf(
            wgBrand(),
            wgStack(
                8,
                wgText(R.style.Widget_Wg_Text_Title, "Your health log, on your terms"),
                wgText(R.style.Widget_Wg_Text_Lede, "Keep it on this phone with no account, or open the account you were invited to."),
            ),
        )
        val links = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(link("Privacy policy", PermissionsRationaleActivity.PRIVACY_POLICY))
            addView(Space(this@MainActivity), LinearLayout.LayoutParams(0, 0, 1f))
            // The service's landing page says how to get an invite; the address is the build's, never committed.
            if (base.isNotEmpty()) addView(link("How to get an invite", "https://$base/"))
        }
        firstRunFoot = listOf(
            // Store-review footnote (bd med-nt9p.31): word for word as ios/App/App.swift.
            wgText(
                R.style.Widget_Wg_Text_Fine,
                "Med Tracker is a personal log, not a medical device, and does not give medical advice. " +
                    "Talk to your doctor before changing a treatment.",
            ),
            links,
        )
        firstRunColumn = wgStack(20).apply { setPadding(24.dp, 8.dp, 24.dp, 24.dp) }
        renderFirstRun()
        return wgScroll(firstRunColumn, fade = true)
    }

    /** N1's order: local first; with a move pending (shot 21) the note, the invite, then the local row. */
    private fun renderFirstRun() {
        val pending = move.exists
        localRowDesc.text = if (pending) "Stay without an account and cancel the move" else "No account. Records stay on this phone."
        val middle = if (pending) listOf(moveNote, inviteSection, orDivider, localRow) else listOf(localRow, orDivider, inviteSection)
        firstRunColumn.removeAllViews()
        for (v in firstRunHead + middle + firstRunFoot) {
            (v.parent as? ViewGroup)?.removeView(v)
            firstRunColumn.addView(v, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        }
    }

    /** The invite field's error (wg-field--error): danger line, the message with its icon, and what to do. */
    private fun fieldError(message: String?, hint: String = INVITE_HINT) {
        inputError.text = message ?: ""
        inputError.visibility = if (message == null) View.GONE else View.VISIBLE
        inputHint.text = hint
        input.setBackgroundResource(if (message == null) R.drawable.wg_field else R.drawable.wg_field_error)
    }

    /**
     * N2 local intro (bd med-nt9p.32.4), twin of ios/App/App.swift LocalIntroView: Back in the top
     * bar, four facts, the optional lock (.9), Start docked. While a move is pending, a warn note
     * above the dock, Start names the consequence and a ghost button goes back to the invite.
     */
    private fun buildLocalIntro(): View {
        val lockLead = wgLeadTile(R.drawable.wg_lead, R.drawable.ic_wg_lock, R.color.wg_fg_2)
        lockSwitch = Switch(this, null, 0, R.style.Widget_Wg_Switch).apply {
            contentDescription = "Lock with fingerprint or face"
            setOnCheckedChangeListener { _, on ->
                lockLead.setBackgroundResource(if (on) R.drawable.wg_lead_sun else R.drawable.wg_lead)
                lockLead.imageTintList = getColorStateList(if (on) R.color.wg_sun else R.color.wg_fg_2)
            }
        }
        // Optional lock (bd med-nt9p.32.9); also Settings → App lock in the app. The full
        // "fingerprint, face or screen lock" wording is the system prompt's.
        lockRow = wgRow(
            lockLead,
            wgText(R.style.Widget_Wg_Text_RowTitle, "Lock with fingerprint or face"),
            wgText(R.style.Widget_Wg_Text_RowDesc, "Hides the app. It doesn't encrypt, and reminders still show on the lock screen."),
            lockSwitch,
        ).apply { setOnClickListener { lockSwitch.toggle() } }
        introMove = wgNote(
            Wg.Tone.WARN, R.drawable.ic_wg_alert,
            wgLead("A move to a cloud account is waiting.", " Start here cancels it. Your records stay on this phone."),
        )
        introMessage = wgNote(Wg.Tone.DANGER, R.drawable.ic_wg_alert, "").apply { visibility = View.GONE }
        val body = wgStack(
            20,
            wgStack(
                8,
                wgText(R.style.Widget_Wg_Text_Title, "Only on this device"),
                wgText(R.style.Widget_Wg_Text_Lede, "Use Med Tracker without an account. Your records live on this phone."),
            ),
            wgStack(
                14,
                wgFact(R.drawable.ic_wg_device, "Stored here, nowhere else", "Nothing is sent to a server."),
                // Scoped Auto Backup, bd med-nt9p.32.5 (data_extraction_rules.xml; privacy-manifest local-records).
                wgFact(R.drawable.ic_wg_download, "You make the backups", "Google backup keeps up to 25 MB. Export a file for the rest."),
                wgFact(R.drawable.ic_wg_alert, "Lose the phone, lose the records", "Unless you have a backup file.", warn = true),
                // The seamless move (bd med-nt9p.32.16-.19); Backup & import keeps the file steps as the fallback.
                wgFact(R.drawable.ic_wg_route, "Move to an account later", "Settings → Move to a cloud account."),
            ),
            lockRow,
            introMove,
            introMessage,
        ).apply { setPadding(24.dp, 8.dp, 24.dp, 24.dp) }
        startButton = wgButton(R.style.Widget_Wg_Button_Primary, "Start") {
            setLock(lockSwitch.isChecked) { e ->
                if (e == null) openLocal() else introMessage.apply { noteText(e); visibility = View.VISIBLE }
            }
        }
        openInviteButton = wgButton(R.style.Widget_Wg_Button_Ghost, "Open the new account instead") { showIntro(false) }
        val dock = wgStack(8, startButton, openInviteButton).apply { setPadding(24.dp, 12.dp, 24.dp, 16.dp) }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.color.wg_screen)
            addView(LinearLayout(this@MainActivity).apply {
                setPadding(10.dp, 2.dp, 10.dp, 2.dp)
                addView(wgButton(R.style.Widget_Wg_Button_Back, "Back") { showIntro(false) })
            })
            addView(wgRule())
            addView(wgScroll(body).also { introScroll = it }, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
            addView(wgRule())
            addView(dock)
            visibility = View.GONE
        }
    }

    private fun showIntro(on: Boolean) {
        localIntro.visibility = if (on) View.VISIBLE else View.GONE
        if (on) {
            lockSwitch.isChecked = lock.on // still on from an earlier stay in local mode
            lockRow.visibility = if (deviceSecure() || lock.on) View.VISIBLE else View.GONE
            // A pending move (bd med-nt9p.32.19): Start enters local mode, which drops the stash
            // (setLocal). Kept reachable, unlike iOS's one-tap Continue on this iPhone: it is the
            // only way back here, and the records stay in local mode either way.
            val pending = move.exists
            introMove.visibility = if (pending) View.VISIBLE else View.GONE
            openInviteButton.visibility = if (pending) View.VISIBLE else View.GONE
            startButton.text = if (pending) "Start and cancel the move" else "Start"
            introMessage.visibility = View.GONE
            introScroll.scrollTo(0, 0)
            window.insetsController?.hide(WindowInsets.Type.ime()) // the invite field's keyboard
        }
        updateChrome()
    }

    private fun link(label: String, url: String) = wgText(R.style.Widget_Wg_Text_Link, label).apply {
        setOnClickListener { openOutside(Uri.parse(url)) }
    }

    /** The browser (or the link's own app); nothing installed to take it is a silent no-op. */
    private fun openOutside(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (e: ActivityNotFoundException) {
        }
    }

    /** N4 load error (bd med-ckm5.16): the icon tile, title, lede and meta line; [showError] fills them. */
    private fun buildError(): View {
        errorIcon = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_INSIDE
            setPadding(17.dp, 17.dp, 17.dp, 17.dp) // 30dp icon in the 64dp tile
            layoutParams = LinearLayout.LayoutParams(64.dp, 64.dp).apply { gravity = Gravity.CENTER_HORIZONTAL }
        }
        errorTitle = wgText(R.style.Widget_Wg_Text_Title_Md).apply { gravity = Gravity.CENTER }
        errorLede = wgText(R.style.Widget_Wg_Text_Lede).apply { gravity = Gravity.CENTER }
        errorMeta = wgText(R.style.Widget_Wg_Text_Meta).apply { gravity = Gravity.CENTER }
        errorPrimary = wgButton(R.style.Widget_Wg_Button_Primary, "Try again") { retry() }
        errorSecondary = wgButton(R.style.Widget_Wg_Button, "Switch account") { forget() }
        val body = wgStack(16, errorIcon, errorTitle, errorLede, errorMeta).apply {
            setPadding(24.dp, 24.dp, 24.dp, 24.dp)
            gravity = Gravity.CENTER
        }
        val foot = wgStack(
            8, errorPrimary, errorSecondary,
            wgButton(R.style.Widget_Wg_Button_Ghost_Sm, "Copy diagnostics") { copyDiagnostics() },
        ).apply { setPadding(24.dp, 12.dp, 24.dp, 16.dp) }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.color.wg_screen)
            addView(wgScroll(body), LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
            addView(wgRule(R.color.wg_line))
            addView(foot)
            visibility = View.GONE
        }
    }

    // MARK: lock (bd med-nt9p.32.9)

    /**
     * N3, local mode's lock screen (bd med-ckm5.16): the 96dp mark tile at the window's centre (the
     * splash's spot, N6), no account name, Unlock the only control. A failed check adds the warn
     * note; a cancelled prompt lands on the plain locked state and stays: only the button asks again.
     */
    private fun buildLock(): View {
        unlockButton = wgButton(R.style.Widget_Wg_Button_Primary, "Unlock") { lock.begin()?.let { authenticate(it) } }
        lockNote = wgNote(Wg.Tone.WARN, R.drawable.ic_wg_alert, "Not recognised. Try again, or use your screen lock.").apply {
            visibility = View.GONE
        }
        val text = wgStack(
            16,
            wgText(R.style.Widget_Wg_Text_Title_Md, "Med Tracker is locked").apply { gravity = Gravity.CENTER },
            wgText(R.style.Widget_Wg_Text_Lede, "Unlock with your fingerprint, face or screen lock.").apply { gravity = Gravity.CENTER },
            lockNote,
        ).apply { setPadding(24.dp, 20.dp, 24.dp, 16.dp) }
        lockFoot = wgStack(8, unlockButton)
        // Two equal halves around the mark: it stays centred whatever the text below needs.
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.color.wg_screen)
            addView(Space(this@MainActivity), LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
            addView(ImageView(this@MainActivity).apply {
                setImageResource(R.drawable.wg_mark_lg)
                contentDescription = "Med Tracker"
            }, LinearLayout.LayoutParams(96.dp, 96.dp).apply { gravity = Gravity.CENTER_HORIZONTAL })
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                addView(wgScroll(text), LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
                addView(wgRule(R.color.wg_line))
                addView(lockFoot)
            }, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
            visibility = View.GONE
        }
    }

    /** The lock screen or the page, as the lock says; on unlock, what it held back. */
    private fun applyLock() {
        // No app-switcher snapshot while the lock is on (screenshots, and so the QA harness, still work).
        setRecentsScreenshotEnabled(!(local && lock.on))
        if (lock.on != screenOffRegistered) {
            if (lock.on) registerReceiver(screenOff, IntentFilter(Intent.ACTION_SCREEN_OFF), RECEIVER_NOT_EXPORTED)
            else unregisterReceiver(screenOff)
            screenOffRegistered = lock.on
        }
        unlockButton.isEnabled = lock.state != LocalLock.State.UNLOCKING
        lockNote.visibility = if (lock.failed || DebugHooks.qaLockFailed(this)) View.VISIBLE else View.GONE
        val hide = concealed
        if (hide == (lockView.visibility == View.VISIBLE)) return
        lockView.visibility = if (hide) View.VISIBLE else View.GONE
        if (hide) {
            // Out of the window the page is hidden: no visibilitychange work runs behind the lock.
            root.removeView(web)
            window.insetsController?.hide(WindowInsets.Type.ime())
        } else if (web.parent == null) {
            root.addView(web, 0)
            layoutBars()
        }
        updateChrome()
        if (hide) return
        deferredUrl?.let { deferredUrl = null; load(it) }
        deferredSection?.let { deferredSection = null; openSection(it) }
    }

    private fun authenticate(attempt: Int) {
        applyLock() // the Unlock button waits for this prompt
        deviceCheck("Unlock Med Tracker") { ok, cancelled ->
            lock.finish(attempt, ok, cancelled)
            applyLock()
        }
    }

    /**
     * The intro's Start and Settings → App lock (lock.set): turning the lock on, or off while it
     * is on, applies only after the phone confirmed its owner. null, or why not.
     */
    private fun setLock(on: Boolean, done: (String?) -> Unit) {
        if (!on && !lock.on) return done(null)
        if (on && !deviceSecure()) return done("Set a screen lock in Android Settings first, or switch the lock off.")
        deviceCheck(if (on) "Turn on the lock for Med Tracker" else "Turn off the lock for Med Tracker") { ok, _ ->
            if (!ok) {
                done(
                    if (lock.on) "The lock is on from before, and changing it or opening Med Tracker needs your fingerprint, face or screen lock. Try again."
                    else "The lock was not turned on. Try again, or switch it off to continue without it."
                )
                return@deviceCheck
            }
            prefs.edit().putBoolean(LocalLock.KEY, on).apply()
            lock.confirmed(on)
            applyLock()
            done(null)
        }
    }

    /** The phone has a screen lock to check against. */
    private fun deviceSecure() = getSystemService(KeyguardManager::class.java).isDeviceSecure

    /**
     * BiometricPrompt with the screen lock as fallback. No screen lock (removed after the lock went
     * on) passes: the lock must never strand the only copy of the records.
     * done(ok, cancelled): a cancel (the user, or the app leaving the screen) is not a failure (N3).
     */
    private fun deviceCheck(title: String, done: (Boolean, Boolean) -> Unit) {
        if (!deviceSecure()) return done(true, false)
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                prompting = false
                done(true, false)
            }
            override fun onAuthenticationError(code: Int, message: CharSequence) {
                prompting = false
                done(code == BiometricPrompt.BIOMETRIC_ERROR_NO_DEVICE_CREDENTIAL, code in CANCELS)
            }
        }
        prompting = true
        runCatching {
            BiometricPrompt.Builder(this)
                .setTitle(title)
                .setAllowedAuthenticators(Authenticators.BIOMETRIC_WEAK or Authenticators.DEVICE_CREDENTIAL)
                .build()
                .authenticate(CancellationSignal(), mainExecutor, callback)
        }.onFailure {
            diag("shell lock prompt failed ${it.javaClass.simpleName}")
            prompting = false
            done(false, false)
        }
    }

    /** Play services' scanner: no camera permission here; any failure falls back to paste. A match fills the field and runs Continue. */
    private fun scan() {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener { code -> (code.rawValue ?: "").let { input.setText(it); open(it) } }
            .addOnFailureListener { fieldError("Scanning isn't available on this phone.", "Paste the link instead.") }
    }

    // MARK: diagnostics (bd med-nt9p.22)

    /** Appends one redacted line to the capped ceremony log. */
    private fun diag(line: String) {
        val log = diagPrefs.getString(DIAG_KEY, "") ?: ""
        diagPrefs.edit().putString(DIAG_KEY, Diag.append(log, line, base, Instant.now().toString())).apply()
    }

    private fun webAuthnMode(w: WebView): String {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) return "unsupported"
        return when (val m = WebSettingsCompat.getWebAuthenticationSupport(w.settings)) {
            WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_NONE -> "none"
            WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP -> "for-app"
            WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_BROWSER -> "for-browser"
            else -> "unknown($m)"
        }
    }

    /** Launcher shortcut or the load-error screen (N4): the device header plus the log, as plain text. */
    private fun copyDiagnostics() {
        val wv = WebViewCompat.getCurrentWebViewPackage(this)
        val credential = runCatching { Settings.Secure.getString(contentResolver, "credential_service") }.getOrNull()
        val autofill = runCatching { getSystemService(AutofillManager::class.java)?.autofillServiceComponentName?.flattenToShortString() }.getOrNull()
        val header = listOf(
            "Med Tracker diagnostics ${Instant.now()}",
            "app ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) ${BuildConfig.BUILD_TYPE}",
            "Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT}) ${Build.MANUFACTURER} ${Build.MODEL}",
            "WebView ${wv?.packageName} ${wv?.versionName}",
            "credential provider ${credential?.takeIf { it.isNotBlank() } ?: "unavailable"}; autofill ${autofill ?: "unavailable"}",
            "webauthn ${if (::web.isInitialized) webAuthnMode(web) else "not started"}",
        ).joinToString("\n")
        val text = Diag.redact(header, base) + "\n\n" + (diagPrefs.getString(DIAG_KEY, "") ?: "")
        getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Med Tracker diagnostics", text))
        Toast.makeText(this, "Diagnostics copied", Toast.LENGTH_SHORT).show()
    }

    private companion object {
        /** The page-facing bridge global, window.wgNative — med-nt9p.6 and .19 detect the Android shell by it. */
        const val BRIDGE = "wgNative"
        /** N6's cap on holding the splash for a page that never reports ready. */
        const val SPLASH_MAX_MS = 5_000L
        /** BiometricPrompt errors that are a dismissal, not a failed check (N3: no note). */
        val CANCELS = setOf(
            BiometricPrompt.BIOMETRIC_ERROR_CANCELED,
            BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED,
        )
        /** N4's meta line when the response carries no reason phrase. */
        val STATUS_TEXT = mapOf(
            404 to "not found", 500 to "internal server error", 502 to "bad gateway",
            503 to "service unavailable", 504 to "gateway timeout",
        )
        /** N4's meta line time. */
        val HH_MM: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")
        const val HOST_KEY = "accountHost"
        const val LEAVE_HOST_KEY = "leaveHost"
        const val ACTION_SWITCH = "com.example.medtracker.SWITCH_ACCOUNT"
        const val ACTION_DIAG = "com.example.medtracker.COPY_DIAGNOSTICS"
        const val DIAG_KEY = "log"
        /** --wg-bg-screen: the bands' colour until the page reports its own. */
        val SCREEN = Wg.SCREEN
        /** N1's second line under the invite field when nothing is wrong. */
        const val INVITE_HINT = "From your invite, or scan the QR on your Emergency Kit."
    }
}
