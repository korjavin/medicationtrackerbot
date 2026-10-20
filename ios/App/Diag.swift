import CryptoKit
import Foundation

/// The passkey ceremony log (bd med-w6gx.24, twin of Android Diag.kt): the
/// page's `diag.append` entries and the shell's own lines, one per line,
/// redacted before they are stored and capped, so "Copy diagnostics" can be
/// pasted into a bead. Pure, checked by Tests/main.swift; Shell keeps the text
/// in UserDefaults.
enum Diag {
    static let cap = 200
    static let maxLine = 2000
    static let key = "wgDiagLog"

    /// `log` plus one redacted line, keeping the last `cap` lines.
    static func append(_ log: String, _ line: String, base: String, time: String) -> String {
        let flat = "\(time) \(redact(line, base: base))"
            .replacingOccurrences(of: "[\\r\\n]+", with: " ", options: .regularExpression)
        let lines = log.split(separator: "\n").map(String.init) + [String(flat.prefix(maxLine))]
        return lines.suffix(cap).joined(separator: "\n")
    }

    /// The base domain becomes `<base>`, each account label `<sub-xxxxxx>` (a
    /// short SHA-256, so two accounts stay distinguishable with no raw label kept).
    static func redact(_ s: String, base: String) -> String {
        guard !base.isEmpty,
              let re = try? NSRegularExpression(pattern: "([A-Za-z0-9-]+)\\." + NSRegularExpression.escapedPattern(for: base),
                                                options: .caseInsensitive) else { return s }
        let ns = s as NSString
        var out = ns
        // Back to front: earlier ranges stay valid in `out`.
        for m in re.matches(in: s, range: NSRange(location: 0, length: ns.length)).reversed() {
            let label = ns.substring(with: m.range(at: 1)).lowercased()
            out = out.replacingCharacters(in: m.range, with: "<sub-\(tag(label))>.<base>") as NSString
        }
        return (out as String).replacingOccurrences(of: base, with: "<base>", options: .caseInsensitive)
    }

    private static func tag(_ label: String) -> String {
        SHA256.hash(data: Data(label.utf8)).prefix(3).map { String(format: "%02x", $0) }.joined()
    }
}
