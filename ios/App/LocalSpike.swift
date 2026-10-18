import SwiftUI
import UIKit
import WebKit

/// Local-mode GO/NO-GO diagnostic (bd med-o7zq.1). Throwaway, like the
/// med-w6gx.2 spike; kept until the release-gate checks (10 backup → restore,
/// 11 eviction) have run. Same origin as local mode (LocalOrigin), so its
/// IndexedDB lives next to the app's (separate database names).
///
/// Opened only from iOS Settings → Med Tracker → Local mode diagnostic; the
/// shell's normal path never creates it. Its own WKWebView loads the bundled
/// test page (ios/LocalSpike/) from a WKURLSchemeHandler on `wgapp://local/`
/// in the default website data store — a separate origin from any account —
/// with the CSP sent as a response header. The page runs the checks; this
/// side adds what only native can see (where WebKit put the origin's data,
/// its file protection class, its isExcludedFromBackup flag — cleared) and how
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

    /// Must match the "wgapp:" WKAppBoundDomains entry (ios/project.yml): a
    /// trailing colon makes WebKit treat it as an app-bound scheme, so the page
    /// loads under the app-bound limit and keeps its script message handlers.
    let scheme = "wgapp"
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
        guardBackupFlag("launch start") // before the page touches storage
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

    static func mime(_ path: String) -> String { LocalOrigin.mime(path) }

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
            "scheme \(scheme)://local, app-bound limit \(appBound ? "on" : "off")",
        ]
        out += log
        out += dataScan()
        return redact(out.joined(separator: "\n"))
    }

    /// This origin's data directories (the same origin as local mode).
    private func originDirs() -> [URL] { LocalOrigin.dataDirs() }

    /// Checks 7 and 12: every IndexedDB directory under Library (Caches
    /// included — that is not backed up), this origin's directory, and the
    /// backup-flag history.
    private func dataScan() -> [String] {
        guard let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first,
              let walk = FileManager.default.enumerator(at: library, includingPropertiesForKeys: nil) else {
            return ["#7 cannot enumerate Library"]
        }
        guardBackupFlag("page scan") // first: the history keeps the value WebKit left
        var lines = ["#7 IndexedDB dirs (path · dir protection · file: protection · excludedFromBackup · bytes):"]
        for case let url as URL in walk where url.lastPathComponent == "IndexedDB" {
            lines.append("  " + describe(url))
        }
        let ours = originDirs()
        if ours.isEmpty { lines.append("#7 our origin dir: not found (the page has not written yet? reopen Report)") }
        for dir in ours { lines.append("#7 our origin dir: " + describe(dir)) }
        return lines + backupFlagReport(ours)
    }

    // MARK: check 12 — isExcludedFromBackup on the origin's data dir

    /// Root cause (bd med-o7zq.11): on iOS WebKit itself excludes a new
    /// origin's directory from backup when it first writes the `origin` file
    /// (NetworkStorageManager::writeOriginToFileIfNecessary) and includes it
    /// again only on a storage access 24 h later
    /// (includeOriginInBackupIfNecessary, defaultBackupExclusionPeriod). A
    /// backup in that window drops the data. So at launch and on every scan an
    /// excluded dir of ours (or a parent up to WebsiteData) is set back to
    /// false. Each dir's first sighting per launch, and every clear, goes to a
    /// history file in Application Support that outlives the launch.
    private static var seen: Set<String> = []
    private static let history = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
        .appendingPathComponent("wg-spike-backup-flag.log")

    private func flagChain(_ dir: URL) -> [URL] { LocalOrigin.flagChain(dir) }

    private static func excluded(_ dir: URL) -> Bool? {
        let fresh = URL(fileURLWithPath: dir.path) // no cached resource values
        return (try? fresh.resourceValues(forKeys: [.isExcludedFromBackupKey]))?.isExcludedFromBackup
    }

    private func label(_ dir: URL, _ origin: URL) -> String {
        dir == origin ? "origin" : relative(dir).replacingOccurrences(of: "~/Library/WebKit/", with: "")
    }

    private func guardBackupFlag(_ stage: String) {
        var parts: [String] = []
        let ours = originDirs()
        for origin in ours {
            for dir in flagChain(origin) {
                let found = LocalSpike.excluded(dir)
                let first = LocalSpike.seen.insert(dir.path).inserted
                guard first || found != false else { continue }
                var part = "\(label(dir, origin)) found=\(found.map { "\($0)" } ?? "unreadable")"
                if found == true {
                    do {
                        var fresh = URL(fileURLWithPath: dir.path)
                        var values = URLResourceValues()
                        values.isExcludedFromBackup = false
                        try fresh.setResourceValues(values)
                        part += LocalSpike.excluded(dir) == false ? " cleared ok" : " cleared FAILED (still excluded)"
                    } catch {
                        part += " cleared FAILED (\(error.localizedDescription))"
                    }
                }
                parts.append(part)
            }
        }
        if ours.isEmpty, LocalSpike.seen.insert("none " + stage).inserted { parts.append("origin dir not created yet") }
        guard !parts.isEmpty, let file = LocalSpike.history else { return }
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        let line = "\(Date().ISO8601Format()) build \(build) launch \(launch) \(stage): " + parts.joined(separator: "; ") + "\n"
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let h = try? FileHandle(forWritingTo: file) {
            _ = try? h.seekToEnd()
            try? h.write(contentsOf: Data(line.utf8))
            try? h.close()
        } else {
            try? Data(line.utf8).write(to: file)
        }
    }

    /// The history (last 40 lines) and the flag as it reads now; the page
    /// grades #12 from the "#12 now:" line and any "cleared FAILED".
    private func backupFlagReport(_ ours: [URL]) -> [String] {
        let text = LocalSpike.history.flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
        let past = text.split(separator: "\n").suffix(40).map { "  " + $0 }
        let now = ours.flatMap { o in
            flagChain(o).map { "\(label($0, o)) excluded=\(LocalSpike.excluded($0).map { "\($0)" } ?? "unreadable")" }
        }
        return ["#12 backup-flag history (each launch: found = flag at first sighting; cleared ok/FAILED):"] + past
            + ["#12 now: " + (now.isEmpty ? "origin dir not found" : now.joined(separator: "; "))]
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
