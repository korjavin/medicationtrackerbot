package com.lochyard.medtracker

import android.app.AlertDialog
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.util.Log
import androidx.lifecycle.lifecycleScope
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.getcapacitor.BridgeActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.TimeUnit

// MainActivity owns the WebView lifecycle and the bootstrap-injection sequence:
//   1. Start GoServerService (foreground service spawns the embedded binary).
//   2. Bind to the service so we can await the LISTENING port from its stdout.
//   3. Once the binary's /healthz responds, inject window.__MEDTRACKER_BOOTSTRAP__
//      into the WebView and navigate it to the localhost URL.
//   4. If the binary never reports a port (10s deadline), show an error dialog
//      with the last 50 lines of stderr and a retry button.
//
// Everything off the main thread runs on Dispatchers.IO; only the final
// WebView.loadUrl / evaluateJavascript call returns to Dispatchers.Main.
class MainActivity : BridgeActivity() {

    private var serviceBinder: GoServerService.LocalBinder? = null
    private var hasBootstrapped: Boolean = false

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as? GoServerService.LocalBinder ?: return
            serviceBinder = binder
            beginBootstrap(binder)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            serviceBinder = null
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val secret = obtainOrGenerateSessionSecret()
        val dbPath = "${filesDir.absolutePath}/medtracker.db"

        val intent = Intent(this, GoServerService::class.java).apply {
            putExtra(GoServerService.EXTRA_DB_PATH, dbPath)
            putExtra(GoServerService.EXTRA_SESSION_SECRET, secret)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
        bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
    }

    private fun beginBootstrap(binder: GoServerService.LocalBinder) {
        if (hasBootstrapped) return
        hasBootstrapped = true

        lifecycleScope.launch {
            val port = withContext(Dispatchers.IO) {
                binder.awaitListening(LISTENING_DEADLINE_MS)
            }
            if (port == null) {
                showStartupErrorDialog(binder.recentStderr())
                hasBootstrapped = false
                return@launch
            }
            val base = "http://127.0.0.1:$port"
            val healthy = withContext(Dispatchers.IO) {
                pollHealthz(base, HEALTHZ_DEADLINE_MS)
            }
            if (!healthy) {
                showStartupErrorDialog(
                    "Backend on $base never responded to /healthz within " +
                        "${HEALTHZ_DEADLINE_MS}ms.\n\n" + binder.recentStderr()
                )
                hasBootstrapped = false
                return@launch
            }
            injectBootstrapAndLoad(base)
        }
    }

    private fun injectBootstrapAndLoad(base: String) {
        val webView = bridge?.webView
        if (webView == null) {
            Log.w(TAG, "bridge.webView unavailable; cannot inject bootstrap")
            return
        }
        // The injection must run BEFORE the WebView navigates to the embedded
        // URL so the frontend's first fetch sees the global. evaluateJavascript
        // posts to the WebView's JS thread; the subsequent loadUrl is also
        // posted to the same thread, so order is preserved.
        val js = "window.__MEDTRACKER_BOOTSTRAP__ = { apiBase: " +
            jsonString(base) + " };"
        webView.evaluateJavascript(js, null)
        webView.loadUrl(base)
    }

    private fun showStartupErrorDialog(stderr: String) {
        runOnUiThread {
            AlertDialog.Builder(this)
                .setTitle("Backend startup failed")
                .setMessage(stderr.ifBlank { "The embedded backend did not respond within the startup deadline." })
                .setCancelable(false)
                .setPositiveButton("Retry") { _, _ -> recreate() }
                .show()
        }
    }

    private fun obtainOrGenerateSessionSecret(): String {
        val masterKey = MasterKey.Builder(this)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        val prefs = EncryptedSharedPreferences.create(
            this,
            "medtracker_secrets",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
        val existing = prefs.getString(KEY_SESSION_SECRET, null)
        if (existing != null && existing.length >= 32) {
            return existing
        }
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        val secret = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        prefs.edit().putString(KEY_SESSION_SECRET, secret).apply()
        return secret
    }

    override fun onDestroy() {
        super.onDestroy()
        try {
            unbindService(serviceConnection)
        } catch (_: IllegalArgumentException) {
            // not bound; ignore
        }
    }

    companion object {
        private const val TAG = "MedtrackerActivity"
        private const val KEY_SESSION_SECRET = "session_secret_v1"
        private const val LISTENING_DEADLINE_MS: Long = 10_000L
        private const val HEALTHZ_DEADLINE_MS: Long = 10_000L

        private val healthzClient: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(500, TimeUnit.MILLISECONDS)
            .readTimeout(500, TimeUnit.MILLISECONDS)
            .build()

        private fun pollHealthz(base: String, deadlineMs: Long): Boolean {
            val end = System.currentTimeMillis() + deadlineMs
            val req = Request.Builder().url("$base/healthz").build()
            while (System.currentTimeMillis() < end) {
                try {
                    healthzClient.newCall(req).execute().use { resp ->
                        if (resp.isSuccessful) return true
                    }
                } catch (_: IOException) {
                    // not up yet; retry after a short tick
                }
                Thread.sleep(100)
            }
            return false
        }

        // Escape a string so it can be embedded inside a JSON / JS string
        // literal without breaking the evaluateJavascript payload. We only
        // ever embed http://127.0.0.1:<port>, so the surface is tiny — but the
        // escape keeps the helper safe to reuse for richer bootstrap fields
        // later.
        private fun jsonString(s: String): String {
            val sb = StringBuilder(s.length + 2)
            sb.append('"')
            for (c in s) {
                when (c) {
                    '"' -> sb.append("\\\"")
                    '\\' -> sb.append("\\\\")
                    '\n' -> sb.append("\\n")
                    '\r' -> sb.append("\\r")
                    '\t' -> sb.append("\\t")
                    else -> if (c.code < 0x20) sb.append(String.format("\\u%04x", c.code)) else sb.append(c)
                }
            }
            sb.append('"')
            return sb.toString()
        }
    }
}
