import SwiftUI
import UIKit
import WebKit

/// The shell (bd med-w6gx.3): one WKWebView on the account origin
/// https://<sub>.<base>/, exactly like the PWA. The app remembers only the
/// account host; everything else (vault, Service Worker, IndexedDB) lives in the
/// persistent default website data store, per origin.
@MainActor
final class Shell: NSObject, ObservableObject, WKNavigationDelegate, WKScriptMessageHandler {
    static let hostKey = "wgAccountHost"
    /// Settings.bundle toggle (iOS Settings → Med Tracker → Switch account).
    static let forgetKey = "wgForgetAccount"
    /// --wg-bg-screen: the bands' colour until the page reports its own.
    static let screen = UIColor(red: 0x13 / 255, green: 0x2D / 255, blue: 0x29 / 255, alpha: 1)

    let base = (Bundle.main.object(forInfoDictionaryKey: "WGBaseDomain") as? String ?? "").lowercased()
    let webView: WKWebView
    @Published private(set) var host: String?
    @Published private(set) var loadError: String?
    /// Behind the status bar and the home indicator: the page's own colours at its top and bottom edge.
    @Published private(set) var top = Color(uiColor: Shell.screen)
    @Published private(set) var bottom = Color(uiColor: Shell.screen)
    /// In memory only: Try again must keep an invite link's #claim= fragment.
    private var lastURL: URL?

    override init() {
        let config = WKWebViewConfiguration()
        // Service Workers in WKWebView need the page on a WKAppBoundDomains entry
        // (Info.plist, from project.yml) with navigation limited to them.
        config.limitsNavigationsToAppBoundDomains = true
        config.allowsInlineMediaPlayback = true // barcode/photo preview stays inline
        config.userContentController.addUserScript(
            WKUserScript(source: Shell.pageJS, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .page))
        Downloads.shared.install(on: config)
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.add(self, contentWorld: .page, name: "wgChrome")
        webView.navigationDelegate = self
        // The page sits between the native bands (RootView), so nothing scrolls
        // under the status bar and no white shows around it.
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false

        let defaults = UserDefaults.standard
        // Spike builds (med-w6gx.2) kept the last URL: adopt its account so testers skip first-run.
        if defaults.string(forKey: Shell.hostKey) == nil,
           let host = defaults.string(forKey: "wgSpikeLastURL").flatMap({ AccountURL.parse($0, base: base) })?.host {
            defaults.set(host, forKey: Shell.hostKey)
        }
        defaults.removeObject(forKey: "wgSpikeLastURL")
        defaults.removeObject(forKey: "wgSpikeLog")
        host = defaults.string(forKey: Shell.hostKey).flatMap { AccountURL.isAccountHost($0, base: base) ? $0 : nil }
        applySettings()
        retry()
    }

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

    func retry() {
        if let url = lastURL ?? host.flatMap({ URL(string: "https://\($0)/") }) { load(url) }
    }

    /// Back to first-run. Website data is kept: it is per origin, so returning to
    /// this account later still finds its offline data and warm unlock.
    func forget() {
        UserDefaults.standard.removeObject(forKey: Shell.hostKey)
        host = nil
        lastURL = nil
        loadError = nil
        webView.loadHTMLString("", baseURL: nil) // stop the old account's page
    }

    /// Runs at launch and whenever the app becomes active.
    func applySettings() {
        guard UserDefaults.standard.bool(forKey: Shell.forgetKey) else { return }
        UserDefaults.standard.set(false, forKey: Shell.forgetKey)
        forget()
    }

    private func load(_ url: URL) {
        loadError = nil
        lastURL = url
        webView.load(URLRequest(url: url))
    }

    private func isInside(_ h: String?) -> Bool {
        guard let h = h?.lowercased() else { return false }
        return h == host || h == base
    }

    // MARK: WKNavigationDelegate

    /// Only the account host and the base domain load in the app; any other
    /// link opens in Safari (or the app owning its scheme: mailto:, tel:, …).
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
           http.statusCode >= 400, !showingAccount(webView) {
            loadError = http.statusCode == 404
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
    }

    /// Offline with a Service Worker in control never gets here: the worker
    /// answers. This is the first-ever load failing (no network, no cache yet).
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let e = error as NSError
        // -999 superseded by another load; 102 interrupted by policy (external link, download).
        if (e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled) || (e.domain == "WebKitErrorDomain" && e.code == 102) { return }
        // A page of this account already showing stays usable.
        if !showingAccount(webView) { loadError = e.localizedDescription }
    }

    private func showingAccount(_ webView: WKWebView) -> Bool {
        host != nil && webView.url?.host?.lowercased() == host
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView.url == nil { retry() } else { webView.reload() } // reload keeps the current URL and fragment
    }

    // MARK: wgChrome messages

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: String] else { return }
        if let c = body["top"].flatMap(Shell.color) { top = Color(uiColor: c) }
        if let c = body["bottom"].flatMap(Shell.color) { bottom = Color(uiColor: c) }
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
