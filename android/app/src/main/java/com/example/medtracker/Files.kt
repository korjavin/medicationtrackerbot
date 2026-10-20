package com.example.medtracker

import android.Manifest
import android.app.Activity
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Environment
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintManager
import android.provider.MediaStore
import android.util.Base64
import android.webkit.MimeTypeMap
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Downloads, print, the file chooser and camera/mic grants (bd med-nt9p.10),
 * twin of Downloads in ios/App/App.swift. WebView ignores <a download> of
 * blob:/data:, window.print() and <input type=file> on its own; assets/files.js
 * sends the first two over window.wgFiles, the WebChromeClient does the rest.
 * Only the account's own top-level page (accountHost) is answered or granted.
 */
class Files(private val activity: Activity, private val accountHost: () -> String?) {
    /** Temp files: a download until it is saved (or the next one), camera shots for the page to read. */
    private val downloads = File(activity.cacheDir, "downloads")
    private val photos = File(activity.cacheDir, "photos")
    private val authority = "${activity.packageName}.files"
    private var pendingSave: File? = null
    private var chooser: ValueCallback<Array<Uri>>? = null
    private var shot: File? = null
    private var afterCamera: (() -> Unit)? = null
    private var grant: PermissionRequest? = null
    private var printView: WebView? = null // held until its print job no longer needs it (the next print)

    init {
        // A file a killed app left behind (an unfinished save).
        downloads.deleteRecursively()
        photos.deleteRecursively()
    }

    fun install(w: WebView, rules: Set<String>) {
        w.webChromeClient = Chrome()
        w.setDownloadListener { url, ua, disposition, mime, _ -> download(url, ua, disposition, mime) }
        if (rules.isEmpty()) return
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(w, BRIDGE, rules) { view, message, origin, isMainFrame, _ ->
                if (isMainFrame && isAccount(origin)) onMessage(view, message.data)
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(w, activity.assets.open("files.js").bufferedReader().use { it.readText() }, rules)
        }
    }

    private fun isAccount(origin: Uri) = origin.scheme == "https" && origin.host?.lowercase().let { it != null && it == accountHost() }

    private fun onMessage(view: WebView, data: String?) {
        val msg = runCatching { JSONObject(data ?: "") }.getOrNull() ?: return
        when (msg.optString("op")) {
            "download" -> offer(msg.optString("name"), msg.optString("data"))
            "print" -> if (msg.has("html")) printHtml(msg.getString("html")) else print(view)
        }
    }

    // MARK: downloads

