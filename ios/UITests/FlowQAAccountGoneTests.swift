import XCTest

/// The account-gone contract (bd med-w6gx.23.5, twin of android/qa
/// not-found.mjs): a 404 marked X-Account-Gone: 1 forgets the host and lands
/// in local mode on home?invite=1, where the web opens "Have an invite?" (bd
/// med-ta2n.17, contract med-ta2n.7 §7); a bare 404 or a 503 keeps the host
/// and shows the error screen (N4, bd med-ckm5.15: "We can't find this
/// account" with Use another invite, or "Can't reach your account" with Try
/// again). The hosts are android/qa/tlsfront's (nobody./stale./down.qa.test),
/// set up by ios/qa/fake-server.sh in the `qa` job, which also builds the app
/// with WG_BASE_DOMAIN=qa.test. With no native first run, the account comes
/// from the launch arguments (NSArgumentDomain), so a relaunch with them
/// reopens it: the forgotten host is proven in memory, not across launches.
@MainActor
final class FlowQAAccountGoneTests: XCTestCase {
    nonisolated override func setUp() {
        super.setUp()
        // bd med-w6gx.23.8: a clean slate, so one failed flow stays one red test.
        MainActor.assumeIsolated { QA.reset() } // XCTest runs setUp on the main thread
    }

    /// Local mode off (another flow may have persisted it, and it wins over a
    /// host), the lock off (the landing is local mode), and this account.
    private func account(_ host: String) -> [String] {
        ["-wgLocalMode", "NO", "-wgLocalLockOn", "NO", "-wgLocalLock", "NO", "-wgAccountHost", host]
    }

    func testAccountGone() {
        continueAfterFailure = false
        let app = XCUIApplication()

        // 1. Marked 404: the host is forgotten, local mode with "Have an invite?".
        launch(app, account("nobody.qa.test"))
        let landed = QA.inviteSheetShows(app, timeout: 60)
        shot("account-gone", "landing")
        XCTAssertTrue(landed, "the marked 404 did not land on local mode's \"Have an invite?\"; on screen: \(texts(app))")
        XCTAssertFalse(app.buttons["Try again"].exists, "the marked 404 showed the error screen")

        // 2. Bare 404 (a proxy's during a redeploy): the host is kept.
        launch(app, account("stale.qa.test"))
        expectErrorScreen(app, "We can't find this account", "404 · not found", "the bare 404")
        shot("account-gone", "bare-404")
        launch(app, account("stale.qa.test"))
        expectErrorScreen(app, "We can't find this account", "404 · not found", "the relaunch after the bare 404")
        app.buttons["Use another invite"].tap()
        XCTAssertTrue(QA.inviteSheetShows(app, timeout: 60), "Use another invite did not land on local mode's \"Have an invite?\"")
        shot("account-gone", "use-another-invite")

        // 3. 503: the error screen, and Try again keeps it (the fake keeps answering 503).
        launch(app, account("down.qa.test"))
        expectErrorScreen(app, "Can't reach your account", "503 · service unavailable", "the 503")
        XCTAssertTrue(app.buttons["Switch account"].exists, "the 503 screen has no Switch account")
        shot("account-gone", "503")
        app.buttons["Try again"].tap()
        expectErrorScreen(app, "Can't reach your account", "503 · service unavailable", "Try again after the 503")
        app.terminate()
    }

    /// A cold launch, ordered (bd med-w6gx.23.6): the previous instance has
    /// exited before the next starts, and the next is in the foreground
    /// before any query ("Timed out while acquiring background assertion",
    /// CI run 39419413374, was a launch).
    private func launch(_ app: XCUIApplication, _ args: [String]) {
        if app.state != .notRunning {
            app.terminate()
            XCTAssertTrue(app.wait(for: .notRunning, timeout: 30), "the previous instance did not exit")
        }
        app.launchArguments = args
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 60), "the app did not reach the foreground")
    }

    /// LoadErrorView with this title and meta line ("404 · not found · 09:41") —
    /// not a TLS failure, whose meta line says "The certificate for this server is invalid".
    private func expectErrorScreen(_ app: XCUIApplication, _ title: String, _ status: String, _ what: String) {
        guard app.staticTexts[title].waitForExistence(timeout: 60) else {
            return XCTFail("\(what) did not show the error screen \"\(title)\"; on screen: \(texts(app))")
        }
        let cert = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'certificate'")).firstMatch
        XCTAssertFalse(cert.exists, "TLS plumbing failed (the Simulator does not trust tlsfront's CA): \(cert.label)")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", status)).firstMatch.exists, "\(what): the error screen's meta line does not start \"\(status)\"")
        XCTAssertTrue(app.buttons["Try again"].exists, "\(what): the error screen has no Try again")
        XCTAssertTrue(app.buttons["Copy diagnostics"].exists, "\(what): the error screen has no Copy diagnostics")
    }

    /// The static texts on screen, for a failure message: the qa job exports
    /// only the screenshots, not the xcresult's UI hierarchy.
    private func texts(_ app: XCUIApplication) -> String {
        app.staticTexts.allElementsBoundByIndex.map(\.label).filter { !$0.isEmpty }.joined(separator: " | ")
    }

    private func shot(_ flow: String, _ step: String) {
        let attachment = XCTAttachment(screenshot: QA.stableScreenshot().0)
        attachment.name = "\(flow)-\(step).png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
