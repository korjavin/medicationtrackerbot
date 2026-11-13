import XCTest

/// The core local flows (bd med-sz4k.6.1, twin of android/qa core-local.mjs):
/// testscenarios/common med-dose-taken, meal-kcal-total and
/// medication-schedule-edit, plus local-first-run's log / edit / delete /
/// reopen. Local mode on the QA driver's golden seed; each launch opens a
/// `core-local-*` flow scene (tests/visual/scenes.json) whose steps are the
/// setup Android does over CDP (open an editor, fill the time rows), and the
/// user's part is native: keyboard entry, Save, Take, swipe. Assertions read
/// the page's state from the driver's report (driver.js flowState), not pixels.
/// The page clock is pinned per launch (`-wgQAClock`): 07:00 for the existing
/// schedule, then mid-day, a later minute each launch.
@MainActor
final class FlowQACoreLocalTests: XCTestCase {
    nonisolated override func setUp() {
        super.setUp()
        MainActor.assumeIsolated { QA.reset() } // XCTest runs setUp on the main thread
    }

    func testCoreLocal() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        // local-first-run "Nothing is sent to the sync server": the fake
        // server (the qa job's tlsfront) counts what it receives over the run.
        // The Simulator stays online: this observes egress to that server,
        // it does not block it, and other hosts are not observed.
        let receiptsBefore = try QA.receipts().count

        // MARK: med-dose-taken — add a medication with a dose due at 09:59
        // (07:00, before its slot, as Android: a med created after its slot
        // has no dose that day); the YAML's two 08:00/20:00 meds exist too.
        launch(app, "core-local-add", clock: "07:00")
        type(app, "name", "QA B1 Dose")
        save(app, "the new medication", modal: "med-modal")
        shot("core-local", "dose-added")

        launch(app, "core-local-dose", clock: "10:00")
        let focusBefore = QA.flow(app)?["focus"]
        var (ok, f) = QA.tapLabel(app, "Today", until: { Self.rows($0, "nextUp").contains { $0.contains("QA B1 Dose") } && QA.target($0, "take") != nil })
        XCTAssertTrue(ok, "Today's Next up does not list QA B1 Dose with Take: \(QA.json(f))")
        shot("core-local", "today-due")
        // Take logs at once (med-aa18.1) or opens a confirm sheet (before it); drop the confirm branch once .1 is in.
        let loads = QA.report(app)?["loads"] as? Int
        let gone: ([String: Any]) -> Bool = { !Self.rows($0, "nextUp").contains { $0.contains("QA B1 Dose") } }
        (ok, f) = QA.tapTarget(app, "take", until: { gone($0) || QA.target($0, "confirm") != nil })
        XCTAssertTrue(ok, "Take neither logged the dose nor opened a confirm sheet: \(QA.json(f))")
        if let f, QA.target(f, "confirm") != nil {
            (ok, f) = QA.tapTarget(app, "confirm", timeout: 5, until: gone)
        }
        XCTAssertTrue(ok, "after Take the dose is still in Next up: \(QA.json(f))")
        XCTAssertEqual(QA.report(app)?["loads"] as? Int, loads, "Take reloaded the page")
        shot("core-local", "today-taken")
        (ok, f) = QA.tapLabel(app, "Meds", prefix: true, until: { Self.doseTaken($0) })
        XCTAssertTrue(ok, "Meds → Timeline does not show QA B1 Dose \"Taken 10:0x\": \(QA.json(f))")
        let focusAfter = f?["focus"] as? [[String: Any]] ?? []
        XCTAssertFalse(focusAfter.contains { ($0["text"] as? String ?? "").contains("QA B1 Dose") },
                       "the Timeline focus card still holds the taken dose: \(QA.json(focusAfter))")
        attach("core-local-focus", ["before": focusBefore ?? NSNull(), "after": focusAfter])
        shot("core-local", "timeline-taken")

        // MARK: meal-kcal-total — a manual meal of 321 kcal.
        launch(app, "core-local-meal", clock: "10:05")
        let before = try XCTUnwrap(Self.number((QA.flow(app)?["memo"] as? [String: Any])?["kcalBefore"]), "no kcal total before the meal")
        type(app, "name", "QA B1 Meal")
        (ok, f) = QA.tapTarget(app, "save", until: {
            Self.number($0["foodKcal"]) == before + 321 && Self.rows($0, "food").contains { $0.contains("QA B1 Meal") } && !Self.modal($0, "food-modal")
        })
        XCTAssertTrue(ok, "Food's day total is not \(before) + 321 with QA B1 Meal listed right after saving: \(QA.json(f))")
        shot("core-local", "meal-food-total")
        (ok, f) = QA.tapLabel(app, "Today", until: { ($0["fuel"] as? [Any])?.compactMap { Self.number($0) } == [before + 321] })
        XCTAssertTrue(ok, "Today's Fuel tile is not \(before + 321): \(QA.json(f))")
        shot("core-local", "meal-today-total")

