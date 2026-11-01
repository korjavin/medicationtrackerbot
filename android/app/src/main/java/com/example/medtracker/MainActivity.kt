package com.example.medtracker

import android.app.Activity
import android.app.KeyguardManager
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.IntentSender
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.Color
import android.hardware.biometrics.BiometricManager.Authenticators
import android.hardware.biometrics.BiometricPrompt
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewTreeObserver
import android.view.Window
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.autofill.AutofillManager
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Space
import android.widget.TextView
import android.widget.Toast
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.time.Instant
import java.time.LocalTime
import java.time.format.DateTimeFormatter

/**
 * The shell (bd med-nt9p.5), twin of ios/App/Shell.swift: one Android System
 * WebView on the account origin https://<sub>.<base>/, exactly like the PWA.
 * The app remembers only the account host; the vault, Service Worker and
 * IndexedDB live in WebView storage, per origin. The base domain comes from
 * the build (BuildConfig.BASE_DOMAIN), the account from the invite at runtime.
 * Local mode (bd med-nt9p.32.4, prefs wgLocalMode) puts the same WebView on the
 * bundled app at https://appassets.androidplatform.net (LocalApp.kt) instead:
 * no account, one vault at a time, with an optional lock (bd med-nt9p.32.9, LocalLock.kt).
 */
class MainActivity : Activity() {
    private val base = BuildConfig.BASE_DOMAIN
    private val prefs by lazy { getSharedPreferences("shell", MODE_PRIVATE) }
    /** The passkey ceremony log (bd med-nt9p.22): its own file, so Switch account never clears it. */
    private val diagPrefs by lazy { getSharedPreferences("diag", MODE_PRIVATE) }
    private var host: String? = null
    /** In memory only: Try again must keep an invite link's #claim= fragment. */
    private var lastUrl: String? = null
    /** A page of this account finished loading: later load failures leave it usable. */
    private var showingAccount = false
    private var loadFailed = false
    /** Set by open/forget: the previous account's pages must not stay reachable by Back. */
    private var clearHistory = false
    /** The committed page is an account ceremony (/unlock, /claim, /recover; the web draws its exit bar). */
    private var onCeremony = false
    /** N6: the splash stays up until the page or a native screen is ready ([releaseSplash]). */
    private var splashHeld = true
    private var topColor = SCREEN
    private var bottomColor = SCREEN
    private var bars = WindowInsets.CONSUMED

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var topBand: View
    private lateinit var bottomBand: View
    private lateinit var errorView: View
    private lateinit var errorIcon: ImageView
    private lateinit var errorTitle: TextView
    private lateinit var errorLede: TextView
    private lateinit var errorMeta: TextView
    private lateinit var errorPrimary: Button
    private lateinit var errorSecondary: Button
    private lateinit var lockView: View
    private lateinit var lockNote: View
    private lateinit var lockFoot: View
    private lateinit var unlockButton: Button

    private val files by lazy { Files(this) { if (concealed) null else vaultHost } }
    private val notifications by lazy { Notifications(this) { vaultHost } }

    /** Local mode's asset origin (bd med-nt9p.32.2). */
    private val localApp by lazy { LocalApp(this) }
    /** The persisted choice (LocalOrigin.MODE_KEY); wins over a stored host, like Shell.swift. */
    @Volatile private var local = false
    /** The vault the shell has open (med-o7zq.9): reminders, their taps and the bridge follow it. */
    private val vaultHost get() = if (local) LocalOrigin.HOST else host
    /** A debug QA scene (DebugHooks.qaScene) or the bundled app's root. */
    private val localHome by lazy { LocalOrigin.qaHome(DebugHooks.qaScene(this)) ?: LocalOrigin.HOME }

