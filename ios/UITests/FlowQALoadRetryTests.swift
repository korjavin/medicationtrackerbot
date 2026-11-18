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
        let markers = ["shell load retry 1 ", "shell load retry 2 ", "shell load retry 3 ", "shell load retry 4 ", "shell load retry gave up"]
        let since = Date()
        // The host's flag pinned off (NSArgumentDomain): cold whatever an earlier flow left.
        let host = try host()
        launch(app, host, ["-wgAccountShown:" + host, "NO", "-wgQAFailLoads", "4"])
        XCTAssertFalse(app.staticTexts[error].waitForExistence(timeout: 3), "N4 showed before the retries ran")
        shot("load-retry", "cold-cycle")
        XCTAssertTrue(app.staticTexts[error].waitForExistence(timeout: 30), "four failed loads never reached N4; on screen: \(texts(app))")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'error -1004 · qa fail load'")).firstMatch.exists,
                      "N4's meta line is not the last error's")
        shot("load-retry", "cold-n4")
        let want = [1, 1, 1, 0, 1]
        XCTAssertEqual(waitDiag(markers, since: since, want), want,"the cycle's diag lines (retry 1-3, no retry 4, gave up) per \(markers)")
        app.buttons["Try again"].tap()
        XCTAssertTrue(page(app).waitForExistence(timeout: 60), "Try again did not open the page; on screen: \(texts(app))")
        XCTAssertFalse(app.staticTexts[error].exists, "N4 still shows after Try again opened the page")
        shot("load-retry", "cold-try-again")
        app.terminate()
    }

    /// Warm host (a page of it finished here before): never N4. (a) One
    /// blink opens the page. Six failures: "Opening…" after 10 s, Switch
    /// account + Copy diagnostics after 30 s, the page on the 6th retry (~35 s
    /// in, the first real load). (b) n=99: no N4 by 35 s; Switch account
    /// lands in local mode on F1 and the host's flag stays (Miles 27084).
    func testWarmHostNeverShowsError() throws {
        continueAfterFailure = false
        let host = try host()
        let flag = "wgAccountShown:" + host
        let app = XCUIApplication()
        launch(app, host, [])
        XCTAssertTrue(page(app).waitForExistence(timeout: 60), "the account page never showed; on screen: \(texts(app))")
        XCTAssertTrue(waitFlag(flag), "a finished page did not mark the host warm (\(flag))")

        // One blink: the first retry (0.5 s) opens the page, no error screen at any point.
        let one = ["shell load retry 1 ", "shell load retry 2 "]
        let blinkSince = Date()
        launch(app, host, ["-wgQAFailLoads", "1"])
        XCTAssertTrue(page(app).waitForExistence(timeout: 60), "one failed load did not end on the page; on screen: \(texts(app))")
        XCTAssertFalse(app.staticTexts[error].exists, "a warm host showed N4 after one failed load")
        XCTAssertEqual(waitDiag(one, since: blinkSince, [1, 0]), [1, 0],"one blink is one retry (counts of \(one))")
        shot("load-retry", "warm-blink")

        let six = ["shell load retry 6 ", "shell load retry gave up"]
        let sixSince = Date()
        launch(app, host, ["-wgQAFailLoads", "6"])
        let opening = app.staticTexts["Opening…"]
        XCTAssertTrue(opening.waitForExistence(timeout: 25), "no \"Opening…\" under the mark; on screen: \(texts(app))")
        XCTAssertFalse(app.staticTexts[error].exists, "a warm host showed N4")
        shot("load-retry", "warm-opening")
        let switchAccount = app.buttons["Switch account"]
        XCTAssertTrue(switchAccount.waitForExistence(timeout: 30), "no Switch account after 30 s; on screen: \(texts(app))")
        XCTAssertTrue(app.buttons["Copy diagnostics"].exists, "no Copy diagnostics beside Switch account")
        XCTAssertFalse(app.staticTexts[error].exists, "a warm host showed N4")
        shot("load-retry", "warm-switch-account")
        XCTAssertTrue(page(app).waitForExistence(timeout: 40), "the page never opened once the loads worked; on screen: \(texts(app))")
        let gone = Date().addingTimeInterval(10)
        while opening.exists, Date() < gone { Thread.sleep(forTimeInterval: 0.5) }
        XCTAssertFalse(opening.exists, "the retry cover still shows over the page")
        XCTAssertFalse(app.staticTexts[error].exists, "a warm host showed N4")
        XCTAssertEqual(waitDiag(six, since: sixSince, [1, 0]), [1, 0],"a warm host retried a sixth time and never gave up (counts of \(six))")
        shot("load-retry", "warm-opened")

        // (b) It never works: no N4 by 35 s, and Switch account is the way out.
        launch(app, host, ["-wgQAFailLoads", "99"])
        let start = Date()
        XCTAssertTrue(app.buttons["Switch account"].waitForExistence(timeout: 40), "n=99: no Switch account; on screen: \(texts(app))")
        let rest = 35 - Date().timeIntervalSince(start)
        if rest > 0 { XCTAssertFalse(app.staticTexts[error].waitForExistence(timeout: rest), "n=99: a warm host showed N4") }
        XCTAssertFalse(app.staticTexts[error].exists, "n=99: a warm host showed N4")
        shot("load-retry", "warm-stuck")
        app.buttons["Switch account"].tap()
        XCTAssertTrue(QA.inviteSheetShows(app, timeout: 60), "Switch account did not land on local mode's \"Have an invite?\"; on screen: \(texts(app))")
        XCTAssertEqual(QA.appDefaults()?[flag] as? Bool, true, "Switch account dropped the host's warm flag")
        shot("load-retry", "warm-switched")
        app.terminate()
    }

    /// Polls the persisted defaults until `key` is true (cfprefsd writes a moment later).
    private func waitFlag(_ key: String) -> Bool {
        let end = Date().addingTimeInterval(15)
        while QA.appDefaults()?[key] as? Bool != true, Date() < end { Thread.sleep(forTimeInterval: 0.5) }
        return QA.appDefaults()?[key] as? Bool == true
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

    /// How many lines of the shell's persisted diag log (Diag.key) since `since`
    /// contain each marker. The log outlives launches (and QA.reset) and is
    /// capped, so only lines stamped from `since` on count (ISO 8601 UTC sorts as text).
    private func diagCounts(_ markers: [String], since: Date) -> [Int] {
        let from = ISO8601DateFormatter().string(from: since)
        let lines = (QA.appDefaults()?["wgDiagLog"] as? String ?? "").split(separator: "\n")
            .filter { String($0.prefix(from.count)) >= from }
        return markers.map { m in lines.filter { $0.contains(m) }.count }
    }

    /// Polls until the counts are `want` (cfprefsd writes a moment later); the last counts.
    private func waitDiag(_ markers: [String], since: Date, _ want: [Int]) -> [Int] {
        let end = Date().addingTimeInterval(10)
        var now = diagCounts(markers, since: since)
        while now != want, Date() < end {
            Thread.sleep(forTimeInterval: 0.5)
            now = diagCounts(markers, since: since)
        }
        return now
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