        // MARK: medication-schedule-edit — 08:00 taken (the precondition, the
        // driver's takeDose), then the times become 09:00 / 21:00 mid-day.
        launch(app, "core-local-schedule-taken", clock: "10:10")
        save(app, "the edited schedule (08:00 taken)", modal: "med-modal")
        var day = todayRows(app, "QA B1 Schedule Taken")
        XCTAssertTrue(day.contains("08:00") && day.range(of: #"Taken 10:1\d"#, options: .regularExpression) != nil && !day.contains("09:00"),
                      "taken branch: the taken 08:00 is not kept, or a 09:00 dose appeared today: \(day)")
        XCTAssertTrue(day.contains("21:00") && !day.contains("20:00"), "taken branch: 21:00 does not replace 20:00 today: \(day)")
        shot("core-local", "schedule-taken")

        launch(app, "core-local-schedule-untaken", clock: "10:15")
        save(app, "the edited schedule (08:00 untaken)", modal: "med-modal")
        day = todayRows(app, "QA B1 Schedule Untaken")
        XCTAssertTrue(day.contains("09:00") && !day.contains("08:00"), "untaken branch: 09:00 does not replace the untaken 08:00: \(day)")
        XCTAssertTrue(day.contains("21:00") && !day.contains("20:00"), "untaken branch: 21:00 does not replace 20:00 today: \(day)")
        shot("core-local", "schedule-untaken")

        // MARK: local-first-run — log a BP and edit it; log a weight and delete it.
        launch(app, "core-local-bp", clock: "10:20")
        type(app, "sys", "141")
        type(app, "dia", "91")
        save(app, "the new BP", modal: "bp-modal", until: { Self.rows($0, "bp").contains { $0.contains("141/91") } })
        (ok, f) = QA.tapTarget(app, "row", until: { QA.target($0, "sys") != nil })
        XCTAssertTrue(ok, "a tap on the 141/91 row opened no editor: \(QA.json(f))")
        // The caret goes to the end of a tap at the field's right edge.
        retype(app, "sys", "142", deleting: 3)
        save(app, "the edited BP", modal: "bp-modal", until: {
            let bp = Self.rows($0, "bp")
            return bp.contains { $0.contains("142/91") } && !bp.contains { $0.contains("141/91") }
        })
        shot("core-local", "bp-edited")

        launch(app, "core-local-weight", clock: "10:25")
        type(app, "value", "77.7")
        save(app, "the new weight", modal: "weight-modal", until: { Self.rows($0, "weight").contains { $0.contains("77.7") } })
        // The row's More menu (wg-row-actions.js): the same Delete as the
        // touch swipe, which an XCUITest press-drag lands as a tap (it opened
        // the editor in CI). The new row sits low on the page and its menu
        // opens below it, past the tab bar (QA 42195050818: Delete at y 782 of
        // 763): scroll it up first, as a user's finger would.
        scrollUp(app, "row")
        (ok, f) = QA.tapTarget(app, "more", until: { QA.target($0, "delete") != nil })
        XCTAssertTrue(ok, "the 77.7 kg row's More menu did not open: \(QA.json(f))")
        let menuDelete = QA.target(f, "delete") ?? .zero
        let tabTop = QA.target(f, "tabbar")?.minY ?? app.webViews.firstMatch.frame.height
        shot("core-local", "weight-menu-open")
        XCTAssertLessThanOrEqual(menuDelete.maxY, tabTop, "the open menu's Delete \(menuDelete) is not above the tab bar (\(tabTop)): \(QA.json(f))")
        (ok, f) = QA.tapTarget(app, "delete", until: { !Self.rows($0, "weight").contains { $0.contains("77.7") } })
        XCTAssertTrue(ok, "Delete did not remove the 77.7 kg entry: \(QA.json(f))")
        shot("core-local", "weight-deleted")
        Thread.sleep(forTimeInterval: 6) // past the 5 s Undo window, so the delete commits before the app stops

        // MARK: Reopen: the take, the edit and the delete all held.
        launch(app, "core-local-after", clock: "10:30")
        (ok, f) = QA.waitFlow(app) { Self.doseTaken($0) }
        XCTAssertTrue(ok, "after the reopen QA B1 Dose is not \"Taken 10:0x\": \(QA.json(f))")
        shot("core-local", "reopen-timeline")
        QA.tapLabel(app, "Health", until: { $0["tab"] as? String == "bp" || $0["tab"] as? String == "weight" || $0["tab"] as? String == "health" })
        (ok, f) = QA.tapLabel(app, "BP", until: { $0["tab"] as? String == "bp" && !Self.rows($0, "bp").isEmpty })
        let bp = Self.rows(f ?? [:], "bp")
        XCTAssertTrue(ok && bp.contains { $0.contains("142/91") } && !bp.contains { $0.contains("141/91") }, "after the reopen the BP edit is lost: \(bp)")
        shot("core-local", "reopen-bp")
        (ok, f) = QA.tapLabel(app, "Weight", until: { $0["tab"] as? String == "weight" && !Self.rows($0, "weight").isEmpty })
        let weight = Self.rows(f ?? [:], "weight")
        XCTAssertTrue(ok && !weight.contains { $0.contains("77.7") }, "after the reopen the deleted weight is back: \(weight)")
        shot("core-local", "reopen-weight")
        app.terminate()

        let after = try QA.receipts()
        attach("core-local-receipts", ["before": receiptsBefore, "after": after.count, "new": Array(after.dropFirst(receiptsBefore))])
        XCTAssertEqual(after.count, receiptsBefore, "the local flows sent requests to the fake sync server: \(QA.json(Array(after.dropFirst(receiptsBefore))))")
    }

