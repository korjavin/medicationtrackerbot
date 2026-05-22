package com.lochyard.medtracker

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

    private fun bindAndStartService(includeSessionSecret: Boolean = true): GoServerService.LocalBinder {
        val dbPath = File(context.cacheDir, "instrumentation-${System.nanoTime()}.db").absolutePath
        val intent = Intent(context, GoServerService::class.java).apply {
            putExtra(GoServerService.EXTRA_DB_PATH, dbPath)
            if (includeSessionSecret) {
                val bytes = ByteArray(32)
                SecureRandom().nextBytes(bytes)
                putExtra(
                    GoServerService.EXTRA_SESSION_SECRET,
                    Base64.getUrlEncoder().withoutPadding().encodeToString(bytes),
                )
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
}
