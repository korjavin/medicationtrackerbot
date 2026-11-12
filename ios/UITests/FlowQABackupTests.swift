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
        let plain = app.webViews.buttons["Export without encryption"]
        XCTAssertTrue(QA.tapUntil(exportBtn, shows: plain), "the passphrase sheet never showed")
        // The sheet focuses the passphrase field: the run's first keyboard
        // can open under the slide-to-type tip.
        QA.dismissKeyboardTip(app)
        tapUntilGone(plain)
        let confirm = app.webViews.buttons["Confirm"]
        let confirmed = confirm.waitForExistence(timeout: 10)
        if !confirmed { shot(flow, "plain-no-confirm") }
        XCTAssertTrue(confirmed, "the plain-export confirm never showed")
        tapUntilGone(confirm)
        XCTAssertTrue(save.waitForExistence(timeout: 60), "Backup ready never showed")
        shot(flow, "plain-ready")
        tapUntilGone(save)
        exportPickerRoundTrip(app, flow: flow, step: "plain", downloads: downloads, suffix: ".json.gz")
        XCTAssertTrue(webText(app, containing: ".json.gz.").waitForExistence(timeout: 10), "the export status never said \"Backup exported\"")

        // Encrypted: the passphrase makes it .age (proof the typing landed).
        let pass = QA.webElement(app, id: "importexport-export-passphrase", placeholder: "Encrypt the backup")
        XCTAssertTrue(QA.tapUntil(exportBtn, shows: pass), "no passphrase field")
        pass.tap()
        QA.dismissKeyboardTip(app)
        pass.typeText("qa-flow-passphrase")
        QA.dismissKeyboardTip(app)
        shot(flow, "passphrase")
        QA.hideKeyboard(app)
        tapUntilGone(app.webViews.buttons["Encrypt and export"])
        XCTAssertTrue(save.waitForExistence(timeout: 120), "encrypted Backup ready never showed")
        shot(flow, "encrypted-ready")
        tapUntilGone(save)
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
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 90), "Meds → My meds never published #wg-qa-ready")
        // loads ≥ 2: this launch's page imported the file and reloaded.
        let report = QA.readyNode(app).label
        XCTAssertTrue(report.range(of: #""loads":([2-9]|\d\d)"#, options: .regularExpression) != nil,
                      "the driver did not restore into the empty store (report \(report))")
        XCTAssertTrue(webText(app, containing: "Lisinopril").waitForExistence(timeout: 10), "the restored medication is not listed")
        shot(flow, "restored-meds")
        app.terminate()

        launch(app)
        openMedsMyMeds(app, flow: flow)
        XCTAssertTrue(webText(app, containing: "Lisinopril").waitForExistence(timeout: 20), "after relaunch the restored medication is gone")
        shot(flow, "relaunch-meds")
        app.terminate()
    }

    /// The same provider-saved file makes the whole trip through the native
    /// export and import pickers. The audit scene reads the live vault; unlike
    /// the visual seed it never imports when the store is empty.
    func testBackupExportRestoreChain() throws {
        continueAfterFailure = false
        let flow = "backup-chain"
        let app = XCUIApplication()
        launch(app, scene: "settings-backup")
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 90))
        app.terminate()
        launch(app, scene: "backup-audit")
        let before = try audit(app)
        let fixtureURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../tests/fixtures/vault-v1.json").standardized
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as? [String: Any])
        let data = try XCTUnwrap(fixture["data"] as? [String: Any])
        let beforeCounts = try XCTUnwrap(before["counts"] as? [String: Int])
        // The visual seed adds records; every fixture collection named here
        // must still be represented, then the restore must match the baseline.
        for (section, list) in [("medications", "items"), ("medications", "intakes"),
                                ("bp", "readings"), ("weight", "logs"), ("food", "logs"),
                                ("workouts", "sessions"), ("vitals", "sleep")] {
            let expected = ((data[section] as? [String: Any])?[list] as? [Any])?.count ?? 0
            XCTAssertGreaterThan(expected, 0, "fixture has no \(section).\(list)")
            XCTAssertGreaterThanOrEqual(beforeCounts["\(section).\(list)"] ?? 0, expected)
        }
        let downloads = try XCTUnwrap(QA.appContainer()).appendingPathComponent("tmp/wg-downloads")
        let export = app.webViews.buttons["Save a backup"]
        let plain = app.webViews.buttons["Export without encryption"]
        XCTAssertTrue(QA.tapUntil(export, shows: plain))
        QA.dismissKeyboardTip(app)
        tapUntilGone(plain)
        let confirm = app.webViews.buttons["Confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        tapUntilGone(confirm)
        let save = app.webViews.buttons["Save to device"]
        XCTAssertTrue(save.waitForExistence(timeout: 60))
        tapUntilGone(save)
        let nativeSave = app.buttons["Save"].firstMatch
        XCTAssertTrue(nativeSave.waitForExistence(timeout: 60), "no native Files Save")
        let name = try XCTUnwrap(filesIn(downloads).first, "no offered backup")
        XCTAssertTrue(name.hasSuffix(".json.gz"))
        let offered = try XCTUnwrap(FileManager.default.enumerator(at: downloads, includingPropertiesForKeys: nil)?.allObjects
            .compactMap { $0 as? URL }.first { $0.lastPathComponent == name })
        let offeredBytes = try Data(contentsOf: offered)
        XCTAssertFalse(offeredBytes.isEmpty)
        shot(flow, "native-save")
        nativeSave.tap()
        XCTAssertTrue(waitUntil(30) { filesIn(downloads).isEmpty }, "export picker did not complete")

        // Locate the provider-backed copy, not the temporary export. This also
        // gives a sibling location for the corrupt file used by the picker.
        let container = try XCTUnwrap(QA.appContainer())
        let device = container.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let files = FileManager.default.enumerator(at: device, includingPropertiesForKeys: [.isRegularFileKey])
        var saved: URL?
        while let url = files?.nextObject() as? URL {
            if url.lastPathComponent == name && !url.path.contains("/tmp/wg-downloads/") { saved = url; break }
        }
        let savedURL = try XCTUnwrap(saved, "native Save produced no provider-backed copy")
        XCTAssertEqual(try Data(contentsOf: savedURL), offeredBytes, "provider-saved file differs from the export")
        let corrupt = savedURL.deletingLastPathComponent().appendingPathComponent("qa-corrupt.json.gz")
        try Data([0x1f, 0x8b, 0x08]).write(to: corrupt)
        defer { try? FileManager.default.removeItem(at: corrupt); try? FileManager.default.removeItem(at: savedURL) }

        let eraseRow = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Erase data on this'")).firstMatch
        let eraseField = app.webViews.textFields.firstMatch
        XCTAssertTrue(QA.tapUntil(eraseRow, shows: eraseField))
        eraseField.tap()
        QA.dismissKeyboardTip(app)
        // WebKit can insert a keyboard suggestion on first focus (the
        // simulator exposed "THE " before the phrase). Clear it before
        // typing, then require the real destructive gate to enable.
        eraseField.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 40))
        eraseField.typeText("erase")
        QA.dismissKeyboardTip(app)
        XCTAssertTrue(app.webViews.buttons["Erase"].isEnabled, "typed erase did not enable confirmation")
        QA.hideKeyboard(app)
        app.webViews.buttons["Erase"].tap()
        XCTAssertTrue(waitUntil(30) { !QA.readyNode(app).exists }, "erase did not reload")
        _ = QA.skipW1(app, timeout: 30)
        app.terminate()
        launch(app, scene: "backup-audit")
        let empty = try audit(app)
        let emptyCounts = try XCTUnwrap(empty["counts"] as? [String: Int])
        XCTAssertEqual(emptyCounts["medications.items"] ?? 0, 0)
        XCTAssertEqual(emptyCounts["bp.readings"] ?? 0, 0)

        // A receiver-only record makes the typed Replace meaningful and its
        // removal observable; the exported file predates this record.
        app.terminate()
        launch(app, scene: "backup-sentinel")
        let receiver = try audit(app)
        let receiverCounts = try XCTUnwrap(receiver["counts"] as? [String: Int])
        XCTAssertEqual(receiverCounts["bp.readings"], 1)
        app.terminate()
        launch(app, scene: "backup-audit")
        _ = try audit(app)

        try pickBackup(app, name: name, flow: flow)
        app.webViews.buttons["Replace my data with this backup"].tap()
        let field = app.webViews.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 30), "no typed Replace confirmation")
        XCTAssertFalse(webText(app, containing: "Merge").exists, "file restore offered Merge")
        let replace = app.webViews.buttons["Replace"].firstMatch
        XCTAssertTrue(replace.exists)
        XCTAssertFalse(replace.isEnabled, "Replace enabled without confirmation")
        field.tap()
        QA.dismissKeyboardTip(app)
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 40))
        field.typeText("replace")
        QA.dismissKeyboardTip(app)
        QA.hideKeyboard(app)
        shot(flow, "typed-replace")
        XCTAssertTrue(replace.isEnabled)
        replace.tap()
        XCTAssertTrue(waitUntil(60) { !QA.readyNode(app).exists }, "restore did not reload")
        app.terminate()
        launch(app, scene: "backup-audit")
        let restored = try audit(app)
        XCTAssertEqual(restored as NSDictionary, before as NSDictionary, "restored vault differs from exported baseline")
        shot(flow, "restored")

        try pickBackup(app, name: corrupt.lastPathComponent, flow: flow)
        app.webViews.buttons["Replace my data with this backup"].tap()
        XCTAssertTrue(webText(app, containing: "Could not read backup").waitForExistence(timeout: 30), "corrupt file was not refused")
        XCTAssertFalse(app.webViews.buttons["Replace"].exists, "corrupt file reached confirmation")
        app.terminate()
        launch(app, scene: "backup-audit")
        XCTAssertEqual(try audit(app) as NSDictionary, restored as NSDictionary, "corrupt restore changed the vault")
        app.terminate()
    }

    private func audit(_ app: XCUIApplication) throws -> [String: Any] {
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 90), "backup audit not ready")
        let report = try XCTUnwrap(QA.report(app), "unreadable backup audit")
        XCTAssertEqual(report["ok"] as? Bool, true, "backup audit failed: \(QA.json(report))")
        return try XCTUnwrap(report["vaultAudit"] as? [String: Any], "no vault audit")
    }

    private func pickBackup(_ app: XCUIApplication, name: String, flow: String) throws {
        let choose = app.webViews.buttons["Choose"].firstMatch
        XCTAssertTrue(choose.waitForExistence(timeout: 15), "no backup file chooser")
        choose.tap()
        // Files exposes both an inner filename text and the actual tappable
        // document cell. The text itself can be tapped without selecting it.
        let file = app.cells.matching(NSPredicate(format: "identifier BEGINSWITH %@ OR label BEGINSWITH %@", name, name)).firstMatch
        XCTAssertTrue(file.waitForExistence(timeout: 30), "native picker lacks \(name): \(tree(app, tail: true))")
        shot(flow, "picker-\(name)")
        file.tap()
        XCTAssertTrue(webText(app, containing: name).waitForExistence(timeout: 30), "picker did not return \(name)")
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
        openMedsMyMeds(app, flow: flow)
        XCTAssertTrue(webText(app, containing: "No medications yet").waitForExistence(timeout: 20), "Meds → My meds is not empty after erase")
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
        var input = field.waitForExistence(timeout: 10) ? field : app.webViews.textFields.firstMatch
        // Run 39944639601 attempt 2: #wg-qa-ready published, then no text
        // field for 15 s. If the dialog is gone (its Erase button too), reopen
        // it from Settings; never tap the row under an open dialog (a backdrop
        // tap cancels it).
        if !input.waitForExistence(timeout: 5) && !app.webViews.buttons["Erase"].exists {
            let row = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Erase data on this'")).firstMatch
            QA.tapUntil(row, shows: app.webViews.textFields.firstMatch)
            input = field.exists ? field : app.webViews.textFields.firstMatch
        }
        XCTAssertTrue(input.waitForExistence(timeout: 5), "no typed-confirm input in the erase dialog — tree: \(tree(app))")
        input.tap()
        QA.dismissKeyboardTip(app)
        input.typeText("erase")
        QA.dismissKeyboardTip(app)
        shot(flow, "dialog-typed")
        let eraseBtn = app.webViews.buttons["Erase"]
        XCTAssertTrue(eraseBtn.waitForExistence(timeout: 5), "no Erase button in the dialog")
        QA.hideKeyboard(app)
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

    /// Bottom tab bar → Meds → My meds (labelled "Schedule" before med-5uwb.2; the tab restores its last sub-tab).
    private func openMedsMyMeds(_ app: XCUIApplication, flow: String) {
        // An empty store reopens the web onboarding (its record went with the erase).
        if QA.w1Shows(app, timeout: 20) {
            shot(flow, "onboarding")
            QA.skipW1(app, timeout: 1)
        }
        XCTAssertTrue(QA.tabBarShows(app, timeout: 30), "no tab bar")
        // aria-pressed makes the segment a toggle button, not a button.
        let schedule = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label IN {'Schedule', 'My meds'}")).firstMatch
        XCTAssertTrue(QA.tapUntil(app.webViews.buttons["Meds"].firstMatch, shows: schedule), "no Meds → My meds sub-tab")
        schedule.tap()
    }

    /// Taps a sheet button its own tap closes, again while it is still there:
    /// on the CI Simulator a tap on a web sheet button now and then never
    /// reaches the page (runs 39551908023 "Export without encryption",
    /// 39557470507 "Save to device": the sheet still up a minute later). A
    /// landed tap closes the sheet, so there is no second one.
    private func tapUntilGone(_ button: XCUIElement) {
        for _ in 0..<3 where button.exists {
            button.tap()
            if waitUntil(5, { !button.exists }) { return }
        }
        XCTAssertFalse(button.exists, "\(button.label): three taps did not close its sheet")
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
