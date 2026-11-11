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
        let claim = try XCTUnwrap(ProcessInfo.processInfo.environment["WG_QA_PULL_DELETE_CLAIM_URL"].flatMap(URL.init(string:)))
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
        XCTAssertEqual(cancelReceipts.filter { $0["path"] as? String == "/api/account/reauth" && $0["method"] as? String == "POST" }.count, 1)
        XCTAssertFalse(cancelReceipts.contains { $0["path"] as? String == "/api/account" && $0["method"] as? String == "DELETE" })
        XCTAssertTrue(app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Delete account'")).firstMatch.isEnabled, "delete button was not re-enabled")
        shot("pull-delete", "cancelled")
        app.terminate(); XCTAssertTrue(app.wait(for: .notRunning, timeout: 30))
        app.launchArguments = ["-wgLocalLockOn", "NO", "-wgLocalLock", "NO", "-wgQASoftAuthn", "YES"]
        app.launch(); XCTAssertTrue(openAccount(app), "account did not reopen after cancellation")
        XCTAssertEqual(try command(app, "verify")["restored"] as? Bool, true, "the account's BP did not return after cancellation")

        // A verified soft passkey completes the real server deletion, then the
        // shell must forget the host and show the local invite screen. The
        // wipe probe reports the IndexedDB/caches state just before leave().
        _ = try command(app, "wipe")
        let beforeDelete = try QA.receipts(host: host).count
        try openDelete(app)
        XCTAssertTrue(QA.inviteSheetShows(app, timeout: 120), "delete did not leave account")
        let deletes = try QA.receipts(host: host).dropFirst(beforeDelete)
        XCTAssertTrue(deletes.contains { $0["path"] as? String == "/api/account" && $0["method"] as? String == "DELETE" && $0["status"] as? Int == 204 }, "no successful account DELETE")
        XCTAssertNil(QA.appDefaults()?["wgAccountHost"], "account host persisted")
        // Push off on iOS: the server rows go with the DELETE cascade
        // (cloudstore delete_account_test.go); a CI build has no APNs token, so
        // no /api/push/* call may follow the DELETE.
        let afterDelete = deletes.drop { !($0["path"] as? String == "/api/account" && $0["method"] as? String == "DELETE") }
        XCTAssertFalse(afterDelete.contains { ($0["path"] as? String ?? "").hasPrefix("/api/push/") }, "a push call followed the DELETE")
        let wiped = deletes.compactMap { $0["path"] as? String }.filter { $0.hasPrefix("/qa-wipe/") }
        XCTAssertEqual(wiped, ["/qa-wipe/clean"], "local data or caches survived the delete")
        shot("pull-delete", "deleted")

        // The deleted host no longer opens: cmd/cloud answers the marked 404
        // (X-Account-Gone) and the shell lands on "Have an invite?", as
        // FlowQAAccountGoneTests does for a host that never existed.
        app.terminate(); XCTAssertTrue(app.wait(for: .notRunning, timeout: 30))
        let beforeGone = try QA.receipts(host: host).count
        app.launchArguments = ["-wgLocalMode", "NO", "-wgLocalLockOn", "NO", "-wgLocalLock", "NO", "-wgAccountHost", host]
        app.launch()
        XCTAssertTrue(QA.inviteSheetShows(app, timeout: 60), "the deleted host did not land on \"Have an invite?\"")
        let gone = try QA.receipts(host: host).dropFirst(beforeGone)
        XCTAssertTrue(gone.contains { $0["status"] as? Int == 404 }, "the deleted host was not answered 404: \(gone)")
        XCTAssertFalse(gone.contains { ($0["status"] as? Int ?? 0) / 100 == 2 }, "the deleted host still served: \(gone)")
        shot("pull-delete", "deleted-host")
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
        let vault = app.webViews.buttons.matching(NSPredicate(format: "label CONTAINS 'Your vault'")).firstMatch
        if !vault.waitForExistence(timeout: 5) {
            let settings = QA.control(app, "Settings")
            XCTAssertTrue(settings.waitForExistence(timeout: 30)); settings.tap()
        }
        XCTAssertTrue(vault.waitForExistence(timeout: 30)); vault.tap()
        let delete = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Delete account'")).firstMatch
        for _ in 0..<6 where !delete.isHittable { app.swipeUp() }
        XCTAssertTrue(delete.waitForExistence(timeout: 20)); delete.tap()
        let input = app.webViews.textFields.firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 20))
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = "pull-delete-dialog-pretap-hierarchy.txt"; tree.lifetime = .keepAlways; add(tree)
        shot("pull-delete", "dialog-pretap")
        QA.hideKeyboard(app)
        let dialog = app.webViews.otherElements.matching(NSPredicate(format: "label BEGINSWITH 'Delete your account?'")).firstMatch
        XCTAssertTrue(dialog.waitForExistence(timeout: 10), "delete dialog missing; see pull-delete-dialog-pretap")
        var safe = false
        for attempt in 0..<4 {
            let first = input.frame
            Thread.sleep(forTimeInterval: 0.3)
            let second = input.frame
            if first == second && input.isHittable && dialog.frame.contains(second) { safe = true; break }
            guard attempt < 3 else { break }
            let start = dialog.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
            let end = dialog.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
            start.press(forDuration: 0.1, thenDragTo: end)
        }
        guard safe else { XCTFail("delete field not stable and inside dialog; see pull-delete-dialog-pretap"); return }
        let confirm = app.webViews.buttons.matching(identifier: "Delete account").allElementsBoundByIndex.last
        XCTAssertFalse(confirm?.isEnabled ?? true, "delete enabled without phrase")
        input.tap()
        guard input.exists || (confirm?.exists == true && confirm?.isEnabled == false) else {
            XCTFail("field tap cancelled the dialog; see pull-delete-dialog-pretap"); return
        }
        QA.dismissKeyboardTip(app)
        input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 40) + "DELETE")
        QA.dismissKeyboardTip(app)
        let button = try XCTUnwrap(confirm)
        XCTAssertTrue(button.isEnabled, "typed DELETE did not enable confirmation")
        QA.hideKeyboard(app)
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
