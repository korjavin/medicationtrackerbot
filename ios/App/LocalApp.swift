import Foundation
import WebKit

/// Serves the bundled web app (<bundle>/LocalApp, ios/bundle-web.sh) on
/// wgapp://local/ for the shell's local mode (bd med-o7zq.4). Every response
/// carries the CSP, as cmd/cloud's do; connect-src reads the native host
/// mirror on each request, so a changed list applies on the next document load.
@MainActor
final class LocalApp: NSObject, WKURLSchemeHandler {
    static let shared = LocalApp()
    private let root: URL
    private let defaults: UserDefaults

    init(root: URL = Bundle.main.bundleURL.appendingPathComponent("LocalApp", isDirectory: true),
         defaults: UserDefaults = .standard) {
        self.root = root.standardizedFileURL
        self.defaults = defaults
        super.init()
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        guard let served = response(for: url) else {
            task.didFailWithError(URLError(.cannotParseResponse))
            return
        }
        task.didReceive(served.response)
        task.didReceive(served.body)
        task.didFinish()
    }

    /// Capture header and body together: later setEgressHosts calls cannot
    /// change the origins reported by a document that has already loaded.
    func response(for url: URL) -> (response: HTTPURLResponse, body: Data)? {
        var body: Data?
        let rel = url.host?.lowercased() == LocalOrigin.host ? LocalOrigin.file(for: url.path) : nil
        if let rel {
            let file = root.appendingPathComponent(rel).standardizedFileURL
            if file.path.hasPrefix(root.path + "/") { body = try? Data(contentsOf: file) }
        }
        let hosts = LocalOrigin.validHosts(defaults.array(forKey: LocalOrigin.hostsKey)) ?? []
        if rel == "index.html", let document = body {
            body = LocalOrigin.document(document, hosts: hosts)
        }
        let headers = [
            "Content-Type": body == nil ? "text/plain" : LocalOrigin.mime(rel ?? ""), // MIME of the file served
            "Content-Security-Policy": LocalOrigin.csp(hosts),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: body == nil ? 404 : 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
            return nil
        }
        return (response, body ?? Data())
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {} // answered synchronously
}
