package com.example.medtracker

import android.Manifest
import android.app.Activity
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.view.WindowInsets
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.util.UUID

/**
 * Local-mode GO/NO-GO spike (bd med-nt9p.32.1), DEBUG SOURCE SET ONLY: the release APK has
 * neither this activity nor its assets. Twin of ios/App/LocalSpike.swift: serves the iOS spike
 * page (ios/LocalSpike, copied into the debug assets as localspike/ by app/build.gradle.kts) on
 * https://appassets.androidplatform.net from shouldInterceptRequest, with the CSP as a response
 * header, and answers the page's wgSpike bridge (origin / native / report). Its own launcher
 * icon ("Local spike") and process-wide WebView storage, so its IndexedDB lives where local mode's
 * will. Never touches MainActivity. Procedure and results: docs/android.md → Spike: local mode.
 */
class LocalSpikeActivity : Activity() {
    private lateinit var web: WebView
    private var grant: PermissionRequest? = null
    private val log = mutableListOf<String>()
    private var pageReport = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(true)
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.webViewClient = Client()
        web.webChromeClient = Chrome()
        val rules = setOf(ORIGIN)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "wgSpike", rules) { _, message, origin, isMainFrame, reply ->
                reply.postMessage(onBridge(message.data.orEmpty(), origin, isMainFrame))
            }
        } else note("WEB_MESSAGE_LISTENER unsupported")
        // chrome.js's mechanism on this origin: does a document-start script run under the CSP header?
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, "window.__wgDocStart = true;", rules)
        } else note("DOCUMENT_START_SCRIPT unsupported")
        web.setOnApplyWindowInsetsListener { v, insets ->
            val b = insets.getInsets(WindowInsets.Type.systemBars())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            insets
        }
        setContentView(web)
        note("load $ORIGIN/ (launch $launch)")
        web.loadUrl("$ORIGIN/")
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    private fun note(s: String) {
        synchronized(log) { log.add("[${java.time.LocalTime.now().withNano(0)}] $s") }
        Log.i(TAG, s)
    }

    // MARK: the asset origin (shouldInterceptRequest runs off the main thread)

    private inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            if (request.url.host == HOST) serve(request.url) else null // other hosts: CSP decides, then the network

        /** The spike never navigates away from its origin. */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) =
            request.url.host != HOST

        override fun onPageFinished(view: WebView, url: String?) = note("loaded $url")
    }

    private fun serve(url: Uri): WebResourceResponse {
        val path = url.path.orEmpty().ifEmpty { "/" }
        val headers = mutableMapOf("Cache-Control" to "no-store")
        if (path == "/env.json") return ok("application/json", headers, env().toByteArray())
        val rel = if (path == "/") "index.html" else path.removePrefix("/")
        val bytes = if (path.endsWith("/") && path != "/" || rel.split('/').any { it == ".." || it == "." }) null
        else runCatching { assets.open("localspike/$rel").use { it.readBytes() } }.getOrNull()
        // Never fall through to the network: a miss is an explicit 404.
        if (bytes == null) {
            note("404 $path")
            return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, ByteArrayInputStream(ByteArray(0)))
        }
        if (rel.endsWith(".html")) headers["Content-Security-Policy"] = CSP
        return ok(mime(rel), headers, bytes)
    }

    private fun ok(mime: String, headers: Map<String, String>, body: ByteArray) =
        WebResourceResponse(mime, if (mime.startsWith("text/") || mime.endsWith("json")) "utf-8" else null, 200, "OK", headers, ByteArrayInputStream(body))

    private fun env(): String {
        val info = packageManager.getPackageInfo(packageName, 0)
        return JSONObject()
            .put("build", info.longVersionCode.toString())
            .put("version", info.versionName ?: "?")
            .put("platform", "android")
            .put("android", "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            .put("model", Build.MODEL)
            .put("webview", WebViewCompat.getCurrentWebViewPackage(this)?.let { "${it.packageName} ${it.versionName}" } ?: "?")
            .put("launch", launch)
            .put("vendor", installId())
            .put("scheme", "https")
            .put("host", HOST)
            .toString()
    }

    /** Lives in no_backup: a fresh install, `pm clear` or another device gets a new one, a restore does not bring it. */
    private fun installId(): String {
        val f = File(noBackupFilesDir, "wg-spike-install-id")
        return runCatching { f.readText() }.getOrNull()?.takeIf { it.isNotBlank() }
            ?: UUID.randomUUID().toString().take(8).also { f.writeText(it) }
    }

    // MARK: wgSpike bridge (check 8): {id, op} in, {id, value | error} out

    private fun onBridge(data: String, origin: Uri, isMainFrame: Boolean): String {
        val msg = runCatching { JSONObject(data) }.getOrElse { JSONObject() }
        val out = JSONObject().put("id", msg.opt("id"))
        when (val op = msg.optString("op")) {
            "origin" -> {
                note("#8 bridge: origin scheme=${origin.scheme} host=${origin.host} port=${origin.port} mainFrame=$isMainFrame")
                out.put("value", JSONObject().put("protocol", origin.scheme).put("host", origin.host).put("port", origin.port).put("mainFrame", isMainFrame))
            }
            "native" -> out.put("value", nativeReport())
            "report" -> {
                pageReport = msg.optString("text")
                pageReport.lines().forEach { Log.i(TAG, "page: $it") }
                out.put("value", true)
            }
            else -> out.put("error", "unsupported: $op")
        }
        return out.toString()
    }

    private fun nativeReport(): String {
        val backup = applicationInfo.flags and ApplicationInfo.FLAG_ALLOW_BACKUP != 0
        val lines = mutableListOf(
            "native · versionCode ${packageManager.getPackageInfo(packageName, 0).longVersionCode} · Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}) · launch $launch",
            "origin $ORIGIN · allowBackup=$backup (main manifest + data_extraction_rules.xml)",
        )
        synchronized(log) { lines += log }
        val root = File(dataDir, "app_webview")
        lines += "#7 app_webview dirs (path · bytes):"
        root.walkTopDown().maxDepth(4).filter { it.isDirectory }.forEach { d ->
            lines += "  ${d.relativeTo(dataDir)} · ${d.walkTopDown().filter { it.isFile }.sumOf { it.length() }} B"
        }
        val ours = File(root, "Default/IndexedDB").listFiles()?.filter { HOST in it.name }.orEmpty()
        if (ours.isEmpty()) lines += "#7 our origin dir: not found (the page has not written yet?)"
        ours.forEach { d -> lines += "#7 our origin dir: ${d.relativeTo(dataDir)} · ${d.walkTopDown().filter { it.isFile }.sumOf { it.length() }} B" }
        return lines.joinToString("\n")
    }

    // MARK: camera (check 5): grant VIDEO_CAPTURE to this origin only, after the runtime prompt

    private inner class Chrome : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) {
            note("permission request ${request.resources.joinToString()} from ${request.origin}")
            val video = PermissionRequest.RESOURCE_VIDEO_CAPTURE
            if (request.origin.host != HOST || video !in request.resources) return request.deny()
            if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) return request.grant(arrayOf(video))
            grant?.deny()
            grant = request
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        if (requestCode != REQ_CAMERA) return super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val r = grant ?: return
        grant = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) r.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        else r.deny()
    }

    companion object {
        const val TAG = "wgLocalSpike"
        const val HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$HOST"
        private const val REQ_CAMERA = 0x5170

        /** Per process: a force-stop + relaunch is a new launch, reopening the activity is not. */
        val launch = UUID.randomUUID().toString().take(8)

        /**
         * ios LocalOrigin.csp(hosts) (= the server's cspPolicy, connect-src scoped) with the two BYOK
         * probe hosts as the egress list, the shape local mode will send once a key is set.
         */
        val CSP = listOf("api.openai.com", "api.anthropic.com").let { hosts ->
            val connect = (listOf("'self'") + hosts.flatMap { listOf("https://$it", "wss://$it") }).joinToString(" ")
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; worker-src 'self'; " +
                "media-src 'self'; connect-src $connect; object-src 'none'; base-uri 'none'; " +
                "frame-ancestors 'none'; form-action 'none'"
        }

        /** ios LocalOrigin.mime, without the charset (WebResourceResponse takes it apart). */
        fun mime(path: String) = when (path.substringAfterLast('.', "").lowercase()) {
            "html" -> "text/html"
            "js", "mjs" -> "text/javascript" // module scripts need a JS MIME
            "css" -> "text/css"
            "json" -> "application/json"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "txt" -> "text/plain"
            else -> "application/octet-stream"
        }
    }
}
