import Foundation

/// The bridge op base.post (contract med-ta2n.24 §A, bd med-ta2n.26; Android
/// twin BasePost.kt, med-ta2n.27): local mode's invite request and attested
/// feedback, POSTed by the shell to its own deployment — never page fetch, so
/// the local CSP stays without the base host. A dumb allowlisted pipe: the page
/// signs and sets the X-Attest-* headers (attest.assert), the shell only
/// carries the bytes.
///
///   base.post {path, body, headers?} → {status, headers, body}
///
/// The shell's first native egress. Foundation only, so Tests/main.swift runs
/// it against a loopback server. Nothing here logs: not the path, body,
/// headers or status.
enum BasePost {
    static let maxBody = 5_242_880 // = the server's maxFeedbackBodyBytes
    static let maxResponse = 65_536
    static let maxHeader = 8192
    static let timeout: TimeInterval = 30
    static let requestHeaders: Set<String> = ["X-Attest-Key-Id", "X-Attest-Challenge", "X-Attest-Assertion"]
    static let responseHeaders = ["X-Attest-Challenge", "X-Trial-Remaining", "Retry-After"]

    struct Reply {
        let status: Int
        let headers: [String: String]
        let body: String
        var json: [String: Any] { ["status": status, "headers": headers, "body": body] }
    }

    /// The op. `done` runs exactly once, on a background queue: with the
    /// server's reply, or an op error string (contract A6) — "network" at the
    /// 30 s deadline whatever the transfer is doing; a late outcome is dropped.
    static func call(base: String, args: [String: Any], done: @escaping (Reply?, String?) -> Void) {
        guard !base.isEmpty else { return done(nil, "no base") }
        send(root: "https://" + base, args: args, done: done)
    }

    /// `root` is "https://" + base in production; the self-check points it at a loopback server.
    static func send(root: String, args: [String: Any], timeout: TimeInterval = timeout,
                     done: @escaping (Reply?, String?) -> Void) {
        guard let path = args["path"] as? String, LocalOrigin.basePostPaths.contains(path) else { return done(nil, "invalid path") }
        guard let body = args["body"] as? String else { return done(nil, "invalid body") }
        let bytes = Data(body.utf8) // verbatim: the assertion binds SHA256(path + "\n" + body)
        guard bytes.count <= maxBody else { return done(nil, "body too large") }
        guard let extra = validHeaders(args["headers"]) else { return done(nil, "invalid headers") }
        guard let url = URL(string: root + path) else { return done(nil, "network") }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = bytes
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        for (k, v) in extra { request.setValue(v, forHTTPHeaderField: k) }

        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.urlCredentialStorage = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        // One session per call: no pooled socket, so a stale keep-alive connection
        // can never make the stack replay the POST (an invite request must not
        // double-submit; Android sends Connection: close for the same reason).
        let call = Call(done: done)
        let session = URLSession(configuration: config, delegate: call, delegateQueue: nil)
        let task = session.dataTask(with: request)
        call.task = task
        // The whole call, connect to last byte, independent of the transfer (#1274's rule).
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { call.finish(nil, "network") }
        task.resume()
        session.finishTasksAndInvalidate() // releases the delegate once the task ends
    }

    /// Only the three X-Attest-* names, case-sensitive; string values ≤ 8 KiB with no line break.
    static func validHeaders(_ raw: Any?) -> [String: String]? {
        if raw == nil || raw is NSNull { return [:] }
        guard let map = raw as? [String: Any] else { return nil }
        var out: [String: String] = [:]
        for (k, v) in map {
            guard requestHeaders.contains(k), let s = v as? String,
                  s.utf8.count <= maxHeader, !s.contains("\r"), !s.contains("\n") else { return nil }
            out[k] = s
        }
        return out
    }

    private final class Call: NSObject, URLSessionDataDelegate {
        private let lock = NSLock()
        private var answered = false
        private var data = Data()
        private var done: ((Reply?, String?) -> Void)?
        var task: URLSessionTask?

        init(done: @escaping (Reply?, String?) -> Void) { self.done = done }

        /// The first outcome wins; the transfer stops.
        func finish(_ reply: Reply?, _ error: String?) {
            lock.lock()
            let first = !answered
            answered = true
            let done = self.done
            self.done = nil
            lock.unlock()
            guard first, let done else { return }
            task?.cancel()
            done(reply, error)
        }

        // A 3xx is the reply, never a second egress.
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            self.data.append(data)
            if self.data.count > BasePost.maxResponse { finish(nil, "response too large") }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            guard error == nil, let http = task.response as? HTTPURLResponse else { return finish(nil, "network") }
            var headers: [String: String] = [:]
            for h in BasePost.responseHeaders { headers[h] = http.value(forHTTPHeaderField: h) }
            finish(Reply(status: http.statusCode, headers: headers, body: String(decoding: data, as: UTF8.self)), nil)
        }
    }
}
