import Foundation
import WebKit

/// Serves the bundled web app (<bundle>/LocalApp, ios/bundle-web.sh) on
/// wgapp://local/ for the shell's local mode (bd med-o7zq.4). Every response
/// carries the CSP, as cmd/cloud's do; connect-src reads the native host
/// mirror on each request, so a changed list applies on the next document load.
@MainActor
final class LocalApp: NSObject, WKURLSchemeHandler {
    static let shared = LocalApp()
    private let root = Bundle.main.bundleURL.appendingPathComponent("LocalApp", isDirectory: true).standardizedFileURL

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        var body: Data?
        if url.host?.lowercased() == LocalOrigin.host, let rel = LocalOrigin.file(for: url.path.isEmpty ? "/" : url.path) {
            let file = root.appendingPathComponent(rel).standardizedFileURL
            if file.path.hasPrefix(root.path + "/") { body = try? Data(contentsOf: file) }
        }
        let hosts = LocalOrigin.validHosts(UserDefaults.standard.array(forKey: LocalOrigin.hostsKey)) ?? []
        let headers = [
            "Content-Type": body == nil ? "text/plain" : LocalOrigin.mime(url.path == "/" ? "/index.html" : url.path),
            "Content-Security-Policy": LocalOrigin.csp(hosts),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: body == nil ? 404 : 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.cannotParseResponse))
            return
        }
        task.didReceive(response)
        task.didReceive(body ?? Data())
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {} // answered synchronously
}
