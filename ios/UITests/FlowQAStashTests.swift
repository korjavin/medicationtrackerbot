import XCTest

/// Flow QA, the shell's two vault stashes from the local side (bd
/// med-w6gx.23.3; twin of the passkey-free half of android/qa move-ops.mjs and
/// local-to-cloud-seamless.mjs). Files, as Shell.swift keeps them in the app's
/// Application Support: move/vault.json (local → cloud, Move.appDir) and
/// leave/vault.json (account → local). Read and written straight in the
/// app's container (QA.appContainer).
@MainActor
final class FlowQAStashTests: XCTestCase {
    private let hint = "Your records are ready to move: paste or scan your invite."

    /// Settings → Move to a cloud account → stash + first run with the hint →
    /// Only on this device → Back keeps it → Start abandons it (file gone) →
    /// Backup & import → I have an invite: first run without the hint →
    /// relaunch is first run, and the records are still there.
    func testMoveLocalSide() throws {
        continueAfterFailure = false
        // A failed step must not leave a stash for the next flow's boot to pick up.
        addTeardownBlock { @MainActor in Self.clearStashes() }
        let flow = "move-local"
        let fixture = try Self.fixture()
        let app = XCUIApplication()
        // Into local mode through the first run, not -wgLocalMode YES: the
        // argument domain would win over local.leave's persisted false on the
        // next applySettings and clear the stash (Shell.swift local.didSet).
        app.launchArguments = ["-wgLocalMode", "NO", "-wgAccountHost", "", "-wgLocalLockOn", "NO", "-wgQAScene", "settings-home"]
        app.launch()
        startLocal(app)
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 90), "the settings-home scene never published #wg-qa-ready")

        let moveRow = webButton(app, prefix: "Move to a cloud account")
        let shown = moveRow.waitForExistence(timeout: 15)
        shot(flow, "settings-move-row")
        XCTAssertTrue(shown, "Settings shows no Move to a cloud account row (shell.ops lacks move.stash?)")
        moveRow.tap()
        XCTAssertTrue(webText(app, "Move to a cloud account?").waitForExistence(timeout: 10), "no move confirm")
        shot(flow, "move-confirm")
        app.webViews.buttons["Move"].tap()

        XCTAssertTrue(app.staticTexts[hint].waitForExistence(timeout: 60), "the first run shows no move hint")
        XCTAssertFalse(app.buttons["Continue on this iPhone"].exists, "the first run offers Continue on this iPhone during a move")
        shot(flow, "first-run-hint")
        let stash = try XCTUnwrap(Self.stashData("move"), "no move/vault.json after move.stash")
        let vault = try XCTUnwrap(JSONSerialization.jsonObject(with: stash) as? [String: Any], "the move stash is not a JSON object")
        XCTAssertEqual(vault["format"] as? String, fixture["format"] as? String)
        XCTAssertEqual(vault["version"] as? Int, fixture["version"] as? Int)
        let got = vault["data"] as? [String: Any] ?? [:], want = fixture["data"] as? [String: Any] ?? [:]
        XCTAssertEqual(Set(want.keys).subtracting(got.keys), [], "the stash lacks fixture sections")
        // The driver shifts dates, not counts; intakes are left out (the app may materialize slots).
        for (section, list) in [("medications", "items"), ("bp", "readings"), ("weight", "logs")] {
            XCTAssertEqual(Self.count(got, section, list), Self.count(want, section, list), "\(section).\(list) count")
        }

        app.buttons["Only on this device"].tap()
        let start = app.buttons["Start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10), "no local intro")
        // ponytail: the bead's "Start cancels the move" note is Android-only (App.swift has none); shot, not asserted.
        shot(flow, "intro")
        app.buttons["Back"].tap()
        XCTAssertTrue(app.staticTexts[hint].waitForExistence(timeout: 10), "Back lost the move hint")
        XCTAssertNotNil(Self.stashData("move"), "Back deleted the move stash")

        startLocal(app)
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 90), "local mode never came back after Start")
        XCTAssertNil(Self.stashData("move"), "Start kept the abandoned move stash")

        // Backup & import's card leaves without a stash: no stale hint.
        let backup = webButton(app, prefix: "Backup & import")
        XCTAssertTrue(backup.waitForExistence(timeout: 15), "Settings shows no Backup & import")
        backup.tap()
        let invite = app.webViews.buttons["I have an invite"]
        XCTAssertTrue(invite.waitForExistence(timeout: 15), "Backup & import shows no I have an invite")
        invite.tap()
        XCTAssertTrue(webText(app, "Open an invite?").waitForExistence(timeout: 10), "no open-invite confirm")
        app.webViews.buttons["Continue"].tap()
        XCTAssertTrue(app.buttons["Only on this device"].waitForExistence(timeout: 30), "local.leave did not reach the first run")
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertFalse(app.staticTexts[hint].exists, "the hint outlived the stash")
        XCTAssertNil(Self.stashData("move"), "the invite card wrote a move stash")
        shot(flow, "first-run-no-hint")

        // No mode argument: local mode was left, and nothing was erased.
        app.terminate()
        app.launchArguments = ["-wgAccountHost", "", "-wgLocalLockOn", "NO"]
        app.launch()
        startLocal(app)
        XCTAssertTrue(QA.tabBarShows(app, timeout: 60), "local mode shows no tab bar after the relaunch")
        webButton(app, prefix: "Meds").tap() // "Meds 1" with a dose due
        XCTAssertTrue(webText(app, contains: Self.firstMed(fixture)).waitForExistence(timeout: 20), "the records are gone after the move round-trip")
        shot(flow, "records-kept")
        app.terminate()
    }

    /// The local boot's leave pickup: on an empty store it imports without a
    /// question, toasts and clears the file; over records it asks Merge /
    /// Replace, and Cancel shows nothing more, keeps the records and clears it too.
    func testLeaveStashPickup() throws {
        continueAfterFailure = false
        // A failed step must not leave a stash for the next flow's boot to pick up.
        addTeardownBlock { @MainActor in Self.clearStashes() }
        let flow = "leave-pickup"
        var fixture = try Self.fixture()
        // As tests/visual/driver.js seed(): the fixture's Berlin zone would raise the timezone confirm.
        if var data = fixture["data"] as? [String: Any], var settings = data["settings"] as? [String: Any] {
            // ponytail: Foundation names the CI runner's zone GMT where WebKit's Intl says UTC; map just that.
            let tz = TimeZone.current.identifier
            settings["timezone"] = tz == "GMT" ? "UTC" : tz
            data["settings"] = settings
            fixture["data"] = data
        }
        let seed = try JSONSerialization.data(withJSONObject: fixture)
        let app = XCUIApplication()
        app.launchArguments = ["-wgLocalMode", "YES", "-wgAccountHost", "", "-wgLocalLockOn", "NO"]
        app.launch() // the container exists from here on
        app.terminate()
        let container = try XCTUnwrap(QA.appContainer(), "the app's data container is not visible to the test runner")
        // An empty store: earlier flows seeded the local origin's IndexedDB (Library/WebKit).
        try? FileManager.default.removeItem(at: container.appendingPathComponent("Library/WebKit"))
        try Self.writeStash("leave", seed)

        app.launch()
        let toast = webText(app, contains: "Your records from your account are on this")
        // ponytail: the toast lives 3 s and app.launch() waits out the boot's
        // import + reload, so it is often gone before the first query (CI run
        // 39423812401): noted, not gated; the outcome below is the contract.
        let toasted = toast.waitForExistence(timeout: 20)
        shot(flow, "toast")
        if !toasted { XCTContext.runActivity(named: "pickup toast not caught (3 s toast)") { _ in } }
        // The web first-run overlay is not vault-managed: the wiped store shows it.
        let skip = app.webViews.buttons["Skip all"]
        if skip.waitForExistence(timeout: 10) { skip.tap() }
        XCTAssertTrue(QA.tabBarShows(app, timeout: 30), "no tab bar after the pickup")
        webButton(app, prefix: "Meds").tap() // "Meds 1" with a dose due
        XCTAssertTrue(webText(app, contains: Self.firstMed(fixture)).waitForExistence(timeout: 20), "Meds lists no fixture medication after the pickup")
        shot(flow, "meds")
        XCTAssertNil(Self.stashData("leave"), "the pickup kept leave/vault.json")

        // Over records now: the Merge / Replace choice, cancelled.
        app.terminate()
        try Self.writeStash("leave", seed)
        app.launch()
        XCTAssertTrue(webText(app, contains: "Records already on this").waitForExistence(timeout: 60), "no Merge / Replace choice over existing records")
        // aria-pressed choices reach XCUITest as toggles, not buttons.
        let replace = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label == 'Replace'")).firstMatch
        XCTAssertTrue(replace.waitForExistence(timeout: 5), "the choice offers no Replace")
        shot(flow, "replace-dialog")
        app.webViews.buttons["Cancel"].tap()
        // bd med-o7zq.42: Cancel = nothing happened. No dialog after it; with
        // no account remembered here, leave.clear {back: true} stays local.
        XCTAssertTrue(QA.tabBarShows(app, timeout: 20), "no tab bar after the cancelled pickup")
        shot(flow, "cancelled")
        XCTAssertFalse(webText(app, "Records not copied").exists, "a dialog followed Cancel")
        XCTAssertNil(Self.stashData("leave"), "Cancel kept leave/vault.json")
        webButton(app, prefix: "Meds").tap() // "Meds 1" with a dose due
        XCTAssertTrue(webText(app, contains: Self.firstMed(fixture)).waitForExistence(timeout: 20), "the records are gone after the cancelled pickup")
        app.terminate()
    }

    // MARK: helpers

    /// First run → Only on this device → Start (lock off by argument).
    private func startLocal(_ app: XCUIApplication) {
        let onlyHere = app.buttons["Only on this device"]
        XCTAssertTrue(onlyHere.waitForExistence(timeout: 30), "first run never showed \"Only on this device\"")
        onlyHere.tap()
        let start = app.buttons["Start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10), "the local intro never showed \"Start\"")
        start.tap()
    }

    private func webButton(_ app: XCUIApplication, prefix: String) -> XCUIElement {
        app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    private func webText(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.webViews.staticTexts.matching(NSPredicate(format: "label == %@", text)).firstMatch
    }

    private func webText(_ app: XCUIApplication, contains text: String) -> XCUIElement {
        // Any element: a role="status" toast may reach XCUITest as a group, not a static text.
        app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    /// tests/fixtures/vault-v1.json, read from the source tree: the Simulator's
    /// runner sees the host's files, so no bundle copy (project.yml) is needed.
    private static func fixture() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../tests/fixtures/vault-v1.json").standardized
        let data = try XCTUnwrap(try? Data(contentsOf: url), "cannot read \(url.path)")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any], "the fixture is not a JSON object")
    }

    private static func firstMed(_ vault: [String: Any]) -> String {
        let meds = (vault["data"] as? [String: Any])?["medications"] as? [String: Any]
        return ((meds?["items"] as? [[String: Any]])?.first?["name"] as? String) ?? "?"
    }

    private static func count(_ data: [String: Any], _ section: String, _ list: String) -> Int? {
        ((data[section] as? [String: Any])?[list] as? [Any])?.count
    }

    private static func stashURL(_ dir: String) -> URL? {
        QA.appContainer()?.appendingPathComponent("Library/Application Support/\(dir)/vault.json")
    }

    private static func clearStashes() {
        for dir in ["move", "leave"] {
            if let url = stashURL(dir) { try? FileManager.default.removeItem(at: url) }
        }
    }

    private static func stashData(_ dir: String) -> Data? {
        stashURL(dir).flatMap { try? Data(contentsOf: $0) }
    }

    private static func writeStash(_ dir: String, _ data: Data) throws {
        let url = try XCTUnwrap(stashURL(dir), "the app's data container is not visible to the test runner")
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url)
    }

    private func shot(_ flow: String, _ step: String) {
        let attachment = XCTAttachment(screenshot: QA.stableScreenshot().0)
        attachment.name = "\(flow)-\(step).png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