    // MARK: Steps

    /// Launches local mode on a flow scene at that page clock; the report says ok.
    private func launch(_ app: XCUIApplication, _ scene: String, clock: String) {
        if app.state != .notRunning {
            app.terminate()
            XCTAssertTrue(app.wait(for: .notRunning, timeout: 30), "the previous instance did not exit")
        }
        app.launchArguments = ["-wgLocalMode", "YES", "-wgAccountHost", "", "-wgLocalLockOn", "NO", "-wgLocalLock", "NO",
                               "-wgQAScene", scene, "-wgQAClock", clock]
        app.launch()
        XCTAssertTrue(QA.readyNode(app).waitForExistence(timeout: 120), "\(scene) never published #wg-qa-ready")
        let (ok, _) = QA.waitFlow(app, timeout: 30) { _ in true }
        let report = QA.report(app)
        XCTAssertTrue(ok && report?["ok"] as? Bool == true && report?["scene"] as? String == scene, "\(scene): \(QA.json(report))")
        XCTAssertEqual((QA.flow(app)?["clock"] as? String)?.prefix(4), clock.prefix(4), "\(scene): the page clock is not \(clock)")
    }

    /// Taps the field, types with the software keyboard, checks the value landed.
    private func type(_ app: XCUIApplication, _ field: String, _ text: String) {
        let (ok, f) = QA.tapTarget(app, field, until: { _ in app.keyboards.firstMatch.exists })
        XCTAssertTrue(ok, "a tap on \(field) opened no keyboard: \(QA.json(f))")
        QA.dismissKeyboardTip(app)
        app.typeText(text)
        let (typed, after) = QA.waitFlow(app, timeout: 5) { Self.value($0, field) == text }
        XCTAssertTrue(typed, "\(field) holds \(Self.value(after ?? [:], field) ?? "nil"), not \(text)")
    }

