import XCTest

/// A separate Simulator/claim for the pull and deletion flows. The peer uses
/// the real encrypted sync protocol; only the passkey cancellation is injected
/// by the Debug-only qa.test authenticator.
@MainActor
final class FlowQAPullDeleteTests: XCTestCase {
    nonisolated override func setUp() {
        super.setUp()
        MainActor.assumeIsolated { QA.reset() }
    }
    nonisolated override func tearDown() {
        _ = MainActor.assumeIsolated { try? QA.fakeServer("POST", "/start") }
        super.tearDown()
    }

    func testLocalPullHasNoSyncUI() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-wgLocalMode", "1", "-wgLocalLockOn", "NO", "-wgLocalLock", "NO", "-wgQAScene", "today"]
        app.launch()
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 120), "local Today did not load")
        pull(app)
        for label in ["Syncing…", "Release to sync", "Offline · showing saved data", "Offline"] {
            let node = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", label)).firstMatch
            XCTAssertFalse(node.exists, "local mode showed \(label)")
        }
        shot("pull-delete", "local-today")
    }

    func testPullAndDelete() throws {
        continueAfterFailure = false
        let claim = try XCTUnwrap(ProcessInfo.processInfo.environment["WG_QA_OFFLINE_CLAIM_URL"].flatMap(URL.init(string:)))
        let host = try XCTUnwrap(claim.host)
        let sub = try XCTUnwrap(host.split(separator: ".").first)
        let token = try XCTUnwrap(claim.fragment?.split(separator: "=").last)
        let link = try XCTUnwrap(URL(string: "medtracker://i/\(sub)#\(token)"))
        let app = XCUIApplication()
        app.launchArguments = ["-wgAccountHost", "", "-wgLocalLockOn", "NO", "-wgLocalLock", "NO", "-wgQASoftAuthn", "YES"]
        app.launch()
        XCTAssertTrue(app.webViews.buttons.firstMatch.waitForExistence(timeout: 60))
        app.open(link)
        let offer = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Turn on sync' OR label BEGINSWITH 'Sign in with'")).firstMatch
        XCTAssertTrue(offer.waitForExistence(timeout: 60)); offer.tap()
        let create = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Continue with'")).firstMatch
        XCTAssertTrue(create.waitForExistence(timeout: 60)); create.tap()
        XCTAssertTrue(openAccount(app), "claim did not open account")

        let prepared = try command(app, "peer")
        XCTAssertEqual(prepared["before"] as? Bool, false)
        pull(app)
        let got = try command(app, "observed")
        XCTAssertEqual(got["document"] as? String, prepared["document"] as? String)
        XCTAssertTrue((got["pill"] as? [String] ?? []).contains { $0.contains("Syncing") }, "no Syncing pill: \(QA.json(got))")
        XCTAssertEqual((got["toasts"] as? [String] ?? []).filter { $0 == "Synced · new entries" }.count, 1)
        XCTAssertGreaterThan(got["pulls"] as? Int ?? 0, 0)
        XCTAssertTrue((got["touch"] as? [String] ?? []).contains("touchmove"))
        XCTAssertTrue((got["row"] as? String ?? "").contains("167"))
        shot("pull-delete", "new-bp")

        _ = try command(app, "quiet"); pull(app)
        let quiet = try command(app, "quietDone")
        XCTAssertTrue((quiet["pill"] as? [String] ?? []).contains { $0.contains("Syncing") })
        XCTAssertFalse((quiet["toasts"] as? [String] ?? []).contains("Synced · new entries"), "quiet pull showed new entries")

        // Simulator host shutdown is not a radio-off event; preserve actual
        // banner evidence without synthesizing navigator.onLine.
        XCTAssertEqual(try QA.fakeServer("POST", "/stop")["listening"] as? Bool, false)
        let offline = try command(app, "network")
        attach(offline, "pull-delete-host-down.json")
        _ = try QA.fakeServer("POST", "/start")

        // Cancel the first reauthentication using the QA authenticator; verify
        // the real endpoint was reached and no DELETE reached the server.
        _ = try command(app, "cancel")
        let beforeCancel = try QA.receipts(host: host).count
        try openDelete(app)
        let cancelled = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Passkey verification was cancelled'")).firstMatch
        XCTAssertTrue(cancelled.waitForExistence(timeout: 60), "cancel error missing")
        let cancelReceipts = try QA.receipts(host: host).dropFirst(beforeCancel)
        XCTAssertTrue(cancelReceipts.contains { $0["path"] as? String == "/api/account/reauth" && $0["method"] as? String == "POST" })
        XCTAssertFalse(cancelReceipts.contains { $0["path"] as? String == "/api/account" && $0["method"] as? String == "DELETE" })
        shot("pull-delete", "cancelled")
        app.terminate(); XCTAssertTrue(app.wait(for: .notRunning, timeout: 30))
        app.launchArguments = ["-wgLocalLockOn", "NO", "-wgLocalLock", "NO", "-wgQASoftAuthn", "YES"]
        app.launch(); XCTAssertTrue(openAccount(app), "account did not reopen after cancellation")
        XCTAssertEqual(try command(app, "verify")["restored"] as? Bool, true, "the account's BP did not return after cancellation")

        // A verified soft passkey completes the real server deletion, then the
        // shell must forget the host and show the local invite screen.
        let beforeDelete = try QA.receipts(host: host).count
        try openDelete(app)
        XCTAssertTrue(QA.inviteSheetShows(app, timeout: 120), "delete did not leave account")
        let deletes = try QA.receipts(host: host).dropFirst(beforeDelete)
        XCTAssertTrue(deletes.contains { $0["path"] as? String == "/api/account" && $0["method"] as? String == "DELETE" && $0["status"] as? Int == 204 }, "no successful account DELETE")
        XCTAssertNil(QA.appDefaults()?["wgAccountHost"], "account host persisted")
        shot("pull-delete", "deleted")
    }

    private func openAccount(_ app: XCUIApplication) -> Bool {
        let end = Date().addingTimeInterval(120)
        while Date() < end {
            if QA.tabBarShows(app, timeout: 2) { return true }
            for label in ["Continue in browser anyway", "Skip all", "Unlock with passkey"] {
                let button = app.webViews.buttons[label]; if button.exists { button.tap() }
            }
        }
        return false
    }

    private func openDelete(_ app: XCUIApplication) throws {
        let settings = QA.control(app, "Settings")
        XCTAssertTrue(settings.waitForExistence(timeout: 30)); settings.tap()
        let vault = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Your vault'")).firstMatch
        XCTAssertTrue(vault.waitForExistence(timeout: 30)); vault.tap()
        let delete = app.webViews.buttons["Delete account"]
        for _ in 0..<6 where !delete.isHittable { app.swipeUp() }
        XCTAssertTrue(delete.waitForExistence(timeout: 20)); delete.tap()
        let input = app.webViews.textFields.firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 20))
        let confirm = app.webViews.buttons["Delete account"].allElementsBoundByIndex.last
        XCTAssertFalse(confirm?.isEnabled ?? true, "delete enabled without phrase")
        input.tap(); input.typeText("DELETE")
        let button = try XCTUnwrap(confirm)
        XCTAssertTrue(button.isEnabled, "typed DELETE did not enable confirmation")
        button.tap()
    }

    private func pull(_ app: XCUIApplication) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: XCUIGestureVelocity(600), thenHoldForDuration: 0.1)
    }

    @discardableResult private func command(_ app: XCUIApplication, _ name: String) throws -> [String: Any] {
        let button = app.webViews.buttons["QA Pull " + name]
        XCTAssertTrue(button.waitForExistence(timeout: 30), "missing probe \(name)"); button.tap()
        let node = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'QA Pull {'")).firstMatch
        let end = Date().addingTimeInterval(120)
        while Date() < end {
            if node.exists, let data = String(node.label.dropFirst("QA Pull ".count)).data(using: .utf8),
               let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let phase = state["phase"] as? String, phase == name + "-done" || phase == name + "-error" {
                XCTAssertEqual(phase, name + "-done", "probe: \(QA.json(state))")
                return state
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTFail("probe \(name) timed out: \(node.label)"); return [:]
    }
    private func attach(_ object: [String: Any], _ name: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) else { return }
        let a = XCTAttachment(data: data, uniformTypeIdentifier: "public.json"); a.name = name; a.lifetime = .keepAlways; add(a)
    }
    private func shot(_ flow: String, _ step: String) {
        let a = XCTAttachment(screenshot: QA.stableScreenshot().0); a.name = "\(flow)-\(step).png"; a.lifetime = .keepAlways; add(a)
    }
}
