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
final class Shell: NSObject, ObservableObject, WKNavigationDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
    static let hostKey = "wgAccountHost"
    /// Settings.bundle toggle (iOS Settings → Med Tracker → Switch account).
    static let forgetKey = "wgForgetAccount"
    /// --wg-bg-screen: the bands' colour until the page reports its own.
    static let screen = UIColor(red: 0x13 / 255, green: 0x2D / 255, blue: 0x29 / 255, alpha: 1)

    let base = (Bundle.main.object(forInfoDictionaryKey: "WGBaseDomain") as? String ?? "").lowercased()
    let webView: WKWebView
    @Published private(set) var host: String? {
        didSet { Notifications.shared.vault = vault }
    }
    /// Local mode, from the persisted choice (LocalOrigin.modeKey); wins over a stored host.
    @Published private(set) var local = UserDefaults.standard.bool(forKey: LocalOrigin.modeKey) {
        didSet { Notifications.shared.vault = vault }
    }
    /// The vault the shell has open (bd med-o7zq.9): one at a time, so
    /// reminders, their taps and the bridge all follow this.
    private var vault: String? { local ? LocalOrigin.host : host }
    @Published private(set) var loadError: String?
    /// The committed page is an account ceremony (/unlock, /claim, /recover):
    /// RootView offers "Use another invite" (bd med-w6gx.21) — a bad or
    /// already-claimed invite has no exit of its own there.
    @Published private(set) var onCeremony = false
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
    /// What the lock held back: a load and a notification tap, run on unlock.
    private var deferredURL: URL?
    private var deferredReminder: (String, String?)?

    /// The lock holds: the page is out of the window, loads wait, the bridge says "locked".
    var concealed: Bool { lock.holds(local: local) }

    override init() {
        let config = WKWebViewConfiguration()
        // Service Workers in WKWebView need the page on a WKAppBoundDomains entry
        // (Info.plist, from project.yml) with navigation limited to them.
        config.limitsNavigationsToAppBoundDomains = true
        config.allowsInlineMediaPlayback = true // barcode/photo preview stays inline
        // Pinch-zoom as in Safari: the page caps maximum-scale=1 on iOS
        // (wg-sheet.js noFocusZoom, med-pe9g) to stop the zoom-in on a focused
        // field, which WebKit still honours with this on; only gestures ignore it.
        config.ignoresViewportScaleLimits = true
        config.userContentController.addUserScript(
            WKUserScript(source: Shell.pageJS, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .page))
        Downloads.shared.install(on: config)
        config.setURLSchemeHandler(LocalApp.shared, forURLScheme: LocalOrigin.scheme)
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        Downloads.shared.held = { [weak self] in self?.concealed ?? false }
        config.userContentController.add(self, contentWorld: .page, name: "wgChrome")
        // Its presence is what makes web/static/js/native/index.js pick the 'ios' platform.
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "wgNative")
        webView.navigationDelegate = self
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
        // Spike builds (med-w6gx.2) kept the last URL: adopt its account so testers skip first-run.
        if defaults.string(forKey: Shell.hostKey) == nil,
           let host = defaults.string(forKey: "wgSpikeLastURL").flatMap({ AccountURL.parse($0, base: base) })?.host {
            defaults.set(host, forKey: Shell.hostKey)
        }
        defaults.removeObject(forKey: "wgSpikeLastURL")
        defaults.removeObject(forKey: "wgSpikeLog")
        host = defaults.string(forKey: Shell.hostKey).flatMap { AccountURL.isAccountHost($0, base: base) ? $0 : nil }
        Notifications.shared.vault = vault // observers don't run in init; a switch in applySettings must see the old vault
        applySettings()
        if local { LocalOrigin.includeInBackup() } // a dir an earlier launch created
        // Launch state for a support sysdiagnose (bd med-o7zq.31); no host name, no data.
        Logger(subsystem: Bundle.main.bundleIdentifier ?? "MedTracker", category: "shell").notice(
            "launch mode=\(self.local ? "local" : self.host == nil ? "first-run" : "account", privacy: .public) host=\(self.host != nil, privacy: .public) localDataDirs=\(LocalOrigin.dataDirs().count, privacy: .public)")
        retry()
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
        if showingAccount, !webView.isLoading,
           let json = try? JSONSerialization.data(withJSONObject: path, options: .fragmentsAllowed),
           let quoted = String(data: json, encoding: .utf8) {
            webView.evaluateJavaScript(
                "history.replaceState({}, '', \(quoted)); window.handleDeepLinks && window.handleDeepLinks()")
        } else if let url = URL(string: path, relativeTo: home)?.absoluteURL {
            load(url)
        }
    }

    /// The page this mode opens on: the bundled app, or the account's root.
    private var home: URL? {
        local ? Shell.localHome : host.flatMap { URL(string: "https://\($0)/") }
    }

    #if DEBUG
    /// Visual QA scene (bd med-y5xx.2, LocalOrigin.qaHome): Debug builds only.
    private static let localHome = LocalOrigin.qaHome(scene: UserDefaults.standard.string(forKey: LocalOrigin.qaSceneKey)) ?? LocalOrigin.home
    #else
    private static let localHome = LocalOrigin.home
    #endif

    /// First-run submit. Returns the message to show, or nil once the account is opening.
    func open(_ raw: String) -> String? {
        guard let url = AccountURL.parse(raw, base: base), let host = url.host else {
            return base.isEmpty
                ? "This build has no service configured."
                : "That isn't an account link. Use your invite link or your account address (yourname.\(base))."
        }
        UserDefaults.standard.set(host, forKey: Shell.hostKey)
        self.host = host
        load(url) // the claim link keeps its #fragment for the page; only the host is stored
        return nil
    }

    /// First-run "Only on this device" (bd med-o7zq.5), after the local intro:
    /// the same persisted choice as the Settings toggle.
    func openLocal() {
        UserDefaults.standard.set(true, forKey: LocalOrigin.modeKey)
        local = true
        reopen()
    }

    func retry() {
        if let url = lastURL ?? home { load(url) }
    }

    /// Back to first-run, leaving local mode too — or, with `thenLocal`,
    /// straight into local mode (bd med-o7zq.34). Website data is kept: it is
    /// per origin, so returning to this account (or to local mode) later still
    /// finds its data.
    func forget(thenLocal: Bool = false) {
        UserDefaults.standard.removeObject(forKey: Shell.hostKey)
        UserDefaults.standard.set(thenLocal, forKey: LocalOrigin.modeKey)
        host = nil
        local = thenLocal
        reopen()
    }

    /// Runs at launch and whenever the app becomes active.
    func applySettings() {
        let defaults = UserDefaults.standard
        if defaults.bool(forKey: Shell.forgetKey) {
            defaults.set(false, forKey: Shell.forgetKey)
            forget()
        }
        let wantLocal = defaults.bool(forKey: LocalOrigin.modeKey)
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
            // A share or print sheet would stay over the lock screen (a vault
            // export in it); closing it deletes the temp file.
            let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene
            scene?.windows.first?.rootViewController?.dismiss(animated: false)
            UIPrintInteractionController.shared.dismiss(animated: false)
        }
    }

    /// The app became active (after applySettings): the lock prompts once per
    /// launch or return from the background.
    func didBecomeActive() {
        let setting = UserDefaults.standard.bool(forKey: LocalLock.settingKey)
        if let attempt = lock.activate(local: local, setting: setting) { authenticate(attempt) }
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

    /// Local onboarding's choice: turning the lock on, or off while it is
    /// still on, applies only after the phone confirmed its owner.
    func setLock(_ on: Bool) async -> Bool {
        guard on || lock.on else { return true }
        let reason = on ? "Turn on the lock for Med Tracker" : "Turn off the lock for Med Tracker"
        guard await DeviceAuth.check(reason: reason) == .ok else { return false }
        UserDefaults.standard.set(on, forKey: LocalLock.settingKey)
        lock.confirmed(on: on)
        return true
    }

    /// Mode or account changed: open the new home, or stop the old page.
    private func reopen() {
        lastURL = nil
        committedHost = nil
        onCeremony = false
        loadError = nil
        deferredURL = nil
        deferredReminder = nil
        if concealed { webView.loadHTMLString("", baseURL: nil) } // the old page must not run behind the lock
        if let home { load(home) } else { webView.loadHTMLString("", baseURL: nil) }
    }

    private func load(_ url: URL) {
        loadError = nil
        lastURL = url
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
        case LocalOrigin.scheme:
            guard local, url.host?.lowercased() == LocalOrigin.host else { return .cancel }
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
            loadError = http.statusCode == 404 && http.url?.host?.lowercased() == host
                ? "There is no account at \(host ?? "this address")."
                : HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
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
        if local { LocalOrigin.includeInBackup() }
    }

    /// Offline with a Service Worker in control never gets here: the worker
    /// answers. This is the first-ever load failing (no network, no cache yet).
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let e = error as NSError
        // -999 superseded by another load; 102 interrupted by policy (external link, download).
        if (e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled) || (e.domain == "WebKitErrorDomain" && e.code == 102) { return }
        // A page of this account already showing stays usable.
        if !showingAccount { loadError = e.localizedDescription }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        committedHost = webView.url?.host?.lowercased()
        // The ceremony pages leave by full navigation (location.href = '/'), so a commit sees every change.
        onCeremony = !local && AccountURL.isCeremony(webView.url, base: base)
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

    // MARK: wgChrome messages

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: String] else { return }
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
        let mine = local
            ? origin.protocol == LocalOrigin.scheme && origin.host.lowercased() == LocalOrigin.host
            : origin.protocol == "https" && origin.host.lowercased() == host
        guard message.frameInfo.isMainFrame, mine else {
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
        case "setEgressHosts" where local:
            let (reply, error) = LocalOrigin.setEgressHosts(body["args"] as? [String: Any] ?? [:])
            replyHandler(reply, error)
        case "local.reset" where local:
            // The page has erased its own storage (local-policy.js eraseDevice);
            // the shell's share of this vault is its reminders and host mirror.
            UserDefaults.standard.removeObject(forKey: LocalOrigin.hostsKey)
            Task {
                await Notifications.shared.remove(vault: LocalOrigin.host)
                replyHandler(true, nil)
            }
        case "local.leave" where local:
            // Settings → Backup → Move to a cloud account (bd med-o7zq.6): the
            // invite screen, as Switch account. The origin's data stays.
            replyHandler(true, nil)
            forget()
        case "account.leave" where !local:
            // Leave the account; the account and this origin's data stay.
            // Settings → Account "Use this iPhone without an account" passes
            // {then: "local"} and goes straight into local mode (bd
            // med-o7zq.34); after account deletion (no args) it is the native
            // first-run, as Switch account. Older shells ignore the args.
            let args = body["args"] as? [String: Any] ?? [:]
            replyHandler(true, nil)
            forget(thenLocal: args["then"] as? String == "local")
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

    /// "rgb(r, g, b)" / "rgba(r, g, b, a)" from getComputedStyle; nil when transparent or unparseable.
    static func color(_ css: String) -> UIColor? {
        let n = css.split(whereSeparator: { !"0123456789.".contains($0) }).compactMap { Double($0) }
        guard n.count == 3 || (n.count == 4 && n[3] > 0) else { return nil }
        return UIColor(red: n[0] / 255, green: n[1] / 255, blue: n[2] / 255, alpha: 1)
    }

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
      const bg = (el) => {
        for (; el; el = el.parentElement) {
          const c = getComputedStyle(el).backgroundColor;
          if (!clear(c)) return c;
        }
        return '';
      };
      let last = '', timer = 0;
      const sample = () => {
        timer = 0;
        const x = innerWidth / 2;
        const m = { top: bg(document.elementFromPoint(x, 0)), bottom: bg(document.elementFromPoint(x, innerHeight - 1)) };
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
