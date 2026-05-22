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
            val polled = try {
                portHandoff.poll(timeoutMs, TimeUnit.MILLISECONDS)
            } catch (_: InterruptedException) {
                null
            }
            // The stdout reader publishes via `portRef.set(...)` THEN a
            // non-blocking `portHandoff.offer(...)`. If the reader fires
            // between our portRef.get() above and our poll() registering as a
            // taker, the offer drops on the floor and we'd timeout despite the
            // value already being in portRef. Re-check on the way out.
            return polled ?: portRef.get()
        }

        fun port(): Int? = portRef.get()
        fun isProcessAlive(): Boolean = process?.isAlive == true
        fun recentStderr(): String = stderrLines.toList().joinToString("\n")

        // setUnexpectedExitListener registers a callback invoked by the
        // process reaper when the Go binary exits without an Activity- or
        // grace-timer-initiated destroy. This closes the foregrounded-crash
        // gap: if the binary dies while the user is actively interacting with
        // the WebView, the listener is the only signal that drives a respawn
        // — onStart fires only on visibility transitions and would leave the
        // app sitting on a dead backend until the user backgrounds it.
        // Passing null clears the callback. Best-effort delivery — the reaper
        // catches any throwable so a listener bug doesn't leak.
        fun setUnexpectedExitListener(listener: (() -> Unit)?) {
            unexpectedExitListener = listener
        }

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
        // a follow-up requestRespawn can re-launch the binary quickly; the
        // notification text flips to a "paused" message via
        // updateNotification so the system tray entry doesn't lie about the
        // backend's state.
        //
        // Cancel-vs-destroy is serialized via stopLock. delay() is cancellable
        // while suspended, but once it resumes the coroutine runs to
        // completion uninterrupted — Kotlin cancellation is cooperative and
        // there are no further suspension points between delay() and
        // p.destroy(). Without the lock, a cancelStopRequest racing past
        // delay's completion would observe `isProcessAlive()` true on the
        // main thread (destroy not yet fired), return without scheduling a
        // respawn, then the resumed coroutine would destroy the process as an
        // "expected" exit (suppressing the unexpected-exit listener) — leaving
        // the foreground WebView on a dead backend. The synchronized block
        // makes the destroy decision atomic with respect to cancel; whichever
        // side acquires the lock first wins, and the loser sees a consistent
        // state (stopJob cleared) on the way out.
        //
        // The destroy block ALSO waits for the process to actually exit before
        // releasing the lock. p.destroy() is asynchronous — it sends SIGTERM
        // and returns immediately, with p.isAlive remaining true until the
        // signal handler in the Go binary completes shutdown. Without the
        // post-destroy waitFor, a cancelStopRequest racing past the destroy
        // (but before the process actually dies) would acquire the lock, see
        // stopJob=null, no-op, then the foreground onStart would observe
        // isProcessAlive()=true and bail. The eventual exit then hits the
        // reaper with expectedExit already true, suppressing the listener —
        // same dead-WebView outcome as the pre-lock race. Waiting under the
        // lock forces cancel + isProcessAlive to see the post-destroy state.
        fun requestStop(graceMs: Long = DEFAULT_STOP_GRACE_MS) {
            cancelStopRequest()
            synchronized(stopLock) {
                val newJob = serviceScope.launch {
                    delay(graceMs)
                    synchronized(stopLock) {
                        // Re-check ownership under the lock. If a concurrent
                        // cancelStopRequest (or subsequent requestStop) ran
                        // first it cleared/replaced stopJob — drop the
                        // destroy.
                        if (stopJob !== coroutineContext[Job]) return@synchronized
                        val p = process
                        if (p != null && p.isAlive) {
                            Log.i(TAG, "Grace expired; SIGTERM'ing Go process pid=${runCatching { p.pid() }.getOrNull()}")
                            expectedExit.set(true)
                            try {
                                p.destroy()
                                if (!p.waitFor(DESTROY_WAIT_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                                    Log.w(TAG, "SIGTERM didn't yield within ${DESTROY_WAIT_TIMEOUT_MS}ms; escalating to destroyForcibly()")
                                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                        p.destroyForcibly()
                                        p.waitFor(DESTROY_WAIT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                                    }
                                }
                            } catch (e: Exception) {
                                Log.w(TAG, "process.destroy() threw: ${e.message}")
                            }
                            updateNotification(false)
                        }
                        stopJob = null
                    }
                }
                stopJob = newJob
            }
        }

        // cancelStopRequest cancels a pending grace timer scheduled by
        // requestStop. No-op if no timer is pending. Holds stopLock so the
        // grace coroutine's post-delay destroy block sees a consistent
        // stopJob state — see requestStop's comment.
        fun cancelStopRequest() {
            synchronized(stopLock) {
                stopJob?.cancel()
                stopJob = null
            }
        }

        // requestRespawn re-launches the embedded Go binary if the current
        // process is dead. Returns true if a respawn was started, false if the
        // process is already alive. Callers should follow with awaitListening
        // to discover the new port. Safe to call from any thread; the actual
        // ProcessBuilder.start() happens synchronously on the caller's thread
        // (Activity uses Dispatchers.IO).
        fun requestRespawn(dbPath: String, sessionSecret: String): Boolean {
            if (process?.isAlive == true) return false
            // launchProcess itself resets portRef + the diagnostic buffers
            // before spawning, so all entry points (initial startCommand,
            // requestRespawn, forceRelaunch) share the same cleanup contract.
            launchProcess(dbPath, sessionSecret)
            return true
        }

        // forceRelaunch kills any current process (alive or dead) and starts
        // a fresh one. Used by the Retry button when the previous binary
        // spawned but hung without producing LISTENING — requestRespawn
        // returns false for an alive process, so a simple "retry" path would
        // wait on the same hung process and loop the error dialog. This is
        // the explicit force path.
        fun forceRelaunch(dbPath: String, sessionSecret: String) {
            process?.let { p ->
                if (p.isAlive) {
                    expectedExit.set(true)
                    try {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            p.destroyForcibly()
                        } else {
                            p.destroy()
                        }
                        p.waitFor(2, TimeUnit.SECONDS)
                    } catch (_: Throwable) {
                        // best-effort; fall through to relaunch regardless
                    }
                }
            }
            // launchProcess resets portRef + diagnostic buffers; see comment
            // there.
            launchProcess(dbPath, sessionSecret)
        }

        // killForTest forcibly terminates the embedded process to simulate an
        // external SIGKILL (e.g. OS low-memory kill). Tests only — the reaper
        // will dispatch the unexpected-exit listener so tests can exercise
        // the foregrounded-crash path the same way the OS would.
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

    // stopLock serializes the grace-timer's destroy decision with
    // cancelStopRequest. See requestStop's javadoc for the race this closes.
    private val stopLock = Any()

    // expectedExit gates the reaper's unexpected-exit-listener dispatch.
    // Planned destroys (grace timer SIGTERM, forceRelaunch, onDestroy) set
    // this to true BEFORE calling Process.destroy/destroyForcibly so the
    // reaper treats the subsequent exit as expected. An unexpected drop to
    // false (the launch path resets it) is the signal the binary crashed
    // mid-run, which is what fires the listener.
    private val expectedExit = java.util.concurrent.atomic.AtomicBoolean(false)

    // processGen is bumped at the start of every spawn (launchProcess). Each
    // reaper captures the gen value its process was launched under and only
    // dispatches if it still matches the current value. This closes a race
    // where the old reaper would otherwise fire AFTER launchProcess has
    // reset expectedExit but BEFORE it has swapped `process` to the new
    // child — using process identity alone was vulnerable because the
    // reaper's `p === process` check would still hold and the just-reopened
    // expectedExit gate would let the stale reaper dispatch.
    private val processGen = java.util.concurrent.atomic.AtomicLong(0)

    @Volatile private var unexpectedExitListener: (() -> Unit)? = null

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
                // Tear down the foreground notification + service we just put
                // up so the user isn't left staring at "Medtracker running" for
                // a service that did nothing. The activity's awaitListening
                // will time out and surface the error dialog separately.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                } else {
                    @Suppress("DEPRECATION")
                    stopForeground(true)
                }
                stopSelf()
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

        // Reset the port handoff + diagnostic buffers before every spawn.
        // Without this, a relaunch path that doesn't clear portRef leaves the
        // stdout reader (which only parses LISTENING while portRef is null —
        // see startStdoutReader) ignoring the new process's LISTENING line and
        // awaitListening returning the previous dead process's port.
        // Centralized here so all entry points (onStartCommand after the
        // grace timer dropped the old process, requestRespawn, forceRelaunch)
        // share the contract. The diagnostic buffers are cleared too so a
        // startup-failure dialog on the respawned process doesn't display
        // lines from the prior dead process; a brief window exists where a
        // still-draining reader thread for the dead process can push one last
        // line after the clear — acceptable for diagnostic output.
        portRef.set(null)
        stderrLines.clear()
        logRing.clear()

        val pb = ProcessBuilder(
            binary.absolutePath,
            "-db", dbPath,
            "-port", "0",
            "-session-secret", sessionSecret,
        )
        pb.redirectErrorStream(false)
        try {
            // Bump the generation BEFORE resetting expectedExit. A still-
            // running reaper for the previous process now sees its captured
            // gen != processGen.get() and short-circuits — even if it would
            // otherwise have observed `p === process` (because we haven't
            // swapped `process` yet) and the freshly-opened expectedExit
            // gate.
            val gen = processGen.incrementAndGet()
            // Reset the "this exit was planned" flag before the spawn — any
            // subsequent destroy will flip it back to true before calling
            // Process.destroy, so the reaper's unexpected-exit dispatch only
            // fires for actual crashes.
            expectedExit.set(false)
            val started = pb.start()
            process = started
            val newPid = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) started.pid() else -1L
            startStdoutReader(started)
            startStderrReader(started)
            startProcessReaper(started, newPid, gen)
            updateNotification(true)
            Log.i(TAG, "Spawned Go binary, pid=$newPid")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start Go binary", e)
            stderrLines.offer("spawn failed: ${e.message}")
        }
    }

    // startProcessReaper drains the child's exit status so it doesn't sit in
    // /proc as a zombie after it dies. Without a waitFor() call, every
    // respawn cycle (grace-expired SIGTERM, low-memory SIGKILL, crash) leaks
    // one zombie into the app process's PCB until the OS reclaims everything
    // by killing the app. Daemon thread so it doesn't keep the JVM alive past
    // service teardown.
    //
    // The reaper also dispatches the unexpected-exit listener registered by
    // the Activity: when expectedExit is false (the launch path resets it on
    // every spawn; planned destroys flip it to true before calling
    // Process.destroy), an exit means the binary crashed or was killed
    // externally and the foregrounded UI needs to drive a respawn.
    //
    // The gen check filters stale reapers: a reaper for a process replaced
    // by a subsequent launchProcess sees gen != processGen.get() and
    // short-circuits. Process identity (`p === process`) is insufficient on
    // its own because launchProcess resets expectedExit BEFORE swapping
    // `process`, leaving a window where a stale reaper would see both
    // identity and the open gate. compareAndSet(false, true) on expectedExit
    // then handles the planned-vs-crashed distinction WITHIN a generation.
    private fun startProcessReaper(p: Process, pid: Long, gen: Long) {
        thread(start = true, isDaemon = true, name = "GoProcessReaper") {
            try {
                val exit = p.waitFor()
                Log.i(TAG, "Go binary pid=$pid exited, code=$exit")
                if (gen == processGen.get() && expectedExit.compareAndSet(false, true)) {
                    updateNotification(false)
                    val listener = unexpectedExitListener
                    if (listener != null) {
                        try {
                            listener.invoke()
                        } catch (e: Throwable) {
                            Log.w(TAG, "unexpected-exit listener threw: ${e.message}")
                        }
                    } else {
                        Log.w(TAG, "Go binary pid=$pid exited unexpectedly with no listener registered")
                    }
                }
            } catch (e: InterruptedException) {
                Log.w(TAG, "process reaper interrupted, pid=$pid: ${e.message}")
            }
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
                                // awaitListening's re-check of portRef covers it.
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
        startForeground(NOTIFICATION_ID, buildNotification(active = process?.isAlive == true))
    }

    // updateNotification refreshes the foreground notification text to reflect
    // the embedded process's actual liveness. Called from launchProcess (true)
    // and from any destroy path (false). The service stays foreground either
    // way so the next requestRespawn doesn't pay the notification-channel
    // setup cost again — only the user-visible content text changes.
    private fun updateNotification(active: Boolean) {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        nm.notify(NOTIFICATION_ID, buildNotification(active))
    }

    private fun buildNotification(active: Boolean): Notification {
        val text = if (active) "Local backend active" else "Local backend paused"
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Medtracker")
            .setContentText(text)
            .setOngoing(true)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .build()
    }

    // onTaskRemoved fires when the user swipes the app off the recent-apps
    // list. The Phase 2a plan calls for the service to "stop cleanly" in
    // that case — the user has explicitly dismissed the app, so the
    // persistent "Medtracker" notification has no reason to linger. We
    // SIGTERM the binary (marking the exit as expected so the reaper doesn't
    // try to respawn), remove the foreground notification, and stop the
    // service. A subsequent app launch starts a fresh service via the
    // Activity's onCreate path.
    override fun onTaskRemoved(rootIntent: Intent?) {
        Log.i(TAG, "Task removed; tearing down embedded backend + service")
        unexpectedExitListener = null
        process?.let { p ->
            if (p.isAlive) {
                expectedExit.set(true)
                try {
                    p.destroy()
                } catch (_: Throwable) {
                }
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        unexpectedExitListener = null
        expectedExit.set(true)
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

        // Max time the grace coroutine waits for the SIGTERM'd Go binary to
        // actually exit before releasing stopLock. The binary's signal
        // handler completes in well under 100ms in practice; 2s gives ample
        // headroom while keeping the worst-case main-thread block (a
        // cancelStopRequest racing the grace expiry) below the ANR threshold.
        // If the process is still alive at the deadline we fall through to
        // destroyForcibly() on API 26+.
        private const val DESTROY_WAIT_TIMEOUT_MS: Long = 2_000L

        // The contract main_mobile.go documents on stdout:
        //   LISTENING 127.0.0.1:<port>\n
        // Anything else is ordinary log output that the activity ignores.
        internal val LISTENING_PATTERN: Pattern =
            Pattern.compile("^LISTENING 127\\.0\\.0\\.1:(\\d+)$")
    }
}
