import XCTest

/// Flow QA on the Simulator (bd med-w6gx.23, docs/ios.md "Flow QA
/// (Simulator)"): the iOS twin of android/qa, local mode only (no account, no
/// passkey). One test method per flow; a flow is a contract, so the first
/// failed step ends it. Screenshots attach as `<flow>-<step>.png`, kept on
/// success too (the `qa` job in .github/workflows/ios.yml exports them).
///
/// Assertions are UI-observable or files the app already writes (QA.appContainer).
/// No app hook beyond the visual tier's Debug-only `-wgQAScene`.
///
/// One flow: `xcodebuild test-without-building ... -only-testing:MedTrackerUITests/FlowQATests/testLocalFirstRun`.
@MainActor
final class FlowQATests: XCTestCase {
    /// First run → "Only on this device" → intro (lock off) → Start → the app
    /// (seeded by the QA driver) → relaunch with no arguments: local mode
    /// persisted, no first-run screen.
    func testLocalFirstRun() {
        continueAfterFailure = false
        let flow = "local-first-run"
        let app = XCUIApplication()
        // NSArgumentDomain over any persisted choice: first-run, and the QA
        // driver's scene once local mode opens (it seeds the golden vault and
        // completes the web onboarding, tests/visual/driver.js).
        app.launchArguments = ["-wgLocalMode", "NO", "-wgAccountHost", "", "-wgQAScene", "today"]
        app.launch()

        let onlyHere = app.buttons["Only on this device"]
        XCTAssertTrue(onlyHere.waitForExistence(timeout: 30), "first run never showed \"Only on this device\"")
        shot(flow, "first-run")
        onlyHere.tap()

        let start = app.buttons["Start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10), "the local intro never showed \"Start\"")
        // The lock toggle shows only where Face ID / a passcode is set up.
        let lock = app.switches.firstMatch
        if lock.exists { XCTAssertEqual(lock.value as? String, "0", "the intro's lock toggle starts on") }
        shot(flow, "intro")
        start.tap()

        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 90), "the local app never published #wg-qa-ready")
        let inApp = QA.tabBarShows(app, timeout: 10)
        shot(flow, "app")
        XCTAssertTrue(inApp, "the local app shows no tab bar")

        app.terminate()
        app.launchArguments = []
        app.launch()
        let back = QA.tabBarShows(app, timeout: 60)
        shot(flow, "relaunch")
        XCTAssertTrue(back, "after relaunch the local app shows no tab bar")
        XCTAssertFalse(app.buttons["Only on this device"].exists, "after relaunch first run showed again")
        // The persisted choice itself, read from the app's container.
        XCTAssertNotNil(QA.appContainer(), "the app's data container is not visible to the test runner")
        XCTAssertEqual(QA.appDefaults()?["wgLocalMode"] as? Bool, true, "wgLocalMode is not persisted in the app's defaults")
        app.terminate()
    }

    private func shot(_ flow: String, _ step: String) {
        let attachment = XCTAttachment(screenshot: QA.stableScreenshot().0)
        attachment.name = "\(flow)-\(step).png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
