import XCTest

/// N5 (bd med-ckm5.15, med-ckm5.2): the shell has no exit bar of its own; the
/// ceremony page's web `.wg-exitbar` ("Not your account?") confirms in-page and
/// calls bridge op account.leave, which forgets the host and shows the native
/// first run. The invite is a real one: ios/qa/fake-server.sh runs cmd/cloud
/// behind tlsfront and hands its claim URL over as WG_QA_CLAIM_URL.
@MainActor
final class FlowQACeremonyExitTests: XCTestCase {
    func testWebExitBarLeaves() throws {
        continueAfterFailure = false
        let claim = try XCTUnwrap(ProcessInfo.processInfo.environment["WG_QA_CLAIM_URL"].flatMap { $0.isEmpty ? nil : $0 },
                                  "WG_QA_CLAIM_URL is unset (fake-server.sh mints it; TEST_RUNNER_ prefix in ios.yml)")
        let app = XCUIApplication()
        app.launchArguments = ["-wgLocalMode", "NO", "-wgAccountHost", ""]
        app.launch()
        let field = app.textFields["Invite link or account address"]
        XCTAssertTrue(field.waitForExistence(timeout: 30), "the first run never showed its address field")
        field.tap()
        QA.dismissKeyboardTip(app)
        field.typeText(claim)
        app.buttons["Continue"].firstMatch.tap()

        let leave = app.webViews.buttons["Not your account?"]
        XCTAssertTrue(leave.waitForExistence(timeout: 60), "the ceremony page shows no web exit bar")
        XCTAssertFalse(app.buttons["Not your account? Use another invite"].exists, "the old native bar is still there")
        shot("ceremony-exit", "bar")
        leave.tap()
        let confirm = app.webViews.buttons["Use another invite"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 10), "\"Not your account?\" opened no confirm")
        shot("ceremony-exit", "confirm")
        confirm.tap()
        XCTAssertTrue(app.buttons["Only on this device"].waitForExistence(timeout: 15),
                      "account.leave did not return to the native first run")
        shot("ceremony-exit", "first-run")
        app.terminate()
        app.launchArguments = ["-wgLocalMode", "NO"]
        app.launch()
        XCTAssertTrue(app.buttons["Only on this device"].waitForExistence(timeout: 30), "after relaunch the left account reopened")
        app.terminate()
    }

    private func shot(_ flow: String, _ step: String) {
        let attachment = XCTAttachment(screenshot: QA.stableScreenshot().0)
        attachment.name = "\(flow)-\(step).png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
