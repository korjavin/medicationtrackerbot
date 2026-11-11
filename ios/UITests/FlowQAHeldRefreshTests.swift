import XCTest

/// Account-mode refresh while a real workout session is under the user's hand.
/// The simulator cannot toggle airplane mode; tlsfront's listener is stopped
/// and started instead. The peer record is encrypted through the real protocol.
@MainActor
final class FlowQAHeldRefreshTests: XCTestCase {
    nonisolated override func setUp() { super.setUp(); MainActor.assumeIsolated { QA.reset() } }
    nonisolated override func tearDown() { _ = MainActor.assumeIsolated { try? QA.fakeServer("POST", "/start") }; super.tearDown() }

    func testOpenSessionHoldsRefresh() throws {
        continueAfterFailure = false
        // Seed real HealthKit records before the app's import is enabled.
        let seed = try HealthDiagnosticTests.run("-wgQAHealthSeed", in: self, retryCode100: true)
        XCTAssertGreaterThan(seed["sampleCount"] as? Int ?? 0, 0, "Health seed has no steps")
        let claim = try XCTUnwrap(ProcessInfo.processInfo.environment["WG_QA_OFFLINE_CLAIM_URL"].flatMap(URL.init(string:)))
        let sub = try XCTUnwrap(claim.host?.split(separator: ".").first)
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
        XCTAssertTrue(openAccount(app, timeout: 120), "account did not open")
        // Claim can navigate again after the tab bar first appears. Begin in
        // a cold account document so a late claim navigation cannot discard
        // the Health switch or our observation state.
        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 30))
        app.launchArguments = ["-wgLocalLockOn", "NO", "-wgLocalLock", "NO", "-wgQASoftAuthn", "YES"]
        app.launch()
        XCTAssertTrue(openAccount(app, timeout: 120), "account cold open failed")
        let setup = app.webViews.buttons["QA held setup"]
        XCTAssertTrue(setup.waitForExistence(timeout: 60)); setup.tap()
        // Every read kind was determined in the seed's one sheet. A second
        // sheet signals drift from HEALTH_KINDS; never accept it as coverage.
        let end = Date().addingTimeInterval(120)
        while Date() < end && !(state(app)?["phase"] as? String ?? "").hasSuffix("-done") && !(state(app)?["phase"] as? String ?? "").hasSuffix("-error") {
            let secondSheet = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'UIA.Health.'")).firstMatch
            XCTAssertFalse(secondSheet.exists, "second Health sheet: seed read set drifted from HEALTH_KINDS")
            Thread.sleep(forTimeInterval: 1)
        }
        XCTAssertEqual(state(app)?["phase"] as? String, "setup-done", QA.json(state(app)))
        let beforeDocument = try XCTUnwrap(state(app)?["document"] as? String)
        let note = app.webViews.textFields.matching(NSPredicate(format: "placeholderValue CONTAINS[c] 'note' OR label CONTAINS[c] 'note'")).firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 15), "session Notes field missing")
        note.tap(); QA.dismissKeyboardTip(app); note.typeText("Before Home")
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 3)
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
        XCTAssertTrue(wait(app, timeout: 60) { ($0["events"] as? [String] ?? []).contains("hidden:true") && ($0["events"] as? [String] ?? []).contains("visible:true") && ($0["returnQueries"] as? Int ?? 0) > 0 }, "native return did not run Health: \(QA.json(state(app)))")
        XCTAssertEqual(state(app)?["document"] as? String, beforeDocument, "return replaced the open document")
        let stopped = try QA.fakeServer("POST", "/stop")
        XCTAssertEqual(stopped["listening"] as? Bool, false)
        XCTAssertEqual(try QA.fakeServer("POST", "/start")["listening"] as? Bool, true)
        try action(app, "peer")
        note.tap(); QA.dismissKeyboardTip(app); note.typeText(" typing stays here")
        try action(app, "inspect")
        let held = try XCTUnwrap(state(app)?["held"] as? [String: Any])
        XCTAssertEqual(held["sameInput"] as? Bool, true); XCTAssertEqual(held["sameExercise"] as? Bool, true)
        XCTAssertEqual(held["connected"] as? Bool, true); XCTAssertEqual(held["open"] as? Bool, true)
        XCTAssertEqual(held["sameList"] as? Bool, true); XCTAssertEqual(held["removed"] as? Int, 0)
        XCTAssertEqual(held["value"] as? String, "Before Home typing stays here")
        XCTAssertEqual((held["notices"] as? [String])?.count, 0, QA.json(held))
        shot("held-refresh-open")
        let close = app.webViews.buttons["Minimise"]
        XCTAssertTrue(close.waitForExistence(timeout: 10)); close.tap()
        try action(app, "after")
        XCTAssertEqual(state(app)?["healthVisible"] as? Bool, true)
        shot("held-refresh-closed")
    }

    private func state(_ app: XCUIApplication) -> [String: Any]? {
        let node = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'QA held {'")).firstMatch
        guard node.exists else { return nil }
        let label = node.label
        guard label.hasPrefix("QA held "), let data = String(label.dropFirst(8)).data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
    private func wait(_ app: XCUIApplication, timeout: TimeInterval, _ predicate: ([String: Any]) -> Bool) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        repeat { if let s = state(app), predicate(s) { return true }; Thread.sleep(forTimeInterval: 0.5) } while Date() < end
        return false
    }
    private func action(_ app: XCUIApplication, _ name: String) throws {
        let button = app.webViews.buttons["QA held " + name]
        XCTAssertTrue(button.waitForExistence(timeout: 15)); button.tap()
        XCTAssertTrue(wait(app, timeout: 90) { ($0["phase"] as? String) == name + "-done" || ($0["phase"] as? String) == name + "-error" }, "\(name) timed out: \(QA.json(state(app)))")
        XCTAssertEqual(state(app)?["phase"] as? String, name + "-done", QA.json(state(app)))
    }
    private func openAccount(_ app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if QA.tabBarShows(app, timeout: 2) { return true }
            for label in ["Continue in browser anyway", "Skip all", "Unlock with passkey"] { let b = app.webViews.buttons[label]; if b.exists { b.tap() } }
        }
        return false
    }
    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: QA.stableScreenshot().0); a.name = name + ".png"; a.lifetime = .keepAlways; add(a)
    }
}
