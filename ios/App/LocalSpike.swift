import SwiftUI
import UIKit
import WebKit

/// Local-mode GO/NO-GO diagnostic (bd med-o7zq.1). Throwaway, like the
/// med-w6gx.2 spike: the bundling bead (med-o7zq.4) replaces it.
///
/// Opened only from iOS Settings → Med Tracker → Local mode diagnostic; the
/// shell's normal path never creates it. Its own WKWebView loads the bundled
/// test page (ios/LocalSpike/) from a WKURLSchemeHandler on `app://local/`
/// in the default website data store — a separate origin from any account —
/// with the CSP sent as a response header. The page runs the checks; this
/// side adds what only native can see (where WebKit put the origin's data,
/// its file protection class, whether isExcludedFromBackup applies) and how
/// the bridge sees the origin. No private WebKit API, no Service Worker.
/// Procedure and results: docs/ios.md.
@MainActor
final class LocalSpike: NSObject, ObservableObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply, WKURLSchemeHandler {
    static let toggleKey = "wgLocalSpike"
    static var requested: Bool { UserDefaults.standard.bool(forKey: toggleKey) }

    /// What the page is served under (connect-src lists the two BYOK probe hosts).
    static let csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; "
        + "media-src 'self' blob: mediastream:; connect-src 'self' https://api.openai.com https://api.anthropic.com; "
        + "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

    /// setURLSchemeHandler raises for a scheme WebKit handles itself.
    let scheme = WKWebView.handlesURLScheme("app") ? "wgapp" : "app"
    /// Fresh per process (static: reopening the diagnostic is not a relaunch):
    /// the page's IndexedDB history shows which launches wrote it.
    static let launch = String(UUID().uuidString.prefix(8))
    var launch: String { LocalSpike.launch }
    @Published private(set) var webView: WKWebView?
    /// Production shell config: navigation limited to app-bound domains. Off retries without the limit.
    @Published var appBound = true { didSet { start() } }
    private var log: [String] = []
    private var pageReport = ""
    private let root = Bundle.main.bundleURL.appendingPathComponent("LocalSpike", isDirectory: true).standardizedFileURL
    private let base = (Bundle.main.object(forInfoDictionaryKey: "WGBaseDomain") as? String ?? "").lowercased()

