import XCTest

/// Native edge-swipe back and system-browser handoff (med-sz4k.6.3.3).
/// The QA driver seeds the vault and reports the current tab and visible
/// sheets; all navigation, swipes, and external-link taps are native touches.
@MainActor
final class FlowQANavigationTests: XCTestCase {
    nonisolated override func setUp() {
        super.setUp()
        MainActor.assumeIsolated { QA.reset() }
    }

    func testBackNavigation() {
        continueAfterFailure = false
        let app = XCUIApplication()
        launch(app, "flow-navigation")
        var (ok, state) = QA.tapLabel(app, "Food", until: { $0["tab"] as? String == "food" })
        XCTAssertTrue(ok, "Food did not open: \(QA.json(state))")
        (ok, state) = QA.tapLabel(app, "Meds", prefix: true, until: { $0["tab"] as? String == "meds" })
        XCTAssertTrue(ok, "Meds did not open: \(QA.json(state))")
        (ok, state) = QA.tapTarget(app, "addMed", until: { Self.hasSheet($0) })
        XCTAssertTrue(ok, "the medication sheet did not open: \(QA.json(state))")
        shot("sheet")

        edgeSwipe(app)
        (ok, state) = QA.waitFlow(app) { $0["tab"] as? String == "meds" && !Self.hasSheet($0) }
        XCTAssertTrue(ok, "back did not close the sheet on Meds: \(QA.json(state))")
        shot("meds")
        edgeSwipe(app)
        (ok, state) = QA.waitFlow(app) { $0["tab"] as? String == "food" && !Self.hasSheet($0) }
        XCTAssertTrue(ok, "back did not return to Food: \(QA.json(state))")
        shot("food")
        edgeSwipe(app)
        (ok, state) = QA.waitFlow(app) { $0["tab"] as? String == "today" && !Self.hasSheet($0) }
        XCTAssertTrue(ok, "back did not return to Today: \(QA.json(state))")
        shot("today")

        // Visit Meds, terminate, and relaunch with a scene that has no
        // navigation steps. The restored tab has no in-memory back trail.
        (ok, state) = QA.tapLabel(app, "Meds", prefix: true, until: { $0["tab"] as? String == "meds" })
        XCTAssertTrue(ok, "Meds did not open before relaunch: \(QA.json(state))")
        app.terminate()
        launch(app, "flow-navigation-restore")
        (ok, state) = QA.waitFlow(app, timeout: 15) { $0["tab"] as? String == "meds" }
        XCTAssertTrue(ok, "Meds was not restored after relaunch: \(QA.json(state))")
        edgeSwipe(app)
        (ok, state) = QA.waitFlow(app) { $0["tab"] as? String == "today" }
        XCTAssertTrue(ok, "back from restored Meds did not go to Today: \(QA.json(state))")
        shot("restored-today")
    }

    func testExternalLink() {
        continueAfterFailure = false
        let app = XCUIApplication()
        launch(app, "flow-external-link")
        let before = QA.flow(app)
        let link = QA.target(before, "link")
        XCTAssertNotNil(link, "the settings provider link is not visible: \(QA.json(before))")
        let browser = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        QA.coordinate(app, link ?? .zero).tap()
        XCTAssertTrue(browser.wait(for: .runningForeground, timeout: 30), "Safari did not become foreground")
        shot("safari")
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20), "the app did not return to foreground")
        let (ok, after) = QA.waitFlow(app, timeout: 20) {
            $0["tab"] as? String == before?["tab"] as? String && QA.target($0, "link") != nil
        }
        XCTAssertTrue(ok, "returning from Safari did not preserve the settings page: \(QA.json(after))")
        shot("returned")
    }

    private func launch(_ app: XCUIApplication, _ scene: String) {
        app.launchArguments = ["-wgLocalMode", "YES", "-wgAccountHost", "", "-wgLocalLockOn", "NO", "-wgLocalLock", "NO", "-wgQAScene", scene]
        app.launch()
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 120), "\(scene) did not become ready")
        let (ok, _) = QA.waitFlow(app, timeout: 30) { _ in true }
        XCTAssertTrue(ok && QA.report(app)?["ok"] as? Bool == true, "\(scene): \(QA.json(QA.report(app)))")
    }

    private static func hasSheet(_ state: [String: Any]) -> Bool {
        (state["modals"] as? [String] ?? []).contains("med-modal")
    }

    private func edgeSwipe(_ app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5)))
    }

    private func shot(_ step: String) {
        let attachment = XCTAttachment(screenshot: QA.stableScreenshot().0)
        attachment.name = "navigation-\(step).png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
