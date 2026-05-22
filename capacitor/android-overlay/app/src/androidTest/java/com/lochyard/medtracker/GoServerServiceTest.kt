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
