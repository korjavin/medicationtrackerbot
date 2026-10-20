import XCTest

/// The account-gone contract (bd med-w6gx.23.5, twin of android/qa
/// not-found.mjs): a 404 marked X-Account-Gone: 1 forgets the stored host and
/// says why on the first run; a bare 404 or a 503 keeps the host and shows the
/// error screen with Try again. The hosts are android/qa/tlsfront's
/// (nobody./stale./down.qa.test), set up by ios/qa/fake-server.sh in the `qa`
/// job, which also builds the app with WG_BASE_DOMAIN=qa.test.
@MainActor
final class FlowQAAccountGoneTests: XCTestCase {
    /// Every relaunch pins local mode off: another flow may have persisted it,
    /// and it wins over a stored host. The host itself is never pinned here.
    private let notLocal = ["-wgLocalMode", "NO"]

    func testAccountGone() {
        continueAfterFailure = false
        let app = XCUIApplication()

        // 1. Marked 404: the host is forgotten, the first run says why.
        openFromFirstRun(app, "https://nobody.qa.test/")
        let gone = app.staticTexts["There is no account at nobody.qa.test."]
        XCTAssertTrue(gone.waitForExistence(timeout: 30), "the marked 404 did not return to the first run with its message")
        XCTAssertTrue(app.buttons["Only on this device"].exists, "the first run lacks \"Only on this device\"")
        XCTAssertFalse(app.buttons["Try again"].exists, "the marked 404 showed the error screen")
        shot("account-gone", "no-account")
        app.terminate()
        // No prefs-plist check: cfprefsd had not flushed the removal when the
        // app was killed (CI run 39416173097). The relaunch is the proof.
        launch(app, notLocal)
        XCTAssertTrue(app.buttons["Only on this device"].waitForExistence(timeout: 30), "after relaunch the forgotten host reopened")
        XCTAssertFalse(gone.exists, "the in-memory message survived a relaunch")
        app.terminate()

        // 2. Bare 404 (a proxy's during a redeploy): the host is kept.
        openFromFirstRun(app, "https://stale.qa.test/")
        expectErrorScreen(app, "not found", "the bare 404")
        shot("account-gone", "bare-404")
        app.terminate()
        launch(app, notLocal)
        expectErrorScreen(app, "not found", "the relaunch after the bare 404")
        app.buttons["Switch account"].tap()
        XCTAssertTrue(app.buttons["Only on this device"].waitForExistence(timeout: 15), "Switch account did not return to the first run")
        app.terminate()

        // 3. 503: the error screen, and Try again keeps it (the fake keeps answering 503).
        openFromFirstRun(app, "https://down.qa.test/")
        expectErrorScreen(app, "service unavailable", "the 503")
        shot("account-gone", "503")
        app.buttons["Try again"].tap()
        expectErrorScreen(app, "service unavailable", "Try again after the 503")
        app.terminate()
    }

    private func launch(_ app: XCUIApplication, _ args: [String]) {
        app.launchArguments = args
        app.launch()
    }

    /// A fresh first run (no stored host), then the address typed and Continue.
    private func openFromFirstRun(_ app: XCUIApplication, _ address: String) {
        launch(app, notLocal + ["-wgAccountHost", ""])
        let field = app.textFields["Invite link or account address"]
        XCTAssertTrue(field.waitForExistence(timeout: 30), "the first run never showed its address field")
        field.tap()
        QA.dismissKeyboardTip(app)
        field.typeText(address)
        app.buttons["Continue"].firstMatch.tap()
    }

    /// LoadErrorView for this HTTP status text — not a TLS failure, which shows
    /// the same screen with "The certificate for this server is invalid".
    private func expectErrorScreen(_ app: XCUIApplication, _ status: String, _ what: String) {
        XCTAssertTrue(app.staticTexts["Can't open your account"].waitForExistence(timeout: 30), "\(what) did not show the error screen")
        let cert = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'certificate'")).firstMatch
        XCTAssertFalse(cert.exists, "TLS plumbing failed (the Simulator does not trust tlsfront's CA): \(cert.label)")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ==[c] %@", status)).firstMatch.exists,"\(what): the error screen does not say \"\(status)\"")
        XCTAssertTrue(app.buttons["Try again"].exists, "\(what): the error screen has no Try again")
    }

    private func shot(_ flow: String, _ step: String) {
        let attachment = XCTAttachment(screenshot: QA.stableScreenshot().0)
        attachment.name = "\(flow)-\(step).png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
