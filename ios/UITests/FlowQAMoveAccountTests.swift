import XCTest

/// Native account side of the local-to-cloud move (med-sz4k.6.4.1).
/// The invite is one-shot, so this class has its own QA part.
@MainActor
final class FlowQAMoveAccountTests: XCTestCase {
    nonisolated override func setUp() {
        super.setUp()
        MainActor.assumeIsolated { QA.reset() }
    }

    func testMoveAccount() throws {
        continueAfterFailure = false
        let claim = try XCTUnwrap(ProcessInfo.processInfo.environment["WG_QA_OFFLINE_CLAIM_URL"].flatMap(URL.init(string:)))
        let host = try XCTUnwrap(claim.host)
        let sub = try XCTUnwrap(host.split(separator: ".").first)
        let token = try XCTUnwrap(claim.fragment?.split(separator: "=").last)
        let link = try XCTUnwrap(URL(string: "medtracker://i/\(sub)#\(token)"))
        let app = XCUIApplication()
        launch(app, ["-wgAccountHost", "", "-wgQAScene", "eu-register-pick"])
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 120))
        let eu = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'EU register'")).firstMatch
        let dialog = text(app, "Needs an account. Without one, no name check runs.")
        XCTAssertTrue(eu.waitForExistence(timeout: 10))
        for _ in 0..<3 where dialog.exists {
            eu.tap()
            let end = Date().addingTimeInterval(5)
            while dialog.exists && Date() < end { Thread.sleep(forTimeInterval: 0.5) }
        }
        XCTAssertFalse(dialog.exists, "EU choice did not close")
        // The visual scene opens the picker on each page load. Relaunch
        // without it before the invite reloads the local document.
        app.terminate(); launch(app, ["-wgAccountHost", ""])
        XCTAssertTrue(QA.tabBarShows(app, timeout: 60))
        app.open(link)
        let offer = button(app, "Turn on sync")
        XCTAssertTrue(offer.waitForExistence(timeout: 60)); offer.tap()
        let create = button(app, "Continue with")
        XCTAssertTrue(create.waitForExistence(timeout: 60))
        let stashURL = try XCTUnwrap(QA.appContainer()?.appendingPathComponent("Library/Application Support/move/vault.json"))
        let stash = try Data(contentsOf: stashURL)
        let source = try XCTUnwrap(try JSONSerialization.jsonObject(with: stash) as? [String: Any])
        let sourceData = try XCTUnwrap(source["data"] as? [String: Any])
        XCTAssertEqual((sourceData["settings"] as? [String: Any])?["med_register"] as? String, "eu")
        create.tap()
        XCTAssertTrue(openAccount(app, timeout: 180), "claim did not open the account")
        XCTAssertFalse(text(app, "Records already in your account").exists, "empty account asked for a choice")
        let pickupDeadline = Date().addingTimeInterval(120)
        while FileManager.default.fileExists(atPath: stashURL.path) && Date() < pickupDeadline {
            XCTAssertFalse(text(app, "Records already in your account").exists, "empty account asked for a choice")
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: stashURL.path), "successful pickup retained the stash")
        let first = try command(app, "inspect")
        XCTAssertEqual(first["register"] as? String, "eu")
        let counts = try XCTUnwrap(first["counts"] as? [String: Int])
        for key in ["medications.items", "medications.intakes", "bp.readings", "weight.logs", "food.logs", "diary.notes", "trackers.items", "trackers.logs", "workouts.sessions", "vitals.heart"] {
            let parts = key.split(separator: ".").map(String.init)
            let section = sourceData[parts[0]] as? [String: Any]
            XCTAssertGreaterThanOrEqual(counts[key] ?? 0, (section?[parts[1]] as? [Any])?.count ?? 0, "missing moved \(key)")
        }
        app.terminate(); launch(app, [])
        XCTAssertTrue(openAccount(app, timeout: 120))
        let second = try command(app, "inspect")
        let reopened = try XCTUnwrap(second["counts"] as? [String: Int])
        // Today can lazily materialize a planned workout session on reopen.
        for key in ["medications.items", "medications.intakes", "bp.readings", "weight.logs", "food.logs", "diary.notes", "trackers.items", "trackers.logs", "vitals.heart"] {
            XCTAssertEqual(reopened[key], counts[key], "relaunch duplicated \(key)")
        }
        let settings = app.webViews.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10)); settings.tap()
        let features = button(app, "Features")
        XCTAssertTrue(features.waitForExistence(timeout: 10)); features.tap()
        XCTAssertTrue(text(app, "EU register").waitForExistence(timeout: 10), "account Settings lost the EU choice")
        let before = try QA.receipts().count
        let saved = try command(app, "save")
        XCTAssertEqual(saved["nameEgress"] as? Int, 0)
        XCTAssertEqual(saved["rxnav"] as? Int, 0)
        XCTAssertEqual(saved["uninspected"] as? Int, 0)
        let receipts = try QA.receipts()
        XCTAssertFalse(receipts.dropFirst(before).contains { $0["nameEgress"] as? Bool == true || ($0["path"] as? String ?? "").contains("rxnav") })

        // Re-present the exact stash to the populated account, as the shell
        // would after moving the unchanged local vault again.
        app.terminate()
        try FileManager.default.createDirectory(at: stashURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try stash.write(to: stashURL)
        launch(app, [])
        // The pickup question is modal: it hides the tab bar from XCUITest.
        let question = text(app, "Records already in your account")
        XCTAssertTrue(openAccount(app, timeout: 180, until: question), "populated account asked no Merge/Replace")
        XCTAssertTrue(choice(app, "Merge").exists, "the populated account offers no Merge")
        let replace = choice(app, "Replace")
        XCTAssertTrue(replace.waitForExistence(timeout: 10)); replace.tap()
        let next = button(app, "Continue")
        XCTAssertTrue(next.waitForExistence(timeout: 10)); next.tap()
        XCTAssertTrue(text(app, "Replace the records in your account?").waitForExistence(timeout: 10))
        let field = app.webViews.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        let confirm = button(app, "Replace")
        XCTAssertFalse(confirm.isEnabled)
        field.tap(); field.typeText("REPLAC")
        XCTAssertFalse(confirm.isEnabled)
        field.typeText("E")
        XCTAssertTrue(confirm.isEnabled)
        app.webViews.buttons["Cancel"].tap()
        XCTAssertEqual(try Data(contentsOf: stashURL), stash)

        app.terminate()

        // Settings' Switch account returns to the unchanged local origin.
        launch(app, ["-wgForgetAccount", "YES"])
        XCTAssertTrue(QA.inviteSheetShows(app, timeout: 60))
        let notNow = app.webViews.buttons["Not now"]
        XCTAssertTrue(notNow.waitForExistence(timeout: 10)); notNow.tap()
        XCTAssertTrue(QA.tabBarShows(app, timeout: 60))
        let meds = button(app, "Meds")
        XCTAssertTrue(meds.waitForExistence(timeout: 20)); meds.tap()
        XCTAssertTrue(text(app, "Lisinopril").waitForExistence(timeout: 20), "local records disappeared")
    }

    func testMoveFailure() throws {
        continueAfterFailure = false
        let claim = try XCTUnwrap(ProcessInfo.processInfo.environment["WG_QA_MOVE_FAIL_CLAIM_URL"].flatMap(URL.init(string:)))
        let host = try XCTUnwrap(claim.host)
        let sub = try XCTUnwrap(host.split(separator: ".").first)
        let token = try XCTUnwrap(claim.fragment?.split(separator: "=").last)
        let link = try XCTUnwrap(URL(string: "medtracker://i/\(sub)#\(token)"))
        let app = XCUIApplication()
        launch(app, ["-wgAccountHost", "", "-wgQAScene", "today"])
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 120))
        app.open(link)
        let offer = button(app, "Turn on sync")
        XCTAssertTrue(offer.waitForExistence(timeout: 60)); offer.tap()
        let create = button(app, "Continue with")
        XCTAssertTrue(create.waitForExistence(timeout: 60))
        let stashURL = try XCTUnwrap(QA.appContainer()?.appendingPathComponent("Library/Application Support/move/vault.json"))
        let stash = try Data(contentsOf: stashURL)
        // Arm before claiming so the new account cannot acquire a cursor.
        _ = try fault("/arm", ["host": host])
        defer { _ = try? fault("/release", [:]) }
        create.tap()
        let error = text(app, "Records not moved yet")
        let choiceDialog = text(app, "Records already in your account")
        let deadline = Date().addingTimeInterval(180)
        while Date() < deadline && !error.exists && !choiceDialog.exists {
            for label in ["Continue in browser anyway", "Skip all", "Unlock with passkey"] {
                let b = app.webViews.buttons[label]; if b.exists { b.tap() }
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        if choiceDialog.exists {
            let merge = choice(app, "Merge")
            XCTAssertTrue(merge.waitForExistence(timeout: 10)); merge.tap()
            button(app, "Continue").tap()
        }
        XCTAssertTrue(error.waitForExistence(timeout: 120), "failed import did not show an error")
        let status = try fault("/status")
        XCTAssertEqual(status["armed"] as? Bool, true)
        XCTAssertGreaterThan(status["hits"] as? Int ?? 0, 0)
        XCTAssertEqual(try Data(contentsOf: stashURL), stash, "failed import changed the local copy")
        _ = try fault("/release", [:])
        app.terminate()
        launch(app, ["-wgForgetAccount", "YES"])
        XCTAssertTrue(QA.inviteSheetShows(app, timeout: 60))
        app.webViews.buttons["Not now"].tap()
        XCTAssertTrue(QA.tabBarShows(app, timeout: 60))
        let meds = button(app, "Meds")
        XCTAssertTrue(meds.waitForExistence(timeout: 20)); meds.tap()
        XCTAssertTrue(text(app, "Lisinopril").waitForExistence(timeout: 20), "failed import lost local records")
    }

    private func launch(_ app: XCUIApplication, _ extra: [String]) {
        if app.state != .notRunning { app.terminate() }
        app.launchArguments = ["-wgLocalLockOn", "NO", "-wgLocalLock", "NO", "-wgQASoftAuthn", "YES"] + extra
        app.launch()
    }

    /// Passes the unlock steps until the tab bar shows, or `until` when given.
    private func openAccount(_ app: XCUIApplication, timeout: TimeInterval, until target: XCUIElement? = nil) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if let target { if target.waitForExistence(timeout: 2) { return true } }
            else if QA.tabBarShows(app, timeout: 2) { return true }
            for label in ["Continue in browser anyway", "Skip all", "Unlock with passkey"] {
                let b = app.webViews.buttons[label]; if b.exists { b.tap() }
            }
        }
        return false
    }

    private func button(_ app: XCUIApplication, _ prefix: String) -> XCUIElement {
        app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    private func text(_ app: XCUIApplication, _ value: String) -> XCUIElement {
        app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", value)).firstMatch
    }

    private func choice(_ app: XCUIApplication, _ value: String) -> XCUIElement {
        app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", value)).firstMatch
    }

    private func command(_ app: XCUIApplication, _ name: String) throws -> [String: Any] {
        let b = app.webViews.buttons["QA Move " + name]
        XCTAssertTrue(b.waitForExistence(timeout: 30)); b.tap()
        let node = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'QA Move {'")).firstMatch
        let end = Date().addingTimeInterval(120)
        repeat {
            if node.exists, let data = String(node.label.dropFirst("QA Move ".count)).data(using: .utf8),
               let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let phase = state["phase"] as? String, phase == name + "-done" || phase == name + "-error" {
                XCTAssertEqual(phase, name + "-done", "move probe: \(QA.json(state))")
                return state
            }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < end
        XCTFail("move probe \(name) timed out: \(node.label)")
        return [:]
    }

    private func fault(_ path: String, _ body: [String: String]? = nil) throws -> [String: Any] {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:8767\(path)")!, timeoutInterval: 15)
        if let body {
            req.httpMethod = "POST"
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let done = DispatchSemaphore(value: 0)
        var result: Result<Data, Error> = .failure(URLError(.timedOut))
        URLSession.shared.dataTask(with: req) { data, response, error in
            if let error { result = .failure(error) }
            else if (response as? HTTPURLResponse)?.statusCode != 200 { result = .failure(URLError(.badServerResponse)) }
            else { result = .success(data ?? Data()) }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 20)
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: result.get()) as? [String: Any])
    }
}
