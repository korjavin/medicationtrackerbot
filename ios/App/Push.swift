import CryptoKit
import Foundation

/// Native push (bd med-erq1.4, twin of Android Push.kt): APNs as the relay's
/// content-free wake channel in account mode. The server
/// (internal/cloudserver/nativepush.go) sends an alert with fixed text plus
/// content-available and a top-level `kind`; nothing else is read from it.
/// The system shows the alert while the app is in the background; with the
/// app in front Notifications.willPresent hands the wake to the page instead
/// (Shell.pushEvent) and shows the alert only when no unlocked page took it.
/// No drain here: the inbox drain needs the unlocked page (the DEK lives in
/// page memory). The token needs the aps-environment entitlement, which
/// the TestFlight archive gets only from a profile with Push (ios.yml, owner
/// bead med-erq1.7); without it registration fails and push.token answers null.
/// Foundation only, so Tests/main.swift checks it.
enum Push {
    /// The server's wake kinds (nativepush.go); 'token' is the shell's own.
    static let kinds: Set<String> = ["inbox-wake", "dry-queue", "token"]
    /// A background wake's grace before its completion: a live unlocked page
    /// drains meanwhile; well under iOS's 30 s budget.
    static let grace: TimeInterval = 10

    /// The device token as APNs wants it: lowercase hex.
    static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    /// For Diag: a 4-byte SHA-256 prefix, never the token itself (as Android).
    static func fingerprint(_ token: String) -> String {
        SHA256.hash(data: Data(token.utf8)).prefix(4).map { String(format: "%02x", $0) }.joined()
    }

    /// The page script for one wake: document event wg:native-push {kind}
    /// (web/static/js/native/push-token.js) on a page whose vault is unlocked
    /// (cloud-boot's MedTrackerCloud.ctx; /unlock has none). Evaluates to
    /// whether the page took it. nil for any other kind.
    static func event(_ kind: String) -> String? {
        guard kinds.contains(kind) else { return nil }
        return "(function(){if(!(window.MedTrackerCloud&&window.MedTrackerCloud.ctx))return false;"
            + "document.dispatchEvent(new CustomEvent('wg:native-push',{detail:{kind:'\(kind)'}}));return true})()"
    }
}
