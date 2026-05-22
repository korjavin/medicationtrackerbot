package com.korjavin.medtracker

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

// Instrumentation suite for GoServerService. Verifies the embedded Go binary
// can be spawned from nativeLibraryDir, its LISTENING line is parsed, and
// /healthz responds — i.e. the full Android-side bootstrap path.
//
// Each test starts the service fresh (with a temp DB under the app's cache
// dir) and waits for the bound LocalBinder's awaitListening() to return a
// port, then stops the service. The 15s deadlines are generous; on a modern
// emulator the spawn + listen + /healthz handshake completes in ~300ms.
@RunWith(AndroidJUnit4::class)
class GoServerServiceTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val activeConnections = mutableListOf<ServiceConnection>()
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(2, TimeUnit.SECONDS)
        .build()

    @After
    fun tearDown() {
        activeConnections.forEach { conn ->
            try {
                context.unbindService(conn)
            } catch (_: IllegalArgumentException) {
            }
        }
        activeConnections.clear()
        context.stopService(Intent(context, GoServerService::class.java))
    }

    // (a) service starts and reaches /healthz on the port it reports.
    @Test
    fun serviceSpawnsBinaryAndHealthzResponds() {
        val binder = bindAndStartService()
        val port = binder.awaitListening(15_000L)
        assertNotNull("expected LISTENING port within 15s, got null", port)
        assertTrue("port out of range: $port", port!! in 1..65535)

        // /healthz roundtrip
        val req = Request.Builder().url("http://127.0.0.1:$port/healthz").build()
        var responded = false
        val deadline = System.currentTimeMillis() + 5_000L
        while (System.currentTimeMillis() < deadline) {
            try {
                httpClient.newCall(req).execute().use { resp ->
                    if (resp.isSuccessful) {
                        responded = true
                        return@use
                    }
                }
            } catch (_: Exception) {
                Thread.sleep(50)
            }
            if (responded) break
        }
        assertTrue("/healthz did not respond OK within 5s", responded)
    }

    // (b) port is parseable from the LISTENING line.
    @Test
    fun listeningLinePatternMatchesExpectedFormat() {
        val good = "LISTENING 127.0.0.1:54321"
        val matcher = GoServerService.LISTENING_PATTERN.matcher(good)
        assertTrue("should match: $good", matcher.matches())
        assertTrue(matcher.group(1)!!.toInt() == 54321)

        // Should reject lines we don't intend the activity to grab.
        for (bad in listOf(
            "LISTENING 0.0.0.0:54321",
            "LISTENING 127.0.0.1:abc",
            " LISTENING 127.0.0.1:80",
            "info: server starting",
        )) {
            assertFalse("should not match: $bad", GoServerService.LISTENING_PATTERN.matcher(bad).matches())
        }
    }

    // (c) deadline-exceeded path: awaitListening returns null when no LISTENING
    // line is produced. We exercise this by binding to a freshly-started
    // service WITHOUT supplying a session-secret extra — the service refuses
    // to launch and the LISTENING line is never written.
    @Test
    fun missingSessionSecretYieldsNullPort() {
        val binder = bindAndStartService(includeSessionSecret = false)
        val port = binder.awaitListening(2_000L)
        assertNull("expected null port (no LISTENING line), got $port", port)
        assertFalse("process should not be alive", binder.isProcessAlive())
        assertTrue(
            "stderr ring should mention session-secret",
            binder.recentStderr().contains("session-secret"),
        )
    }

    // (d) The native binary must be present in nativeLibraryDir for any of
    // this to work. This guards the build pipeline: a packaging regression
    // that drops jniLibs/<abi>/libmedtracker.so fails this test before the
    // service spawn path does.
    @Test
    fun nativeBinaryExistsInNativeLibraryDir() {
        val binary = File(context.applicationInfo.nativeLibraryDir, "libmedtracker.so")
        assertTrue(
            "libmedtracker.so missing from ${context.applicationInfo.nativeLibraryDir}; check scripts/build-android-binaries.sh ran",
            binary.exists(),
        )
        assertTrue("libmedtracker.so should be executable", binary.canExecute())
    }

    // (Task 4 / a) Backgrounding then immediately foregrounding within the
    // grace window must reuse the same Go process. We simulate this by
    // calling requestStop with a long grace, immediately cancelling it, and
    // asserting the PID is unchanged and the process is still alive.
    @Test
    fun backgroundThenImmediateForegroundReusesProcess() {
        val binder = bindAndStartService()
        val originalPort = binder.awaitListening(15_000L)
        assertNotNull("expected initial LISTENING port", originalPort)
        val originalPid = binder.pid()
        assertNotNull("expected pid for live process", originalPid)

        binder.requestStop(60_000L) // long grace; we'll cancel right away
        binder.cancelStopRequest()

        // Sleep briefly to let any racing destroy() land — if cancelStopRequest
        // worked, this is a no-op. 500ms is generous.
        Thread.sleep(500L)

        assertTrue("process should still be alive after cancelStopRequest", binder.isProcessAlive())
        assertEquals("pid should be unchanged after cancelled stop", originalPid, binder.pid())
        assertEquals("port should be unchanged after cancelled stop", originalPort, binder.port())
    }

    // (Task 4 / b) Backgrounding then waiting past the grace window must
    // SIGTERM the Go process. A subsequent respawn replaces it with a fresh
    // pid + port. The test uses a 200ms grace so it completes in ~5s instead
    // of the production 60s.
    @Test
    fun backgroundThenWaitForGraceWindowRespawns() {
        val dbPath = File(context.cacheDir, "instrumentation-${System.nanoTime()}.db").absolutePath
        val secret = randomSessionSecret()
        val binder = bindAndStartService(dbPath = dbPath, sessionSecret = secret)
        val originalPort = binder.awaitListening(15_000L)
        assertNotNull("expected initial LISTENING port", originalPort)
        val originalPid = binder.pid()
        assertNotNull("expected pid for live process", originalPid)

        binder.requestStop(graceMs = 200L)

        // Wait up to 5s for the grace to expire and the OS to mark the process
        // as not-alive. The Go binary handles SIGTERM cleanly and exits within
        // a fraction of a second.
        val deadline = System.currentTimeMillis() + 5_000L
        while (System.currentTimeMillis() < deadline && binder.isProcessAlive()) {
            Thread.sleep(50L)
        }
        assertFalse("process should be dead after grace expired", binder.isProcessAlive())

        // Respawn: new process, new port (most likely — OS-assigned).
        val respawned = binder.requestRespawn(dbPath, secret)
        assertTrue("requestRespawn should return true when process is dead", respawned)
        val newPort = binder.awaitListening(15_000L)
        assertNotNull("expected new LISTENING port after respawn", newPort)
        assertTrue("process should be alive after respawn", binder.isProcessAlive())

        val newPid = binder.pid()
        assertNotNull("expected pid for respawned process", newPid)
        assertTrue("respawn should yield a different pid; old=$originalPid new=$newPid", originalPid != newPid)
    }

    // (Task 4 / c) An external SIGKILL (simulated via destroyForcibly) must
    // leave the service in a state where a follow-up requestRespawn brings a
    // fresh process up. This is the OS-low-memory-kill recovery path.
    @Test
    fun killProcessThenRespawnYieldsNewPid() {
        val dbPath = File(context.cacheDir, "instrumentation-${System.nanoTime()}.db").absolutePath
        val secret = randomSessionSecret()
        val binder = bindAndStartService(dbPath = dbPath, sessionSecret = secret)
        val originalPort = binder.awaitListening(15_000L)
        assertNotNull("expected initial LISTENING port", originalPort)
        val originalPid = binder.pid()
        assertNotNull("expected pid for live process", originalPid)

        binder.killForTest()

        val deadline = System.currentTimeMillis() + 5_000L
        while (System.currentTimeMillis() < deadline && binder.isProcessAlive()) {
            Thread.sleep(50L)
        }
        assertFalse("process should be dead after killForTest", binder.isProcessAlive())

        val respawned = binder.requestRespawn(dbPath, secret)
        assertTrue("requestRespawn should return true when process is dead", respawned)
        val newPort = binder.awaitListening(15_000L)
        assertNotNull("expected new LISTENING port after respawn-from-kill", newPort)

        val newPid = binder.pid()
        assertNotNull("expected pid for respawned process", newPid)
        assertTrue("respawn should yield a different pid; old=$originalPid new=$newPid", originalPid != newPid)
    }

    // (Task 5) The unified log ring captures both stdout and stderr from the
    // spawned binary. By the time /healthz responds, the LISTENING line is in
    // the ring and the chronological merge of subsequent output is observable
    // by NativeBridge.getBackendLogs(). We assert the ring is non-empty and
    // contains the LISTENING line we know the binary always emits.
    @Test
    fun backendLogRingCapturesListeningLine() {
        val binder = bindAndStartService()
        val port = binder.awaitListening(15_000L)
        assertNotNull("expected LISTENING port", port)

        // Give the stdout reader a brief moment after handoff to drain the
        // pipe; on emulator hardware this is sub-50ms but a generous wait
        // keeps the test non-flaky.
        Thread.sleep(200L)

        val tail = binder.recentLogTail()
        assertTrue("log tail should be non-empty after healthy boot, got=\"$tail\"", tail.isNotEmpty())
        assertTrue(
            "log tail should contain the LISTENING line, got=\"$tail\"",
            tail.contains("LISTENING 127.0.0.1:$port"),
        )
    }

    // (Retry-deadlock guard) forceRelaunch must kill an alive process and
    // start a fresh one, unlike requestRespawn which no-ops when the process
    // is alive. This is the Retry-button path when the previous spawn hung
    // without producing LISTENING.
    @Test
    fun forceRelaunchOnAliveProcessYieldsNewPid() {
        val dbPath = File(context.cacheDir, "instrumentation-${System.nanoTime()}.db").absolutePath
        val secret = randomSessionSecret()
        val binder = bindAndStartService(dbPath = dbPath, sessionSecret = secret)
        val originalPort = binder.awaitListening(15_000L)
        assertNotNull("expected initial LISTENING port", originalPort)
        val originalPid = binder.pid()
        assertNotNull("expected pid for live process", originalPid)
        assertTrue("process should be alive before forceRelaunch", binder.isProcessAlive())

        binder.forceRelaunch(dbPath, secret)

        val newPort = binder.awaitListening(15_000L)
        assertNotNull("expected new LISTENING port after forceRelaunch", newPort)
        assertTrue("process should be alive after forceRelaunch", binder.isProcessAlive())
        val newPid = binder.pid()
        assertNotNull("expected pid for relaunched process", newPid)
        assertTrue(
            "forceRelaunch on alive process should yield a different pid; old=$originalPid new=$newPid",
            originalPid != newPid,
        )
    }

    // requestRespawn must be a no-op when the current process is alive. Guards
    // against accidentally killing a healthy backend on a redundant onStart
    // signal (e.g. config-change Activity recreate that fires onStart twice
    // back-to-back with no onStop in between).
    @Test
    fun requestRespawnOnAliveProcessIsNoOp() {
        val binder = bindAndStartService()
        val originalPort = binder.awaitListening(15_000L)
        assertNotNull("expected initial LISTENING port", originalPort)
        val originalPid = binder.pid()

        val respawned = binder.requestRespawn(
            File(context.cacheDir, "noop-${System.nanoTime()}.db").absolutePath,
            randomSessionSecret(),
        )
        assertFalse("requestRespawn must return false when process is alive", respawned)
        assertEquals("pid should be unchanged after no-op respawn", originalPid, binder.pid())
        assertEquals("port should be unchanged after no-op respawn", originalPort, binder.port())
    }

    // (Finding 2) Foregrounded-crash recovery: the unexpected-exit listener
    // must fire when the binary dies without an Activity-initiated destroy.
    // We simulate the crash with killForTest() (destroyForcibly), which is
    // the same OS-level SIGKILL signal the low-memory killer would deliver.
    @Test
    fun unexpectedExitFiresRegisteredListener() {
        val binder = bindAndStartService()
        val port = binder.awaitListening(15_000L)
        assertNotNull("expected initial LISTENING port", port)
        assertTrue("process should be alive before kill", binder.isProcessAlive())

        val fired = CountDownLatch(1)
        binder.setUnexpectedExitListener { fired.countDown() }

        binder.killForTest()

        assertTrue(
            "unexpected-exit listener should fire within 5s of process death",
            fired.await(5, TimeUnit.SECONDS),
        )
        assertFalse("process should be dead", binder.isProcessAlive())
    }

    // (Finding 2) Planned destroys (requestStop → SIGTERM after grace) must
    // NOT fire the unexpected-exit listener; otherwise the activity would
    // try to respawn the backend exactly when the user intended to release
    // it. We assert no listener invocation within 2s of the grace expiry.
    @Test
    fun expectedExitDoesNotFireListener() {
        val binder = bindAndStartService()
        val port = binder.awaitListening(15_000L)
        assertNotNull("expected initial LISTENING port", port)

        val fired = CountDownLatch(1)
        binder.setUnexpectedExitListener { fired.countDown() }

        binder.requestStop(graceMs = 200L)

        // Wait past the grace + a safety margin. The listener must NOT fire
        // because the destroy was planned.
        val firedDuringGrace = fired.await(2, TimeUnit.SECONDS)
        assertFalse("listener must not fire for planned destroys", firedDuringGrace)
    }

    // (Finding 1) onStartCommand path: if the service stays alive after the
    // grace timer killed the process, a follow-up startForegroundService (e.g.
    // Android destroying + recreating the Activity) must clear portRef so the
    // new spawn's LISTENING line is parsed. Without the launchProcess-level
    // reset, the stdout reader (gated on portRef == null) would ignore the
    // new port and awaitListening would return the stale value from the dead
    // process.
    @Test
    fun startCommandRespawnAfterDeathPicksUpNewPort() {
        val dbPath = File(context.cacheDir, "instrumentation-${System.nanoTime()}.db").absolutePath
        val secret = randomSessionSecret()
        val binder = bindAndStartService(dbPath = dbPath, sessionSecret = secret)
        val originalPort = binder.awaitListening(15_000L)
        assertNotNull("expected initial LISTENING port", originalPort)

        // Kill the process out from under the service to simulate either a
        // grace-timer SIGTERM or an OS-low-memory SIGKILL. portRef now holds
        // the dead process's port.
        binder.killForTest()
        val deadline = System.currentTimeMillis() + 5_000L
        while (System.currentTimeMillis() < deadline && binder.isProcessAlive()) {
            Thread.sleep(50L)
        }
        assertFalse("process should be dead after killForTest", binder.isProcessAlive())

        // Re-deliver startForegroundService with the same db + secret. This
        // exercises GoServerService.onStartCommand's launchProcess branch —
        // the path that previously did not clear portRef.
        val intent = Intent(context, GoServerService::class.java).apply {
            putExtra(GoServerService.EXTRA_DB_PATH, dbPath)
            putExtra(GoServerService.EXTRA_SESSION_SECRET, secret)
        }
        context.startForegroundService(intent)

        // Spin awaitListening until the port changes — the new process should
        // publish its LISTENING line and the stdout reader should update
        // portRef. If the bug regresses, awaitListening returns the stale
        // originalPort immediately.
        val pollDeadline = System.currentTimeMillis() + 15_000L
        var observedPort: Int? = binder.port()
        while (System.currentTimeMillis() < pollDeadline && observedPort == originalPort) {
            Thread.sleep(100L)
            observedPort = binder.port()
        }
        assertNotNull("expected new LISTENING port after startForegroundService re-entry", observedPort)
        assertTrue(
            "startForegroundService re-entry must surface the new process's port; old=$originalPort new=$observedPort",
            observedPort != originalPort,
        )
        assertTrue("process should be alive after re-entry", binder.isProcessAlive())
    }

    // (Finding 3) forceRelaunch on an alive process must not fire the
    // unexpected-exit listener. The old reaper races with launchProcess's
    // expectedExit reset; without the process-generation guard, the reaper
    // could observe `p === process` (process not yet swapped) AND the
    // freshly-opened expectedExit gate and dispatch the listener — which
    // the Activity would interpret as a foregrounded crash and drive a
    // duplicate triggerRespawnAndReload() concurrent with the in-progress
    // forceRelaunch spawn.
    @Test
    fun forceRelaunchDoesNotFireUnexpectedExitListener() {
        val dbPath = File(context.cacheDir, "instrumentation-${System.nanoTime()}.db").absolutePath
        val secret = randomSessionSecret()
        val binder = bindAndStartService(dbPath = dbPath, sessionSecret = secret)
        assertNotNull("expected initial LISTENING port", binder.awaitListening(15_000L))

        val fired = java.util.concurrent.atomic.AtomicInteger(0)
        binder.setUnexpectedExitListener { fired.incrementAndGet() }

        // Run a few rapid forceRelaunch cycles to widen the chance of
        // hitting the race window. With the gen fix the count stays at 0
        // across all iterations.
        repeat(3) {
            binder.forceRelaunch(dbPath, secret)
            assertNotNull("expected LISTENING port after forceRelaunch", binder.awaitListening(15_000L))
        }
        // Let any stale reaper that was about to dispatch settle.
        Thread.sleep(1_000L)

        assertEquals(
            "forceRelaunch must not trigger the unexpected-exit listener; fired=${fired.get()}",
            0,
            fired.get(),
        )
    }

    // (Finding 4) Race regression: cancelStopRequest called near the grace
    // boundary must serialize with the coroutine's destroy decision. Pre-fix,
    // the grace coroutine resuming from delay() and a foreground-driven
    // cancelStopRequest could both "succeed" — cancel returned cleanly while
    // the resumed coroutine destroyed the process as a planned exit. The
    // foregrounded Activity would observe isProcessAlive=true between cancel
    // and destroy, return without scheduling a respawn, then the destroy
    // would fire with expectedExit=true and suppress the unexpected-exit
    // listener — leaving the WebView on a dead backend with no recovery
    // path. The synchronized(stopLock) block makes the destroy-vs-cancel
    // decision atomic: whichever side acquires the lock first wins.
    //
    // We stress the boundary by scheduling a short grace then cancelling
    // close to (or past) its expiry across several iterations. The
    // assertion is the invariant that holds with the fix: the unexpected-
    // exit listener must never fire — every destroy that happens is a
    // planned one, set under the lock. (A regressed implementation that
    // sets expectedExit AFTER the cancel-vs-destroy race could leak a
    // listener invocation; the lock prevents that.)
    @Test
    fun cancelStopRequestAtGraceBoundaryIsRaceFree() {
        val dbPath = File(context.cacheDir, "instrumentation-${System.nanoTime()}.db").absolutePath
        val secret = randomSessionSecret()
        val binder = bindAndStartService(dbPath = dbPath, sessionSecret = secret)
        binder.awaitListening(15_000L)

        val unexpectedFired = java.util.concurrent.atomic.AtomicInteger(0)
        binder.setUnexpectedExitListener { unexpectedFired.incrementAndGet() }

        repeat(5) {
            if (!binder.isProcessAlive()) {
                binder.forceRelaunch(dbPath, secret)
                assertNotNull("expected respawn LISTENING", binder.awaitListening(15_000L))
            }
            binder.requestStop(graceMs = 50L)
            // Sleep approximately at the boundary so the cancel races the
            // coroutine's resume-from-delay path.
            Thread.sleep(50L)
            binder.cancelStopRequest()
            // Let any racing destroy + reaper settle.
            Thread.sleep(200L)
        }

        assertEquals(
            "unexpected-exit listener must not fire for grace-boundary cancel/destroy races; fired=${unexpectedFired.get()}",
            0,
            unexpectedFired.get(),
        )
    }

    // (Finding 5) Once the grace coroutine has fired the destroy, a follow-up
    // cancelStopRequest must observe a fully-dead process by the time it
    // returns — not merely a destroy-initiated-but-still-alive one. Pre-fix,
    // p.destroy() was asynchronous and the grace coroutine released stopLock
    // immediately after the call; cancelStopRequest serialized correctly with
    // respect to the destroy call but not with respect to the process
    // actually exiting, so the foreground activity's isProcessAlive() check
    // could see true and bail, leaving the WebView attached to a dying
    // backend with no recovery (the reaper's expectedExit gate already
    // committed). The fix waits for the process to exit inside the lock.
    @Test
    fun cancelStopRequestObservesDeadProcessAfterGrace() {
        val dbPath = File(context.cacheDir, "instrumentation-${System.nanoTime()}.db").absolutePath
        val secret = randomSessionSecret()
        val binder = bindAndStartService(dbPath = dbPath, sessionSecret = secret)
        assertNotNull("expected initial LISTENING port", binder.awaitListening(15_000L))

        binder.requestStop(graceMs = 50L)
        // Sleep past the grace expiry so the destroy block has started.
        // Margin is generous (4x graceMs) so the coroutine reliably gets past
        // delay() before we call cancel — without that margin, cancel could
        // win the race against delay-resume and the test would exercise the
        // "cancel before destroy" path instead of the post-destroy invariant
        // it's meant to assert.
        Thread.sleep(200L)

        binder.cancelStopRequest()
        assertFalse(
            "after cancelStopRequest serialized with the grace-timer destroy under stopLock, isProcessAlive must reflect post-destroy state",
            binder.isProcessAlive(),
        )
    }

    // (Finding 2) The listener must be invoked at most once per spawn — a
    // re-register inside the listener (the activity's respawn path) must not
    // trigger a second dispatch from the same exit event.
    @Test
    fun listenerCanBeClearedAfterDispatch() {
        val binder = bindAndStartService()
        binder.awaitListening(15_000L)

        val firedCount = java.util.concurrent.atomic.AtomicInteger(0)
        binder.setUnexpectedExitListener {
            firedCount.incrementAndGet()
            binder.setUnexpectedExitListener(null) // clear during dispatch
        }

        binder.killForTest()
        // Give the reaper + listener a generous window to settle.
        Thread.sleep(2_000L)
        assertEquals(1, firedCount.get())
    }

    private fun bindAndStartService(includeSessionSecret: Boolean = true): GoServerService.LocalBinder {
        val dbPath = File(context.cacheDir, "instrumentation-${System.nanoTime()}.db").absolutePath
        val secret = if (includeSessionSecret) randomSessionSecret() else null
        return bindAndStartService(dbPath = dbPath, sessionSecret = secret)
    }

    // Overload used by the lifecycle / respawn tests, which need to reuse the
    // same dbPath + secret across spawns so the on-disk schema is shared.
    private fun bindAndStartService(dbPath: String, sessionSecret: String?): GoServerService.LocalBinder {
        val intent = Intent(context, GoServerService::class.java).apply {
            putExtra(GoServerService.EXTRA_DB_PATH, dbPath)
            if (sessionSecret != null) {
                putExtra(GoServerService.EXTRA_SESSION_SECRET, sessionSecret)
            }
        }
        context.startForegroundService(intent)

        val latch = CountDownLatch(1)
        val bound = AtomicReference<GoServerService.LocalBinder?>(null)
        val conn = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
                bound.set(service as? GoServerService.LocalBinder)
                latch.countDown()
            }
            override fun onServiceDisconnected(name: ComponentName?) {}
        }
        activeConnections.add(conn)
        val ok = context.bindService(intent, conn, Context.BIND_AUTO_CREATE)
        assertTrue("bindService returned false; the service component is not declared correctly", ok)
        assertTrue("service did not bind within 5s", latch.await(5, TimeUnit.SECONDS))
        return bound.get() ?: error("LocalBinder was null after bind")
    }

    private fun randomSessionSecret(): String {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}
