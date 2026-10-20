import XCTest

/// The account-gone contract (bd med-w6gx.23.5, twin of android/qa
/// not-found.mjs): a 404 marked X-Account-Gone: 1 forgets the stored host and
/// says why on the first run; a bare 404 or a 503 keeps the host and shows the
/// error screen (N4, bd med-ckm5.15: "We can't find this account" with Use
/// another invite, or "Can't reach your account" with Try again). The hosts are android/qa/tlsfront's
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
        XCTAssertTrue(gone.waitForExistence(timeout: 60), "the marked 404 did not return to the first run with its message; on screen: \(texts(app))")
        XCTAssertTrue(app.buttons["Only on this device"].exists, "the first run lacks \"Only on this device\"")
        XCTAssertFalse(app.buttons["Try again"].exists, "the marked 404 showed the error screen")
        shot("account-gone", "no-account")
        // No prefs-plist check: cfprefsd had not flushed the removal when the
        // app was killed (CI run 39416173097). The relaunch is the proof.
        launch(app, notLocal)
        XCTAssertTrue(app.buttons["Only on this device"].waitForExistence(timeout: 30), "after relaunch the forgotten host reopened")
        XCTAssertFalse(gone.exists, "the in-memory message survived a relaunch")

        // 2. Bare 404 (a proxy's during a redeploy): the host is kept.
        openFromFirstRun(app, "https://stale.qa.test/")
        expectErrorScreen(app, "We can't find this account", "404 · not found", "the bare 404")
        shot("account-gone", "bare-404")
        launch(app, notLocal)
        expectErrorScreen(app, "We can't find this account", "404 · not found", "the relaunch after the bare 404")
        app.buttons["Use another invite"].tap()
        XCTAssertTrue(app.buttons["Only on this device"].waitForExistence(timeout: 15), "Use another invite did not return to the first run")

        // 3. 503: the error screen, and Try again keeps it (the fake keeps answering 503).
        openFromFirstRun(app, "https://down.qa.test/")
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

    /// A fresh first run (no stored host), then the address typed and Continue.
    /// The keyboard's slide-to-type tip opens on tap or mid-typing and eats
    /// keystrokes (CI run 39429614834: the bare 404's first run never left),
    /// so the field's value is checked, and retyped, before submitting.
    private func openFromFirstRun(_ app: XCUIApplication, _ address: String) {
        launch(app, notLocal + ["-wgAccountHost", ""])
        let field = app.textFields["Invite link or account address"]
        XCTAssertTrue(field.waitForExistence(timeout: 30), "the first run never showed its address field")
        // The first run's own button: the tip has a "Continue" too.
        let submit = app.scrollViews.buttons["Continue"]
        for _ in 0..<3 where field.value as? String != address {
            field.tap()
            dismissTip(app, besides: submit)
            let typed = field.value as? String ?? ""
            if !typed.isEmpty, typed != field.placeholderValue {
                field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: typed.count))
            }
            field.typeText(address)
            dismissTip(app, besides: submit)
        }
        XCTAssertEqual(field.value as? String, address, "the address field did not take the typed address")
        // No wait for the first run to leave: the marked 404 brings it back,
        // maybe faster than a poll sees it go. Callers wait on the destination.
        submit.tap()
    }

    /// The slide-to-type tip, dismissed with its own Continue, never the first run's.
    private func dismissTip(_ app: XCUIApplication, besides submit: XCUIElement) {
        let tip = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Speed up your typing'")).firstMatch
        guard tip.waitForExistence(timeout: 1) else { return }
        let ours = submit.exists ? submit.frame : .null
        app.buttons.matching(identifier: "Continue").allElementsBoundByIndex
            .first { $0.frame != ours && $0.isHittable }?.tap()
        let closed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: tip)
        _ = XCTWaiter().wait(for: [closed], timeout: 5)
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
