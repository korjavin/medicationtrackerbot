import XCTest

/// Flow QA: local mode's data lifecycle (bd med-w6gx.23.4, docs/ios.md "Flow
/// QA (Simulator)") — backup export to the Files export picker, restore from a file,
/// erase. Twin of android/qa smoke.mjs exportBackup / local-smoke / erase.
/// Same contract as FlowQATests: first failed step ends the flow, shots are
/// `<flow>-<step>.png`, assertions are UI or files the app already writes.
@MainActor
final class FlowQABackupTests: XCTestCase {
    nonisolated override func setUp() {
        super.setUp()
        // bd med-w6gx.23.8: a clean slate, so one failed flow stays one red test.
        MainActor.assumeIsolated { QA.reset() } // XCTest runs setUp on the main thread
    }

    /// Local mode, lock off; `scene` makes the QA driver seed the golden vault
    /// into an empty store (through Settings → Backup & import) and open it.
    private func launch(_ app: XCUIApplication, scene: String? = nil) {
        app.launchArguments = ["-wgLocalMode", "1", "-wgLocalLockOn", "0", "-wgLocalLock", "0"] + (scene.map { ["-wgQAScene", $0] } ?? [])
        app.launch()
    }

    /// Settings → Backup & import → Export backup → passphrase sheet → Backup
    /// ready → Save to device, plain then encrypted: each lands in the shell's
    /// Downloads temp dir, is offered through the Files export picker, and is
    /// deleted once the picker closes (kit S7, bd med-ckm5.7, med-o7zq.43).
    func testBackupExport() throws {
        continueAfterFailure = false
        let flow = "backup-export"
        let app = XCUIApplication()
        launch(app, scene: "settings-backup")
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 90), "Backup & import never published #wg-qa-ready")
        let downloads = try XCTUnwrap(QA.appContainer(), "no app container").appendingPathComponent("tmp/wg-downloads")
        let exportBtn = app.webViews.buttons["Save a backup"]
        let save = app.webViews.buttons["Save to device"]

        // Plain: no passphrase → the page asks before writing API keys in clear.
        XCTAssertTrue(exportBtn.waitForExistence(timeout: 10), "no Save a backup button")
        exportBtn.tap()
        let plain = app.webViews.buttons["Export without encryption"]
        XCTAssertTrue(plain.waitForExistence(timeout: 10), "the passphrase sheet never showed")
        // Run 39551908023: the tap never reached the page. The sheet focuses
        // the passphrase field, so the run's first keyboard (and its
        // slide-to-type tip) comes up, and the sheet may still be sliding in:
        // clear the tip, and tap again while the button is still there.
        QA.dismissKeyboardTip(app)
        let confirm = app.webViews.buttons["Confirm"]
        var confirmed = false
        for _ in 0..<3 where !confirmed {
            if plain.exists { plain.tap() }
            confirmed = confirm.waitForExistence(timeout: 5)
        }
        if !confirmed { shot(flow, "plain-no-confirm") }
        XCTAssertTrue(confirmed, "the plain-export confirm never showed")
        confirm.tap()
        XCTAssertTrue(save.waitForExistence(timeout: 60), "Backup ready never showed")
        shot(flow, "plain-ready")
        save.tap()
        exportPickerRoundTrip(app, flow: flow, step: "plain", downloads: downloads, suffix: ".json.gz")
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
        exportPickerRoundTrip(app, flow: flow, step: "encrypted", downloads: downloads, suffix: ".json.gz.age", timeout: 60)
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
        // No account means local mode, persisted at launch (bd med-ta2n.17),
        // so the relaunch below can run with no arguments.
        app.launchArguments = ["-wgAccountHost", "", "-wgLocalLockOn", "NO", "-wgLocalLock", "NO", "-wgQAScene", "settings-erase-confirm"]
        app.launch()
        erase(app, flow: flow)
        XCTAssertEqual(QA.appDefaults()?["wgLocalMode"] as? Bool, true, "wgLocalMode is not persisted before the relaunch")
        app.terminate()

        app.launchArguments = ["-wgLocalLock", "NO"] // the persisted choice only; a scene would re-seed the empty store
        app.launch()
        openMedsSchedule(app, flow: flow)
        XCTAssertTrue(webText(app, containing: "No medications yet").waitForExistence(timeout: 20), "Meds → Schedule is not empty after erase")
        XCTAssertFalse(webText(app, containing: "Lisinopril").exists, "an erased medication is still listed")
        shot(flow, "empty")
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

    /// Waits for the Files export picker (bd med-o7zq.43), checks the file sits
    /// in the Downloads dir while it shows, swipes it away, and checks the dir is
    /// empty after. The picker is a remote view whose controls show in the app
    /// tree; they count only beyond the web view's own matches, so page
    /// buttons never pass.
    private func exportPickerRoundTrip(_ app: XCUIApplication, flow: String, step: String, downloads: URL,
                                       suffix: String, timeout: TimeInterval = 60) {
        let marks = NSPredicate(format: "label IN {'Cancel', 'Save', 'Move', 'Browse', 'Recents', 'On My iPhone'}")
        let shown = {
            app.descendants(matching: .any).matching(marks).count > app.webViews.descendants(matching: .any).matching(marks).count
        }
        let up = waitUntil(timeout, shown)
        shot(flow, "\(step)-export-picker")
        guard up else {
            return XCTFail("\(step): the Files export picker never showed — tree: \(tree(app))")
        }
        let files = filesIn(downloads)
        XCTAssertTrue(files.count == 1 && files[0].hasSuffix(suffix), "\(step): Downloads holds \(files), want one *\(suffix)")

        // Swipe the sheet down by its header: the picker opens at its last
        // location (Browse with an X, or a folder with Back + Save), so no
        // single button is always there.
        let header = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.112))
        header.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
        let closed = waitUntil(15) { !shown() }
        XCTAssertTrue(closed, "\(step): the export picker did not close — tree tail: \(tree(app, tail: true))")
        XCTAssertTrue(waitUntil(10) { filesIn(downloads).isEmpty }, "\(step): the export file outlived the picker: \(filesIn(downloads))")
    }

    /// The element tree on one line, for a failure message (the job's log keeps
    /// only " error: " lines and the artifact only PNGs).
    private func tree(_ app: XCUIApplication, tail: Bool = false) -> String {
        let line = app.debugDescription.split(separator: "\n").joined(separator: " | ")
        return String(tail ? line.suffix(6000) : line.prefix(6000))
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