    func start() {
        stop()
        let config = WKWebViewConfiguration()
        config.limitsNavigationsToAppBoundDomains = appBound
        config.allowsInlineMediaPlayback = true
        config.setURLSchemeHandler(self, forURLScheme: scheme)
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "wgSpike")
        let view = WKWebView(frame: .zero, configuration: config)
        view.isInspectable = true // Safari Web Inspector from a Mac
        view.navigationDelegate = self
        webView = view
        note("load \(scheme)://local/ with app-bound limit \(appBound ? "on" : "off")")
        if let url = URL(string: "\(scheme)://local/") { view.load(URLRequest(url: url)) }
    }

    /// Breaks the config → handler → self retain cycle.
    func stop() {
        webView?.configuration.userContentController.removeAllScriptMessageHandlers()
        webView?.stopLoading()
        webView = nil
    }

    private func note(_ s: String) {
        log.append("[\(Date().formatted(date: .omitted, time: .standard))] \(s)")
    }

    // MARK: WKURLSchemeHandler — the bundled page

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        let path = url.path.isEmpty || url.path == "/" ? "/index.html" : url.path
        var body: Data?
        if path == "/env.json" {
            body = env()
        } else {
            let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
            if file.path.hasPrefix(root.path + "/") { body = try? Data(contentsOf: file) }
        }
        var headers = ["Content-Type": body == nil ? "text/plain" : LocalSpike.mime(path), "Cache-Control": "no-store"]
        if path.hasSuffix(".html") { headers["Content-Security-Policy"] = LocalSpike.csp }
        guard let response = HTTPURLResponse(url: url, statusCode: body == nil ? 404 : 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.cannotParseResponse))
            return
        }
        if body == nil { note("404 \(path)") }
        task.didReceive(response)
        task.didReceive(body ?? Data())
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {} // answered synchronously

    static func mime(_ path: String) -> String {
        switch (path as NSString).pathExtension {
        case "html": return "text/html; charset=utf-8"
        case "js": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        default: return "application/octet-stream"
        }
    }

    private func env() -> Data? {
        let info = Bundle.main.infoDictionary ?? [:]
        let device = UIDevice.current
        return try? JSONSerialization.data(withJSONObject: [
            "build": info["CFBundleVersion"] as? String ?? "?",
            "version": info["CFBundleShortVersionString"] as? String ?? "?",
            "ios": device.systemVersion,
            "model": device.model,
            "launch": launch,
            // Changes with a new install or another device: tells a restored history apart.
            "vendor": String((device.identifierForVendor?.uuidString ?? "none").prefix(8)),
            "scheme": scheme,
        ])
    }

    // MARK: WKNavigationDelegate — load results and the share-sheet download path

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        Downloads.policy(for: action)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        Downloads.policy(for: navigationResponse)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        note("download started (share sheet follows)")
        download.delegate = Downloads.shared
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        note("download started (share sheet follows)")
        download.delegate = Downloads.shared
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        note("loaded \(webView.url?.absoluteString ?? "?")")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let e = error as NSError
        note("load FAILED \(e.domain) \(e.code): \(e.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let e = error as NSError
        note("navigation FAILED \(e.domain) \(e.code): \(e.localizedDescription)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        note("web content process terminated; reloading")
        webView.reload()
    }

    // MARK: wgSpike bridge (check 8)

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        let body = message.body as? [String: Any] ?? [:]
        switch body["op"] as? String {
        case "origin":
            note("#8 bridge: securityOrigin protocol=\"\(origin.protocol)\" host=\"\(origin.host)\" port=\(origin.port) mainFrame=\(message.frameInfo.isMainFrame)")
            replyHandler(["protocol": origin.protocol, "host": origin.host, "port": origin.port,
                          "mainFrame": message.frameInfo.isMainFrame], nil)
        case "native":
            replyHandler(nativeReport(), nil)
        case "report":
            pageReport = body["text"] as? String ?? ""
            replyHandler(true, nil)
        case let op:
            replyHandler(nil, "unsupported: \(op ?? "")")
        }
    }

    // MARK: report

    /// The native side plus the page's last report, for the Report sheet.
    func fullReport() -> String {
        nativeReport() + "\n\n— page (over the bridge) —\n"
            + (pageReport.isEmpty ? "none received: the bridge failed, use the page's Share/Copy buttons" : pageReport)
    }

    func nativeReport() -> String {
        let info = Bundle.main.infoDictionary ?? [:]
        var out = [
            "native · build \(info["CFBundleVersion"] ?? "?") · iOS \(UIDevice.current.systemVersion) · launch \(launch)",
            "scheme \(scheme)://local (WKWebView.handlesURLScheme(\"app\") = \(WKWebView.handlesURLScheme("app"))), app-bound limit \(appBound ? "on" : "off")",
        ]
        out += log
        out += dataScan()
        return redact(out.joined(separator: "\n"))
    }

    /// Checks 7 and 12: every IndexedDB directory under Library (Caches
    /// included — that is not backed up), this origin's directory, and whether
    /// isExcludedFromBackup can be set on it (set, read back, reverted: the
    /// backup → restore run needs it included).
    private func dataScan() -> [String] {
        let fm = FileManager.default
        guard let library = fm.urls(for: .libraryDirectory, in: .userDomainMask).first,
              let walk = fm.enumerator(at: library, includingPropertiesForKeys: nil) else {
            return ["#7 cannot enumerate Library"]
        }
        var lines = ["#7 IndexedDB dirs (path · dir protection · file: protection · excludedFromBackup · bytes):"]
        var ours: [URL] = []
        let schemeBytes = Data(scheme.utf8), hostBytes = Data("local".utf8)
        for case let url as URL in walk {
            let name = url.lastPathComponent
            if name == "IndexedDB" {
                lines.append("  " + describe(url))
            } else if name == "origin", let d = try? Data(contentsOf: url),
                      d.range(of: schemeBytes) != nil, d.range(of: hostBytes) != nil {
                ours.append(url.deletingLastPathComponent()) // salted-hash layout: <dir>/origin names the origin
            } else if name.hasPrefix("\(scheme)_local") {
                ours.append(url) // legacy layout: <scheme>_<host>_<port>
            }
        }
        if ours.isEmpty { lines.append("#7 our origin dir: not found (the page has not written yet? reopen Report)") }
        for dir in ours {
            lines.append("#7 our origin dir: " + describe(dir))
            lines.append("#12 " + relative(dir) + ": " + excludeFromBackupProbe(dir))
        }
        return lines
    }

    private func excludeFromBackupProbe(_ dir: URL) -> String {
        func flag() -> String {
            let fresh = URL(fileURLWithPath: dir.path) // no cached resource values
            guard let v = try? fresh.resourceValues(forKeys: [.isExcludedFromBackupKey]) else { return "unreadable" }
            return "\(v.isExcludedFromBackup ?? false)"
        }
        let before = flag()
        var url = dir
        var values = URLResourceValues()
        do {
            values.isExcludedFromBackup = true
            try url.setResourceValues(values)
            let set = flag()
            values.isExcludedFromBackup = false
            try url.setResourceValues(values)
            return "before=\(before) set=\(set) reverted=\(flag())"
        } catch {
            return "before=\(before) setResourceValues FAILED: \(error.localizedDescription)"
        }
    }

    private func describe(_ dir: URL) -> String {
        let keys: Set<URLResourceKey> = [.fileSizeKey, .fileProtectionKey, .isRegularFileKey]
        var bytes = 0
        var file = "no files"
        let files = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: Array(keys))?.allObjects as? [URL] ?? []
        for f in files {
            guard let v = try? f.resourceValues(forKeys: keys), v.isRegularFile == true else { continue }
            bytes += v.fileSize ?? 0
            if file == "no files" || f.lastPathComponent.contains("sqlite") {
                file = "\(f.lastPathComponent): \(v.fileProtection?.rawValue ?? "?")"
            }
        }
        let v = try? dir.resourceValues(forKeys: [.isExcludedFromBackupKey, .fileProtectionKey])
        return "\(relative(dir)) · dir \(v?.fileProtection?.rawValue ?? "?") · \(file) · excluded=\(v?.isExcludedFromBackup ?? false) · \(bytes) B"
    }

    /// Path inside the app container, e.g. ~/Library/WebKit/…
    private func relative(_ url: URL) -> String {
        let home = URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path
        let path = url.resolvingSymlinksInPath().path
        return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
    }

    /// Account origins appear in the scan; keep deployment host names out of a pasted report.
    private func redact(_ text: String) -> String {
        guard !base.isEmpty else { return text }
        let pattern = "[A-Za-z0-9.-]*" + NSRegularExpression.escapedPattern(for: base)
        return text.replacingOccurrences(of: pattern, with: "<account>", options: [.regularExpression, .caseInsensitive])
    }
}

struct LocalSpikeView: View {
    @ObservedObject var spike: LocalSpike
    let close: () -> Void
    @State private var report = ""
    @State private var showing = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Close", action: close)
                Spacer()
                Toggle("App-bound", isOn: $spike.appBound).fixedSize()
                Button("Report") {
                    report = spike.fullReport()
                    showing = true
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            if let view = spike.webView {
                WebView(webView: view).id(ObjectIdentifier(view))
            } else {
                Spacer()
            }
        }
        .background(Color(uiColor: Shell.screen).ignoresSafeArea())
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showing) {
            NavigationStack {
                ScrollView {
                    Text(report).font(.caption.monospaced()).textSelection(.enabled).padding()
                }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Done") { showing = false } }
                    ToolbarItem(placement: .primaryAction) { ShareLink(item: report) }
                    ToolbarItem(placement: .secondaryAction) { Button("Copy") { UIPasteboard.general.string = report } }
                }
            }
        }
    }
}