    /** Local mode's optional lock (bd med-nt9p.32.9); off unless the user turned it on. */
    private val lock by lazy { LocalLock(prefs.getBoolean(LocalLock.KEY, false)) }
    /** The lock holds: the page is out of the window, loads and taps wait, the bridge says "locked". */
    private val concealed get() = lock.holds(local) || DebugHooks.qaLock(this)
    /** What the lock held back, run on unlock. */
    private var deferredUrl: String? = null
    private var deferredPath: String? = null
    /** This app's own screen is up (a picker, print, Settings): its onStop is not a background. */
    private var outbound = false
    /** The phone's check is up; its screen-lock screen stops this activity too. */
    private var prompting = false
    /**
     * The screen went off: locks even while one of this app's own screens is up, when this
     * activity is already stopped and gets no second onStop. Registered only while the lock is on.
     */
    private val screenOff = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            outbound = false
            lock.background()
            applyLock()
        }
    }
    private var screenOffRegistered = false

    /** window.Health's health.* ops (bd med-nt9p.8). */
    private val health by lazy { HealthConnect(this, ::diag) }
    /** window.Attest's attest.* ops, local mode only (bd med-nt9p.32.8.4). */
    private val attest by lazy { Attest(this) }
    /** The local → cloud move's stash (bd med-nt9p.32.17): no-backup app storage, see Move.kt. */
    private val move by lazy { Move(File(noBackupFilesDir, "move")) }
    /** The account → local leave stash (bd med-o7zq.36.3): the same class, its own no-backup dir. */
    private val leave by lazy { Move(File(noBackupFilesDir, "leave")) }

    private var resumed = false
    /**
     * invite.pending replies held while the first-install referrer read runs (bd med-ydt2): the local
     * page mounts W1 on a null slot, so answering null before a late referrer lands flashed W1 until
     * deliverInvite's reload. null = no read in flight, answer at once.
     */
    private var referrerWaits: MutableList<() -> Unit>? = null
    /** Push.allowed at the last check: its false -> true edge fires the page's 'token' event. */
    private var pushAllowed = false

    /**
     * Native push (bd med-erq1.5, Push.kt): cancelable document event wg:native-push {kind} on the
     * account page. A wake ('inbox-wake', 'dry-queue', 'transfer_claimed') goes in only while this activity is in front;
     * done(true) only when a listener cancelled it (NativePush.onWake's receipt, installed by
     * cloud-boot after unlock; twin of iOS Push.swift, bd med-erq1.10), else Push posts the
     * notification. 'token' whenever an account page is open; it has no fallback.
     */
    fun pushEvent(kind: String, done: (Boolean) -> Unit = {}) {
        if (local || !showingAccount || loadFailed || (kind != "token" && !resumed)) return done(false)
        web.evaluateJavascript(
            "!document.dispatchEvent(new CustomEvent('wg:native-push',{detail:{kind:${JSONObject.quote(kind)}},cancelable:true}))"
        ) { done(it == "true") }
    }

    /**
     * The page's back.state (bd med-y7b4.5, web/static/js/native/back.js): null until the current page
     * reports it (pages without the app: /unlock, /claim, error pages), reset on every main-frame load.
     */
    private var pageCanStep: Boolean? = null
    /**
     * bd med-8bgs: the main-frame load (onPageStarted), and the load whose page sent its shell.ops probe.
     * A page's back.state always follows its probe (native/index.js has()), so one arriving while they
     * differ, or a wg:native-back answer from an earlier load, is the outgoing page's: ignored.
     */
    private var loadGen = 0
    private var probedGen = -1
    private val back = OnBackInvokedCallback {
        if (pageCanStep == null) return@OnBackInvokedCallback web.goBack()
        val gen = loadGen
        // The page owns its history: never web.goBack() here, its popstate would step AppBack again.
        web.evaluateJavascript("!document.dispatchEvent(new CustomEvent('wg:native-back',{cancelable:true}))") {
            // false: a race, the page hit its root before its back.state arrived. Drop the callback and
            // let the system own the next Back (on Android 12+ it moves the root task back, not finish()).
            if (it != "true" && gen == loadGen) { pageCanStep = false; updateBack() }
        }
    }
    private var backRegistered = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        // Edge to edge on Android 14 too (targetSdk 35+ only enforces it from 15):
        // layoutBars owns the bar and keyboard insets on every version.
        @Suppress("DEPRECATION")
        window.setDecorFitsSystemWindows(false)
        @Suppress("DEPRECATION")
        window.statusBarColor = Color.TRANSPARENT
        @Suppress("DEPRECATION")
        window.navigationBarColor = Color.TRANSPARENT
        window.isNavigationBarContrastEnforced = false // the band shows the page colour, not a scrim
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        setContentView(buildUi())
        Push.live = java.lang.ref.WeakReference(this)
        pushAllowed = Push.allowed(this)
        holdSplash()
        publishShortcut()

        if (intent?.action == ACTION_DIAG && savedInstanceState == null) copyDiagnostics()
        adoptSpikeAccount()
        host = prefs.getString(HOST_KEY, null)?.takeIf { AccountUrl.isAccountHost(it, base) }
        local = prefs.getBoolean(LocalOrigin.MODE_KEY, false)
        // Before anything writes the mode: a true first install reads the Play referrer (A6).
        if (savedInstanceState == null) {
            val done = prefs.getBoolean(Invite.REFERRER_KEY, false)
            if (Invite.readReferrer(prefs.contains(HOST_KEY), prefs.contains(LocalOrigin.MODE_KEY), done)) readReferrer()
            if (!done) prefs.edit().putBoolean(Invite.REFERRER_KEY, true).commit()
        }
        // An invite link launched the app (A5): into the slot; the launch path below boots as usual.
        capture(intent, savedInstanceState == null)
        // QA launch extra, false in release (src/release): enter local mode even with an account stored.
        if (!local && savedInstanceState == null && DebugHooks.localMode(this)) setLocal(true)
        // No account: the bundled app (bd med-ta2n.12, contract med-ta2n.7 §9). A fresh install, and an
        // install that was on the old native first run, open W1 there; invites come in through F1.
        if (!local && host == null) setLocal(true)
        // A restored activity keeps its launch intent: only a fresh shortcut launch switches.
        if (intent?.action == ACTION_SWITCH && savedInstanceState == null) forget()
        else reopen(tappedPath(intent)?.let { pathUrl(it) } ?: home)
        if (DebugHooks.qaLocalError(this)) showError(LoadError.LOCAL, "local · bundle failed to load")
    }

    /**
     * N6 splash → web hand-off: the platform splash (wg_screen, the mark tile) stays while the
     * first frame is held, until the page posts its first chrome sample or commits a visible frame,
     * or a native screen (error, lock) shows — then the mark fades out over 180 ms onto
     * the same colour. ponytail: capped at [SPLASH_MAX_MS], so a page that never reports still shows.
     */
    private fun holdSplash() {
        root.viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
            override fun onPreDraw(): Boolean {
                if (splashHeld) return false
                root.viewTreeObserver.removeOnPreDrawListener(this)
                return true
            }
        })
        root.postDelayed(::releaseSplash, SPLASH_MAX_MS)
        splashScreen.setOnExitAnimationListener { v ->
            v.animate().alpha(0f).setDuration(180).withEndAction { v.remove() }.start()
        }
    }

    private fun releaseSplash() {
        if (!splashHeld) return
        splashHeld = false
        root.invalidate()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == ACTION_SWITCH) forget()
        if (intent.action == ACTION_DIAG) copyDiagnostics()
        tappedPath(intent)?.let { openPath(it) }
        if (capture(intent, fresh = true)) deliverInvite()
    }

    /** A reminder tap, or a push tap with a path (Push.tappedPath, bd med-r1j2.15) — that one only into the open account. */
    private fun tappedPath(intent: Intent?) =
        Notifications.tappedPath(intent, vaultHost) ?: Push.tappedPath(intent)?.takeUnless { local }

    // MARK: invites (bd med-ta2n.12.1, contract med-ta2n.7 §4–§7)

    /** invite.pending's reply: {url, receivedAt} or null. */
    private fun pendingInvite(): JSONObject? {
        val url = prefs.getString(Invite.URL_KEY, null) ?: return null
        return JSONObject().put("url", url).put("receivedAt", prefs.getLong(Invite.AT_KEY, 0))
    }

    /** The slot, written with commit() (A6: a cold start can die right after). null clears it. */
    private fun setInvite(url: String?, at: Long = System.currentTimeMillis()) {
        prefs.edit().apply {
            if (url == null) remove(Invite.URL_KEY).remove(Invite.AT_KEY) else putString(Invite.URL_KEY, url).putLong(Invite.AT_KEY, at)
        }.commit()
        slotWrites++
    }

    /**
     * A VIEW intent from InviteLinkActivity: an invite into the slot (newest wins). A5: only a
     * fresh delivery (not a restore, not Recents) and the intent is consumed; never opens anything
     * itself — medtracker:// is unauthenticated. True when the slot was filled.
     */
    private fun capture(intent: Intent?, fresh: Boolean): Boolean {
        if (intent?.action != Intent.ACTION_VIEW) return false
        val raw = intent.dataString
        intent.data = null
        intent.action = null
        if (!fresh || (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return false
        val url = raw?.let { AccountUrl.parseInvite(it, base) } ?: return false
        setInvite(url)
        return true
    }

    /**
     * Warm delivery (§6): the page (any mode) reloads its home with ?invite=1 — history cleared,
     * deferred under the lock — so the web reads the slot. The mode never changes.
     */
    private fun deliverInvite() = reopen(Invite.withInvite(home))

    /**
     * Play Install Referrer (§4, A6), on a true first install only: invite=<landing URL> into the
     * slot when it is still empty (a link captured on this launch is newer), dated by Play's click.
     * ponytail: nothing retries a failed connection; F1's Paste (the landing copies the link) covers it.
     */
    private fun readReferrer() {
        val client = InstallReferrerClient.newBuilder(this).build()
        val writes = slotWrites // any capture, open, clear or reset after this wins over the late answer
        val waits = mutableListOf<() -> Unit>()
        referrerWaits = waits
        // Main thread only. Answers the held invite.pending reads with the slot as it now stands;
        // true when a page was waiting (it got the slot, so it needs no reload).
        fun settle(): Boolean {
            if (referrerWaits !== waits) return false
            referrerWaits = null
            waits.forEach { it() }
            return waits.isNotEmpty()
        }
        // ponytail: a referrer service that never calls back releases the page after REFERRER_HOLD_MS.
        root.postDelayed({ settle() }, REFERRER_HOLD_MS)
        runCatching {
            client.startConnection(object : InstallReferrerStateListener {
                override fun onInstallReferrerSetupFinished(code: Int) {
                    val details = if (code == InstallReferrerClient.InstallReferrerResponse.OK) runCatching { client.installReferrer }.getOrNull() else null
                    runCatching { client.endConnection() }
                    val url = AccountUrl.referrerInvite(details?.installReferrer, base)
                    runOnUiThread {
                        if (url == null || slotWrites != writes || prefs.contains(Invite.URL_KEY)) {
                            settle()
                            return@runOnUiThread
                        }
                        // Filed even if this activity went meanwhile: the read-once flag is already set.
                        setInvite(url, Invite.referrerAt(details!!.referrerClickTimestampSeconds, System.currentTimeMillis()))
                        if (!settle() && !isDestroyed) deliverInvite()
                    }
                }
                override fun onInstallReferrerServiceDisconnected() {
                    runOnUiThread { settle() }
                }
            })
        }.onFailure {
            diag("shell referrer ${it.javaClass.simpleName}")
            settle()
        }
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        outbound = false
        notifications.onResume()
        // Notifications newly allowed (the reminders Enable, or system Settings): push.token now
        // answers, so the page registers again (bd med-erq1.5).
        val allowed = Push.allowed(this)
        if (allowed && !pushAllowed) pushEvent("token")
        pushAllowed = allowed
        // Once per launch or return from the background; the prompt's own pause/resume asks nothing.
        lock.activate(local)?.let { authenticate(it) }
    }

    /** Chromium writes cookies only every ~30 s: a kill soon after sign-in would lose the session (bd med-nt9p.45). */
    override fun onPause() {
        super.onPause()
        resumed = false
        notifications.onPause()
        CookieManager.getInstance().flush()
    }

    /**
     * The lock closes on every stop (bd med-nt9p.32.9) — Home, Recents, a call, another app, the
     * screen going off — except for this app's own file picker, share, print and Settings screens
     * and the phone's screen-lock check, while the screen is on.
     * The screen going off on one of them locks through [screenOff].
     * ponytail: leaving the app from one of those screens locks only at the next stop; telling
     * that apart needs tracking other apps' activities. Permission screens (requestPermissions is
     * final) are not exempt: the return from one asks to unlock.
     */
    override fun onStop() {
        super.onStop()
        if (!getSystemService(PowerManager::class.java).isInteractive || !(outbound || prompting)) {
            lock.background()
            applyLock()
        }
    }

    /**
     * Every startActivity lands here: this app's own screens, except a link opened in the browser.
     * Marked only once the launch went through: a failed one (callers catch it) exempts nothing.
     */
    override fun startActivityForResult(intent: Intent, requestCode: Int, options: Bundle?) {
        super.startActivityForResult(intent, requestCode, options)
        if (!intent.hasCategory(Intent.CATEGORY_BROWSABLE)) outbound = true
    }

    /** PrintManager.print opens the print screen through here. */
    override fun startIntentSender(
        intent: IntentSender, fillInIntent: Intent?, flagsMask: Int, flagsValues: Int, extraFlags: Int, options: Bundle?,
    ) {
        super.startIntentSender(intent, fillInIntent, flagsMask, flagsValues, extraFlags, options)
        outbound = true
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (!files.onActivityResult(requestCode, resultCode, data)) super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        if (!files.onRequestPermissionsResult(requestCode) && !notifications.onRequestPermissionsResult(requestCode) &&
            !health.onRequestPermissionsResult(requestCode)
        ) {
            super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        }
    }

    /**
     * A reminder tap (bd med-nt9p.7, med-nt9p.52; Shell.openReminder's twin): hand the sanitized
     * path to the open page's deep-link router, or load the vault on it.
     */
    private fun openPath(path: String) {
        val url = pathUrl(path) ?: return
        if (concealed) {
            deferredPath = path // opened after the unlock
            return
        }
        if (!showingAccount || web.progress < 100) return load(url)
        // A page without the router (e.g. the unlock page) loads the path instead.
        web.evaluateJavascript(
            "!!window.handleDeepLinks && (history.replaceState({}, '', ${JSONObject.quote(path)}), window.handleDeepLinks(), true)"
        ) { if (it != "true") load(url) }
    }

    /** [path] is a ReminderPath.sanitize result ("/?…"). */
    private fun pathUrl(path: String) = vaultHost?.let { "https://$it$path" }
    override fun onDestroy() {
        if (Push.live?.get() === this) Push.live = null
        if (screenOffRegistered) unregisterReceiver(screenOff)
        health.close()
        attest.close()
        web.destroy()
        files.destroy()
        super.onDestroy()
    }

    // MARK: account

    /** No account means local mode (onCreate, forget()), so there is always a home. */
    private val home: String get() = host?.takeUnless { local }?.let { "https://$it/" } ?: localHome

    /**
     * Opens a validated account URL from any mode (A1): local.leave / account.leave {url}. It
     * leaves local mode with setLocal(false), which keeps the move stash (forget()/setLocal(true)
     * would drop it): dropping it is account.leave's call.
     */
    private fun enterAccount(url: String, h: String) {
        if (h != host) Notifications.clear(this)
        setLocal(false) // leaving local mode keeps the move stash for the new account
        leave.clear() // opening an account abandons a pending leave stash; the next leave stashes afresh
        prefs.edit().putString(HOST_KEY, h).remove(LEAVE_HOST_KEY).apply()
        clearErase() // opening an account drops a pending join erase; local.leave {erase} re-arms it after
        setInvite(null) // whatever invite was waiting, this open consumed or superseded it
        host = h
        reopen(url) // the claim link keeps its #fragment for the page; only the host is stored
    }

    /**
     * Every native way out — launcher Switch account, N4's "Use another invite" / "Switch account",
     * X-Account-Gone, account.leave without args — lands in local mode on
     * home?invite=1, where the web opens F1 (bd med-ta2n.12, contract med-ta2n.7 §7; it replaced the
     * native first run). With [thenLocal] (account.leave {then: "local"}, bd med-nt9p.32.13) the
     * plain home, and leave.clear {back: true} can reopen the account left — unless [drop]
     * (account.leave {then: "local", forget: true}, bd med-r1j2.19, iOS twin med-r1j2.18): the plain
     * home with the account forgotten, no "Return to account". Entering local mode
     * drops a pending move stash (setLocal), from local mode too (bd med-nt9p.49): only the page's
     * own local.leave hands one off. WebView data is per origin and kept.
     */
    private fun forget(thenLocal: Boolean = false, drop: Boolean = false) {
        // The account a leave left (bd med-o7zq.42): leave.clear {back: true} reopens it.
        val left = host
        prefs.edit().apply { if (thenLocal && !drop && left != null) putString(LEAVE_HOST_KEY, left) else remove(LEAVE_HOST_KEY) }.apply()
        setLocal(true)
        Notifications.clear(this)
        prefs.edit().remove(HOST_KEY).apply()
        host = null
        reopen(if (thenLocal) home else Invite.withInvite(home))
    }

    /** Every mode change clears the alarms (med-o7zq.9): no reminder of the other vault fires or opens it. */
    private fun setLocal(on: Boolean) {
        if (on != local) Notifications.clear(this)
        // Entering local mode (or a native exit within it) abandons a pending move; the next move stashes afresh.
        if (on) move.clear()
        if (on) clearErase() // back in local mode: the join erase (bd med-r1j2.8) must never fire later
        prefs.edit().putBoolean(LocalOrigin.MODE_KEY, on).apply()
        local = on
    }

    private fun clearErase() = prefs.edit().remove(Invite.ERASE_HOST_KEY).remove(Invite.ERASE_AT_KEY).apply()

    private fun reopen(url: String = home) {
        deferredUrl = null
        deferredPath = null
        if (concealed) web.loadUrl("about:blank") // the old page must not run behind the lock
        applyLock()
        showingAccount = false
        lastUrl = null
        clearHistory = true
        onCeremony = false
        errorView.visibility = View.GONE
        load(url)
        updateChrome()
    }

    private fun load(url: String) {
        errorView.visibility = View.GONE
        lastUrl = url
        if (concealed) {
            deferredUrl = url // loaded after the unlock
            return
        }
        // bd med-r1j2.12: the local origin waits for an in-flight local.erase wipe (max 10 s), so a
        // switch to local mode, or its import/restore, can't write data the wipe then deletes.
        if (LocalWipe.gate.busy && Uri.parse(url).host == LocalOrigin.HOST) {
            LocalWipe.gate.after { if (!isDestroyed && lastUrl == url) load(url) }
            return
        }
        web.loadUrl(url)
        updateChrome()
    }

    private fun retry() = load(lastUrl ?: home)

    /** N4's three variants (screens-native.html; twin of iOS LoadErrorView). */
    private enum class LoadError { NETWORK, NOT_FOUND, LOCAL }

    /**
     * N4 load error: [what] is the mono meta line for support ("503 · service unavailable"), the
     * time appended. A bare 404 leads with another invite (trying again can't fix it, warn tone);
     * local mode never offers Switch account.
     */
    private fun showError(kind: LoadError, what: String) {
        val h = host ?: "your account"
        val warn = kind == LoadError.NOT_FOUND
        errorIcon.setBackgroundResource(if (warn) R.drawable.wg_shell_icon_warn else R.drawable.wg_shell_icon)
        errorIcon.setImageResource(
            when (kind) {
                LoadError.NETWORK -> R.drawable.ic_wg_cloud_off
                LoadError.NOT_FOUND -> R.drawable.ic_wg_search
                LoadError.LOCAL -> R.drawable.ic_wg_device
            }
        )
        errorIcon.imageTintList = getColorStateList(if (warn) R.color.wg_warn_fg else R.color.wg_fg_2)
        when (kind) {
            LoadError.NETWORK -> {
                errorTitle.text = "Can't reach your account"
                errorLede.text = "Med Tracker couldn't connect to $h. Your records are safe. Check your connection and try again."
            }
            LoadError.NOT_FOUND -> {
                errorTitle.text = "We can't find this account"
                errorLede.text = "There's no account at $h any more. It may have been deleted, or the address changed."
            }
            LoadError.LOCAL -> {
                errorTitle.text = "Can't open Med Tracker"
                errorLede.text = "The app on this phone didn't start. Your records are still here. Try again, or restart your phone if it keeps happening."
            }
        }
        errorMeta.text = "$what · ${LocalTime.now().format(HH_MM)}"
        fun set(b: Button, label: String, action: () -> Unit) {
            b.text = label
            b.setOnClickListener { action() }
        }
        // Leaving an account keeps its data: it is back on the next switch. Local mode has no exit here
        // (bd med-ta2n.12, iOS twin): forget() would only reload the bundle that just failed.
        errorSecondary.visibility = if (kind == LoadError.LOCAL) View.GONE else View.VISIBLE
        if (warn) {
            set(errorPrimary, "Use another invite") { forget() }
            set(errorSecondary, "Try again") { retry() }
        } else {
            set(errorPrimary, "Try again") { retry() }
            set(errorSecondary, "Switch account") { forget() }
        }
        errorView.visibility = View.VISIBLE
        updateChrome()
    }

    private fun isInside(h: String?): Boolean {
        val l = h?.lowercase() ?: return false
        if (local) return l == LocalOrigin.HOST // the bundled app navigates on its own origin only
        return host != null && (l == host || l == base)
    }

    /** The spike (bd med-nt9p.4) kept the last URL: adopt its account so testers skip first run. */
    private fun adoptSpikeAccount() {
        val spike = getSharedPreferences("spike", MODE_PRIVATE)
        val last = spike.getString("lastUrl", null)
        if (last != null && !prefs.contains(HOST_KEY)) {
            AccountUrl.parse(last, base)?.let { Uri.parse(it).host }?.let { prefs.edit().putString(HOST_KEY, it).apply() }
        }
        if (spike.all.isNotEmpty()) deleteSharedPreferences("spike")
    }

    /** Long-press the launcher icon → Switch account: the twin of iOS Settings → Switch account. */
    private fun publishShortcut() {
        val switch = ShortcutInfo.Builder(this, "switch-account")
            .setShortLabel("Switch account")
            .setIntent(Intent(ACTION_SWITCH, null, this, MainActivity::class.java))
            .build()
        val copy = ShortcutInfo.Builder(this, "copy-diagnostics")
            .setShortLabel("Copy diagnostics")
            .setIntent(Intent(ACTION_DIAG, null, this, MainActivity::class.java))
            .build()
        runCatching { getSystemService(ShortcutManager::class.java).setDynamicShortcuts(listOf(switch, copy)) }
    }

    // MARK: web view

    private fun makeWebView(): WebView {
        val w = WebView(this)
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        // iOS parity: page text ignores the system font scale (fixed-height chrome would
        // overflow), pinch-zoom is on instead (no on-screen buttons), and no edge glow.
        w.settings.textZoom = 100
        w.settings.builtInZoomControls = true
        w.settings.displayZoomControls = false
        w.overScrollMode = View.OVER_SCROLL_NEVER
        // The ElevenLabs SDK plays the agent through an autoplay <audio> element fed by a
        // MediaStream, started seconds after the tap (attested start, the mint, the mic
        // prompt), past the gesture's transient activation. With the WebView default (true)
        // that play() is refused (NotAllowedError) and the call is silent (bd med-dngs,
        // measured by android/qa local-app). Only our own pages load here.
        w.settings.mediaPlaybackRequiresUserGesture = false
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
            WebSettingsCompat.setWebAuthenticationSupport(w.settings, WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP)
        }
        diag("shell webview webauthn=${webAuthnMode(w)}")
        w.setBackgroundColor(SCREEN) // the token mirror: wg_screen until the page paints (N6)
        w.webViewClient = Client()
        // The account subdomains and the asset origin; onBridge and Files answer only the open vault's.
        val rules = (if (base.isEmpty()) emptySet() else setOf("https://*.$base")) + "https://${LocalOrigin.HOST}"
        files.install(w, rules)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(w, BRIDGE, rules) { _, message, origin, isMainFrame, reply ->
                onBridge(message.data, origin, isMainFrame) { reply.postMessage(it) }
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(w, assets.open("chrome.js").bufferedReader().use { it.readText() }, rules)
            WebViewCompat.addDocumentStartJavaScript(w, LocalWipe.SESSION_JS, setOf("https://${LocalOrigin.HOST}"))
        }
        DebugHooks.onWebView(this, w, rules, ::diag) // no-op in release (src/release) and off the qa.test base
        return w
    }

    private inner class Client : WebViewClient() {
        /** Off the main thread. Only the asset origin, only in local mode; null = the network. */
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            if (local) localApp.intercept(request) else null

        /** Only the account host and the base domain load in the app; anything else opens outside it. */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            when (uri.scheme?.lowercase()) {
                "http", "https" -> if (isInside(uri.host) || !request.isForMainFrame) return false
                "blob", "data", "about" -> return false
            }
            openOutside(uri)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            loadFailed = false
            loadGen++
            pageCanStep = null
            updateBack()
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (clearHistory) {
                clearHistory = false
                view.clearHistory()
            }
            val v = vaultHost
            if (!loadFailed && v != null && url?.let { Uri.parse(it).host?.lowercase() } == v) showingAccount = true
            updateBack()
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            // A mode switch from a page with a dialog open (the wizard's "Use another invite", F1's
            // Continue) races the dialog's own history.back(): WebView delivers it late, it lands after
            // reopen()'s load and the old vault's page stays (bd med-ta2n.12). Only the open vault's
            // origin belongs here (isInside), so anything else committing is that stale page: load again.
            val u = url?.let(Uri::parse)
            if (u != null && (u.scheme == "https" || u.scheme == "http") && !isInside(u.host)) {
                diag("shell stale page after a mode switch")
                view.post { reopen(lastUrl?.takeIf { isInside(Uri.parse(it).host) } ?: home) }
                return
            }
            // The ceremony pages leave by full navigation, so every commit is seen here.
            val ceremony = AccountUrl.isCeremony(url, base)
            // Leaving /unlock, /claim or /recover for the app (bd med-nt9p.33): Back on Today
            // must leave the app, not reopen the spent ceremony ("invite already claimed").
            if (!ceremony && onCeremony) {
                clearHistory = true
                // Signed in: write the session cookie now, not on Chromium's ~30 s timer (bd med-nt9p.45).
                CookieManager.getInstance().flush()
            }
            onCeremony = ceremony
            updateBack()
        }

        /** N6: the page's first visible frame ends the splash hold. */
        override fun onPageCommitVisible(view: WebView, url: String?) {
            releaseSplash()
        }

        /**
         * Offline with a Service Worker in control never gets here: the worker answers.
         * Unlike WKWebView, WebView replaces the page with its own error page, so a
         * later failure gets the screen too, and Try again reloads that URL.
         */
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            if (bundled(request, "error ${error.errorCode}")) return
            loadFailed = true
            if (showingAccount) lastUrl = request.url.toString()
            val why = error.description?.toString()?.takeIf { it.isNotBlank() } ?: "not loaded"
            showError(if (local) LoadError.LOCAL else LoadError.NETWORK, "error ${error.errorCode} · $why")
        }

        /** An HTTP error before any page of this account showed — a mistyped or deleted account is a 404. */
        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            // Once the account showed, the server's own error page stays (Back leaves it).
            if (!request.isForMainFrame || response.statusCode < 400 || showingAccount) return
            val code = response.statusCode
            if (bundled(request, "HTTP $code")) {
                // The app document itself missing: the bundled app can't start (N4 · local).
                if (request.url.path.orEmpty().trim('/').isEmpty()) {
                    loadFailed = true
                    showError(LoadError.LOCAL, "local · $code · bundle failed to load")
                }
                return
            }
            val h = request.url.host?.lowercase()
            // The server says the stored account is gone (deleted here or elsewhere, or a typo): forget
            // it (bd med-nt9p.32.14) — local mode with F1 open, no way back to it (no leaveHost). A 404
            // without the server's marker (a proxy's during a redeploy, an older server) keeps the
            // error screen and Try again.
            if (h != null && h == host && AccountUrl.accountGone(response.statusCode, response.responseHeaders)) {
                diag("shell account gone")
                forget()
                return
            }
            loadFailed = true
            // WebView often leaves reasonPhrase empty (HTTP/2 has none).
            val reason = response.reasonPhrase?.takeIf { it.isNotBlank() }?.lowercase() ?: STATUS_TEXT[code] ?: "http error"
            showError(if (code == 404) LoadError.NOT_FOUND else LoadError.NETWORK, "$code · $reason")
        }

        /** The asset origin is never "your account": a miss is LocalApp's own 404, so log it and keep the page (the app document aside). */
        private fun bundled(request: WebResourceRequest, what: String): Boolean {
            if (request.url.host?.lowercase() != LocalOrigin.HOST) return false
            diag("shell local $what ${request.url.path}")
            return true
        }

        /** Renderer crash or kill: a fresh WebView on the same URL (it keeps the fragment). */
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            val url = runCatching { view.url }.getOrNull()?.takeIf { it != "about:blank" }
            root.removeView(view)
            view.destroy()
            web = makeWebView()
            if (!concealed) root.addView(web, 0) // else the unlock attaches it
            layoutBars()
            showingAccount = false
            if (url != null) load(url) else retry()
            return true
        }
    }

    /**
     * The wgNative bridge (bd med-nt9p.5): WebMessageListener injected as
     * window.wgNative on the `https` subdomains of base and the asset origin. Only
     * the open vault's top-level page is answered (LocalOrigin.bridgeCaller), and
     * the local-only ops only in local mode. Messages are JSON {op, args, id}; replies
     * {id, result} or {id, error}. Capability ops (native/ android platform,
     * med-nt9p.6) add cases here.
     */
    private fun stash(m: Move, msg: JSONObject, answer: (Any?, String?) -> Unit) = try {
        m.stash(msg.optJSONObject("args")?.opt("vault"))
        answer(true, null)
    } catch (e: Move.Failure) {
        answer(null, e.message)
    } catch (e: IOException) {
        answer(null, "write failed")
    }

    private fun take(m: Move, answer: (Any?, String?) -> Unit) = try {
        answer(m.take()?.let { JSONObject().put("vault", it) } ?: JSONObject.NULL, null)
    } catch (e: IOException) {
        answer(null, "read failed")
    }

    private fun onBridge(data: String?, origin: Uri, isMainFrame: Boolean, reply: (String) -> Unit) {
        val msg = runCatching { JSONObject(data ?: "") }.getOrNull() ?: return
        val id = msg.opt("id")
        fun answer(result: Any?, error: String? = null) {
            if (id == null) return
            reply(JSONObject().put("id", id).apply { if (error != null) put("error", error) else put("result", result) }.toString())
        }
        if (!LocalOrigin.bridgeCaller(isMainFrame, origin.scheme, origin.host, vaultHost)) {
            answer(null, "forbidden")
            return
        }
        // The page's back stack (bd med-y7b4.5): a report, not a capability, so it lands behind the lock too.
        if (msg.optString("op") == "shell.ops") probedGen = loadGen
        if (msg.optString("op") == "back.state") {
            if (probedGen != loadGen) return answer(true)
            pageCanStep = msg.optJSONObject("args")?.optBoolean("canStep") == true
            updateBack()
            return answer(true)
        }
        // A page still running behind the lock gets no native capability.
        if (concealed) return answer(null, "locked")
        val op = msg.optString("op")
        if (!LocalOrigin.opAllowed(op, local)) return answer(null, "unsupported: $op")
        // {url} (bd med-ta2n.12.1, contract med-ta2n.7 §7): open that account's claim link from either
        // mode — validated by today's parse (fragment verbatim, &kit=1 kept), else "invalid url" and
        // nothing changes. A3: the url KEY decides; null, empty or non-string is "invalid url", never
        // the no-url leave. account.leave ignores then and drops the move stash (A1); local.leave keeps it.
        val leaveArgs = msg.optJSONObject("args")
        if ((op == "local.leave" || op == "account.leave") && leaveArgs?.has("url") == true) {
            val url = (leaveArgs.opt("url") as? String)?.let { AccountUrl.parse(it, base) } ?: return answer(null, "invalid url")
            val h = Uri.parse(url).host ?: return answer(null, "invalid url")
            answer(true)
            if (op == "account.leave") move.clear()
            enterAccount(url, h)
            // "Join and erase" (bd med-r1j2.8): nothing is erased now — only remembered for this host
            // until its unlocked boot calls local.erase. No merge either: drop any move stash.
            // Only for an add-device claim link (/claim#…); erase on an invite is a plain leave (bd med-r1j2.14).
            if (op == "local.leave" && leaveArgs.optBoolean("erase") && Invite.armsErase(url)) {
                move.clear()
                prefs.edit().putString(Invite.ERASE_HOST_KEY, h).putLong(Invite.ERASE_AT_KEY, System.currentTimeMillis()).apply()
            }
            return
        }
        when (op) {
            "ping" -> answer("pong")
            // The page's capability probe (bd med-nt9p.32.13): an older shell answers "unsupported".
            "shell.ops" -> answer(JSONArray(LocalOrigin.ops(local)))
            // Leave the account (account mode only); the account and this origin's data stay. Settings
            // → Account "Use this phone without an account" passes {then: "local"} → local mode; after
            // an account delete (no args) → local mode with F1, as Switch account (forget()).
            // {then: "local", forget: true} (bd med-r1j2.19): local mode, no F1, no way back.
            "account.leave" -> {
                answer(true)
                val args = msg.optJSONObject("args")
                val thenLocal = args?.optString("then") == "local"
                forget(thenLocal, drop = thenLocal && args?.optBoolean("forget") == true)
            }
            "chrome" -> {
                val args = msg.optJSONObject("args") ?: return
                cssColor(args.optString("top"))?.let { topColor = it }
                cssColor(args.optString("bottom"))?.let { bottomColor = it }
                updateChrome()
                releaseSplash() // N6: the page's first sample says it is ready

            }
            // The page's BYOK hosts, for the next document's CSP; it reloads itself when changed (local-boot.js).
            "setEgressHosts" -> {
                val raw = msg.optJSONObject("args")?.optJSONArray("hosts")
                val hosts = LocalOrigin.validHosts(raw?.let { a -> List(a.length()) { a.opt(it) } })
                    ?: return answer(null, "invalid hosts")
                val changed = LocalOrigin.decodeHosts(prefs.getString(LocalOrigin.HOSTS_KEY, null)) != hosts
                prefs.edit().putString(LocalOrigin.HOSTS_KEY, LocalOrigin.encodeHosts(hosts)).apply()
                answer(JSONObject().put("changed", changed))
            }
            // The page erased its own storage (local-policy.js); the shell's share is the host mirror and reminders.
            "local.reset" -> {
                prefs.edit().remove(LocalOrigin.HOSTS_KEY).remove(LEAVE_HOST_KEY).apply()
                move.clear()
                leave.clear()
                setInvite(null) // A4: no claim token left behind after Erase
                Notifications.clear(this)
                // Only after our server deleted the install record (bd med-egb3): key material goes (pass stays) before the answer.
                if (LocalOrigin.dropsAttest(msg.optJSONObject("args")?.opt("dropAttest"))) attest.drop()
                answer(true)
            }
            // "Join and erase", account side (bd med-r1j2.8, cloud-boot.js finishJoinErase): the joined
            // account booted unlocked. Only for the host local.leave {erase} remembered, within the code's
            // 10 minutes: wipe the local origin's website data plus local.reset's native share. Reminders
            // and the slot were already cleared by enterAccount; clearing them here would hit this
            // account's own. Not due: a no-op that spends the flag. A failed wipe answers "erase failed"
            // and keeps the flag for the next boot.
            // Listed in both modes (the local page's Join-and-erase probe); in local mode a no-op.
            // Only {enrolled: true} wipes (bd med-r1j2.12, iOS #1347's contract): an old cached cloud-boot.js
            // sends a bare {} on every unlocked boot, failed joins included — a no-op that keeps the flag.
            "local.erase" -> {
                if (local) return answer(true) // the flag cannot exist here (setLocal(true) clears it)
                if (msg.optJSONObject("args")?.optBoolean("enrolled") != true) return answer(true)
                val due = Invite.eraseDue(prefs.getString(Invite.ERASE_HOST_KEY, null), prefs.getLong(Invite.ERASE_AT_KEY, 0), host, System.currentTimeMillis())
                if (!due) {
                    clearErase()
                    return answer(true)
                }
                // The reply waits for the wipe; the page's caller times out on its own. A failed wipe
                // keeps the (host- and TTL-bound) flag, so the next unlocked boot retries.
                val from = host
                val at = prefs.getLong(Invite.ERASE_AT_KEY, 0)
                LocalWipe.run(this) { ok ->
                    diag("shell local erase ${if (ok) "done" else "failed"}")
                    // Native state only if nothing changed during the wipe (mode, account, erase intent).
                    val same = !local && host == from && prefs.getString(Invite.ERASE_HOST_KEY, null) == from &&
                        prefs.getLong(Invite.ERASE_AT_KEY, 0) == at
                    if (ok && same) {
                        clearErase()
                        prefs.edit().remove(LocalOrigin.HOSTS_KEY).remove(LEAVE_HOST_KEY).apply()
                        move.clear()
                        leave.clear()
                    }
                    if (!isDestroyed) runCatching { if (ok) answer(true) else answer(null, "erase failed") }
                }
            }
            // The pending-invite slot: the page reads it once per boot; clear on "Keep this account" or stale.
            // On a first install the reply waits for the Play referrer read (referrerWaits, bd med-ydt2).
            "invite.pending" -> {
                val reply = { answer(pendingInvite() ?: JSONObject.NULL) }
                val held = referrerWaits
                if (held != null) held.add { if (!isDestroyed) runCatching { reply() } } else reply()
            }
            "invite.clear" -> {
                setInvite(null)
                answer(true)
            }
            // F1's Paste (Android only): WebView has no clipboard-read permission UI. Text only, else null.
            // Native push (bd med-erq1.5, account mode only): {platform, token} or null; Diag gets a fingerprint.
            "push.token" -> Push.token(this) { t ->
                if (t != null) diag("shell push token ${Push.fingerprint(t)}")
                if (!isDestroyed && !local) runCatching { answer(t?.let { JSONObject().put("platform", "android").put("token", it) } ?: JSONObject.NULL) }
            }
            "clipboard.read" -> answer(
                getSystemService(ClipboardManager::class.java).primaryClip?.takeIf { it.itemCount > 0 }
                    ?.getItemAt(0)?.text?.toString()?.takeIf { it.isNotEmpty() } ?: JSONObject.NULL
            )
            // Local → cloud move (bd med-nt9p.32.17): the vault v1 JSON for the next account to pick up.
            // Errors never carry the contents or the path.
            // ponytail: synchronous file I/O on the main thread; move it off-thread if a 64 MB vault ever janks.
            "move.stash" -> stash(move, msg) { r, e -> answer(r, e) }
            // The account side: {vault} or null. Not deleted here: the page clears it once imported,
            // so a failed import retries on the next open.
            "move.take" -> take(move) { r, e -> answer(r, e) }
            "move.clear" -> {
                move.clear()
                answer(true)
            }
            // Account → local leave (bd med-o7zq.36.3): the mirror image, same contract, the "leave" dir.
            // Entering local mode (setLocal/forget) deliberately keeps it; enterAccount (leave {url}) and local.reset delete it.
            "leave.stash" -> stash(leave, msg) { r, e -> answer(r, e) }
            "leave.take" -> take(leave) { r, e -> answer(r, e) }
            // {back: true}: the user cancelled the pickup (bd med-o7zq.42), so nothing happened:
            // reopen the account the leave came from (never changed; its origin's data is kept).
            "leave.clear" -> {
                leave.clear()
                val back = prefs.getString(LEAVE_HOST_KEY, null)?.takeIf { AccountUrl.isAccountHost(it, base) }
                prefs.edit().remove(LEAVE_HOST_KEY).apply()
                if (back != null && msg.optJSONObject("args")?.optBoolean("back") == true) {
                    answer(JSONObject().put("back", true))
                    setLocal(false)
                    prefs.edit().putString(HOST_KEY, back).apply()
                    host = back
                    reopen()
                } else answer(true)
            }
            // No url (bd med-ta2n.12, contract §7): no current web caller sends one (the Settings Move
            // row went with bd med-ta2n.5); an older page might. Stay in local mode and reload home
            // with ?invite=1, so the web opens F1. Not forget(): a move stash stays for the account F1 opens.
            "local.leave" -> {
                answer(true)
                reopen(Invite.withInvite(home))
            }
            // The camera-denied "Allow camera in Settings" (bd med-r1j2.19, media-capture.js openSettings):
            // this app's page in system Settings. Replies once launched, not on return. No NEW_TASK:
            // from the activity it stacks on our task, so Back returns to the app (a new task did not).
            "app.openSettings" -> runCatching {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
            }.fold({ answer(true) }, { answer(null, "no settings screen") })
            // Settings → App lock (local-policy.js mountLocalLockRow); available: the phone has a screen lock.
            "lock.status" -> answer(JSONObject().put("on", lock.on).put("available", deviceSecure()))
            "lock.set" -> setLock(msg.optJSONObject("args")?.optBoolean("on") == true) { answer(it == null) }
            "diag.append" -> diag("page " + (msg.optJSONObject("args")?.optString("entry") ?: ""))
            "health.authorize", "health.query" -> health.handle(op, msg.optJSONObject("args")) { r, e -> answer(r, e) }
            "attest.status", "attest.enroll", "attest.setPass", "attest.assert" ->
                attest.handle(op, msg.optJSONObject("args")) { r, e -> answer(r, e) }
            // Local mode's invite request + feedback POST (BasePost.kt): off the main thread, answered on it.
            "base.post" -> {
                val args = msg.optJSONObject("args") ?: JSONObject()
                val headers = when (val h = args.opt("headers")) {
                    null, JSONObject.NULL -> null
                    is JSONObject -> h.keys().asSequence().associateWith { h.opt(it) }
                    else -> h
                }
                BasePost.call(BuildConfig.BASE_DOMAIN, args.opt("path"), args.opt("body"), headers) { r, error ->
                    val result = r?.let { JSONObject().put("status", it.status).put("headers", JSONObject(it.headers)).put("body", it.body) }
                    runOnUiThread {
                        // Locked or left local mode mid-call: drop the reply — no native result behind the lock.
                        if (concealed || !LocalOrigin.opAllowed(op, local)) return@runOnUiThread
                        runCatching { answer(result, error) } // the WebView may be gone by now
                    }
                }
            }
            else -> if (op.startsWith("notifications.")) notifications.handle(op, msg.optJSONObject("args")) { r, e -> answer(r, e) }
                else answer(null, "unsupported: $op")
        }
    }

    // MARK: chrome — edge to edge, the page's colours behind the system bars

    private fun buildUi(): View {
        root = FrameLayout(this)
        web = makeWebView()
        root.addView(web)
        topBand = View(this)
        bottomBand = View(this)
        root.addView(topBand, FrameLayout.LayoutParams(MATCH_PARENT, 0, Gravity.TOP))
        root.addView(bottomBand, FrameLayout.LayoutParams(MATCH_PARENT, 0, Gravity.BOTTOM))
        errorView = buildError()
        lockView = buildLock()
        root.addView(errorView, MATCH_PARENT, MATCH_PARENT)
        root.addView(lockView, MATCH_PARENT, MATCH_PARENT)
        root.setOnApplyWindowInsetsListener { _, insets ->
            bars = insets
            layoutBars()
            WindowInsets.CONSUMED
        }
        return root
    }

    private fun layoutBars() {
        val sys = bars.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
        val ime = bars.getInsets(WindowInsets.Type.ime())
        val bottom = maxOf(sys.bottom, ime.bottom)
        web.layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT).apply {
            setMargins(sys.left, sys.top, sys.right, bottom)
        }
        topBand.layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, sys.top, Gravity.TOP)
        bottomBand.layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, sys.bottom, Gravity.BOTTOM)
        errorView.setPadding(sys.left, sys.top, sys.right, sys.bottom)
        // The lock fills the window so its mark sits at the window's centre, where the splash put
        // it (N6); only its foot clears the navigation bar. The lock hides the keyboard.
        lockView.setPadding(sys.left, 0, sys.right, 0)
        lockFoot.setPadding(24.dp, 12.dp, 24.dp, 16.dp + sys.bottom)
    }

    /** Bands and bar icons follow the page, or wg_screen while a native screen is up. */
    private fun updateChrome() {
        val native = errorView.visibility == View.VISIBLE || lockView.visibility == View.VISIBLE
        if (native) releaseSplash() // N6: a native screen is ready to show at once
        val top = if (native) SCREEN else topColor
        val bottom = if (native) SCREEN else bottomColor
        root.setBackgroundColor(top)
        topBand.setBackgroundColor(top)
        bottomBand.setBackgroundColor(bottom)
        val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
        val lightNav = WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        window.insetsController?.setSystemBarsAppearance(
            (if (isLight(top)) light else 0) or (if (isLight(bottom)) lightNav else 0),
            light or lightNav,
        )
        updateBack()
    }

    private val Int.dp get() = (this * resources.displayMetrics.density).toInt()

    private fun isLight(c: Int) = Color.luminance(c) > 0.5f

    /**
     * While the page shows, Back goes to the page while it can step (back.state), else — a page without
     * the app — walks the web view's history; at the root no callback, so predictive back peeks the launcher.
     */
    private fun updateBack() {
        val want = lockView.visibility != View.VISIBLE && errorView.visibility != View.VISIBLE && (pageCanStep ?: web.canGoBack())
        if (want == backRegistered) return
        if (want) onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, back)
        else onBackInvokedDispatcher.unregisterOnBackInvokedCallback(back)
        backRegistered = want
    }

    // MARK: native screens (kit token mirror, bd med-ckm5.14; Wg.kt + res/values/styles.xml)

    /** The browser (or the link's own app); nothing installed to take it is a silent no-op. */
    private fun openOutside(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (e: ActivityNotFoundException) {
        }
    }

    /** N4 load error (bd med-ckm5.16): the icon tile, title, lede and meta line; [showError] fills them. */
    private fun buildError(): View {
        errorIcon = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_INSIDE
            setPadding(17.dp, 17.dp, 17.dp, 17.dp) // 30dp icon in the 64dp tile
            layoutParams = LinearLayout.LayoutParams(64.dp, 64.dp).apply { gravity = Gravity.CENTER_HORIZONTAL }
        }
        errorTitle = wgText(R.style.Widget_Wg_Text_Title_Md).apply { gravity = Gravity.CENTER }
        errorLede = wgText(R.style.Widget_Wg_Text_Lede).apply { gravity = Gravity.CENTER }
        errorMeta = wgText(R.style.Widget_Wg_Text_Meta).apply { gravity = Gravity.CENTER }
        errorPrimary = wgButton(R.style.Widget_Wg_Button_Primary, "Try again") { retry() }
        errorSecondary = wgButton(R.style.Widget_Wg_Button, "Switch account") { forget() }
        val body = wgStack(16, errorIcon, errorTitle, errorLede, errorMeta).apply {
            setPadding(24.dp, 24.dp, 24.dp, 24.dp)
            gravity = Gravity.CENTER
        }
        val foot = wgStack(
            8, errorPrimary, errorSecondary,
            wgButton(R.style.Widget_Wg_Button_Ghost_Sm, "Copy diagnostics") { copyDiagnostics() },
        ).apply { setPadding(24.dp, 12.dp, 24.dp, 16.dp) }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.color.wg_screen)
            addView(wgScroll(body), LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
            addView(wgRule(R.color.wg_line))
            addView(foot)
            visibility = View.GONE
        }
    }

    // MARK: lock (bd med-nt9p.32.9)

    /**
     * N3, local mode's lock screen (bd med-ckm5.16): the 96dp mark tile at the window's centre (the
     * splash's spot, N6), no account name, Unlock the only control. A failed check adds the warn
     * note; a cancelled prompt lands on the plain locked state and stays: only the button asks again.
     */
    private fun buildLock(): View {
        unlockButton = wgButton(R.style.Widget_Wg_Button_Primary, "Unlock") { lock.begin()?.let { authenticate(it) } }
        lockNote = wgNote(Wg.Tone.WARN, R.drawable.ic_wg_alert, "Not recognised. Try again, or use your screen lock.").apply {
            visibility = View.GONE
        }
        val text = wgStack(
            16,
            wgText(R.style.Widget_Wg_Text_Title_Md, "Med Tracker is locked").apply { gravity = Gravity.CENTER },
            wgText(R.style.Widget_Wg_Text_Lede, "Unlock with your fingerprint, face or screen lock.").apply { gravity = Gravity.CENTER },
            lockNote,
        ).apply { setPadding(24.dp, 20.dp, 24.dp, 16.dp) }
        lockFoot = wgStack(8, unlockButton)
        // Two equal halves around the mark: it stays centred whatever the text below needs.
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.color.wg_screen)
            addView(Space(this@MainActivity), LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
            addView(ImageView(this@MainActivity).apply {
                setImageResource(R.drawable.wg_mark_lg)
                contentDescription = "Med Tracker"
            }, LinearLayout.LayoutParams(96.dp, 96.dp).apply { gravity = Gravity.CENTER_HORIZONTAL })
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                addView(wgScroll(text), LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
                addView(wgRule(R.color.wg_line))
                addView(lockFoot)
            }, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
            visibility = View.GONE
        }
    }

    /** The lock screen or the page, as the lock says; on unlock, what it held back. */
    private fun applyLock() {
        // No app-switcher snapshot while the lock is on (screenshots, and so the QA harness, still work).
        setRecentsScreenshotEnabled(!(local && lock.on))
        if (lock.on != screenOffRegistered) {
            if (lock.on) registerReceiver(screenOff, IntentFilter(Intent.ACTION_SCREEN_OFF), RECEIVER_NOT_EXPORTED)
            else unregisterReceiver(screenOff)
            screenOffRegistered = lock.on
        }
        unlockButton.isEnabled = lock.state != LocalLock.State.UNLOCKING
        lockNote.visibility = if (lock.failed || DebugHooks.qaLockFailed(this)) View.VISIBLE else View.GONE
        val hide = concealed
        if (hide == (lockView.visibility == View.VISIBLE)) return
        lockView.visibility = if (hide) View.VISIBLE else View.GONE
        if (hide) {
            // Out of the window the page is hidden: no visibilitychange work runs behind the lock.
            root.removeView(web)
            window.insetsController?.hide(WindowInsets.Type.ime())
        } else if (web.parent == null) {
            root.addView(web, 0)
            layoutBars()
        }
        updateChrome()
        if (hide) return
        deferredUrl?.let { deferredUrl = null; load(it) }
        deferredPath?.let { deferredPath = null; openPath(it) }
    }

    private fun authenticate(attempt: Int) {
        applyLock() // the Unlock button waits for this prompt
        deviceCheck("Unlock Med Tracker") { ok, cancelled ->
            lock.finish(attempt, ok, cancelled)
            applyLock()
        }
    }

    /**
     * Settings → App lock (lock.set): turning the lock on, or off while it
     * is on, applies only after the phone confirmed its owner. null, or why not.
     */
    private fun setLock(on: Boolean, done: (String?) -> Unit) {
        if (!on && !lock.on) return done(null)
        if (on && !deviceSecure()) return done("Set a screen lock in Android Settings first, or switch the lock off.")
        deviceCheck(if (on) "Turn on the lock for Med Tracker" else "Turn off the lock for Med Tracker") { ok, _ ->
            if (!ok) {
                done(
                    if (lock.on) "The lock is on from before, and changing it or opening Med Tracker needs your fingerprint, face or screen lock. Try again."
                    else "The lock was not turned on. Try again, or switch it off to continue without it."
                )
                return@deviceCheck
            }
            prefs.edit().putBoolean(LocalLock.KEY, on).apply()
            lock.confirmed(on)
            applyLock()
            done(null)
        }
    }

    /** The phone has a screen lock to check against. */
    private fun deviceSecure() = getSystemService(KeyguardManager::class.java).isDeviceSecure

    /**
     * BiometricPrompt with the screen lock as fallback. No screen lock (removed after the lock went
     * on) passes: the lock must never strand the only copy of the records.
     * done(ok, cancelled): a cancel (the user, or the app leaving the screen) is not a failure (N3).
     */
    private fun deviceCheck(title: String, done: (Boolean, Boolean) -> Unit) {
        if (!deviceSecure()) return done(true, false)
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                prompting = false
                done(true, false)
            }
            override fun onAuthenticationError(code: Int, message: CharSequence) {
                prompting = false
                done(code == BiometricPrompt.BIOMETRIC_ERROR_NO_DEVICE_CREDENTIAL, code in CANCELS)
            }
        }
        prompting = true
        runCatching {
            BiometricPrompt.Builder(this)
                .setTitle(title)
                .setAllowedAuthenticators(Authenticators.BIOMETRIC_WEAK or Authenticators.DEVICE_CREDENTIAL)
                .build()
                .authenticate(CancellationSignal(), mainExecutor, callback)
        }.onFailure {
            diag("shell lock prompt failed ${it.javaClass.simpleName}")
            prompting = false
            done(false, false)
        }
    }

    // MARK: diagnostics (bd med-nt9p.22)

    /** Appends one redacted line to the capped ceremony log. */
    private fun diag(line: String) {
        val log = diagPrefs.getString(DIAG_KEY, "") ?: ""
        diagPrefs.edit().putString(DIAG_KEY, Diag.append(log, line, base, Instant.now().toString())).apply()
    }

    private fun webAuthnMode(w: WebView): String {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) return "unsupported"
        return when (val m = WebSettingsCompat.getWebAuthenticationSupport(w.settings)) {
            WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_NONE -> "none"
            WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP -> "for-app"
            WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_BROWSER -> "for-browser"
            else -> "unknown($m)"
        }
    }

    /** Launcher shortcut or the load-error screen (N4): the device header plus the log, as plain text. */
    private fun copyDiagnostics() {
        val wv = WebViewCompat.getCurrentWebViewPackage(this)
        val credential = runCatching { Settings.Secure.getString(contentResolver, "credential_service") }.getOrNull()
        val autofill = runCatching { getSystemService(AutofillManager::class.java)?.autofillServiceComponentName?.flattenToShortString() }.getOrNull()
        val header = listOf(
            "Med Tracker diagnostics ${Instant.now()}",
            "app ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) ${BuildConfig.BUILD_TYPE}",
            "Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT}) ${Build.MANUFACTURER} ${Build.MODEL}",
            "WebView ${wv?.packageName} ${wv?.versionName}",
            "credential provider ${credential?.takeIf { it.isNotBlank() } ?: "unavailable"}; autofill ${autofill ?: "unavailable"}",
            "webauthn ${if (::web.isInitialized) webAuthnMode(web) else "not started"}",
        ).joinToString("\n")
        val text = Diag.redact(header, base) + "\n\n" + (diagPrefs.getString(DIAG_KEY, "") ?: "")
        getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Med Tracker diagnostics", text))
        Toast.makeText(this, "Diagnostics copied", Toast.LENGTH_SHORT).show()
    }

    private companion object {
        /** Slot writes in this process (setInvite, main thread): a late referrer never overrides one. */
        var slotWrites = 0
        /** The page-facing bridge global, window.wgNative — med-nt9p.6 and .19 detect the Android shell by it. */
        const val BRIDGE = "wgNative"
        /** N6's cap on holding the splash for a page that never reports ready. */
        const val SPLASH_MAX_MS = 5_000L
        /** Cap on holding invite.pending for the referrer read; below invite.js's 15 s box on that read. */
        const val REFERRER_HOLD_MS = 10_000L
        /** BiometricPrompt errors that are a dismissal, not a failed check (N3: no note). */
        val CANCELS = setOf(
            BiometricPrompt.BIOMETRIC_ERROR_CANCELED,
            BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED,
        )
        /** N4's meta line when the response carries no reason phrase. */
        val STATUS_TEXT = mapOf(
            404 to "not found", 500 to "internal server error", 502 to "bad gateway",
            503 to "service unavailable", 504 to "gateway timeout",
        )
        /** N4's meta line time. */
        val HH_MM: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")
        const val HOST_KEY = "accountHost"
        const val LEAVE_HOST_KEY = "leaveHost"
        const val ACTION_SWITCH = "com.example.medtracker.SWITCH_ACCOUNT"
        const val ACTION_DIAG = "com.example.medtracker.COPY_DIAGNOSTICS"
        const val DIAG_KEY = "log"
        /** --wg-bg-screen: the bands' colour until the page reports its own. */
        val SCREEN = Wg.SCREEN
    }
}
