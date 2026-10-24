import os
import SwiftUI
import UIKit
import WebKit

/// The shell (bd med-w6gx.3): one WKWebView on the account origin
/// https://<sub>.<base>/, exactly like the PWA. The app remembers only the
/// account host; everything else (vault, Service Worker, IndexedDB) lives in the
/// persistent default website data store, per origin. Local mode (bd
/// med-o7zq.4) puts the same web view on the bundled app at wgapp://local/
/// instead (LocalApp.swift): no account, data only in that origin.
@MainActor
final class Shell: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
    static let hostKey = "wgAccountHost"
    /// Settings.bundle toggle (iOS Settings → Med Tracker → Switch account).
    static let forgetKey = "wgForgetAccount"
    /// The account that account.leave {then: "local"} left (bd med-o7zq.42):
    /// a Cancel in the local page's leave pickup goes back to it (leave.clear
    /// {back: true}). Cleared by every leave.clear and every other forget().
    static let leaveHostKey = "wgLeaveHost"
    /// --wg-bg-screen: the bands' colour until the page reports its own.
    static let screen = UIColor(red: 0x13 / 255, green: 0x2D / 255, blue: 0x29 / 255, alpha: 1)

    let base = (Bundle.main.object(forInfoDictionaryKey: "WGBaseDomain") as? String ?? "").lowercased()
    let webView: WKWebView
    @Published private(set) var host: String? {
        didSet { Notifications.shared.vault = vault }
    }
    /// Local mode, from the persisted choice (LocalOrigin.modeKey); wins over a stored host.
    @Published private(set) var local = UserDefaults.standard.bool(forKey: LocalOrigin.modeKey) {
        didSet {
            Notifications.shared.vault = vault
            // Entering local mode again (forget(), the Settings toggle,
            // account.leave {then: "local"}) abandons a pending move; the next
            // move stashes afresh (bd med-o7zq.35).
            if local {
                move.clear()
                JoinErase.clear() // a join's erase never outlives a return to local mode (bd med-r1j2.7)
            }
        }
    }
    /// The local → cloud move's stash (bd med-o7zq.35, Move.swift).
    let move = Move(dir: Move.appDir)
    /// The account → local move's stash (bd med-o7zq.36, same Move): Application
    /// Support/leave, beside move/. Kept across local.didSet and forget(), so it
    /// survives account.leave {then: "local"}; cleared by leave.clear,
    /// local.reset and opening an account.
    let leaveStash = Move(dir: Move.appDir.deletingLastPathComponent().appendingPathComponent("leave", isDirectory: true))
    /// The vault the shell has open (bd med-o7zq.9): one at a time, so
    /// reminders, their taps and the bridge all follow this.
    private var vault: String? { local ? LocalOrigin.host : host }
    @Published private(set) var loadError: LoadError? {
        didSet { if loadError != nil { painted = true } }
    }
    /// The first page reported ready (N6): RootView fades the launch mark out.
    @Published private(set) var painted = false
    /// Behind the status bar and the home indicator: the page's own colours at its top and bottom edge.
    @Published private(set) var top = Color(uiColor: Shell.screen)
    @Published private(set) var bottom = Color(uiColor: Shell.screen)
    /// In memory only: Try again must keep an invite link's #claim= fragment.
    private var lastURL: URL?
    /// Host of the last committed page: WKWebView.url already names the
    /// provisional one while a load is in flight.
    private var committedHost: String?
    /// Local mode's optional lock (bd med-o7zq.8, LocalLock.swift).
    @Published private(set) var lock = LocalLock(on: UserDefaults.standard.bool(forKey: LocalLock.onKey)) {
        didSet { UserDefaults.standard.set(lock.on, forKey: LocalLock.onKey) }
    }
    /// "Copy diagnostics" ran (bd med-w6gx.24): RootView confirms it.
    @Published var diagCopied = false
    /// The live shell, for the Home Screen quick action (QuickAction below).
    static weak var current: Shell?
    /// The quick action launched the app before the shell existed.
    static var copyOnLaunch = false
    /// What the lock held back: a load and a notification tap, run on unlock.
    private var deferredURL: URL?
    private var deferredReminder: (String, String?)?
    /// local.erase is wiping wgapp://local: every load() waits in heldLoad
    /// and no wgapp navigation is allowed until it ends, so no local page
    /// runs (or writes) beside a half-done wipe.
    private var erasing = false
    private var heldLoad: URL?

    private func endErase() {
        erasing = false
        if let url = heldLoad {
            heldLoad = nil
            load(url)
        }
    }

    /// The lock holds: the page is out of the window, loads wait, the bridge says "locked".
    var concealed: Bool { lock.holds(local: local) }

    override init() {
        let config = WKWebViewConfiguration()
        // Service Workers in WKWebView need the page on a WKAppBoundDomains entry
        // (Info.plist, from project.yml) with navigation limited to them.
        config.limitsNavigationsToAppBoundDomains = true
        config.allowsInlineMediaPlayback = true // barcode/photo preview stays inline
        // No ignoresViewportScaleLimits (med-r6sh): the page caps maximum-scale=1
        // on iOS (wg-sheet.js noFocusZoom, med-pe9g), and honouring that cap is
        // what turns off double-tap zoom. The flag kept pinch-zoom but made the
        // page scalable again, and a double-tap on a card zoomed it (build 351).
        config.userContentController.addUserScript(
            WKUserScript(source: Shell.pageJS, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .page))
        config.userContentController.addUserScript(
            WKUserScript(source: Shell.sessionWipeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        Downloads.shared.install(on: config)
        config.setURLSchemeHandler(LocalApp.shared, forURLScheme: LocalOrigin.scheme)
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        Downloads.shared.held = { [weak self] in self?.concealed ?? false }
        config.userContentController.add(self, contentWorld: .page, name: "wgChrome")
        // Its presence is what makes web/static/js/native/index.js pick the 'ios' platform.
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "wgNative")
        webView.navigationDelegate = self
        webView.uiDelegate = self // getUserMedia's permission only (bd med-r1j2.18)
        // The selector WebKit asks for must be the one implemented below (a
        // misnamed optional delegate method compiles and is never called); a
        // Debug build (the simulator QA run) traps if it is not.
        assert(responds(to: #selector(WKUIDelegate.webView(_:requestMediaCapturePermissionFor:initiatedByFrame:type:decisionHandler:))))
        // The page sits between the native bands (RootView), so nothing scrolls
        // under the status bar and no white shows around it.
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        #if DEBUG
        webView.isInspectable = true // Safari Web Inspector on the Simulator (bd med-y5xx.2); never in the Release archive
        #endif

        let defaults = UserDefaults.standard
        // Spike builds (med-w6gx.2) kept the last URL: adopt its account.
        if defaults.string(forKey: Shell.hostKey) == nil,
           let host = defaults.string(forKey: "wgSpikeLastURL").flatMap({ AccountURL.parse($0, base: base) })?.host {
            defaults.set(host, forKey: Shell.hostKey)
        }
        defaults.removeObject(forKey: "wgSpikeLastURL")
        defaults.removeObject(forKey: "wgSpikeLog")
        host = defaults.string(forKey: Shell.hostKey).flatMap { AccountURL.isAccountHost($0, base: base) ? $0 : nil }
        let qa = qaLoadError() // before the line below: its network screens set a host
        // No native first run (bd med-ta2n.17): without an account the app
        // opens in local mode; applySettings persists it.
        if host == nil, !local { local = true }
        Notifications.shared.vault = vault // observers don't run in init; a switch in applySettings must see the old vault
        applySettings()
        if local { LocalOrigin.includeInBackup() } // a dir an earlier launch created
        // Launch state for a support sysdiagnose (bd med-o7zq.31); no host name, no data.
        Logger(subsystem: Bundle.main.bundleIdentifier ?? "MedTracker", category: "shell").notice(
            "launch mode=\(self.local ? "local" : "account", privacy: .public) host=\(self.host != nil, privacy: .public) localDataDirs=\(LocalOrigin.dataDirs().count, privacy: .public)")
        Shell.current = self
        if Shell.copyOnLaunch {
            Shell.copyOnLaunch = false
            copyDiagnostics()
        }
        #if DEBUG
        if let link = Shell.qaCapture { capture(link) } // nothing committed yet: only the slot
        // native-local-erased: local.erase's wipe on the seeded store before
        // the first page, which then has nothing left (W1).
        if UserDefaults.standard.bool(forKey: "wgQAEraseLocal") {
            Task {
                let left = await Shell.eraseLocalOrigin(proceed: { true })
                diag("qa local erase \(left.map(String.init) ?? "cancelled")")
                if !qa { retry() }
            }
        } else if !qa { retry() }
        #else
        if !qa { retry() }
        #endif
        Notifications.shared.onOpen = { [weak self] path, vault in self?.openReminder(path, of: vault) }
    }

    /// A notification tap (bd med-w6gx.5, med-w6gx.20): hand the open page the
    /// reminder's deeplink (the take sheet for a dose, else its section) as
    /// cloud-boot.js does for a Web Push tap, or load the vault on it — the
    /// deep-link router reads either. A tap on another vault's reminder —
    /// delivered before a mode or account switch — is ignored (bd med-o7zq.9);
    /// untagged ones predate the tag.
    func openReminder(_ raw: String, of owner: String?) {
        guard owner == nil || owner == vault, let home else { return }
        if concealed {
            deferredReminder = (raw, owner)
            return
        }
        let path = ReminderPath.sanitize(raw)
        guard let url = URL(string: path, relativeTo: home)?.absoluteURL else { return }
        guard showingAccount, !webView.isLoading,
              let json = try? JSONSerialization.data(withJSONObject: path, options: .fragmentsAllowed),
              let quoted = String(data: json, encoding: .utf8) else { return load(url) }
        // A page without the router (e.g. the unlock page) loads the path
        // instead, its own URL untouched (bd med-w6gx.27, Android #1273).
        webView.evaluateJavaScript(
            "!!window.handleDeepLinks && (history.replaceState({}, '', \(quoted)), window.handleDeepLinks(), true)"
        ) { [weak self] result, _ in
            if result as? Bool != true { self?.load(url) }
        }
    }

    /// The page this mode opens on: the bundled app, or the account's root.
    private var home: URL? {
        local ? Shell.localHome : host.flatMap { URL(string: "https://\($0)/") }
    }

    #if DEBUG
    /// Visual QA scene (bd med-y5xx.2, LocalOrigin.qaHome): Debug builds only.
    /// `-wgQACapture <link>` (add-device-from-link): the link fills the invite
    /// slot at launch as if the app had been opened with it, and the scene runs
    /// on the real clock (`&clock=real`, tests/visual/driver.js) so the page's
    /// 10-minute join check compares like with like.
    private static let qaCapture = UserDefaults.standard.string(forKey: "wgQACapture").flatMap { URL(string: $0) }
    private static let localHome = LocalOrigin.qaHome(scene: UserDefaults.standard.string(forKey: LocalOrigin.qaSceneKey))
        .flatMap { qaCapture == nil ? $0 : URL(string: $0.absoluteString + "&clock=real") } ?? LocalOrigin.home
    #else
    private static let localHome = LocalOrigin.home
    #endif

    /// Opens an account URL (validated by AccountURL.parse) from either mode:
    /// local.leave/account.leave {url} (bd med-ta2n.11).
    /// The move stash is the caller's call (account.leave {url} drops it).
    private func enter(_ url: URL, host: String) {
        let defaults = UserDefaults.standard
        defaults.set(host, forKey: Shell.hostKey)
        defaults.set(false, forKey: LocalOrigin.modeKey)
        defaults.removeObject(forKey: Shell.leaveHostKey)
        JoinErase.clear() // opening any account drops a pending join's erase; local.leave {erase} re-arms it
        setInvite(nil) // whatever invite was waiting, this open consumed or superseded it
        self.host = host
        local = false
        leaveStash.clear() // an account was opened, so a pending account → local move was abandoned
        reopen(to: url) // the claim link keeps its #fragment for the page; only the host is stored
    }

    private func setInvite(_ url: URL?) {
        if let url { InviteSlot.store(url) } else { InviteSlot.clear() }
    }

    /// HOME with ?invite=1 (contract med-ta2n.7 §6-7): the booting page reads
    /// the slot, or with none opens the "Have an invite?" sheet (F1).
    private var inviteHome: URL? {
        guard let home, var parts = URLComponents(url: home, resolvingAgainstBaseURL: false) else { return nil }
        parts.queryItems = (parts.queryItems ?? []) + [URLQueryItem(name: "invite", value: "1")]
        return parts.url
    }

    /// An invite link opened the app (bd med-ta2n.11, contract med-ta2n.7 §6):
    /// the landing universal link or the medtracker:// scheme. It goes into the
    /// pending slot (newest wins) and never opens by itself — any page can fire
    /// the scheme. A loaded page reloads home with ?invite=1 so the web reads
    /// the slot; on a cold start the booting page reads it anyway.
    func capture(_ link: URL) {
        guard let claim = AccountURL.parseInvite(link.absoluteString, base: base) else { return }
        setInvite(claim)
        if committedHost != nil, let url = inviteHome { load(url) } // deferred under the lock like any load
    }

    func retry() {
        if let url = lastURL ?? home { load(url) }
    }

    /// Leaves the account (Settings.bundle Switch account, X-Account-Gone,
    /// the error screen, account.leave) into local mode — the app has no
    /// native first run (bd med-ta2n.17). Plain: on home?invite=1, where the
    /// web offers "Have an invite?", with no way back. `.local`
    /// (account.leave {then: "local"}, bd med-o7zq.34): on local home,
    /// remembering the account for leave.clear {back}. `.forgetLocal`
    /// ({then: "local", forget: true}, bd med-r1j2.18): on local home, no way
    /// back. Website data is kept:
    /// it is per origin, so returning to this account later still finds its
    /// data. The move stash is dropped: from local mode (Settings.bundle) a
    /// stale snapshot would bring deleted rows back into the next account.
    func forget(_ to: LocalOrigin.Leave = .invite) {
        let defaults = UserDefaults.standard
        if to == .local, let host { defaults.set(host, forKey: Shell.leaveHostKey) }
        else { defaults.removeObject(forKey: Shell.leaveHostKey) }
        defaults.removeObject(forKey: Shell.hostKey)
        defaults.set(true, forKey: LocalOrigin.modeKey)
        host = nil
        local = true
        move.clear() // local.didSet does too; this one is load-bearing
        reopen(to: to == .invite ? inviteHome : nil)
    }

    /// Runs at launch and whenever the app becomes active.
    func applySettings() {
        let defaults = UserDefaults.standard
        if defaults.bool(forKey: Shell.forgetKey) {
            defaults.set(false, forKey: Shell.forgetKey)
            forget()
        }
        // No account means local mode (bd med-ta2n.17), whatever the Settings
        // toggle says. Persisting it the first time drops a move stash a
        // phase-1 native first run kept: a stale snapshot by now.
        if host == nil, !defaults.bool(forKey: LocalOrigin.modeKey) {
            defaults.set(true, forKey: LocalOrigin.modeKey)
            move.clear()
        }
        let wantLocal = host == nil || defaults.bool(forKey: LocalOrigin.modeKey)
        if wantLocal != local {
            local = wantLocal
            reopen()
        }
    }

    /// The app went to the background, where backups run: no new origin dir
    /// of the local app may stay excluded from them. The lock closes here, not
    /// on inactive (Control Center, the Face ID sheet itself); RootView covers
    /// the window on inactive so the app-switcher snapshot shows no data.
    func didEnterBackground() {
        if local { LocalOrigin.includeInBackup() }
        lock.background()
        if concealed {
            // A share, export or print sheet would stay over the lock screen (a
            // vault export in it); closing it deletes the temp file.
            let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene
            scene?.windows.first?.rootViewController?.dismiss(animated: false)
            Downloads.shared.dropExports()
            UIPrintInteractionController.shared.dismiss(animated: false)
        }
    }

    /// The app became active (after applySettings): the lock prompts once per
    /// launch or return from the background.
    func didBecomeActive() {
        let setting = UserDefaults.standard.bool(forKey: LocalLock.settingKey)
        if let attempt = lock.activate(local: local, setting: setting) { authenticate(attempt) }
        // Notifications newly allowed (the reminders Enable's system prompt, or
        // iOS Settings): the token arrives and the page hears 'token' (bd med-erq1.4).
        Task { await registerPush() }
    }

    // MARK: native push (bd med-erq1.4, Push.swift; twin of Android med-erq1.5)

    /// The APNs device token (hex), from QuickAction's didRegister. Memory
    /// only: iOS hands it over again on every registration.
    private var pushToken: String?

    /// Account mode with notifications allowed: ask iOS for the token. Local
    /// mode never registers (checked again after the await). Returns whether it asked.
    @discardableResult
    func registerPush() async -> Bool {
        guard !local, await Notifications.shared.permission() == "granted", !local else { return false }
        UIApplication.shared.registerForRemoteNotifications()
        return true
    }

    /// didRegisterForRemoteNotificationsWithDeviceToken: a first or changed
    /// token tells the page to register it again.
    func pushRegistered(_ token: String) {
        guard token != pushToken else { return }
        pushToken = token
        diag("shell push token \(Push.fingerprint(token))")
        pushEvent("token")
    }

    /// Document event wg:native-push {kind} on this account's page whose vault
    /// is unlocked; `done` gets whether the page took it, exactly once: a page
    /// that does not answer within Push.answer counts as not taking it.
    func pushEvent(_ kind: String, done: @escaping (Bool) -> Void = { _ in }) {
        guard !local, showingAccount, loadError == nil, let js = Push.event(kind) else { return done(false) }
        var pending: ((Bool) -> Void)? = done
        let finish = { (took: Bool) in
            pending?(took)
            pending = nil
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Push.answer) { finish(false) }
        webView.evaluateJavaScript(js) { result, _ in finish(result as? Bool == true) }
    }

    /// The lock screen's Unlock button.
    func unlock() {
        if let attempt = lock.begin() { authenticate(attempt) }
    }

    private func authenticate(_ attempt: Int) {
        Task {
            let result = await DeviceAuth.check(reason: "Unlock Med Tracker")
            lock.finish(attempt, result, setting: UserDefaults.standard.bool(forKey: LocalLock.settingKey))
            guard !concealed else { return }
            if let url = deferredURL {
                deferredURL = nil
                load(url)
            }
            if let tap = deferredReminder {
                deferredReminder = nil
                openReminder(tap.0, of: tap.1)
            }
        }
    }

    /// Local onboarding's choice, or Settings → App lock (bridge op lock.set):
    /// turning the lock on, or off while it is
    /// still on, applies only after the phone confirmed its owner.
    func setLock(_ on: Bool) async -> Bool {
        guard on || lock.on else { return true }
        let reason = on ? "Turn on the lock for Med Tracker" : "Turn off the lock for Med Tracker"
        guard await DeviceAuth.check(reason: reason) == .ok else { return false }
        UserDefaults.standard.set(on, forKey: LocalLock.settingKey)
        lock.confirmed(on: on)
        return true
    }

    /// Mode or account changed: open the new home (or `url` on it), or stop the old page.
    private func reopen(to url: URL? = nil) {
        lastURL = nil
        committedHost = nil
        loadError = nil
        deferredURL = nil
        deferredReminder = nil
        if concealed { webView.loadHTMLString("", baseURL: nil) } // the old page must not run behind the lock
        if let target = url ?? home { load(target) } else { webView.loadHTMLString("", baseURL: nil) }
    }

    private func load(_ url: URL) {
        loadError = nil
        lastURL = url
        if erasing {
            heldLoad = url
            return
        }
        if concealed {
            deferredURL = url
            return
        }
        webView.load(URLRequest(url: url))
    }

    /// An account page: never in local mode, whatever host is still stored.
    private func isInside(_ h: String?) -> Bool {
        guard !local, let h = h?.lowercased() else { return false }
        return h == host || h == base
    }

    // MARK: WKNavigationDelegate

    /// Only the account host and the base domain load in the app — in local
    /// mode only wgapp://local, and any other wgapp URL is cancelled; any
    /// other link opens in Safari (or the app owning its scheme: mailto:, tel:, …).
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        switch url.scheme?.lowercased() {
        case "http", "https":
            if isInside(url.host) {
                if action.targetFrame == nil { // target=_blank / window.open: no second window in the shell
                    webView.load(action.request)
                    return .cancel
                }
                return Downloads.policy(for: action)
            }
            // Subframes stay with WebKit: the app-bound limit already blocks foreign ones.
            if action.targetFrame?.isMainFrame == false { return .allow }
            // A late history.back() into the other mode's or a previous
            // account's page (bd med-o7zq.47, Android #1251): stay put, never Safari.
            if action.navigationType == .backForward { return .cancel }
        case LocalOrigin.scheme:
            guard local, url.host?.lowercased() == LocalOrigin.host else { return .cancel }
            // A reload or page navigation outside load() (process restart,
            // location.reload) waits for local.erase like a load() does.
            if erasing {
                if action.targetFrame?.isMainFrame != false, heldLoad == nil { heldLoad = url }
                return .cancel
            }
            if action.targetFrame == nil {
                webView.load(action.request)
                return .cancel
            }
            return Downloads.policy(for: action)
        case "blob", "data", "about":
            return Downloads.policy(for: action)
        default:
            break
        }
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
        return .cancel
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        // An HTTP error before any page of this account showed — a mistyped or
        // deleted account answers 404 — gets the error screen (Switch account)
        // instead of a bare error page the user cannot leave.
        if navigationResponse.isForMainFrame, let http = navigationResponse.response as? HTTPURLResponse,
           http.statusCode >= 400, !showingAccount {
            // The server says the stored account is gone (deleted, expired or a
            // typo; bd med-w6gx.22): forget it — local mode on home?invite=1,
            // no way back (contract med-ta2n.7 §7). A 404 without the marker
            // (a proxy's during a redeploy, an older server) keeps the error
            // screen with Try again.
            if let h = http.url?.host?.lowercased(), h == host, AccountURL.accountGone(http.statusCode, http.allHeaderFields) {
                diag("shell account gone")
                forget()
                return .cancel
            }
            let status = "\(http.statusCode) · \(HTTPURLResponse.localizedString(forStatusCode: http.statusCode))"
            loadError = local ? LoadError(.local, "local · " + status)
                : LoadError(http.statusCode == 404 ? .notFound : .network, status)
            diag("shell load http \(http.statusCode)")
            return .cancel
        }
        return Downloads.policy(for: navigationResponse)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = Downloads.shared
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = Downloads.shared
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadError = nil
        painted = true
        if local { LocalOrigin.includeInBackup() }
    }

    /// Offline with a Service Worker in control never gets here: the worker
    /// answers. This is the first-ever load failing (no network, no cache yet).
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let e = error as NSError
        // -999 superseded by another load; 102 interrupted by policy (external link, download).
        if (e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled) || (e.domain == "WebKitErrorDomain" && e.code == 102) { return }
        // A page of this account already showing stays usable.
        if !showingAccount {
            loadError = local ? LoadError(.local, "local · bundle failed to load · \(e.code)")
                : LoadError(.network, "error \(e.code) · " + e.localizedDescription.trimmingCharacters(in: CharacterSet(charactersIn: ".")))
        }
        diag("shell load failed \(e.domain) \(e.code)")
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        committedHost = webView.url?.host?.lowercased()
    }

    private var showingAccount: Bool {
        guard let committedHost else { return false }
        return committedHost == (local ? LocalOrigin.host : host)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if concealed, let url = webView.url {
            deferredURL = url
            return
        }
        if webView.url == nil { retry() } else { webView.reload() } // reload keeps the current URL and fragment
    }

    // MARK: WKUIDelegate

    /// getUserMedia (bd med-r1j2.18): the add-device scanner (/claim#scan, W5)
    /// and the food scanner get the camera without WebKit's per-page prompt;
    /// the decision is LocalOrigin.media.
    /// The completion-handler spelling on purpose: the async one is imported
    /// as decideMediaCapturePermissionsFor, so a misnamed async method would
    /// silently never be called.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let own = LocalOrigin.isOwn(scheme: origin.protocol, host: origin.host, port: origin.port,
                                    mainFrame: frame.isMainFrame, local: local, account: host)
        switch LocalOrigin.media(cameraOnly: type == .camera, own: own && !concealed) {
        case .grant: decisionHandler(.grant)
        case .prompt: decisionHandler(.prompt)
        case .deny: decisionHandler(.deny)
        }
    }

    // MARK: wgChrome messages

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: String] else { return }
        painted = true // the page's first sample: it has painted
        if let c = body["top"].flatMap(Shell.color) { top = Color(uiColor: c) }
        if let c = body["bottom"].flatMap(Shell.color) { bottom = Color(uiColor: c) }
    }

    // MARK: wgNative — the native/ bridge (bd med-w6gx.4)

    /// web/static/js/native/index.js `call(op, args)` posts {op, args}; the reply
    /// resolves its promise, an error string rejects it. Capabilities add ops
    /// here (notifications.* med-w6gx.5, health.* med-w6gx.6, attest.* med-o7zq.16).
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        // Only the account's own top-level page — in local mode only the
        // bundled app's — reaches native capabilities.
        let origin = message.frameInfo.securityOrigin
        guard LocalOrigin.isOwn(scheme: origin.protocol, host: origin.host, port: origin.port,
                                mainFrame: message.frameInfo.isMainFrame, local: local, account: host) else {
            replyHandler(nil, "forbidden")
            return
        }
        // A page still running behind the lock gets no native capability.
        guard !concealed else {
            replyHandler(nil, "locked")
            return
        }
        let body = message.body as? [String: Any] ?? [:]
        switch body["op"] as? String {
        case "ping":
            replyHandler("pong", nil)
        case "shell.ops":
            replyHandler(LocalOrigin.ops(local: local), nil)
        case "diag.append":
            // The passkey ceremony log (bd med-w6gx.24, web/cloud/js/passkey-diag.js); the page does not wait.
            diag("page " + ((body["args"] as? [String: Any])?["entry"] as? String ?? ""))
            replyHandler(nil, nil)
        case "setEgressHosts" where local:
            let (reply, error) = LocalOrigin.setEgressHosts(body["args"] as? [String: Any] ?? [:])
            replyHandler(reply, error)
        case "local.reset" where local:
            // The page has erased its own storage (local-policy.js eraseDevice);
            // the shell's share of this vault is its reminders and host mirror.
            UserDefaults.standard.removeObject(forKey: LocalOrigin.hostsKey)
            // A stale account must not come back on a later leave.clear {back} (bd med-w6gx.28, Android #1217).
            UserDefaults.standard.removeObject(forKey: Shell.leaveHostKey)
            move.clear()
            leaveStash.clear()
            setInvite(nil) // no claim token left behind after Erase
            Task {
                await Notifications.shared.remove(vault: LocalOrigin.host)
                replyHandler(true, nil)
            }
        // Settings → App lock (bd med-o7zq.39, local-policy.js mountLocalLockRow;
        // twin of Android med-nt9p.32.9). Same key as iPhone Settings → Lock, so
        // both stay in sync. available: the phone can check its owner. lock.set
        // is the intro's Start path: true once applied, false when cancelled.
        case "lock.status" where local:
            replyHandler(["on": lock.on, "available": DeviceAuth.available], nil)
        case "lock.set" where local:
            let on = (body["args"] as? [String: Any])?["on"] as? Bool == true
            // No passcode: DeviceAuth.check lets anyone in, so there is nothing to turn on.
            guard !on || DeviceAuth.available else { return replyHandler(false, nil) }
            Task { replyHandler(await setLock(on), nil) }
        // The pending-invite slot (bd med-ta2n.11, InviteSlot): the page reads it once per boot.
        case "invite.pending":
            replyHandler(InviteSlot.pending() ?? NSNull(), nil)
        case "invite.clear":
            setInvite(nil)
            replyHandler(true, nil)
        // "Join and erase" (bd med-r1j2.7, AD9; contract with Android med-r1j2.8:
        // {} → true). The joined account's unlocked boot sends it (cloud-boot.js
        // finishJoinErase). Only while JoinErase still holds this account (the
        // add-device code's 10 minutes): the local vault's erase — the local
        // origin's website data plus local.reset's share. Anywhere else, local
        // mode included (listed there for invite.js's probe), a no-op.
        // The intent (host + its stamp) is captured here and re-checked right
        // before each destructive step: a switch to local mode, another
        // account, a newer intent or the TTL running out in between cancels
        // the wipe. Every load and wgapp navigation while it runs waits for it
        // (load, decidePolicyFor), so no local page runs beside a half-done wipe. Native state is
        // spent only after a verified wipe; a failed one answers "erase
        // failed" and keeps the intent for the page's retry (twin of Android).
        // Only {enrolled: true} acts: the boot right after this tab's claim
        // enrolled (cloud-boot.js). The #1336 page's bare {} ran on every
        // unlocked boot, a failed join's included, so it is a no-op.
        case "local.erase":
            let enrolled = (body["args"] as? [String: Any])?["enrolled"] as? Bool == true
            // A wipe still running (the page's Try again after its timeout) is
            // not a success: "busy", and the page keeps showing the failure.
            if enrolled, erasing { return replyHandler(nil, "busy") }
            guard enrolled, !local, let from = host, JoinErase.due(from), let at = JoinErase.stamp() else {
                return replyHandler(true, nil)
            }
            let due = { [weak self] () -> Bool in
                guard let self else { return false }
                return !self.local && self.host == from && JoinErase.due(from, stamp: at)
            }
            erasing = true
            Task {
                // One retry: a delete blocked by the shell page's old connection
                // has usually finished by then.
                var left = await Shell.eraseLocalOrigin(proceed: due)
                if let l = left, l != 0 { left = await Shell.eraseLocalOrigin(proceed: due) }
                if left == 0, due() {
                    JoinErase.clear() // spent: a second boot of this account erases nothing
                    UserDefaults.standard.removeObject(forKey: LocalOrigin.hostsKey)
                    UserDefaults.standard.removeObject(forKey: Shell.leaveHostKey)
                    move.clear()
                    leaveStash.clear()
                    await Notifications.shared.remove(vault: LocalOrigin.host)
                }
                // No host, no data in the log.
                diag("shell local.erase " + (left.map { $0 == 0 ? "wiped" : "incomplete (\($0))" } ?? "cancelled"))
                endErase()
                if let l = left, l != 0 { replyHandler(nil, "erase failed") } else { replyHandler(true, nil) }
            }
        // {url} (bd med-ta2n.11, contract med-ta2n.7 §7): open that account's
        // claim link from either mode — validated, else "invalid url" and
        // nothing changes; the slot is consumed. account.leave ignores then.
        // A present url key always takes this path: null, empty or non-string
        // is "invalid url", never the destructive no-url leave (contract A3).
        case "local.leave" where local, "account.leave" where !local:
            let args = body["args"] as? [String: Any] ?? [:]
            if let raw = args["url"] {
                guard let url = (raw as? String).flatMap({ AccountURL.parse($0, base: base) }), let h = url.host else {
                    return replyHandler(nil, "invalid url")
                }
                replyHandler(true, nil)
                // Only local.leave's move stash is for the new account; from
                // an account, a stale one must not land in the next account.
                // "Join and erase" (bd med-r1j2.7) is no merge: no stash either.
                // Only for an add-device claim link (/claim#<slot>.<TK>), never an invite.
                let erase = local && args["erase"] as? Bool == true && url.path == "/claim"
                if !local || erase { move.clear() }
                enter(url, host: h)
                if erase { JoinErase.remember(h) }
            } else if local {
                // Without a url (bd med-ta2n.17): no web caller since the
                // Settings Move row went (#1255; the P3 sheet always passes
                // {url}). Stays local, nothing
                // else changes (a stash waits for the invite); home?invite=1
                // opens "Have an invite?".
                replyHandler(true, nil)
                if let url = inviteHome { reopen(to: url) }
            } else {
                // account.leave leaves the account (it and this origin's data
                // stay): {then: "local"} is Settings → Account "Use this iPhone
                // without an account", onto local home with the way back (bd
                // med-o7zq.34); no args (account deletion, the ceremony's "Not
                // your account?") onto local home?invite=1, no way back;
                // {then: "local", forget: true} (/unlock "Back to local mode",
                // bd med-r1j2.18) onto local home, no way back.
                replyHandler(true, nil)
                forget(LocalOrigin.leave(args))
            }
        // AD13 "Allow camera in Settings" (bd med-r1j2.18, twin of Android):
        // {} → true, this app's page in iOS Settings.
        case "app.openSettings":
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            replyHandler(true, nil)
        // The local → cloud move (bd med-o7zq.35, twin of Android med-nt9p.32.17):
        // the local page stashes its vault v1 JSON before local.leave; the new
        // account takes it and clears it once imported, so a failed import
        // retries on the next open. Errors never carry the contents or the path.
        // ponytail: synchronous file I/O on the main thread; move it off if a 64 MB vault ever janks.
        case "move.stash" where local:
            do {
                try move.stash((body["args"] as? [String: Any])?["vault"])
                replyHandler(true, nil)
            } catch {
                replyHandler(nil, (error as? Move.Failure)?.message ?? "write failed")
            }
        case "move.take" where !local:
            do {
                if let vault = try move.take() { replyHandler(["vault": vault], nil) } else { replyHandler(NSNull(), nil) }
            } catch {
                replyHandler(nil, "read failed")
            }
        case "move.clear" where !local:
            move.clear()
            replyHandler(true, nil)
        // Native push (bd med-erq1.4, account mode only): {platform, token}, or
        // null without the notification grant or before APNs answered — the
        // 'token' event follows once it does.
        case "push.token" where !local:
            Task {
                let asked = await registerPush()
                guard asked, !local, let t = pushToken else { return replyHandler(NSNull(), nil) }
                replyHandler(["platform": "ios", "token": t], nil)
            }
        // The account → local move (bd med-o7zq.36), the reverse of move.*: the
        // account page stashes its vault v1 JSON before account.leave {then:
        // "local"}; the local page takes it and clears it once restored. Same
        // validation and errors as move.*; never the contents or the path.
        case "leave.stash" where !local:
            do {
                try leaveStash.stash((body["args"] as? [String: Any])?["vault"])
                replyHandler(true, nil)
            } catch {
                replyHandler(nil, (error as? Move.Failure)?.message ?? "write failed")
            }
        case "leave.take" where local:
            do {
                if let vault = try leaveStash.take() { replyHandler(["vault": vault], nil) } else { replyHandler(NSNull(), nil) }
            } catch {
                replyHandler(nil, "read failed")
            }
        case "leave.clear" where local:
            // {back: true}: the user cancelled the pickup (bd med-o7zq.42), so
            // nothing happened: reopen the account the leave came from. That
            // account was never changed and its origin's data is still here.
            leaveStash.clear()
            let back = UserDefaults.standard.string(forKey: Shell.leaveHostKey)
            UserDefaults.standard.removeObject(forKey: Shell.leaveHostKey)
            if (body["args"] as? [String: Any])?["back"] as? Bool == true,
               let h = back, AccountURL.isAccountHost(h, base: base) {
                replyHandler(["back": true], nil)
                UserDefaults.standard.set(h, forKey: Shell.hostKey)
                UserDefaults.standard.set(false, forKey: LocalOrigin.modeKey)
                host = h
                local = false
                reopen()
            } else {
                replyHandler(true, nil)
            }
        // Local mode's invite request + attested feedback (BasePost.swift, contract
        // med-ta2n.24 §A): the shell POSTs to its own base, off the main thread.
        // WebKit requires every reply, so a call that outlives the lock or local
        // mode answers that gate's error, never the server's reply (Android drops it).
        case "base.post" where local:
            BasePost.call(base: base, args: body["args"] as? [String: Any] ?? [:]) { reply, error in
                Task { @MainActor [weak self] in
                    guard let self, self.local else { return replyHandler(nil, "unsupported: base.post") }
                    guard !self.concealed else { return replyHandler(nil, "locked") }
                    replyHandler(reply?.json, error)
                }
            }
        // The anonymous trial AI (bd med-o7zq.16): local mode only — an account
        // has its own trial — and, like every op here, never while locked.
        case let op? where local && op.hasPrefix("attest."):
            let args = body["args"] as? [String: Any] ?? [:]
            let base = self.base
            Task {
                do { replyHandler(try await Attest.handle(op, args, base: base), nil) }
                catch { replyHandler(nil, error.localizedDescription) }
            }
        // notifications.* and health.* stay open in local mode: its reminders
        // and Apple Health import use them (bd med-o7zq.9).
        case let op? where op.hasPrefix("notifications."):
            Notifications.shared.handle(op, args: body["args"] as? [String: Any] ?? [:], reply: replyHandler)
        case let op? where op.hasPrefix("health."):
            let args = body["args"] as? [String: Any] ?? [:]
            Task {
                do { replyHandler(try await Health.handle(op, args), nil) }
                catch { replyHandler(nil, error.localizedDescription) }
            }
        case let op:
            replyHandler(nil, "unsupported: \(op ?? "")")
        }
    }

    /// local.erase's wipe of wgapp://local's website data, what the local
    /// page's eraseDevice clears itself (local-policy.js): IndexedDB (the
    /// vault), localStorage, sessionStorage, Cache Storage. WKWebsiteDataStore
    /// lists no custom-scheme origin in fetchDataRecords, so a throwaway web
    /// view on that origin does it with the page's own APIs; its document is
    /// the scheme handler's 404 for a path no bundle file has, so no app code
    /// runs there. sessionStorage belongs to each web view, so the wipe leaves
    /// a localStorage marker that Shell.sessionWipeJS turns into a
    /// sessionStorage.clear() in the shell's own view on its next local page,
    /// before any app script. `proceed` is asked once the view has loaded,
    /// right before anything is deleted. Returns what is left (databases +
    /// localStorage keys besides the marker): 0 = wiped, -1 = the wipe failed
    /// to run, nil = `proceed` said no (nothing touched). A delete blocked by
    /// a connection still open waits up to 10 s, then counts as left.
    static func eraseLocalOrigin(proceed: () -> Bool) async -> Int? {
        let config = WKWebViewConfiguration()
        config.limitsNavigationsToAppBoundDomains = true // as the shell's own view
        config.setURLSchemeHandler(LocalApp.shared, forURLScheme: LocalOrigin.scheme)
        let view = WKWebView(frame: .zero, configuration: config)
        let loaded = Loaded()
        view.navigationDelegate = loaded
        let ok = await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
            loaded.done = { done.resume(returning: $0) }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(15))
                loaded.finish(false)
            }
            view.load(URLRequest(url: URL(string: "wgapp://local/__erase__")!))
        }
        guard ok, view.url?.host?.lowercased() == LocalOrigin.host else { return -1 }
        guard proceed() else { return nil }
        let left = try? await view.callAsyncJavaScript("""
            const settle = (q) => new Promise((r) => { q.onsuccess = q.onerror = () => r(); });
            const names = async () => ((await indexedDB.databases()) || []).map((d) => d.name);
            await Promise.race([
                Promise.all((await names()).map((n) => settle(indexedDB.deleteDatabase(n)))),
                new Promise((r) => setTimeout(r, 10000)),
            ]);
            localStorage.clear();
            localStorage.setItem(marker, '1');
            if (self.caches) for (const k of await caches.keys()) await caches.delete(k);
            return (await names()).length + localStorage.length - 1;
            """, arguments: ["marker": Shell.sessionWipeKey], in: nil, contentWorld: .page)
        return (left as? NSNumber)?.intValue ?? -1
    }

    /// The throwaway view's load outcome, once (didFinish, a failure, or the timeout).
    @MainActor
    private final class Loaded: NSObject, WKNavigationDelegate {
        var done: ((Bool) -> Void)?
        func finish(_ ok: Bool) {
            done?(ok)
            done = nil
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish(true) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(false) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(false) }
    }

    // MARK: diagnostics (bd med-w6gx.24, twin of Android med-nt9p.22)

    /// Appends one redacted line to the capped ceremony log; kept across Switch account.
    func diag(_ line: String) {
        let defaults = UserDefaults.standard
        let time = ISO8601DateFormatter().string(from: Date())
        defaults.set(Diag.append(defaults.string(forKey: Diag.key) ?? "", line, base: base, time: time), forKey: Diag.key)
    }

    /// The error screen or the quick action: the
    /// device header plus the log, as plain text on the pasteboard.
    func copyDiagnostics() {
        var machine = utsname()
        uname(&machine)
        let model = withUnsafeBytes(of: &machine.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        let info = Bundle.main.infoDictionary ?? [:]
        let header = [
            "Med Tracker diagnostics \(ISO8601DateFormatter().string(from: Date()))",
            "app \(info["CFBundleShortVersionString"] as? String ?? "?") (\(info["CFBundleVersion"] as? String ?? "?"))",
            "iOS \(UIDevice.current.systemVersion) \(model)",
            "mode " + (local ? "local" : "account " + (host ?? "?")),
        ].joined(separator: "\n")
        UIPasteboard.general.string = Diag.redact(header, base: base) + "\n\n" + (UserDefaults.standard.string(forKey: Diag.key) ?? "")
        diagCopied = true
    }

    /// Visual QA (Debug only): `-wgQALoadError 503|404|local` draws N4 without
    /// a server; nothing loads. Returns whether it did.
    private func qaLoadError() -> Bool {
        #if DEBUG
        switch UserDefaults.standard.string(forKey: "wgQALoadError") {
        case "503":
            host = "vivid-vole.qa.test"
            loadError = LoadError(.network, "503 · service unavailable")
        case "404":
            host = "vivid-vole.qa.test"
            loadError = LoadError(.notFound, "404 · not found")
        case "local":
            loadError = LoadError(.local, "local · bundle failed to load")
        default:
            return false
        }
        return true
        #else
        return false
        #endif
    }

    /// "rgb(r, g, b)" / "rgba(r, g, b, a)" from getComputedStyle; nil when transparent or unparseable.
    static func color(_ css: String) -> UIColor? {
        let n = css.split(whereSeparator: { !"0123456789.".contains($0) }).compactMap { Double($0) }
        guard n.count == 3 || (n.count == 4 && n[3] > 0) else { return nil }
        return UIColor(red: n[0] / 255, green: n[1] / 255, blue: n[2] / 255, alpha: 1)
    }

    /// local.erase's marker (eraseLocalOrigin): wgapp://local was wiped, so the
    /// shell view's sessionStorage there (first-run step, pickup markers) goes
    /// too, once, at the next local document's start, before any app script.
    static let sessionWipeKey = "wg-shell-session-wipe"
    static let sessionWipeJS = """
        if (location.protocol === '\(LocalOrigin.scheme):') try {
            if (localStorage.getItem('\(sessionWipeKey)')) {
                sessionStorage.clear();
                localStorage.removeItem('\(sessionWipeKey)');
            }
        } catch (_) {}
        """

    /// Page world, main frame, every page the shell loads. Asks for persistent
    /// storage (the spike found storage.persisted false: evictable under storage
    /// pressure, which would lose unsynced offline writes), and reports the
    /// background colour at the page's top and bottom edge for the native bands.
    static let pageJS = #"""
    (() => {
      const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wgChrome;
      if (!h) return;
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      const clear = (c) => !c || c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c);
      // Paint order, not DOM ancestry: a transparent full-screen layer (a sheet's
      // tap-catching backdrop) is a child of <body>, so walking its parents hit
      // body's legacy white instead of the opaque layer painted under it (med-o7zq.44).
      const bg = (x, y) => {
        for (const el of document.elementsFromPoint(x, y)) {
          const c = getComputedStyle(el).backgroundColor;
          if (!clear(c)) return c;
        }
        return '';
      };
      let last = '', timer = 0;
      const sample = () => {
        timer = 0;
        const x = innerWidth / 2;
        const m = { top: bg(x, 0), bottom: bg(x, innerHeight - 1) };
        const s = m.top + '|' + m.bottom;
        if (s !== last) { last = s; h.postMessage(m); }
      };
      const soon = () => { if (!timer) timer = setTimeout(sample, 150); };
      addEventListener('load', soon);
      addEventListener('resize', soon);
      new MutationObserver(soon).observe(document.documentElement,
        { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'open'] });
      soon();
    })();
    """#
}

/// N4 (bd med-ckm5.15, screens-native.html): which error screen, and its mono
/// meta line for support ("503 · service unavailable · 09:41").
struct LoadError: Equatable {
    enum Kind { case network, notFound, local }
    let kind: Kind
    let meta: String

    init(_ kind: Kind, _ what: String) {
        self.kind = kind
        let time = DateFormatter()
        time.dateFormat = "HH:mm"
        meta = what + " · " + time.string(from: Date())
    }
}
