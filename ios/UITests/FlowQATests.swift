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
    nonisolated override func setUp() {
        super.setUp()
        // bd med-w6gx.23.8: a clean slate, so one failed flow stays one red test.
        MainActor.assumeIsolated { QA.reset() } // XCTest runs setUp on the main thread
    }

    /// Cold launch with no account (bd med-ta2n.17): no native first run — the
    /// app opens straight into local mode's web W1 picker, with the v3 shell's
    /// "Have an invite?" footer. Then the app (seeded by the QA driver) →
    /// relaunch with no arguments: still local, the mode persisted.
    func testLocalFirstRun() {
        continueAfterFailure = false
        let flow = "local-first-run"
        let app = XCUIApplication()
        // A fresh install: no account, no local-mode choice, an empty local store.
        let fresh = ["-wgLocalMode", "NO", "-wgAccountHost", "", "-wgLocalLockOn", "NO", "-wgLocalLock", "NO"]
        app.launchArguments = fresh // setUp's QA.reset emptied the store
        app.launch()

        XCTAssertTrue(QA.w1Shows(app, timeout: 60), "the cold launch did not open the web W1 picker")
        let invite = app.webViews.buttons["Have an invite?"].waitForExistence(timeout: 10)
        shot(flow, "cold-launch")
        XCTAssertTrue(invite, "W1 has no \"Have an invite?\" footer (shell.ops lacks invite.pending?)")
        XCTAssertFalse(app.buttons["Only on this device"].exists, "a native first run showed")
        app.terminate()

        // The QA driver's scene seeds the golden vault and completes the web
        // onboarding (tests/visual/driver.js).
        app.launchArguments = ["-wgAccountHost", "", "-wgLocalLockOn", "NO", "-wgLocalLock", "NO", "-wgQAScene", "today"]
        app.launch()
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 90), "the local app never published #wg-qa-ready")
        let inApp = QA.tabBarShows(app, timeout: 10)
        shot(flow, "app")
        XCTAssertTrue(inApp, "the local app shows no tab bar")

        app.terminate()
        app.launchArguments = ["-wgLocalLock", "NO"] // the persisted mode only (the lock pinned off, as everywhere)
        app.launch()
        let back = QA.tabBarShows(app, timeout: 60)
        shot(flow, "relaunch")
        XCTAssertTrue(back, "after relaunch the local app shows no tab bar")
        XCTAssertFalse(app.buttons["Only on this device"].exists, "after relaunch a native first run showed")
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
