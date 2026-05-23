package com.lochyard.medtracker

import android.app.AlertDialog
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.ApplicationInfo
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
    private var reconnectDialog: AlertDialog? = null
    private var devServerMode: Boolean = false
    // Tracks the onStart/onStop boundary. The unexpected-exit listener
    // observes this so a backend crash during the post-onStop grace window
    // doesn't drive a respawn + WebView reload + dialog show against a
    // backgrounded activity. The next onStart already handles that path
    // (it sees a dead process and calls triggerRespawnAndReload itself).
    private var isStarted: Boolean = false

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as? GoServerService.LocalBinder ?: return
            serviceBinder = binder
            // Listener fires from the GoProcessReaper thread when the Go
            // binary exits without an Activity- or grace-timer-initiated
            // destroy. Without this, a crash while the activity is
            // foregrounded would leave a dead backend until the user
            // backgrounds + foregrounds the app.
            binder.setUnexpectedExitListener {
                runOnUiThread { onBackendUnexpectedlyExited() }
            }
            // Mirror onStart's cancel-pending-stop + alive-or-respawn logic
            // here too. The race we close: Activity recreate (config change)
            // while a prior onStop left a grace-timer SIGTERM pending —
            // onStart already ran with serviceBinder=null and returned at the
            // "bind in progress" guard, so without canceling here the grace
            // can fire mid-bootstrap and SIGTERM the backend while the
            // WebView is being wired up. If the grace already expired before
            // the bind completed (process dead), drive a respawn instead of
            // bootstrapping into a corpse.
            if (!devServerMode && isStarted) {
                binder.cancelStopRequest()
                if (!binder.isProcessAlive()) {
                    triggerRespawnAndReload(binder)
                    return
                }
            }
            beginBootstrap(binder)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            serviceBinder = null
        }
    }

    // onBackendUnexpectedlyExited is the foregrounded-crash recovery hook.
    // The unexpected-exit listener registered above invokes it on the main
    // thread when the Go binary dies on its own (crash, panic, OS SIGKILL
    // while the activity is visible). We delegate to the same respawn path
    // the onStart-after-background uses so the user sees the same
    // "Reconnecting…" splash and then the fresh WebView.
    private fun onBackendUnexpectedlyExited() {
        if (devServerMode) return
        if (isFinishing || isDestroyed) return
        // Only respawn while the activity is between onStart and onStop. If
        // the backend dies during the post-onStop grace window (crash before
        // the grace SIGTERM fires), let the next onStart do the respawn —
        // showing a "Reconnecting…" dialog and loading the WebView from a
        // backgrounded activity is wasted work and against the user's
        // intent in backgrounding.
        if (!isStarted) return
        val binder = serviceBinder ?: return
        if (binder.isProcessAlive()) return
        Log.w(TAG, "Backend exited unexpectedly while activity was foregrounded; respawning")
        triggerRespawnAndReload(binder)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Dev-server fallback: when capacitor.config.ts sets server.url to a
        // remote backend (the Phase 1 spike workflow), skip the embedded-binary
        // spawn entirely and let Capacitor's BridgeActivity load from
        // server.url as it did before Phase 2a. The flag is driven by the
        // Capacitor runtime config so flipping between embedded and dev-server
        // modes is a single edit to capacitor.config.ts — no overlay code
        // change required.
        val configuredServerUrl = bridge?.config?.serverUrl
        if (!configuredServerUrl.isNullOrEmpty()) {
            devServerMode = true
            Log.i(TAG, "server.url=$configuredServerUrl set; skipping embedded-binary spawn (dev-server fallback)")
            return
        }

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
        // addJavascriptInterface persists across WebView navigations, unlike
        // evaluateJavascript which only modifies the current document. The
        // bootstrap shim at the top of index.html mirrors the native
        // apiBase() into window.__MEDTRACKER_BOOTSTRAP__ so the documented
        // frontend protocol stays unchanged. Re-registering on respawn
        // replaces the prior binding (Android keeps the latest reference for
        // a given name).
        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        val nativeBridge = NativeBridge(base, { serviceBinder }, debuggable)
        webView.addJavascriptInterface(nativeBridge, NativeBridge.JS_NAME)
        webView.loadUrl(base)
    }

    private fun showStartupErrorDialog(stderr: String) {
        runOnUiThread {
            // lifecycleScope.launch can fire after the activity is stopped or
            // finishing; AlertDialog.show() against a dead window token throws
            // BadTokenException. Best-effort: skip the dialog rather than crash.
            if (isFinishing || isDestroyed) return@runOnUiThread
            AlertDialog.Builder(this)
                .setTitle("Backend startup failed")
                .setMessage(stderr.ifBlank { "The embedded backend did not respond within the startup deadline." })
                .setCancelable(false)
                .setPositiveButton("Retry") { _, _ -> retryStartup() }
                .show()
        }
    }

    // retryStartup is the "user tapped Retry on the startup-error dialog"
    // path. The prior binary may be hung-but-alive (spawned, never produced
    // LISTENING) — recreate() alone would re-bind the same service and skip
    // launchProcess (process.isAlive == true), leaving the user stuck. Force
    // a fresh spawn through the binder and re-enter the bootstrap latch.
    private fun retryStartup() {
        val binder = serviceBinder
        if (binder == null) {
            // No bound service yet — fall back to a full activity recreate so
            // the bind sequence runs from scratch.
            recreate()
            return
        }
        val secret = obtainOrGenerateSessionSecret()
        val dbPath = "${filesDir.absolutePath}/medtracker.db"
        lifecycleScope.launch {
            withContext(Dispatchers.IO) { binder.forceRelaunch(dbPath, secret) }
            hasBootstrapped = false
            beginBootstrap(binder)
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

    // onStart fires on initial launch (after onCreate) and on every
    // return-to-foreground. We cancel any pending grace-period stop the
    // service may have scheduled in onStop, and — if the process died while
    // we were backgrounded (grace expired or OS killed it) — trigger a
    // respawn + WebView reload.
    override fun onStart() {
        super.onStart()
        isStarted = true
        if (devServerMode) return
        val binder = serviceBinder ?: return // initial launch: bind in progress; onServiceConnected handles it
        binder.cancelStopRequest()
        if (binder.isProcessAlive()) return
        triggerRespawnAndReload(binder)
    }

    // onStop fires when the activity stops being visible (user backgrounded
    // the app or moved on to another task). We schedule a SIGTERM to the Go
    // process after STOP_GRACE_MS so brief task-switches stay warm but
    // sustained backgrounding releases the process. The service itself stays
    // bound + foreground so the next onStart can respawn quickly.
    override fun onStop() {
        super.onStop()
        isStarted = false
        if (devServerMode) return
        serviceBinder?.requestStop(STOP_GRACE_MS)
    }

    // triggerRespawnAndReload is the "process died, bring it back" path.
    // Spawns the binary off the main thread (Dispatchers.IO), polls /healthz,
    // then returns to Dispatchers.Main for the WebView load. A non-cancelable
    // "Reconnecting…" dialog blocks user interaction until the new backend is
    // healthy.
    private fun triggerRespawnAndReload(binder: GoServerService.LocalBinder) {
        val secret = obtainOrGenerateSessionSecret()
        val dbPath = "${filesDir.absolutePath}/medtracker.db"
        showReconnectingDialog()
        lifecycleScope.launch {
            val respawned = withContext(Dispatchers.IO) {
                binder.requestRespawn(dbPath, secret)
            }
            if (!respawned) {
                // Process became alive between the alive-check and the respawn
                // call — nothing to do. Dismiss the splash and trust the
                // previously-loaded WebView.
                dismissReconnectDialog()
                return@launch
            }
            val port = withContext(Dispatchers.IO) {
                binder.awaitListening(LISTENING_DEADLINE_MS)
            }
            if (port == null) {
                dismissReconnectDialog()
                showStartupErrorDialog(binder.recentStderr())
                return@launch
            }
            val base = "http://127.0.0.1:$port"
            val healthy = withContext(Dispatchers.IO) {
                pollHealthz(base, HEALTHZ_DEADLINE_MS)
            }
            if (!healthy) {
                dismissReconnectDialog()
                showStartupErrorDialog(
                    "Backend on $base never responded to /healthz within " +
                        "${HEALTHZ_DEADLINE_MS}ms.\n\n" + binder.recentStderr()
                )
                return@launch
            }
            injectBootstrapAndLoad(base)
            dismissReconnectDialog()
        }
    }

    private fun showReconnectingDialog() {
        if (reconnectDialog?.isShowing == true) return
        // Same window-token concern as showStartupErrorDialog — bail before
        // touching AlertDialog.show() if the activity is on its way out.
        if (isFinishing || isDestroyed) return
        reconnectDialog = AlertDialog.Builder(this)
            .setTitle("Reconnecting…")
            .setMessage("Restarting the local backend.")
            .setCancelable(false)
            .create()
            .also { it.show() }
    }

    private fun dismissReconnectDialog() {
        try {
            reconnectDialog?.dismiss()
        } catch (_: Exception) {
            // Activity may be finishing; best-effort dismiss.
        }
        reconnectDialog = null
    }

    override fun onDestroy() {
        super.onDestroy()
        dismissReconnectDialog()
        if (devServerMode) return
        // Clear the listener BEFORE unbinding so a death racing the unbind
        // can't dispatch into a finishing activity (the runOnUiThread
        // callback would post to a stopped Looper and silently drop).
        serviceBinder?.setUnexpectedExitListener(null)
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

        // Grace window between the activity going into the background and the
        // embedded backend being SIGTERM'd. Long enough that a brief
        // task-switch (recent-apps swipe, opening a notification) doesn't tear
        // the backend down; short enough that a phone left idle releases the
        // resources. 60s matches the default in GoServerService.
        private const val STOP_GRACE_MS: Long = GoServerService.DEFAULT_STOP_GRACE_MS

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

    }
}
