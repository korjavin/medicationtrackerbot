import Foundation

/// What the first-run screen accepts (bd med-w6gx.3): an invite/claim link, a
/// device hand-off link, a bare account address, or the Emergency Kit QR
/// (origin, account id and recovery code on separate lines — only the first
/// line is read, the code is never touched). Foundation only, so CI can run
/// ios/Tests/main.swift against it without a simulator.
enum AccountURL {
    /// The URL to open, or nil when the input is not an account on this deployment.
    static func parse(_ raw: String, base: String) -> URL? {
        let base = base.lowercased()
        guard !base.isEmpty,
              let line = raw.split(whereSeparator: \.isNewline)
                  .map({ $0.trimmingCharacters(in: .whitespaces) })
                  .first(where: { !$0.isEmpty })
        else { return nil }
        guard var parts = URLComponents(string: line.contains("://") ? line : "https://" + line),
              parts.scheme?.lowercased() == "https",
              parts.user == nil, parts.password == nil, parts.port == nil,
              let host = parts.host?.lowercased(), isAccountHost(host, base: base)
        else { return nil }
        parts.scheme = "https"
        parts.host = host
        if parts.path.isEmpty { parts.path = "/" }
        return parts.url
    }

    /// An invite the app was opened with (bd med-ta2n.11, contract med-ta2n.7
    /// §1/§5) as the claim URL https://<sub>.<base>/#claim=<token>: the landing
    /// page https://<base>/i/<sub>#<token> (universal link), the scheme
    /// medtracker://i/<sub>#<token>, or anything parse() accepts. nil otherwise.
    static func parseInvite(_ raw: String, base: String) -> URL? {
        let base = base.lowercased()
        let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !base.isEmpty, let parts = URLComponents(string: line) else { return nil }
        let scheme = parts.scheme?.lowercased(), host = parts.host?.lowercased()
        let landing = scheme == "https" && host == base && parts.port == nil
        let custom = scheme == "medtracker" && host == "i"
        guard landing || custom else { return parse(raw, base: base) }
        // Landing path "/i/<sub>"; the scheme's host is "i", so its path is "/<sub>".
        let sub = parts.path.hasPrefix(landing ? "/i/" : "/") ? String(parts.path.dropFirst(landing ? 3 : 1)).lowercased() : ""
        let tok = parts.fragment ?? ""
        guard parts.user == nil, parts.port == nil, parts.password == nil, parts.query == nil,
              !sub.isEmpty, sub.allSatisfy({ ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }),
              !tok.isEmpty, tok.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
        else { return nil }
        return parse("https://\(sub).\(base)/#claim=\(tok)", base: base)
    }

    /// The server's own "no such account" 404 (bd med-w6gx.22, twin of Android's
    /// AccountUrl.accountGone): cmd/cloud marks it with X-Account-Gone: 1
    /// (internal/cloudserver/router.go). A bare 404 — a proxy's during a
    /// redeploy, an older server — is not proof the account is gone.
    static func accountGone(_ status: Int, _ headers: [AnyHashable: Any]) -> Bool {
        status == 404 && headers.contains { h in
            (h.key as? String)?.caseInsensitiveCompare("X-Account-Gone") == .orderedSame
                && (h.value as? String)?.trimmingCharacters(in: .whitespaces) == "1"
        }
    }

    /// Exactly one DNS label under base: what the webcredentials wildcard and
    /// the WKAppBoundDomains entry cover.
    static func isAccountHost(_ host: String, base: String) -> Bool {
        guard !base.isEmpty, host.hasSuffix("." + base) else { return false }
        let label = host.dropLast(base.count + 1)
        return !label.isEmpty && !label.contains(".")
    }
}

/// The pending-invite slot (bd med-ta2n.11, contract med-ta2n.7 §5): the last
/// invite the app was opened with, as its claim URL, persisted until the page
/// consumes it (local.leave/account.leave {url}) or drops it (invite.clear).
/// Newest wins; the shell never expires it — staleness is the web's call.
enum InviteSlot {
    static let key = "wgPendingInvite"

    /// invite.pending's reply: {url, receivedAt (epoch ms)}, or nil when empty.
    static func pending(_ defaults: UserDefaults = .standard) -> [String: Any]? {
        guard let slot = defaults.dictionary(forKey: key), let url = slot["url"] as? String,
              let at = (slot["receivedAt"] as? NSNumber)?.int64Value else { return nil }
        return ["url": url, "receivedAt": at]
    }

    static func store(_ url: URL, at: Date = Date(), _ defaults: UserDefaults = .standard) {
        defaults.set(["url": url.absoluteString, "receivedAt": Int64(at.timeIntervalSince1970 * 1000)], forKey: key)
    }

    static func clear(_ defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key)
    }
}
