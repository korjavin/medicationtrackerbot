package com.example.medtracker

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.Window
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.inputmethod.EditorInfo
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import org.json.JSONObject

/**
 * The shell (bd med-nt9p.5), twin of ios/App/Shell.swift: one Android System
 * WebView on the account origin https://<sub>.<base>/, exactly like the PWA.
 * The app remembers only the account host; the vault, Service Worker and
 * IndexedDB live in WebView storage, per origin. The base domain comes from
 * the build (BuildConfig.BASE_DOMAIN), the account from the invite at runtime.
 */
class MainActivity : Activity() {
    private val base = BuildConfig.BASE_DOMAIN
    private val prefs by lazy { getSharedPreferences("shell", MODE_PRIVATE) }
    private var host: String? = null
    /** In memory only: Try again must keep an invite link's #claim= fragment. */
    private var lastUrl: String? = null
    /** A page of this account finished loading: later load failures leave it usable. */
    private var showingAccount = false
    private var loadFailed = false
    /** Set by open/forget: the previous account's pages must not stay reachable by Back. */
    private var clearHistory = false
    private var topColor = SCREEN
    private var bottomColor = SCREEN
    private var bars = WindowInsets.CONSUMED

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var topBand: View
    private lateinit var bottomBand: View
    private lateinit var firstRun: View
    private lateinit var input: EditText
    private lateinit var firstRunMessage: TextView
    private lateinit var errorView: View
    private lateinit var errorMessage: TextView

    private val files by lazy { Files(this) { host } }

    private val back = OnBackInvokedCallback { web.goBack() }
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
        publishShortcut()

