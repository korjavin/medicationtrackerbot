package com.example.medtracker

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.Window
import android.view.WindowInsets
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import org.json.JSONTokener
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

// GO/NO-GO spike (bd med-nt9p.4), twin of the iOS spike med-w6gx.2.
// Throwaway: the shell bead (med-nt9p.5) replaces this file. One Android System
// WebView on an account origin the tester pastes at runtime (no domain is ever
// built in), with passkeys enabled for the app, a scoped WebMessageListener
// bridge, camera and file-chooser plumbing, and a native panel that runs the
// checks in assets/spike-checks.js. The procedure is in docs/android.md.
class MainActivity : Activity() {
    private val prefs by lazy { getSharedPreferences("spike", MODE_PRIVATE) }
    /** Fresh per process: an IndexedDB marker from another launchId proves the data survived a kill. */
    private val launchId = UUID.randomUUID().toString()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var web: WebView
    private lateinit var panel: View
    private lateinit var logView: TextView
    private lateinit var urlField: EditText
    /** The base domain the bridge and tap script are bound to; from the tester's input, never the build. */
    private var base = ""
    private var tapScript: ScriptHandler? = null
    private var pendingPermission: PermissionRequest? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var runSeq = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        WebView.setWebContentsDebuggingEnabled(true) // chrome://inspect from a desktop, spike only

        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        val webauthn = if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
            WebSettingsCompat.setWebAuthenticationSupport(web.settings, WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP)
            "for-app (read back ${WebSettingsCompat.getWebAuthenticationSupport(web.settings)})"
        } else {
            "UNSUPPORTED by this WebView"
        }
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) = onLoaded(url)

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) log("load failed: ${error.errorCode} ${error.description}")
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                log("render process gone (crash=${detail.didCrash()}); recreating")
                recreate()
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) = onWebPermission(request)

            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                log("onShowFileChooser accept=${params.acceptTypes.joinToString()}")
                return try {
                    startActivityForResult(params.createIntent(), REQ_FILE)
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    log("file chooser failed: $e")
                    false
                }
            }

            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) log("console error: ${m.message().take(300)}")
                return false
            }
        }

        setContentView(buildUi())
        prefs.getString("base", null)?.let { bind(it) }
        val wv = WebViewCompat.getCurrentWebViewPackage(this)
        val app = packageManager.getPackageInfo(packageName, 0)
        log(
            "launch ${launchId.take(8)} Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT}, " +
                "${Build.DISPLAY}, patch ${Build.VERSION.SECURITY_PATCH}) ${Build.MANUFACTURER} ${Build.MODEL}; " +
                "WebView ${wv?.packageName} ${wv?.versionName}; app ${app.versionName} (${app.longVersionCode}); webauthn $webauthn"
        )

        val last = prefs.getString("lastUrl", null)
        if (last != null && base.isNotEmpty()) web.loadUrl(last) else panel.visibility = View.VISIBLE
    }

    // MARK: UI — a plain panel over the web view, opened by the "Spike" button.

    private fun buildUi(): View {
        val root = FrameLayout(this)
        root.addView(web, MATCH_PARENT, MATCH_PARENT)

        urlField = EditText(this).apply {
            hint = "Paste an invite link or https://<account>/"
            maxLines = 3
        }
        logView = TextView(this).apply {
            setTextIsSelectable(true)
            textSize = 11f
            typeface = Typeface.MONOSPACE
            text = prefs.getString("log", "")
        }
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
            addView(urlField)
        }
        val actions = listOf<Pair<String, () -> Unit>>(
            "Open" to { open(urlField.text.toString()) },
            "Run checks (3, 4, 5 camera, 6)" to { run("checks") },
            "Passkey create + PRF" to { run("create") },
            "Passkey get + PRF" to { run("get") },
            "File chooser (5)" to { run("file") },
            "Reload page" to { web.reload() },
            "Copy report" to { copyReport() },
            "Clear report" to { prefs.edit().remove("log").apply(); logView.text = "" },
            "Close panel" to { panel.visibility = View.GONE },
        )
        for ((label, action) in actions) {
            column.addView(Button(this).apply { text = label; isAllCaps = false; setOnClickListener { action() } })
        }
        column.addView(logView)

        val bg = TypedValue().also { theme.resolveAttribute(android.R.attr.colorBackground, it, true) }
        panel = ScrollView(this).apply {
            setBackgroundColor(bg.data)
            visibility = View.GONE
            addView(column)
        }
        root.addView(panel, MATCH_PARENT, MATCH_PARENT)

        val toggle = Button(this).apply {
            text = "Spike"
            isAllCaps = false
            alpha = 0.7f
            setOnClickListener { panel.visibility = if (panel.visibility == View.VISIBLE) View.GONE else View.VISIBLE }
        }
        root.addView(toggle, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.END or Gravity.CENTER_VERTICAL))

        // targetSdk 35 draws edge to edge: keep everything clear of the system bars and keyboard.
        root.setOnApplyWindowInsetsListener { v, insets ->
            val b = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsets.CONSUMED
        }
        return root
    }

    @Deprecated("Activity back handling is enough for a spike")
    override fun onBackPressed() {
        when {
            panel.visibility == View.VISIBLE -> panel.visibility = View.GONE
            web.canGoBack() -> web.goBack()
            else -> super.onBackPressed()
        }
    }

    // MARK: navigation

    private fun open(raw: String) {
        val line = raw.lines().map { it.trim() }.firstOrNull { it.isNotEmpty() } ?: return
        val uri = Uri.parse(if ("://" in line) line else "https://$line")
        val newBase = uri.host?.let { SpikeText.baseOf(it) }
        if (uri.scheme != "https" || newBase == null) {
            log("open: not an https account URL (https://<sub>.<base>/…)")
            return
        }
        bind(newBase)
        urlField.setText("")
        panel.visibility = View.GONE
        log("open ${strip(uri)}${if (uri.fragment != null) " (+ #fragment)" else ""}")
        web.loadUrl(uri.toString())
    }

    private fun onLoaded(url: String) {
        val uri = Uri.parse(url)
        val clean = strip(uri) // never keep or log a #claim= token
        log("loaded $clean")
        // Unredacted on purpose, in the app's own sandbox: the relaunch needs the real origin.
        if (isAccountHost(uri.host ?: "")) prefs.edit().putString("lastUrl", clean).apply()
    }

    private fun strip(uri: Uri) = uri.buildUpon().fragment(null).clearQuery().build().toString()

    private fun isAccountHost(host: String): Boolean {
        if (base.isEmpty() || !host.lowercase().endsWith(".$base")) return false
        val label = host.dropLast(base.length + 1)
        return label.isNotEmpty() && '.' !in label
    }

    /**
     * Binds the wgSpike bridge and the WebAuthn tap to every https subdomain of base: both
     * apply to navigations after the call, so this runs before the load.
     */
    private fun bind(newBase: String) {
        if (newBase == base) return
        val rules = setOf("https://*.$newBase")
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            if (base.isNotEmpty()) WebViewCompat.removeWebMessageListener(web, BRIDGE)
            WebViewCompat.addWebMessageListener(web, BRIDGE, rules) { _, message, origin, isMainFrame, reply ->
                onBridge(message.data, origin, isMainFrame, reply)
            }
        } else {
            log("WEB_MESSAGE_LISTENER unsupported by this WebView")
        }
        tapScript?.remove()
        tapScript = if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, asset("spike-tap.js"), rules)
        } else {
            log("DOCUMENT_START_SCRIPT unsupported: no webauthn tap")
            null
        }
        base = newBase
        prefs.edit().putString("base", newBase).apply()
    }

    private fun onBridge(data: String?, origin: Uri, isMainFrame: Boolean, reply: JavaScriptReplyProxy) {
        val msg = try {
            JSONObject(data ?: "")
        } catch (e: Exception) {
            log("bridge: unparseable message")
            return
        }
        when (msg.optString("op")) {
            "ping" -> reply.postMessage(
                JSONObject().put("pong", true).put("launchId", launchId.take(8))
                    .put("origin", origin.toString()).put("mainFrame", isMainFrame).toString()
            )
            "log" -> log("tap $msg")
            else -> log("bridge: unknown op ${msg.optString("op")}")
        }
    }

    // MARK: checks — evaluated on the loaded page; the result is polled, so it
    // arrives even when the bridge does not.

    private fun run(op: String) {
        panel.visibility = View.GONE
        val id = ++runSeq
        val host = Uri.parse(web.url ?: "").host ?: "?"
        val args = JSONObject().put("launchId", launchId)
            .put("versionCode", packageManager.getPackageInfo(packageName, 0).longVersionCode)
        log("$op on $host: started${if (op != "checks") " — tap the button on the page" else ""}")
        web.evaluateJavascript(asset("spike-checks.js") + "\nwgSpikeRun(${JSONObject.quote(op)}, $id, $args);", null)
        poll(op, host, id, System.currentTimeMillis())
    }

    private fun poll(op: String, host: String, id: Int, start: Long) {
        main.postDelayed({
            web.evaluateJavascript("JSON.stringify(window.__wgSpikeDone || null)") { raw ->
                val done = runCatching { JSONObject(JSONTokener(raw).nextValue() as String) }.getOrNull()
                when {
                    done != null && done.optInt("id") == id -> {
                        log("$op on $host:\n${done.optString("text")}")
                        panel.visibility = View.VISIBLE
                    }
                    System.currentTimeMillis() - start > 180_000 -> log("$op on $host: no result in 3 min")
                    else -> poll(op, host, id, start)
                }
            }
        }, 500)
    }

    // MARK: camera + file chooser

    private fun onWebPermission(request: PermissionRequest) {
        val host = request.origin.host ?: ""
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE !in request.resources || !isAccountHost(host)) {
            log("web permission denied: ${request.resources.joinToString()} for $host")
            request.deny()
            return
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            grantCamera(request)
        } else {
            pendingPermission?.deny()
            pendingPermission = request
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
        }
    }

    private fun grantCamera(request: PermissionRequest) {
        log("onPermissionRequest: camera granted to ${request.origin.host}")
        request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (requestCode != REQ_CAMERA) return
        val request = pendingPermission ?: return
        pendingPermission = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            grantCamera(request)
        } else {
            log("camera permission refused")
            request.deny()
        }
    }

    @Deprecated("startActivityForResult is enough for a spike")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQ_FILE) return
        val uris = WebChromeClient.FileChooserParams.parseResult(resultCode, data)
        log("file chooser returned ${uris?.size ?: 0} file(s)")
        fileCallback?.onReceiveValue(uris)
        fileCallback = null
    }

    // MARK: report

    /** Redacted before storing, so the persisted log never holds a raw base or account host. */
    private fun log(s: String) {
        val line = "[${SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())}] ${SpikeText.redact(s, base)}\n"
        val text = (prefs.getString("log", "") + line).takeLast(60_000)
        prefs.edit().putString("log", text).apply()
        if (::logView.isInitialized) logView.text = text
    }

    private fun copyReport() {
        val text = prefs.getString("log", "") ?: ""
        getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("spike report", text))
        Toast.makeText(this, "Report copied (${text.length} chars)", Toast.LENGTH_SHORT).show()
    }

    private fun asset(name: String) = assets.open(name).bufferedReader().use { it.readText() }

    private companion object {
        const val BRIDGE = "wgSpike"
        const val REQ_CAMERA = 1
        const val REQ_FILE = 2
    }
}
