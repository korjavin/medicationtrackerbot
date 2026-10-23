import UIKit
import UserNotifications

/// Local notifications from the web app's reminder horizon (bd med-w6gx.5).
/// WKWebView has no Web Push, so the page hands its computed reminders to
/// `window.LocalNotifications` (web/static/js/native/local-notifications.js),
/// which reaches the `notifications.*` ops here through the wgNative bridge.
/// Scheduling is replace-all, like the relay's schedule: every app open and
/// every reminder-affecting edit sends the full, already-capped list.
@MainActor
final class Notifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifications()
    /// iOS keeps at most 64 pending local notifications per app.
    static let cap = 64
    private let center = UNUserNotificationCenter.current()
    /// Set by Shell: (path to open, ReminderPath-sanitized; vault the reminder
    /// belongs to — nil from builds before bd med-o7zq.9). A tap that launched
    /// the app waits here until it is.
    var onOpen: ((String, String?) -> Void)? {
        didSet { if let tap = pending, let onOpen { pending = nil; onOpen(tap.0, tap.1) } }
    }
    private var pending: (String, String?)?

    /// The vault the shell has open: "local" or the account host, nil before
    /// the shell sets it (bd med-o7zq.9). Every reminder carries it.
    /// A change drops the pending schedule — the newly opened page sends its
    /// own — so only the active vault's reminders fire, and a schedule call
    /// still in flight from the previous page adds nothing.
    var vault: String? {
        didSet {
            if oldValue != nil, oldValue != vault { center.removeAllPendingNotificationRequests() }
        }
    }

    /// Before the app finishes launching, so a tap that cold-starts it is delivered.
    func install() {
        center.delegate = self
    }

    /// The bridge checked the caller is the open vault's page; `owner` pins
    /// that vault for the whole call.
    func handle(_ op: String, args: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        let owner = vault
        Task {
            switch op {
            case "notifications.permission":
                reply(await permission(), nil)
            case "notifications.requestPermission":
                _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
                reply(await permission(), nil)
            case "notifications.schedule":
                do { reply(try await schedule(args["items"] as? [[String: Any]] ?? [], for: owner), nil) } catch { reply(nil, error.localizedDescription) }
            case "notifications.test":
                guard let owner, owner == vault else { reply(nil, "stale"); return }
                do {
                    try await add(id: "wg-test", after: 1, body: "Test notification", url: ReminderPath.fallback, vault: owner)
                    reply(true, nil)
                } catch { reply(nil, error.localizedDescription) }
            case "notifications.openSettings":
                // This app's page in iOS Settings → Notifications (iOS 16+; the target is 18).
                reply(await UIApplication.shared.open(URL(string: UIApplication.openNotificationSettingsURLString)!), nil)
            default:
                reply(nil, "unsupported: \(op)")
            }
        }
    }

    func permission() async -> String {
        switch await center.notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral: return "granted"
        case .denied: return "denied"
        default: return "default"
        }
    }

    /// Replaces every pending reminder; returns how many are now scheduled.
    /// Every check of `owner == vault` sits right before the request it
    /// guards, on the main actor: a vault switch between awaits stops the rest.
    private func schedule(_ items: [[String: Any]], for owner: String?) async throws -> Int {
        guard let owner, owner == vault else { return 0 } // the page that asked is gone
        center.removeAllPendingNotificationRequests()
        // Without permission iOS refuses each add; the page re-schedules once it is granted.
        guard await permission() == "granted" else { return 0 }
        let now = Date().timeIntervalSince1970
        var count = 0
        for (i, item) in items.prefix(Notifications.cap).enumerated() {
            guard owner == vault else { break }
            guard let at = (item["fireAtUnix"] as? NSNumber)?.doubleValue, at > now,
                  let body = item["body"] as? String else { continue }
            try await add(id: "wg-\(i)", after: at - now, title: item["title"] as? String, body: body,
                          url: item["url"] as? String ?? ReminderPath.legacy(item["section"]), vault: owner)
            count += 1
        }
        return count
    }

    /// Local mode's erase (bridge op local.reset): this vault's pending and
    /// delivered notifications go, any other vault's stay.
    func remove(vault owner: String) async {
        let mine = { (c: UNNotificationContent) in c.userInfo["vault"] as? String == owner }
        let queued = await center.pendingNotificationRequests().filter { mine($0.content) }
        center.removePendingNotificationRequests(withIdentifiers: queued.map(\.identifier))
        let delivered = await center.deliveredNotifications().filter { mine($0.request.content) }
        center.removeDeliveredNotifications(withIdentifiers: delivered.map(\.request.identifier))
    }

    private func add(id: String, after seconds: TimeInterval, title: String? = nil, body: String, url: String,
                     vault owner: String) async throws {
        let content = UNMutableNotificationContent()
        content.title = title ?? "Med Tracker"
        content.body = body
        content.sound = .default
        // The url carries opaque ids, never names; it is sanitized on tap.
        content.userInfo = ["url": url, "vault": owner]
        // An interval, not calendar components: fireAtUnix is an instant, so a
        // time-zone change on the phone does not move it.
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, seconds), repeats: false)
        // Per vault: a delivered reminder of one vault is never replaced or
        // removed by the same slot of another's.
        try await center.add(UNNotificationRequest(identifier: "\(id)-\(owner)", content: content, trigger: trigger))
    }

    // MARK: UNUserNotificationCenterDelegate
    // Completion-handler variants, not the async ones: a nonisolated async
    // delegate method makes the ObjC thunk call UIKit's completion handler on a
    // Swift-concurrency thread, and UIKit aborts (bd med-w6gx.19). Both hop to
    // the main actor and complete there.

    /// A reminder due while the app is open still shows, like a Web Push does.
    /// A native push wake (bd med-erq1.4, Push.swift) goes to the page instead
    /// and shows only when no unlocked page took it — the SW's rule (sw.js).
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let show: UNNotificationPresentationOptions = [.banner, .list, .sound]
        let kind = notification.request.trigger is UNPushNotificationTrigger
            ? notification.request.content.userInfo["kind"] as? String : nil
        Task { @MainActor in
            guard let kind, let shell = Shell.current else { return completionHandler(show) }
            shell.pushEvent(kind) { took in completionHandler(took ? [] : show) }
        }
    }

    /// A tap opens the reminder's url (bd med-w6gx.20): a dose's take sheet, else its section.
    /// A native push's alert has no url and no vault: Today (ReminderPath.fallback).
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let path = ReminderPath.sanitize(info["url"] as? String ?? ReminderPath.legacy(info["section"]))
        let vault = info["vault"] as? String
        Task { @MainActor in
            if let onOpen { onOpen(path, vault) } else { pending = (path, vault) }
            completionHandler()
        }
    }
}