    /**
     * https attachments: the system download manager, never with the WebView's
     * cookies (it re-sends request headers across redirects, to any host).
     * blob:/data: come through files.js.
     */
    private fun download(url: String, ua: String?, disposition: String?, mime: String?) {
        if (!AccountUrl.isDownloadable(url)) {
            if (url.startsWith("http:", ignoreCase = true)) toast("This download isn't secure, so it was blocked.")
            return
        }
        val uri = Uri.parse(url)
        val req = DownloadManager.Request(uri)
            .setMimeType(mime)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, URLUtil.guessFileName(url, disposition, mime))
        ua?.let { req.addRequestHeader("User-Agent", it) }
        runCatching { activity.getSystemService(DownloadManager::class.java).enqueue(req) }
            .onFailure { toast("The download could not start.") }
    }

    /** A page download (a data: URL from files.js): temp file, then straight to the system file picker (the web's Backup-ready sheet owns the choice). */
    private fun offer(rawName: String, dataUrl: String) {
        // Every refusal says so (bd med-nvd4): a silent return looked like a stuck export.
        val bad = { toast("The download could not be saved.") }
        val comma = dataUrl.indexOf(',')
        val header = if (dataUrl.startsWith("data:") && comma > 0) dataUrl.substring(5, comma) else return bad()
        if (!header.endsWith(";base64")) return bad() // FileReader.readAsDataURL always is
        val bytes = runCatching { Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT) }.getOrNull() ?: return bad()
        val mime = header.substringBefore(';').ifBlank { "application/octet-stream" }
        val name = File(rawName).name.replace(Regex("[\\x00-\\x1f\\\\/:*?\"<>|]"), "_").ifBlank { "download" }
        // One download at a time: the previous one's file goes (a vault export holds secrets).
        downloads.deleteRecursively()
        val file = runCatching {
            File(File(downloads, UUID.randomUUID().toString()).apply { mkdirs() }, name).apply { writeBytes(bytes) }
        }.getOrElse { return toast("The download could not be saved.") }
        save(file, mime)
    }

    private fun save(file: File, mime: String) {
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime)
            .putExtra(Intent.EXTRA_TITLE, file.name)
        try {
            pendingSave = file
            activity.startActivityForResult(intent, REQ_SAVE)
        } catch (e: ActivityNotFoundException) {
            pendingSave = null
            file.parentFile?.deleteRecursively()
            toast("No app can save this file.")
        }
    }

    // MARK: print

    private fun print(view: WebView) {
        val name = view.title?.takeIf { it.isNotBlank() } ?: "Med Tracker"
        val inner = view.createPrintDocumentAdapter(name)
        // An offscreen print view lives exactly as long as its print job.
        val offscreen = view === printView
        val adapter = if (!offscreen) inner else object : PrintDocumentAdapter() {
            override fun onStart() = inner.onStart()
            override fun onLayout(
                oldAttributes: PrintAttributes?, newAttributes: PrintAttributes,
                cancellationSignal: CancellationSignal?, callback: PrintDocumentAdapter.LayoutResultCallback, extras: Bundle?,
            ) = inner.onLayout(oldAttributes, newAttributes, cancellationSignal, callback, extras)
            override fun onWrite(
                pages: Array<PageRange>, destination: ParcelFileDescriptor,
                cancellationSignal: CancellationSignal?, callback: PrintDocumentAdapter.WriteResultCallback,
            ) = inner.onWrite(pages, destination, cancellationSignal, callback)
            override fun onFinish() {
                inner.onFinish()
                releasePrintView(view)
            }
        }
        runCatching { activity.getSystemService(PrintManager::class.java).print(name, adapter, PrintAttributes.Builder().build()) }
            .onFailure {
                if (offscreen) releasePrintView(view) // never the app's own WebView
                toast("Printing isn't available.")
            }
    }

    private fun releasePrintView(view: WebView) {
        if (printView === view) printView = null
        view.destroy()
    }

    /** MainActivity.onDestroy: a print view still waiting for its job. */
    fun destroy() {
        printView?.let { releasePrintView(it) }
    }

    /**
     * print-doc.js's iframe document in its own offscreen WebView, as on iOS: no
     * app CSP, so its inline <style> applies and none of the app chrome prints.
     * No script and no network: the document is self-contained.
     */
    private fun printHtml(html: String) {
        val v = WebView(activity)
        printView = v
        v.settings.blockNetworkLoads = true
        v.webViewClient = object : WebViewClient() {
            private var printed = false
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
            override fun onPageFinished(view: WebView, url: String?) {
                if (printed || printView !== view) return
                printed = true
                print(view)
            }
        }
        v.loadDataWithBaseURL(null, "<!doctype html>$html", "text/html", "utf-8", null)
    }

    // MARK: file chooser, camera and mic

    private fun granted(permission: String) = activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private inner class Chrome : WebChromeClient() {
        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            chooser?.onReceiveValue(null)
            chooser = callback
            val types = params.acceptTypes.flatMap { it.split(',') }.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
            // Extensions (".json") become MIME types; one the phone doesn't know lifts the filter.
            val mimes = types.map { if (it.startsWith(".")) MimeTypeMap.getSingleton().getMimeTypeFromExtension(it.drop(1)) else it }
            val images = mimes.any { it != null && it.startsWith("image/") }
            val open = { openChooser(mimes.takeIf { m -> m.isNotEmpty() && m.all { it != null } }?.filterNotNull(), images, params.mode) }
            if (images && !granted(Manifest.permission.CAMERA)) {
                // Ask once; the chooser opens either way, with the camera only if allowed.
                afterCamera = open
                activity.requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
            } else {
                open()
            }
            return true
        }

        /** getUserMedia: camera and mic for the account origin only, once Android allows them. */
        override fun onPermissionRequest(request: PermissionRequest) {
            val wanted = request.resources.filter { it in MEDIA }
            if (!isAccount(request.origin) || wanted.isEmpty()) return request.deny()
            val missing = wanted.map { MEDIA.getValue(it) }.filterNot { granted(it) }
            if (missing.isEmpty()) return request.grant(wanted.toTypedArray())
            grant?.deny()
            grant = request
            activity.requestPermissions(missing.toTypedArray(), REQ_MEDIA)
        }

        override fun onPermissionRequestCanceled(request: PermissionRequest) {
            if (grant === request) grant = null
        }
    }

    private fun openChooser(mimes: List<String>?, images: Boolean, mode: Int) {
        val pick = Intent(Intent.ACTION_GET_CONTENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE)
        if (mimes != null) pick.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toTypedArray())
        val extras = mutableListOf<Intent>()
        shot = null
        if (images && granted(Manifest.permission.CAMERA)) {
            runCatching {
                val f = File(photos.apply { mkdirs() }, "photo-${System.currentTimeMillis()}.jpg")
                val uri = FileProvider.getUriForFile(activity, authority, f)
                extras += Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                    .putExtra(MediaStore.EXTRA_OUTPUT, uri)
                    .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    .apply { clipData = ClipData.newRawUri("", uri) }
                shot = f
            }
        }
        val intent = Intent.createChooser(pick, null).putExtra(Intent.EXTRA_INITIAL_INTENTS, extras.toTypedArray())
        try {
            activity.startActivityForResult(intent, REQ_CHOOSER)
        } catch (e: ActivityNotFoundException) {
            chooser?.onReceiveValue(null)
            chooser = null
        }
    }

    // MARK: activity results (MainActivity forwards them)

    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        when (requestCode) {
            REQ_SAVE -> {
                val file = pendingSave ?: return true
                pendingSave = null
                val uri = data?.data
                if (resultCode == Activity.RESULT_OK && uri != null) {
                    runCatching {
                        activity.contentResolver.openOutputStream(uri)!!.use { out -> file.inputStream().use { it.copyTo(out) } }
                    }.onSuccess { toast("Saved.") }.onFailure { toast("The file could not be saved.") }
                }
                file.parentFile?.deleteRecursively()
            }
            REQ_CHOOSER -> {
                val cb = chooser ?: return true
                chooser = null
                val photo = shot?.takeIf { it.length() > 0 }
                shot = null
                val clip = data?.clipData
                val picked = when {
                    resultCode != Activity.RESULT_OK -> null
                    clip != null && clip.itemCount > 0 -> Array(clip.itemCount) { clip.getItemAt(it).uri }
                    data?.data != null -> arrayOf(data.data!!)
                    // The camera writes EXTRA_OUTPUT and returns no data.
                    photo != null -> arrayOf(FileProvider.getUriForFile(activity, authority, photo))
                    else -> null
                }
                cb.onReceiveValue(picked)
            }
            else -> return false
        }
        return true
    }

    fun onRequestPermissionsResult(requestCode: Int): Boolean {
        when (requestCode) {
            REQ_CAMERA -> afterCamera?.also { afterCamera = null }?.invoke()
            REQ_MEDIA -> {
                val request = grant ?: return true
                grant = null
                val allowed = request.resources.filter { r -> MEDIA[r]?.let { granted(it) } == true }
                if (allowed.isEmpty()) request.deny() else request.grant(allowed.toTypedArray())
            }
            else -> return false
        }
        return true
    }

    private fun toast(text: String) = Toast.makeText(activity, text, Toast.LENGTH_SHORT).show()

    private companion object {
        /** window.wgFiles: downloads and print only; capability ops stay on wgNative. */
        const val BRIDGE = "wgFiles"
        const val REQ_SAVE = 0x5701
        const val REQ_CHOOSER = 0x5702
        const val REQ_CAMERA = 0x5703
        const val REQ_MEDIA = 0x5704
        val MEDIA = mapOf(
            PermissionRequest.RESOURCE_VIDEO_CAPTURE to Manifest.permission.CAMERA,
            PermissionRequest.RESOURCE_AUDIO_CAPTURE to Manifest.permission.RECORD_AUDIO,
        )
    }
}