    private func retype(_ app: XCUIApplication, _ field: String, _ text: String, deleting count: Int) {
        let rect = QA.target(QA.flow(app), field)
        XCTAssertNotNil(rect, "no \(field) field")
        QA.coordinate(app, rect ?? .zero, at: CGPoint(x: 0.95, y: 0.5)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "a tap on \(field) opened no keyboard")
        app.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: count) + text)
        let (typed, after) = QA.waitFlow(app, timeout: 5) { Self.value($0, field) == text }
        XCTAssertTrue(typed, "\(field) holds \(Self.value(after ?? [:], field) ?? "nil"), not \(text)")
    }

    /// A slow finger drag that scrolls the page until the named target's top
    /// sits near the top of the web view (as far as the page scrolls), held
    /// at the end so no fling follows; waits for the report to show it moved.
    private func scrollUp(_ app: XCUIApplication, _ name: String) {
        let web = app.webViews.firstMatch.frame
        guard let rect = QA.target(QA.flow(app), name) else { return XCTFail("no \(name) to scroll: \(QA.json(QA.flow(app)))") }
        let by = rect.minY - web.height * 0.2
        guard by > 0 else { return }
        let from = QA.coordinate(app, CGRect(x: 0, y: 0, width: web.width, height: web.height * 0.75), at: CGPoint(x: 0.5, y: 1))
        from.press(forDuration: 0.1, thenDragTo: from.withOffset(CGVector(dx: 0, dy: -by)), withVelocity: .slow, thenHoldForDuration: 0.5)
        let (moved, f) = QA.waitFlow(app, timeout: 5) { (QA.target($0, name)?.minY ?? rect.minY) < rect.minY - 20 }
        XCTAssertTrue(moved, "the drag did not scroll \(name) up from \(rect): \(QA.json(f))")
    }

    /// Save, then the sheet is gone (and `until` holds).
    private func save(_ app: XCUIApplication, _ what: String, modal: String, until: @escaping ([String: Any]) -> Bool = { _ in true }) {
        let (ok, f) = QA.tapTarget(app, "save", until: { !Self.modal($0, modal) && until($0) })
        XCTAssertTrue(ok, "Save did not keep \(what): \(QA.json(f))")
        // A keyboard left up scrolls the web view's content (the page sat 317 pt
        // up in CI) and the next coordinate tap missed its row: wait it down;
        // the driver republishes rects on the viewport resize.
        let keyboard = app.keyboards.firstMatch
        if keyboard.exists && !keyboard.waitForNonExistence(timeout: 3) {
            let done = app.toolbars.buttons["Done"]
            if done.exists { done.tap() }
        }
        XCTAssertTrue(keyboard.waitForNonExistence(timeout: 5), "the keyboard stayed up after saving \(what)")
        Thread.sleep(forTimeInterval: 0.5) // the scroll view settles; the report follows it
    }

    /// Meds → Timeline, "Later today" unfolded, the text of today's rows of that med.
    private func todayRows(_ app: XCUIApplication, _ med: String) -> String {
        let (ok, f) = QA.tapLabel(app, "Timeline", until: { ($0["timeline"] as? [Any])?.isEmpty == false })
        XCTAssertTrue(ok, "Meds → Timeline shows no rows: \(QA.json(f))")
        if QA.target(f, "later") != nil {
            let (open, g) = QA.tapTarget(app, "later", until: { QA.target($0, "later") == nil })
            XCTAssertTrue(open, "\"Later today\" did not unfold: \(QA.json(g))")
        }
        // Both branches end with a 21:00 dose today: wait for the re-render.
        let (_, g) = QA.waitFlow(app, timeout: 10) { Self.today($0, med).contains("21:00") }
        let rows = Self.todayRows(g ?? [:], med)
        attach("core-local-\(med.lowercased().replacingOccurrences(of: " ", with: "-"))", rows)
        return Self.today(g ?? [:], med)
    }

    private static func todayRows(_ f: [String: Any], _ med: String) -> [[String: Any]] {
        (f["timeline"] as? [[String: Any]] ?? []).filter { $0["date"] as? String == f["today"] as? String && ($0["text"] as? String ?? "").contains(med) }
    }

    private static func today(_ f: [String: Any], _ med: String) -> String {
        todayRows(f, med).compactMap { $0["text"] as? String }.joined(separator: "\n")
    }

    // MARK: Report reading

    private static func doseTaken(_ f: [String: Any]) -> Bool {
        (f["timeline"] as? [[String: Any]] ?? []).contains {
            let text = $0["text"] as? String ?? ""
            return $0["date"] as? String == f["today"] as? String && text.contains("QA B1 Dose")
                && text.range(of: #"Taken 10:0\d"#, options: .regularExpression) != nil
        }
    }

    /// A list of the flow state as texts (rows that are {text} objects too).
    private static func rows(_ f: [String: Any], _ key: String) -> [String] {
        (f[key] as? [Any] ?? []).compactMap { ($0 as? String) ?? ($0 as? [String: Any])?["text"] as? String }
    }

    private static func modal(_ f: [String: Any], _ id: String) -> Bool {
        (f["modals"] as? [String] ?? []).contains(id)
    }

    private static func value(_ f: [String: Any], _ target: String) -> String? {
        ((f["targets"] as? [String: Any])?[target] as? [String: Any])?["value"] as? String
    }

    /// "1,451" → 1451.
    private static func number(_ v: Any?) -> Int? {
        (v as? String).flatMap { Int($0.filter(\.isNumber)) }
    }

    // MARK: Attachments

    private func attach(_ name: String, _ value: Any) {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]) else { return }
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "\(name).json"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func shot(_ flow: String, _ step: String) {
        let attachment = XCTAttachment(screenshot: QA.stableScreenshot().0)
        attachment.name = "\(flow)-\(step).png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
