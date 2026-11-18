import XCTest

/// A failed account load retries quietly under the launch mark (bd med-si05,
/// twin of Android load-retry.mjs, med-wcpg): testscenarios/common/
/// account-load-blink. The Simulator has no airplane mode and tlsfront's /stop
/// only reaches the network path, so the Debug shell's `-wgQAFailLoads <n>`
/// fails the first n account loads synthetically (qa.test base only). The
/// account is the qa job's minted invite host (WG_QA_CLAIM_URL, never claimed
/// here: its pages load as for any visitor).
@MainActor
final class FlowQALoadRetryTests: XCTestCase {
    nonisolated override func setUp() {
        super.setUp()
        MainActor.assumeIsolated { QA.reset() } // XCTest runs setUp on the main thread
    }

    private let error = "Can't reach your account"

    private func host() throws -> String {
        let claim = try XCTUnwrap(ProcessInfo.processInfo.environment["WG_QA_CLAIM_URL"].flatMap { URL(string: $0) },
                                  "WG_QA_CLAIM_URL is unset (fake-server.sh mints it; TEST_RUNNER_ prefix in ios.yml)")
        return try XCTUnwrap(claim.host, "no host in \(claim)")
    }

    /// Cold host (no page of it ever finished here): three quiet retries
    /// (0.5 / 1.5 / 3 s), then N4 with the last error; Try again opens the page.
    func testColdHostGivesUpAfterThreeRetries() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        // wgAccountShown pinned empty (NSArgumentDomain): cold whatever an earlier flow left.
        launch(app, try host(), ["-wgAccountShown", "", "-wgQAFailLoads", "4"])
        XCTAssertFalse(app.staticTexts[error].waitForExistence(timeout: 3), "N4 showed before the retries ran")
        shot("load-retry", "cold-cycle")
        XCTAssertTrue(app.staticTexts[error].waitForExistence(timeout: 30), "four failed loads never reached N4; on screen: \(texts(app))")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'error -1004 · qa fail load'")).firstMatch.exists,
                      "N4's meta line is not the last error's")
        shot("load-retry", "cold-n4")
        let log = diagLog()
        for line in ["shell load retry 1 ", "shell load retry 2 ", "shell load retry 3 ", "shell load retry gave up"] {
            XCTAssertTrue(log.contains(line), "the diag log has no \"\(line)\": \(log.suffix(800))")
        }
        XCTAssertFalse(log.contains("shell load retry 4 "), "a cold host retried a fourth time")
        app.buttons["Try again"].tap()
        XCTAssertTrue(page(app).waitForExistence(timeout: 60), "Try again did not open the page; on screen: \(texts(app))")
        XCTAssertFalse(app.staticTexts[error].exists, "N4 still shows after Try again opened the page")
        shot("load-retry", "cold-try-again")
        app.terminate()
    }

    /// Warm host (a page of it finished here before): never N4, "Opening…"
    /// after 10 s, Switch account after 30 s, and the page once a retry works.
    /// Six failures: the 6th retry, ~35 s in, is the first real load.
    func testWarmHostNeverShowsError() throws {
        continueAfterFailure = false
        let host = try host()
        let app = XCUIApplication()
        launch(app, host, [])
        XCTAssertTrue(page(app).waitForExistence(timeout: 60), "the account page never showed; on screen: \(texts(app))")
        let end = Date().addingTimeInterval(15)
        while QA.appDefaults()?["wgAccountShown"] as? String != host, Date() < end { Thread.sleep(forTimeInterval: 0.5) }
        XCTAssertEqual(QA.appDefaults()?["wgAccountShown"] as? String, host, "a finished page did not mark the host warm")

        launch(app, host, ["-wgQAFailLoads", "6"])
        let opening = app.staticTexts["Opening…"]
        XCTAssertTrue(opening.waitForExistence(timeout: 25), "no \"Opening…\" under the mark; on screen: \(texts(app))")
        XCTAssertFalse(app.staticTexts[error].exists, "a warm host showed N4")
        shot("load-retry", "warm-opening")
        let switchAccount = app.buttons["Switch account"]
        XCTAssertTrue(switchAccount.waitForExistence(timeout: 30), "no Switch account after 30 s; on screen: \(texts(app))")
        XCTAssertFalse(app.staticTexts[error].exists, "a warm host showed N4")
        shot("load-retry", "warm-switch-account")
        XCTAssertTrue(page(app).waitForExistence(timeout: 40), "the page never opened once the loads worked; on screen: \(texts(app))")
        let gone = Date().addingTimeInterval(10)
        while opening.exists, Date() < gone { Thread.sleep(forTimeInterval: 0.5) }
        XCTAssertFalse(opening.exists, "the retry cover still shows over the page")
        XCTAssertFalse(app.staticTexts[error].exists, "a warm host showed N4")
        XCTAssertTrue(diagLog().contains("shell load retry 6 "), "the diag log has no sixth retry")
        shot("load-retry", "warm-opened")
        app.terminate()
    }

    /// A cold launch on this account, lock and local mode off.
    private func launch(_ app: XCUIApplication, _ host: String, _ extra: [String]) {
        if app.state != .notRunning {
            app.terminate()
            XCTAssertTrue(app.wait(for: .notRunning, timeout: 30), "the previous instance did not exit")
        }
        app.launchArguments = ["-wgLocalMode", "NO", "-wgLocalLockOn", "NO", "-wgLocalLock", "NO", "-wgAccountHost", host] + extra
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 60), "the app did not reach the foreground")
    }

    /// The shell's diag log (Diag.key), as persisted; polled briefly, cfprefsd writes it a moment later.
    private func diagLog() -> String {
        let end = Date().addingTimeInterval(10)
        var log = ""
        repeat {
            log = QA.appDefaults()?["wgDiagLog"] as? String ?? ""
            if log.contains("gave up") || log.contains("retry 6 ") { break }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < end
        return log
    }

    /// Any rendered element of the account's web page (its unlock page: this invite is never claimed).
    private func page(_ app: XCUIApplication) -> XCUIElement {
        app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label != ''")).firstMatch
    }

    private func texts(_ app: XCUIApplication) -> String {
        app.staticTexts.allElementsBoundByIndex.prefix(40).map(\.label).filter { !$0.isEmpty }.joined(separator: " | ")
    }

    private func shot(_ flow: String, _ step: String) {
        let attachment = XCTAttachment(screenshot: QA.stableScreenshot().0)
        attachment.name = "\(flow)-\(step).png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
