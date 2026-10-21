import XCTest

/// Flow QA, the shell's two vault stashes from the local side (bd
/// med-w6gx.23.3; twin of the passkey-free half of android/qa move-ops.mjs and
/// local-to-cloud-seamless.mjs). Files, as Shell.swift keeps them in the app's
/// Application Support: move/vault.json (local → cloud, Move.appDir) and
/// leave/vault.json (account → local). Read and written straight in the
/// app's container (QA.appContainer).
@MainActor
final class FlowQAStashTests: XCTestCase {
    // The move's local side (Settings Move row → stash → first-run hint) is
    // gone with the row (bd med-ta2n.5): the move now starts from the web P3
    // sheet over an invite, local.leave {url} straight to the claim page.

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
        let skip = app.webViews.buttons.matching(NSPredicate(format: "label IN {'Skip', 'Skip all'}")).firstMatch // W1 picker "Skip" (med-ta2n.1)
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
        let replace = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Replace'")).firstMatch
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
