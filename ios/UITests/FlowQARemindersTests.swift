import XCTest

/// A real Settings permission grant and a real local notification after the
/// process exits and the account server stops (med-sz4k.6.3.1).
@MainActor
final class FlowQARemindersTests: XCTestCase {
    nonisolated override func setUp() {
        super.setUp()
        MainActor.assumeIsolated { QA.reset() }
    }

    func testNotificationAndOfflineReminder() throws {
        continueAfterFailure = false
        defer { _ = try? QA.fakeServer("POST", "/start") }
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
        XCTAssertTrue(openAccount(app, timeout: 120), "claim did not open account")

        let settings = app.webViews.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 30)); settings.tap()
        let notifications = app.webViews.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Reminders & notifications'")).firstMatch
        XCTAssertTrue(notifications.waitForExistence(timeout: 30)); notifications.tap()
        let enable = app.webViews.buttons["Enable"]
        XCTAssertTrue(enable.waitForExistence(timeout: 30), "no notification Enable")
        enable.tap()
        let allow = springboard.buttons["Allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 30), "fresh install did not show the system permission prompt")
        shot("system-prompt")
        allow.tap()
        let disable = app.webViews.buttons["Disable"]
        XCTAssertTrue(disable.waitForExistence(timeout: 30), "grant did not turn the control on")
        XCTAssertTrue(app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Wake-ups: off (not connected yet)'")).firstMatch.waitForExistence(timeout: 30), "no token must show Wake-ups off")
        shot("enabled")

        let setup = app.webViews.buttons["QA schedule reminder"]
        XCTAssertTrue(setup.waitForExistence(timeout: 30)); setup.tap()
        let state = try waitState(app, timeout: 90)
        let body = try XCTUnwrap(state["body"] as? String)
        let fireAt = try XCTUnwrap(state["fireAt"] as? Double)
        XCTAssertGreaterThan(fireAt, Date().timeIntervalSince1970 + 30, "reminder no longer has time to survive termination")
        XCTAssertGreaterThan(state["count"] as? Int ?? 0, 0)
        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 30))
        XCTAssertEqual(try QA.fakeServer("POST", "/stop")["listening"] as? Bool, false)
        let banner = springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", body)).firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 240), "local reminder did not fire with app stopped and server down")
        shot("delivered")
        banner.tap()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 60), "notification did not cold-open the app")
        let med = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS 'QA Offline Reminder'")).firstMatch
        XCTAssertTrue(med.waitForExistence(timeout: 120), "notification did not open this medication's take sheet")
        let take = app.webViews.buttons.matching(NSPredicate(format: "label CONTAINS 'Take'")).firstMatch
        XCTAssertTrue(take.waitForExistence(timeout: 15), "dose is not ready to take")
        shot("take-sheet")
    }

    private func openAccount(_ app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if QA.tabBarShows(app, timeout: 2) { return true }
            for label in ["Continue in browser anyway", "Skip all", "Unlock with passkey"] {
                let button = app.webViews.buttons[label]
                if button.exists { button.tap() }
            }
        }
        return false
    }

    private func waitState(_ app: XCUIApplication, timeout: TimeInterval) throws -> [String: Any] {
        let end = Date().addingTimeInterval(timeout)
        let node = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'QA reminder {'")).firstMatch
        while Date() < end {
            if node.exists, let data = String(node.label.dropFirst("QA reminder ".count)).data(using: .utf8),
               let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if state["phase"] as? String == "done" { return state }
                if state["phase"] as? String == "error" { throw NSError(domain: "ReminderQA", code: 1, userInfo: [NSLocalizedDescriptionKey: QA.json(state)]) }
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        throw NSError(domain: "ReminderQA", code: 2, userInfo: [NSLocalizedDescriptionKey: "schedule probe timed out"])
    }

    private func shot(_ step: String) {
        let attachment = XCTAttachment(screenshot: QA.stableScreenshot().0)
        attachment.name = "reminder-\(step).png"; attachment.lifetime = .keepAlways; add(attachment)
    }
}
