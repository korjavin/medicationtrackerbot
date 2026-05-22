package com.korjavin.medtracker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
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

        // recentLogTail returns the unified stdout+stderr ring tail (most
        // recent BACKEND_LOG_RING_SIZE lines), oldest first. Used by
        // NativeBridge.getBackendLogs() so the Settings → Backend logs
        // screen surfaces what's currently in the Go process's output for
        // bug-report copy/paste. Each line is prefixed with " " or "E " to
        // mark stderr; the prefix is included in the returned string.
        fun recentLogTail(): String = logRing.toList().joinToString("\n")

        // pid returns the embedded process's OS PID, or null if no process is
        // running. java.lang.Process.pid() is API 26+; on older devices we
        // return null rather than crash.
        fun pid(): Long? {
            val p = process ?: return null
            if (!p.isAlive) return null
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) p.pid() else null
        }

        // requestStop schedules a SIGTERM to the embedded Go process after
        // graceMs. If cancelStopRequest is called before the grace expires the
        // process keeps running. Activity backgrounding wires onStop here so
        // brief task-switches don't tear down the backend — only sustained
        // backgrounding does. The service itself stays in foreground state so
        // a follow-up requestRespawn can re-launch the binary quickly.
        fun requestStop(graceMs: Long = DEFAULT_STOP_GRACE_MS) {
            cancelStopRequest()
            stopJob = serviceScope.launch {
                delay(graceMs)
                val p = process
                if (p != null && p.isAlive) {
                    Log.i(TAG, "Grace expired; SIGTERM'ing Go process pid=${runCatching { p.pid() }.getOrNull()}")
                    try {
                        p.destroy()
                    } catch (e: Exception) {
                        Log.w(TAG, "process.destroy() threw: ${e.message}")
                    }
                }
                stopJob = null
            }
        }

        // cancelStopRequest cancels a pending grace timer scheduled by
        // requestStop. No-op if no timer is pending.
        fun cancelStopRequest() {
            stopJob?.cancel()
            stopJob = null
        }

        // requestRespawn re-launches the embedded Go binary if the current
        // process is dead. Returns true if a respawn was started, false if the
        // process is already alive. Callers should follow with awaitListening
        // to discover the new port. Safe to call from any thread; the actual
        // ProcessBuilder.start() happens synchronously on the caller's thread
        // (Activity uses Dispatchers.IO).
        fun requestRespawn(dbPath: String, sessionSecret: String): Boolean {
            if (process?.isAlive == true) return false
            // Reset the port handoff state so awaitListening sees the next
            // LISTENING line, not the stale value from the dead process.
            portRef.set(null)
            launchProcess(dbPath, sessionSecret)
            return true
        }

        // killForTest forcibly terminates the embedded process to simulate an
        // external SIGKILL (e.g. OS low-memory kill). Tests only.
        internal fun killForTest() {
            val p = process ?: return
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    p.destroyForcibly()
                } else {
                    p.destroy()
                }
            } catch (_: Throwable) {
            }
        }
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

    // Unified stdout + stderr tail used by the in-app "Backend logs" debug
    // screen (Settings → About → Backend logs). Bounded to the most recent
    // BACKEND_LOG_RING_SIZE lines; stderr entries are tagged with an "E "
    // prefix so the surfacing UI can distinguish channels at a glance.
    private val logRing = LinkedBlockingDeque<String>(BACKEND_LOG_RING_SIZE)

    // SupervisorJob so a failing child coroutine (e.g. the stop-grace timer)
    // doesn't cascade-cancel siblings. Cancelled in onDestroy.
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile private var stopJob: Job? = null

    private val runtimePrefs: SharedPreferences by lazy {
        getSharedPreferences(RUNTIME_PREFS, Context.MODE_PRIVATE)
    }

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
            val newPid = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) started.pid() else -1L
            persistRuntimeState(port = null, pid = newPid)
            startStdoutReader(started)
            startStderrReader(started)
            Log.i(TAG, "Spawned Go binary, pid=$newPid")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start Go binary", e)
            stderrLines.offer("spawn failed: ${e.message}")
        }
    }

    // persistRuntimeState writes the last-known port + pid to plain
    // SharedPreferences (not Encrypted — these are diagnostic and not secret).
    // OS-assigned ports usually mean the saved port is stale on the next
    // respawn, but the values are still useful in logcat when triaging a bug
    // report. Pass null for either field to leave it unchanged.
    private fun persistRuntimeState(port: Int?, pid: Long?) {
        val editor = runtimePrefs.edit()
        if (port != null) editor.putInt(KEY_LAST_PORT, port)
        if (pid != null) editor.putLong(KEY_LAST_PID, pid)
        editor.apply()
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
                                persistRuntimeState(port = parsed, pid = null)
                                // Non-blocking offer first so a fast reader
                                // wakes immediately; if no one is polling yet,
                                // the AtomicReference covers later callers.
                                portHandoff.offer(parsed)
                            }
                        }
                        pushLogLine("  $line")
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
                        pushLogLine("E $line")
                        Log.w(LOGCAT_TAG, line)
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "stderr reader died: ${e.message}")
            }
        }
    }

    // pushLogLine appends to the unified log ring, dropping oldest entries
    // when full. Both readers funnel through here so the tail is the
    // chronological merge of stdout + stderr (within reader-scheduling
    // jitter — close enough for human triage).
    private fun pushLogLine(prefixed: String) {
        while (!logRing.offer(prefixed)) {
            logRing.poll()
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
            serviceScope.cancel()
        } catch (_: Exception) {
        }
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
        internal const val BACKEND_LOG_RING_SIZE = 200

        private const val TAG = "GoServerService"
        private const val LOGCAT_TAG = "MedtrackerGo"

        // Default backgrounding grace window. Quick app-switches stay under
        // this and reuse the warm process; sustained backgrounding releases
        // it. Tests pass a shorter value to keep instrumentation runtimes
        // bounded.
        const val DEFAULT_STOP_GRACE_MS: Long = 60_000L

        // Plain (un-encrypted) SharedPreferences for diagnostic runtime state.
        // EncryptedSharedPreferences is reserved for the session secret.
        private const val RUNTIME_PREFS = "medtracker_runtime"
        private const val KEY_LAST_PORT = "last_port"
        private const val KEY_LAST_PID = "last_pid"

        // The contract main_mobile.go documents on stdout:
        //   LISTENING 127.0.0.1:<port>\n
        // Anything else is ordinary log output that the activity ignores.
        internal val LISTENING_PATTERN: Pattern =
            Pattern.compile("^LISTENING 127\\.0\\.0\\.1:(\\d+)$")
    }
}
