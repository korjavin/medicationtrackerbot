import XCTest

/// A fresh Simulator install for the system's once-only refusal path.
@MainActor
final class FlowQARemindersDeniedTests: XCTestCase {
    nonisolated override func setUp() {
        super.setUp()
        MainActor.assumeIsolated { QA.reset() }
    }

    func testDeniedAndRepeatEnable() throws {
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
        let guidance = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'iOS Settings'" )).firstMatch
        XCTAssertTrue(guidance.waitForExistence(timeout: 30), "refusal gave no iOS Settings guidance")
        XCTAssertTrue(enable.waitForExistence(timeout: 10), "Enable is not ready after refusal")
        enable.tap()
        XCTAssertFalse(deny.waitForExistence(timeout: 5), "later Enable repeated the system prompt")
        XCTAssertTrue(guidance.exists, "later Enable lost the Settings guidance")
    }
}
