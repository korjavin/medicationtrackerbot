import XCTest

/// A fresh Simulator install for the system's once-only refusal path.
@MainActor
final class FlowQARemindersDeniedTests: XCTestCase {
    nonisolated override func setUp() {
        super.setUp()
        MainActor.assumeIsolated { QA.reset() }
    }

    func testDeniedSettingsPath() throws {
        continueAfterFailure = false
        let claim = try XCTUnwrap(ProcessInfo.processInfo.environment["WG_QA_OFFLINE_CLAIM_URL"].flatMap(URL.init(string:)))
        let sub = try XCTUnwrap(claim.host?.split(separator: ".").first)
        let token = try XCTUnwrap(claim.fragment?.split(separator: "=").last)
        let link = try XCTUnwrap(URL(string: "medtracker://i/\(sub)#\(token)"))
        let app = XCUIApplication()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        app.launchArguments = ["-wgAccountHost", "", "-wgLocalLockOn", "NO", "-wgLocalLock", "NO", "-wgQASoftAuthn", "YES"]
        app.launch()
        XCTAssertTrue(app.webViews.buttons.firstMatch.waitForExistence(timeout: 60))
        app.open(link)
        let offer = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Turn on sync' OR label BEGINSWITH 'Sign in with'")).firstMatch
        XCTAssertTrue(offer.waitForExistence(timeout: 60)); offer.tap()
        let create = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Continue with'")).firstMatch
        XCTAssertTrue(create.waitForExistence(timeout: 60)); create.tap()
        let end = Date().addingTimeInterval(120)
        while Date() < end && !QA.tabBarShows(app, timeout: 2) {
            for label in ["Continue in browser anyway", "Skip all", "Unlock with passkey"] {
                let button = app.webViews.buttons[label]
                if button.exists { button.tap() }
            }
        }
        XCTAssertTrue(QA.tabBarShows(app, timeout: 5))
        let settings = app.webViews.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 30)); settings.tap()
        let notifications = app.webViews.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Reminders & notifications'")).firstMatch
        XCTAssertTrue(notifications.waitForExistence(timeout: 30)); notifications.tap()
        let enable = app.webViews.buttons["Enable"]
        XCTAssertTrue(enable.waitForExistence(timeout: 30)); enable.tap()
        let deny = springboard.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Don’t Allow", "Don't Allow")).firstMatch
        XCTAssertTrue(deny.waitForExistence(timeout: 30), "fresh install did not show the system permission prompt")
        deny.tap()
        let open = app.webViews.buttons["Open iOS Settings"]
        XCTAssertTrue(open.waitForExistence(timeout: 30), "refusal gave no iOS Settings button")
        let inspect = app.webViews.buttons["QA inspect notification settings"]
        XCTAssertTrue(inspect.waitForExistence(timeout: 10)); inspect.tap()
        let state = try readState(app)
        XCTAssertEqual(state["cardHidden"] as? Bool, true, "denied card is still visible")
        XCTAssertEqual(state["warning"] as? Bool, true, "denied chip lacks warning state")
        XCTAssertTrue((state["note"] as? String ?? "").contains("Reminders won’t fire. Notifications are off for Med Tracker."), "wrong denied note: \(QA.json(state))")
        XCTAssertFalse(enable.exists, "Enable should be hidden after denial")
        shot("denied")
        let preferences = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        open.tap()
        XCTAssertTrue(preferences.wait(for: .runningForeground, timeout: 30), "iOS Settings did not open")
        shot("settings")
        XCTAssertFalse(deny.waitForExistence(timeout: 5), "Settings action repeated the system prompt")
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
        XCTAssertTrue(open.waitForExistence(timeout: 15), "return lost denied guidance")
    }

    private func readState(_ app: XCUIApplication) throws -> [String: Any] {
        let node = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'QA reminder {'")).firstMatch
        let end = Date().addingTimeInterval(15)
        while Date() < end {
            if node.exists, let data = String(node.label.dropFirst("QA reminder ".count)).data(using: .utf8),
               let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any], state["phase"] as? String == "inspected" { return state }
            Thread.sleep(forTimeInterval: 0.5)
        }
        throw NSError(domain: "ReminderQA", code: 3, userInfo: [NSLocalizedDescriptionKey: "denied state probe timed out"])
    }

    private func shot(_ step: String) {
        let attachment = XCTAttachment(screenshot: QA.stableScreenshot().0)
        attachment.name = "reminder-\(step).png"; attachment.lifetime = .keepAlways; add(attachment)
    }
}
