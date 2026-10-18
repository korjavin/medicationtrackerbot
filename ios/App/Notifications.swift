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
    /// The sections a tap may open (stable section ids, CLAUDE.md rule 6).
    static let sections: Set<String> = ["today", "meds", "bp", "weight", "workouts", "health"]

    private let center = UNUserNotificationCenter.current()
    /// Set by Shell; a tap that launched the app waits here until it is.
    var onOpen: ((String) -> Void)? {
        didSet { if let section = pending, let onOpen { pending = nil; onOpen(section) } }
    }
    private var pending: String?

    /// Before the app finishes launching, so a tap that cold-starts it is delivered.
    func install() {
        center.delegate = self
    }

    func handle(_ op: String, args: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        Task {
            switch op {
            case "notifications.permission":
                reply(await permission(), nil)
            case "notifications.requestPermission":
                _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
                reply(await permission(), nil)
            case "notifications.schedule":
                do { reply(try await schedule(args["items"] as? [[String: Any]] ?? []), nil) } catch { reply(nil, error.localizedDescription) }
            case "notifications.test":
                do {
                    try await add(id: "wg-test", after: 1, body: "Test notification", section: "today")
                    reply(true, nil)
                } catch { reply(nil, error.localizedDescription) }
            default:
                reply(nil, "unsupported: \(op)")
            }
        }
    }

    private func permission() async -> String {
        switch await center.notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral: return "granted"
        case .denied: return "denied"
        default: return "default"
        }
    }

    /// Replaces every pending reminder; returns how many are now scheduled.
    private func schedule(_ items: [[String: Any]]) async throws -> Int {
        center.removeAllPendingNotificationRequests()
        // Without permission iOS refuses each add; the page re-schedules once it is granted.
        guard await permission() == "granted" else { return 0 }
        let now = Date().timeIntervalSince1970
        var count = 0
        for (i, item) in items.prefix(Notifications.cap).enumerated() {
            guard let at = (item["fireAtUnix"] as? NSNumber)?.doubleValue, at > now,
                  let body = item["body"] as? String else { continue }
            try await add(id: "wg-\(i)", after: at - now, title: item["title"] as? String, body: body,
                          section: item["section"] as? String ?? "today")
            count += 1
        }
        return count
    }

    private func add(id: String, after seconds: TimeInterval, title: String? = nil, body: String, section: String) async throws {
        let content = UNMutableNotificationContent()
        content.title = title ?? "Med Tracker"
        content.body = body
        content.sound = .default
        content.userInfo = ["section": section]
        // An interval, not calendar components: fireAtUnix is an instant, so a
        // time-zone change on the phone does not move it.
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, seconds), repeats: false)
        try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
    }

    // MARK: UNUserNotificationCenterDelegate
    // Completion-handler variants, not the async ones: a nonisolated async
    // delegate method makes the ObjC thunk call UIKit's completion handler on a
    // Swift-concurrency thread, and UIKit aborts (bd med-w6gx.19). Both hop to
    // the main actor and complete there.

    /// A reminder due while the app is open still shows, like a Web Push does.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        Task { @MainActor in completionHandler([.banner, .list, .sound]) }
    }

    /// A tap opens the reminder's section.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let raw = response.notification.request.content.userInfo["section"] as? String ?? "today"
        Task { @MainActor in
            let section = Notifications.sections.contains(raw) ? raw : "today"
            if let onOpen { onOpen(section) } else { pending = section }
            completionHandler()
        }
    }
}
