package com.korjavin.medtracker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.util.regex.Pattern
import kotlin.concurrent.thread

// GoServerService owns the embedded Go process. It is a started + bound
// foreground service:
//   - "Started" so Android keeps it alive past the activity going away.
//   - "Foreground" so Doze / background-restrictions don't kill it.
//   - "Bound" so MainActivity can call awaitListening() without recreating
//     the process every Activity recreate (config change, theme switch, etc.).
//
// The service reads the binary's stdout looking for exactly one line of the
// form "LISTENING 127.0.0.1:<port>" — that's the contract main_mobile.go
// guarantees. The port is published via portRef + a SynchronousQueue handoff;
// stderr is captured into a bounded ring-buffer (50 lines) so the activity
// can surface the tail on a startup failure.
class GoServerService : Service() {

    inner class LocalBinder : Binder() {
        // awaitListening blocks until the LISTENING line is seen on stdout, or
        // until the deadline expires. Returns null on timeout.
        fun awaitListening(timeoutMs: Long): Int? {
            portRef.get()?.let { return it }
            return try {
                portHandoff.poll(timeoutMs, TimeUnit.MILLISECONDS)
            } catch (_: InterruptedException) {
                null
            }
        }

        fun port(): Int? = portRef.get()
        fun isProcessAlive(): Boolean = process?.isAlive == true
        fun recentStderr(): String = stderrLines.toList().joinToString("\n")
    }

    private val binder = LocalBinder()

    @Volatile private var process: Process? = null
    private val portRef = AtomicReference<Int?>(null)
    // SynchronousQueue handoff: the stdout reader thread offers the port, the
    // activity thread takes it. Multiple takers are fine — the AtomicReference
    // short-circuit covers them. We pick SynchronousQueue (not a single-slot
    // BlockingQueue) so a late `poll` doesn't strand the value.
    private val portHandoff = SynchronousQueue<Int>()
    private val stderrLines = LinkedBlockingDeque<String>(STDERR_RING_SIZE)

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundWithNotification()
        if (process?.isAlive != true) {
            val dbPath = intent?.getStringExtra(EXTRA_DB_PATH)
                ?: "${filesDir.absolutePath}/medtracker.db"
            val secret = intent?.getStringExtra(EXTRA_SESSION_SECRET)
            if (secret.isNullOrBlank()) {
                Log.e(TAG, "session-secret extra missing; refusing to launch")
                stderrLines.offer("session-secret extra missing in startService intent")
                return START_NOT_STICKY
            }
            launchProcess(dbPath, secret)
        }
        return START_STICKY
    }

    private fun launchProcess(dbPath: String, sessionSecret: String) {
        val binary = File(applicationInfo.nativeLibraryDir, NATIVE_BINARY_NAME)
        if (!binary.exists()) {
            val msg = "native binary missing at ${binary.absolutePath}"
            Log.e(TAG, msg)
            stderrLines.offer(msg)
            return
        }
        if (!binary.canExecute()) {
            binary.setExecutable(true, true)
        }

        val pb = ProcessBuilder(
            binary.absolutePath,
            "-db", dbPath,
            "-port", "0",
            "-session-secret", sessionSecret,
        )
        pb.redirectErrorStream(false)
        try {
            val started = pb.start()
            process = started
            startStdoutReader(started)
            startStderrReader(started)
            Log.i(TAG, "Spawned Go binary, pid=${started.pid()}")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start Go binary", e)
            stderrLines.offer("spawn failed: ${e.message}")
        }
    }

    private fun startStdoutReader(p: Process) {
        thread(start = true, isDaemon = true, name = "GoStdoutReader") {
            try {
                BufferedReader(InputStreamReader(p.inputStream)).use { br ->
                    br.lineSequence().forEach { line ->
                        if (portRef.get() == null) {
                            val matcher = LISTENING_PATTERN.matcher(line)
                            if (matcher.matches()) {
                                val parsed = matcher.group(1)!!.toInt()
                                portRef.set(parsed)
                                // Non-blocking offer first so a fast reader
                                // wakes immediately; if no one is polling yet,
                                // the AtomicReference covers later callers.
                                portHandoff.offer(parsed)
                            }
                        }
                        Log.i(LOGCAT_TAG, line)
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "stdout reader died: ${e.message}")
            }
        }
    }

    private fun startStderrReader(p: Process) {
        thread(start = true, isDaemon = true, name = "GoStderrReader") {
            try {
                BufferedReader(InputStreamReader(p.errorStream)).use { br ->
                    br.lineSequence().forEach { line ->
                        // Bounded ring buffer: drop oldest when full so the
                        // tail is always the most recent N lines, which is
                        // what the error dialog wants.
                        while (!stderrLines.offer(line)) {
                            stderrLines.poll()
                        }
                        Log.w(LOGCAT_TAG, line)
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "stderr reader died: ${e.message}")
            }
        }
    }

    private fun startForegroundWithNotification() {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    "Backend service",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "Keeps the local medtracker backend alive while the app is in the recent-apps list."
                }
                nm.createNotificationChannel(channel)
            }
        }
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Medtracker running")
            .setContentText("Local backend active")
            .setOngoing(true)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .build()
        startForeground(NOTIFICATION_ID, notification)
    }

    override fun onDestroy() {
        try {
            process?.destroy()
        } catch (_: Exception) {
        }
        super.onDestroy()
    }

    companion object {
        const val EXTRA_DB_PATH = "db_path"
        const val EXTRA_SESSION_SECRET = "session_secret"

        // The "lib*.so" name is required by Android's automatic-extraction
        // rule for files under jniLibs/<abi>/. See docs/local-mode.md →
        // "Phase 2a build pipeline".
        private const val NATIVE_BINARY_NAME = "libmedtracker.so"

        private const val CHANNEL_ID = "medtracker_backend"
        private const val NOTIFICATION_ID = 9001
        private const val STDERR_RING_SIZE = 50

        private const val TAG = "GoServerService"
        private const val LOGCAT_TAG = "MedtrackerGo"

        // The contract main_mobile.go documents on stdout:
        //   LISTENING 127.0.0.1:<port>\n
        // Anything else is ordinary log output that the activity ignores.
        internal val LISTENING_PATTERN: Pattern =
            Pattern.compile("^LISTENING 127\\.0\\.0\\.1:(\\d+)$")
    }
}
