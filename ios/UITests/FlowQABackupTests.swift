import XCTest

/// Flow QA: local mode's data lifecycle (bd med-w6gx.23.4, docs/ios.md "Flow
/// QA (Simulator)") — backup export to the share sheet, restore from a file,
/// erase. Twin of android/qa smoke.mjs exportBackup / local-smoke / erase.
/// Same contract as FlowQATests: first failed step ends the flow, shots are
/// `<flow>-<step>.png`, assertions are UI or files the app already writes.
@MainActor
final class FlowQABackupTests: XCTestCase {
    /// Local mode, lock off; `scene` makes the QA driver seed the golden vault
    /// into an empty store (through Settings → Backup & import) and open it.
    private func launch(_ app: XCUIApplication, scene: String? = nil) {
        app.launchArguments = ["-wgLocalMode", "1", "-wgLocalLockOn", "0"] + (scene.map { ["-wgQAScene", $0] } ?? [])
        app.launch()
    }

    /// Settings → Backup & import → Export backup → passphrase sheet → Backup
    /// ready → Save to device, plain then encrypted: each lands in the shell's
    /// Downloads temp dir, is offered through the share sheet, and is deleted
    /// once the sheet closes (kit S7, bd med-ckm5.7).
    func testBackupExport() throws {
        continueAfterFailure = false
        let flow = "backup-export"
        let app = XCUIApplication()
        launch(app, scene: "settings-backup")
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 90), "Backup & import never published #wg-qa-ready")
        let downloads = try XCTUnwrap(QA.appContainer(), "no app container").appendingPathComponent("tmp/wg-downloads")
        let exportBtn = app.webViews.buttons["Export backup"]
        let save = app.webViews.buttons["Save to device"]

        // Plain: no passphrase → the page asks before writing API keys in clear.
        XCTAssertTrue(exportBtn.waitForExistence(timeout: 10), "no Export backup button")
        exportBtn.tap()
        let plain = app.webViews.buttons["Export without encryption"]
        XCTAssertTrue(plain.waitForExistence(timeout: 10), "the passphrase sheet never showed")
        plain.tap()
        let confirm = app.webViews.buttons["Confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 10), "the plain-export confirm never showed")
        confirm.tap()
        XCTAssertTrue(save.waitForExistence(timeout: 60), "Backup ready never showed")
        shot(flow, "plain-ready")
        save.tap()
        shareSheetRoundTrip(app, flow: flow, step: "plain", downloads: downloads, suffix: ".json.gz")
        XCTAssertTrue(webText(app, containing: ".json.gz.").waitForExistence(timeout: 10), "the export status never said \"Backup exported\"")

        // Encrypted: the passphrase makes it .age (proof the typing landed).
        exportBtn.tap()
        let pass = QA.webElement(app, id: "importexport-export-passphrase", placeholder: "Encrypt the backup")
        XCTAssertTrue(pass.waitForExistence(timeout: 10), "no passphrase field")
        pass.tap()
        QA.dismissKeyboardTip(app)
        pass.typeText("qa-flow-passphrase")
        QA.dismissKeyboardTip(app)
        shot(flow, "passphrase")
        hideKeyboard(app)
        app.webViews.buttons["Encrypt and export"].tap()
        XCTAssertTrue(save.waitForExistence(timeout: 120), "encrypted Backup ready never showed")
        shot(flow, "encrypted-ready")
        save.tap()
        shareSheetRoundTrip(app, flow: flow, step: "encrypted", downloads: downloads, suffix: ".json.gz.age", timeout: 60)
        XCTAssertTrue(webText(app, containing: ".json.gz.age").waitForExistence(timeout: 10), "the encrypted export status never said \"Backup exported\"")
        shot(flow, "after-dismiss")
        XCTAssertFalse(webText(app, containing: "Preparing").exists || webText(app, containing: "Encrypting").exists, "the export status still says it is running")
        app.terminate()
    }

    /// Restore via the Settings import input (driver seed): erase to an empty
    /// store, then the QA driver imports tests/fixtures/vault-v1.json through
    /// #importexport-import-file → SettingsImportExport.import() and the page
    /// reloads. The records survive a relaunch.
    func testRestoreFromFile() {
        continueAfterFailure = false
        let flow = "restore"
        let app = XCUIApplication()
        launch(app, scene: "settings-erase-confirm")
        erase(app, flow: flow)
        app.terminate()

        launch(app, scene: "meds-schedule")
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 90), "Meds → Schedule never published #wg-qa-ready")
        // loads ≥ 2: this launch's page imported the file and reloaded.
        let report = QA.readyNode(app).label
        XCTAssertTrue(report.range(of: #""loads":([2-9]|\d\d)"#, options: .regularExpression) != nil,
                      "the driver did not restore into the empty store (report \(report))")
        XCTAssertTrue(webText(app, containing: "Lisinopril").waitForExistence(timeout: 10), "the restored medication is not listed")
        shot(flow, "restored-meds")
        app.terminate()

        launch(app)
        openMedsSchedule(app, flow: flow)
        XCTAssertTrue(webText(app, containing: "Lisinopril").waitForExistence(timeout: 20), "after relaunch the restored medication is gone")
        shot(flow, "relaunch-meds")
        app.terminate()
    }

    /// Settings → Backup → Erase data on this device → type "erase" → Erase:
    /// the page wipes its storage, the shell clears both stashes, and the app
    /// relaunches empty, still in local mode.
    func testErase() throws {
        continueAfterFailure = false
        let flow = "erase"
        let app = XCUIApplication()
        // Choose local mode on first run, so it is persisted (not only the
        // launch argument) and the relaunch below can run with no arguments.
        app.launchArguments = ["-wgLocalMode", "NO", "-wgAccountHost", "", "-wgQAScene", "settings-erase-confirm"]
        app.launch()
        let onlyHere = app.buttons["Only on this device"]
        XCTAssertTrue(onlyHere.waitForExistence(timeout: 30), "first run never showed \"Only on this device\"")
        onlyHere.tap()
        let start = app.buttons["Start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10), "the local intro never showed \"Start\"")
        start.tap()
        erase(app, flow: flow)
        XCTAssertEqual(QA.appDefaults()?["wgLocalMode"] as? Bool, true, "wgLocalMode is not persisted before the relaunch")
        app.terminate()

        app.launchArguments = [] // the persisted choice only; a scene would re-seed the empty store
        app.launch()
        openMedsSchedule(app, flow: flow)
        XCTAssertTrue(webText(app, containing: "No medications yet").waitForExistence(timeout: 20), "Meds → Schedule is not empty after erase")
        XCTAssertFalse(webText(app, containing: "Lisinopril").exists, "an erased medication is still listed")
        shot(flow, "empty")
        XCTAssertFalse(app.buttons["Only on this device"].exists, "erase dropped local mode (first run showed)")
        XCTAssertEqual(QA.appDefaults()?["wgLocalMode"] as? Bool, true, "erase dropped the persisted local-mode flag")
        app.terminate()
    }

    /// From the settings-erase-confirm scene (the typed-confirm dialog open):
    /// seeds both shell stashes, types the phrase, erases, and asserts the
    /// stash dirs are gone. The phrase is settings.js bindLocalErase's typedConfirm.
    private func erase(_ app: XCUIApplication, flow: String) {
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 90), "the erase dialog never published #wg-qa-ready")
        guard let container = QA.appContainer() else { return XCTFail("no app container") }
        // Dummy stashes after boot (the local page reads leave/ only at start),
        // so the "cleared" assertion below is not vacuous.
        let support = container.appendingPathComponent("Library/Application Support")
        let stashes = ["move", "leave"].map { support.appendingPathComponent($0) }
        for dir in stashes {
            XCTAssertNoThrow(try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true))
            XCTAssertNoThrow(try Data("{}".utf8).write(to: dir.appendingPathComponent("vault.json")))
        }
        let field = app.webViews.textFields.matching(NSPredicate(format: "label CONTAINS 'to confirm'")).firstMatch
        let input = field.waitForExistence(timeout: 10) ? field : app.webViews.textFields.firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 5), "no typed-confirm input in the erase dialog")
        input.tap()
        QA.dismissKeyboardTip(app)
        input.typeText("erase")
        QA.dismissKeyboardTip(app)
        shot(flow, "dialog-typed")
        let eraseBtn = app.webViews.buttons["Erase"]
        XCTAssertTrue(eraseBtn.waitForExistence(timeout: 5), "no Erase button in the dialog")
        hideKeyboard(app)
        eraseBtn.tap()
        // eraseDevice → local.reset → location.replace('/'): the scene's ready node goes.
        XCTAssertTrue(waitUntil(30) { !QA.readyNode(app).exists }, "the page never reloaded after Erase")
        XCTAssertTrue(waitUntil(15) { stashes.allSatisfy { !FileManager.default.fileExists(atPath: $0.path) } },
                      "local.reset left a stash dir behind")
        shot(flow, "after-erase")
    }

    /// Waits for the share sheet, checks the file sits in the Downloads dir
    /// while it shows, dismisses it, and checks the dir is empty after.
    private func shareSheetRoundTrip(_ app: XCUIApplication, flow: String, step: String, downloads: URL,
                                     suffix: String, timeout: TimeInterval = 60) {
        let sheetUI = XCUIApplication(bundleIdentifier: "com.apple.ShareSheetUI")
        let marks = NSPredicate(format: "identifier IN {'ActivityListView', 'UIActivityContentView'} OR label IN {'Save to Files', 'Copy', 'Close'}")
        let inApp = app.descendants(matching: .any).matching(marks).firstMatch
        let remote = sheetUI.descendants(matching: .any).matching(marks).firstMatch
        XCTAssertTrue(waitUntil(timeout) { inApp.exists || remote.exists }, "\(step): the share sheet never showed")
        shot(flow, "\(step)-share-sheet")
        let files = filesIn(downloads)
        XCTAssertTrue(files.count == 1 && files[0].hasSuffix(suffix), "\(step): Downloads holds \(files), want one *\(suffix)")

        let close = [app.buttons["Close"], sheetUI.buttons["Close"]].first { $0.exists }
        if let close { close.tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap() }
        XCTAssertTrue(waitUntil(15) { !inApp.exists && !remote.exists }, "\(step): the share sheet did not close")
        XCTAssertTrue(waitUntil(10) { filesIn(downloads).isEmpty }, "\(step): the export file outlived the sheet: \(filesIn(downloads))")
    }

    /// Bottom tab bar → Meds → Schedule (the tab restores its last sub-tab).
    private func openMedsSchedule(_ app: XCUIApplication, flow: String) {
        // An empty store reopens the web onboarding (its record went with the erase).
        let skip = app.webViews.buttons.matching(NSPredicate(format: "label IN {'Skip', 'Skip all'}")).firstMatch // W1 picker "Skip" (med-ta2n.1)
        if skip.waitForExistence(timeout: 20) {
            shot(flow, "onboarding")
            skip.tap()
        }
        XCTAssertTrue(QA.tabBarShows(app, timeout: 30), "no tab bar")
        app.webViews.buttons["Meds"].firstMatch.tap()
        // aria-pressed makes the segment a toggle button, not a button.
        let schedule = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label == 'Schedule'")).firstMatch
        XCTAssertTrue(schedule.waitForExistence(timeout: 10), "no Meds → Schedule sub-tab")
        schedule.tap()
    }

    /// WKWebView's form accessory bar has Done; else the keyboard's own key.
    private func hideKeyboard(_ app: XCUIApplication) {
        guard app.keyboards.firstMatch.exists else { return }
        let done = app.toolbars.buttons["Done"]
        if done.exists { done.tap() } else { app.keyboards.buttons.matching(NSPredicate(format: "label IN[c] {'return', 'done', 'go'}")).firstMatch.tap() }
        _ = waitUntil(5) { !app.keyboards.firstMatch.exists }
    }

    private func webText(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func filesIn(_ dir: URL) -> [String] {
        let all = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.isRegularFileKey])?.allObjects as? [URL] ?? []
        return all.filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true }.map(\.lastPathComponent)
    }

    private func waitUntil(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return condition()
    }

    private func shot(_ flow: String, _ step: String) {
        let attachment = XCTAttachment(screenshot: QA.stableScreenshot().0)
        attachment.name = "\(flow)-\(step).png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
