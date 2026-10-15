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

    /// Exactly one DNS label under base: what the webcredentials wildcard and
    /// the WKAppBoundDomains entry cover.
    static func isAccountHost(_ host: String, base: String) -> Bool {
        guard !base.isEmpty, host.hasSuffix("." + base) else { return false }
        let label = host.dropLast(base.count + 1)
        return !label.isEmpty && !label.contains(".")
    }
}