        adoptSpikeAccount()
        host = prefs.getString(HOST_KEY, null)?.takeIf { AccountUrl.isAccountHost(it, base) }
        // A restored activity keeps its launch intent: only a fresh shortcut launch switches.
        if (intent?.action == ACTION_SWITCH && savedInstanceState == null) forget() else reopen()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == ACTION_SWITCH) forget()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (!files.onActivityResult(requestCode, resultCode, data)) super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        if (!files.onRequestPermissionsResult(requestCode)) super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    // MARK: account

    private val home get() = host?.let { "https://$it/" }

    /** First-run submit: open the account, or say why not. */
    private fun open(raw: String) {
        val url = AccountUrl.parse(raw, base)
        val h = url?.let { Uri.parse(it).host }
        if (url == null || h == null) {
            firstRunMessage.text = if (base.isEmpty()) "This build has no service configured."
            else "That isn't an account link. Use your invite link or your account address (yourname.$base)."
            return
        }
        prefs.edit().putString(HOST_KEY, h).apply()
        host = h
        input.setText("")
        firstRunMessage.text = ""
        reopen(url) // the claim link keeps its #fragment for the page; only the host is stored
    }

    /** Switch account: back to first run. WebView data is per origin and kept. */
    private fun forget() {
        prefs.edit().remove(HOST_KEY).apply()
        host = null
        reopen()
    }

    private fun reopen(url: String? = home) {
        showingAccount = false
        lastUrl = null
        clearHistory = true
        errorView.visibility = View.GONE
        if (url == null) {
            web.loadUrl("about:blank")
            firstRun.visibility = View.VISIBLE
        } else {
            firstRun.visibility = View.GONE
            load(url)
        }
        updateChrome()
    }

    private fun load(url: String) {
        errorView.visibility = View.GONE
        lastUrl = url
        web.loadUrl(url)
        updateChrome()
    }

    private fun retry() {
        (lastUrl ?: home)?.let { load(it) }
    }

    private fun showError(message: String) {
        errorMessage.text = message
        errorView.visibility = View.VISIBLE
        updateChrome()
    }

    private fun isInside(h: String?): Boolean {
        val l = h?.lowercase() ?: return false
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
        runCatching { getSystemService(ShortcutManager::class.java).setDynamicShortcuts(listOf(switch)) }
    }

    // MARK: web view

    private fun makeWebView(): WebView {
        val w = WebView(this)
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
            WebSettingsCompat.setWebAuthenticationSupport(w.settings, WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP)
        }
        w.setBackgroundColor(Color.TRANSPARENT)
        w.webViewClient = Client()
        files.install(w, if (base.isEmpty()) emptySet() else setOf("https://*.$base"))
        if (base.isNotEmpty()) {
            val rules = setOf("https://*.$base")
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                WebViewCompat.addWebMessageListener(w, BRIDGE, rules) { _, message, origin, isMainFrame, reply ->
                    onBridge(message.data, origin, isMainFrame) { reply.postMessage(it) }
                }
            }
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                WebViewCompat.addDocumentStartJavaScript(w, assets.open("chrome.js").bufferedReader().use { it.readText() }, rules)
            }
        }
        return w
    }

    private inner class Client : WebViewClient() {
        /** Only the account host and the base domain load in the app; anything else opens outside it. */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            when (uri.scheme?.lowercase()) {
                "http", "https" -> if (isInside(uri.host) || !request.isForMainFrame) return false
                "blob", "data", "about" -> return false
            }
            try {
                startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
            } catch (e: ActivityNotFoundException) {
            }
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
            if (!loadFailed && host != null && url?.let { Uri.parse(it).host?.lowercase() } == host) showingAccount = true
            updateBack()
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) = updateBack()

        /**
         * Offline with a Service Worker in control never gets here: the worker answers.
         * Unlike WKWebView, WebView replaces the page with its own error page, so a
         * later failure gets the screen too, and Try again reloads that URL.
         */
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            loadFailed = true
            if (showingAccount) lastUrl = request.url.toString()
            showError(error.description?.toString()?.takeIf { it.isNotBlank() } ?: "The page could not be loaded.")
        }

        /** An HTTP error before any page of this account showed — a mistyped or deleted account is a 404. */
        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            // Once the account showed, the server's own error page stays (Back leaves it).
            if (!request.isForMainFrame || response.statusCode < 400 || showingAccount) return
            loadFailed = true
            val h = request.url.host?.lowercase()
            showError(
                if (response.statusCode == 404 && h == host) "There is no account at $host."
                else response.reasonPhrase?.takeIf { it.isNotBlank() } ?: "The server answered ${response.statusCode}."
            )
        }

        /** Renderer crash or kill: a fresh WebView on the same URL (it keeps the fragment). */
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            val url = runCatching { view.url }.getOrNull()?.takeIf { it != "about:blank" }
            root.removeView(view)
            view.destroy()
            web = makeWebView()
            root.addView(web, 0)
            layoutBars()
            showingAccount = false
            when {
                url != null -> load(url)
                host == null -> web.loadUrl("about:blank")
                else -> retry()
            }
            return true
        }
    }

    /**
     * The wgNative bridge (bd med-nt9p.5): WebMessageListener injected as
     * window.wgNative on the `https` subdomains of base. Only the account's own
     * top-level page is answered. Messages are JSON {op, args, id}; replies
     * {id, result} or {id, error}. Capability ops (native/ android platform,
     * med-nt9p.6) add cases here.
     */
    private fun onBridge(data: String?, origin: Uri, isMainFrame: Boolean, reply: (String) -> Unit) {
        val msg = runCatching { JSONObject(data ?: "") }.getOrNull() ?: return
        val id = msg.opt("id")
        fun answer(result: Any?, error: String? = null) {
            if (id == null) return
            reply(JSONObject().put("id", id).apply { if (error != null) put("error", error) else put("result", result) }.toString())
        }
        if (!isMainFrame || origin.scheme != "https" || origin.host?.lowercase() != host) {
            answer(null, "forbidden")
            return
        }
        when (val op = msg.optString("op")) {
            "ping" -> answer("pong")
            "chrome" -> {
                val args = msg.optJSONObject("args") ?: return
                cssColor(args.optString("top"))?.let { topColor = it }
                cssColor(args.optString("bottom"))?.let { bottomColor = it }
                updateChrome()
            }
            else -> answer(null, "unsupported: $op")
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
        errorView = buildError()
        root.addView(firstRun, MATCH_PARENT, MATCH_PARENT)
        root.addView(errorView, MATCH_PARENT, MATCH_PARENT)
        root.setOnApplyWindowInsetsListener { _, insets ->
            bars = insets
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
        for (v in listOf(firstRun, errorView)) v.setPadding(sys.left, sys.top, sys.right, bottom)
    }

    /** Bands and bar icons follow the page, or the theme while a native screen is up. */
    private fun updateChrome() {
        val native = firstRun.visibility == View.VISIBLE || errorView.visibility == View.VISIBLE
        val themeBg = TypedValue().also { theme.resolveAttribute(android.R.attr.colorBackground, it, true) }.data
        val top = if (native) themeBg else topColor
        val bottom = if (native) themeBg else bottomColor
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

    private fun isLight(c: Int) = Color.luminance(c) > 0.5f

    /** Back walks the web view's history while the page shows, then leaves the app. */
    private fun updateBack() {
        val want = firstRun.visibility != View.VISIBLE && errorView.visibility != View.VISIBLE && web.canGoBack()
        if (want == backRegistered) return
        if (want) onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, back)
        else onBackInvokedDispatcher.unregisterOnBackInvokedCallback(back)
        backRegistered = want
    }

    // MARK: native screens

    private fun buildFirstRun(): View {
        input = EditText(this).apply {
            hint = if (base.isEmpty()) "Invite link" else "Invite link or yourname.$base"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            setOnEditorActionListener { _, action, _ ->
                (action == EditorInfo.IME_ACTION_GO).also { if (it) open(text.toString()) }
            }
        }
        firstRunMessage = TextView(this)
        return screen(
            "Med Tracker",
            TextView(this).apply {
                text = "Med Tracker is invite-only. Paste your invite link or your account address, " +
                    "or scan the QR code from your invite or your Emergency Kit."
            },
            input,
            button("Open") { open(input.text.toString()) },
            button("Scan QR code") { scan() },
            firstRunMessage,
        )
    }

    private fun buildError(): View {
        errorMessage = TextView(this)
        return screen(
            "Can't open your account",
            errorMessage,
            button("Try again") { retry() },
            button("Switch account") { forget() },
        ).apply { visibility = View.GONE }
    }

    private fun screen(title: String, vararg views: View): View {
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (24 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
            addView(TextView(this@MainActivity).apply {
                text = title
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
            })
            for (v in views) addView(v, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = pad / 2 })
        }
        val bg = TypedValue().also { theme.resolveAttribute(android.R.attr.colorBackground, it, true) }.data
        return ScrollView(this).apply {
            setBackgroundColor(bg)
            isFillViewport = true
            clipToPadding = false
            addView(column)
        }
    }

    private fun button(label: String, action: () -> Unit) =
        Button(this).apply { text = label; isAllCaps = false; setOnClickListener { action() } }

    /** Play services' scanner: no camera permission here; any failure falls back to paste. */
    private fun scan() {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener { code -> open(code.rawValue ?: "") }
            .addOnFailureListener { firstRunMessage.text = "Scanning isn't available on this phone. Paste the link instead." }
    }

    private companion object {
        /** The page-facing bridge global, window.wgNative — med-nt9p.6 and .19 detect the Android shell by it. */
        const val BRIDGE = "wgNative"
        const val HOST_KEY = "accountHost"
        const val ACTION_SWITCH = "com.example.medtracker.SWITCH_ACCOUNT"
        /** --wg-bg-screen: the bands' colour until the page reports its own. */
        val SCREEN = Color.rgb(0x13, 0x2D, 0x29)
    }
}
